/**
 * The detection quality events (H3.10), one IndexedDB database per vault since DU-08, bounded, and tolerant of a row
 * that no longer validates.
 *
 * Until DU-08 every vault open with the plugin in one Obsidian wrote the same `tyrian-companion-detection-quality`
 * database (they share the origin and so the whole IndexedDB), nothing ever removed an event, and one row that did not
 * validate made `load` answer `corrupt` for all of them, which turned the measurement off for the rest of the run. Each
 * vault now has `<name>:<vaultId>`, with the same `vaultId` the session, coordination, confirmation queue and pilot
 * metrics databases receive (DU-11: each vault is independent). It keeps the newest `DETECTION_QUALITY_MAX_EVENTS`
 * events, and an unreadable row is retired and counted instead of failing the rest, as DU-07 does when pruning prices.
 *
 * The common database an earlier release wrote is never migrated in place and never deleted, as with the confirmation
 * queue (DU-03) and the session pair (H18.12). Nothing in an event says which vault recorded it, so a vault whose own
 * database holds no event starts, once, from a COPY of the readable events the common database holds (the newest that
 * fit the limit). Every vault gets the same copy: what each vault showed before this release is what it shows after
 * it, and a session that was running across the update keeps its start event. The copy is read before the vault's own
 * read-write transaction (one transaction cannot wait for another database) and written only if the vault's own
 * database is still empty in it; a failure reading the common database fails the load without writing, so the copy
 * can still be made later. Without `IDBFactory.databases()` nothing is adopted: checking for the common database must
 * not create it.
 */
import {
	compareDetectionQualityEvents,
	isDetectionQualityEvent,
	type DetectionQualityEvent,
} from './session-detection-quality';
import {
	IndexedDbUnavailableError,
	ReopeningIndexedDbConnection,
	indexedDbFailureCode,
	isIndexedDbUnavailable,
	openIndexedDb,
	startIndexedDbTransaction,
} from '../core/indexed-db-open';
import {
	LocalDebugPersistenceProbe,
	type LocalDebugPersistenceContext,
} from '../core/local-debug-persistence';

export const DETECTION_QUALITY_DB_NAME = 'tyrian-companion-detection-quality';
export const DETECTION_QUALITY_DB_VERSION = 1;
export const DETECTION_QUALITY_STORE_NAME = 'events-v1';
/**
 * DU-08: how many events one vault keeps. A session leaves two accepted boundaries plus one event per dismissed
 * proposal, so this is several hundred sessions of history; each event is a few hundred bytes to a few kB (an assisted
 * start carries its proposal's gains). Past it the oldest by `recordedAt` go first.
 */
export const DETECTION_QUALITY_MAX_EVENTS = 2_000;

/** DU-08: one vault's events, `<name>:<vaultId>`, like the session, queue and pilot metrics databases. */
export function vaultDetectionQualityDatabaseName(vaultId: string): string {
	if (vaultId.length === 0) throw new Error('A vault id is required to scope detection quality storage.');
	return `${DETECTION_QUALITY_DB_NAME}:${vaultId}`;
}

/** One stored row: its key and whatever is under it, readable or not. */
export interface DetectionQualityRow {
	key: IDBValidKey;
	value: unknown;
}

/** What a vault keeps of its rows: the readable events, and the keys to delete. */
export interface DetectionQualityRetention {
	/** The newest readable events, at most `maximum`, oldest first. */
	kept: DetectionQualityEvent[];
	/** Rows that do not validate as an event (DU-08): retired, never returned. */
	unreadable: IDBValidKey[];
	/** Readable rows past the limit, oldest first. */
	pruned: IDBValidKey[];
}

/**
 * DU-08: splits stored rows into the events a vault keeps, the unreadable rows to retire and the oldest readable rows
 * past `maximum`. A row is unreadable when it does not validate or when it sits under a key that is not its own event id.
 */
