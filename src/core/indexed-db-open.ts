/**
 * One IndexedDB open dance, shared by every store in the plugin.
 *
 * Ten stores had written this out separately, and the schema creation was never
 * the interesting part: the interesting part is the race. `onsuccess` can fire
 * after `onerror` has already rejected, `onblocked` can fire and then `onsuccess`
 * arrive anyway, and a database handed to a caller that has meanwhile been
 * disposed leaks a connection that blocks the next version upgrade forever. Each
 * copy solved that with its own `settled` flag, and a fix to one of them could
 * never reach the other nine.
 *
 * What is NOT shared is the vocabulary each domain rejects with. A store that
 * reports `future_schema` and one that throws a plain `Error` are making
 * different promises to their callers, so the error stays the caller's to build
 * and this module only says which handler ended the attempt.
 */

import {
	STORAGE_ANSWER_TIMEOUT_MS, StorageDeadline, StorageUnansweredError, type StorageDeadlineOptions,
} from '../sessions/storage-deadline';
import type { LocalDebugCode } from './local-debug-contract';
import { localDebugStorageFailureCode } from './local-debug-persistence';

/** An index as the upgrade handlers declare it today: name plus key path, nothing else. */
export interface IndexedDbIndexSchema {
	name: string;
	keyPath: string | readonly string[];
}

/** An object store, created only when absent. */
export interface IndexedDbStoreSchema {
	name: string;
	keyPath?: string | readonly string[];
	indexes?: readonly IndexedDbIndexSchema[];
}

/**
 * Which handler ended the attempt.
 *
 * `blocked` is kept apart from `error` because several stores report it as its
 * own condition: an upgrade blocked by another open tab is a retry, while an
 * `error` may be a `VersionError` from a database written by a newer build.
 * `refused` means the open itself succeeded and `accept` turned it down.
 */
export type IndexedDbOpenFailureReason = 'error' | 'blocked' | 'refused' | 'timeout';

/**
 * Why a connection was asked to step aside.
 *
 * `upgrade`: another context opened this database with a HIGHER version, so the schema this code
 * knows is no longer the one on disk and opening again would only fail against it. `released` is
 * every other `versionchange` (the database is being deleted, or the engine wants the connection
 * back without raising the version): the connection is closed and a later operation may open a
 * new one against the same schema.
 */
export type IndexedDbVersionChangeKind = 'upgrade' | 'released';

export interface OpenIndexedDbOptions {
	factory: IDBFactory;
	databaseName: string;
	databaseVersion: number;
	/**
	 * Applied on `onupgradeneeded`, creating only what is missing. Every store in
	 * the tree upgrades this way and none of them reads `oldVersion`, so this
	 * declarative form is the whole migration vocabulary in use.
	 */
	schema: readonly IndexedDbStoreSchema[];
	/** Builds the error this domain rejects with. `error` is the request's own, when there was one. */
	toError: (reason: IndexedDbOpenFailureReason, error: DOMException | null) => Error;
	/**
	 * The last word before the database is handed over. Returning false closes it
	 * and rejects with `refused`, which is how a store that was disposed while
	 * opening avoids leaking the connection it no longer wants.
	 */
	accept?: (database: IDBDatabase) => boolean;
	/**
	 * What to install as `onversionchange`, if anything.
	 *
	 * `'close'` closes the connection so another tab's upgrade is not blocked; a
	 * callback closes first and then runs, which is where a store drops its cached
	 * handle. OMITTING it installs no handler at all: the connection then stays
	 * open through another context's upgrade, which waits (`blocked`) until its
	 * owner closes it. No store omits it since DU-05 (the Halloween store, the
	 * last one without a handler, now gets one from `ReopeningIndexedDbConnection`);
	 * it stays available for a caller that closes the connection itself right away.
	 *
	 * The callback is told which kind it was, so a store can stay closed after a real
	 * upgrade and still open again after anything else.
	 */
	onVersionChange?: 'close' | ((database: IDBDatabase, kind: IndexedDbVersionChangeKind) => void);
	/**
	 * Runs when the engine closes the connection on its own (the `close` event: its storage
	 * process died, the origin was cleared). `database.close()` never fires it. This is where a
	 * store drops a handle that will throw on every later `transaction()`.
	 */
	onClose?: (database: IDBDatabase) => void;
	/**
	 * How long the engine may leave the open without any event (`STORAGE_ANSWER_TIMEOUT_MS` when absent). Past it the open
	 * fails as `timeout`, the way a refusal does; a database the engine hands over later is closed, never kept.
	 */
	timeoutMs?: number;
	/** The timer, for a test; the host's `window.setTimeout` when absent. A host that has none gets the open unbounded. */
	schedule?: (callback: () => void, milliseconds: number) => unknown;
	cancel?: (handle: unknown) => void;
}

/**
 * Opens the database, applies the schema and resolves the connection.
 *
 * Exactly one of resolve or reject ever runs, whatever order the handlers fire
 * in, and any database that arrives after that point is closed rather than
 * leaked.
 */
