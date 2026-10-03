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

function kvKey(namespace: string): string {
	return `tyrian-path-index:${namespace}`;
}

/**
 * Preloaded in memory; each mutation persists the whole index (one write per change, outside
 * `batch`). `namespace` keeps two libraries, or two output folders, of the same device apart.
 */
export class TyrianPathIndex {
	readonly #kv: TyrianPathIndexKv;
	readonly #namespace: string;
	/** path → entry. */
	readonly #byPath = new Map<string, TyrianIndexEntry>();
	/** note or file id → path (for `onChange` and deletion by id). */
	readonly #byId = new Map<string, string>();
	#unadopted: readonly TyrianUnadoptedNote[] = [];
	/** Inside `batch()`: mutations are saved ONCE at the end. */
	#batchDepth = 0;
	#batchDirty = false;

	private constructor(kv: TyrianPathIndexKv, namespace: string) {
		this.#kv = kv;
		this.#namespace = namespace;
	}

	static async load(kv: TyrianPathIndexKv, namespace: string): Promise<TyrianPathIndex> {
		const index = new TyrianPathIndex(kv, namespace);
		const raw = await kv.get(kvKey(namespace));
		if (!raw) return index;
		let snapshot: TyrianPathIndexSnapshot;
		try {
			snapshot = JSON.parse(raw) as TyrianPathIndexSnapshot;
		} catch {
			// A corrupt index (a half-written disk, an unknown future version) is rebuilt by
			// `seedTyrianPathIndex`; it never throws from here.
			return index;
		}
		if (snapshot.version !== 1 || !Array.isArray(snapshot.entries)) return index;
		// `Array.isArray` narrows a readonly array to `any[]`: give the entries their type back.
		for (const entry of snapshot.entries as readonly TyrianIndexEntry[]) {
			index.#byPath.set(entry.path, entry);
			if (entry.id) index.#byId.set(entry.id, entry.path);
		}
		if (Array.isArray(snapshot.unadopted)) index.#unadopted = snapshot.unadopted;
		return index;
	}

	async #persist(): Promise<void> {
		if (this.#batchDepth > 0) {
			this.#batchDirty = true;
			return;
		}
		const snapshot: TyrianPathIndexSnapshot = {
			version: 1,
			entries: [...this.#byPath.values()],
			unadopted: this.#unadopted,
		};
		await this.#kv.set(kvKey(this.#namespace), JSON.stringify(snapshot));
	}

	/**
	 * Groups many mutations into ONE kv write (seeding: without it every adopted note saved the
	 * whole index again, 1,364 times with David's library). If `run` throws, what already changed
	 * in memory is still saved before the error propagates.
	 */
	async batch<T>(run: () => Promise<T>): Promise<T> {
		this.#batchDepth += 1;
		try {
			return await run();
		} finally {
			this.#batchDepth -= 1;
			if (this.#batchDepth === 0 && this.#batchDirty) {
				this.#batchDirty = false;
				await this.#persist();
			}
		}
	}

	/** The Tyrian notes left out of the index, with their reason. */
	unadopted(): readonly TyrianUnadoptedNote[] {
		return this.#unadopted;
	}

	async setUnadopted(notes: readonly TyrianUnadoptedNote[]): Promise<void> {
		this.#unadopted = [...notes];
		await this.#persist();
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
		await this.#persist();
	}

	async setFile(path: string, id: string, mtime: number): Promise<void> {
		this.#dropId(id);
		this.#byPath.set(path, { path, kind: 'file', id, mtime });
		this.#byId.set(id, path);
		await this.#persist();
	}

	async setFolder(path: string): Promise<void> {
		if (this.#byPath.get(path)?.kind === 'folder') return;
		this.#byPath.set(path, { path, kind: 'folder' });
		await this.#persist();
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
		if (removed > 0) await this.#persist();
		return removed;
	}

	async deleteById(id: string): Promise<void> {
		const path = this.#byId.get(id);
		if (path === undefined) return;
		this.#byPath.delete(path);
		this.#byId.delete(id);
		await this.#persist();
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
