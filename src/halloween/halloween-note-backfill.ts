import { inspectDurableSessionNote } from '../sessions/session-history';
import { sha256Text } from '../sessions/session-note-renderer';
import type { HalloweenBackfillCandidate } from './halloween-model';

export interface HalloweenBackfillFile { path: string }
export interface HalloweenBackfillVault {
	markdownFiles(): readonly HalloweenBackfillFile[];
	read(file: HalloweenBackfillFile): Promise<string>;
}

export class HalloweenBackfillError extends Error {
	constructor(readonly failure: 'corrupt' | 'unavailable') {
		super(`Halloween note backfill is ${failure}.`);
		this.name = 'HalloweenBackfillError';
	}
}

/** Reads canonical durable session notes; prose and unverified metadata never become inventory evidence. */
export async function scanHalloweenSessionNotes(
	vault: HalloweenBackfillVault,
	accountRef: string,
): Promise<HalloweenBackfillCandidate[]> {
	const candidates: HalloweenBackfillCandidate[] = [];
	const observedSessions = new Set<string>();
	for (const file of [...vault.markdownFiles()].sort((left, right) => left.path.localeCompare(right.path))) {
		let content: string;
		try { content = await vault.read(file); }
		catch { throw new HalloweenBackfillError('unavailable'); }
		const inspected = await inspectDurableSessionNote(content);
		if (inspected.status !== 'ok') {
			if (inspected.status === 'invalid' && hasHalloweenTcHint(content)) throw new HalloweenBackfillError('corrupt');
			continue;
		}
		const evidence = inspected.evidence;
		if (evidence.event !== 'halloween' || evidence.accountRef !== accountRef) continue;
		if (observedSessions.has(evidence.sessionRef)) throw new HalloweenBackfillError('corrupt');
		observedSessions.add(evidence.sessionRef);
		const gains = evidence.positiveItemDeltas === null ? [] : [...evidence.positiveItemDeltas];
		const fingerprint = await sha256Text(JSON.stringify({
			schema: evidence.schema,
			sessionRef: evidence.sessionRef,
			endedAt: evidence.endedAt,
			gains,
		}));
		candidates.push({
			observationId: `note:${evidence.sessionRef}:${fingerprint}`,
			episodeId: `note-session:${evidence.sessionRef}`,
			observedAt: evidence.endedAt,
			coverage: evidence.schema === 3 ? 'complete' : 'partial',
			gains,
		});
	}
	return candidates.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
		left.observationId.localeCompare(right.observationId));
}

/** Used only to decide whether an invalid canonical note must fail the opt-in scan closed. */
function hasHalloweenTcHint(content: string): boolean {
	const opening = /^---\r?\n/u.exec(content)?.[0];
	if (opening === undefined) return false;
	const closing = /\r?\n---(?:\r?\n|$)/u.exec(content.slice(opening.length));
	if (closing?.index === undefined) return false;
	return /(?:^|\r?\n)\s*tc_event\s*:\s*["']?halloween["']?\s*(?:\r?\n|$)/iu
		.test(content.slice(opening.length, opening.length + closing.index));
}