export function retainDetectionQualityRows(rows: readonly DetectionQualityRow[], maximum: number): DetectionQualityRetention {
	const readable: { key: IDBValidKey; event: DetectionQualityEvent }[] = [];
	const unreadable: IDBValidKey[] = [];
	for (const row of rows) {
		if (isDetectionQualityEvent(row.value) && row.key === row.value.eventId) readable.push({ key: row.key, event: row.value });
		else unreadable.push(row.key);
	}
	readable.sort((left, right) => compareDetectionQualityEvents(left.event, right.event));
	const cut = Math.max(0, readable.length - maximum);
	return {
		kept: readable.slice(cut).map((entry) => structuredClone(entry.event)),
		unreadable,
		pruned: readable.slice(0, cut).map((entry) => entry.key),
	};
}

export type DetectionQualityLoadResult =
	| { status: 'loaded'; events: DetectionQualityEvent[] }
	| { status: 'empty' }
	| { status: 'error'; code: 'corrupt' | 'unavailable' };

export type DetectionQualityAppendResult =
	| { status: 'saved' | 'duplicate' }
	| { status: 'error'; code: 'conflict' | 'corrupt' | 'unavailable' };

export interface DetectionQualityStore {
	load(context?: LocalDebugPersistenceContext): Promise<DetectionQualityLoadResult>;
	append(event: DetectionQualityEvent, context?: LocalDebugPersistenceContext): Promise<DetectionQualityAppendResult>;
	close(): void;
}

/** Test seed (DE-09): in-memory double of the IndexedDB store; only the detection quality tests build it. */
export class MemoryDetectionQualityStore implements DetectionQualityStore {
	private readonly values = new Map<string, unknown>();

	constructor(initial: readonly unknown[] = []) {
		for (const value of initial) {
			if (isDetectionQualityEvent(value)) this.values.set(value.eventId, structuredClone(value));
			else this.values.set(`corrupt:${this.values.size}`, structuredClone(value));
		}
	}

	async load(): Promise<DetectionQualityLoadResult> {
		const retention = retainDetectionQualityRows(
			[...this.values].map(([key, value]) => ({ key, value })), Number.MAX_SAFE_INTEGER,
		);
		// DU-08: an unreadable row is retired, as the IndexedDB store does.
		for (const key of retention.unreadable) this.values.delete(key as string);
		return retention.kept.length === 0 ? { status: 'empty' } : { status: 'loaded', events: retention.kept };
	}

	async append(event: DetectionQualityEvent): Promise<DetectionQualityAppendResult> {
		if (!isDetectionQualityEvent(event)) return { status: 'error', code: 'corrupt' };
		const current = this.values.get(event.eventId);
		if (current !== undefined && isDetectionQualityEvent(current)) {
			return JSON.stringify(current) === JSON.stringify(event)
				? { status: 'duplicate' }
				: { status: 'error', code: 'conflict' };
		}
		this.values.set(event.eventId, structuredClone(event));
		return { status: 'saved' };
	}

	close(): void {}
}

/** What one read-write pass over a vault's events did. */
interface DetectionQualityPass<T> {
	result: T;
	unreadable: number;
	pruned: number;
	adopted: number;
}

/**
 * A connection the engine dropped, or that a `versionchange` other than an upgrade released, is replaced on the next
 * operation (DU-05); `close()` and a real upgrade end the store for good.
 */
export class IndexedDbDetectionQualityStore implements DetectionQualityStore {
	private readonly connection: ReopeningIndexedDbConnection;
	/** The diagnostic context of the operation that is opening, if one is; an open is recorded under it. */
	private openingContext: LocalDebugPersistenceContext | undefined;
	/** DU-08: this store's own events are known to exist, or the common database had nothing to adopt; it is never read again. */
	private adoptionSettled = false;

