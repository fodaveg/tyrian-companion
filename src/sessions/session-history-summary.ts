import { canonicalJson } from '../core/canonical-sha256';
import type { DurableSessionHistoryRecord, DurableSessionLootLine, SessionHistoryScan } from './session-history';

/** Result exposed to the UI after one explicit load request. */
export type SessionHistoryLoadResult = SessionHistoryScan | { status: 'unavailable' };

/**
 * How a load reaches the notes: `index` reuses what was already inspected (the view's own loads),
 * `rebuild` reads every note again (the explicit refresh). See `SessionHistoryScanSource`.
 */
export type SessionHistoryLoadSource = 'index' | 'rebuild';

/** Two sessions are the smallest honest personal baseline; one observation is not a comparison. */
export const SESSION_HISTORY_PERFORMANCE_MINIMUM = 2 as const;

/** Conservative totals plus an identity-free chronological ledger. */
export interface SessionHistoryAggregate {
	readonly sessionCount: number;
	readonly totalDurationMs: number | null;
	readonly totalSacks: number | null;
	readonly sacksKnown: number;
	/** Sum over only the sessions that have a value, regardless of `totalSacks` (H18.10): a
	 *  single missing session used to withhold this number too, so the panel had nothing honest
	 *  left to show but the count. */
	readonly sacksKnownSubtotal: number | null;
	readonly totalImmediateCopper: number | null;
	readonly immediateValueKnown: number;
	readonly immediateValueKnownSubtotal: number | null;
	readonly totalListingCopper: number | null;
	readonly listingValueKnown: number;
	readonly listingValueKnownSubtotal: number | null;
	readonly comparison: SessionHistoryComparison | null;
	readonly performance: SessionHistoryPerformance;
	readonly sessions: readonly SessionHistorySummaryRow[];
}

export interface SessionHistoryPerformance {
	readonly minimumSessions: typeof SESSION_HISTORY_PERFORMANCE_MINIMUM;
	readonly missingContextSessions: number;
	/** Neither a comparable `exact` nor a comparable `estimated` session (in practice: a
	 *  `contaminated` one, whose metrics are already withheld at the source): it cannot join any
	 *  quality bucket at all, so this is where its exclusion stays visible instead of vanishing. */
	readonly qualityExcludedSessions: number;
	/** Sessions the player abandoned (schema 6): nothing was measured, so they never join a group. */
	readonly abandonedSessions: number;
	readonly groups: readonly SessionHistoryPerformanceGroup[];
}

/**
 * `general` covers every session outside the Halloween Labyrinth (a manual farm, or the rest of
 * the year): H18.10 stopped treating "no declared event" as "cannot be compared" and gave it its
 * own bucket instead, so a build's normal-year rate has somewhere to live next to its Halloween one.
 */
export type SessionHistoryPerformanceActivity = 'halloween' | 'general';

/**
 * `exact` is `classification: 'exact'` at `confidence: 'high'`; `estimated` is any
 * `classification: 'estimated'` session, regardless of its `medium`/`low` confidence tier — both
 * still rest on the same cache-blurred window, never on a second-accurate one. A Labyrinth session
 * (sacks, keys) is routinely `estimated`, so H18.10 gives it its own comparable bucket instead of
 * excluding it from a comparison that used to require `exact`/`high` and stayed empty in practice.
 */
export type SessionHistoryPerformanceQuality = 'exact' | 'estimated';

export interface SessionHistoryPerformanceGroup {
	readonly activity: SessionHistoryPerformanceActivity;
	readonly build: string;
	readonly buildRef: string | null;
	readonly presenceScope: 'pure_labyrinth' | 'mixed' | 'unknown';
	readonly groupContext: 'with_bosses' | 'without_bosses' | null;
	readonly magicFind: { readonly observable: number | null; readonly manual: number | null; readonly unobservedBuffs: true };
	readonly sackBasis: 'observed_gains' | 'closing_net';
	readonly sacksMetric: SessionHistoryMetricSample;
	readonly goldMetric: SessionHistoryMetricSample;
	readonly quality: SessionHistoryPerformanceQuality;
	readonly sessionCount: number;
	readonly eligibleSessions: number;
	readonly status: 'ready' | 'insufficient_sample' | 'unavailable';
	readonly sacksPerHourMilli: number | null;
	readonly immediateCopperPerHour: number | null;
	readonly exclusions: readonly SessionHistoryPerformanceExclusion[];
}

/** Duration-weighted rate and the range of individual observations, never a causal ranking. */
export interface SessionHistoryMetricSample {
	readonly eligibleSessions: number;
	readonly durationMs: number | null;
	readonly status: 'ready' | 'insufficient_sample' | 'unavailable';
	readonly rate: number | null;
	readonly minimumRate: number | null;
	readonly maximumRate: number | null;
}

