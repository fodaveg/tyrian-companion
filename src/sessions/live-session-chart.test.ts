import { describe, expect, it } from 'vitest';
import type { LiveChartPointV1, LiveJournalEntryV1, LiveObservationV1, LiveSessionRuntimeRecord } from './live-session-model';
import { buildLiveChart, GOLD_CURRENCY_ID, liveChartPoint, LiveChartBuilder, liveObservationTotals, valueLiveTotals } from './live-session-reducer';

type PricedRecord = Pick<LiveSessionRuntimeRecord, 'prices' | 'priceCapturedAt' | 'currencyTrackedIds'>;
const AT = Date.parse('2026-10-06T12:00:00.000Z');

/** The point the old per-entry rebuild gave EVERY entry (copy and sort every total, revalue); the chart now keeps a subset of them, unchanged. */
function legacyChart(journal: readonly LiveJournalEntryV1[], record: PricedRecord | null): LiveChartPointV1[] {
	const all: LiveChartPointV1[] = []; let totals: ReturnType<typeof liveObservationTotals> = [];
	for (const entry of journal) {
		totals = liveObservationTotals(totals, entry.observations);
		const valuation = valueLiveTotals(totals, record?.prices ?? [], record?.priceCapturedAt ?? null, record?.currencyTrackedIds.includes(GOLD_CURRENCY_ID) ?? false);
		all.push({ observedAt: entry.observedAt, itemQuantityNet: totals.filter((item) => item.kind === 'item').reduce((sum, item) => sum + item.net, 0),
			netItemValueKnownCopper: valuation.netItemValueKnownCopper, knownNetValueCopper: valuation.knownNetValueCopper, breakBefore: entry.breakBefore });
	}
	return all;
}
function observation(index: number, kind: 'item' | 'currency', idNumber: number, delta: number): LiveObservationV1 {
	return { version: 1, id: `o${String(index)}`, source: 'nexus_inventory', epoch: 'e', cursor: index, kind, idNumber, before: 0, after: delta, delta,
		observedAt: new Date(AT + index * 1000).toISOString(), windowStartAt: new Date(AT).toISOString(), sourceElapsedMs: index * 1000, cause: 'unknown', coverage: 'observed_interval' };
}
/** Deterministic journal: gaps (empty entries), breaks, item and gold rows, negative deltas, ids arriving out of order. */
function journal(size: number): LiveJournalEntryV1[] {
	return Array.from({ length: size }, (_, index) => {
		const observations: LiveObservationV1[] = [];
		if (index % 7 !== 3) observations.push(observation(index, 'item', [30, 5, 12147, 9][index % 4]!, (index % 5) - 1 || 2));
		if (index % 11 === 0) observations.push(observation(index, 'currency', 1, 100 * ((index % 3) - 1)));
		return { version: 1, sessionId: 's', epoch: 'e', cursor: index, observedAt: new Date(AT + index * 1000).toISOString(),
			observations, breakBefore: index % 13 === 0, alertsProcessed: true, outbox: [] };
	});
}
const record = (gold: boolean, prices: PricedRecord['prices']): PricedRecord => ({ prices, priceCapturedAt: prices.length > 0 ? new Date(AT).toISOString() : null, currencyTrackedIds: gold ? [1] : [] });

