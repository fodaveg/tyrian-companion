import type { StorageDeltaStatus } from '../account/storage-delta-model';

export const RELEVANT_START_PROPOSAL_VERSION = 1 as const;

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
 * Turns two contiguous relevant positive deltas into a proposal. It never starts
 * a session, performs I/O, or infers relevance from mutable catalog text.
 */
export class RelevantItemStartDetector {
	private readonly ruleSet: { id: string; version: number; itemIds: Set<number> };
	private firstSignal: RelevantDeltaSignal | null = null;
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

		const signal = relevantSignal(delta, this.ruleSet.itemIds);
		if (!signal) {
			this.firstSignal = null;
			return { status: 'no_signal', reason: 'no_relevant_gain', proposal: null };
		}

		if (!this.firstSignal || !areContiguous(this.firstSignal, signal)) {
			this.firstSignal = signal;
			return { status: 'first_signal', signal: structuredClone(signal), proposal: null };
		}

		const proposal = buildProposal(this.ruleSet, this.firstSignal, signal);
		this.proposal = proposal;
		return { status: 'proposed', proposal: structuredClone(proposal) };
	}

	reset(): void {
		this.firstSignal = null;
		this.proposal = null;
		this.lastDeltaIdentity = null;
	}

	private resetPending(): void {
		this.firstSignal = null;
		this.lastDeltaIdentity = null;
	}
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

function areContiguous(first: RelevantDeltaSignal, second: RelevantDeltaSignal): boolean {
	return first.accountId === second.accountId &&
		first.afterSnapshotId === second.beforeSnapshotId &&
		first.window.to === second.window.from;
}

function buildProposal(
	ruleSet: { id: string; version: number },
	first: RelevantDeltaSignal,
	confirmation: RelevantDeltaSignal,
): RelevantStartProposal {
	const from = Date.parse(first.window.from);
	const to = Date.parse(first.window.to);
	return {
		version: RELEVANT_START_PROPOSAL_VERSION,
		proposalId: `relevant-start:${ruleSet.id}:${ruleSet.version}:${first.beforeSnapshotId}:${confirmation.afterSnapshotId}`,
		accountId: first.accountId,
		ruleSet: { id: ruleSet.id, version: ruleSet.version },
		possibleStart: { from: first.window.from, to: first.window.to, uncertaintyMs: to - from },
		evidenceQuality:
			first.deltaStatus === 'comparable' && confirmation.deltaStatus === 'comparable'
				? 'complete'
				: 'limited',
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
