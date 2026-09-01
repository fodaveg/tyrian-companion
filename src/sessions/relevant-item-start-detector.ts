import type { StorageDeltaStatus } from '../account/storage-delta-model';

export const RELEVANT_START_PROPOSAL_VERSION = 1 as const;

/**
 * Documented ceiling of the Guild Wars 2 account cache chain, «5-10 minutes (nested caches)»
 * according to ArenaNet's own API developer; the same source `session-api-settlement` cites.
 * Below this ceiling two consecutive polls can read byte-identical bytes while the player is
 * farming, so consecutiveness is not evidence of anything and must not gate a proposal.
 */
export const RELEVANT_EVIDENCE_CACHE_CEILING_MS = 10 * 60_000;

/** Relevant gains needed inside the trailing evidence before a start is proposed. */
export const RELEVANT_EVIDENCE_REQUIRED_GAINS = 2;

/**
 * Trailing evidence retained for the two-gain criterion: never fewer than this many contiguous
 * samples, and never a shorter span than `RELEVANT_EVIDENCE_WINDOW_MS`.
 *
 * With a poll interval `P` the retained span is `max(3·P, 30 min)`, and observing two distinct
 * cache generations needs at most `CACHE_CEILING + 2·P`. The floor covers every `P >= 10 min`
 * (`3·P - (10 + 2·P) = P - 10 >= 0`) and the window covers every `P <= 10 min`
 * (`30 >= 10 + 2·P`), so the criterion is reachable at any cadence instead of only at slow ones.
 */
export const RELEVANT_EVIDENCE_MIN_SAMPLES = 3;
export const RELEVANT_EVIDENCE_WINDOW_MS = 30 * 60_000;

/** Hard cap so a pathological cadence cannot grow the retained evidence without bound. */
export const RELEVANT_EVIDENCE_MAX_SAMPLES = 64;

export interface RelevantItemRuleSet {
	id: string;
	version: number;
	itemIds: readonly number[];
}

export interface RelevantItemGain {
	itemId: number;
	quantity: number;
}

export interface RelevantDeltaSignal {
	accountId: string;
	beforeSnapshotId: string;
	afterSnapshotId: string;
	window: { from: string; to: string };
	deltaStatus: Exclude<StorageDeltaStatus, 'invalid'>;
	gains: RelevantItemGain[];
}

export interface RelevantStartProposal {
	version: typeof RELEVANT_START_PROPOSAL_VERSION;
	proposalId: string;
	accountId: string;
	ruleSet: { id: string; version: number };
	possibleStart: {
		from: string;
		to: string;
		uncertaintyMs: number;
	};
	evidenceQuality: 'complete' | 'limited';
	confirmedAt: string;
	firstSignal: RelevantDeltaSignal;
	confirmationSignal: RelevantDeltaSignal;
}

export type RelevantStartObservation =
	| { status: 'no_signal'; reason: 'invalid_delta' | 'no_relevant_gain'; proposal: null }
	| { status: 'first_signal'; signal: RelevantDeltaSignal; proposal: null }
	| { status: 'duplicate'; proposal: RelevantStartProposal | null }
	| { status: 'proposed'; proposal: RelevantStartProposal };

/**
 * Turns two relevant positive deltas inside a trailing evidence window into a proposal. It never
 * starts a session, performs I/O, or infers relevance from mutable catalog text.
 *
 * The window is deliberately not «two consecutive polls»: the account API answers from a 5-10
 * minute cache, so at a fast cadence the gains land on every other poll at best and a
 * consecutiveness rule never fires. Quiet samples no longer discard the evidence, they only age
 * it out.
 */
export class RelevantItemStartDetector {
	private readonly ruleSet: { id: string; version: number; itemIds: Set<number> };
	private readonly samples: EvidenceSample[] = [];
	private proposal: RelevantStartProposal | null = null;
	private lastDeltaIdentity: string | null = null;

	constructor(ruleSet: RelevantItemRuleSet) {
		this.ruleSet = normalizeRuleSet(ruleSet);
	}

	getProposal(): RelevantStartProposal | null {
		return this.proposal ? structuredClone(this.proposal) : null;
	}