	/**
	 * `adoptFrom` names the common database of an earlier release (DU-08) that this store copies while its own holds no
	 * event; null, the default, adopts nothing. `maximumEvents` is how many events it keeps.
	 */
	constructor(
		private readonly factory: IDBFactory,
		databaseName = DETECTION_QUALITY_DB_NAME,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
		private readonly adoptFrom: string | null = null,
		private readonly maximumEvents = DETECTION_QUALITY_MAX_EVENTS,
	) {
		this.connection = new ReopeningIndexedDbConnection(async (hooks) => {
			const attempt = this.diagnostics.begin('detection_quality', 'open', this.openingContext);
			try {
				const database = await openIndexedDb({
					factory,
					databaseName,
					databaseVersion: DETECTION_QUALITY_DB_VERSION,
					schema: [{ name: DETECTION_QUALITY_STORE_NAME }],
					...hooks,
					toError: (reason) => new Error(reason === 'blocked'
						? 'Detection quality storage upgrade was blocked.'
						: 'Could not open detection quality storage.'),
				});
				attempt.success();
				return database;
			} catch (error) {
				attempt.failure(indexedDbFailureCode(error), error);
				throw error;
			}
		}, () => new Error('Detection quality storage is unavailable.'));
	}

	/**
	 * The vault's events, newest `maximumEvents`, oldest first. The same read-write pass adopts the common database's
	 * copy while the vault has none, retires unreadable rows and deletes the oldest past the limit.
	 */
	async load(context?: LocalDebugPersistenceContext): Promise<DetectionQualityLoadResult> {
		const attempt = this.diagnostics.begin('detection_quality', 'read', context);
		try {
			const pass = await this.run(context, async (database) => {
				// Read before the transaction (it cannot wait for another database), written only if the own store is still empty in it.
				const seed = await this.adoptionSeed(database);
				return await this.loadTransaction(database, seed);
			});
			if (pass.adopted > 0 || pass.result.length > 0) this.adoptionSettled = true;
			this.report(pass);
			if (pass.result.length === 0) { attempt.skip(); return { status: 'empty' }; }
			attempt.success();
			return { status: 'loaded', events: pass.result };
		} catch (error) {
			attempt.failure(indexedDbFailureCode(error), error);
			return { status: 'error', code: 'unavailable' };
		}
	}

	async append(event: DetectionQualityEvent, context?: LocalDebugPersistenceContext): Promise<DetectionQualityAppendResult> {
		const attempt = this.diagnostics.begin('detection_quality', 'write', context);
		if (!isDetectionQualityEvent(event)) { attempt.failure('validation_failed'); return { status: 'error', code: 'corrupt' }; }
		try {
			const pass = await this.run(context, async (database) => await this.appendTransaction(database, event));
			this.report(pass);
			const result = pass.result;
			if (result.status === 'saved') attempt.success();
			else if (result.status === 'duplicate') attempt.skip();
			else attempt.failure('validation_failed');
			return result;
		} catch (error) {
			attempt.failure(indexedDbFailureCode(error), error);
			return { status: 'error', code: 'unavailable' };
		}
	}

	close(): void {
		const attempt = this.diagnostics.begin('detection_quality', 'close');
		this.connection.close();
		attempt.success();
	}

	/**
	 * One operation on the cached connection, replacing a dead one once (DU-05). An open it causes is recorded under
	 * `context`; a second dead connection is this operation's failure, reported as the store being unavailable.
	 */
	private async run<T>(context: LocalDebugPersistenceContext | undefined, operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
		this.openingContext = context;
		try {
			return await this.connection.run(operation);
		} catch (error) {
			// Both ways `withIndexedDbReopen` gives up are the store being unavailable; the reason stays for the diagnostic code.
			throw isIndexedDbUnavailable(error) ? new IndexedDbUnavailableError('Detection quality storage is unavailable.', error) : error;
		}
	}

	/** Records what a pass retired, pruned or adopted, on the store's own probe; nothing when it did none of them. */
	private report(pass: DetectionQualityPass<unknown>): void {
		if (pass.unreadable > 0) {
			this.diagnostics.begin('detection_quality', 'recover').skip('corrupt_tail_recovered', {
				reason: 'unreadable_row_retired', rows: String(pass.unreadable), objectStore: DETECTION_QUALITY_STORE_NAME,
			});
		}
		if (pass.pruned > 0) {
			this.diagnostics.begin('detection_quality', 'delete').success('ok', {
				reason: 'retention_limit', rows: String(pass.pruned), objectStore: DETECTION_QUALITY_STORE_NAME,
			});
		}
		if (pass.adopted > 0) {
			this.diagnostics.begin('detection_quality', 'recover').success('ok', {
				reason: 'common_store_copied', rows: String(pass.adopted), objectStore: DETECTION_QUALITY_STORE_NAME,
			});
		}
	}

