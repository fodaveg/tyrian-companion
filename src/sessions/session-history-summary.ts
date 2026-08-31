import type { DurableSessionHistoryRecord, SessionHistoryScan } from './session-history';

/** Result exposed to the UI after one explicit load request. */
export type SessionHistoryLoadResult = SessionHistoryScan | { status: 'unavailable' };

/** Two sessions are the smallest honest personal baseline; one observation is not a comparison. */
export const SESSION_HISTORY_PERFORMANCE_MINIMUM = 2 as const;

/** Conservative totals plus an identity-free chronological ledger. */
export interface SessionHistoryAggregate {
	readonly sessionCount: number;
	readonly totalDurationMs: number | null;
	readonly totalSacks: number | null;
	readonly sacksKnown: number;
	readonly totalImmediateCopper: number | null;
	readonly immediateValueKnown: number;
	readonly totalListingCopper: number | null;
	readonly listingValueKnown: number;
	readonly comparison: SessionHistoryComparison | null;
	readonly performance: SessionHistoryPerformance;
	readonly sessions: readonly SessionHistorySummaryRow[];
}

export interface SessionHistoryPerformance {
	readonly minimumSessions: typeof SESSION_HISTORY_PERFORMANCE_MINIMUM;
	readonly missingContextSessions: number;
	readonly groups: readonly SessionHistoryPerformanceGroup[];
}

export interface SessionHistoryPerformanceGroup {
	readonly activity: 'halloween';
	readonly build: string;
	readonly sessionCount: number;
	readonly eligibleSessions: number;
	readonly status: 'ready' | 'insufficient_sample' | 'unavailable';
	readonly sacksPerHourMilli: number | null;
	readonly immediateCopperPerHour: number | null;
	readonly exclusions: readonly SessionHistoryPerformanceExclusion[];
}

export type SessionHistoryPerformanceExclusion = 'quality' | 'valuation' | 'metrics';

/** Visible durable facts for one completed session; hashed identity is intentionally absent. */
export interface SessionHistorySummaryRow {
	readonly startedAt: string;
	readonly endedAt: string;
	readonly durationMs: number;
	readonly classification: string;
	readonly confidence: string;
	readonly sacks: number | null;
	readonly sacksPerHourMilli: number | null;
	readonly immediateCopper: number | null;
	readonly listingCopper: number | null;
	readonly immediateCopperPerHour: number | null;
	readonly listingCopperPerHour: number | null;
}

/** Arithmetic delta between the latest two validated sessions. */
export interface SessionHistoryComparison {
	readonly latestEndedAt: string;
	readonly previousEndedAt: string;
	readonly durationDeltaMs: number;
	readonly sacksPerHourMilliDelta: number | null;
	readonly immediateCopperPerHourDelta: number | null;
	readonly listingCopperPerHourDelta: number | null;
}

/** Builds an identity-free, newest-first projection from validated durable session notes. */
export function buildSessionHistoryAggregate(
	sessions: readonly DurableSessionHistoryRecord[],
): SessionHistoryAggregate {
	const rows = sessions.map(summaryRow).sort(compareNewestFirst);
	const sacks = completeSum(rows.map((row) => row.sacks));
	const immediate = completeSum(rows.map((row) => row.immediateCopper));
	const listing = completeSum(rows.map((row) => row.listingCopper));
	return {
		sessionCount: rows.length,
		totalDurationMs: safeSum(rows.map((row) => row.durationMs)),
		totalSacks: sacks.value,
		sacksKnown: sacks.known,
		totalImmediateCopper: immediate.value,
		immediateValueKnown: immediate.known,
		totalListingCopper: listing.value,
		listingValueKnown: listing.known,
		comparison: compareLatest(rows),
		performance: buildPerformance(sessions),
		sessions: rows,
	};
}

function buildPerformance(sessions: readonly DurableSessionHistoryRecord[]): SessionHistoryPerformance {
	const grouped = new Map<string, { activity: 'halloween'; build: string; sessions: DurableSessionHistoryRecord[] }>();
	let missingContextSessions = 0;
	for (const session of sessions) {
		const build = normalizeBuild(session.build);
		if (session.activity !== 'halloween' || build === null) {
			missingContextSessions += 1;
			continue;
		}
		const key = `${session.activity}\u0000${build}`;
		const group = grouped.get(key) ?? { activity: session.activity, build, sessions: [] };
		group.sessions.push(session);
		grouped.set(key, group);
	}
	return {
		minimumSessions: SESSION_HISTORY_PERFORMANCE_MINIMUM,
		missingContextSessions,
		groups: [...grouped.values()].map(performanceGroup).sort((left, right) =>
			left.activity.localeCompare(right.activity) || left.build.localeCompare(right.build)),
	};
}

