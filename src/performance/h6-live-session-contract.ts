/**
 * Budgets for the long live-session case of the H6 benchmark: what runs every second of a real
 * Nexus session (commit, price enrichment, chart) plus the closing render and re-read of the note.
 * Pure data and checks; the fixture lives in `scripts/benchmark-h6-live-session.ts`.
 */
export interface H6LiveSessionWindowMetrics {
	medianMs: number;
	p95Ms: number;
	sampleCount: number;
}

export interface H6LiveSessionMetrics {
	/** Looted samples early in the session (journal still shorter than the chart cap). */
	start: H6LiveSessionWindowMetrics;
	/** Looted samples around the one-hour mark. */
	oneHour: H6LiveSessionWindowMetrics;
	/** Looted samples at the end of the long session. */
	end: H6LiveSessionWindowMetrics;
	/** `end.medianMs / start.medianMs`: what a quadratic cost shows up in, steadier than any absolute time. */
	endToStartMedianRatio: number;
	closeMs: number;
	noteBytes: number;
	noteReadable: boolean;
}

export interface H6LiveSessionBudget {
	maxEndMedianMs: number;
	maxEndP95Ms: number;
	maxEndToStartMedianRatio: number;
	maxCloseMs: number;
	maxNoteBytes: number;
}

export const H6_LIVE_SESSION_SAMPLES_ONE_HOUR = 3_600;
/** Ninety minutes at one sample per second: the shortest session that still separates linear from quadratic cost and fits the ~60 s case budget. */
export const H6_LIVE_SESSION_SAMPLES_LONG = 5_400;
export const H6_LIVE_SESSION_LOOT_PER_LOOTED_SAMPLE = 5;
/** One window is as long as the chart cap, so the early window sees a journal no longer than the chart. */
export const H6_LIVE_SESSION_WINDOW_SAMPLES = 600;

/**
 * Measured 8 oct 2026 on this fixture (Node 22, Linux, local): end-of-session median 15.9-17.9 ms,
 * p95 21-22 ms, end/start median ratio 1.18-1.31, close and note 1.2-1.4 s, note 13 059 235 B
 * (deterministic: same seed, same bytes). Times and the ratio carry at least 4x margin, since CI is
 * slower and noisier. They reject a collapse, not a small regression. The ratio is the sharp one: a
 * linear per-sample cost stays near 1, work proportional to the journal grows towards the
 * journal-length ratio (about 13x here), so it also holds on a slow runner. The note size is the
 * one deterministic figure, so its limit is tight (1.5x) instead of 4x.
 */
export const H6_LIVE_SESSION_BUDGET: Readonly<H6LiveSessionBudget> = {
	maxEndMedianMs: 80,
	maxEndP95Ms: 100,
	maxEndToStartMedianRatio: 6,
	maxCloseMs: 6_000,
	maxNoteBytes: 20 * 1024 * 1024,
};

export function summarizeH6LiveSessionWindow(
	durationsMs: readonly number[],
): H6LiveSessionWindowMetrics {
	if (durationsMs.length === 0 || !durationsMs.every(nonNegativeFinite))
		throw new Error(
			"H6 live-session samples must be a non-empty list of non-negative finite values.",
		);
	const sorted = [...durationsMs].sort((left, right) => left - right);
	return {
		medianMs: nearestRank(sorted, 0.5),
		p95Ms: nearestRank(sorted, 0.95),
		sampleCount: sorted.length,
	};
}

export function assertH6LiveSessionBudget(
	metrics: H6LiveSessionMetrics,
	budget: H6LiveSessionBudget = H6_LIVE_SESSION_BUDGET,
): void {
	if (!Object.values(budget).every(nonNegativeFinite))
		throw new Error(
			"H6 live-session budget must contain finite non-negative limits.",
		);
	if (
		!nonNegativeFinite(metrics.closeMs) ||
		!nonNegativeFinite(metrics.noteBytes) ||
		!nonNegativeFinite(metrics.endToStartMedianRatio)
	)
		throw new Error(
			"H6 live-session metrics must contain finite non-negative values.",
		);
	const failures = [
		metrics.end.medianMs > budget.maxEndMedianMs
			? `end-of-session median ${metrics.end.medianMs.toFixed(2)}ms > ${budget.maxEndMedianMs}ms`
			: null,
		metrics.end.p95Ms > budget.maxEndP95Ms
			? `end-of-session p95 ${metrics.end.p95Ms.toFixed(2)}ms > ${budget.maxEndP95Ms}ms`
			: null,
		metrics.endToStartMedianRatio > budget.maxEndToStartMedianRatio
			? `end/start median ratio ${metrics.endToStartMedianRatio.toFixed(2)} > ${budget.maxEndToStartMedianRatio}`
			: null,
		metrics.closeMs > budget.maxCloseMs
			? `close and note ${metrics.closeMs.toFixed(0)}ms > ${budget.maxCloseMs}ms`
			: null,
		metrics.noteBytes > budget.maxNoteBytes
			? `note ${metrics.noteBytes}B > ${budget.maxNoteBytes}B`
			: null,
		metrics.noteReadable ? null : "note not readable by inspectLiveSessionNote",
	].filter((failure): failure is string => failure !== null);
	if (failures.length > 0)
		throw new Error(
			`H6 live-session budget exceeded: ${failures.join("; ")}.`,
		);
}

function nearestRank(sorted: readonly number[], percentile: number): number {
	return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

function nonNegativeFinite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}
