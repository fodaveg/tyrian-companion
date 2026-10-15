import { ensureFoldersBySegments } from '../core/vault-folders';

/**
 * The payload of a live session note of `tc_payload_version` 3 lives in a text file of its own, managed by the plugin, instead of
 * inside the note: a long session's payload is megabytes, and Hebra's relay refuses a note that large (HTTP 413, `record_too_large`).
 *
 * The file is `<outputFolder>/sessions/data/<sessionRef>.json`. Its name comes from the session's reference, never from the note's
 * title (which may change), and it is plain text, so the rule "the plugin writes no binaries into the vault" still holds. The note
 * names it relative to the output folder (`tc_payload_file`); a reader finds the output folder from the path of the note, which
 * always ends in `sessions/<year>/<name>.md`.
 */
export function liveSessionPayloadFilePath(sessionRef: string): string { return `sessions/data/${sessionRef}.json`; }

/** True for the one path `liveSessionPayloadFilePath` gives `sessionRef`: nothing else a note names is ever read. */
export function isLiveSessionPayloadFileRef(value: unknown, sessionRef: unknown): value is string {
	return typeof value === 'string' && typeof sessionRef === 'string' && /^[a-f0-9]{64}$/u.test(sessionRef) && value === liveSessionPayloadFilePath(sessionRef);
}

/** The output folder a session note sits in (`<outputFolder>/sessions/<year>/<name>.md`), or null for a note moved out of that layout. */
export function outputFolderOfSessionNote(notePath: string): string | null {
	const match = /^(?:(.*)\/)?sessions\/\d{4}\/[^/]+\.md$/u.exec(notePath);
	return match === null ? null : match[1] ?? '';
}

/** The vault path of the payload file a note at `notePath` names, or null when the note cannot be placed. */
export function liveSessionPayloadVaultPath(notePath: string, relative: string): string | null {
	const folder = outputFolderOfSessionNote(notePath);
	return folder === null ? null : folder === '' ? relative : `${folder}/${relative}`;
}

/** Reads the payload file a note names (the path relative to the output folder); null when it is not there (yet) or cannot be read. */
export type LiveSessionPayloadReader = (relative: string) => Promise<string | null>;

interface PayloadFileReadVault {
	file(path: string): { path: string } | null;
	read(file: { path: string }): Promise<string>;
}

/**
 * The reader for the note at `notePath`. A file that is absent, a note outside the layout, or a read that fails (in Hebra the
 * file may not have reached this device yet) all answer null: "missing" is a state of its own and never a verdict on the note.
 */
export function liveSessionPayloadReader(vault: PayloadFileReadVault, notePath: string): LiveSessionPayloadReader {
	return async (relative) => {
		try {
			const path = liveSessionPayloadVaultPath(notePath, relative);
			if (path === null) return null;
			const file = vault.file(path);
			return file === null ? null : await vault.read(file);
		} catch { return null; }
	};
}

export interface PayloadFileWriteVault extends PayloadFileReadVault {
	createFolder(path: string): Promise<unknown>;
	create(path: string, content: string): Promise<unknown>;
	process?(file: { path: string }, update: (current: string) => string): Promise<unknown>;
	/** Only a port whose `file()` does not answer for folders has it. */
	exists?(path: string): boolean;
}

/**
 * Makes sure the payload file of a session holds exactly `content`, before the note that names it is written. A file that already
 * holds it is not written again. Throws when it cannot: the caller must not write the note then.
 */
export async function writeLiveSessionPayloadFile(vault: PayloadFileWriteVault, outputFolder: string, sessionRef: string, content: string): Promise<void> {
	const path = `${outputFolder}/${liveSessionPayloadFilePath(sessionRef)}`;
	const existing = vault.file(path);
	if (existing !== null) {
		if (await vault.read(existing) === content) return;
		if (vault.process === undefined) throw new Error('The session payload file differs and cannot be replaced.');
		await vault.process(existing, () => content);
		return;
	}
	await ensureFoldersBySegments({ file: (folder) => vault.exists?.(folder) === true ? { path: folder } : vault.file(folder),
		createFolder: (folder) => vault.createFolder(folder) }, `${outputFolder}/sessions/data`, 'Session payload folder creation failed.');
	try { await vault.create(path, content); }
	catch (error) {
		// Another writer (or the host's sync) created it first: fine when it holds the same text.
		const raced = vault.file(path);
		if (raced === null || await vault.read(raced) !== content) throw error;
	}
}
