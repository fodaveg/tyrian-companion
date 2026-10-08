/** A single optional target, copied into the session when it starts. */
export type FarmingGoalV1 =
	| { version: 1; kind: 'none' }
	| { version: 1; kind: 'bags'; targetBags: number }
	| { version: 1; kind: 'duration'; targetDurationMs: number };

export const DEFAULT_FARMING_GOAL: Readonly<FarmingGoalV1> = Object.freeze({ version: 1, kind: 'none' });
export const DEFAULT_FARMING_TARGET_BAGS = 1_000;
export const DEFAULT_FARMING_TARGET_DURATION_MS = 60 * 60_000;
/** Three API boundaries over twenty minutes avoid estimating from one cache interval. */
export const FARMING_GOAL_MIN_SAMPLES = 3;
export const FARMING_GOAL_MIN_WINDOW_MS = 20 * 60_000;
export const FARMING_GOAL_MAX_OBSERVATION_AGE_MS = 15 * 60_000;
const MAX_TARGET_BAGS = 1_000_000_000;
const MAX_TARGET_DURATION_MS = 7 * 24 * 60 * 60_000;

export interface FarmingGoalObservation {
	startedAt: string;
	now: string;
	/** Null until a usable observation exists; zero is an observed zero. Never a final net delta. */
	observedBags: number | null;
	observedFrom: string | null;
	observedAt: string | null;
	/** Count of successful, distinct storage boundaries, including the baseline. */
	sampleCount: number;
	/** End time freezes a duration target; a later view never makes a short session reach it. */
	endedAt?: string | null;
	finalNetBags?: number | null;
	maxObservationAgeMs?: number;
}

export type FarmingGoalEtaUnavailableReason =
	| 'no_observation' | 'insufficient_sample' | 'stale_observation' | 'invalid_observation' | 'no_rate';

/** JSON-safe evidence shared by the session panel, note and addon projection. */
export interface FarmingGoalProgress {
	goal: FarmingGoalV1;
	status: 'none' | 'in_progress' | 'reached' | 'unavailable';
	observedBags: number | null;
	finalNetBags: number | null;
	/** Acquiring and opening between polls can leave no observable gain at all. */
	totalObtained: 'unobservable';
	elapsedMs: number | null;
	progressRatio: number | null;
	remainingMs: number | null;
	remainingKind: 'countdown' | 'estimate' | null;
	etaUnavailableReason: FarmingGoalEtaUnavailableReason | null;
	observedAt: string | null;
}

/** Validates persisted targets without converting missing or malformed data into a target. */
export function isFarmingGoal(value: unknown): value is FarmingGoalV1 {
	if (!isRecord(value) || value.version !== 1) return false;
	if (value.kind === 'none') return Object.keys(value).length === 2;
	if (value.kind === 'bags') return Object.keys(value).length === 3 && positiveInteger(value.targetBags, MAX_TARGET_BAGS);
	return value.kind === 'duration' && Object.keys(value).length === 3
		&& positiveInteger(value.targetDurationMs, MAX_TARGET_DURATION_MS);
}

/** Returns a detached canonical target so default changes cannot rewrite an active session. */
export function normalizeFarmingGoal(value: unknown): FarmingGoalV1 {
	if (!isFarmingGoal(value)) return { version: 1, kind: 'none' };
	return { ...value };
}

/**
 * Where the observed window starts: the last observation minus the covered item time. That time is summed on the
 * addon's clock while `startedAt` and the observation are the host's, so over a long session a slightly faster addon
 * clock puts the result before the start. It is bounded to `startedAt` (a marginally shorter window) instead of
 * invalidating the estimate.
 */
export function liveObservedFrom(startedAt: string, lastObservationAt: string | null, observedItemsMs: number): string | null {
	if (lastObservationAt === null) return null;
	const at = Date.parse(lastObservationAt); const started = Date.parse(startedAt);
	if (!Number.isFinite(at) || !Number.isFinite(started)) return null;
	return new Date(Math.max(started, at - observedItemsMs)).toISOString();
}

