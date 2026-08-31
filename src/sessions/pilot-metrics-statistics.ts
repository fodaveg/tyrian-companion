import {
	DETECTION_CORRECTION_CAUSES,
	type DetectionCorrectionCause,
} from './session-detection-quality';
import type {
	PilotEnvironmentV1,
	PilotJournalHealth,
	PilotObservationV1,
	PilotPlatform,
	PilotProposalObservationV1,
} from './pilot-metrics-model';

export interface PilotRateMetricV1 {
	k: number;
	n: number;
	rate: number | null;
	wilson95: { low: number; high: number } | null;
	causes: Record<DetectionCorrectionCause, number>;
	reviews: number;
	decisions: number;
	expired: number;
	workflowFailed: number;
	coverage: number | null;
}

export interface PilotPrecisionMetricV1 {
	count: number;
	seconds: { median: number; p90: number; maximum: number } | null;
	intervalMultiples: { median: number; p90: number; maximum: number } | null;
}

export interface PilotAggregateV1 {
	version: 1;
	scope: { platform: PilotPlatform; versions: Omit<PilotEnvironmentV1, 'version' | 'platform'> | null };
	falseStart: PilotRateMetricV1;
	falseStop: PilotRateMetricV1;
	precision: PilotPrecisionMetricV1;
	recovery: { presented: number; succeeded: number; failed: number; discarded: number; rate: number | null };
	completedSessions: number;
	verdict: 'pass' | 'fail' | 'inconclusive';
	evidence: {
		journalHealth: PilotJournalHealth;
		silentLosses: 'none_observed' | 'unavailable_or_inconsistent';
		executedOperations: 0;
		operationsBasis: 'architectural_guard_no_executor';
	};
}

export interface PilotAggregationV1 {
	version: 1;
	method: 'h0.6-wilson95-nearest-rank-v1';
	platforms: PilotAggregateV1[];
	versionStrata: PilotAggregateV1[];
}

/** Aggregates only within a platform. Version combinations are diagnostic strata, never global verdicts. */
export function aggregatePilotMetrics(
	observations: readonly PilotObservationV1[],
	health: PilotJournalHealth,
): PilotAggregationV1 {
	const platforms = unique(observations.map((entry) => entry.environment.platform));
	const platformRows = platforms.map((platform) => aggregate(
		observations.filter((entry) => entry.environment.platform === platform), platform, null, health,
	));
	const strata = unique(observations.map((entry) => environmentKey(entry.environment)))
		.map((key) => {
			const selected = observations.filter((entry) => environmentKey(entry.environment) === key);
			const environment = selected[0]!.environment;
			return aggregate(selected, environment.platform, {
				platformVersion: environment.platformVersion,
				obsidianVersion: environment.obsidianVersion,
				tyrianVersion: environment.tyrianVersion,
			}, health);
		});
	return { version: 1, method: 'h0.6-wilson95-nearest-rank-v1', platforms: platformRows, versionStrata: strata };
}

export function wilson95(k: number, n: number): { low: number; high: number } | null {
	if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || k < 0 || n <= 0 || k > n) return null;
	const z = 1.959963984540054;
	const p = k / n;
	const denominator = 1 + z * z / n;
	const center = (p + z * z / (2 * n)) / denominator;
	const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
	return { low: center - half, high: center + half };
}

function aggregate(
	observations: readonly PilotObservationV1[],
	platform: PilotPlatform,
	versions: Omit<PilotEnvironmentV1, 'version' | 'platform'> | null,
	health: PilotJournalHealth,
): PilotAggregateV1 {
	const proposals = observations.filter((entry): entry is PilotProposalObservationV1 => entry.kind === 'proposal');
	const falseStart = rateMetric(proposals.filter((entry) => entry.phase === 'start'));
	const falseStop = rateMetric(proposals.filter((entry) => entry.phase === 'stop'));
	const precision = precisionMetric(proposals);
	const recoveries = observations.filter((entry) => entry.kind === 'recovery');
	const recovery = {
		presented: recoveries.length,
		succeeded: recoveries.filter((entry) => entry.terminal?.outcome === 'succeeded').length,
		failed: recoveries.filter((entry) => entry.terminal?.outcome === 'failed').length,
		discarded: recoveries.filter((entry) => entry.terminal?.outcome === 'discarded').length,
		rate: recoveries.length === 0 ? null : recoveries.filter((entry) => entry.terminal?.outcome === 'succeeded').length / recoveries.length,
	};
	const completedSessions = observations.filter((entry) => entry.kind === 'session' && entry.completedAt !== null).length;
	return {
		version: 1,
		scope: { platform, versions },
		falseStart,
		falseStop,
		precision,
		recovery,
		completedSessions,
		verdict: verdict(falseStart, falseStop, precision, recovery, completedSessions, health),
		evidence: {
			journalHealth: health,
			silentLosses: health === 'ready' ? 'none_observed' : 'unavailable_or_inconsistent',
			executedOperations: 0,
			operationsBasis: 'architectural_guard_no_executor',
		},
	};
}

