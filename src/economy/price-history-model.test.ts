import { describe, expect, it } from 'vitest';

import { PRICE_HISTORY_MAX_WATCH_ITEMS, selectDerivedWatchListItemIds } from './price-history-model';

describe('selectDerivedWatchListItemIds (SPEC-recomendacion-por-objeto, decision 3, M2)', () => {
	it('admits exactly the items whose demonstrated capital clears the threshold, dropping the rest', () => {
		const positions = [
			{ itemId: 1, totalSellCopper: 100_000 },
			{ itemId: 2, totalSellCopper: 99_999 },
			{ itemId: 3, totalSellCopper: 500_000 },
			{ itemId: 4, totalSellCopper: null },
		];
		expect(selectDerivedWatchListItemIds(positions, 100_000)).toEqual([3, 1]);
	});

	it('sums capital across several positions of the same item before comparing to the threshold', () => {
		const positions = [
			{ itemId: 1, totalSellCopper: 60_000 },
			{ itemId: 1, totalSellCopper: 60_000 },
			{ itemId: 2, totalSellCopper: 90_000 },
		];
		expect(selectDerivedWatchListItemIds(positions, 100_000)).toEqual([1]);
	});

	it('caps at maxItems, keeping the highest-capital items and breaking ties by item id', () => {
		const positions = Array.from({ length: PRICE_HISTORY_MAX_WATCH_ITEMS + 50 }, (_, index) => ({
			itemId: index + 1, totalSellCopper: 1_000_000 - index,
		}));
		const derived = selectDerivedWatchListItemIds(positions, 1);
		expect(derived).toHaveLength(PRICE_HISTORY_MAX_WATCH_ITEMS);
		expect(derived).toEqual(Array.from({ length: PRICE_HISTORY_MAX_WATCH_ITEMS }, (_, index) => index + 1));
	});

	it('returns nothing when every position is below the threshold or undemonstrated', () => {
		expect(selectDerivedWatchListItemIds([{ itemId: 1, totalSellCopper: 1 }, { itemId: 2, totalSellCopper: null }], 100_000)).toEqual([]);
	});
});