export type SessionHistoryPerformanceExclusion = 'valuation' | 'metrics';

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
	/** Already-rendered gains lines the note itself wrote; empty when its results table couldn't
	 *  be read back. No identity travels with a line: only a name, a quantity, and its label. */
	readonly lootRows: readonly DurableSessionLootLine[];
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
	// An abandoned session stays in the ledger, but it has no loot to add and no duration of farming
	// to bill: counting it would turn every total into "unknown" and every rate into a lie.
	const measured = sessions.filter((session) => session.outcome !== 'abandoned').map(summaryRow).sort(compareNewestFirst);
	const sacks = completeSum(measured.map((row) => row.sacks));
	const immediate = completeSum(measured.map((row) => row.immediateCopper));
	const listing = completeSum(measured.map((row) => row.listingCopper));
	return {
		sessionCount: rows.length,
		totalDurationMs: safeSum(measured.map((row) => row.durationMs)),
		totalSacks: sacks.value,
		sacksKnown: sacks.known,
		sacksKnownSubtotal: sacks.knownSubtotal,
		totalImmediateCopper: immediate.value,
		immediateValueKnown: immediate.known,
		immediateValueKnownSubtotal: immediate.knownSubtotal,
		totalListingCopper: listing.value,
		listingValueKnown: listing.known,
		listingValueKnownSubtotal: listing.knownSubtotal,
		comparison: compareLatest(measured),
		performance: buildPerformance(sessions),
		sessions: rows,
	};
}

/** Captured configuration, evidence of buffs and map scope keep unlike observations apart. */
function buildPerformance(sessions: readonly DurableSessionHistoryRecord[]): SessionHistoryPerformance {
	const grouped = new Map<string, { dimensions: PerformanceDimensions; sessions: DurableSessionHistoryRecord[] }>();
	let missingContextSessions = 0;
	let qualityExcludedSessions = 0;
	let abandonedSessions = 0;
	for (const session of sessions) {
		if (session.outcome === 'abandoned') { abandonedSessions += 1; continue; }
		const quality = qualityBucket(session);
		if (quality === null) { qualityExcludedSessions += 1; continue; }
		const metadata = session.comparisonMetadata;
		const build = session.build?.trim() || '';
		if (!metadata && !build) missingContextSessions += 1;
		const dimensions: PerformanceDimensions = {
			activity: session.activity === 'halloween' ? 'halloween' : 'general', build,
			buildRef: metadata?.buildRef ?? null, quality,
			presenceScope: metadata?.presence?.scope ?? 'unknown', groupContext: metadata?.groupContext ?? null,
			magicFind: metadata?.magicFind ?? { observable: null, manual: null, unobservedBuffs: true },
			sackBasis: session.sackObservation?.observedGains != null ? 'observed_gains' : 'closing_net',
		};
		// The name is a label, never part of a known configuration's identity. Old notes retain a
		// labelled unknown-identity bucket rather than lose their basic metrics.
		const key = canonicalJson({ ...dimensions, build: dimensions.buildRef === null ? build : null });
		const group = grouped.get(key) ?? { dimensions, sessions: [] };
		group.sessions.push(session);
		grouped.set(key, group);
	}
	return {
		minimumSessions: SESSION_HISTORY_PERFORMANCE_MINIMUM, missingContextSessions, qualityExcludedSessions, abandonedSessions,
		groups: [...grouped.values()].map(performanceGroup).sort((a, b) =>
			a.activity.localeCompare(b.activity) || a.build.localeCompare(b.build) || a.quality.localeCompare(b.quality)),
	};
}

type PerformanceDimensions = Pick<SessionHistoryPerformanceGroup,
	'activity' | 'build' | 'buildRef' | 'quality' | 'presenceScope' | 'groupContext' | 'magicFind' | 'sackBasis'>;

function qualityBucket(session: DurableSessionHistoryRecord): SessionHistoryPerformanceQuality | null {
	if (session.classification === 'exact' && session.confidence === 'high') return 'exact';
	if (session.classification === 'estimated') return 'estimated';
	return null;
}