	observe(value: unknown): RelevantStartObservation {
		if (this.proposal) return { status: 'duplicate', proposal: this.getProposal() };
		const delta = parseDelta(value);
		if (!delta) {
			this.resetPending();
			return { status: 'no_signal', reason: 'invalid_delta', proposal: null };
		}

		const identity = JSON.stringify(delta);
		if (identity === this.lastDeltaIdentity) {
			return { status: 'duplicate', proposal: this.getProposal() };
		}
		this.lastDeltaIdentity = identity;

		const sample: EvidenceSample = {
			accountId: delta.accountId,
			beforeSnapshotId: delta.beforeSnapshotId,
			afterSnapshotId: delta.afterSnapshotId,
			window: { ...delta.window },
			deltaStatus: delta.status,
			signal: relevantSignal(delta, this.ruleSet.itemIds),
		};

		// A break in the snapshot chain means the retained samples no longer describe one
		// uninterrupted observation of the same account: they are evidence of nothing together.
		const previous = this.samples.at(-1);
		if (previous && !areContiguous(previous, sample)) this.samples.length = 0;
		this.samples.push(sample);
		this.pruneEvidence();

		if (!sample.signal) return { status: 'no_signal', reason: 'no_relevant_gain', proposal: null };

		const firstGainIndex = this.samples.findIndex((entry) => entry.signal !== null);
		const gains = this.samples.reduce((total, entry) => total + (entry.signal ? 1 : 0), 0);
		if (gains < RELEVANT_EVIDENCE_REQUIRED_GAINS) {
			return { status: 'first_signal', signal: structuredClone(sample.signal), proposal: null };
		}

		const proposal = buildProposal(this.ruleSet, this.samples.slice(firstGainIndex));
		this.proposal = proposal;
		return { status: 'proposed', proposal: structuredClone(proposal) };
	}

	reset(): void {
		this.resetPending();
		this.proposal = null;
	}

	private resetPending(): void {
		this.samples.length = 0;
		this.lastDeltaIdentity = null;
	}

	/** Ages evidence out by span and by count, always retaining the minimum sample floor. */
	private pruneEvidence(): void {
		while (this.samples.length > RELEVANT_EVIDENCE_MIN_SAMPLES && (
			this.samples.length > RELEVANT_EVIDENCE_MAX_SAMPLES ||
			evidenceSpanMs(this.samples) > RELEVANT_EVIDENCE_WINDOW_MS
		)) this.samples.shift();
	}
}

/** One observed delta kept in the trailing window, with or without a relevant gain. */
interface EvidenceSample {
	accountId: string;
	beforeSnapshotId: string;
	afterSnapshotId: string;
	window: { from: string; to: string };
	deltaStatus: Exclude<StorageDeltaStatus, 'invalid'>;
	signal: RelevantDeltaSignal | null;
}

interface ParsedDelta {
	status: Exclude<StorageDeltaStatus, 'invalid'>;
	accountId: string;
	beforeSnapshotId: string;
	afterSnapshotId: string;
	window: { from: string; to: string };
	itemChanges: Array<{ id: number; delta: number }>;
}

function normalizeRuleSet(ruleSet: RelevantItemRuleSet): {
	id: string;
	version: number;
	itemIds: Set<number>;
} {
	const rawItemIds: unknown = ruleSet.itemIds;
	if (
		typeof ruleSet !== 'object' || ruleSet === null ||
		typeof ruleSet.id !== 'string' || !validIdentifier(ruleSet.id) ||
		!Number.isSafeInteger(ruleSet.version) || ruleSet.version <= 0 ||
		!isUnknownArray(rawItemIds) || rawItemIds.length === 0
	) throw new TypeError('Relevant item rule set is invalid.');

	if (!rawItemIds.every(isPositiveId)) {
		throw new TypeError('Relevant item ids must be sorted, unique positive integers.');
	}
	const ids = rawItemIds.filter(isPositiveId);
	if (ids.some((id, index) => index > 0 && id <= (ids[index - 1] ?? 0))) {
		throw new TypeError('Relevant item ids must be sorted, unique positive integers.');
	}
	return { id: ruleSet.id, version: ruleSet.version, itemIds: new Set(ids) };
}

