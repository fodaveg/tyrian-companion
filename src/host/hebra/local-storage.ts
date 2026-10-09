/**
 * What HebraHost keeps outside the library (SPEC-TYRIAN-EN-HEBRA.md §2-§3), all through
 * `api.storage` so the plugin reads exactly what the compiled module wrote (SPEC-PLUGINS-EXTERNOS.md
 * §11.2, nothing is copied):
 *
 * - `settings`: the plugin's JSON (Obsidian's `data.json`) in `api.storage.settings`, which Hebra
 *   keeps under `hebra.library-v1.module.tyrian-companion.settings:<libraryId>`. A new library has
 *   none, so the core starts in consultation mode (R1b: no key, no collector);
 * - `localStorage`: the core's small per-device values (today only the in-game session link) in
 *   `api.storage.device`, under `…tyrian-companion.local:<libraryId>:<key>`; never synced;
 * - `adapter`/`diagnostics.storage`: raw writes under `configDir` (the rotating diagnostic log, the
 *   advisor capture receipt, the support package). They are not notes: they go to an IndexedDB
 *   database of their own (`api.storage.indexedDbName('local-files')`), not to the synced library.
 */
import type { PluginStorage } from 'hebra-plugin-api';

import { startIndexedDbTransaction, withIndexedDbReopen } from '../../core/indexed-db-open';
import type { LocalDebugStoragePort } from '../../core/local-debug-writer';
import type { TyrianLocalStoragePort, TyrianSettingsPort } from '../tyrian-host';

/** `settings` plus `latest()`: the last value loaded or saved, for whoever reads a setting outside
 *  the core (the webhook on every HTTP call, the output folder on every save). */
export interface HebraTyrianSettingsPort extends TyrianSettingsPort {
	latest(): unknown;
}

export function createTyrianSettingsPort(storage: Pick<PluginStorage, 'settings'>): HebraTyrianSettingsPort {
	let latest: unknown = null;
	return {
		async load() {
			// Hebra reads a corrupt value as null, which the core migrates to its defaults.
			latest = await storage.settings.load();
			return latest;
		},
		async save(data) {
			latest = data;
			await storage.settings.save(data);
		},
		latest: () => latest,
	};
}

export function createTyrianLocalStoragePort(storage: Pick<PluginStorage, 'device'>): TyrianLocalStoragePort {
	return {
		load: (key) => storage.device.get(key),
		save: (key, value) => {
			if (value === null || value === undefined) storage.device.remove(key);
			else storage.device.set(key, value);
		},
	};
}

/** Key to text, with a key listing (for `exists` on a directory and for `rename`). */
export interface LocalFileBackend {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	/** Every key, or only those that start with `prefix`: a key range, so the rest is not even read. */
	keys(prefix?: string): Promise<string[]>;
	/** Closes the held connection (see `TyrianPathIndexKv.close`); a later call opens a new one. */
	close?(): void;
}

export function createMemoryFileBackend(): LocalFileBackend {
	const files = new Map<string, string>();
	return {
		get: async (key) => files.get(key),
		set: async (key, value) => { files.set(key, value); },
		delete: async (key) => { files.delete(key); },
		keys: async (prefix = '') => [...files.keys()].filter((key) => key.startsWith(prefix)),
	};
}

/** Logical name for `api.storage.indexedDbName`; Hebra maps it to `hebra-tyrian-local-files`. */
export const LOCAL_FILES_DATABASE = 'local-files';
const FILE_STORE_NAME = 'files';

/**
 * An IndexedDB database of the webview, apart from the core's (`kv.indexedDB`) and the path index.
 *
 * The connection is kept between calls, but not past its death: one the engine closed, one that no
 * longer starts transactions and an open that failed are all forgotten, and the call that found out
 * opens one more (one reopen per call, see `withIndexedDbReopen`).
 */
export function createIndexedDbFileBackend(factory: IDBFactory, databaseName: string): LocalFileBackend {
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
					if (!request.result.objectStoreNames.contains(FILE_STORE_NAME)) request.result.createObjectStore(FILE_STORE_NAME);
				};
				request.onsuccess = () => {
					const database = request.result;
					entry.database = database;
					database.onclose = () => { forget(database); };
					resolve(database);
				};
				request.onerror = () => reject(request.error ?? new Error('tyrian-local-files: open'));
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
			const tx = startIndexedDbTransaction(db, FILE_STORE_NAME, mode);
			const request = operation(tx.objectStore(FILE_STORE_NAME));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error ?? new Error('tyrian-local-files: transaction'));
			// An abort does not always come with an `error` event (a connection the engine closed, a
			// commit it refused): without this handler the promise would never settle, and the
			// diagnostic log queue waiting on it would stop for good.
			tx.onabort = () => reject(tx.error ?? new Error('tyrian-local-files: transaction aborted'));
		}));
	return {
		get: async (key) => await run('readonly', (store) => store.get(key)) as string | undefined,
		set: async (key, value) => { await run('readwrite', (store) => store.put(value, key)); },
		delete: async (key) => { await run('readwrite', (store) => store.delete(key)); },
		keys: async (prefix) => (await run('readonly', (store) => store.getAllKeys(
			// `\uffff` sorts after every character a key can continue with.
			prefix === undefined ? undefined : IDBKeyRange.bound(prefix, `${prefix}\uffff`),
		))).map(String),
		close: () => {
			const entry = cached;
			cached = null;
			if (entry === null) return;
			if (entry.database !== null) discard(entry.database);
			// Still opening: close the connection the moment it exists. A failed open has nothing to close.
			else entry.opening.then(discard, () => undefined);
		},
	};
}