export function openIndexedDb(options: OpenIndexedDbOptions): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = options.factory.open(options.databaseName, options.databaseVersion);
		let settled = false;
		// 9 Oct 2026: an engine that takes the open and fires nothing left every store waiting for ever. Only the WAIT is
		// bounded: the request stays in course, and `onsuccess` below closes whatever arrives after `settled`.
		let timer: unknown;
		const schedule = options.schedule ?? ((callback: () => void, milliseconds: number) => window.setTimeout(callback, milliseconds));
		const cancel = options.cancel ?? ((handle: unknown) => { window.clearTimeout(handle as number); });
		const stopTimer = (): void => {
			if (timer === undefined) return;
			try { cancel(timer); } catch { /* A timer that cannot be cancelled fires into an open already settled. */ }
		};

		const fail = (reason: IndexedDbOpenFailureReason, error: DOMException | null): void => {
			if (settled) return;
			settled = true;
			stopTimer();
			reject(options.toError(reason, error));
		};
		try { timer = schedule(() => { fail('timeout', null); }, options.timeoutMs ?? STORAGE_ANSWER_TIMEOUT_MS); }
		catch { timer = undefined; /* No timer in this host (a unit test under Node): the open is unbounded, as before. */ }

		request.onupgradeneeded = () => {
			applyIndexedDbSchema(request.result, options.schema);
		};
		request.onerror = () => fail('error', request.error);
		request.onblocked = () => fail('blocked', null);
		request.onsuccess = () => {
			const database = request.result;
			if (settled) {
				database.close();
				return;
			}
			if (options.accept !== undefined && !options.accept(database)) {
				database.close();
				fail('refused', null);
				return;
			}
			settled = true;
			stopTimer();
			const versionChange = options.onVersionChange;
			if (versionChange !== undefined) {
				database.onversionchange = (event) => {
					// Read before closing: only a version above the one this connection holds is an upgrade.
					const kind: IndexedDbVersionChangeKind = event.newVersion !== null && event.newVersion > database.version
						? 'upgrade' : 'released';
					database.close();
					if (versionChange !== 'close') versionChange(database, kind);
				};
			}
			const closed = options.onClose;
			if (closed !== undefined) database.onclose = () => closed(database);
			resolve(database);
		};
	});
}

/**
 * Raised in place of whatever `transaction()` threw. It says one thing: the connection is not
 * usable and nothing was started on it, which is what makes running the operation again safe.
 */
export class IndexedDbConnectionLostError extends Error {
	constructor(readonly reason: unknown) {
		super('The IndexedDB connection is no longer usable.');
		this.name = 'IndexedDbConnectionLostError';
	}
}

/** `database.transaction()`, with a dead connection reported as such instead of as the engine's own error. */
export function startIndexedDbTransaction(
	database: IDBDatabase,
	storeNames: string | string[],
	mode: IDBTransactionMode,
): IDBTransaction {
	try {
		return database.transaction(storeNames, mode);
	} catch (error) {
		throw new IndexedDbConnectionLostError(error);
	}
}

/** How a store hands out its cached connection and forgets one that died. */
export interface ReopenableIndexedDb {
	open(): Promise<IDBDatabase>;
	/** Drops `database` from the cache if it is still the cached one; a later `open()` opens anew. */
	discard(database: IDBDatabase): void;
}

/**
 * Runs one operation on the store's connection. If the connection turns out to be dead before the
 * operation could start a transaction, it is discarded and the operation runs once more on a new
 * one.
 *
 * Exactly one reopen per operation, no waiting and no loop: a second dead connection is this
 * operation's failure, and the next operation gets its own single attempt. Only
 * `IndexedDbConnectionLostError` is retried, never an abort or a rejected request, because those
 * happen after a transaction started and the caller alone knows whether repeating it is safe.
 */
export async function withIndexedDbReopen<T>(
	connection: ReopenableIndexedDb,
	operation: (database: IDBDatabase) => Promise<T>,
	deadlineOptions: StorageDeadlineOptions = {},
): Promise<T> {
	// 9 Oct 2026: a transaction the engine takes and never answers. Only the WAIT is bounded (the transaction stays in
	// course and may still write; each store guards its writes). The connection it ran on is dropped, so the next
	// operation opens anew instead of queueing behind it, and this one is refused as any failed operation is.
	const deadline = new StorageDeadline(deadlineOptions);
	const run = (database: IDBDatabase): Promise<T> => deadline.bounded(() => operation(database), () => {
		connection.discard(database);
		return Promise.reject(new StorageUnansweredError());
	});
	const database = await connection.open();
	try {
		return await run(database);
	} catch (error) {
		if (!(error instanceof IndexedDbConnectionLostError)) throw error;
		connection.discard(database);
	}
	const reopened = await connection.open();
	try {
		return await run(reopened);
	} catch (error) {
		if (error instanceof IndexedDbConnectionLostError) connection.discard(reopened);
		throw error;
	}
}

/**
 * The two ways `withIndexedDbReopen` gives up on an operation: no live connection even after the one reopen, or no
 * answer in time. Both mean "storage is unavailable"; each store reports them in its own vocabulary.
 */
