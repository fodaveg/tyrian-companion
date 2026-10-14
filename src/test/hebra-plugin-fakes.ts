/**
 * Test doubles for the Hebra adapter (`src/host/hebra/`), all over the TYPES of `hebra-plugin-api`
 * (the only thing the plugin sees of Hebra). The package's own fake (`createFakePluginApi`) denies
 * capabilities exactly like Hebra and records the `ui`; what it does not model, and the adapter
 * needs, lives here:
 *
 * - `FakeLibrary`: a `PluginVault` in memory WITH folders, files and blobs (`fileReplace` with
 *   `file_stale`), protected notes (`locked`, `body: null`), revisions (`notesRewriteBatch` leaves a
 *   stale entry in `stale`) and the change events Hebra emits (`note-changed`, `library-changed`).
 *   It replaces the in-memory `LibraryStorePort` Hebra's own adapter tests used.
 * - `createHebraStorage`: `api.storage` with Hebra's real key layout over a `Map` standing for
 *   `localStorage`, and its IndexedDB name map. It mirrors Hebra's `src/lib/plugins/api/storage.ts`
 *   (read at Hebra `130c34d6`, 2026-10-03): the migration test seeds what the compiled module wrote
 *   under those keys and checks the plugin reads it.
 * - `createFakeSecrets`: `api.secrets` with the alias Hebra committed to for Tyrian: key `api-key` is
 *   the keychain account `tyrian-api-key-v1` the compiled module used.
 * - `createTyrianTestApi`: a whole `HebraPluginApi` for `tyrian-companion` = the package fake + the
 *   three pieces above + a `workspace` whose `openNote`/`restart` are recorded.
 */
import { createHash } from 'node:crypto';

import { IDBFactory as FakeIdbFactory, IDBKeyRange as FakeIdbKeyRange } from 'fake-indexeddb';
import {
	isPluginApiError,
	type HebraPluginApi,
	type PluginApiErrorCode,
	type PluginCapability,
	type PluginClipboard,
	type PluginFile,
	type PluginFolder,
	type PluginHttpRequest,
	type PluginHttpResponse,
	type PluginNote,
	type PluginNotesScope,
	type PluginPlatform,
	type PluginSecrets,
	type PluginSoundMime,
	type PluginSoundOutcome,
	type PluginStorage,
	type PluginUi,
	type PluginVault,
	type PluginVaultChange,
} from 'hebra-plugin-api/v2';
import { createFakePluginApiV2, type FakePluginApiV2 } from 'hebra-plugin-api/v2/testing';

/** The package's 1.x host under the 2.0 fake: its library, its `ui` that mounts in the test's page, and what it recorded. */
export type FakePluginApi = FakePluginApiV2['host'];

/** A copy of a frozen object of the 2.0 API whose properties a test may replace (getters stay live). */
function thawed<T extends object>(source: T): T {
	const descriptors = Object.getOwnPropertyDescriptors(source);
	for (const descriptor of Object.values(descriptors)) {
		descriptor.configurable = true;
		if ('value' in descriptor) descriptor.writable = true;
	}
	return Object.defineProperties({}, descriptors) as T;
}

/**
 * The 2.0 fake's API with the surfaces of its 1.x host. The published fake (`createFakePluginApiV2`) serves
 * no surface frame yet: its `ui` registrations answer `capability-not-available` and its `has` says no to
 * the main view, which needs one (`visual`). Hebra 2.x does serve them, so here `ui`,
 * `editor.registerCodeBlock` and `has('ui.view.main')` are the 1.x host's, which mounts in the test's page
 * and records what it got (the same as JDex Manager's tests do). The rest is the 2.0 fake's, thawed so a
 * test can still wrap a piece of it.
 */
export function surfacedV2Api(v2: FakePluginApiV2): HebraPluginApi {
	const host = v2.host.api;
	const namespaces = Object.fromEntries(Object.entries(v2.api)
		.map(([key, value]) => [key, typeof value === 'object' && value !== null ? thawed(value as object) : value])) as unknown as HebraPluginApi;
	return {
		...namespaces,
		has: (name) => (name === 'ui.view.main' ? host.has(name) : v2.api.has(name)),
		ui: host.ui as unknown as PluginUi,
		editor: { ...v2.api.editor, registerCodeBlock: (language, render) => host.editor.registerCodeBlock(language, render) },
	};
}

