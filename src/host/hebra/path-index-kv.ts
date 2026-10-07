/**
 * Where `TyrianPathIndex` keeps its snapshot (SPEC-TYRIAN-EN-HEBRA.md §3): per device, never
 * synced; each device rebuilds it with `seedTyrianPathIndex` when it is missing or corrupt.
 *
 * This is NOT the core's `TyrianKvPort` (`kv.indexedDB`, the core's own databases): it is
 * HebraHost bookkeeping the core never sees, behind a one-key, one-text-value interface so the
 * index can be tested with an in-memory double.
 */

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
	let dbPromise: Promise<IDBDatabase> | undefined;
	const openDb = (): Promise<IDBDatabase> => (dbPromise ??= new Promise((resolve, reject) => {
		const request = factory.open(databaseName, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('tyrian-path-index-kv: open'));
	}));
	return {
		async get(key) {
			const db = await openDb();
			return await new Promise((resolve, reject) => {
				const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
				request.onsuccess = () => resolve((request.result as string | undefined) ?? undefined);
				request.onerror = () => reject(request.error ?? new Error('tyrian-path-index-kv: get'));
			});
		},
		async set(key, value) {
			const db = await openDb();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, 'readwrite');
				tx.objectStore(STORE_NAME).put(value, key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error ?? new Error('tyrian-path-index-kv: set'));
				// An abort does not always come with an `error` event; without this the save never settles.
				tx.onabort = () => reject(tx.error ?? new Error('tyrian-path-index-kv: set aborted'));
			});
		},
	};
}