/**
 * The `LocalDebugStoragePort` the core uses for `vault.adapter` and `diagnostics.storage`, over a
 * `LocalFileBackend` with the library id as namespace. Directories do not exist as such: one
 * "exists" when it holds a file or was made with `mkdir` (an empty marker is stored).
 */
export function createLocalFileStorage(backend: LocalFileBackend, libraryId: string): LocalDebugStoragePort {
	const prefix = `${libraryId}/`;
	const dirMarker = (path: string): string => `${prefix}${trimSlashes(path)}/`;
	const fileKey = (path: string): string => `${prefix}${trimSlashes(path)}`;
	/** The chunk keys of a file, in append order. */
	const chunkKeysOf = async (path: string): Promise<string[]> => {
		const start = `${fileKey(path)}${CHUNK_SEPARATOR}`;
		return (await backend.keys(start)).sort();
	};
	const chunkKey = (path: string, index: number): string =>
		`${fileKey(path)}${CHUNK_SEPARATOR}${String(index).padStart(CHUNK_INDEX_DIGITS, '0')}`;
	/** `undefined` when the file has neither a whole value nor chunks. */
	const readAll = async (path: string): Promise<string | undefined> => {
		const whole = await backend.get(fileKey(path));
		const chunks = await chunkKeysOf(path);
		if (whole === undefined && chunks.length === 0) return undefined;
		let text = whole ?? '';
		for (const key of chunks) text += await backend.get(key) ?? '';
		return text;
	};
	const dropChunks = async (path: string): Promise<void> => {
		for (const key of await chunkKeysOf(path)) await backend.delete(key);
	};
	return {
		async exists(path) {
			if (await backend.get(fileKey(path)) !== undefined) return true;
			const dir = dirMarker(path);
			const chunks = `${fileKey(path)}${CHUNK_SEPARATOR}`;
			return (await backend.keys(dir)).length > 0 || (await backend.keys(chunks)).length > 0;
		},
		async read(path) {
			const value = await readAll(path);
			if (value === undefined) throw new Error(`tyrian local: ${path} does not exist`);
			return value;
		},
		async write(path, data) {
			// Chunks first: a file never reads back as the new whole value followed by old chunks.
			await dropChunks(path);
			await backend.set(fileKey(path), data);
		},
		async append(path, data) {
			// Only the last chunk is rewritten, so a line costs at most `APPEND_CHUNK_CHARS` of writes
			// however long the log is. A value saved by an older build stays the file's first part.
			const chunks = await chunkKeysOf(path);
			const last = chunks.at(-1);
			if (last === undefined) {
				await backend.set(chunkKey(path, 0), data);
				return;
			}
			const current = await backend.get(last) ?? '';
			if (current.length + data.length <= APPEND_CHUNK_CHARS) {
				await backend.set(last, `${current}${data}`);
				return;
			}
			const lastIndex = Number(last.slice(last.lastIndexOf(CHUNK_SEPARATOR) + 1));
			await backend.set(chunkKey(path, lastIndex + 1), data);
		},
		mkdir: async (path) => { await backend.set(dirMarker(path), ''); },
		async remove(path) {
			await dropChunks(path);
			await backend.delete(fileKey(path));
		},
		async rename(path, destination) {
			const value = await readAll(path);
			if (value === undefined) throw new Error(`tyrian local: ${path} does not exist`);
			await dropChunks(destination);
			await backend.set(fileKey(destination), value);
			await dropChunks(path);
			await backend.delete(fileKey(path));
		},
	};
}

/**
 * A file grows in chunks of this many characters under `<file key><separator><index>`: appending a
 * diagnostic line used to read and write the whole file (filling the 2 MiB log wrote 6 GiB). The
 * file reads as its whole value (the layout of older builds, and what `write` makes) followed by
 * its chunks.
 */
const APPEND_CHUNK_CHARS = 4096;
const CHUNK_SEPARATOR = '\u0000';
const CHUNK_INDEX_DIGITS = 8;

function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/gu, '');
}
