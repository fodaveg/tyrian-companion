/**
 * Test support for live session notes of version 3, whose payload lives in a `.json` file of its own.
 *
 * `renderLiveSessionNote` here is the real one, and remembers the payload file of everything it renders; `inspectLiveSessionNote`
 * is the real one too, reading the payload from what was remembered. A test that renders a note and then inspects its text
 * (without a vault in between) uses these two in place of the originals and reads as it did when the payload was inside the text.
 * `inlineLiveSessionNote` rebuilds the note of version 1 or 2 that builds up to 0.7.1 wrote, to test what must keep reading.
 */
import { canonicalJson } from '../core/canonical-sha256';
import { inspectLiveSessionNote as inspectReal, renderLiveSessionNote as renderReal } from '../sessions/live-session-note-renderer';
import type { LiveSessionPayloadReader } from '../sessions/live-session-payload-file';
import type { LiveSessionNoteInput, StoredLiveSessionPayloadV1 } from '../sessions/live-session-note-model';
import { readStoredSessionBlocks, rewriteStoredSessionNote } from '../sessions/session-note-renderer';

const REMEMBERED = new Map<string, string>();

/** Reads the payload files remembered by `renderLiveSessionNote` of this module. */
export const rememberedPayloads: LiveSessionPayloadReader = async (relative) => REMEMBERED.get(relative) ?? null;

export async function renderLiveSessionNote(input: LiveSessionNoteInput): ReturnType<typeof renderReal> {
	const result = await renderReal(input);
	if (result.status === 'ok') REMEMBERED.set(result.payloadFile.relative, result.payloadFile.content);
	return result;
}

export function inspectLiveSessionNote(content: string, readPayload: LiveSessionPayloadReader = rememberedPayloads): ReturnType<typeof inspectReal> {
	return inspectReal(content, readPayload);
}

const LEGACY_SENTENCE = {
	es: 'El siguiente registro conserva la sesión completa para recuperarla y exportarla en otra instalación.',
	en: 'The following record preserves the complete session for recovery and export on another installation.',
};

/** The note of version 1 or 2 (payload inside the text) with the same session as `note`, the way builds up to 0.7.1 wrote it. */
export async function inlineLiveSessionNote(note: string, session: StoredLiveSessionPayloadV1, locale: 'es' | 'en' = 'es'): Promise<string> {
	const blocks = await readStoredSessionBlocks(note);
	if (blocks === null) throw new Error('fixture');
	const head = blocks.provenance.split('\n').slice(0,-1);
	const provenance = [...head, LEGACY_SENTENCE[locale], '```json', canonicalJson(session), '```'].join('\n');
	const inline = await rewriteStoredSessionNote(note, { tc_payload_version: session.version, tc_payload_file: undefined }, { provenance });
	if (inline === null) throw new Error('fixture');
	return inline;
}