	/**
	 * DU-08: what this vault starts from while its own store holds no event: a copy of the common database's readable
	 * events, or nothing. Once the vault has events, or the common database was read and has none to give, it answers
	 * nothing without reading anything. A failure to read the common database rejects, so the load fails and nothing is
	 * written that would make the copy impossible later.
	 */
	private async adoptionSeed(database: IDBDatabase): Promise<DetectionQualityEvent[] | undefined> {
		if (this.adoptFrom === null || this.adoptionSettled) return undefined;
		if (await countEvents(database) > 0) {
			this.adoptionSettled = true;
			return undefined;
		}
		const seed = retainDetectionQualityRows(await this.readCommonRows(this.adoptFrom), this.maximumEvents).kept;
		// Nothing readable there (or no common database): there is nothing to adopt later either.
		if (seed.length === 0) {
			this.adoptionSettled = true;
			return undefined;
		}
		return seed;
	}

	/** Every row of the common database, or none when it does not exist; opening it only after listing never creates it. */
	private async readCommonRows(name: string): Promise<DetectionQualityRow[]> {
		// The DOM typings declare it, but an injected factory may still predate it.
		const listDatabases = (this.factory as Partial<Pick<IDBFactory, 'databases'>>).databases;
		if (typeof listDatabases !== 'function') return [];
		if (!(await listDatabases.call(this.factory)).some((info) => info.name === name)) return [];
		const common = await openIndexedDb({
			factory: this.factory,
			databaseName: name,
			databaseVersion: DETECTION_QUALITY_DB_VERSION,
			schema: [{ name: DETECTION_QUALITY_STORE_NAME }],
			onVersionChange: 'close',
			toError: (reason) => new Error(reason === 'blocked'
				? 'The earlier detection quality database was blocked.'
				: 'Could not open the earlier detection quality database.'),
		});
		try {
			if (!common.objectStoreNames.contains(DETECTION_QUALITY_STORE_NAME)) return [];
			return await new Promise<DetectionQualityRow[]>((resolve, reject) => {
				// Its own connection, opened for this read only: a failure here is this load's, never a reason to reopen the vault's.
				const transaction = common.transaction(DETECTION_QUALITY_STORE_NAME, 'readonly');
				const rows: DetectionQualityRow[] = [];
				const request = transaction.objectStore(DETECTION_QUALITY_STORE_NAME).openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (cursor === null) return;
					rows.push({ key: cursor.primaryKey, value: cursor.value as unknown });
					cursor.continue();
				};
				transaction.oncomplete = () => resolve(rows);
				transaction.onerror = () => reject(new Error('Could not read the earlier detection quality database.'));
				transaction.onabort = () => reject(new Error('Reading the earlier detection quality database was aborted.'));
			});
		} finally {
			common.close();
		}
	}

	/**
	 * One read-write pass: writes `seed` if the store is still empty, then reads every row, retires the unreadable ones
	 * and deletes the oldest readable ones past the limit.
	 */
	private loadTransaction(database: IDBDatabase, seed: readonly DetectionQualityEvent[] | undefined): Promise<DetectionQualityPass<DetectionQualityEvent[]>> {
		return new Promise((resolve, reject) => {
			// A dead connection throws here, before anything was read or written, so running it again is safe.
			const transaction = startIndexedDbTransaction(database, DETECTION_QUALITY_STORE_NAME, 'readwrite');
			const store = transaction.objectStore(DETECTION_QUALITY_STORE_NAME);
			let adopted = 0;
			let pass: DetectionQualityPass<DetectionQualityEvent[]> = { result: [], unreadable: 0, pruned: 0, adopted: 0 };
			const compactAll = (): void => {
				compactRows(store, this.maximumEvents, (retention) => {
					pass = { result: retention.kept, unreadable: retention.unreadable.length, pruned: retention.pruned.length, adopted };
				});
			};
			if (seed === undefined) compactAll();
			else {
				const counting = store.count();
				counting.onsuccess = () => {
					if (counting.result === 0) {
						for (const event of seed) store.put(structuredClone(event), event.eventId);
						adopted = seed.length;
					}
					compactAll();
				};
			}
			transaction.oncomplete = () => resolve(pass);
			transaction.onerror = () => reject(new Error('Could not read detection quality storage.'));
			transaction.onabort = () => reject(new Error('Detection quality read was aborted.'));
		});
	}

	/**
	 * Saves `event` unless the same id holds it already (duplicate) or a different readable event (conflict); an
	 * unreadable row under that id is replaced. A save past the limit deletes the oldest in the same transaction.
	 */
	private appendTransaction(database: IDBDatabase, event: DetectionQualityEvent): Promise<DetectionQualityPass<DetectionQualityAppendResult>> {
		return new Promise((resolve, reject) => {
			// A dead connection throws here, before anything was read or written, so running it again is safe.
			const transaction = startIndexedDbTransaction(database, DETECTION_QUALITY_STORE_NAME, 'readwrite');
			const store = transaction.objectStore(DETECTION_QUALITY_STORE_NAME);
			const request = store.get(event.eventId);
			let pass: DetectionQualityPass<DetectionQualityAppendResult> = {
				result: { status: 'error', code: 'unavailable' }, unreadable: 0, pruned: 0, adopted: 0,
			};
			let mutationFailed = false;
			request.onsuccess = () => {
				const current = request.result as unknown;
				if (current !== undefined && isDetectionQualityEvent(current)) {
					pass = { ...pass, result: JSON.stringify(current) === JSON.stringify(event)
						? { status: 'duplicate' }
						: { status: 'error', code: 'conflict' } };
					return;
				}
				// DU-08: an unreadable row under this id is retired by the save itself.
				pass = { ...pass, result: { status: 'saved' }, unreadable: current === undefined ? 0 : 1 };
				store.put(structuredClone(event), event.eventId);
				const counting = store.count();
				counting.onsuccess = () => {
					if (counting.result <= this.maximumEvents) return;
					const retired = pass.unreadable;
					compactRows(store, this.maximumEvents, (retention) => {
						pass = { ...pass, unreadable: retired + retention.unreadable.length, pruned: retention.pruned.length };
					});
				};
			};
			request.onerror = () => {
				mutationFailed = true;
				transaction.abort();
			};
			transaction.oncomplete = () => resolve(pass);
			transaction.onerror = () => reject(new Error('Could not update detection quality storage.'));
			transaction.onabort = () => reject(new Error(
				mutationFailed ? 'Detection quality mutation failed.' : 'Detection quality update was aborted.',
			));
		});
	}
}

