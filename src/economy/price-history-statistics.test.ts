import { describe, expect, it } from 'vitest';

import { priceHistoryDayUtc, type PriceHistoryDailyV1, type PriceHistorySnapshotV1 } from './price-history-model';
import { aggregatePriceHistoryDay, calculatePriceHistoryPercentile, medianCopperX2 } from './price-history-statistics';

describe('price-history statistics', () => {
	it('keeps odd, even, and tied medians exact in doubled copper', () => {
		expect(medianCopperX2([9, 1, 5])).toBe(10);
		expect(medianCopperX2([9, 1, 5, 3])).toBe(8);
		expect(medianCopperX2([7, 7, 7, 7])).toBe(14);
		expect(medianCopperX2([])).toBeNull();
	});

	it('uses UTC days across local DST boundaries and keeps null sides as gaps', () => {
		const beforeUtcMidnight = Date.parse('2026-03-29T23:59:59.000Z');
		const afterUtcMidnight = Date.parse('2026-03-30T00:00:01.000Z');
		expect(priceHistoryDayUtc(beforeUtcMidnight)).toBe('2026-03-29');
		expect(priceHistoryDayUtc(afterUtcMidnight)).toBe('2026-03-30');
		const daily = aggregatePriceHistoryDay('vault', 36_038, '2026-03-30', [
			snapshot(afterUtcMidnight, [[36_038, 100, null]]),
			snapshot(afterUtcMidnight + 1_000, [[36_038, 120, 200]]),
		]);
		expect(daily.bid).toMatchObject({ count: 2, minCopper: 100, maxCopper: 120, medianCopperX2: 220, closeCopper: 120 });
		expect(daily.ask).toMatchObject({ count: 1, medianCopperX2: 400, closeCopper: 200 });
	});

	it('requires 42 observed days without filling a missing day', () => {
		const fortyOne = Array.from({ length: 41 }, (_, index) => daily(index, index + 1));
		expect(calculatePriceHistoryPercentile(fortyOne, 'ask', 42)).toEqual({
			status: 'insufficient_history', coveredDays: 41, requiredDays: 42,
		});
		const fortyTwo = [...fortyOne, daily(42, 42)];
		expect(calculatePriceHistoryPercentile(fortyTwo, 'ask', 42)).toEqual({
			status: 'ready', percentile: 100, coveredDays: 42, valueCopper: 42,
		});
		fortyTwo[20] = { ...fortyTwo[20]!, ask: null };
		expect(calculatePriceHistoryPercentile(fortyTwo, 'ask', 42).status).toBe('insufficient_history');
	});
});

function snapshot(capturedAtMs: number, items: PriceHistorySnapshotV1['items']): PriceHistorySnapshotV1 {
	return {
		version: 1, vaultId: 'vault', slotStartMs: capturedAtMs, capturedAtMs, intervalMs: 900_000,
		status: 'complete', items, missingItemIds: [],
	};
}

function daily(index: number, close: number): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId: 36_038,
		dayUtc: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
		snapshotCount: 1, partialSnapshotCount: 0, bid: null,
		ask: { count: 1, minCopper: close, maxCopper: close, medianCopperX2: close * 2, closeCopper: close, closeCapturedAtMs: index },
	};
}
