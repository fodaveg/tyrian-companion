export const INACTIVITY_STOP_PROPOSAL_VERSION = 1 as const;

export interface InactivitySample {
	accountId: string;
	beforeSnapshotId: string;
	afterSnapshotId: string;
	window: { from: string; to: string };
	relevantGainQuantity: number;
	evidenceQuality: 'complete' | 'limited';
}

export interface InactivityStopProposal {
	version: typeof INACTIVITY_STOP_PROPOSAL_VERSION;
	proposalId: string;
	accountId: string;
	thresholdMs: number;
	possibleStop: { from: string; to: string; uncertaintyMs: number };
	quietSince: string;
	quietDurationMs: number;
	detectedAt: string;
	evidenceQuality: 'complete' | 'limited';
	lastGainSample: InactivitySample | null;
	firstQuietSample: InactivitySample;
	confirmationSample: InactivitySample;
}

export type InactivityObservation =
	| { status: 'invalid_sample'; proposal: null }
	| { status: 'activity'; proposal: null }
	| { status: 'quiet'; quietDurationMs: number; remainingMs: number; proposal: null }
	| { status: 'duplicate'; proposal: InactivityStopProposal | null }
	| { status: 'proposed'; proposal: InactivityStopProposal };

/**
 * Measures a continuous quiet period and emits a proposal only. It never stops
 * or transitions a product session.
 */
export class InactivityStopDetector {
	private readonly thresholdMs: number;
	private readonly sessionStartedAt: string;
	private readonly sessionStartedAtMs: number;
	private lastSample: InactivitySample | null = null;
	private lastSampleIdentity: string | null = null;
	private lastGainSample: InactivitySample | null = null;
	private firstQuietSample: InactivitySample | null = null;
	private quietLimited = false;
	private proposal: InactivityStopProposal | null = null;

	constructor(options: { thresholdMs: number; sessionStartedAt: string }) {
		if (!Number.isSafeInteger(options.thresholdMs) || options.thresholdMs <= 0) {
			throw new TypeError('Inactivity threshold must be a positive safe integer.');
		}
		const startedAtMs = canonicalInstant(options.sessionStartedAt);
		if (startedAtMs === null) throw new TypeError('Session start timestamp is invalid.');
		this.thresholdMs = options.thresholdMs;
		this.sessionStartedAt = options.sessionStartedAt;
		this.sessionStartedAtMs = startedAtMs;
	}

	getProposal(): InactivityStopProposal | null {
		return this.proposal ? structuredClone(this.proposal) : null;
	}

	observe(value: unknown): InactivityObservation {
		if (this.proposal) return { status: 'duplicate', proposal: this.getProposal() };
		const sample = parseSample(value);
		if (!sample || Date.parse(sample.window.from) < this.sessionStartedAtMs ||
			!Number.isSafeInteger(Date.parse(sample.window.to) - this.sessionStartedAtMs)) {
			this.resetEvidence();
			return { status: 'invalid_sample', proposal: null };
		}
		const identity = JSON.stringify(sample);
		if (identity === this.lastSampleIdentity) {
			return { status: 'duplicate', proposal: null };
		}

		const contiguous = this.lastSample === null ||
			(this.lastSample.accountId === sample.accountId &&
				this.lastSample.afterSnapshotId === sample.beforeSnapshotId &&
				Date.parse(this.lastSample.window.to) <= Date.parse(sample.window.from));
		if (!contiguous) this.resetEvidence();
		this.lastSample = sample;
		this.lastSampleIdentity = identity;

		if (sample.relevantGainQuantity > 0) {
			this.lastGainSample = sample;
			this.firstQuietSample = null;
			this.quietLimited = sample.evidenceQuality === 'limited';
			return { status: 'activity', proposal: null };
		}

		if (!this.firstQuietSample) {
			this.firstQuietSample = sample;
			this.quietLimited = this.quietLimited || sample.evidenceQuality === 'limited';
		} else if (sample.evidenceQuality === 'limited') {
			this.quietLimited = true;
		}
		const quietDurationMs = Date.parse(sample.window.to) - Date.parse(this.firstQuietSample.window.from);
		if (!Number.isSafeInteger(quietDurationMs) || quietDurationMs < this.thresholdMs) {
			return {
				status: 'quiet',
				quietDurationMs,
				remainingMs: Math.max(0, this.thresholdMs - quietDurationMs),
				proposal: null,
			};
		}

		const proposal = this.buildProposal(sample, quietDurationMs);
		this.proposal = proposal;
		return { status: 'proposed', proposal: structuredClone(proposal) };
	}

	reset(): void {
		this.resetEvidence();
		this.proposal = null;
	}

	private buildProposal(sample: InactivitySample, quietDurationMs: number): InactivityStopProposal {
		const firstQuiet = this.firstQuietSample as InactivitySample;
		const possibleFrom = this.lastGainSample?.window.from ?? this.sessionStartedAt;
		const possibleTo = firstQuiet.window.to;
		return {
			version: INACTIVITY_STOP_PROPOSAL_VERSION,
			proposalId: `inactivity-stop:${sample.accountId}:${firstQuiet.beforeSnapshotId}:${sample.afterSnapshotId}`,
			accountId: sample.accountId,
			thresholdMs: this.thresholdMs,
			possibleStop: {
				from: possibleFrom,
				to: possibleTo,
				uncertaintyMs: Date.parse(possibleTo) - Date.parse(possibleFrom),
			},
			quietSince: firstQuiet.window.from,
			quietDurationMs,
			detectedAt: sample.window.to,
			evidenceQuality: this.quietLimited ? 'limited' : 'complete',
			lastGainSample: this.lastGainSample ? structuredClone(this.lastGainSample) : null,
			firstQuietSample: structuredClone(firstQuiet),
			confirmationSample: structuredClone(sample),
		};
	}

	private resetEvidence(): void {
		this.lastSample = null;
		this.lastSampleIdentity = null;
		this.lastGainSample = null;
		this.firstQuietSample = null;
		this.quietLimited = false;
	}
}

function parseSample(value: unknown): InactivitySample | null {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'accountId', 'beforeSnapshotId', 'afterSnapshotId', 'window',
		'relevantGainQuantity', 'evidenceQuality',
	])) return null;
	if (
		!nonEmptyString(value.accountId) ||
		!nonEmptyString(value.beforeSnapshotId) ||
		!nonEmptyString(value.afterSnapshotId) ||
		value.beforeSnapshotId === value.afterSnapshotId ||
		!validWindow(value.window) ||
		!isNonNegativeSafeInteger(value.relevantGainQuantity) ||
		(value.evidenceQuality !== 'complete' && value.evidenceQuality !== 'limited')
	) return null;
	return {
		accountId: value.accountId,
		beforeSnapshotId: value.beforeSnapshotId,
		afterSnapshotId: value.afterSnapshotId,
		window: value.window,
		relevantGainQuantity: value.relevantGainQuantity,
		evidenceQuality: value.evidenceQuality,
	};
}

function validWindow(value: unknown): value is { from: string; to: string } {
	if (!isRecord(value) || !hasOnlyKeys(value, ['from', 'to']) ||
		typeof value.from !== 'string' || typeof value.to !== 'string') return false;
	const from = canonicalInstant(value.from);
	const to = canonicalInstant(value.to);
	return from !== null && to !== null && from < to && Number.isSafeInteger(to - from);
}

function canonicalInstant(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}
