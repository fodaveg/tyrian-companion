/**
 * The R3 part of HebraHost's `TyrianVault`, over `api.vault` (SPEC-TYRIAN-EN-HEBRA.md §3):
 * `file`/`markdownFiles`/`exists` SYNCHRONOUS from the preloaded index (`TyrianPathIndex`),
 * `read`, `create` (notes, and files that are not notes: `.json`/`.csv`/`.base`), `createFolder`
 * ("ensure folders"), an atomic `process`, `trashFile`, `trashIfUnchanged` and `onChange`.
 *
 * `process` is atomic for both kinds of entry and NEVER creates another one:
 * - a note, over `notesRewriteBatch` (never `noteSave`: a changed base has to be skipped and
 *   retried, not turned into a conflict copy);
 * - a file that is not a note (a `.base` or the managed-assets manifest), over `fileReplace` with
 *   `expectedSha256`: the new blob replaces the one read only while it is still that one; if not,
 *   `file_stale`, read again and retry. The file keeps id, name and folder.
 *
 * Hebra derives the note title from the body itself (SPEC-PLUGINS-EXTERNOS.md §5.2), and hands a
 * protected note over as `{ locked: true, body: null }`: such a note is never read, written or
 * indexed here (the compiled module dropped its wrapper with `isLockedBody`; the API never sends
 * the wrapper at all).
 *
 * OUTSIDE this file on purpose: `configDir`, `canonicalIdentity`, `basePath`, `fullPath`,
 * `adapter`, `listFiles` (`vault.ts` answers them) and every port that is not `vault`.
 */
import type { PluginNote, PluginVault, PluginVaultChange } from 'hebra-plugin-api';

import type { TyrianDisposer, TyrianVault, TyrianVaultChange, TyrianVaultFile, TyrianVaultTrashResult } from '../tyrian-host';
import { ensureFolderPath, folderRelativePaths, folderSegmentsOf } from './folder-path';
import type { TyrianPathIndex } from './path-index';
import { decideAdoption } from './seed';

/** What this port uses of `api.vault`, so a test can hand it a double. */
export type TyrianVaultLibrary = Pick<PluginVault,
	| 'foldersList'
	| 'folderCreate'
	| 'noteRead'
	| 'noteCreate'
	| 'notesRewriteBatch'
	| 'noteTrash'
	| 'blobPut'
	| 'blobRead'
	| 'fileCreate'
	| 'fileReplace'
	| 'fileTrash'
	| 'fileRead'
	| 'filesPage'
	| 'onChange'>;

const PROCESS_MAX_ATTEMPTS = 5;
/** Longest wait for a note read while reconciling a `synced`: past it, the event is reported and
 *  dropped, so a hung read cannot stall the queue. */
const READ_TIMEOUT_MS = 15_000;

export interface CreateTyrianVaultPortOptions {
	library: TyrianVaultLibrary;
	index: TyrianPathIndex;
	/** Hebra folder chosen as Tyrian's output. */
	rootFolderId: string;
	/**
	 * Candidate paths (relative to the output folder) the core gives for a note body, the same
	 * function seeding uses with its `root` applied. With it, a `synced` note the index does not
	 * know (created on another device) is indexed and delivered as `create`, and one whose path
	 * changed as `rename`. Without it, a `synced` only gives `modify` for what is indexed.
	 */
	canonicalPathFor?: (noteText: string) => readonly string[];
	/** A failure handling an event is reported here and that event dropped; the subscription lives on. */
	onError?: (error: unknown) => void;
}

/** The part of `TyrianVault` built here (see the file header). */
export type TyrianVaultPort = Pick<TyrianVault,
	| 'markdownFiles'
	| 'file'
	| 'exists'
	| 'read'
	| 'process'
	| 'createFolder'
	| 'create'
	| 'trashFile'
	| 'trashIfUnchanged'
	| 'onChange'>;

/** The port with its lifecycle. */
export type TyrianVaultPortHandle = TyrianVaultPort & {
	/** Tears the port down: see `dispose` below. */
	dispose(): void;
	/** Resolves once the event queue is empty with nothing in flight. */
	whenIdle(): Promise<void>;
};

