/**
 * HebraHost's whole `TyrianVault` (SPEC-TYRIAN-EN-HEBRA.md §2-§3): the R3 port (`vault-port.ts`)
 * plus what it leaves out on purpose (`configDir`, `canonicalIdentity`, `basePath`, `fullPath`,
 * `adapter`, `listFiles`).
 *
 * Paths. The core speaks in VAULT paths (`Tyrian Companion/Inventory/Positions/1.md`), but the
 * index and `canonicalPathFor` keep them RELATIVE to the output folder (`Inventory/Positions/1.md`;
 * "HebraHost adds the prefix", §3). The prefix is removed and added here, both ways. A path outside
 * the output folder does not exist for Hebra: `file` is null, `exists` false and writing to it
 * refuses with an explicit reason (the core does not write outside: the support package and the
 * advisor receipt go through `adapter`).
 *
 * Without an output folder in the library (`port === null`: the saved one, or the default, does
 * not exist; it is picked in the plugin settings among the real ones and Hebra never creates it),
 * the vault is empty and every write refuses. Consultation mode does not write, so it goes unseen.
 */
import type { LocalDebugStoragePort } from '../../core/local-debug-writer';
import type { TyrianVault, TyrianVaultFile } from '../tyrian-host';
import type { TyrianPathIndex } from './path-index';
import type { TyrianVaultPort } from './vault-port';

/** Hebra's `configDir` for Tyrian: a VIRTUAL directory of the local storage (`adapter`), never of
 *  the library. The core forbids its output folder under it. */
export const HEBRA_TYRIAN_CONFIG_DIR = '.hebra';

export interface CreateHebraTyrianVaultOptions {
	/** The R3 port over the output folder; null when that folder does not exist. */
	port: TyrianVaultPort | null;
	index: TyrianPathIndex;
	/** Tyrian's output folder, counted from the library root. */
	outputFolder: string;
	libraryId: string;
	adapter: LocalDebugStoragePort;
	/** A (non-empty) reason while the vault must NOT write: the saved output folder is no longer
	 *  this one and the plugin is about to restart (`hebra-host.ts`). Every write refuses with it. */
	writeBlockedReason?: () => string | null;
	/** Called with each refused write before it is thrown: the host's diagnostics. */
	onReject?: (error: Error) => void;
}

