import { describe, expect, it } from "vitest";

import {
	assertH6LiveSessionBudget,
	summarizeH6LiveSessionWindow,
	type H6LiveSessionBudget,
	type H6LiveSessionMetrics,
} from "./h6-live-session-contract";

const BUDGET: H6LiveSessionBudget = {
	maxEndMedianMs: 80,
	maxEndP95Ms: 100,
	maxEndToStartMedianRatio: 6,
	maxCloseMs: 6_000,
	maxNoteBytes: 1_000,
};
const WINDOW = { medianMs: 18, p95Ms: 22, sampleCount: 300 };
const GOOD: H6LiveSessionMetrics = {
	start: WINDOW,
	oneHour: WINDOW,
	end: WINDOW,
	endToStartMedianRatio: 1.2,
	closeMs: 1_300,
	noteBytes: 900,
	noteReadable: true,
};

describe("H6 live-session performance contract", () => {
	it("summarizes a window by nearest-rank median and p95", () => {
		const durations = Array.from({ length: 20 }, (_value, index) => index + 1);

		expect(summarizeH6LiveSessionWindow(durations)).toEqual({
			medianMs: 10,
			p95Ms: 19,
			sampleCount: 20,
		});
	});

	it("rejects an empty window instead of reporting a zero median", () => {
		expect(() => summarizeH6LiveSessionWindow([])).toThrow("non-empty");
	});

	it("accepts metrics inside every limit", () => {
		expect(() => assertH6LiveSessionBudget(GOOD, BUDGET)).not.toThrow();
	});

	it("fails on the end/start ratio even when absolute times are inside their limits", () => {
		expect(() =>
			assertH6LiveSessionBudget({ ...GOOD, endToStartMedianRatio: 6.01 }, BUDGET),
		).toThrow("end/start median ratio 6.01 > 6");
	});

	it("fails when the long note can no longer be read back", () => {
		expect(() =>
			assertH6LiveSessionBudget({ ...GOOD, noteReadable: false }, BUDGET),
		).toThrow("note not readable by inspectLiveSessionNote");
	});

	it("fails on close time and on note size, naming both", () => {
		expect(() =>
			assertH6LiveSessionBudget({ ...GOOD, closeMs: 6_001, noteBytes: 1_001 }, BUDGET),
		).toThrow("close and note 6001ms > 6000ms; note 1001B > 1000B");
	});

	it("fails closed on a negative or non-finite limit", () => {
		expect(() =>
			assertH6LiveSessionBudget(GOOD, { ...BUDGET, maxCloseMs: Number.NaN }),
		).toThrow("finite non-negative limits");
	});
});
