/**
 * What HebraHost keeps outside the library (SPEC-TYRIAN-EN-HEBRA.md §2-§3), all through
 * `api.storage` so the plugin reads exactly what the compiled module wrote (SPEC-PLUGINS-EXTERNOS.md
 * §11.2, nothing is copied):
 *
 * - `settings`: the plugin's JSON (Obsidian's `data.json`) in `api.storage.settings`, which Hebra
 *   keeps under `hebra.library-v1.module.tyrian-companion.settings:<libraryId>`. A new library has
 *   none, so the core starts in consultation mode (R1b: no key, no collector). The settings of
 *   THIS device (`HEBRA_DEVICE_SETTING_KEYS`) are split off into `api.storage.device` instead;
 * - `localStorage`: the core's small per-device values (the in-game session link, the farming
 *   context of the session in progress, where this device shows the plugin) in
 *   `api.storage.device`, under `…tyrian-companion.local:<libraryId>:<key>`; never synced;
 * - `adapter`/`diagnostics.storage`: raw writes under `configDir` (the rotating diagnostic log, the
 *   advisor capture receipt, the support package). They are not notes: they go to an IndexedDB
 *   database of their own (`api.storage.indexedDbName('local-files')`), not to the synced library.
 */
import type { PluginStorage } from 'hebra-plugin-api';

import { openIndexedDb, startIndexedDbTransaction, withIndexedDbReopen } from '../../core/indexed-db-open';
import { DEFAULT_SETTINGS } from '../../core/settings';
import type { LocalDebugStoragePort } from '../../core/local-debug-writer';
import type { TyrianLocalStoragePort, TyrianSettingsPort } from '../tyrian-host';

/** `settings` plus `latest()`: the last value loaded or saved, for whoever reads a setting outside
 *  the core (the webhook on every HTTP call, the output folder on every save). */
export interface HebraTyrianSettingsPort extends TyrianSettingsPort {
	latest(): unknown;
}

/**
 * The settings that belong to THIS device rather than to the library (decision of 10 Oct 2026):
 * the in-game bridge (whether it listens, its loopback port and the NAME of its keychain entry,
 * whose value already lives in this device's keychain), the diagnostic log switch and level, and
 * the receipt of the last inventory sync run here. `api.storage.settings` is the scope that will
 * travel with the library once Hebra syncs settings; these stay in `api.storage.device`, which
 * never syncs. Everything else (the webhook URL and the output folder included) stays shared.
 *
 * Only Hebra splits them: the core still sees one settings object, and Obsidian's `data.json`
 * keeps its exact contract.
 */
export const HEBRA_DEVICE_SETTING_KEYS = Object.freeze([
	'alertIngameEnabled',
	'alertIngamePort',
	'alertIngameSecret',
	'debugLoggingEnabled',
	'debugLoggingLevel',
	'inventorySyncLastRun',
] as const);

/** The `api.storage.device` key of a device setting. Hebra namespaces it per library
 *  (`…tyrian-companion.local:<libraryId>:<key>`), like the core's own device values. */
export function hebraDeviceSettingKey(key: string): string {
	return `tyrian-companion:setting:${key}`;
}

export interface TyrianSettingsPortOptions {
	/** Where a failure the port recovers from goes (`HebraHostDeps.report`). */
	report?: (error: unknown, where: string) => void;
}

/**
 * The core's settings over Hebra's two scopes. `load` hands the core ONE object: the shared one
 * with the device settings laid over it, the device value winning. `save` splits it again: the
 * device settings go to `api.storage.device` and are never written to `api.storage.settings`.
 *
 * A library saved by an older build still has the device settings in the shared scope. `load`
 * moves each one that this device does not hold yet, once: it copies it to `device` and only then
 * drops it from `settings`. A copy that fails leaves it in `settings`, so nothing is lost and the
 * next load tries again. A device setting found in neither scope reaches the core as its default
 * (`DEFAULT_SETTINGS`), so a device without a value of its own starts with diagnostic logging off.
 */
export function createTyrianSettingsPort(
	storage: Pick<PluginStorage, 'settings' | 'device'>,
	options: TyrianSettingsPortOptions = {},
): HebraTyrianSettingsPort {
	const report = options.report ?? (() => undefined);
	let latest: unknown = null;
	return {
		async load() {
			// Hebra reads a corrupt value as null, which the core migrates to its defaults. With no
			// shared object there is nothing to lay the device values over: a library without settings
			// must still load null (the core starts in consultation mode).
			const shared = await storage.settings.load();
			latest = isSettingsObject(shared) ? await withDeviceSettings(storage, shared, report) : shared;
			return latest;
		},
		async save(data) {
			latest = data;
			if (!isSettingsObject(data)) {
				await storage.settings.save(data);
				return;
			}
			const shared: Record<string, unknown> = { ...data };
			// Device first: a device write that throws rejects the save before the shared scope changes.
			for (const key of HEBRA_DEVICE_SETTING_KEYS) {
				const value = data[key];
				delete shared[key];
				if (value === null || value === undefined) storage.device.remove(hebraDeviceSettingKey(key));
				else storage.device.set(hebraDeviceSettingKey(key), value);
			}
			await storage.settings.save(shared);
		},
		latest: () => latest,
	};
}

/**
 * The shared settings with this device's settings laid over them, moving to `device` the ones an
 * older build left in `settings`. Idempotent: once moved, a key is in `device` and not in
 * `settings`, so the next load writes nothing.
 */
async function withDeviceSettings(
	storage: Pick<PluginStorage, 'settings' | 'device'>,
	shared: Record<string, unknown>,
	report: (error: unknown, where: string) => void,
): Promise<Record<string, unknown>> {
	const merged: Record<string, unknown> = { ...shared };
	const remaining: Record<string, unknown> = { ...shared };
	let moved = false;
	for (const key of HEBRA_DEVICE_SETTING_KEYS) {
		const local = storage.device.get(hebraDeviceSettingKey(key));
		if (local !== null && local !== undefined) {
			// This device's value wins. A stale shared copy is left alone here: the next save drops it.
			merged[key] = local;
			continue;
		}
		if (!Object.prototype.hasOwnProperty.call(shared, key)) {
			// In neither scope (a device that never saved them, settings that arrived by sync, a
			// downgrade): the core's default, never the reading `migrateSettings` gives an absent key,
			// which for `debugLoggingEnabled` is "on". Only what the core gets: `device` stays empty.
			merged[key] = DEFAULT_SETTINGS[key];
			continue;
		}
		const value = shared[key];
		// `null` (the empty sync receipt) is what an absent device key reads as: nothing to copy.
		if (value !== null && value !== undefined) {
			try {
				storage.device.set(hebraDeviceSettingKey(key), value);
			} catch (error) {
				// The value stays in `settings` (and in what the core gets); the next load tries again.
				report(error, 'settings.device-move');
				continue;
			}
		}
		delete remaining[key];
		moved = true;
	}
	if (moved) {
		try {
			await storage.settings.save(remaining);
		} catch (error) {
			// The copies are already in `device`, which wins on every load, so the stale shared ones
			// lose nothing; the next save drops them. Starting without settings would be worse.
			report(error, 'settings.device-move');
		}
	}
	return merged;
}

function isSettingsObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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
			// The shared open: it also gives up on an engine that never answers, and closes a database that arrives after that.
			opening: openIndexedDb({
				factory, databaseName, databaseVersion: 1, schema: [{ name: FILE_STORE_NAME }],
				onClose: forget,
				toError: () => new Error('tyrian-local-files: open'),
			}).then((database) => { entry.database = database; return database; }),
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
