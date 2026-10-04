/**
 * Seeding of Tyrian's path→id index (SPEC-TYRIAN-EN-HEBRA.md §3): walks what already lives under
 * Tyrian's output folder (`rootFolderId`, a folder of the Hebra library) and indexes it with paths
 * RELATIVE to it. It adopts what exists (the 1,364 notes of the 28 Sep decision) without
 * duplicating or overwriting anything.
 *
 * What enters the index:
 * - FOLDERS under the root (`vault.file(folder)` is not null), so the core never "creates" one
 *   that is already there;
 * - FILES that are not notes (`.base`, `.json`, `.csv`) by name: asked to create one that exists,
 *   `create` refuses instead of leaving two with the same name;
 * - NOTES with a marker, on the path `canonicalPathFor` gives, trying its candidates IN ORDER
 *   (a session gives two, preferred and collision, the same rule as its writer). The first free
 *   one, or one already assigned to this SAME note, is adopted.
 *
 * What stays out, in the VISIBLE unadopted list (saved with the index, shown in the plugin's
 * settings by `unadopted-panel.ts`), without touching the note:
 * - `path_taken`: every candidate already belongs to ANOTHER note (a duplicate);
 * - `invalid_marker`: it looks like Tyrian's (`tc_kind` or marker comment) but gives no path.
 *
 * A note with nothing of Tyrian is the user's and is ignored (`noMarker`), and so is a protected
 * note: Hebra never hands its text to a plugin (`locked`, SPEC-PLUGINS-EXTERNOS.md §5.2), so the
 * core could not read it anyway. Seeding again is idempotent.
 */
import type { PluginVault } from 'hebra-plugin-api';

import type { CanonicalPathFor } from '../tyrian-host';
import { folderRelativePaths } from './folder-path';
import type { TyrianNoteFamily, TyrianPathIndex, TyrianUnadoptedNote } from './path-index';

export type { TyrianNoteFamily, TyrianUnadoptedNote, TyrianUnadoptedReason } from './path-index';

/** What seeding reads of the library. */
export type TyrianSeedLibrary = Pick<PluginVault, 'notesPage' | 'noteRead' | 'foldersList' | 'filesPage'>;

export interface TyrianSeedResult {
	/** Notes indexed at the end (already indexed or adopted now). */
	readonly adopted: number;
	/** Notes indexed by THIS call (excludes those already indexed). */
	readonly newlyAdopted: number;
	/** Nothing of Tyrian (or protected): the user's, ignored. */
	readonly noMarker: number;
	/** Folders under the root left indexed. */
	readonly folders: number;
	/** Non-note files under the root left indexed. */
	readonly files: number;
	/** Tyrian notes NOT indexed, with their reason. */
	readonly unadopted: readonly TyrianUnadoptedNote[];
}

const SEED_PAGE_SIZE = 200;

export async function seedTyrianPathIndex(options: {
	library: TyrianSeedLibrary;
	index: TyrianPathIndex;
	rootFolderId: string;
	root: string;
	canonicalPathFor: CanonicalPathFor;
	/**
	 * Reconcile an index ALREADY saved with today's library (returning to an output folder used
	 * before, or any start with an index): notes with an entry are not read again (only their
	 * `mtime` is refreshed), new ones are adopted, and what the index has and the library no
	 * longer has (deleted, trashed, archived, moved out) is purged. Without it, after another
	 * device edited the folder the core created duplicates and wrote to dead ids.
	 */
	reconcile?: boolean;
}): Promise<TyrianSeedResult> {
	const { library, index, rootFolderId, root, canonicalPathFor } = options;
	const reconcile = options.reconcile === true;
	return await index.batch(async () => {
		const liveIds = new Set<string>();
		const updatedAt = new Map<string, number>();
		const folderPaths = folderRelativePaths(await library.foldersList(), rootFolderId);
		let folders = 0;
		for (const path of [...folderPaths.values()].sort()) {
			await index.setFolder(path);
			folders += 1;
		}

		let adopted = 0;
		let newlyAdopted = 0;
		let noMarker = 0;
		const unadopted: TyrianUnadoptedNote[] = [];
		let cursor: string | null = null;
		do {
			const page = await library.notesPage(cursor, SEED_PAGE_SIZE, { kind: 'folder', folderId: rootFolderId, subfolders: true });
			for (const item of page.items) {
				liveIds.add(item.id);
				updatedAt.set(item.id, item.updatedAt);
				if (reconcile && index.getKindForId(item.id) === 'note') {
					adopted += 1; // already indexed: its body is not read again.
					continue;
				}
				if (item.locked) {
					noMarker += 1;
					continue;
				}
				const note = await library.noteRead(item.id);
				if (!note) {
					liveIds.delete(item.id);
					continue; // purged meanwhile: nothing to seed.
				}
				if (note.locked || note.body === null) {
					noMarker += 1;
					continue;
				}
				const candidates = canonicalPathFor(root, note.body);
				if (candidates.length === 0) {
					const family = tyrianFamilyOf(note.body);
					if (family === null) noMarker += 1;
					else unadopted.push({ id: note.id, title: note.title, family, reason: 'invalid_marker', candidates: [] });
					continue;
				}
				const decision = decideAdoption(index, note.id, candidates);
				if (decision.outcome === 'ambiguous') {
					unadopted.push({
						id: note.id,
						title: note.title,
						family: tyrianFamilyOf(note.body) ?? 'other',
						reason: 'path_taken',
						candidates,
					});
					continue;
				}
				if (decision.outcome === 'new') {
					await index.setNote(decision.path, note.id, note.updatedAt);
					newlyAdopted += 1;
				}
				adopted += 1;
			}
			cursor = page.nextCursor;
		} while (cursor !== null);

		let files = 0;
		cursor = null;
		do {
			const page = await library.filesPage(rootFolderId, true, cursor, SEED_PAGE_SIZE);
			for (const file of page.items) {
				const folderPath = file.folderId === rootFolderId ? '' : folderPaths.get(file.folderId);
				if (folderPath === undefined) continue; // outside the effective subtree.
				const path = folderPath ? `${folderPath}/${file.name}` : file.name;
				liveIds.add(file.id);
				if (index.getIdForPath(path) === file.id) {
					// Already indexed: only today's `mtime` (an index saved before did not carry it).
					index.touchMtime(path, file.updatedAt);
					files += 1;
					continue;
				}
				// A taken path (two files with the same name in a folder, or a note): the first
				// one stays and the other is not indexed. Never overwritten.
				if (index.has(path)) continue;
				await index.setFile(path, file.id, file.updatedAt);
				files += 1;
			}
			cursor = page.nextCursor;
		} while (cursor !== null);

		if (reconcile) {
			await index.retainOnly(liveIds, new Set(folderPaths.values()));
			index.refreshMtimes(updatedAt);
		}
		await index.setUnadopted(unadopted);
		return { adopted, newlyAdopted, noMarker, folders, files, unadopted };
	});
}

