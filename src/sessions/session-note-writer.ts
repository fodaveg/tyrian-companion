import { canonicalJson } from '../core/canonical-sha256';
import { renderLiveSessionNote, inspectLiveSessionNote } from './live-session-note-renderer';
import type { LiveSessionNoteInput } from './live-session-note-model';
import { errorClassName } from '../core/local-debug-error-details';
import { ensureFoldersBySegments } from '../core/vault-folders';
import { prepareSessionNote, type SessionNoteInput } from './session-note-model';
import {
	frontmatterSessionRef,
	mergeRenderedSessionNote,
	renderAbandonedSessionNote,
	renderSessionNote,
	type AbandonedSessionNoteInput,
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
	/** `errorName` is the underlying rejection's class only (never its message or stack), carried
	 * so a caller's diagnostics can tell a permission failure from a race apart from this fixed
	 * copy (H15.10, 2026-09-10 incident: `catch {}` here left every such rejection unlogged). */
	| { status: 'conflict' | 'unavailable'; message: string; errorName?: string };

export class SessionNoteWriter {
	private readonly flights = new Map<string, Promise<SessionNoteWriteResult>>();
	private readonly liveFlights = new Map<string, { payload: string; flight: Promise<SessionNoteWriteResult> }>();

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

	/** The live clear barrier succeeds only after rereading the persisted full journal. */
	async writeLive(input: LiveSessionNoteInput): Promise<SessionNoteWriteResult> {
		const rendered = await renderLiveSessionNote(input);
		if (rendered.status !== 'ok') return rendered;
		const payload = canonicalJson(rendered.session);
		const pending = this.liveFlights.get(rendered.note.sessionRef);
		if (pending) return pending.payload === payload ? pending.flight
			: { status: 'conflict', message: 'A different live session revision is being written.' };
		const flight = this.writeRendered(rendered.note).then(async (result): Promise<SessionNoteWriteResult> => {
			if (result.status !== 'written' && result.status !== 'unchanged') return result;
			try {
				const file = this.vault.file(result.path);
				if (file === null) return { status: 'unavailable', message: 'The live session note could not be verified.' };
				const verified = await inspectLiveSessionNote(await this.vault.read(file));
				return verified.status === 'ok' && canonicalJson(verified.session) === payload ? result
					: { status: 'conflict', message: 'The persisted live session evidence does not match the completed session.' };
			} catch (error) { return { status: 'unavailable', message: 'The live session note could not be verified.', errorName: errorClassName(error) }; }
		}).finally(() => { if (this.liveFlights.get(rendered.note.sessionRef)?.flight === flight) this.liveFlights.delete(rendered.note.sessionRef); });
		this.liveFlights.set(rendered.note.sessionRef,{ payload, flight });
		return flight;
	}

	/**
	 * Writes the note of an abandoned session, or marks the note that session already has as
	 * abandoned: same path, same managed blocks, human lines kept, nothing deleted.
	 */
	async writeAbandoned(input: AbandonedSessionNoteInput): Promise<SessionNoteWriteResult> {
		const rendered = await renderAbandonedSessionNote(input);
		if (rendered.status !== 'ok') return { status: 'invalid', reason: rendered.reason };
		const current = this.flights.get(rendered.note.sessionRef);
		if (current) await current;
		const flight = this.writeRendered(rendered.note).finally(() => {
			if (this.flights.get(rendered.note.sessionRef) === flight) this.flights.delete(rendered.note.sessionRef);
		});
		this.flights.set(rendered.note.sessionRef, flight);
		return flight;
	}

	private async writeRendered(note: RenderedSessionNote<string | null>): Promise<SessionNoteWriteResult> {
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
			} catch (error) {
				const raced = this.vault.file(note.preferredPath);
				if (!raced) return { status: 'unavailable', message: 'The session note could not be created.', errorName: errorClassName(error) };
				const content = await this.vault.read(raced);
				if (frontmatterSessionRef(content) === note.sessionRef) return await this.update(raced, content, note);
				return await this.writeCollision(note);
			}
		} catch (error) {
			return { status: 'unavailable', message: 'The session note could not be written safely.', errorName: errorClassName(error) };
		}
	}

	private async writeCollision(note: RenderedSessionNote<string | null>): Promise<SessionNoteWriteResult> {
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
		} catch (error) {
			const raced = this.vault.file(note.collisionPath);
			if (!raced) return { status: 'unavailable', message: 'The collision-safe session note could not be created.', errorName: errorClassName(error) };
			const content = await this.vault.read(raced);
			if (frontmatterSessionRef(content) !== note.sessionRef) {
				return { status: 'conflict', message: 'The collision-safe session note path is already occupied.' };
			}
			return await this.update(raced, content, note);
		}
	}

	private async update(file: SessionNoteFile, initial: string, note: RenderedSessionNote<string | null>): Promise<SessionNoteWriteResult> {
		let existing = initial;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			// A live note in a payload format this build cannot read is not ours to rewrite with an older one: it stays as it is.
			if (note.frontmatter.tc_schema === 7 && (await inspectLiveSessionNote(existing)).status === 'unsupported') {
				return { status: 'conflict', message: 'The existing session note was written by a newer version of the plugin.' };
			}
			const merged = await mergeRenderedSessionNote(existing, note);
			if (merged.status !== 'ok') {
				return { status: 'conflict', message: 'The existing session note has modified or ambiguous managed blocks.' };
			}
			const unchanged = merged.content === existing;
			let applied = false;
			// Decided on every run, not latched: a host may re-run the update on a fresh read (Hebra
			// retries after `stale`), and only the run whose result it wrote may count.
			const observed = await this.vault.process(file, (current) => {
				applied = current === existing;
				return applied ? merged.content : current;
			});
			if (applied) return { status: unchanged ? 'unchanged' : 'written', path: file.path };
			existing = observed;
		}
		return { status: 'conflict', message: 'The session note changed repeatedly while it was being updated.' };
	}

	private async ensureFolder(folder: string): Promise<void> {
		await ensureFoldersBySegments(this.vault, folder, 'Folder creation failed.');
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
