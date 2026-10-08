/**
 * Where `TyrianPathIndex` keeps its snapshot (SPEC-TYRIAN-EN-HEBRA.md §3): per device, never
 * synced; each device rebuilds it with `seedTyrianPathIndex` when it is missing or corrupt.
 *
 * This is NOT the core's `TyrianKvPort` (`kv.indexedDB`, the core's own databases): it is
 * HebraHost bookkeeping the core never sees, behind a one-key, one-text-value interface so the
 * index can be tested with an in-memory double.
 */

import { startIndexedDbTransaction, withIndexedDbReopen } from '../../core/indexed-db-open';

export interface TyrianPathIndexKv {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
}

/** Faithful double for tests: same contract, no IndexedDB. */
export function createMemoryPathIndexKv(): TyrianPathIndexKv {
	const store = new Map<string, string>();
	return {
		get: async (key) => store.get(key),
		set: async (key, value) => { store.set(key, value); },
	};
}

/**
 * Logical name of the database, handed to `api.storage.indexedDbName`. Hebra maps it to the name
 * the compiled module used (`hebra-tyrian-path-index`), so an index saved before the move to a
 * plugin is read as it is (SPEC-PLUGINS-EXTERNOS.md §11.2).
 */
export const PATH_INDEX_DATABASE = 'path-index';
const STORE_NAME = 'index';

/**
 * One database with one object store in the webview's IndexedDB, apart from the core's own. One
 * row per key and no custom transactions: one entry per library of a few thousand notes does not
 * need them.
 */
export function createIndexedDbPathIndexKv(factory: IDBFactory, databaseName: string): TyrianPathIndexKv {
	// Same shape as the file backend next door (`createIndexedDbFileBackend`): the connection is kept
	// between calls but not past its death, and an open that failed is not kept at all. One reopen
	// per call (`withIndexedDbReopen`).
	let cached: { opening: Promise<IDBDatabase>; database: IDBDatabase | null } | null = null;
	const forget = (database: IDBDatabase): void => {
		if (cached?.database === database) cached = null;
	};
	const open = (): Promise<IDBDatabase> => {
		if (cached !== null) return cached.opening;
		const entry: { opening: Promise<IDBDatabase>; database: IDBDatabase | null } = {
			database: null,
			opening: new Promise<IDBDatabase>((resolve, reject) => {
				const request = factory.open(databaseName, 1);
				request.onupgradeneeded = () => {
					if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
				};
				request.onsuccess = () => {
					const database = request.result;
					entry.database = database;
					database.onclose = () => { forget(database); };
					resolve(database);
				};
				request.onerror = () => reject(request.error ?? new Error('tyrian-path-index-kv: open'));
			}),
		};
		cached = entry;
		entry.opening.catch(() => { if (cached === entry) cached = null; });
		return entry.opening;
	};
	const discard = (database: IDBDatabase): void => {
		forget(database);
		try { database.close(); } catch { /* Already gone, which is the reason it is being dropped. */ }
	};
	const run = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
		await withIndexedDbReopen({ open, discard }, async (db) => await new Promise<T>((resolve, reject) => {
			// A throw here rejects this promise: the executor runs synchronously inside it.
			const tx = startIndexedDbTransaction(db, STORE_NAME, mode);
			const request = operation(tx.objectStore(STORE_NAME));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error ?? new Error('tyrian-path-index-kv: transaction'));
			// An abort does not always come with an `error` event; without this the save never settles.
			tx.onabort = () => reject(tx.error ?? new Error('tyrian-path-index-kv: transaction aborted'));
		}));
	return {
		get: async (key) => (await run('readonly', (store) => store.get(key)) as string | undefined) ?? undefined,
		set: async (key, value) => { await run('readwrite', (store) => store.put(value, key)); },
	};
}