function performanceGroup(group: {
	readonly activity: 'halloween';
	readonly build: string;
	readonly sessions: readonly DurableSessionHistoryRecord[];
}): SessionHistoryPerformanceGroup {
	const exclusions = new Set<SessionHistoryPerformanceExclusion>();
	const eligible = group.sessions.filter((session) => {
		let accepted = true;
		if (session.classification !== 'exact' || session.confidence !== 'high') {
			exclusions.add('quality');
			accepted = false;
		}
		if (session.valuationCoverage !== 'complete') {
			exclusions.add('valuation');
			accepted = false;
		}
		if (session.sacks === null || session.observedImmediateCopper === null) {
			exclusions.add('metrics');
			accepted = false;
		}
		return accepted;
	});
	if (eligible.length < SESSION_HISTORY_PERFORMANCE_MINIMUM) {
		return {
			activity: group.activity, build: group.build, sessionCount: group.sessions.length,
			eligibleSessions: eligible.length, status: 'insufficient_sample', sacksPerHourMilli: null,
			immediateCopperPerHour: null, exclusions: [...exclusions],
		};
	}
	const durationMs = sumBigInt(eligible.map((session) => session.durationMs));
	const sacks = sumBigInt(eligible.map((session) => session.sacks as number));
	const immediateCopper = sumBigInt(eligible.map((session) => session.observedImmediateCopper as number));
	const sacksPerHourMilli = safeRoundedRate(sacks, durationMs, 3_600_000_000n);
	const immediateCopperPerHour = safeRoundedRate(immediateCopper, durationMs, 3_600_000n);
	return {
		activity: group.activity, build: group.build, sessionCount: group.sessions.length,
		eligibleSessions: eligible.length,
		status: sacksPerHourMilli === null || immediateCopperPerHour === null ? 'unavailable' : 'ready',
		sacksPerHourMilli, immediateCopperPerHour, exclusions: [...exclusions],
	};
}

function normalizeBuild(build: string | null): string | null {
	if (build === null) return null;
	const normalized = build.trim();
	return normalized.length === 0 ? null : normalized;
}

function sumBigInt(values: readonly number[]): bigint {
	return values.reduce((total, value) => total + BigInt(value), 0n);
}

function safeRoundedRate(total: bigint, durationMs: bigint, scale: bigint): number | null {
	if (durationMs <= 0n) return null;
	const rounded = (total * scale + durationMs / 2n) / durationMs;
	return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}

function summaryRow(session: DurableSessionHistoryRecord): SessionHistorySummaryRow {
	return {
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		durationMs: session.durationMs,
		classification: session.classification,
		confidence: session.confidence,
		sacks: session.sacks,
		sacksPerHourMilli: session.sacksPerHourMilli,
		immediateCopper: session.observedImmediateCopper,
		listingCopper: session.observedListingCopper,
		immediateCopperPerHour: session.immediateCopperPerHour,
		listingCopperPerHour: session.listingCopperPerHour,
	};
}

function compareNewestFirst(left: SessionHistorySummaryRow, right: SessionHistorySummaryRow): number {
	return right.endedAt.localeCompare(left.endedAt) || right.startedAt.localeCompare(left.startedAt);
}

function compareLatest(rows: readonly SessionHistorySummaryRow[]): SessionHistoryComparison | null {
	const latest = rows[0];
	const previous = rows[1];
	if (latest === undefined || previous === undefined) return null;
	return {
		latestEndedAt: latest.endedAt,
		previousEndedAt: previous.endedAt,
		durationDeltaMs: latest.durationMs - previous.durationMs,
		sacksPerHourMilliDelta: difference(latest.sacksPerHourMilli, previous.sacksPerHourMilli),
		immediateCopperPerHourDelta: difference(latest.immediateCopperPerHour, previous.immediateCopperPerHour),
		listingCopperPerHourDelta: difference(latest.listingCopperPerHour, previous.listingCopperPerHour),
	};
}

function difference(latest: number | null, previous: number | null): number | null {
	if (latest === null || previous === null) return null;
	const delta = latest - previous;
	return Number.isSafeInteger(delta) ? delta : null;
}

function completeSum(values: readonly (number | null)[]): { value: number | null; known: number } {
	const knownValues = values.filter((value): value is number => value !== null);
	return {
		value: knownValues.length === values.length && values.length > 0 ? safeSum(knownValues) : null,
		known: knownValues.length,
	};
}

function safeSum(values: readonly number[]): number | null {
	let total = 0;
	for (const value of values) {
		total += value;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}