export const FAKE_LIBRARY_ID = 'library-1';
export const FAKE_ROOT_ID = 'root';

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** `title:` of the frontmatter or the first `# …`, the rule of `PluginVault` (good enough here). */
function titleOf(body: string): string {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(body);
	const title = frontmatter ? /^title:\s*"?([^"\n]+)"?\s*$/mu.exec(frontmatter[1] ?? '')?.[1] : undefined;
	if (title) return title.trim();
	const rest = frontmatter ? body.slice(frontmatter[0].length) : body;
	return /^#[ \t]+(.+?)[ \t#]*$/mu.exec(rest)?.[1]?.trim() ?? '';
}

interface StoredNote {
	id: string;
	folderId: string;
	title: string;
	body: string;
	locked: boolean;
	createdAt: number;
	updatedAt: number;
	trashedAt: number | null;
	archivedAt: number | null;
	localSeq: number;
}

export interface FakeLibrary extends PluginVault {
	readonly notes: Map<string, StoredNote>;
	readonly folders: PluginFolder[];
	readonly files: Map<string, PluginFile>;
	readonly blobs: Map<string, Uint8Array>;
	/** Every write call the adapter made, in order (`notesRewriteBatch:<id>`, `fileReplace:<id>`…). */
	readonly writes: string[];
	addFolder(id: string, parentId: string | null, name: string): PluginFolder;
	addNote(id: string, body: string, options?: { folderId?: string; locked?: boolean; title?: string; updatedAt?: number }): StoredNote;
	addFile(id: string, folderId: string, name: string, content: string, options?: { updatedAt?: number }): PluginFile;
	/** Changes a note "from elsewhere" (another device, the editor): its revision moves. */
	touchNote(id: string, body: string): void;
	emit(change: PluginVaultChange): void;
	/** A sync from another device: `note-changed` with `synced`. */
	sync(id: string): void;
	readText(fileId: string): string;
	listenerCount(): number;
}