function parseDelta(value: unknown): ParsedDelta | null {
	if (!isRecord(value) || value.version !== 1 || (value.status !== 'comparable' && value.status !== 'limited')) {
		return null;
	}
	if (
		!nonEmptyString(value.accountId) ||
		!nonEmptyString(value.beforeSnapshotId) ||
		!nonEmptyString(value.afterSnapshotId) ||
		value.beforeSnapshotId === value.afterSnapshotId ||
		!validWindow(value.window) ||
		(value.surface !== 'core_and_delivery' && value.surface !== 'core_only') ||
		(value.currencySurface !== 'wallet_and_delivery' &&
			value.currencySurface !== 'wallet_only' && value.currencySurface !== 'unavailable') ||
		(value.status === 'comparable' &&
			(value.surface !== 'core_and_delivery' || value.currencySurface !== 'wallet_and_delivery')) ||
		(value.status === 'limited' &&
			value.surface === 'core_and_delivery' && value.currencySurface === 'wallet_and_delivery') ||
		!Array.isArray(value.itemChanges)
	) return null;

	const itemChanges: Array<{ id: number; delta: number }> = [];
	let previousId = 0;
	for (const change of value.itemChanges) {
		if (
			!isRecord(change) ||
			!hasOnlyKeys(change, ['id', 'before', 'after', 'delta']) ||
			!isPositiveId(change.id) || change.id <= previousId ||
			!isNonNegativeSafeInteger(change.before) ||
			!isNonNegativeSafeInteger(change.after) ||
			!Number.isSafeInteger(change.delta) || change.delta === 0 ||
			change.after - change.before !== change.delta
		) return null;
		previousId = change.id;
		itemChanges.push({ id: change.id, delta: change.delta });
	}

	return {
		status: value.status,
		accountId: value.accountId,
		beforeSnapshotId: value.beforeSnapshotId,
		afterSnapshotId: value.afterSnapshotId,
		window: value.window,
		itemChanges,
	};
}

function relevantSignal(delta: ParsedDelta, relevantIds: ReadonlySet<number>): RelevantDeltaSignal | null {
	const gains = delta.itemChanges
		.filter((change) => change.delta > 0 && relevantIds.has(change.id))
		.map((change) => ({ itemId: change.id, quantity: change.delta }));
	return gains.length === 0 ? null : {
		accountId: delta.accountId,
		beforeSnapshotId: delta.beforeSnapshotId,
		afterSnapshotId: delta.afterSnapshotId,
		window: { ...delta.window },
		deltaStatus: delta.status,
		gains,
	};
}

function areContiguous(first: EvidenceSample, second: EvidenceSample): boolean {
	return first.accountId === second.accountId &&
		first.afterSnapshotId === second.beforeSnapshotId &&
		Date.parse(first.window.to) <= Date.parse(second.window.from);
}

function evidenceSpanMs(samples: readonly EvidenceSample[]): number {
	const oldest = samples[0];
	const newest = samples.at(-1);
	if (!oldest || !newest) return 0;
	return Date.parse(newest.window.to) - Date.parse(oldest.window.from);
}

/**
 * Builds the proposal from the retained span that starts at the oldest gain and ends at the
 * newest one. Coverage is judged over the whole span, quiet samples included: a `limited` delta
 * in the middle did not read the full surface, so it cannot back a `complete` claim.
 */
function buildProposal(
	ruleSet: { id: string; version: number },
	span: readonly EvidenceSample[],
): RelevantStartProposal {
	const first = span[0]?.signal;
	const confirmation = span.at(-1)?.signal;
	if (!first || !confirmation) throw new TypeError('Relevant start evidence span is incomplete.');
	const from = Date.parse(first.window.from);
	const to = Date.parse(first.window.to);
	return {
		version: RELEVANT_START_PROPOSAL_VERSION,
		proposalId: `relevant-start:${ruleSet.id}:${ruleSet.version}:${first.beforeSnapshotId}:${confirmation.afterSnapshotId}`,
		accountId: first.accountId,
		ruleSet: { id: ruleSet.id, version: ruleSet.version },
		possibleStart: { from: first.window.from, to: first.window.to, uncertaintyMs: to - from },
		evidenceQuality: span.every((entry) => entry.deltaStatus === 'comparable') ? 'complete' : 'limited',
		confirmedAt: confirmation.window.to,
		firstSignal: structuredClone(first),
		confirmationSignal: structuredClone(confirmation),
	};
}

function validWindow(value: unknown): value is { from: string; to: string } {
	if (!isRecord(value) || !hasOnlyKeys(value, ['from', 'to']) ||
		typeof value.from !== 'string' || typeof value.to !== 'string') return false;
	const from = Date.parse(value.from);
	const to = Date.parse(value.to);
	return Number.isFinite(from) && Number.isFinite(to) && from < to && Number.isSafeInteger(to - from) &&
		new Date(from).toISOString() === value.from && new Date(to).toISOString() === value.to;
}

function validIdentifier(value: string): boolean {
	return value.length > 0 && value.length <= 128 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value);
}

function isPositiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}
