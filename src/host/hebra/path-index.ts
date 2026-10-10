/**
 * Tyrian's path→id index, preloaded in memory and persisted in `TyrianPathIndexKv`
 * (SPEC-TYRIAN-EN-HEBRA.md §3, R3).
 *
 * `TyrianVault.file()`/`markdownFiles()` are SYNCHRONOUS in the core's contract: with a few
 * thousand entries at most (1,364 imported notes in David's library) the whole index fits in
 * memory, so no call goes to the library.
 *
 * It holds FOLDERS too (`vault.exists(path)` is true for folders, session-history.ts) and files
 * that are not notes (`.base`, `.json`, `.csv`: `vault.create` writes them as library files).
 */
import type { TyrianVaultFile } from '../tyrian-host';
import type { TyrianPathIndexKv } from './path-index-kv';

export type TyrianIndexEntryKind = 'note' | 'file' | 'folder';

interface TyrianIndexEntry {
	readonly path: string;
	readonly kind: TyrianIndexEntryKind;
	/** Note or file id; absent for a folder. */
	readonly id?: string;
	/**
	 * `updatedAt` of the note or file (mtime = updatedAt, §2); undefined for a folder. The core
	 * tells files from folders by it (`TyrianVaultFile`), so a file (`.base`, manifest) MUST carry
	 * it. An index saved before did not store it for files: seeding with `reconcile` adds it.
	 */
	readonly mtime?: number;
}

/** The Tyrian family a note claims (by its `tc_kind` or its marker comment). */
export type TyrianNoteFamily = 'inventory' | 'wallet' | 'session' | 'collector_status' | 'other';

/**
 * Why a Tyrian note was left OUT of the index (§3: never duplicated, never overwritten):
 * - `path_taken`: every candidate path already belongs to ANOTHER note (a duplicate);
 * - `invalid_marker`: it carries Tyrian's marker or `tc_kind` but `canonicalPathFor` gives it no
 *   path (a broken marker, or one from another version). The core cannot see it and would create
 *   another note on its path, so David has to see it.
 */
export type TyrianUnadoptedReason = 'path_taken' | 'invalid_marker';

export interface TyrianUnadoptedNote {
	readonly id: string;
	/** The note title when it was seeded (only to show it). */
	readonly title: string;
	readonly family: TyrianNoteFamily;
	readonly reason: TyrianUnadoptedReason;
	/** Relative paths it asked for (empty with `invalid_marker`). */
	readonly candidates: readonly string[];
}

/** Serialized shape in `TyrianPathIndexKv` (one row per namespace). */
interface TyrianPathIndexSnapshot {
	readonly version: 1;
	readonly entries: readonly TyrianIndexEntry[];
	/** Optional: an index saved before the unadopted list does not carry it. */
	readonly unadopted?: readonly TyrianUnadoptedNote[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndexEntry(value: unknown): value is TyrianIndexEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.path === 'string' &&
		(value.kind === 'note' || value.kind === 'file' || value.kind === 'folder') &&
		(value.id === undefined || typeof value.id === 'string') &&
		(value.mtime === undefined || (typeof value.mtime === 'number' && Number.isFinite(value.mtime)))
	);
}

function isUnadoptedNote(value: unknown): value is TyrianUnadoptedNote {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === 'string' &&
		typeof value.title === 'string' &&
		typeof value.family === 'string' &&
		(value.reason === 'path_taken' || value.reason === 'invalid_marker') &&
		Array.isArray(value.candidates) &&
		value.candidates.every((candidate) => typeof candidate === 'string')
	);
}

/** The saved text is only trusted whole: one malformed entry discards the cache, which is rebuilt. */
function isSnapshot(value: unknown): value is TyrianPathIndexSnapshot {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return false;
	if (!value.entries.every(isIndexEntry)) return false;
	return value.unadopted === undefined || (Array.isArray(value.unadopted) && value.unadopted.every(isUnadoptedNote));
}

function kvKey(namespace: string): string {
	return `tyrian-path-index:${namespace}`;
}

