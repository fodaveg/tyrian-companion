/**
 * The seven path-based vault ports, built from one host `TyrianVault`.
 *
 * `TyrianVault` already satisfies every port by type (`TyrianVaultPortConformance`). These
 * wrappers keep the two things the per-port adapters in `main.ts` did on top of it before R1a,
 * so moving them behind the host changed no behavior:
 *
 * - a read, write or trash of something that is not a file rejects with that port's own message
 *   (`Inventory note is not a file.`, …), which is what reaches its caller and its diagnostics;
 * - the session-history port answers `file()` with `null` for a folder (its `exists()` is what
 *   reports folders), and resolves `process` to nothing. It also carries the host's change
 *   events, only where the host says they are complete (`TyrianVault.reportsEveryChange`).
 *
 * A file carries `mtime` and a folder does not (`TyrianVaultFile`): that is the only file/folder
 * test a host-neutral caller has.
 */

import type { SessionHistoryNoteChange, SessionHistoryVault } from '../sessions/session-history';
import type { TyrianVault, TyrianVaultFile } from '../host/tyrian-host';

function isFile(entry: TyrianVaultFile | null): entry is TyrianVaultFile {
	return entry !== null && entry.mtime !== undefined;
}

/** `vault`, with every file-only operation refusing a non-file under `label`'s own message. */
export function labelledVault(vault: TyrianVault, label: string): TyrianVault {
	const requireFile = (file: TyrianVaultFile): TyrianVaultFile => {
		if (!isFile(vault.file(file.path))) throw new Error(`${label} is not a file.`);
		return file;
	};
	return {
		markdownFiles: () => vault.markdownFiles(),
		listFiles: () => vault.listFiles(),
		exists: (path) => vault.exists(path),
		file: (path) => vault.file(path),
		read: async (file) => await vault.read(requireFile(file)),
		process: async (file, update) => await vault.process(requireFile(file), update),
		createFolder: async (path) => { await vault.createFolder(path); },
		create: async (path, content) => await vault.create(path, content),
		trashFile: async (file) => { await vault.trashFile(requireFile(file)); },
		// Passed through as the host answers it: a missing note or a folder is the host's own
		// `conflict`, and the guarantee it reports is never upgraded here.
		trashIfUnchanged: async (file, expectedContent) => await vault.trashIfUnchanged(file, expectedContent),
		onChange: (root, listener) => vault.onChange(root, listener),
		get configDir() { return vault.configDir; },
		canonicalIdentity: () => vault.canonicalIdentity(),
		basePath: () => vault.basePath(),
		fullPath: (path) => vault.fullPath(path),
		get adapter() { return vault.adapter; },
	};
}

/** The session-history port: files only through `file()`, folders through `exists()`. */
export function sessionHistoryVault(vault: TyrianVault): SessionHistoryVault {
	const notes = labelledVault(vault, 'Session history note');
	return {
		markdownFiles: () => notes.markdownFiles().map((file) => ({ path: file.path })),
		exists: (path) => notes.exists(path),
		file: (path) => {
			const entry = notes.file(path);
			return isFile(entry) ? { path: entry.path } : null;
		},
		read: async (file) => await notes.read(file),
		process: async (file, update) => { await notes.process(file, update); },
		createFolder: async (path) => { await notes.createFolder(path); },
		create: async (path, content) => {
			const file = await notes.create(path, content);
			return { path: file.path };
		},
		// Offered only where the host promises to report every change: it is what lets the history
		// keep an inspection instead of reading the note again. `''` is the whole vault, because a
		// session note moved out of the output folder still counts.
		...(vault.reportsEveryChange === true
			? { onNoteChange: (listener: (change: SessionHistoryNoteChange) => void) => vault.onChange('', listener) }
			: {}),
	};
}
