import { describe, expect, it } from 'vitest';
import type { LiveJournalEntryV1, LivePriceBasis, LivePriceV1, LiveTotalV1 } from './live-session-model';
import { buildLiveChart, LiveChartBuilder, LiveValuationMemo, liveChartPoint, liveObservationTotals, valueLiveTotals } from './live-session-reducer';

/** A small deterministic generator, so a failure repeats. */
function generator(seed: number): () => number {
	let state = seed;
	return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 4_294_967_296; };
}

const ITEMS = 60;
const BASES: LivePriceBasis[] = ['instant_sell_gross', 'instant_sell_net'];
/** Prices of every kind the valuation sees: tiny ones (minimum fee), round ones, large ones, zero, unpriced and one that overflows. */
function prices(random: () => number): LivePriceV1[] {
	return Array.from({ length: ITEMS }, (_, index) => {
		const kind = index % 6;
		const unitCopper = kind === 0 ? 1 + Math.floor(random() * 5) : kind === 1 ? 0 : kind === 2 ? null : kind === 3 ? Number.MAX_SAFE_INTEGER
			: kind === 4 ? 1 + Math.floor(random() * 50_000) : 1 + Math.floor(random() * 40);
		return { itemId: 1000 + index, unitCopper };
	});
}
function journal(random: () => number, entries: number): LiveJournalEntryV1[] {
	return Array.from({ length: entries }, (_, cursor) => ({ cursor, epoch: 'e', observedAt: new Date(Date.UTC(2026, 9, 10, 0, 0, cursor)).toISOString(),
		breakBefore: cursor % 97 === 0 && cursor > 0,
		observations: Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({ kind: 'item' as const, idNumber: 1000 + Math.floor(random() * ITEMS),
			delta: Math.floor(random() * 600) - 300 })).filter((row) => row.delta !== 0) })) as unknown as LiveJournalEntryV1[];
}

describe('the valuation memo of a chart build gives the value the plain call gives', () => {
	for (const basis of BASES) {
		it(`valueLiveTotals with and without the memo agree on every total set (${basis})`, () => {
			const random = generator(7); const list = prices(random); const memo = new LiveValuationMemo(list, basis);
			let totals: LiveTotalV1[] = [];
			for (const entry of journal(random, 400)) {
				totals = liveObservationTotals(totals, entry.observations);
				expect(valueLiveTotals(totals, list, 'at', false, basis, memo)).toEqual(valueLiveTotals(totals, list, 'at', false, basis));
			}
		});
		it(`a chart built with the memo has the points of one built value by value, with the same cuts and thinning (${basis})`, () => {
			const random = generator(11); const list = prices(random); const entries = journal(random, 1500);
			const record = { prices: list, priceCapturedAt: 'at', currencyTrackedIds: [] as number[], priceBasis: basis };
			const reference = new LiveChartBuilder((entry, totals) => liveChartPoint(entry, totals, record), 600);
			let totals: LiveTotalV1[] = [];
			for (const entry of entries) { totals = liveObservationTotals(totals, entry.observations); const now = totals; reference.push(entry, () => now); }
			const expected = reference.points(() => totals);
			const chart = buildLiveChart(entries, record, 600, null);
			expect(chart.length).toBeGreaterThan(100);
			expect(chart).toEqual(expected);
		});
	}
	it('ignores a memo made for other prices or another basis, so it cannot change a result', () => {
		const random = generator(3); const list = prices(random); const totals: LiveTotalV1[] = [{ kind: 'item', idNumber: 1004, positive: 40, negative: 0, net: 40 }];
		const otherBasis = new LiveValuationMemo(list, 'instant_sell_net');
		const otherPrices = new LiveValuationMemo([...list], 'instant_sell_gross');
		expect(valueLiveTotals(totals, list, null, false, 'instant_sell_gross', otherBasis)).toEqual(valueLiveTotals(totals, list, null, false, 'instant_sell_gross'));
		expect(valueLiveTotals(totals, list, null, false, 'instant_sell_gross', otherPrices)).toEqual(valueLiveTotals(totals, list, null, false, 'instant_sell_gross'));
	});
});
