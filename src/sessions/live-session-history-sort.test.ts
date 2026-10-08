import { describe, expect, it } from 'vitest';
import type { LiveTotalV1 } from './live-session-model';
import { liveItemRank, sortLiveItemsByValue } from './live-session-history';

describe('sortLiveItemsByValue', () => {
	it('orders exactly like the per-comparison price scan: unpriced and negative sink, ties by net', () => {
		const totals: LiveTotalV1[] = [
			{ kind: 'item', idNumber: 1, positive: 5, negative: 0, net: 5 }, { kind: 'item', idNumber: 2, positive: 9, negative: 0, net: 9 },
			{ kind: 'item', idNumber: 3, positive: 4, negative: 0, net: 4 }, { kind: 'item', idNumber: 4, positive: 0, negative: 3, net: -3 },
			{ kind: 'item', idNumber: 5, positive: 2, negative: 2, net: 0 }, { kind: 'item', idNumber: 6, positive: 7, negative: 0, net: 7 },
			{ kind: 'currency', idNumber: 1, positive: 9, negative: 0, net: 9 }, { kind: 'item', idNumber: 7, positive: 1, negative: 0, net: 1 }];
		const prices = [{ itemId: 1, unitCopper: 100 }, { itemId: 2, unitCopper: 50 }, { itemId: 3, unitCopper: null }, { itemId: 4, unitCopper: 10 }, { itemId: 7, unitCopper: 500 }];
		const reference = totals.filter((row) => row.kind === 'item' && row.net !== 0)
			.sort((a, b) => liveItemRank(b, prices) - liveItemRank(a, prices) || b.net - a.net);
		const sorted = sortLiveItemsByValue(totals, prices);
		expect(sorted).toEqual(reference); expect(sorted.map((row) => row.idNumber)).toEqual([1, 7, 2, 6, 3, 4]);
	});
});