/** A live note whose text the plugin may read: not trashed and not protected. */
function readableBody(note: PluginNote | null): string | null {
	if (!note || note.trashedAt !== null || note.locked || note.body === null) return null;
	return note.body;
}

export function createTyrianVaultPort(options: CreateTyrianVaultPortOptions): TyrianVaultPortHandle {
	const { library, index, rootFolderId, canonicalPathFor, onError } = options;

	async function read(target: TyrianVaultFile): Promise<string> {
		const kind = idKindFor(target.path);
		const id = index.getIdForPath(target.path);
		if (kind === 'note' && id !== undefined) {
			const body = readableBody(await library.noteRead(id));
			if (body === null) throw new Error(`tyrian vault: no note found for ${target.path}`);
			return body;
		}
		if (kind === 'file' && id !== undefined) return new TextDecoder().decode(await readFileBytes(library, id));
		throw new Error(`tyrian vault: path not indexed: ${target.path}`);
	}

	async function processEntry(target: TyrianVaultFile, update: (current: string) => string): Promise<string> {
		const id = index.getIdForPath(target.path);
		if (!id) throw new Error(`tyrian vault: process on a path not indexed: ${target.path}`);
		if (index.getKindForId(id) === 'file') return await processFile(id, target.path, update);
		let current = await library.noteRead(id);
		// `noteRead` also returns trashed notes: rewriting one silently would bring back a note
		// the user deleted.
		let body = readableBody(current);
		if (current === null || body === null) throw new Error(`tyrian vault: no note found for ${target.path}`);
		for (let attempt = 0; attempt < PROCESS_MAX_ATTEMPTS; attempt += 1) {
			const nextBody = update(body);
			if (nextBody === body) return body; // Unchanged: 0 writes.
			// mtime = updatedAt (§2): a core `process` ALWAYS moves the date.
			const result = await library.notesRewriteBatch(
				[{ id, body: nextBody, expected: current.revision }],
				{ cause: null, touchUpdatedAt: true },
			);
			if (result.written.includes(id)) {
				const after = await library.noteRead(id);
				if (after) index.touchMtime(target.path, after.updatedAt);
				return nextBody;
			}
			// `stale`: read again and retry with the update function, which has to be pure (it
			// may run several times, §3).
			current = await library.noteRead(id);
			body = readableBody(current);
			if (current === null || body === null) throw new Error(`tyrian vault: note deleted during process: ${target.path}`);
		}
		throw new Error(`tyrian vault: process did not converge after ${String(PROCESS_MAX_ATTEMPTS)} attempts (persistent conflict): ${target.path}`);
	}

	/**
	 * `process` on a file that is not a note: reads its blob, applies `update` and replaces the
	 * content with `fileReplace(id, next, expected)`, which writes only while the file still holds
	 * the blob read. Unchanged, 0 writes (not even a new blob). A trashed file is not rewritten.
	 */
	async function processFile(id: string, path: string, update: (current: string) => string): Promise<string> {
		for (let attempt = 0; attempt < PROCESS_MAX_ATTEMPTS; attempt += 1) {
			const row = await library.fileRead(id);
			if (!row || row.trashedAt !== null) throw new Error(`tyrian vault: no file found for ${path}`);
			const bytes = await library.blobRead(row.sha256);
			if (!bytes) throw new Error(`tyrian vault: missing blob for the file ${path}`);
			const current = new TextDecoder().decode(bytes);
			const next = update(current);
			if (next === current) return current;
			const blob = await library.blobPut(new TextEncoder().encode(next), { mime: row.mime });
			try {
				const replaced = await library.fileReplace(id, blob.sha256, row.sha256);
				index.touchMtime(path, replaced.updatedAt);
				return next;
			} catch (error) {
				// `file_stale`: someone changed it between the read and the write; read again.
				if (!isFileStale(error)) throw error;
			}
		}
		throw new Error(`tyrian vault: process did not converge after ${String(PROCESS_MAX_ATTEMPTS)} attempts (persistent conflict): ${path}`);
	}

	/**
	 * A file with this name that already lives in the folder and the index does not know (it came
	 * by sync or import after seeding): it is indexed and `create` refuses, as Obsidian does with a
	 * file that exists. Never two with the same name.
	 */
	async function adoptExistingFile(folderId: string, name: string, path: string): Promise<boolean> {
		let cursor: string | null = null;
		do {
			const page = await library.filesPage(folderId, false, cursor, 200);
			const found = page.items.find((item) => item.folderId === folderId && item.name.normalize('NFC') === name);
			if (found) {
				await index.setFile(path, found.id, found.updatedAt);
				return true;
			}
			cursor = page.nextCursor;
		} while (cursor !== null);
		return false;
	}

	async function createFolder(path: string): Promise<void> {
		await ensureFolderPath(library, rootFolderId, path.split('/').filter((segment) => segment.length > 0));
		await index.setFolder(path);
	}

	async function create(path: string, content: string): Promise<TyrianVaultFile> {
		if (index.has(path)) throw new Error(`tyrian vault: an entry already exists at ${path}`);
		const name = path.split('/').filter((part) => part.length > 0).at(-1) ?? path;
		const folderId = await ensureFolderPath(library, rootFolderId, folderSegmentsOf(path));
		if (name.toLowerCase().endsWith('.md')) {
			// Hebra derives the title from the body (SPEC-PLUGINS-EXTERNOS.md §5.2).
			const note = await library.noteCreate({ folderId, body: content });
			// While awaiting above, a `synced` may have adopted ANOTHER note on this path: check
			// again right before indexing, so it is never overwritten.
			if (index.has(path)) {
				await library.noteTrash(note.id).catch((error: unknown) => onError?.(error));
				throw new Error(`tyrian vault: an entry already exists at ${path}`);
			}
			await index.setNote(path, note.id, note.updatedAt);
			return { path, mtime: note.updatedAt };
		}
		// Not a note: `.json`/`.csv`/`.base` as a library file (R0 point 4).
		if (await adoptExistingFile(folderId, name.normalize('NFC'), path)) {
			throw new Error(`tyrian vault: a file already exists at ${path}`);
		}
		const blob = await library.blobPut(new TextEncoder().encode(content));
		const created = await library.fileCreate(folderId, name, blob.sha256);
		await index.setFile(path, created.id, created.updatedAt);
		return { path, mtime: created.updatedAt };
	}

	async function trashFile(target: TyrianVaultFile): Promise<void> {
		const kind = idKindFor(target.path);
		const id = index.getIdForPath(target.path);
		if (!id) throw new Error(`tyrian vault: trashFile on a path not indexed: ${target.path}`);
		if (kind === 'file') await library.fileTrash(id);
		else await library.noteTrash(id);
		await index.deleteById(id);
	}

	/**
	 * Conditional trash (Tyrian 0.2.14 contract, the same semantics as Obsidian's): reads the entry
	 * again, normalizes its line endings to LF and only when it equals `expectedContent` sends it to
	 * Hebra's TRASH (reversible, never a purge). A folder, a path not indexed, an entry already
	 * trashed, a protected note or different text: `conflict`, nothing touched. It is the `checked`
	 * guarantee, not `atomic`: the library offers no "trash if the sha did not change", so reading
	 * and trashing are two steps. A storage failure while reading propagates.
	 */
	async function trashIfUnchanged(target: TyrianVaultFile, expectedContent: string): Promise<TyrianVaultTrashResult> {
		const kind = idKindFor(target.path);
		const id = index.getIdForPath(target.path);
		if ((kind !== 'note' && kind !== 'file') || id === undefined) return { status: 'conflict' };
		let current: string;
		if (kind === 'note') {
			const body = readableBody(await library.noteRead(id));
			if (body === null) return { status: 'conflict' };
			current = body;
		} else {
			const row = await library.fileRead(id);
			if (!row || row.trashedAt !== null) return { status: 'conflict' };
			const bytes = await library.blobRead(row.sha256);
			if (!bytes) return { status: 'conflict' };
			current = new TextDecoder().decode(bytes);
		}
		if (current.replace(/\r\n?/gu, '\n') !== expectedContent) return { status: 'conflict' };
		if (kind === 'file') await library.fileTrash(id);
		else await library.noteTrash(id);
		await index.deleteById(id);
		return { status: 'trashed', guarantee: 'checked' };
	}

	/** State of one drain round: the folders are listed ONCE per round. */
	interface DrainRound {
		folderPaths: Map<string, string> | null;
	}

	/** A read with a deadline: a `noteRead` that never resolves cannot stall the queue. */
	async function readNote(id: string): Promise<PluginNote | null> {
		let timer: number | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error(`tyrian vault: reading ${id} took over ${String(READ_TIMEOUT_MS)} ms`)), READ_TIMEOUT_MS);
		});
		try {
			return await Promise.race([library.noteRead(id), timeout]);
		} finally {
			window.clearTimeout(timer);
		}
	}

	/**
	 * A note synced from another device: the event carries only the id, so the note is READ and its
	 * canonical path computed (the same function and adoption rule as seeding) to decide what change
	 * the core sees. Returns null when there is nothing to deliver. Keeps the index current; the
	 * caller serializes it and groups it in an `index.batch` (`drain`).
	 *
	 * Cost: one read (with a deadline) per synced id, and one folder listing per drain ROUND (not
	 * per note) when a note with Tyrian's marker was not indexed. The index is saved once per round.
	 */
	async function reconcileSynced(id: string, round: DrainRound): Promise<TyrianVaultChange | null> {
		const oldPath = index.getPathForId(id);
		const kind = index.getKindForId(id);
		// An indexed file (`.base`, manifest) is not read as a note: `modify` and done.
		if (oldPath !== undefined && kind === 'file') return { kind: 'modify', path: oldPath };
		const known = oldPath !== undefined && kind === 'note';
		if (!canonicalPathFor) {
			// Without the path function the new path cannot be known: only `modify` of what is indexed.
			return known ? { kind: 'modify', path: oldPath } : null;
		}
		const note = await readNote(id);
		if (disposed) return null;
		if (note?.locked) {
			// Protected: Hebra does not hand its text to plugins. Not indexed; if it was, it stays.
			return known ? { kind: 'modify', path: oldPath } : null;
		}
		const candidates = note && note.body !== null && note.trashedAt === null && note.archivedAt === null
			? canonicalPathFor(note.body)
			: [];
		if (!note || candidates.length === 0) {
			// Purged, trashed, archived, or no longer Tyrian's: it leaves the index.
			if (!known) return null;
			await index.deleteById(id);
			return { kind: 'delete', path: oldPath };
		}
		if (!known || note.folderId !== rootFolderId) {
			round.folderPaths ??= folderRelativePaths(await library.foldersList(), rootFolderId);
			if (disposed) return null;
			if (note.folderId !== rootFolderId && !round.folderPaths.has(note.folderId)) {
				// Outside the output folder: a note never indexed is not Tyrian's to adopt, and one that
				// was (moved out in Hebra) leaves the index.
				if (!known) return null;
				await index.deleteById(id);
				return { kind: 'delete', path: oldPath };
			}
		}
		const decision = decideAdoption(index, id, candidates);
		if (decision.outcome === 'ambiguous') {
			// Every path belongs to another note: never overwritten. What was indexed stays.
			return known ? { kind: 'modify', path: oldPath } : null;
		}
		if (decision.outcome === 'already') {
			const path = index.getPathForId(id) ?? oldPath;
			if (path === undefined) return null;
			index.touchMtime(path, note.updatedAt);
			return { kind: 'modify', path };
		}
		await index.setNote(decision.path, id, note.updatedAt);
		return known ? { kind: 'rename', path: decision.path, oldPath } : { kind: 'create', path: decision.path };
	}

	interface Subscriber {
		root: string;
		listener: (change: TyrianVaultChange) => void;
	}
	const subscribers = new Set<Subscriber>();
	let unsubscribeLibrary: (() => void) | null = null;
	let disposed = false;

	/** An event waiting its turn: a local one (`handle`) or a `synced` (which reads the note). */
	type QueuedEvent = { type: 'synced'; id: string } | { type: 'local'; id: string; change: string };
	/** One queue: a `synced` reads asynchronously and the library listener is synchronous. While
	 *  anything is queued or in flight every later event waits its turn, so two events of the same
	 *  note are never delivered out of order. */
	let events: QueuedEvent[] = [];
	/** Ids with a `synced` not handled yet: a burst of the same id is read once (its latest state). */
	const pendingSynced = new Set<string>();
	let draining = false;
	let idleWaiters: (() => void)[] = [];

	function report(error: unknown): void {
		try {
			onError?.(error);
		} catch {
			// An `onError` that throws cannot break the queue.
		}
	}

	function enqueue(event: QueuedEvent): void {
		if (event.type === 'synced') {
			if (pendingSynced.has(event.id)) return;
			pendingSynced.add(event.id);
		}
		events.push(event);
		if (!draining) {
			// One microtask of slack: events of the same synchronous burst merge into ONE round.
			draining = true;
			queueMicrotask(() => void drain());
		}
	}

	/** Handles the queue in rounds, each inside ONE `index.batch` (one index save), in order. */
	async function drain(): Promise<void> {
		try {
			while (events.length > 0 && !disposed) {
				const round: DrainRound = { folderPaths: null };
				const taken = events;
				events = [];
				pendingSynced.clear();
				try {
					await index.batch(async () => {
						for (const event of taken) {
							if (disposed) return;
							try {
								if (event.type === 'local') await handle(event.id, event.change);
								else {
									const change = await reconcileSynced(event.id, round);
									if (change && !disposed) deliver(change);
								}
							} catch (error) {
								report(error);
							}
						}
					});
				} catch (error) {
					report(error);
				}
			}
		} finally {
			draining = false;
			if (disposed) {
				events = [];
				pendingSynced.clear();
			}
			if (events.length === 0) {
				const waiters = idleWaiters;
				idleWaiters = [];
				for (const resolve of waiters) resolve();
			}
		}
	}

	function whenIdle(): Promise<void> {
		if (!draining && events.length === 0) return Promise.resolve();
		return new Promise((resolve) => idleWaiters.push(resolve));
	}

	/** Delivers to whoever watches a root holding the path; a `rename` that crosses a root is seen
	 *  as `create` or `delete` from the side that sees it. A listener that throws is reported and
	 *  does not stop the others. */
	function deliver(change: TyrianVaultChange): void {
		const call = (subscriber: Subscriber, value: TyrianVaultChange): void => {
			try {
				subscriber.listener(value);
			} catch (error) {
				report(error);
			}
		};
		for (const subscriber of [...subscribers]) {
			if (disposed) return;
			if (!subscribers.has(subscriber)) continue;
			const { root } = subscriber;
			const inNew = change.path.startsWith(root);
			if (change.kind !== 'rename') {
				if (inNew) call(subscriber, change);
				continue;
			}
			const inOld = change.oldPath !== undefined && change.oldPath.startsWith(root);
			if (inNew && inOld) call(subscriber, change);
			else if (inNew) call(subscriber, { kind: 'create', path: change.path });
			else if (inOld && change.oldPath !== undefined) call(subscriber, { kind: 'delete', path: change.oldPath });
		}
	}

	function handle(id: string, change: string): Promise<void> | void {
		const path = index.getPathForId(id);
		switch (change) {
			case 'created':
			case 'restored':
				if (path !== undefined) deliver({ kind: 'create', path });
				return;
			case 'saved':
				if (path !== undefined) deliver({ kind: 'modify', path });
				return;
			case 'trashed':
			case 'archived':
			case 'purged':
				if (path === undefined) return;
				deliver({ kind: 'delete', path });
				return index.deleteById(id);
			default:
				// favorite, hidden, unhidden, resolved: unused by the core. `moved` and `unarchived`
				// need a read (see `onLibraryChange`): the event says neither where the note is now nor
				// what it holds. Moving changes where the note hangs in Hebra, not its canonical path
				// (that comes from the BODY), so a move inside the output folder is only a `modify`.
				return;
		}
	}

	function onLibraryChange(event: PluginVaultChange): void {
		if (disposed || event.kind !== 'note-changed') return;
		const { id, change } = event;
		// `moved` (it may have left the output folder) and `unarchived` (it may be back) are read like a
		// `synced`; without the path function there is nothing to decide with, as before.
		const rereads = change === 'synced' || ((change === 'moved' || change === 'unarchived') && canonicalPathFor !== undefined);
		if (rereads) {
			if (!canonicalPathFor && !draining && events.length === 0) {
				// No path function, no read to wait for: `modify` of what is indexed, synchronous.
				void handle(id, 'saved');
				return;
			}
			enqueue({ type: 'synced', id });
			return;
		}
		if (draining || events.length > 0) {
			enqueue({ type: 'local', id, change });
			return;
		}
		try {
			const result = handle(id, change);
			if (result) result.catch(report);
		} catch (error) {
			report(error);
		}
	}

	function onChange(root: string, listener: (change: TyrianVaultChange) => void): TyrianDisposer {
		if (disposed) return () => undefined;
		const subscriber: Subscriber = { root, listener };
		subscribers.add(subscriber);
		// One library subscription for every listener: the index is updated ONCE per event, not once
		// per listener (the second would see the note indexed already).
		unsubscribeLibrary ??= library.onChange(onLibraryChange);
		return () => {
			subscribers.delete(subscriber);
			if (subscribers.size === 0) {
				unsubscribeLibrary?.();
				unsubscribeLibrary = null;
			}
		};
	}

	/** Tears the whole port down (the core drops the `onChange` disposer): cuts the library
	 *  subscription, empties what is pending, and makes a read in flight that ends later neither
	 *  write the index nor deliver anything. */
	function dispose(): void {
		disposed = true;
		subscribers.clear();
		unsubscribeLibrary?.();
		unsubscribeLibrary = null;
		events = [];
		pendingSynced.clear();
	}

	function idKindFor(path: string): 'note' | 'file' | 'folder' | undefined {
		if (index.isFolder(path)) return 'folder';
		const id = index.getIdForPath(path);
		if (!id) return undefined;
		return index.getKindForId(id) === 'file' ? 'file' : 'note';
	}

	return {
		markdownFiles: () => index.listNoteFiles(),
		file: (path) => index.toVaultFile(path),
		exists: (path) => index.has(path),
		read,
		// Named apart: a local `process` reads as Node's global to the webview boundary guard.
		process: processEntry,
		createFolder,
		create,
		trashFile,
		trashIfUnchanged,
		onChange,
		dispose,
		whenIdle,
	};
}

/** Is it `fileReplace`'s `file_stale`? It arrives as Hebra's library error (`code`), as text (a
 *  rejected Tauri `invoke`) or as an `Error` with that message (the web worker). */
function isFileStale(error: unknown): boolean {
	if (typeof error === 'string') return error === 'file_stale';
	if (typeof error !== 'object' || error === null) return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	return code === 'file_stale' || message === 'file_stale';
}

/** The index does not store a file's sha256 (it would duplicate state `files` already holds):
 *  `fileRead(id)` once per read, then the bytes. */
async function readFileBytes(library: Pick<PluginVault, 'fileRead' | 'blobRead'>, fileId: string): Promise<Uint8Array> {
	const row = await library.fileRead(fileId);
	if (!row) throw new Error(`tyrian vault: file not found: ${fileId}`);
	const bytes = await library.blobRead(row.sha256);
	if (!bytes) throw new Error(`tyrian vault: missing blob for the file ${fileId}`);
	return bytes;
}
