import { describe, expect, it } from 'vitest';
import type { LiveChartPointV1, LiveJournalEntryV1, LiveObservationV1, LiveSessionRuntimeRecord } from './live-session-model';
import { buildLiveChart, GOLD_CURRENCY_ID, liveObservationTotals, valueLiveTotals } from './live-session-reducer';

type PricedRecord = Pick<LiveSessionRuntimeRecord, 'prices' | 'priceCapturedAt' | 'currencyTrackedIds'>;
const AT = Date.parse('2026-10-06T12:00:00.000Z');

/** The algorithm `rebuildChart` ran before it became incremental: per entry copy and sort every total, revalue, keep the last 600. */
function legacyChart(journal: readonly LiveJournalEntryV1[], record: PricedRecord | null): LiveChartPointV1[] {
	const chart: LiveChartPointV1[] = []; let totals: ReturnType<typeof liveObservationTotals> = [];
	for (const entry of journal) {
		totals = liveObservationTotals(totals, entry.observations);
		const valuation = valueLiveTotals(totals, record?.prices ?? [], record?.priceCapturedAt ?? null, record?.currencyTrackedIds.includes(GOLD_CURRENCY_ID) ?? false);
		chart.push({ observedAt: entry.observedAt, itemQuantityNet: totals.filter((item) => item.kind === 'item').reduce((sum, item) => sum + item.net, 0),
			netItemValueKnownCopper: valuation.netItemValueKnownCopper, knownNetValueCopper: valuation.knownNetValueCopper, breakBefore: entry.breakBefore }); if (chart.length > 600) chart.shift();
	}
	return chart;
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
	it.each([0, 1, 5, 599, 600, 601, 1500])('is identical point by point to the legacy rebuild for %i entries', (size) => {
		for (const rec of [null, record(false, []), record(true, prices), record(false, prices)]) {
			const entries = journal(size);
			expect(buildLiveChart(entries, rec)).toEqual(legacyChart(entries, rec));
		}
	});
	it('revalues the whole retained tail when the prices change', () => {
		const entries = journal(900); const cheap = record(true, [{ itemId: 30, unitCopper: 1 }]); const dear = record(true, [{ itemId: 30, unitCopper: 99 }]);
		expect(buildLiveChart(entries, dear)).toEqual(legacyChart(entries, dear));
		expect(buildLiveChart(entries, dear)).not.toEqual(buildLiveChart(entries, cheap));
	});
	it('keeps the arithmetic overflow guard', () => {
		const huge = journal(2); huge[0]!.observations = [observation(0, 'item', 1, Number.MAX_SAFE_INTEGER)]; huge[1]!.observations = [observation(1, 'item', 1, 5)];
		expect(() => buildLiveChart(huge, null)).toThrow('Live session arithmetic overflow.');
	});
});