export function createHebraTyrianVault(options: CreateHebraTyrianVaultOptions): TyrianVault {
	const { port, index, libraryId, adapter } = options;
	const root = options.outputFolder.replace(/^\/+|\/+$/gu, '');

	/** null: outside the output folder. `''`: the output folder itself. */
	const toRelative = (path: string): string | null => relativeToOutputFolder(root, path);
	/**
	 * A folder that CONTAINS the output folder (`Games` and `Games/GW2` for `Games/GW2/Tyrian`). It
	 * surely exists: the output folder was found through it (`port !== null`). The core's writers
	 * ensure their folder one segment at a time FROM THE VAULT ROOT (`file(segment)` and, when
	 * null, `createFolder(segment)`); without this, with a nested output folder like David's (three
	 * levels), every write ended in `storage_failure` (measured in R3).
	 */
	const isAncestorOfOutput = (path: string): string | null => {
		const clean = path.replace(/^\/+|\/+$/gu, '');
		return clean.length > 0 && root.startsWith(`${clean}/`) ? clean : null;
	};
	const toVaultPath = (relative: string): string => (relative ? `${root}/${relative}` : root);
	const toVaultFile = (file: TyrianVaultFile): TyrianVaultFile => ({ ...file, path: toVaultPath(file.path) });

	/** Reports the refusal to the host's diagnostics (only the path, no content) and throws it. */
	function reject(message: string): never {
		const error = new Error(message);
		options.onReject?.(error);
		throw error;
	}

	/** No write leaves while the saved output folder differs from the vault's. */
	function requireWritable(action: string, path: string): void {
		const reason = options.writeBlockedReason?.();
		if (reason) reject(`tyrian vault: ${action} on «${path}» refused: ${reason}`);
	}

	function requirePort(action: string, path: string): TyrianVaultPort {
		if (!port) reject(`tyrian vault: ${action} on «${path}» without an output folder: «${root}» is not in the library.`);
		return port;
	}

	function requireInside(action: string, path: string): string {
		const relative = toRelative(path);
		if (relative === null || relative === '') reject(`tyrian vault: ${action} outside the output folder «${root}»: ${path}`);
		return relative;
	}

	return {
		markdownFiles: () => (port ? port.markdownFiles().map(toVaultFile) : []),
		listFiles: () => (port ? index.listAllFiles().map(toVaultFile) : []),
		exists(path) {
			if (!port) return false;
			if (isAncestorOfOutput(path) !== null) return true;
			const relative = toRelative(path);
			if (relative === null) return false;
			return relative === '' || port.exists(relative);
		},
		file(path) {
			if (!port) return null;
			const ancestor = isAncestorOfOutput(path);
			if (ancestor !== null) return { path: ancestor };
			const relative = toRelative(path);
			if (relative === null) return null;
			if (relative === '') return { path: root };
			const found = port.file(relative);
			return found ? toVaultFile(found) : null;
		},
		async read(file) {
			const relative = requireInside('read', file.path);
			return await requirePort('read', file.path).read({ ...file, path: relative });
		},
		async process(file, update) {
			requireWritable('process', file.path);
			const relative = requireInside('process', file.path);
			return await requirePort('process', file.path).process({ ...file, path: relative }, update);
		},
		async createFolder(path) {
			requireWritable('createFolder', path);
			const relative = toRelative(path);
			if (relative === '' || isAncestorOfOutput(path) !== null) {
				requirePort('createFolder', path);
				return;
			}
			if (relative === null) reject(`tyrian vault: createFolder outside the output folder «${root}»: ${path}`);
			await requirePort('createFolder', path).createFolder(relative);
		},
		async create(path, content) {
			requireWritable('create', path);
			const relative = requireInside('create', path);
			return toVaultFile(await requirePort('create', path).create(relative, content));
		},
		async saveNote(path, content) {
			requireWritable('saveNote', path);
			const relative = requireInside('saveNote', path);
			await requirePort('saveNote', path).saveNote(relative, content);
		},
		async trashFile(file) {
			requireWritable('trashFile', file.path);
			const relative = requireInside('trashFile', file.path);
			await requirePort('trashFile', file.path).trashFile({ ...file, path: relative });
		},
		async trashIfUnchanged(file, expectedContent) {
			requireWritable('trashIfUnchanged', file.path);
			const relative = requireInside('trashIfUnchanged', file.path);
			return await requirePort('trashIfUnchanged', file.path).trashIfUnchanged({ ...file, path: relative }, expectedContent);
		},
		onChange(watched, listener) {
			// `''` (the whole vault) or a folder that CONTAINS the output one: Hebra only reports what
			// is inside the output folder, so it is watched WHOLE (relative root `''`) and the
			// listener filters by its folder, as in Obsidian. A foreign root delivers nothing.
			const cleanWatched = watched.replace(/^\/+|\/+$/gu, '');
			const relative = cleanWatched === '' || isAncestorOfOutput(watched) !== null ? '' : toRelative(watched);
			if (relative === null || !port) return () => undefined;
			return port.onChange(relative, (change) => listener({
				...change,
				path: toVaultPath(change.path),
				...(change.oldPath === undefined ? {} : { oldPath: toVaultPath(change.oldPath) }),
			}));
		},
		configDir: HEBRA_TYRIAN_CONFIG_DIR,
		canonicalIdentity: () => `hebra-library:${libraryId}`,
		basePath: () => null,
		fullPath: () => null,
		adapter,
	};
}

/** The path relative to the output folder of a vault path, or null when it is outside:
 *  `ui.openNote(path)` looks it up in the index with it. */
export function relativeToOutputFolder(outputFolder: string, path: string): string | null {
	const root = outputFolder.replace(/^\/+|\/+$/gu, '');
	const clean = path.replace(/^\/+|\/+$/gu, '');
	if (clean === root) return '';
	return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : null;
}