/**
 * Preloaded in memory; each mutation persists the whole index (one write per change, outside
 * `batch`). `namespace` keeps two libraries, or two output folders, of the same device apart.
 *
 * The saves run in the background, one at a time, and nobody waits for them (decided 10 Oct 2026,
 * HP-13): a mutation returns as soon as memory holds it. The copy on disk is only a cache that the
 * next start reconciles from the notes' markers (`seedTyrianPathIndex`), so one that lags costs
 * nothing, while waiting on a storage engine that does not answer cost ten seconds per save, the
 * start's included and every note the core created. A change made while a save is in flight is
 * saved after it, and only the newest text: the ones in between are never written.
 */
export class TyrianPathIndex {
	readonly #kv: TyrianPathIndexKv;
	readonly #namespace: string;
	/** path → entry. */
	readonly #byPath = new Map<string, TyrianIndexEntry>();
	/** note or file id → path (for `onChange` and deletion by id). */
	readonly #byId = new Map<string, string>();
	#unadopted: readonly TyrianUnadoptedNote[] = [];
	/**
	 * The text last read from, or written to, the kv under this namespace. `#persist` writes only
	 * when the index serializes to something else: a start that changes nothing (the usual one)
	 * would otherwise rewrite the whole index to say what it already says.
	 */
	#saved: string | undefined;
	/** The text being written now, until its write settles. */
	#writing: string | undefined;
	/** The newest text waiting for the write in flight to settle; it replaces any older one still waiting. */
	#queued: string | undefined;
	/** The background writer while it runs (`whenSaved`); null when nothing is in flight or waiting. */
	#drain: Promise<void> | null = null;
	/** After `stopSaving()`: no save starts any more. */
	#stopped = false;
	/** Inside `batch()`: mutations are saved ONCE at the end. */
	#batchDepth = 0;
	#batchDirty = false;

	/** Where a storage failure is reported: the index never lets it reach its callers. */
	readonly #onStorageError: ((error: unknown) => void) | undefined;

	private constructor(kv: TyrianPathIndexKv, namespace: string, onStorageError?: (error: unknown) => void) {
		this.#kv = kv;
		this.#namespace = namespace;
		this.#onStorageError = onStorageError;
	}

	/**
	 * The saved copy is only a per-device cache (SPEC-TYRIAN-EN-HEBRA.md §3): it is rebuilt from the
	 * library on the next start. So a kv that cannot be read starts the index empty and one that
	 * cannot be written is reported through `onStorageError` and then ignored; neither may fail the
	 * library operation that triggered it (a note created in the library but refused by the index
	 * would be created again by the next attempt).
	 */
	static async load(kv: TyrianPathIndexKv, namespace: string, onStorageError?: (error: unknown) => void): Promise<TyrianPathIndex> {
		const index = new TyrianPathIndex(kv, namespace, onStorageError);
		let raw: string | undefined;
		try {
			raw = await kv.get(kvKey(namespace));
		} catch (error) {
			index.#reportStorageError(error);
			return index;
		}
		if (!raw) return index;
		index.#saved = raw;
		let snapshot: unknown;
		try {
			snapshot = JSON.parse(raw);
		} catch {
			// A corrupt index (a half-written disk, an unknown future version) is rebuilt by
			// `seedTyrianPathIndex`; it never throws from here.
			return index;
		}
		// Valid JSON of the wrong shape is treated like an absent or other-version index: empty, so
		// the next seed rebuilds it and `#persist` saves it again.
		if (!isSnapshot(snapshot)) return index;
		for (const entry of snapshot.entries) {
			index.#byPath.set(entry.path, entry);
			if (entry.id) index.#byId.set(entry.id, entry.path);
		}
		if (snapshot.unadopted) index.#unadopted = snapshot.unadopted;
		return index;
	}

