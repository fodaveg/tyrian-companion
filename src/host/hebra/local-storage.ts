/**
 * What HebraHost keeps outside the library (SPEC-TYRIAN-EN-HEBRA.md §2-§3), all through
 * `api.storage` so the plugin reads exactly what the compiled module wrote (SPEC-PLUGINS-EXTERNOS.md
 * §11.2, nothing is copied):
 *
 * - `settings`: the plugin's JSON (Obsidian's `data.json`) in `api.storage.settings`, which Hebra
 *   keeps under `hebra.library-v1.module.tyrian-companion.settings:<libraryId>`. A new library has
 *   none, so the core starts in consultation mode (R1b: no key, no collector). The settings of
 *   THIS device (`HEBRA_DEVICE_SETTING_KEYS`) are read from and saved to `api.storage.device`;
 * - `localStorage`: the core's small per-device values (the in-game session link, the farming
 *   context of the session in progress, where this device shows the plugin) in
 *   `api.storage.device`, under `…tyrian-companion.local:<libraryId>:<key>`; never synced;
 * - `adapter`/`diagnostics.storage`: raw writes under `configDir` (the rotating diagnostic log, the
 *   advisor capture receipt, the support package). They are not notes: they go to an IndexedDB
 *   database of their own (`api.storage.indexedDbName('local-files')`), not to the synced library.
 */
import type { PluginStorage } from 'hebra-plugin-api';

import { openIndexedDb, startIndexedDbTransaction, withIndexedDbReopen } from '../../core/indexed-db-open';
import { DEFAULT_SETTINGS, isNewerSettingsSchema } from '../../core/settings';
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
 * the receipt of the last inventory sync run here. `api.storage.settings` already travels with
 * the library: Hebra syncs it between devices, plugin by plugin, with the user's consent
 * (`plugins/sync/plugin-sync-controller.ts`, since 4 Oct 2026). These live in
 * `api.storage.device`, which never syncs. Everything else (the webhook URL and the output folder
 * included) stays shared.
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

/** The `api.storage.device` key that says this device already took the shared values once. */
export const HEBRA_DEVICE_SETTINGS_ADOPTED_KEY = hebraDeviceSettingKey('migrated');

type HebraDeviceSettingKey = typeof HEBRA_DEVICE_SETTING_KEYS[number];
const DEVICE_SETTING_KEYS: ReadonlySet<string> = new Set(HEBRA_DEVICE_SETTING_KEYS);

export interface TyrianSettingsPortOptions {
	/** Where a failure the port recovers from goes (`HebraHostDeps.report`). */
	report?: (error: unknown, where: string) => void;
}

/**
 * The core's settings over Hebra's two scopes. `load` hands the core ONE object, in the key order
 * of `DEFAULT_SETTINGS` (the order `migrateSettings` writes, so `shouldPersistSettingsOnLoad` sees
 * no false change): the shared settings with the six device settings from `device`. `save` sends
 * those six to `device` only.
 *
 * The shared copies of the six are FROZEN: a device on an older build still reads and writes them
 * (it knows nothing of `device`), so this build never writes nor removes them in `settings`; a save
 * keeps whatever value each one had there. Dropping them is for a later release, once no device
 * runs an older build.
 *
 * A device adopts the shared values ONCE (`HEBRA_DEVICE_SETTINGS_ADOPTED_KEY`): the first load
 * copies to `device` each shared value it does not hold yet and then sets the mark, only if every
 * copy worked (a failed copy is reported and retried on the next load). With the mark set, nothing
 * is ever taken from `settings` for these keys again, so a value another device writes there later
 * (say, its inventory sync receipt) never reaches this one. A device setting this device does not
 * hold, and does not adopt, reaches the core as its `DEFAULT_SETTINGS` value: a device without a
 * value of its own starts with diagnostic logging off, never with the reading `migrateSettings`
 * gives an absent key (`debugLoggingEnabled !== false`, i.e. on). Defaults are not written.
 *
 * Shared settings of a newer schema (DU-04, `isNewerSettingsSchema`) are read-only: the device
 * values are laid over them and the gaps filled, but nothing is copied, marked or written.
 * Shared settings that are `null` (a new library) or corrupt (Hebra reads those as `null`) load
 * as `null`, untouched, so the core starts in consultation mode as before.
 *
 * `save` is all or nothing: it keeps the previous device values and, if any write fails (in
 * `device` or `settings.save`), puts them back and rethrows.
 */