/**
 * Reads every row of `store` with a cursor, then deletes the unreadable ones and the oldest readable ones past
 * `maximum`, all inside the caller's transaction; `done` gets the retention once the deletes are issued.
 */
function compactRows(store: IDBObjectStore, maximum: number, done: (retention: DetectionQualityRetention) => void): void {
	const rows: DetectionQualityRow[] = [];
	const request = store.openCursor();
	request.onsuccess = () => {
		const cursor = request.result;
		if (cursor !== null) {
			rows.push({ key: cursor.primaryKey, value: cursor.value as unknown });
			cursor.continue();
			return;
		}
		const retention = retainDetectionQualityRows(rows, maximum);
		for (const key of [...retention.unreadable, ...retention.pruned]) store.delete(key);
		done(retention);
	};
}

/** How many rows `database` holds, in a read-only transaction of its own. */
function countEvents(database: IDBDatabase): Promise<number> {
	return new Promise((resolve, reject) => {
		const transaction = startIndexedDbTransaction(database, DETECTION_QUALITY_STORE_NAME, 'readonly');
		const request = transaction.objectStore(DETECTION_QUALITY_STORE_NAME).count();
		let count = 0;
		request.onsuccess = () => { count = request.result; };
		transaction.oncomplete = () => resolve(count);
		transaction.onerror = () => reject(new Error('Could not read detection quality storage.'));
		transaction.onabort = () => reject(new Error('Detection quality read was aborted.'));
	});
}
