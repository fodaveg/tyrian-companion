export interface H6PerformanceMetrics {
	medianMs: number;
	p95Ms: number;
	maxCumulativeRetainedHeapBytes: number;
	sampleCount: number;
}

export interface H6PerformanceBudget {
	maxMedianMs: number;
	maxP95Ms: number;
	maxCumulativeRetainedHeapBytes: number;
}

export const H6_WARMUP_RUNS = 3;
export const H6_MEASURED_RUNS = 21;

/**
 * Broad supported-Node CI collapse limits for the deterministic large-account fixture.
 * They reject large failures, not small cross-runner regressions.
 */
export const H6_PERFORMANCE_BUDGET: Readonly<H6PerformanceBudget> = {
	maxMedianMs: 500,
	maxP95Ms: 1_200,
	maxCumulativeRetainedHeapBytes: 16 * 1024 * 1024,
};

export function summarizeH6Performance(
	durationsMs: readonly number[],
	cumulativeRetainedHeapBytes: readonly number[],
): H6PerformanceMetrics {
	if (
		durationsMs.length === 0 ||
		durationsMs.length !== cumulativeRetainedHeapBytes.length ||
		!durationsMs.every(nonNegativeFinite) ||
		!cumulativeRetainedHeapBytes.every(nonNegativeFinite)
	) {
		throw new Error(
			"H6 performance samples must be paired non-negative finite values.",
		);
	}
	const sorted = [...durationsMs].sort((left, right) => left - right);
	return {
		medianMs: percentileNearestRank(sorted, 0.5),
		p95Ms: percentileNearestRank(sorted, 0.95),
		maxCumulativeRetainedHeapBytes: Math.max(...cumulativeRetainedHeapBytes),
		sampleCount: sorted.length,
	};
}

export function assertH6PerformanceBudget(
	metrics: H6PerformanceMetrics,
	budget: H6PerformanceBudget = H6_PERFORMANCE_BUDGET,
): void {
	if (!validBudget(budget))
		throw new Error(
			"H6 performance budget must contain finite non-negative limits.",
		);
	if (!validMetrics(metrics))
		throw new Error(
			"H6 performance metrics must contain finite non-negative values.",
		);
	const failures = [
		metrics.medianMs > budget.maxMedianMs
			? `median ${metrics.medianMs.toFixed(2)}ms > ${budget.maxMedianMs}ms`
			: null,
		metrics.p95Ms > budget.maxP95Ms
			? `p95 ${metrics.p95Ms.toFixed(2)}ms > ${budget.maxP95Ms}ms`
			: null,
		metrics.maxCumulativeRetainedHeapBytes > budget.maxCumulativeRetainedHeapBytes
			? `cumulative retained heap ${metrics.maxCumulativeRetainedHeapBytes}B > ${budget.maxCumulativeRetainedHeapBytes}B`
			: null,
	].filter((failure): failure is string => failure !== null);
	if (failures.length > 0)
		throw new Error(
			`H6 performance budget exceeded: ${failures.join("; ")}.`,
		);
}

function percentileNearestRank(
	sorted: readonly number[],
	percentile: number,
): number {
	return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

function validBudget(value: H6PerformanceBudget): boolean {
	return (
		nonNegativeFinite(value.maxMedianMs) &&
		nonNegativeFinite(value.maxP95Ms) &&
		nonNegativeFinite(value.maxCumulativeRetainedHeapBytes)
	);
}

function validMetrics(value: H6PerformanceMetrics): boolean {
	return (
		Number.isSafeInteger(value.sampleCount) &&
		value.sampleCount > 0 &&
		nonNegativeFinite(value.medianMs) &&
		nonNegativeFinite(value.p95Ms) &&
		nonNegativeFinite(value.maxCumulativeRetainedHeapBytes)
	);
}

function nonNegativeFinite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}