function rateMetric(proposals: readonly PilotProposalObservationV1[]): PilotRateMetricV1 {
	const causes = Object.fromEntries(DETECTION_CORRECTION_CAUSES.map((cause) => [cause, 0])) as Record<DetectionCorrectionCause, number>;
	let k = 0;
	let n = 0;
	let decisions = 0;
	let expired = 0;
	let workflowFailed = 0;
	for (const proposal of proposals) {
		const terminal = proposal.terminal;
		if (!terminal) continue;
		if (terminal.status === 'expired') { expired += 1; continue; }
		decisions += 1;
		if (terminal.effectiveResult === 'accepted_workflow_failed') { workflowFailed += 1; continue; }
		if (terminal.effectiveResult === 'dismissed') {
			k += 1;
			if (terminal.correctionCause) causes[terminal.correctionCause] += 1;
		}
		if (terminal.effectiveResult === 'dismissed' || terminal.effectiveResult === 'accepted_workflow_succeeded') n += 1;
	}
	const reviews = decisions + expired;
	return {
		k, n, rate: n === 0 ? null : k / n, wilson95: wilson95(k, n), causes,
		reviews, decisions, expired, workflowFailed, coverage: reviews === 0 ? null : decisions / reviews,
	};
}

function precisionMetric(proposals: readonly PilotProposalObservationV1[]): PilotPrecisionMetricV1 {
	const rows = proposals.flatMap((proposal) => {
		const boundary = proposal.terminal?.humanBoundaryAt;
		if (!boundary) return [];
		const midpoint = (Date.parse(proposal.window.from) + Date.parse(proposal.window.to)) / 2;
		const seconds = Math.abs(Date.parse(boundary) - midpoint) / 1_000;
		return [{ seconds, intervalMultiples: seconds / (proposal.pollingIntervalMs / 1_000) }];
	});
	if (rows.length === 0) return { count: 0, seconds: null, intervalMultiples: null };
	return {
		count: rows.length,
		seconds: distribution(rows.map((row) => row.seconds)),
		intervalMultiples: distribution(rows.map((row) => row.intervalMultiples)),
	};
}

function distribution(values: readonly number[]): { median: number; p90: number; maximum: number } {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		median: nearestRank(sorted, 0.5),
		p90: nearestRank(sorted, 0.9),
		maximum: sorted.at(-1)!,
	};
}

function nearestRank(sorted: readonly number[], percentile: number): number {
	return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

function verdict(
	start: PilotRateMetricV1,
	stop: PilotRateMetricV1,
	precision: PilotPrecisionMetricV1,
	recovery: { presented: number; rate: number | null },
	completedSessions: number,
	health: PilotJournalHealth,
): 'pass' | 'fail' | 'inconclusive' {
	if (health !== 'ready') return 'inconclusive';
	const enough = start.n >= 20 && stop.n >= 20 && start.coverage !== null && stop.coverage !== null &&
		recovery.presented >= 20 && completedSessions >= 50 && precision.intervalMultiples !== null;
	if (!enough) return 'inconclusive';
	return start.rate! <= 0.1 && stop.rate! <= 0.1 && start.coverage! >= 0.9 && stop.coverage! >= 0.9 &&
		recovery.rate! >= 0.95 && precision.intervalMultiples!.median <= 1 && precision.intervalMultiples!.p90 <= 2
		? 'pass' : 'fail';
}

function environmentKey(environment: PilotEnvironmentV1): string {
	return [environment.platform, environment.platformVersion, environment.obsidianVersion, environment.tyrianVersion].join('\0');
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
}