/** Projects progress without prices, gameplay operations or assumptions about unobserved loot. */
export function projectFarmingGoal(goal: FarmingGoalV1, input: FarmingGoalObservation): FarmingGoalProgress {
	const started = timestamp(input.startedAt);
	const now = timestamp(input.now);
	const end = input.endedAt == null ? now : timestamp(input.endedAt);
	const elapsedMs = started !== null && now !== null && end !== null && end >= started && end <= now
		? end - started : null;
	const observedBags = nonNegativeInteger(input.observedBags) ? input.observedBags : null;
	const finalNetBags = Number.isSafeInteger(input.finalNetBags) ? input.finalNetBags ?? null : null;
	const result: FarmingGoalProgress = {
		goal: normalizeFarmingGoal(goal), status: 'none', observedBags, finalNetBags,
		totalObtained: 'unobservable', elapsedMs, progressRatio: null, remainingMs: null,
		remainingKind: null, etaUnavailableReason: null,
		observedAt: timestamp(input.observedAt) === null ? null : input.observedAt,
	};
	if (result.goal.kind === 'none') return result;
	if (elapsedMs === null) return { ...result, status: 'unavailable', etaUnavailableReason: 'invalid_observation' };
	if (result.goal.kind === 'duration') {
		return {
			...result, status: elapsedMs >= result.goal.targetDurationMs ? 'reached' : 'in_progress',
			progressRatio: Math.min(1, elapsedMs / result.goal.targetDurationMs),
			remainingMs: Math.max(0, result.goal.targetDurationMs - elapsedMs), remainingKind: 'countdown',
		};
	}
	if (observedBags === null) return { ...result, status: 'unavailable', etaUnavailableReason: 'no_observation' };
	result.progressRatio = Math.min(1, observedBags / result.goal.targetBags);
	result.status = observedBags >= result.goal.targetBags ? 'reached' : 'in_progress';
	// Reaching a target is evidence about observed increments, never total obtained.
	if (result.status === 'reached') return result;
	const from = timestamp(input.observedFrom);
	const at = timestamp(input.observedAt);
	const maxAge = input.maxObservationAgeMs ?? FARMING_GOAL_MAX_OBSERVATION_AGE_MS;
	if (from === null || at === null) return { ...result, etaUnavailableReason: 'no_observation' };
	if (started === null || now === null || end === null || from < started || at < from || at > end
		|| !positiveInteger(maxAge, Number.MAX_SAFE_INTEGER)
		|| !nonNegativeInteger(input.sampleCount)) {
		return { ...result, etaUnavailableReason: 'invalid_observation' };
	}
	if (now - at > maxAge) return { ...result, etaUnavailableReason: 'stale_observation' };
	const windowMs = at - from;
	if (input.sampleCount < FARMING_GOAL_MIN_SAMPLES || windowMs < FARMING_GOAL_MIN_WINDOW_MS) {
		return { ...result, etaUnavailableReason: 'insufficient_sample' };
	}
	if (observedBags === 0) return { ...result, etaUnavailableReason: 'no_rate' };
	const remainingMs = Math.ceil((result.goal.targetBags - observedBags) * windowMs / observedBags);
	if (!Number.isSafeInteger(remainingMs)) return { ...result, etaUnavailableReason: 'invalid_observation' };
	return { ...result, remainingMs, remainingKind: 'estimate' };
}

/** Defensive note reader: reject absent/invalid numbers instead of treating them as zero. */
export function isFarmingGoalProgress(value: unknown): value is FarmingGoalProgress {
	if (!isRecord(value) || !isFarmingGoal(value.goal) || value.totalObtained !== 'unobservable') return false;
	return ['none', 'in_progress', 'reached', 'unavailable'].includes(String(value.status))
		&& (value.observedBags === null || nonNegativeInteger(value.observedBags))
		&& (value.finalNetBags === null || Number.isSafeInteger(value.finalNetBags))
		&& (value.elapsedMs === null || nonNegativeInteger(value.elapsedMs))
		&& (value.remainingMs === null || nonNegativeInteger(value.remainingMs))
		&& (value.progressRatio === null || typeof value.progressRatio === 'number'
			&& Number.isFinite(value.progressRatio) && value.progressRatio >= 0 && value.progressRatio <= 1)
		&& (value.remainingKind === null || value.remainingKind === 'estimate' || value.remainingKind === 'countdown')
		&& (value.etaUnavailableReason === null || typeof value.etaUnavailableReason === 'string'
			&& ['no_observation', 'insufficient_sample', 'stale_observation',
				'invalid_observation', 'no_rate'].includes(value.etaUnavailableReason))
		&& (value.observedAt === null || timestamp(value.observedAt) !== null)
		&& (value.goal.kind !== 'duration' || value.remainingKind !== 'estimate')
		&& (value.goal.kind !== 'bags' || value.remainingKind !== 'countdown');
}

function timestamp(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function positiveInteger(value: unknown, maximum: number): value is number {
	return nonNegativeInteger(value) && value > 0 && value <= maximum;
}
function nonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
