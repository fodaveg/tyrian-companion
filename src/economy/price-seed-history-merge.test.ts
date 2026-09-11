import { describe, expect, it } from 'vitest';

import type { PriceHistoryDailyV1 } from './price-history-model';
import { mergePriceHistoryWithSeed } from './price-seed-history-merge';
import type { PriceSeedV1 } from './price-seed-model';
import { mergeSellSignalSeries } from './sell-signal';

const ITEM_ID = 42;

describe('mergePriceHistoryWithSeed (SPEC-recomendacion-por-objeto.md, decision 4, M2)', () => {
	it('lets the captured day win over the seed for a day both cover, and keeps a seed-only day as-is', () => {
		const seed = seedWith([
			{ dayUtc: '2026-08-30', bidCopper: 100, askCopper: 110 },
			{ dayUtc: '2026-08-31', bidCopper: 200, askCopper: 210 },
		]);
		const daily = [dailyEntry('2026-08-31', 999)];
		const merged = mergePriceHistoryWithSeed(ITEM_ID, daily, seed);
		const byDay = new Map(merged.map((entry) => [entry.dayUtc, entry]));
		expect(byDay.get('2026-08-31')?.bid?.closeCopper).toBe(999);
		expect(byDay.get('2026-08-30')?.bid?.closeCopper).toBe(100);
		expect(merged).toHaveLength(2);
	});

	/**
	 * The precedence must be the SAME rule `mergeSellSignalSeries` (H13.2, `sell-signal.ts`) already
	 * applies to its own flat series: both share `unionByDayLocalWins`, so this pins the two down to
	 * agreeing on the winner for an identical overlapping day rather than merely asserting a number.
	 */
	it('agrees with mergeSellSignalSeries on which value wins for the same overlapping day', () => {
		const seed = seedWith([{ dayUtc: '2026-08-31', bidCopper: 200, askCopper: 210 }]);
		const daily = [dailyEntry('2026-08-31', 999)];
		const sellSignalSeries = mergeSellSignalSeries(seed, daily, ITEM_ID);
		const merged = mergePriceHistoryWithSeed(ITEM_ID, daily, seed);
		const sellSignalDay = sellSignalSeries.days.find((day) => day.dayUtc === '2026-08-31');
		const historyDay = merged.find((entry) => entry.dayUtc === '2026-08-31');
		expect(historyDay?.bid?.closeCopper).toBe(sellSignalDay?.bidCopper);
		expect(sellSignalDay?.bidCopper).toBe(999);
	});

	it('returns the captured series untouched when there is no seed for the item', () => {
		const daily = [dailyEntry('2026-08-31', 500)];
		expect(mergePriceHistoryWithSeed(ITEM_ID, daily, null)).toEqual(daily);
	});

	it('ignores a seed cached for a different item id', () => {
		const seed = { ...seedWith([{ dayUtc: '2026-08-30', bidCopper: 100, askCopper: null }]), itemId: 7 };
		expect(mergePriceHistoryWithSeed(ITEM_ID, [], seed)).toEqual([]);
	});

	it('never invents a day neither side has', () => {
		const seed = seedWith([{ dayUtc: '2026-08-30', bidCopper: 100, askCopper: null }]);
		const merged = mergePriceHistoryWithSeed(ITEM_ID, [dailyEntry('2026-08-31', 500)], seed);
		expect(merged.map((entry) => entry.dayUtc).sort()).toEqual(['2026-08-30', '2026-08-31']);
	});
});

function seedWith(days: PriceSeedV1['days']): PriceSeedV1 {
	return { version: 1, itemId: ITEM_ID, source: 'datawars2', retrievedAt: '2026-09-01T00:00:00.000Z', days };
}

function dailyEntry(dayUtc: string, closeCopper: number): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId: ITEM_ID, dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
		bid: { count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2, closeCopper, closeCapturedAtMs: 0 },
		ask: null,
	};
}