describe('incremental live chart', () => {
	const prices = [{ itemId: 30, unitCopper: 15 }, { itemId: 12147, unitCopper: null }, { itemId: 9, unitCopper: 1234 }];
	it.each([0, 1, 5, 599, 600, 601, 1500, 5000])('spans the session within 600 points, each exact, for %i entries', (size) => {
		for (const rec of [null, record(false, []), record(true, prices), record(false, prices)]) {
			const entries = journal(size); const chart = buildLiveChart(entries, rec); const every = legacyChart(entries, rec);
			expect(chart.length).toBeLessThanOrEqual(600);
			if (size === 0) { expect(chart).toEqual([]); continue; }
			for (const point of chart) expect(point, point.observedAt).toEqual(every.find((candidate) => candidate.observedAt === point.observedAt));
			expect(chart[0]).toEqual(every[0]); expect(chart.at(-1), 'the latest entry closes the line').toEqual(every.at(-1));
			const kept = new Set(chart.map((point) => point.observedAt));
			for (const point of every.filter((candidate) => candidate.breakBefore)) expect(kept.has(point.observedAt), 'cuts are kept').toBe(true);
			expect(chart.map((point) => point.observedAt)).toEqual([...kept].sort());
		}
	});
	it('built sample by sample gives the same chart as built at once', () => {
		for (const size of [3, 600, 601, 1500, 5000]) {
			const entries = journal(size); const rec = record(true, prices); let totals: ReturnType<typeof liveObservationTotals> = [];
			const incremental = new LiveChartBuilder((entry, cumulative) => liveChartPoint(entry, cumulative, rec));
			for (const entry of entries) { totals = liveObservationTotals(totals, entry.observations); const now = totals; incremental.push(entry, () => now); }
			expect(incremental.points(() => totals)).toEqual(buildLiveChart(entries, rec));
		}
	});
	it('revalues every kept point when the prices change', () => {
		const entries = journal(900); const cheap = record(true, [{ itemId: 30, unitCopper: 1 }]); const dear = record(true, [{ itemId: 30, unitCopper: 99 }]);
		const chart = buildLiveChart(entries, dear); const every = legacyChart(entries, dear);
		for (const point of chart) expect(point).toEqual(every.find((candidate) => candidate.observedAt === point.observedAt));
		expect(chart).not.toEqual(buildLiveChart(entries, cheap));
	});
	/** A looting entry built directly (`journal(n)` per entry made the test quadratic). */
	const loot = (index: number, cut: boolean): LiveJournalEntryV1 => ({ version: 1, sessionId: 's', epoch: 'e', cursor: index, observedAt: new Date(AT + index * 1000).toISOString(),
		observations: [observation(index, 'item', 30, 1)], breakBefore: cut, alertsProcessed: true, outbox: [] });
	it('never exceeds 600 points nor loses the first, with cuts piling up after a full chart', () => {
		const entries = Array.from({ length: 599 }, (_, index) => loot(index, index === 0));
		entries.push(loot(599, true), loot(600, true), { ...loot(601, false), observations: [] });
		const chart = buildLiveChart(entries, null);
		expect(chart.length).toBeLessThanOrEqual(600); expect(chart[0]).toMatchObject({ observedAt: entries[0]!.observedAt, breakBefore: true });
		expect(chart.at(-1)?.observedAt).toBe(entries.at(-1)!.observedAt);
		const cuts = Array.from({ length: 1500 }, (_, index) => loot(index, true)); const many = buildLiveChart(cuts, null);
		expect(many.length).toBeLessThanOrEqual(600); expect(many[0]?.observedAt).toBe(cuts[0]!.observedAt); expect(many.at(-1)?.observedAt).toBe(cuts.at(-1)!.observedAt);
		let totals: ReturnType<typeof liveObservationTotals> = []; const incremental = new LiveChartBuilder((entry, cumulative) => liveChartPoint(entry, cumulative, null));
		for (const entry of cuts) { totals = liveObservationTotals(totals, entry.observations); const now = totals; incremental.push(entry, () => now); }
		expect(incremental.points(() => totals), 'sample by sample = at once').toEqual(many);
	});
	it('costs at most linear work however many cuts there are (counted, not timed)', () => {
		const work = (size: number, cut: (index: number) => boolean) => {
			const builder = new LiveChartBuilder((entry, cumulative) => liveChartPoint(entry, cumulative, null)); const totals = liveObservationTotals([], [observation(0, 'item', 30, 1)]);
			for (let index = 0; index < size; index += 1) builder.push(loot(index, cut(index)), () => totals);
			return builder.work.valued + builder.work.examined;
		};
		for (const [label, cut] of [['all cuts', () => true], ['every other', (index: number) => index % 2 === 0], ['no cuts', () => false]] as const) {
			const small = work(3000, cut); const large = work(12000, cut);
			expect(large, `${label}: x4 the entries is at most x5 the work (${String(small)} -> ${String(large)})`).toBeLessThanOrEqual(small * 5);
			expect(large / 12000, `${label}: a bounded amount of work per entry, however long the run`).toBeLessThanOrEqual(12);
		}
	});
	it('keeps the arithmetic overflow guard', () => {
		const huge = journal(2); huge[0]!.observations = [observation(0, 'item', 1, Number.MAX_SAFE_INTEGER)]; huge[1]!.observations = [observation(1, 'item', 1, 5)];
		expect(() => buildLiveChart(huge, null)).toThrow('Live session arithmetic overflow.');
	});
});
