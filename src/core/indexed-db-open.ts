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
export type IndexedDbOpenFailureReason = 'error' | 'blocked' | 'refused';

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
	 * handle. OMITTING it installs no handler at all, which is deliberately
	 * available because the Halloween store has never had one, and quietly giving
	 * it one would close a database its own methods still hold.
	 */
	onVersionChange?: 'close' | ((database: IDBDatabase) => void);
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

		const fail = (reason: IndexedDbOpenFailureReason, error: DOMException | null): void => {
			if (settled) return;
			settled = true;
			reject(options.toError(reason, error));
		};

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
			const versionChange = options.onVersionChange;
			if (versionChange !== undefined) {
				database.onversionchange = () => {
					database.close();
					if (versionChange !== 'close') versionChange(database);
				};
			}
			resolve(database);
		};
	});
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