	/** Hands the index as it is now to the background writer; returns at once (see the class). */
	#persist(): void {
		if (this.#batchDepth > 0) {
			this.#batchDirty = true;
			return;
		}
		if (this.#stopped) return;
		const snapshot: TyrianPathIndexSnapshot = {
			version: 1,
			entries: [...this.#byPath.values()],
			unadopted: this.#unadopted,
		};
		const text = JSON.stringify(snapshot);
		// Compared with what the disk will say once the writer is done: the newest text waiting, else the one in flight,
		// else the one last read or written. After a write that failed `#saved` is unknown, so the next change writes again.
		if (text === (this.#queued ?? this.#writing ?? this.#saved)) return;
		this.#queued = text;
		if (this.#drain !== null) return;
		const drain = this.#writeQueued();
		// Kept only while a write is in flight: a kv that throws instead of rejecting finishes the writer before this line,
		// and a finished writer kept here would never be cleared (`whenSaved` would wait on it for ever).
		if (this.#writing !== undefined) this.#drain = drain;
	}

	/**
	 * The background writer: one write at a time, always the newest text, until nothing waits. It never rejects: a
	 * failed write goes to `onStorageError` and the writer goes on with what came meanwhile.
	 */
	async #writeQueued(): Promise<void> {
		while (this.#queued !== undefined && !this.#stopped) {
			const text = this.#queued;
			this.#queued = undefined;
			this.#writing = text;
			try {
				await this.#kv.set(kvKey(this.#namespace), text);
				this.#saved = text;
			} catch (error) {
				// A write that failed may still have reached the disk (a transaction past its deadline commits later), so what
				// the disk holds is no longer known: whatever comes next is written, even the text it held before.
				this.#saved = undefined;
				this.#reportStorageError(error);
			} finally {
				this.#writing = undefined;
			}
		}
		this.#drain = null;
	}

	/**
	 * Resolves once no save is in flight or waiting (at once when none is): for the tests, and for whoever wants the copy on
	 * disk current. It never rejects; whether the writes succeeded is what `onStorageError` was told. After `stopSaving()`
	 * it resolves without writing what was dropped. It waits as long as the `kv.set` in flight does: one that never answers
	 * keeps it waiting for ever, which production does not meet because its kv gives every call a deadline.
	 */
	async whenSaved(): Promise<void> {
		while (this.#drain !== null) await this.#drain;
	}

	/**
	 * The plugin is closing: no save starts from now on and the one waiting is dropped, so nothing opens the kv again after
	 * its owner closed it. The one in flight is not waited for. What is lost is reconciled by the next start.
	 */
	stopSaving(): void {
		this.#stopped = true;
		this.#queued = undefined;
	}

	#reportStorageError(error: unknown): void {
		try { this.#onStorageError?.(error); } catch { /* A reporter that throws must not undo the point of this. */ }
	}

	/**
	 * Groups many mutations into ONE kv write (seeding: without it every adopted note saved the
	 * whole index again, 1,364 times with David's library). If `run` throws, what already changed
	 * in memory is still handed to the writer before the error propagates.
	 */
	async batch<T>(run: () => Promise<T>): Promise<T> {
		this.#batchDepth += 1;
		try {
			return await run();
		} finally {
			this.#batchDepth -= 1;
			if (this.#batchDepth === 0 && this.#batchDirty) {
				this.#batchDirty = false;
				this.#persist();
			}
		}
	}

	/** The Tyrian notes left out of the index, with their reason. */
	unadopted(): readonly TyrianUnadoptedNote[] {
		return this.#unadopted;
	}

	async setUnadopted(notes: readonly TyrianUnadoptedNote[]): Promise<void> {
		this.#unadopted = [...notes];
		this.#persist();
	}

	has(path: string): boolean {
		return this.#byPath.has(path);
	}

	isFolder(path: string): boolean {
		return this.#byPath.get(path)?.kind === 'folder';
	}

	getIdForPath(path: string): string | undefined {
		const entry = this.#byPath.get(path);
		return entry?.kind === 'folder' ? undefined : entry?.id;
	}

	getPathForId(id: string): string | undefined {
		return this.#byId.get(id);
	}

	getKindForId(id: string): TyrianIndexEntryKind | undefined {
		const path = this.#byId.get(id);
		return path === undefined ? undefined : this.#byPath.get(path)?.kind;
	}

	toVaultFile(path: string): TyrianVaultFile | null {
		const entry = this.#byPath.get(path);
		if (!entry) return null;
		return entry.mtime === undefined ? { path } : { path, mtime: entry.mtime };
	}

	async setNote(path: string, id: string, mtime: number): Promise<void> {
		this.#dropId(id);
		this.#byPath.set(path, { path, kind: 'note', id, mtime });
		this.#byId.set(id, path);
		this.#persist();
	}

	async setFile(path: string, id: string, mtime: number): Promise<void> {
		this.#dropId(id);
		this.#byPath.set(path, { path, kind: 'file', id, mtime });
		this.#byId.set(id, path);
		this.#persist();
	}

	async setFolder(path: string): Promise<void> {
		if (this.#byPath.get(path)?.kind === 'folder') return;
		this.#byPath.set(path, { path, kind: 'folder' });
		this.#persist();
	}

	/**
	 * After a `process` that did write: moves the cached `mtime` without touching the path. In
	 * MEMORY only: saving the whole index for every rewritten note cost, in the dump measured with
	 * David's library, 1,356 writes and 254 MB of JSON in IndexedDB. The saved `mtime` is only a
	 * hint: every start refreshes it from the library (`refreshMtimes`), which is the source.
	 */
	touchMtime(path: string, mtime: number): void {
		const entry = this.#byPath.get(path);
		if (!entry || entry.kind === 'folder') return;
		this.#byPath.set(path, { ...entry, mtime });
	}

	/** `touchMtime` by id for every indexed note listed (memory only). Returns how many changed. */
	refreshMtimes(updatedAtById: ReadonlyMap<string, number>): number {
		let changed = 0;
		for (const [id, mtime] of updatedAtById) {
			const path = this.#byId.get(id);
			const entry = path === undefined ? undefined : this.#byPath.get(path);
			if (!entry || entry.kind !== 'note' || entry.mtime === mtime) continue;
			this.#byPath.set(entry.path, { ...entry, mtime });
			changed += 1;
		}
		return changed;
	}

	/**
	 * Keeps ONLY what is alive: drops notes and files whose id is not in `liveIds` and folders whose
	 * path is not in `liveFolders`. The "purge" half of reconciling a saved index with today's
	 * library. Returns how many it dropped; saves once, and only when it dropped something.
	 */
	async retainOnly(liveIds: ReadonlySet<string>, liveFolders: ReadonlySet<string>): Promise<number> {
		let removed = 0;
		for (const entry of [...this.#byPath.values()]) {
			const alive = entry.kind === 'folder'
				? liveFolders.has(entry.path)
				: entry.id !== undefined && liveIds.has(entry.id);
			if (alive) continue;
			this.#byPath.delete(entry.path);
			if (entry.id) this.#byId.delete(entry.id);
			removed += 1;
		}
		if (removed > 0) this.#persist();
		return removed;
	}

	async deleteById(id: string): Promise<void> {
		const path = this.#byId.get(id);
		if (path === undefined) return;
		this.#byPath.delete(path);
		this.#byId.delete(id);
		this.#persist();
	}

	#dropId(id: string): void {
		const previousPath = this.#byId.get(id);
		if (previousPath !== undefined) this.#byPath.delete(previousPath);
	}

	/** Indexed notes (for `TyrianVault.markdownFiles()`), in a stable order. */
	listNoteFiles(): TyrianVaultFile[] {
		return this.#sortedFiles((entry) => entry.kind === 'note');
	}

	/** Everything indexed that is not a folder (for `TyrianVault.listFiles()`). */
	listAllFiles(): TyrianVaultFile[] {
		return this.#sortedFiles((entry) => entry.kind !== 'folder');
	}

	#sortedFiles(keep: (entry: TyrianIndexEntry) => boolean): TyrianVaultFile[] {
		return [...this.#byPath.values()]
			.filter(keep)
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			.map((entry) => (entry.mtime === undefined ? { path: entry.path } : { path: entry.path, mtime: entry.mtime }));
	}

	/** For tests and inspection: how many paths are indexed. */
	get size(): number {
		return this.#byPath.size;
	}
}
