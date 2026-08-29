import { describe, expect, it } from 'vitest';

import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { evaluateHalloweenPrice } from './halloween-price-alert';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

describe('Halloween price projection', () => {
	it('uses today provisionally and the 30 complete immediately preceding UTC days', () => {
		const daily = history(Array.from({ length: 30 }, (_, index) => index + 1), 40);
		expect(evaluateHalloweenPrice(daily, NOW, 0)).toEqual({
			status: 'high', dayUtc: '2026-08-31', bidCopper: 40, p90Copper: 27,
			capturedAtMs: NOW, referenceDays: 30, minimumAboveP90Bps: 0,
		});
	});

	it('fails closed for any UTC gap, a null bid, or a missing provisional today close', () => {
		const gap = history(Array.from({ length: 30 }, (_, index) => index + 1), 40).filter(({ dayUtc }) => dayUtc !== '2026-08-15');
		expect(evaluateHalloweenPrice(gap, NOW, 0)).toMatchObject({ status: 'insufficient_history', missingDayUtc: '2026-08-15' });
		const nullBid = history(Array.from({ length: 30 }, (_, index) => index + 1), 40);
		nullBid[0]!.bid = null;
		expect(evaluateHalloweenPrice(nullBid, NOW, 0).status).toBe('insufficient_history');
		expect(evaluateHalloweenPrice(nullBid.slice(0, -1), NOW, 0).status).toBe('insufficient_history');
		const wrongUtcClose = history(Array.from({ length: 30 }, (_, index) => index + 1), 40);
		wrongUtcClose[0]!.bid!.closeCapturedAtMs = NOW;
		expect(evaluateHalloweenPrice(wrongUtcClose, NOW, 0).status).toBe('insufficient_history');
	});

	it('uses nearest-rank position 27 and applies the configured margin without filling data', () => {
		const daily = history(Array.from({ length: 30 }, (_, index) => index + 1), 30);
		expect(evaluateHalloweenPrice(daily, NOW, 1_000).status).toBe('high');
		expect(evaluateHalloweenPrice(daily, NOW, 1_500).status).toBe('below');
		expect(evaluateHalloweenPrice(history(Array.from({ length: 30 }, () => 30), 30), NOW, 0).status).toBe('below');
	});
});

function history(reference: number[], today: number): PriceHistoryDailyV1[] {
	return [...reference.map((close, index) => daily(NOW - (30 - index) * 86_400_000, close)), daily(NOW, today)];
}

function daily(timestamp: number, closeCopper: number): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId: 36_038, dayUtc: new Date(timestamp).toISOString().slice(0, 10),
		snapshotCount: 1, partialSnapshotCount: 0,
		bid: { count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2,
			closeCopper, closeCapturedAtMs: timestamp }, ask: null,
	};
}
