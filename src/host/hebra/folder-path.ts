/**
 * "Ensure folders" (SPEC-TYRIAN-EN-HEBRA.md §3): turns the RELATIVE path segments `canonicalPathFor`
 * gives into the id of a real folder of the Hebra library, creating the missing ones one by one,
 * always under Tyrian's output folder (`rootFolderId`).
 *
 * Hebra folder names match case-insensitively here (the same rule Hebra applies to Bases): two
 * sibling folders that differ only in case count as one for Tyrian (a rare case, not resolved).
 */
import type { PluginFolder, PluginVault } from 'hebra-plugin-api';

export type TyrianFolderLibrary = Pick<PluginVault, 'foldersList' | 'folderCreate'>;

/** Folder segments of a Tyrian path (all but the last part, the file name). `''` gives `[]`. */
export function folderSegmentsOf(path: string): string[] {
	return path.split('/').filter((segment) => segment.length > 0).slice(0, -1);
}

/**
 * Creates (when missing) and returns the id of the Hebra folder for `segments` under
 * `rootFolderId`. A caller that makes many calls in a row (seeding) may pass the folders it
 * already listed, so they are not listed again for every note.
 */
export async function ensureFolderPath(
	library: TyrianFolderLibrary,
	rootFolderId: string,
	segments: readonly string[],
	preloadedFolders?: readonly PluginFolder[],
): Promise<string> {
	let folders = preloadedFolders ?? await library.foldersList();
	let parentId = rootFolderId;
	for (const segment of segments) {
		const existing = findChildByName(folders, parentId, segment);
		if (existing) {
			parentId = existing.id;
			continue;
		}
		const created = await library.folderCreate(parentId, segment);
		// Another writer may have created the same folder meanwhile: list again so the next
		// segment does not create a duplicate sibling.
		folders = await library.foldersList();
		parentId = findChildByName(folders, parentId, segment)?.id ?? created.id;
	}
	return parentId;
}

/**
 * The library folder for a Tyrian path counted from the library ROOT (`'Tyrian Companion'`,
 * `'Games/GW2'`), WITHOUT creating anything: null when a segment is missing. It is how HebraHost
 * finds the output folder on start: the start creates nothing (`createLibraryFolderPath` does, on a press).
 * First-level folders hang from `rootFolderId` or have no parent.
 */
export function resolveFolderPath(folders: readonly PluginFolder[], rootFolderId: string, path: string): string | null {
	const segments = path.split('/').filter((segment) => segment.trim().length > 0);
	if (segments.length === 0) return null;
	let parentId: string | null = null;
	for (const segment of segments) {
		const found = findSegment(folders, rootFolderId, parentId, segment);
		if (!found) return null;
		parentId = found.id;
	}
	return parentId;
}

/**
 * David, 10 Oct 2026 («si no existe, se crea»): the library folder for a path counted from the library
 * ROOT, as `resolveFolderPath` finds it, creating the segments that are missing (a first-level one with
 * `parentId` null, as the plugin API documents it). Only the explicit managed-assets writes of the
 * Settings row reach it (`vault.createOutputFolder`), with the output folder the user configured.
 * Rejects with what Hebra rejects (`invalid_name`, a name another writer took meanwhile…).
 */
export async function createLibraryFolderPath(library: TyrianFolderLibrary, rootFolderId: string, path: string): Promise<string> {
	const segments = path.split('/').filter((segment) => segment.trim().length > 0);
	if (segments.length === 0) throw new Error('tyrian folders: no folder to create for an empty path.');
	let folders = await library.foldersList();
	let parentId: string | null = null;
	for (const segment of segments) {
		const existing = findSegment(folders, rootFolderId, parentId, segment);
		if (existing) {
			parentId = existing.id;
			continue;
		}
		const created = await library.folderCreate(parentId, segment);
		// Another writer may have created the same folder meanwhile: list again, as `ensureFolderPath` does.
		folders = await library.foldersList();
		parentId = findSegment(folders, rootFolderId, parentId, segment)?.id ?? created.id;
	}
	return parentId as string;
}

/** A folder named `name` under `parentId`; null is the library root, whose children may hang from `rootFolderId` or from nothing. */
function findSegment(folders: readonly PluginFolder[], rootFolderId: string, parentId: string | null, name: string): PluginFolder | undefined {
	if (parentId !== null) return findChildByName(folders, parentId, name);
	return findChildByName(folders, rootFolderId, name)
		?? folders.find((folder) => folder.parentId === null && folder.id !== rootFolderId
			&& folder.name.trim().toLowerCase() === name.trim().toLowerCase());
}

function findChildByName(folders: readonly PluginFolder[], parentId: string, name: string): PluginFolder | undefined {
	const wanted = name.trim().toLowerCase();
	return folders.find((folder) => folder.parentId === parentId && folder.name.trim().toLowerCase() === wanted);
}

/**
 * The path RELATIVE to `rootFolderId` of every folder under it (id → `'Inventory'`,
 * `'Inventory/Positions'`…). The root itself is not listed (it is `''`). Seeding uses it so
 * `vault.file(folder)` answers from the first start, before the core "creates" it.
 */
export function folderRelativePaths(folders: readonly PluginFolder[], rootFolderId: string): Map<string, string> {
	const byId = new Map(folders.map((folder) => [folder.id, folder] as const));
	const paths = new Map<string, string>();
	const resolve = (folder: PluginFolder, seen: Set<string>): string | null => {
		const known = paths.get(folder.id);
		if (known !== undefined) return known;
		if (folder.parentId === null || seen.has(folder.id)) return null;
		seen.add(folder.id);
		let parentPath: string | null;
		if (folder.parentId === rootFolderId) parentPath = '';
		else {
			const parent = byId.get(folder.parentId);
			parentPath = parent ? resolve(parent, seen) : null;
		}
		if (parentPath === null) return null;
		const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
		paths.set(folder.id, path);
		return path;
	};
	for (const folder of folders) {
		if (folder.id !== rootFolderId && folder.name.length > 0) resolve(folder, new Set());
	}
	return paths;
}

/** Path of every library folder from the root: the options of `pickFolder`. */
export function libraryFolderPaths(folders: readonly PluginFolder[], rootFolderId: string): string[] {
	const byId = new Map(folders.map((folder) => [folder.id, folder] as const));
	const pathOf = (folder: PluginFolder, seen = new Set<string>()): string => {
		if (seen.has(folder.id)) return folder.name;
		seen.add(folder.id);
		const parent = folder.parentId === null ? undefined : byId.get(folder.parentId);
		if (!parent || parent.id === rootFolderId) return folder.name;
		return `${pathOf(parent, seen)}/${folder.name}`;
	};
	return folders
		.filter((folder) => folder.id !== rootFolderId && folder.name.length > 0)
		.map((folder) => pathOf(folder))
		.sort((a, b) => a.localeCompare(b, 'es'));
}