export function isIndexedDbUnavailable(error: unknown): boolean {
	return error instanceof IndexedDbConnectionLostError || error instanceof StorageUnansweredError;
}

/** A store's own "unavailable", keeping what `withIndexedDbReopen` gave up with, so the diagnostic can still name it. */
export class IndexedDbUnavailableError extends Error {
	constructor(message: string, readonly reason: unknown) {
		super(message);
	}
}

/**
 * The diagnostic code of a failed store operation: `timeout` when the engine did not answer in time
 * (`StorageUnansweredError`, also when a store wrapped it), otherwise the storage code of the engine's own error.
 */
export function indexedDbFailureCode(error: unknown): LocalDebugCode {
	const reason = error instanceof IndexedDbUnavailableError || error instanceof IndexedDbConnectionLostError ? error.reason : error;
	return reason instanceof StorageUnansweredError ? 'timeout' : localDebugStorageFailureCode(reason);
}

/** What a reopening connection installs on each open: spread them into the `openIndexedDb` options. */
export type ReopeningIndexedDbHooks = Required<Pick<OpenIndexedDbOptions, 'accept' | 'onVersionChange' | 'onClose'>>;

/**
 * The one cached connection of a store, opened again when the engine dropped it (DU-05, 10 Oct 2026).
 *
 * The session, coordination and inventory-preferences stores each wrote this out (`connection()`, `discard()`,
 * `withIndexedDbReopen`). The stores that kept one connection for the whole run failed every transaction after the
 * engine closed it, until the plugin was reloaded; they share this copy instead of writing a ninth and tenth.
 *
 * A connection the engine closed (`onClose`), one released by a `versionchange` that is not an upgrade, and one that no
 * longer starts transactions are forgotten, and the next operation opens a new one. Two things retire it for good:
 * `close()`, and a real upgrade from another context (the schema on disk is no longer this build's). Built around a fixed
 * database, without `connect`, there is nothing to open again: once that database is dropped the store stays unavailable.
 */
export class ReopeningIndexedDbConnection implements ReopenableIndexedDb {
	private opening: Promise<IDBDatabase> | null = null;
	private retired = false;
	/** Installed on every connection `connect` opens. */
	readonly hooks: ReopeningIndexedDbHooks = {
		accept: () => !this.retired,
		onVersionChange: (database, kind) => {
			if (this.database === database) this.database = null;
			if (kind === 'upgrade') this.retired = true;
		},
		onClose: (database) => { this.discard(database); },
	};

	/**
	 * `connect` opens one connection with `hooks` installed (null: only `database` is ever used). `unavailable` is the
	 * error this store's callers already know for a store that cannot answer.
	 */
	constructor(
		private readonly connect: ((hooks: ReopeningIndexedDbHooks) => Promise<IDBDatabase>) | null,
		private readonly unavailable: () => Error,
		private database: IDBDatabase | null = null,
	) {}

	/** The cached connection, or a new one; the store's own `unavailable` error once retired. */
	async open(): Promise<IDBDatabase> {
		if (this.retired) throw this.unavailable();
		if (this.database) return this.database;
		if (this.opening) return await this.opening;
		if (this.connect === null) throw this.unavailable();
		const opening = this.connect(this.hooks);
		this.opening = opening;
		try {
			const database = await opening;
			// Closed between the engine's answer and this line: `accept` saw it open, so the database is ours to close.
			if (this.retired) {
				database.close();
				throw this.unavailable();
			}
			this.database = database;
			return database;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}

	/** True after `close()` or a real upgrade; nothing opens again from then on. */
	get isRetired(): boolean { return this.retired; }

	/** Forgets `database` if it is still the cached one, and closes it; the next operation opens anew. */
	discard(database: IDBDatabase): void {
		if (this.database === database) this.database = null;
		try { database.close(); } catch { /* Already gone, which is the reason it is being dropped. */ }
	}

	/** Retires the connection: the cached database is closed and nothing opens again. */
	close(): void {
		this.retired = true;
		const database = this.database;
		this.database = null;
		database?.close();
	}

	/**
	 * One operation on the cached connection, with a single reopen when it died underneath (`withIndexedDbReopen`). The
	 * operation must start its transaction with `startIndexedDbTransaction`, so that a dead connection is told apart from
	 * a transaction that started and failed.
	 */
	async run<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
		return await withIndexedDbReopen(this, operation);
	}
}

/** Creates every declared store and index that is not already there, and nothing else. */
export function applyIndexedDbSchema(
	database: IDBDatabase,
	schema: readonly IndexedDbStoreSchema[],
): void {
	for (const store of schema) {
		if (database.objectStoreNames.contains(store.name)) continue;
		const created = store.keyPath === undefined
			? database.createObjectStore(store.name)
			: database.createObjectStore(store.name, { keyPath: store.keyPath as string | string[] });
		for (const index of store.indexes ?? []) {
			created.createIndex(index.name, index.keyPath as string | string[]);
		}
	}
}
