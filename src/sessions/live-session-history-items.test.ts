import { describe, expect, it } from 'vitest';
import { liveHistoryCurrencies, liveItemRank } from './live-session-history';

describe('liveHistoryCurrencies: the coins of a saved session', () => {
	const row = (kind: 'item' | 'currency', idNumber: number, net: number) => ({ kind, idNumber, positive: Math.max(net, 0), negative: Math.max(-net, 0), net });

	it('keeps only currency rows with a net other than 0, gold first and the rest by ascending id', () => {
		const totals = [row('currency', 7, 2), row('item', 1, 9), row('currency', 3, -4), row('currency', 1, 500), row('currency', 2, 0)];
		expect(liveHistoryCurrencies(totals)).toEqual([{ idNumber: 1, net: 500 }, { idNumber: 3, net: -4 }, { idNumber: 7, net: 2 }]);
	});

	it('is empty when no coin was observed, and does not reorder its input', () => {
		expect(liveHistoryCurrencies([row('item', 1, 9)])).toEqual([]);
		const totals = [row('currency', 5, 1), row('currency', 1, 1)];
		liveHistoryCurrencies(totals);
		expect(totals.map((entry) => entry.idNumber)).toEqual([5, 1]);
	});
});

describe('liveItemRank: the order of the object tiles, live and saved', () => {
	const row = (idNumber: number, net: number) => ({ kind: 'item' as const, idNumber, positive: Math.max(net, 0), negative: Math.max(-net, 0), net });
	const prices = [{ itemId: 1, unitCopper: 10 }, { itemId: 2, unitCopper: 3 }, { itemId: 3, unitCopper: null }];

	it('ranks by estimated value, then unpriced, then consumed objects last', () => {
		const rows = [row(4, -5), row(3, 9), row(2, 2), row(1, 1), row(5, 1)];
		const sorted = [...rows].sort((a, b) => liveItemRank(b, prices) - liveItemRank(a, prices) || b.net - a.net).map((entry) => entry.idNumber);
		expect(sorted).toEqual([1, 2, 3, 5, 4]);
	});

	it('sinks a consumed object whatever its price, and an unquoted one to -1', () => {
		expect(liveItemRank(row(1, -1), prices)).toBe(Number.NEGATIVE_INFINITY);
		expect(liveItemRank(row(3, 4), prices)).toBe(-1);
		expect(liveItemRank(row(1, 3), prices)).toBe(30);
	});
});
