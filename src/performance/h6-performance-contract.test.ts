import { describe, expect, it } from "vitest";

import {
	assertH6PerformanceBudget,
	H6_MEASURED_RUNS,
	summarizeH6Performance,
	type H6PerformanceMetrics,
} from "./h6-performance-contract";

describe("H6.6 performance budget contract", () => {
	it("uses enough samples for nearest-rank p95 not to collapse to the maximum", () => {
		const durations = Array.from(
			{ length: H6_MEASURED_RUNS },
			(_value, index) => index + 1,
		);
		const metrics = summarizeH6Performance(
			durations,
			durations.map((value) => value * 10),
		);

		expect(metrics).toEqual({
			medianMs: 11,
			p95Ms: 20,
			maxCumulativeRetainedHeapBytes: 210,
			sampleCount: 21,
		});
		expect(metrics.p95Ms).toBeLessThan(Math.max(...durations));
	});

	it("fails closed when a sabotaged p95 budget is below the measured value", () => {
		const metrics: H6PerformanceMetrics = {
			medianMs: 4,
			p95Ms: 9,
			maxCumulativeRetainedHeapBytes: 1_024,
			sampleCount: 21,
		};

		expect(() =>
			assertH6PerformanceBudget(metrics, {
				maxMedianMs: 4,
				maxP95Ms: 8,
				maxCumulativeRetainedHeapBytes: 1_024,
			}),
		).toThrow("p95 9.00ms > 8ms");
	});

	it("fails closed when cumulative retained heap crosses the collapse budget", () => {
		const metrics: H6PerformanceMetrics = {
			medianMs: 4,
			p95Ms: 9,
			maxCumulativeRetainedHeapBytes: 1_025,
			sampleCount: 21,
		};

		expect(() =>
			assertH6PerformanceBudget(metrics, {
				maxMedianMs: 4,
				maxP95Ms: 9,
				maxCumulativeRetainedHeapBytes: 1_024,
			}),
		).toThrow("cumulative retained heap 1025B > 1024B");
	});
});
