import { describe, expect, it } from 'vitest';
import type { LiveChartPointV1, LiveObservationV1, LiveTotalV1 } from './live-session-model';
import { liveObservationTotals, valueLiveTotals } from './live-session-reducer';
import { liveSessionViewFromStored } from './live-session-history';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';

const AT = Date.parse('2026-10-06T12:00:00.000Z');

/** The loop `liveSessionViewFromStored` ran before it reused the shared accumulator. */
function legacy(payload: StoredLiveSessionPayloadV1): LiveChartPointV1[] {
	const chart: LiveChartPointV1[] = []; let totals: LiveTotalV1[] = [];
	for (const [index, entry] of payload.journal.entries()) {
		totals = liveObservationTotals(totals, entry.observations);
		if (index < payload.journal.length - 600) continue;
		const valuation = valueLiveTotals(totals, payload.valuation.prices, payload.valuation.capturedAt, payload.valuation.coinNetCopper !== null);
		chart.push({ observedAt: entry.observedAt, itemQuantityNet: totals.filter((row) => row.kind === 'item').reduce((sum, row) => sum + row.net, 0),
			netItemValueKnownCopper: valuation.netItemValueKnownCopper, knownNetValueCopper: valuation.knownNetValueCopper,
			breakBefore: entry.breakBefore || chart.length === 0 && index > 0 });
	}
	return chart;
}
function observation(index: number, kind: 'item' | 'currency', idNumber: number, delta: number): LiveObservationV1 {
	return { version: 1, id: `o${String(index)}`, source: 'nexus_inventory', epoch: 'e', cursor: index, kind, idNumber, before: 0, after: delta, delta,
		observedAt: new Date(AT + index * 1000).toISOString(), windowStartAt: new Date(AT).toISOString(), sourceElapsedMs: index * 1000, cause: 'unknown', coverage: 'observed_interval' };
}
function payload(size: number, gold: boolean): StoredLiveSessionPayloadV1 {
	const journal = Array.from({ length: size }, (_, index) => ({ observedAt: new Date(AT + index * 1000).toISOString(), breakBefore: index % 9 === 4,
		observations: [...index % 6 === 2 ? [] : [observation(index, 'item', [7, 3, 12147][index % 3]!, (index % 4) - 1 || 3)],
			...index % 10 === 0 ? [observation(index, 'currency', 1, 50)] : []] }));
	return { journal, valuation: { priceBasis: 'instant_sell_net', capturedAt: new Date(AT).toISOString(), prices: [{ itemId: 7, unitCopper: 11 }, { itemId: 12147, unitCopper: null }],
		coinNetCopper: gold ? 0 : null }, coverage: { items: 'complete', currencies: 'none', currencyIds: [], lastObservationAt: null, freeSlots: null },
		gaps: [], totals: [], magicFind: { value: null, source: 'unknown' } } as unknown as StoredLiveSessionPayloadV1;
}

describe('saved session chart', () => {
	it.each([0, 1, 599, 600, 601, 1300])('is identical to the previous per-entry loop for %i entries', (size) => {
		for (const gold of [false, true]) {
			const stored = payload(size, gold);
			expect(liveSessionViewFromStored(stored, 0).chartPoints).toEqual(legacy(stored));
		}
	});
});
