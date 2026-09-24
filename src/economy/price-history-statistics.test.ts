import { describe, expect, it } from 'vitest';

import { priceHistoryDayUtc, type PriceHistoryDailyV1, type PriceHistorySnapshotV1 } from './price-history-model';
import { buildPriceHistoryDailyAggregates, calculatePriceHistoryPercentile, medianCopperX2 } from './price-history-statistics';

describe('price-history statistics', () => {
	it('keeps odd, even, and tied medians exact in doubled copper', () => {
		expect(medianCopperX2([9, 1, 5])).toBe(10);
		expect(medianCopperX2([9, 1, 5, 3])).toBe(8);
		expect(medianCopperX2([7, 7, 7, 7])).toBe(14);
		expect(medianCopperX2(Array.from({ length: 101 }, (_, index) => 101 - index))).toBe(102);
		expect(medianCopperX2(Array.from({ length: 100 }, (_, index) => 100 - index))).toBe(101);
		expect(medianCopperX2([])).toBeNull();
	});

	it('uses UTC days across local DST boundaries and keeps null sides as gaps', () => {
		const beforeUtcMidnight = Date.parse('2026-03-29T23:59:59.000Z');
		const afterUtcMidnight = Date.parse('2026-03-30T00:00:01.000Z');
		expect(priceHistoryDayUtc(beforeUtcMidnight)).toBe('2026-03-29');
		expect(priceHistoryDayUtc(afterUtcMidnight)).toBe('2026-03-30');
		const [daily] = buildPriceHistoryDailyAggregates('vault', [
			snapshot(afterUtcMidnight, [[36_038, 100, null]]),
			snapshot(afterUtcMidnight + 1_000, [[36_038, 120, 200]]),
		]);
		expect(daily?.bid).toMatchObject({ count: 2, minCopper: 100, maxCopper: 120, medianCopperX2: 220, closeCopper: 120 });
		expect(daily?.ask).toMatchObject({ count: 1, medianCopperX2: 400, closeCopper: 200 });
		expect(daily?.partialSnapshotCount).toBe(1);
	});

	it('attributes missing ids and incomplete sides to their own item only', () => {
		const capturedAt = Date.parse('2026-08-29T12:00:00.000Z');
		const daily = buildPriceHistoryDailyAggregates('vault', [{
			...snapshot(capturedAt, [[1, 100, 110], [3, null, 330]]),
			status: 'partial', missingItemIds: [2],
		}]);
		expect(daily).toHaveLength(3);
		expect(daily.find(({ itemId }) => itemId === 1)).toMatchObject({ snapshotCount: 1, partialSnapshotCount: 0 });
		expect(daily.find(({ itemId }) => itemId === 2)).toMatchObject({ snapshotCount: 1, partialSnapshotCount: 1, bid: null, ask: null });
		expect(daily.find(({ itemId }) => itemId === 3)).toMatchObject({ snapshotCount: 1, partialSnapshotCount: 1, bid: null });
	});

	it('groups a reasonable 400-item scale in one result per item and snapshot', () => {
		const base = Date.parse('2026-08-29T00:00:00.000Z');
		const snapshots = Array.from({ length: 20 }, (_, sample) => snapshot(
			base + sample * 900_000,
			Array.from({ length: 400 }, (_unused, index) => [index + 1, index + sample, index + sample + 1]),
		));
		const daily = buildPriceHistoryDailyAggregates('vault', snapshots);
		expect(daily).toHaveLength(400);
		expect(daily.every(({ snapshotCount, partialSnapshotCount }) => snapshotCount === 20 && partialSnapshotCount === 0)).toBe(true);
		expect(daily[399]?.ask).toMatchObject({ count: 20, minCopper: 400, maxCopper: 419, medianCopperX2: 819, closeCopper: 419 });
	});

	it('requires 42 observed days, today\'s quote included, without filling a missing day', () => {
		const forty = Array.from({ length: 40 }, (_, index) => daily(index, index + 1));
		expect(calculatePriceHistoryPercentile(forty, 'ask', 42, 42, 41)).toEqual({
			status: 'insufficient_history', coveredDays: 41, requiredDays: 42,
		});
		const fortyOne = [...forty, daily(40, 41)];
		expect(calculatePriceHistoryPercentile(fortyOne, 'ask', 42, 42, 42)).toEqual({
			status: 'ready', percentile: 100, coveredDays: 42, valueCopper: 42,
		});
		fortyOne[20] = { ...fortyOne[20]!, ask: null };
		expect(calculatePriceHistoryPercentile(fortyOne, 'ask', 42, 42, 42).status).toBe('insufficient_history');
	});

	/**
	 * H18.2 (audit 2026-09-24 §3.A): the observation is today's quote, never the history's last
	 * close. Before the fix the fifth argument did not exist and the last close (410, the series'
	 * maximum, dated 60+ days before any "today") was ranked as today's price: percentile 100.
	 */
	it('ranks today\'s quote against the history, never the history\'s own last close', () => {
		const rising = Array.from({ length: 41 }, (_, index) => daily(index, 10 + index * 10));
		const cheapToday = calculatePriceHistoryPercentile(rising, 'ask', 180, 42, 15);
		expect(cheapToday).toMatchObject({ status: 'ready', valueCopper: 15, coveredDays: 42 });
		// 10 and 15 itself are at or below 15: rank 2 of 42.
		expect(cheapToday.status === 'ready' ? cheapToday.percentile : null).toBe(4.76);
		const dearToday = calculatePriceHistoryPercentile(rising, 'ask', 180, 42, 1_000);
		expect(dearToday).toMatchObject({ status: 'ready', percentile: 100, valueCopper: 1_000 });
	});

	it('rejects an observation that is not a non-negative integer amount of copper', () => {
		const history = Array.from({ length: 41 }, (_, index) => daily(index, index + 1));
		expect(() => calculatePriceHistoryPercentile(history, 'ask', 42, 42, -1)).toThrow(RangeError);
		expect(() => calculatePriceHistoryPercentile(history, 'ask', 42, 42, 1.5)).toThrow(RangeError);
	});
});

function snapshot(capturedAtMs: number, items: PriceHistorySnapshotV1['items']): PriceHistorySnapshotV1 {
	const partial = items.some(([, bid, ask]) => bid === null || ask === null);
	return {
		version: 1, vaultId: 'vault', slotStartMs: capturedAtMs, capturedAtMs, intervalMs: 900_000,
		status: partial ? 'partial' : 'complete', items, missingItemIds: [],
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
