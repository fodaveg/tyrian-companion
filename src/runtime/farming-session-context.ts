import { isFarmingGoal, normalizeFarmingGoal, type FarmingGoalV1 } from '../sessions/farming-goal';

export type FarmingGroupContext = 'with_bosses' | 'without_bosses' | null;

/** Local captured intent; changing next-session settings never rewrites it. */
export interface FarmingSessionContext {
	version: 1;
	sessionId: string;
	goal: FarmingGoalV1;
	groupContext: FarmingGroupContext;
	observedFrom: string;
	observedAt: string;
	sampleCount: number;
}

/** Strict reload boundary. Corrupt or older context cannot manufacture progress or an ETA. */
export function readFarmingSessionContext(value: unknown): FarmingSessionContext | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 7 || record.version !== 1 || typeof record.sessionId !== 'string'
		|| record.sessionId.length === 0 || !isFarmingGoal(record.goal)
		|| (record.groupContext !== null && record.groupContext !== 'with_bosses' && record.groupContext !== 'without_bosses')
		|| typeof record.observedFrom !== 'string' || typeof record.observedAt !== 'string'
		|| !Number.isFinite(Date.parse(record.observedFrom)) || !Number.isFinite(Date.parse(record.observedAt))
		|| Date.parse(record.observedAt) < Date.parse(record.observedFrom)
		|| typeof record.sampleCount !== 'number' || !Number.isSafeInteger(record.sampleCount) || record.sampleCount < 1) return null;
	return {
		version: 1, sessionId: record.sessionId, goal: normalizeFarmingGoal(record.goal),
		groupContext: record.groupContext, observedFrom: record.observedFrom,
		observedAt: record.observedAt, sampleCount: record.sampleCount,
	};
}

/** Counts only a distinct successful API boundary; a display tick cannot refresh its age. */
export function observeFarmingSessionContext(context: FarmingSessionContext, at: string | null): FarmingSessionContext {
	if (at === null || !Number.isFinite(Date.parse(at)) || Date.parse(at) <= Date.parse(context.observedAt)) return context;
	return { ...context, observedAt: at, sampleCount: context.sampleCount + 1 };
}
