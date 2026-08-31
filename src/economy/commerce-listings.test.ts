import { describe, expect, it, vi } from 'vitest';

import {
	isInventoryMarketDepthEvidence,
	valueCompetitiveListing,
	valueExpectedInstantSellDepth,
	valueInstantSellDepth,
} from './commerce-listings';
import { captureInventoryMarketDepth } from './commerce-listings-capture';

describe('official commerce listings depth', () => {
	it('consumes several buy levels without extrapolating the best bid', () => {
		expect(valueInstantSellDepth([
			{ unitCopper: 100, quantity: 2 },
			{ unitCopper: 90, quantity: 3 },
		], 4)).toMatchObject({
			status: 'complete', coveredQuantity: 4, uncoveredQuantity: 0,
			grossCopper: 380, netCopper: 323,
		});
		expect(valueInstantSellDepth([{ unitCopper: 100, quantity: 2 }], 5)).toMatchObject({
			status: 'partial', coveredQuantity: 2, uncoveredQuantity: 3, grossCopper: 200, netCopper: 170,
		});
	});

	it('continues from already consumed depth and degrades when later rows exhaust it', () => {
		const levels = [{ unitCopper: 100, quantity: 2 }, { unitCopper: 90, quantity: 3 }];
		expect(valueInstantSellDepth(levels, 2, 2)).toMatchObject({
			status: 'complete', grossCopper: 180, coveredQuantity: 2, uncoveredQuantity: 0,
		});
		expect(valueInstantSellDepth(levels, 2, 4)).toMatchObject({
			status: 'partial', grossCopper: 90, coveredQuantity: 1, uncoveredQuantity: 1,
		});
	});

	it('values probabilistic outcome units conservatively against finite depth', () => {
		const complete = valueExpectedInstantSellDepth([{ unitCopper: 10, quantity: 2 }], 1_500_000n);
		expect(complete).toMatchObject({
			status: 'complete', grossMicroCopper: 15_000_000n, netMicroCopper: 12_500_000n,
		});
		expect(valueExpectedInstantSellDepth([{ unitCopper: 10, quantity: 1 }], 1_500_000n)).toMatchObject({
			status: 'partial', coveredUnitsMillionths: 1_000_000n, uncoveredUnitsMillionths: 500_000n,
		});
	});

	it('never treats sell-listing quantity as instant-sale capacity', () => {
		const sells = [{ unitCopper: 120, quantity: 1 }];
		expect(valueCompetitiveListing(sells, 10)).toMatchObject({
			status: 'complete', coveredQuantity: 10, uncoveredQuantity: 0, unitCopper: 120,
		});
		expect(valueInstantSellDepth([], 10)).toMatchObject({
			status: 'no_market', coveredQuantity: 0, uncoveredQuantity: 10,
		});
	});

	it.each([
		[[{ unitCopper: 90, quantity: 1 }, { unitCopper: 100, quantity: 1 }]],
		[[{ unitCopper: 100, quantity: 1 }, { unitCopper: 100, quantity: 2 }]],
		[[{ unitCopper: 100, quantity: 0 }]],
	] as const)('rejects invalid, disordered or duplicate buy levels', (levels) => {
		expect(valueInstantSellDepth(levels, 2).status).toBe('invalid');
	});

	it('captures batches of 200 with explicit missing and empty-market coverage', async () => {
		const requestDetailed = vi.fn(async (path: string) => {
			const ids = path.split('ids=')[1]!.split(',').map(Number);
			return { status: 200, headers: {}, body: ids.filter((id) => id !== 2).map((id) => ({
				id, buys: id === 1 ? [] : [{ listings: 1, unit_price: 100, quantity: 2 }], sells: [],
			})) };
		});
		const evidence = await captureInventoryMarketDepth(
			Array.from({ length: 201 }, (_, index) => index + 1), { requestDetailed }, Date.parse('2026-08-29T12:00:00.000Z'),
		);
		expect(requestDetailed).toHaveBeenCalledTimes(2);
		expect(requestDetailed.mock.calls[0]?.[0].split(',')).toHaveLength(200);
		expect(evidence.status).toBe('partial');
		expect(evidence.items.slice(0, 2)).toMatchObject([
			{ itemId: 1, coverage: 'complete', buys: [], sells: [] },
			{ itemId: 2, coverage: 'missing', buys: [], sells: [] },
		]);
		expect(isInventoryMarketDepthEvidence(evidence)).toBe(true);
	});

	it('marks a corrupt batch invalid instead of accepting duplicate or unexpected ids', async () => {
		for (const body of [
			[{ id: 1, buys: [], sells: [] }, { id: 1, buys: [], sells: [] }],
			[{ id: 999, buys: [], sells: [] }],
			[{ id: 1, buys: [level(100), level(100)], sells: [] }],
		]) {
			const evidence = await captureInventoryMarketDepth([1], {
				requestDetailed: async () => ({ status: 200, headers: {}, body }),
			}, Date.parse('2026-08-29T12:00:00.000Z'));
			expect(evidence).toMatchObject({ status: 'unavailable', items: [{ itemId: 1, coverage: 'invalid' }] });
		}
	});
});

function level(unitPrice: number) { return { listings: 1, unit_price: unitPrice, quantity: 1 }; }