/**
 * Looks again at the saved unadopted list on a start without seeding: drops the ones no longer
 * alive (trash, archive or purged: David already resolved the duplicate) or already indexed. It
 * adopts nothing new: that is seeding.
 */
export async function refreshUnadoptedNotes(
	library: Pick<PluginVault, 'noteRead'>,
	index: TyrianPathIndex,
): Promise<readonly TyrianUnadoptedNote[]> {
	const current = index.unadopted();
	if (current.length === 0) return current;
	const alive: TyrianUnadoptedNote[] = [];
	for (const entry of current) {
		if (index.getPathForId(entry.id) !== undefined) continue;
		const note = await library.noteRead(entry.id);
		if (!note || note.trashedAt !== null || note.archivedAt !== null) continue;
		alive.push(note.title === entry.title ? entry : { ...entry, title: note.title });
	}
	const changed = alive.length !== current.length || alive.some((entry, i) => entry !== current[i]);
	if (changed) await index.setUnadopted(alive);
	return index.unadopted();
}

/** Each Tyrian family's mark in the text (frontmatter `tc_kind` or its writer's marker comment). */
const TC_KIND_FAMILIES: Readonly<Record<string, TyrianNoteFamily>> = {
	gw2_inventory_position: 'inventory',
	gw2_wallet_currency: 'wallet',
	gw2_farming_session: 'session',
	gw2_collector_status: 'collector_status',
};
const TC_KIND_LINE = /^tc_kind:[ \t]*["']?([A-Za-z0-9_]+)/mu;
const MARKER_COMMENT = /<!-- tyrian-companion-(inventory|wallet)\b/u;

/**
 * The Tyrian family the text CLAIMS, or null when it carries nothing of Tyrian. It does not
 * validate: it only classifies what `canonicalPathFor` refused or left without a path. A loose
 * `tyrian-price-history` block (the user's notes) does not count.
 */
export function tyrianFamilyOf(text: string): TyrianNoteFamily | null {
	const kind = TC_KIND_LINE.exec(text)?.[1];
	if (kind !== undefined) return TC_KIND_FAMILIES[kind] ?? 'other';
	const marker = MARKER_COMMENT.exec(text)?.[1];
	if (marker === 'inventory') return 'inventory';
	if (marker === 'wallet') return 'wallet';
	return null;
}

export type AdoptionDecision = { outcome: 'already' } | { outcome: 'new'; path: string } | { outcome: 'ambiguous' };

/** One candidate per note, in `canonicalPathFor`'s order: the first free one (or already this
 *  note's) wins; none free leaves the note unadopted. Decides only: the caller writes. */
export function decideAdoption(index: TyrianPathIndex, noteId: string, candidates: readonly string[]): AdoptionDecision {
	const currentPath = index.getPathForId(noteId);
	if (currentPath !== undefined && candidates.includes(currentPath)) return { outcome: 'already' };
	for (const candidate of candidates) {
		if (index.isFolder(candidate)) continue; // a folder is not a free path.
		const owner = index.getIdForPath(candidate);
		if (owner === undefined) return { outcome: 'new', path: candidate };
		if (owner === noteId) return { outcome: 'already' };
	}
	return { outcome: 'ambiguous' };
}
