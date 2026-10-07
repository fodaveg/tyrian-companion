import { describe, expect, it } from 'vitest';
import { liveItemRank } from './live-session-history';

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