export function createFakeLibrary(options: { libraryId?: string; rootId?: string; now?: () => number } = {}): FakeLibrary {
	const libraryId = options.libraryId ?? FAKE_LIBRARY_ID;
	const rootId = options.rootId ?? FAKE_ROOT_ID;
	let clock = 1000;
	const now = options.now ?? (() => (clock += 1));
	const notes = new Map<string, StoredNote>();
	const folders: PluginFolder[] = [];
	const files = new Map<string, PluginFile>();
	const blobs = new Map<string, Uint8Array>();
	const writes: string[] = [];
	const listeners = new Set<(change: PluginVaultChange) => void>();
	let counter = 0;
	const nextId = (prefix: string): string => `${prefix}-${String((counter += 1))}`;

	const emit = (change: PluginVaultChange): void => {
		for (const listener of [...listeners]) listener(change);
	};
	const revisionOf = (note: StoredNote) => ({ localSeq: note.localSeq, bodySha256: sha256(new TextEncoder().encode(note.body)) });
	const toNote = (note: StoredNote): PluginNote => ({
		id: note.id,
		folderId: note.folderId,
		title: note.title,
		body: note.locked ? null : note.body,
		locked: note.locked,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
		favorite: false,
		trashedAt: note.trashedAt,
		archivedAt: note.archivedAt,
		revision: revisionOf(note),
	});
	const inSubtree = (folderId: string, ancestorId: string): boolean => {
		const seen = new Set<string>();
		let current: string | null = folderId;
		while (current !== null && !seen.has(current)) {
			if (current === ancestorId) return true;
			seen.add(current);
			current = folders.find((folder) => folder.id === current)?.parentId ?? null;
		}
		return false;
	};
	const inScope = (folderId: string, scope: PluginNotesScope | undefined): boolean => {
		if (!scope || scope.kind === 'all') return true;
		return scope.subfolders ? inSubtree(folderId, scope.folderId) : folderId === scope.folderId;
	};
	const page = <T>(items: T[], cursor: string | null, limit: number) => {
		const start = cursor === null ? 0 : Number(cursor);
		const slice = items.slice(start, start + limit);
		return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null };
	};
	const store = (body: string, folderId: string, id: string, locked = false, title = titleOf(body), updatedAt = now()): StoredNote => {
		const previous = notes.get(id);
		const note: StoredNote = {
			id,
			folderId,
			title,
			body,
			locked,
			createdAt: previous?.createdAt ?? updatedAt,
			updatedAt,
			trashedAt: null,
			archivedAt: null,
			localSeq: (previous?.localSeq ?? 0) + 1,
		};
		notes.set(id, note);
		return note;
	};
	const putBlob = (bytes: Uint8Array): string => {
		const hash = sha256(bytes);
		blobs.set(hash, new Uint8Array(bytes));
		return hash;
	};

	const library: FakeLibrary = {
		notes,
		folders,
		files,
		blobs,
		writes,
		addFolder(id, parentId, name) {
			const folder: PluginFolder = { id, parentId, name, createdAt: 1, updatedAt: 1 };
			folders.push(folder);
			return folder;
		},
		addNote(id, body, noteOptions = {}) {
			return store(body, noteOptions.folderId ?? rootId, id, noteOptions.locked ?? false, noteOptions.title ?? titleOf(body), noteOptions.updatedAt);
		},
		addFile(id, folderId, name, content, fileOptions = {}) {
			const bytes = new TextEncoder().encode(content);
			const updatedAt = fileOptions.updatedAt ?? now();
			const file: PluginFile = {
				id, folderId, name, sha256: putBlob(bytes), byteLength: bytes.length, mime: null,
				createdAt: updatedAt, updatedAt, trashedAt: null,
			};
			files.set(id, file);
			return file;
		},
		touchNote(id, body) {
			const current = notes.get(id);
			if (!current) throw new Error(`fake library: no note ${id}`);
			store(body, current.folderId, id, current.locked);
		},
		emit,
		sync(id) {
			emit({ kind: 'note-changed', id, change: 'synced' });
		},
		readText(fileId) {
			const file = files.get(fileId);
			const bytes = file ? blobs.get(file.sha256) : undefined;
			if (!bytes) throw new Error(`fake library: no file ${fileId}`);
			return new TextDecoder().decode(bytes);
		},
		listenerCount: () => listeners.size,

		libraryId: () => libraryId,
		rootFolderId: () => rootId,
		async notesPage(cursor, limit, scope) {
			const items = [...notes.values()]
				.filter((note) => note.trashedAt === null && note.archivedAt === null && inScope(note.folderId, scope))
				.map((note) => ({
					id: note.id, title: note.title, excerpt: '', createdAt: note.createdAt, updatedAt: note.updatedAt,
					favorite: false, locked: note.locked,
				}));
			return page(items, cursor, limit);
		},
		async noteRead(id) {
			const note = notes.get(id);
			return note ? toNote(note) : null;
		},
		async noteSummary(ids) {
			// What the real one answers: a row per note that exists (trashed and archived included).
			return ids.flatMap((id) => {
				const note = notes.get(id);
				return note ? [{
					id: note.id, title: note.title, excerpt: '', createdAt: note.createdAt, updatedAt: note.updatedAt,
					favorite: false, locked: note.locked, folderId: note.folderId, trashedAt: note.trashedAt, archivedAt: note.archivedAt,
					// Since API 1.1: the stored revision and the hash of the body, without reading it.
					revision: revisionOf(note), bodySha256: revisionOf(note).bodySha256,
				}] : [];
			});
		},
		async noteCreate({ folderId, body }) {
			const id = nextId('note');
			writes.push(`noteCreate:${id}`);
			const note = store(body, folderId ?? rootId, id);
			emit({ kind: 'note-changed', id, change: 'created' });
			return toNote(note);
		},
		async noteSave({ id, body, expected }) {
			const current = notes.get(id);
			if (!current) throw new Error(`fake library: no note ${id}`);
			writes.push(`noteSave:${id}`);
			const revision = revisionOf(current);
			if (revision.localSeq !== expected.localSeq || revision.bodySha256 !== expected.bodySha256) {
				const copy = store(body, current.folderId, nextId('conflict'));
				return { outcome: 'redirected', id: copy.id, revision: revisionOf(copy) };
			}
			const saved = store(body, current.folderId, id, false);
			emit({ kind: 'note-changed', id, change: 'saved' });
			return { outcome: 'saved', id, revision: revisionOf(saved) };
		},
		async notesRewriteBatch(entries) {
			const written: string[] = [];
			const stale: string[] = [];
			// What was written, with the revision it left: confirmed in the same write (a later API adds it).
			const committed: Array<{ id: string; body: string; revision: { localSeq: number; bodySha256: string } }> = [];
			for (const entry of entries) {
				writes.push(`notesRewriteBatch:${entry.id}`);
				const current = notes.get(entry.id);
				if (!current || current.locked) {
					stale.push(entry.id);
					continue;
				}
				const revision = revisionOf(current);
				if (revision.localSeq !== entry.expected.localSeq || revision.bodySha256 !== entry.expected.bodySha256) {
					stale.push(entry.id);
					continue;
				}
				const derived = titleOf(entry.body);
				const saved = store(entry.body, current.folderId, entry.id, false, derived === '' ? current.title : derived);
				written.push(entry.id);
				committed.push({ id: entry.id, body: saved.body, revision: revisionOf(saved) });
			}
			for (const id of written) emit({ kind: 'note-changed', id, change: 'saved' });
			return { written, stale, committed };
		},
		async noteMove(id, folderId) {
			const current = notes.get(id);
			if (!current) throw new Error(`fake library: no note ${id}`);
			current.folderId = folderId;
			emit({ kind: 'note-changed', id, change: 'moved' });
			return toNote(current);
		},
		async noteTrash(id) {
			const current = notes.get(id);
			if (!current) throw new Error(`fake library: no note ${id}`);
			writes.push(`noteTrash:${id}`);
			current.trashedAt = now();
			emit({ kind: 'note-changed', id, change: 'trashed' });
			return toNote(current);
		},
		async foldersList() {
			return folders.map((folder) => ({ ...folder }));
		},
		async folderCreate(parentId, name) {
			const folder = library.addFolder(nextId('folder'), parentId, name);
			writes.push(`folderCreate:${name}`);
			return { ...folder };
		},
		async folderRename() {
			throw new Error('fake library: folderRename is not used by Tyrian');
		},
		async folderMove() {
			throw new Error('fake library: folderMove is not used by Tyrian');
		},
		async filesPage(folderId, subfolders, cursor, limit = 200) {
			const items = [...files.values()].filter((file) => file.trashedAt === null
				&& (subfolders ? inSubtree(file.folderId, folderId) : file.folderId === folderId));
			return page(items.map((file) => ({ ...file })), cursor, limit);
		},
		async fileRead(ref) {
			const file = files.get(ref);
			return file ? { ...file } : null;
		},
		async fileCreate(folderId, name, hash) {
			const id = nextId('file');
			writes.push(`fileCreate:${name}`);
			const bytes = blobs.get(hash);
			if (!bytes) throw new Error('fake library: blob_missing');
			const updatedAt = now();
			const file: PluginFile = {
				id, folderId: folderId ?? rootId, name, sha256: hash, byteLength: bytes.length, mime: null,
				createdAt: updatedAt, updatedAt, trashedAt: null,
			};
			files.set(id, file);
			emit({ kind: 'library-changed', ids: [id], reason: 'file-created' });
			return { ...file };
		},
		async fileReplace(id, hash, expectedSha256) {
			const file = files.get(id);
			if (!file) throw new Error('fake library: file_not_found');
			writes.push(`fileReplace:${id}`);
			if (expectedSha256 !== undefined && expectedSha256 !== null && file.sha256 !== expectedSha256) {
				throw Object.assign(new Error('file_stale'), { code: 'file_stale' });
			}
			file.sha256 = hash;
			file.byteLength = blobs.get(hash)?.length ?? 0;
			file.updatedAt = now();
			emit({ kind: 'library-changed', ids: [id], reason: 'file-replaced' });
			return { ...file };
		},
		async fileTrash(id) {
			const file = files.get(id);
			if (!file) throw new Error('fake library: file_not_found');
			writes.push(`fileTrash:${id}`);
			file.trashedAt = now();
			emit({ kind: 'library-changed', ids: [id], reason: 'file-trashed' });
			return { ...file };
		},
		async blobRead(hash) {
			const bytes = blobs.get(hash);
			return bytes ? new Uint8Array(bytes) : null;
		},
		async blobPut(bytes) {
			const hash = sha256(bytes);
			const alreadyPresent = blobs.has(hash);
			putBlob(bytes);
			return { sha256: hash, byteLength: bytes.length, alreadyPresent };
		},
		// `PluginVault` gained these after the API the adapter was written against (1.0.0). The
		// adapter calls none of them, so this fake models none: a call fails the test that makes it.
		noteMoveIfUnchanged: () => notModelled('noteMoveIfUnchanged'),
		noteTrashIfUnchanged: () => notModelled('noteTrashIfUnchanged'),
		noteRestore: () => notModelled('noteRestore'),
		noteRestoreIfUnchanged: () => notModelled('noteRestoreIfUnchanged'),
		folderMoveIfUnchanged: () => notModelled('folderMoveIfUnchanged'),
		folderRenameIfUnchanged: () => notModelled('folderRenameIfUnchanged'),
		folderTrashEmpty: () => notModelled('folderTrashEmpty'),
		onChange(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
	return library;
}

function notModelled(what: string): never {
	throw new Error(`fake library: «${what}» is not modelled; the adapter was never expected to call it.`);
}

/** Hebra's localStorage key prefix for module and plugin data. */
const KEY_PREFIX = 'hebra.library-v1.module.';
/** The IndexedDB names Hebra keeps for the databases Tyrian's compiled module already had. */
const LEGACY_INDEXED_DB_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	'tyrian-companion': { 'path-index': 'hebra-tyrian-path-index', 'local-files': 'hebra-tyrian-local-files' },
};

