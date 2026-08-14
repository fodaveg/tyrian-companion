import { prepareSessionNote, type SessionNoteInput } from './session-note-model';
import {
	frontmatterSessionRef,
	mergeRenderedSessionNote,
	renderSessionNote,
	type RenderedSessionNote,
} from './session-note-renderer';

export interface SessionNoteFile { path: string }

/** Vault-only persistence port. Production adapts Obsidian Vault; no filesystem path is exposed. */
export interface SessionNoteVault {
	file(path: string): SessionNoteFile | null;
	read(file: SessionNoteFile): Promise<string>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<SessionNoteFile>;
	process(file: SessionNoteFile, update: (content: string) => string): Promise<string>;
}

export type SessionNoteWriteResult =
	| { status: 'written' | 'unchanged'; path: string }
	| { status: 'invalid'; reason: string }
	| { status: 'conflict' | 'unavailable'; message: string };

export class SessionNoteWriter {
	private readonly flights = new Map<string, Promise<SessionNoteWriteResult>>();

	constructor(private readonly vault: SessionNoteVault) {}

	async write(value: unknown): Promise<SessionNoteWriteResult> {
		const prepared = prepareSessionNote(value);
		if (prepared.status !== 'ok') return { status: 'invalid', reason: prepared.reason };
		const rendered = await renderSessionNote(prepared.note);
		if (rendered.status !== 'ok') return { status: 'invalid', reason: rendered.reason };
		const current = this.flights.get(rendered.note.sessionRef);
		if (current) return current;
		const flight = this.writeRendered(rendered.note).finally(() => {
			if (this.flights.get(rendered.note.sessionRef) === flight) this.flights.delete(rendered.note.sessionRef);
		});
		this.flights.set(rendered.note.sessionRef, flight);
		return flight;
	}

	private async writeRendered(note: RenderedSessionNote): Promise<SessionNoteWriteResult> {
		try {
			await this.ensureFolder(note.preferredPath.slice(0, note.preferredPath.lastIndexOf('/')));
			const preferred = this.vault.file(note.preferredPath);
			if (preferred) {
				const content = await this.vault.read(preferred);
				if (frontmatterSessionRef(content) === note.sessionRef) return await this.update(preferred, content, note);
				return await this.writeCollision(note);
			}
			try {
				await this.vault.create(note.preferredPath, note.content);
				return { status: 'written', path: note.preferredPath };
			} catch {
				const raced = this.vault.file(note.preferredPath);
				if (!raced) return { status: 'unavailable', message: 'The session note could not be created.' };
				const content = await this.vault.read(raced);
				if (frontmatterSessionRef(content) === note.sessionRef) return await this.update(raced, content, note);
				return await this.writeCollision(note);
			}
		} catch {
			return { status: 'unavailable', message: 'The session note could not be written safely.' };
		}
	}

	private async writeCollision(note: RenderedSessionNote): Promise<SessionNoteWriteResult> {
		const existing = this.vault.file(note.collisionPath);
		if (existing) {
			const content = await this.vault.read(existing);
			if (frontmatterSessionRef(content) !== note.sessionRef) {
				return { status: 'conflict', message: 'The collision-safe session note path is already occupied.' };
			}
			return await this.update(existing, content, note);
		}
		try {
			await this.vault.create(note.collisionPath, note.content);
			return { status: 'written', path: note.collisionPath };
		} catch {
			const raced = this.vault.file(note.collisionPath);
			if (!raced) return { status: 'unavailable', message: 'The collision-safe session note could not be created.' };
			const content = await this.vault.read(raced);
			if (frontmatterSessionRef(content) !== note.sessionRef) {
				return { status: 'conflict', message: 'The collision-safe session note path is already occupied.' };
			}
			return await this.update(raced, content, note);
		}
	}

	private async update(file: SessionNoteFile, initial: string, note: RenderedSessionNote): Promise<SessionNoteWriteResult> {
		let existing = initial;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const merged = await mergeRenderedSessionNote(existing, note);
			if (merged.status !== 'ok') {
				return { status: 'conflict', message: 'The existing session note has modified or ambiguous managed blocks.' };
			}
			const unchanged = merged.content === existing;
			let applied = false;
			const observed = await this.vault.process(file, (current) => {
				if (current !== existing) return current;
				applied = true;
				return merged.content;
			});
			if (applied) return { status: unchanged ? 'unchanged' : 'written', path: file.path };
			existing = observed;
		}
		return { status: 'conflict', message: 'The session note changed repeatedly while it was being updated.' };
	}

	private async ensureFolder(folder: string): Promise<void> {
		let current = '';
		for (const segment of folder.split('/')) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.vault.file(current)) {
				try { await this.vault.createFolder(current); }
				catch { if (!this.vault.file(current)) throw new Error('Folder creation failed.'); }
			}
		}
	}
}

/** Clear barrier: a failed/conflicted note write leaves the completed runtime untouched. */
export async function writeSessionNoteBeforeClear(
	writer: Pick<SessionNoteWriter, 'write'>,
	input: SessionNoteInput,
	clear: () => Promise<boolean>,
): Promise<boolean> {
	const note = await writer.write(input);
	if (note.status !== 'written' && note.status !== 'unchanged') return false;
	return await clear();
}

export type { SessionNoteInput };