export function createTyrianSettingsPort(
	storage: Pick<PluginStorage, 'settings' | 'device'>,
	options: TyrianSettingsPortOptions = {},
): HebraTyrianSettingsPort {
	const report = options.report ?? (() => undefined);
	let latest: unknown = null;
	return {
		async load() {
			const shared = await storage.settings.load();
			latest = isSettingsObject(shared) ? withDeviceSettings(storage, shared, report) : shared;
			return latest;
		},
		async save(data) {
			latest = data;
			if (!isSettingsObject(data)) {
				await storage.settings.save(data);
				return;
			}
			// The frozen shared copies, as they are NOW (another device may have synced a new one).
			const before = await storage.settings.load();
			const frozen = isSettingsObject(before) ? before : {};
			const shared: Record<string, unknown> = {};
			for (const key of Object.keys(data)) {
				if (!DEVICE_SETTING_KEYS.has(key)) shared[key] = data[key];
				else if (hasOwn(frozen, key)) shared[key] = frozen[key];
			}
			for (const key of HEBRA_DEVICE_SETTING_KEYS) if (!hasOwn(shared, key) && hasOwn(frozen, key)) shared[key] = frozen[key];
			const deviceKeys = [...HEBRA_DEVICE_SETTING_KEYS.map(hebraDeviceSettingKey), HEBRA_DEVICE_SETTINGS_ADOPTED_KEY];
			const previous = deviceKeys.map((key) => [key, storage.device.get(key)] as const);
			try {
				for (const key of HEBRA_DEVICE_SETTING_KEYS) writeDeviceValue(storage, hebraDeviceSettingKey(key), data[key]);
				// What this device saved is its own value for all six: nothing is adopted from `settings` after this.
				storage.device.set(HEBRA_DEVICE_SETTINGS_ADOPTED_KEY, 1);
				await storage.settings.save(shared);
			} catch (error) {
				for (const [key, value] of previous) {
					try {
						writeDeviceValue(storage, key, value);
					} catch (restoreError) {
						// The save still rejects with its own error; this one only goes to the log.
						report(restoreError, 'settings.device-restore');
					}
				}
				throw error;
			}
		},
		latest: () => latest,
	};
}

/**
 * The shared settings with this device's six (see `createTyrianSettingsPort`): its own value, else
 * the shared one while it has not adopted them yet, else the default. The first time, it copies the
 * adopted ones to `device` and sets the mark. It never writes `settings`.
 */
function withDeviceSettings(
	storage: Pick<PluginStorage, 'device'>,
	shared: Record<string, unknown>,
	report: (error: unknown, where: string) => void,
): Record<string, unknown> {
	const readOnly = isNewerSettingsSchema(shared);
	const adopting = storage.device.get(HEBRA_DEVICE_SETTINGS_ADOPTED_KEY) === null;
	const values = {} as Record<HebraDeviceSettingKey, unknown>;
	const adopted: HebraDeviceSettingKey[] = [];
	for (const key of HEBRA_DEVICE_SETTING_KEYS) {
		const local = storage.device.get(hebraDeviceSettingKey(key));
		if (local !== null && local !== undefined) values[key] = local;
		else if (adopting && hasOwn(shared, key) && shared[key] !== null && shared[key] !== undefined) {
			values[key] = shared[key];
			adopted.push(key);
		} else values[key] = DEFAULT_SETTINGS[key];
	}
	if (adopting && !readOnly) {
		try {
			for (const key of adopted) storage.device.set(hebraDeviceSettingKey(key), values[key]);
			storage.device.set(HEBRA_DEVICE_SETTINGS_ADOPTED_KEY, 1);
		} catch (error) {
			// No mark: the next load adopts again what did not reach `device` (what did, wins). The
			// values still reach the core in this run, and `settings` keeps them as they were.
			report(error, 'settings.device-adopt');
		}
	}
	return inSettingsOrder(shared, values);
}

/** `shared` with the device values, in `DEFAULT_SETTINGS` order; keys it does not know go last, as they were. */
function inSettingsOrder(shared: Record<string, unknown>, values: Record<HebraDeviceSettingKey, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		if (DEVICE_SETTING_KEYS.has(key)) merged[key] = values[key as HebraDeviceSettingKey];
		else if (hasOwn(shared, key)) merged[key] = shared[key];
	}
	for (const key of Object.keys(shared)) if (!hasOwn(merged, key)) merged[key] = shared[key];
	return merged;
}

/** A device value; `null` (the empty sync receipt, or nothing stored) removes the key. */
function writeDeviceValue(storage: Pick<PluginStorage, 'device'>, key: string, value: unknown): void {
	if (value === null || value === undefined) storage.device.remove(key);
	else storage.device.set(key, value);
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
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
