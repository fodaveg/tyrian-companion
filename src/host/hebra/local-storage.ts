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
	keys(): Promise<string[]>;
}

export function createMemoryFileBackend(): LocalFileBackend {
	const files = new Map<string, string>();
	return {
		get: async (key) => files.get(key),
		set: async (key, value) => { files.set(key, value); },
		delete: async (key) => { files.delete(key); },
		keys: async () => [...files.keys()],
	};
}

/** Logical name for `api.storage.indexedDbName`; Hebra maps it to `hebra-tyrian-local-files`. */
export const LOCAL_FILES_DATABASE = 'local-files';
const FILE_STORE_NAME = 'files';

/** An IndexedDB database of the webview, apart from the core's (`kv.indexedDB`) and the path index. */
export function createIndexedDbFileBackend(factory: IDBFactory, databaseName: string): LocalFileBackend {
	let dbPromise: Promise<IDBDatabase> | undefined;
	const open = (): Promise<IDBDatabase> => (dbPromise ??= new Promise((resolve, reject) => {
		const request = factory.open(databaseName, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(FILE_STORE_NAME)) request.result.createObjectStore(FILE_STORE_NAME);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('tyrian-local-files: open'));
	}));
	const run = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
		const db = await open();
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(FILE_STORE_NAME, mode);
			const request = operation(tx.objectStore(FILE_STORE_NAME));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error ?? new Error('tyrian-local-files: transaction'));
		});
	};
	return {
		get: async (key) => await run('readonly', (store) => store.get(key)) as string | undefined,
		set: async (key, value) => { await run('readwrite', (store) => store.put(value, key)); },
		delete: async (key) => { await run('readwrite', (store) => store.delete(key)); },
		keys: async () => (await run('readonly', (store) => store.getAllKeys())).map(String),
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
	return {
		async exists(path) {
			if (await backend.get(fileKey(path)) !== undefined) return true;
			const dir = dirMarker(path);
			return (await backend.keys()).some((key) => key.startsWith(dir));
		},
		async read(path) {
			const value = await backend.get(fileKey(path));
			if (value === undefined) throw new Error(`tyrian local: ${path} does not exist`);
			return value;
		},
		write: async (path, data) => { await backend.set(fileKey(path), data); },
		async append(path, data) {
			const current = await backend.get(fileKey(path)) ?? '';
			await backend.set(fileKey(path), `${current}${data}`);
		},
		mkdir: async (path) => { await backend.set(dirMarker(path), ''); },
		remove: async (path) => { await backend.delete(fileKey(path)); },
		async rename(path, destination) {
			const value = await backend.get(fileKey(path));
			if (value === undefined) throw new Error(`tyrian local: ${path} does not exist`);
			await backend.set(fileKey(destination), value);
			await backend.delete(fileKey(path));
		},
	};
}

function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/gu, '');
}
