import { inspectDurableSessionNote } from '../sessions/session-history';
import { sha256Text } from '../sessions/session-note-renderer';
import type { HalloweenBackfillCandidate } from './halloween-model';

export interface HalloweenBackfillFile { path: string; mtime?: number }
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

/** What a single note resolves to, independent of which account is being scanned. */
type HalloweenBackfillOutcome =
	| { kind: 'skip' }
	| { kind: 'corrupt' }
	| { kind: 'candidate'; accountRef: string; sessionRef: string; candidate: HalloweenBackfillCandidate };

/**
 * Per-path memo of the last inspection, invalidated by `mtime`.
 *
 * A vault event (create/modify/delete/rename under the sessions folder) or a repeated
 * "Comprobar conexión" re-scans every session note every time; without this, that means
 * re-reading and re-parsing thousands of untouched notes just to notice zero of them
 * changed. The outcome cached here does not depend on the account being scanned, so it
 * survives an account switch too: only content and `mtime` invalidate it.
 */
export class HalloweenBackfillCache {
	private readonly entries = new Map<string, { mtime: number; outcome: HalloweenBackfillOutcome }>();

	/** Drops entries for paths no longer present, so a deleted note cannot resurrect its candidate. */
	prune(paths: ReadonlySet<string>): void {
		for (const path of this.entries.keys()) if (!paths.has(path)) this.entries.delete(path);
	}

	get(path: string, mtime: number): HalloweenBackfillOutcome | undefined {
		const entry = this.entries.get(path);
		return entry !== undefined && entry.mtime === mtime ? entry.outcome : undefined;
	}

	set(path: string, mtime: number, outcome: HalloweenBackfillOutcome): void {
		this.entries.set(path, { mtime, outcome });
	}
}

/** Reads canonical durable session notes; prose and unverified metadata never become inventory evidence. */
export async function scanHalloweenSessionNotes(
	vault: HalloweenBackfillVault,
	accountRef: string,
	cache?: HalloweenBackfillCache,
): Promise<HalloweenBackfillCandidate[]> {
	const candidates: HalloweenBackfillCandidate[] = [];
	const observedSessions = new Set<string>();
	const files = [...vault.markdownFiles()].sort((left, right) => left.path.localeCompare(right.path));
	cache?.prune(new Set(files.map((file) => file.path)));
	for (const file of files) {
		let outcome = file.mtime === undefined ? undefined : cache?.get(file.path, file.mtime);
		if (outcome === undefined) {
			let content: string;
			try { content = await vault.read(file); }
			catch { throw new HalloweenBackfillError('unavailable'); }
			outcome = await inspectHalloweenNote(content);
			if (file.mtime !== undefined) cache?.set(file.path, file.mtime, outcome);
		}
		if (outcome.kind === 'corrupt') throw new HalloweenBackfillError('corrupt');
		if (outcome.kind === 'skip') continue;
		if (outcome.accountRef !== accountRef) continue;
		if (observedSessions.has(outcome.sessionRef)) throw new HalloweenBackfillError('corrupt');
		observedSessions.add(outcome.sessionRef);
		candidates.push(outcome.candidate);
	}
	return candidates.sort((left, right) => left.observedAt.localeCompare(right.observedAt) ||
		left.observationId.localeCompare(right.observationId));
}

async function inspectHalloweenNote(content: string): Promise<HalloweenBackfillOutcome> {
	const inspected = await inspectDurableSessionNote(content);
	if (inspected.status !== 'ok') {
		return inspected.status === 'invalid' && hasHalloweenTcHint(content) ? { kind: 'corrupt' } : { kind: 'skip' };
	}
	const evidence = inspected.evidence;
	if (evidence.event !== 'halloween') return { kind: 'skip' };
	const gains = evidence.positiveItemDeltas === null ? [] : [...evidence.positiveItemDeltas];
	const fingerprint = await sha256Text(JSON.stringify({
		schema: evidence.schema,
		sessionRef: evidence.sessionRef,
		endedAt: evidence.endedAt,
		gains,
	}));
	return {
		kind: 'candidate',
		accountRef: evidence.accountRef,
		sessionRef: evidence.sessionRef,
		candidate: {
			observationId: `note:${evidence.sessionRef}:${fingerprint}`,
			episodeId: `note-session:${evidence.sessionRef}`,
			observedAt: evidence.endedAt,
			coverage: evidence.schema === 3 ? 'complete' : 'partial',
			gains,
		},
	};
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