export function hebraSettingsKey(pluginId: string, libraryId: string): string {
	return `${KEY_PREFIX}${pluginId}.settings:${libraryId}`;
}

export function hebraDeviceKey(pluginId: string, libraryId: string, key: string): string {
	return `${KEY_PREFIX}${pluginId}.local:${libraryId}:${key}`;
}

function parseJson(raw: string | undefined): unknown {
	if (raw === undefined) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

/** The IndexedDB Hebra 2.0 serves the plugin (`api.storage.indexedDB` and its `IDBKeyRange`). */
export interface FakeHebraIndexedDb {
	readonly indexedDB: IDBFactory;
	readonly IDBKeyRange: typeof IDBKeyRange;
}

/**
 * `api.storage` with Hebra's key layout over `local`, a `Map` standing for the device storage (the same
 * keys in the 1.x `localStorage` and in the 2.0 mirror, which Hebra saves after the fact: `flush` resolves
 * at once here). `indexedDB` is the factory Hebra serves; by default a fresh `fake-indexeddb` engine of its
 * own, made the first time it is read, never the page's `indexedDB`.
 */
export function createHebraStorage(local: Map<string, string>, pluginId: string, libraryId: string, served?: FakeHebraIndexedDb): PluginStorage {
	const settingsKey = hebraSettingsKey(pluginId, libraryId);
	let idb = served ?? null;
	const engine = (): FakeHebraIndexedDb => (idb ??= { indexedDB: new FakeIdbFactory(), IDBKeyRange: FakeIdbKeyRange });
	return {
		get indexedDB() { return engine().indexedDB; },
		get IDBKeyRange() { return engine().IDBKeyRange; },
		settings: {
			load: async <T>() => parseJson(local.get(settingsKey)) as T | null,
			save: async (value: unknown) => {
				if (value === null || value === undefined) local.delete(settingsKey);
				else local.set(settingsKey, JSON.stringify(value));
			},
			onChange: () => () => undefined,
		},
		device: {
			get: <T>(key: string) => parseJson(local.get(hebraDeviceKey(pluginId, libraryId, key))) as T | null,
			set: (key: string, value: unknown) => {
				const storageKey = hebraDeviceKey(pluginId, libraryId, key);
				if (value === null || value === undefined) local.delete(storageKey);
				else local.set(storageKey, JSON.stringify(value));
			},
			remove: (key: string) => { local.delete(hebraDeviceKey(pluginId, libraryId, key)); },
			flush: async () => undefined,
		},
		indexedDbName: (name: string) => LEGACY_INDEXED_DB_NAMES[pluginId]?.[name] ?? `hebra-plugin-${pluginId}-${name}`,
	};
}

/** Tyrian's keychain account in the compiled module, which `api-key` aliases to. */
export const TYRIAN_KEYCHAIN_ACCOUNT = 'tyrian-api-key-v1';

/** `api.secrets` over `accounts` (keychain account → value) with Hebra's alias for Tyrian. */
export function createFakeSecrets(accounts: Map<string, string>, pluginId = 'tyrian-companion'): PluginSecrets {
	const account = (key: string): string => (pluginId === 'tyrian-companion' && key === 'api-key'
		? TYRIAN_KEYCHAIN_ACCOUNT
		: `plugin:${pluginId}:${key}`);
	return {
		get: async (key) => accounts.get(account(key)) ?? null,
		set: async (key, value) => { accounts.set(account(key), value); },
		clear: async (key) => { accounts.delete(account(key)); },
	};
}

export interface TyrianTestApiOptions {
	platform?: PluginPlatform;
	capabilities?: readonly PluginCapability[];
	library?: FakeLibrary;
	/** `localStorage` of the device (Hebra's keys). */
	local?: Map<string, string>;
	/** Keychain accounts; `null` = this Hebra has no `secrets` (as Hebra 1.0.0). */
	keychain?: Map<string, string> | null;
	http?: (request: PluginHttpRequest) => Promise<PluginHttpResponse>;
	confirmUserHost?: (host: string) => boolean | Promise<boolean>;
	appleMobile?: boolean;
	version?: string;
	/**
	 * True: a Hebra with the main view (plugin API 1.3.0), which is what the package's fake is.
	 * Default false: a Hebra before it (`asHebraWithoutMainView`), where the plugin has its three
	 * views of always. Every test that is not about the main view runs there, so that path keeps
	 * being tested against the API it has to keep working on.
	 */
	mainView?: boolean;
	/**
	 * False: a Hebra without remote images in a line of a note (`markdown.image.remote`, plugin API
	 * 1.4.0), whose `has` answers false to that name. Default: what the package's fake answers (true).
	 */
	remoteImages?: boolean;
	/**
	 * False: a Hebra before 1.5.0, whose `has` answers false to `notify.urgency` (and to
	 * `instance.lock`) and ignores `urgency` and `silent`. Default: what the package's fake answers (true).
	 */
	notifyUrgency?: boolean;
	/** The IndexedDB Hebra serves (`api.storage.indexedDB`); by default a fresh fake engine of its own. */
	indexedDb?: FakeHebraIndexedDb;
	/**
	 * What Hebra does with `api.clipboard.writeText` (2.0): by default it takes the text, as after a click.
	 * A test of a write without a gesture rejects with `userActivationRequired()`.
	 */
	clipboard?: PluginClipboard['writeText'];
	/** What `api.notify.sound.play` answers (2.0), when `notify.sound` is declared: by default `played`. */
	soundOutcome?: PluginSoundOutcome;
}

/**
 * An error of the 2.0 API as the plugin receives it: `name`, `code` and `message`, what
 * `isPluginApiError` recognizes. (Over the real port it is a plain object, which the adapter must not
 * tell apart from this: it only reads those three fields.)
 */
export function pluginApiError(code: PluginApiErrorCode, message: string): Error & { name: 'PluginApiError'; code: PluginApiErrorCode } {
	return Object.assign(new Error(message), { name: 'PluginApiError' as const, code });
}

/** The error Hebra 2.0 rejects `clipboard.writeText` with when it sees no user gesture. */
export function userActivationRequired(): Error & { name: 'PluginApiError'; code: PluginApiErrorCode } {
	return pluginApiError('user-activation-required', 'Escribir en el portapapeles necesita un gesto del usuario.');
}

/**
 * `api` as a Hebra before the main view gives it (plugin API 1.2.0): that `apiVersion`, `has` answers
 * false to `'ui.view.main'`, as it does to any name it does not know, and `ui.updateView` and
 * `ui.updateViewSection` do not exist. Such a Hebra takes a `placement: 'main'` view without a word
 * and shows it nowhere, and ignores what follows the id in `revealView`; here both THROW, because
 * the plugin must never send either without the feature and a silent test would not say so.
 */
export function asHebraWithoutMainView(api: HebraPluginApi): HebraPluginApi {
	const ui = { ...api.ui };
	Reflect.deleteProperty(ui, 'updateView');
	Reflect.deleteProperty(ui, 'updateViewSection');
	ui.registerView = (view) => {
		if (view.placement === 'main') throw new Error(`A Hebra before 1.3.0 was sent the main view «${view.id}».`);
		return api.ui.registerView(view);
	};
	ui.revealView = (id: string, ...rest: unknown[]) => {
		if (rest.some((argument) => argument !== undefined)) throw new Error(`A Hebra before 1.3.0 was asked for a section of «${id}».`);
		api.ui.revealView(id);
	};
	return {
		...api,
		apiVersion: '1.2.0',
		has: (capability) => (capability as string) !== 'ui.view.main' && api.has(capability),
		ui,
	};
}

export interface TyrianTestApi {
	api: HebraPluginApi;
	/** The 1.x host under the 2.0 fake: what it recorded (views, commands, notices…) and its `ui`. */
	fake: FakePluginApi;
	/** The package's 2.0 fake itself (`createFakePluginApiV2`): environment, events, the port. */
	v2: FakePluginApiV2;
	/** Every text Hebra accepted through `api.clipboard.writeText`, in order. */
	clipboardWrites: string[];
	/** What reached `api.notify.sound`: the sounds registered and every `play`. */
	sounds: { registered: Map<string, { bytes: Uint8Array; mime: PluginSoundMime }>; plays: Array<{ id: string; volume?: number }> };
	library: FakeLibrary;
	local: Map<string, string>;
	openedNotes: string[];
	restarts: { count: number; result: boolean };
	/**
	 * What Hebra does when a plugin is unloaded: it undoes every registration the plugin made through
	 * `ui` and `editor`. The cleanup `activate` returns does not do it (Hebra does, `hebra-runtime.ts`),
	 * and since the fake of API 1.4.0 refuses a view, command, status item or code block whose id is
	 * still registered, a test that loads the plugin again on the same api calls this after the cleanup.
	 */
	unloadPlugin(): void;
}

/** The capabilities `hebra.json` declares for Tyrian. */
export const TYRIAN_CAPABILITIES: readonly PluginCapability[] = [
	'vault.read', 'vault.write', 'editor', 'http', 'secrets', 'tcp', 'notify.system', 'background', 'screen.awake', 'notify.sound',
];

/**
 * A whole 2.0 `HebraPluginApi` for `tyrian-companion`. Built on the package's 2.0 fake
 * (`createFakePluginApiV2`): `has`, `env`, `http`, `tcp`, `notify.system`, `background`, `markdown`,
 * `workspace` and `isError` are the plugin's side of the port, with Hebra's side served by the 1.x
 * fake under it, so their answers and errors arrive as they do in a frame (cloned, errors as plain
 * `PluginApiError` shapes). What the published fake does not serve yet is filled in here:
 *
 * - the surfaces (`ui` and `editor.registerCodeBlock`): the package's fake has no surface frames
 *   (they answer `capability-not-available`), so its 1.x host's `ui` mounts views, panels, modals and
 *   note blocks in the test's own page and records them, as JDex Manager's tests do;
 * - `clipboard` (records, or rejects as `options.clipboard` says) and `notify.sound` (records the
 *   registered sounds and every play; `has('notify.sound')` answers what `capabilities` declares);
 * - `storage` with Hebra's key layout and the IndexedDB Hebra serves (`createHebraStorage`), and the
 *   library, keychain and workspace doubles above.
 */
export function createTyrianTestApi(options: TyrianTestApiOptions = {}): TyrianTestApi {
	const capabilities = options.capabilities ?? TYRIAN_CAPABILITIES;
	const v2 = createFakePluginApiV2({
		id: 'tyrian-companion',
		version: options.version ?? '0.2.21',
		platform: options.platform ?? 'macos',
		capabilities,
		hosts: ['api.guildwars2.com', 'api.datawars2.ie'],
		userHosts: true,
		...(options.http === undefined ? {} : { http: options.http }),
		...(options.confirmUserHost === undefined ? {} : { confirmUserHost: options.confirmUserHost }),
		...(options.appleMobile === undefined ? {} : { appleMobile: options.appleMobile }),
	});
	const fake = v2.host;
	const library = options.library ?? createFakeLibrary();
	const local = options.local ?? new Map<string, string>();
	const keychain = options.keychain === undefined ? new Map<string, string>() : options.keychain;
	const openedNotes: string[] = [];
	const restarts = { count: 0, result: true };
	const secretsAvailable = keychain !== null && capabilities.includes('secrets');
	const soundAvailable = capabilities.includes('notify.sound');
	const clipboardWrites: string[] = [];
	const sounds: TyrianTestApi['sounds'] = { registered: new Map(), plays: [] };
	// The 1.x host's `ui` (the surfaces) has the 1.x ribbon, whose click is a `MouseEvent`; in the 2.0 Hebra
	// sends a `PluginPointerInfo`, and a test clicks a recorded ribbon with whichever it means to.
	const notSurface: HebraPluginApi = {
		...surfacedV2Api(v2),
		clipboard: {
			writeText: async (text) => {
				if (options.clipboard !== undefined) await options.clipboard(text);
				clipboardWrites.push(text);
			},
		},
		notify: {
			system: (input) => v2.api.notify.system(input),
			sound: {
				register: async (id, sound) => {
					if (!soundAvailable) throw pluginApiError('capability-not-declared', 'notify.sound');
					sounds.registered.set(id, { bytes: new Uint8Array(sound.bytes), mime: sound.mime });
				},
				play: async (id, playOptions) => {
					if (!soundAvailable) throw pluginApiError('capability-not-declared', 'notify.sound');
					if (!sounds.registered.has(id)) throw pluginApiError('invalid-argument', `no sound ${id}`);
					sounds.plays.push(playOptions?.volume === undefined ? { id } : { id, volume: playOptions.volume });
					return options.soundOutcome ?? 'played';
				},
				unregister: async (id) => { sounds.registered.delete(id); },
			},
		},
		isError: (error, code) => isPluginApiError(error, code),
	};
	const hebra = options.mainView === true ? notSurface : asHebraWithoutMainView(notSurface);
	// The undo functions of the registrations, which Hebra calls when it unloads the plugin.
	const registrations: Array<() => void> = [];
	const tracked = <T extends unknown[]>(register: (...args: T) => () => void) => (...args: T): (() => void) => {
		const undo = register(...args);
		registrations.push(undo);
		return undo;
	};
	// In place, not on copies: a test that spies on `fake.api.ui` must still see the calls.
	// The originals are bound to their object, since `tracked` calls them without `this`.
	hebra.ui.registerView = tracked(hebra.ui.registerView.bind(hebra.ui));
	hebra.ui.registerCommand = tracked(hebra.ui.registerCommand.bind(hebra.ui));
	const registerStatusBarItem = hebra.ui.registerStatusBarItem.bind(hebra.ui);
	hebra.ui.registerStatusBarItem = (item) => {
		const handle = registerStatusBarItem(item);
		registrations.push(() => { handle.remove(); });
		return handle;
	};
	hebra.editor.registerCodeBlock = tracked(hebra.editor.registerCodeBlock.bind(hebra.editor));
	const api: HebraPluginApi = {
		...hebra,
		has: (capability) => (capability === 'secrets' ? secretsAvailable
			: capability === 'notify.sound' ? soundAvailable
				: capability === 'markdown.image.remote' && options.remoteImages === false ? false
					: (capability === 'notify.urgency' || capability === 'instance.lock') && options.notifyUrgency === false ? false
						: hebra.has(capability)),
		vault: library,
		storage: createHebraStorage(local, 'tyrian-companion', library.libraryId(), options.indexedDb),
		secrets: keychain === null ? v2.api.secrets : createFakeSecrets(keychain),
		workspace: {
			...v2.api.workspace,
			openNote: (id) => { openedNotes.push(id); },
			restart: async () => {
				restarts.count += 1;
				return restarts.result;
			},
		},
	};
	const unloadPlugin = (): void => {
		for (const undo of registrations.splice(0).reverse()) undo();
	};
	return { api, fake, v2, clipboardWrites, sounds, library, local, openedNotes, restarts, unloadPlugin };
}