function performanceGroup(group: {
	readonly dimensions: PerformanceDimensions;
	readonly sessions: readonly DurableSessionHistoryRecord[];
}): SessionHistoryPerformanceGroup {
	const sacksValue = (session: DurableSessionHistoryRecord): number | null =>
		session.sackObservation?.observedGains ?? (session.sackObservation?.netRetained != null
			? Math.max(0, session.sackObservation.netRetained) : session.sacks);
	const sacksEligible = group.sessions.filter((session) => usableDuration(session) && sacksValue(session) !== null);
	const goldEligible = group.sessions.filter((session) => usableDuration(session) &&
		session.valuationCoverage === 'complete' && session.observedImmediateCopper !== null);
	const sacksMetric = metricSample(sacksEligible, (session) => sacksValue(session) as number, 3_600_000_000n);
	const goldMetric = metricSample(goldEligible, (session) => session.observedImmediateCopper as number, 3_600_000n);
	const exclusions: SessionHistoryPerformanceExclusion[] = [];
	if (goldEligible.length < group.sessions.length) exclusions.push('valuation');
	if (sacksEligible.length < group.sessions.length) exclusions.push('metrics');
	return {
		...group.dimensions, sessionCount: group.sessions.length,
		// Kept for old consumers; new presentation always uses each metric's own evidence.
		eligibleSessions: Math.max(sacksEligible.length, goldEligible.length),
		status: sacksMetric.status === 'unavailable' || goldMetric.status === 'unavailable' ? 'unavailable'
			: sacksMetric.status === 'ready' || goldMetric.status === 'ready' ? 'ready' : 'insufficient_sample',
		sacksPerHourMilli: sacksMetric.rate, immediateCopperPerHour: goldMetric.rate, sacksMetric, goldMetric, exclusions,
	};
}

function usableDuration(session: DurableSessionHistoryRecord): boolean {
	return Number.isSafeInteger(session.durationMs) && session.durationMs > 0;
}

/** Each rate divides only by the time of the sessions eligible for that particular metric. */
function metricSample(sessions: readonly DurableSessionHistoryRecord[], value: (session: DurableSessionHistoryRecord) => number,
	scale: bigint): SessionHistoryMetricSample {
	const duration = sumBigInt(sessions.map((session) => session.durationMs));
	const durationMs = duration <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(duration) : null;
	if (sessions.length < SESSION_HISTORY_PERFORMANCE_MINIMUM) return {
		eligibleSessions: sessions.length, durationMs, status: 'insufficient_sample', rate: null, minimumRate: null, maximumRate: null,
	};
	const rate = safeRoundedRate(sumBigInt(sessions.map(value)), duration, scale);
	const individual = sessions.map((session) => safeRoundedRate(BigInt(value(session)), BigInt(session.durationMs), scale));
	const complete = individual.every((item): item is number => item !== null);
	return { eligibleSessions: sessions.length, durationMs, status: rate === null ? 'unavailable' : 'ready', rate,
		minimumRate: complete ? individual.reduce((lowest, item) => Math.min(lowest, item), Infinity) : null, maximumRate: complete ? individual.reduce((highest, item) => Math.max(highest, item), -Infinity) : null };
}

function sumBigInt(values: readonly number[]): bigint {
	return values.reduce((total, value) => total + BigInt(value), 0n);
}

function safeRoundedRate(total: bigint, durationMs: bigint, scale: bigint): number | null {
	if (durationMs <= 0n) return null;
	const scaled = total * scale;
	let rounded = scaled / durationMs;
	const remainder = scaled % durationMs;
	// Match session valuation's Math.round, including negative nets and ties toward +infinity.
	if (remainder * 2n >= durationMs) rounded += 1n;
	else if (remainder * 2n < -durationMs) rounded -= 1n;
	return rounded >= BigInt(Number.MIN_SAFE_INTEGER) && rounded <= BigInt(Number.MAX_SAFE_INTEGER)
		? Number(rounded) : null;
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
		lootRows: session.lootRows,
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

/**
 * `value` keeps withholding the aggregate the moment a single session lacks the figure (never
 * treating the gap as zero); `knownSubtotal` is new (H18.10) and answers a narrower, always
 * honest question: what do the sessions that DO have a value add up to. The panel shows that
 * subtotal next to how many are missing instead of hiding every session's total the instant one
 * of them can't be valued.
 */
function completeSum(values: readonly (number | null)[]): { value: number | null; known: number; knownSubtotal: number | null } {
	const knownValues = values.filter((value): value is number => value !== null);
	const knownSubtotal = knownValues.length > 0 ? safeSum(knownValues) : null;
	return {
		value: knownValues.length === values.length && values.length > 0 ? knownSubtotal : null,
		known: knownValues.length,
		knownSubtotal,
	};
}

function safeSum(values: readonly number[]): number | null {
	// Signed nets can cross a safe bound temporarily and still cancel to an exact safe total.
	const total = sumBigInt(values);
	return total >= BigInt(Number.MIN_SAFE_INTEGER) && total <= BigInt(Number.MAX_SAFE_INTEGER)
		? Number(total) : null;
}
