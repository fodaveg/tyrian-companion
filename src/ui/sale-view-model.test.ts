import { describe, expect, it } from 'vitest';

import {
	buildSaleViewModel,
	computeInstantSellNetCopper,
	type SaleSourceRow,
	type SaleViewModelInput,
} from './sale-view-model';

const NOW_MS = Date.UTC(2026, 8, 26, 7, 38, 0); // 26 sep 2026, 07:38 UTC, matches the maqueta.

function row(overrides: Partial<SaleSourceRow> & Pick<SaleSourceRow, 'itemId' | 'name'>): SaleSourceRow {
	return {
		id: `#/row/${String(overrides.itemId)}`,
		icon: null,
		ownedQuantity: 1,
		slotsUsed: 1,
		materialStorageEligible: false,
		decision: null,
		bidCopper: null,
		instantSellNetCopper: null,
		listingNetCopper: null,
		...overrides,
	};
}

function baseInput(overrides: Partial<SaleViewModelInput> = {}): SaleViewModelInput {
	return {
		status: 'ready',
		nowMs: NOW_MS,
		festivalStartMs: Date.UTC(2026, 9, 13),
		maxPriceAgeMs: 900_000,
		hero: null,
		rows: [],
		calendar: [],
		...overrides,
	};
}

describe('sale view model: grouping', () => {
	it('groups sell into "now", hold/sell_at_season into "wait" and review into "noData"', () => {
		const model = buildSaleViewModel(baseInput({
			rows: [
				row({ itemId: 48805, name: 'Colmillos de plástico de alta calidad', decision: { action: 'sell', reason: 'seasonal_sell_window', until: null, priceQuotedAt: null, sellWindowFromDay: '2026-09-22', sellWindowToDay: '2026-10-19' } }),
				row({ itemId: 47909, name: 'Barra de caramelo', decision: { action: 'sell_at_season', reason: 'wait_advantage_demonstrated', until: null, priceQuotedAt: null, sellWindowFromDay: '2026-10-06', sellWindowToDay: '2026-10-19' } }),
				row({ itemId: 43320, name: 'Jorcamelo', decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null } }),
				row({ itemId: 36059, name: 'Colmillos de plástico', decision: { action: 'review', reason: 'price_unknown', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null } }),
			],
		}));
		expect(model.groups.now.map((r) => r.itemId)).toEqual([48805]);
		expect(model.groups.wait.map((r) => r.itemId).sort()).toEqual([43320, 47909]);
		expect(model.groups.noData.map((r) => r.itemId)).toEqual([36059]);
		expect(model.groups.now[0]!.action).toBe('sell');
		expect(model.groups.wait.find((r) => r.itemId === 47909)!.action).toBe('not_yet');
		expect(model.groups.wait.find((r) => r.itemId === 43320)!.action).toBe('wait');
		expect(model.groups.noData[0]!.action).toBe('no_data');
	});

	it('excludes a row with no decision at all into "noData" rather than throwing', () => {
		const model = buildSaleViewModel(baseInput({ rows: [row({ itemId: 1, name: 'Sin decisión' })] }));
		expect(model.groups.noData.map((r) => r.itemId)).toEqual([1]);
	});
});

describe('sale view model: low-space override (ficha decision 3)', () => {
	const lowSpace = {
		bags: null, bank: null, sharedInventory: null,
		lowSpace: { freeSlots: 9, totalSlots: 370, thresholdFreeSlots: 20, isLow: true },
		materialCapacity: null,
	};
	const plentySpace = {
		...lowSpace,
		lowSpace: { freeSlots: 64, totalSlots: 370, thresholdFreeSlots: 20, isLow: false },
	};

	it('leaves every row untouched with plenty of space', () => {
		const model = buildSaleViewModel(baseInput({
			storageSpace: plentySpace,
			rows: [row({
				itemId: 43320, name: 'Jorcamelo', slotsUsed: 1,
				decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
			})],
		}));
		expect(model.groups.wait[0]!.action).toBe('wait');
		expect(model.groups.wait[0]!.slotsFreedLabel).toBeNull();
	});

	it('flips a "wait" row to "sell" with low space and labels the slots it frees', () => {
		const model = buildSaleViewModel(baseInput({
			storageSpace: lowSpace,
			rows: [row({
				itemId: 43320, name: 'Jorcamelo', slotsUsed: 1,
				decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
			})],
		}));
		expect(model.groups.now.map((r) => r.itemId)).toEqual([43320]);
		expect(model.groups.now[0]!.action).toBe('sell');
		expect(model.groups.now[0]!.slotsFreedLabel).toBe(1);
	});

	it('routes a depositable material to "deposit" instead of "sell", even over an already-sell row\'s "libera N" label', () => {
		const model = buildSaleViewModel(baseInput({
			storageSpace: lowSpace,
			rows: [
				row({
					itemId: 36041, name: 'Trozo de caramelo', slotsUsed: 7, materialStorageEligible: true,
					decision: { action: 'sell_at_season', reason: 'wait_advantage_demonstrated', until: null, priceQuotedAt: null, sellWindowFromDay: '2026-10-06', sellWindowToDay: '2026-10-12' },
				}),
				row({
					itemId: 48805, name: 'Colmillos de plástico de alta calidad', slotsUsed: 1,
					decision: { action: 'sell', reason: 'seasonal_sell_window', until: null, priceQuotedAt: null, sellWindowFromDay: '2026-09-22', sellWindowToDay: '2026-10-19' },
				}),
			],
			// Ordered by slots freed first, gold second, per `prioritizeSpaceFreeingActions`.
		}));
		const deposited = model.groups.now.find((r) => r.itemId === 36041)!;
		expect(deposited.action).toBe('deposit');
		expect(deposited.slotsFreedLabel).toBe(7);
		const sold = model.groups.now.find((r) => r.itemId === 48805)!;
		expect(sold.action).toBe('sell');
		expect(sold.slotsFreedLabel).toBe(1);
		// Deposit frees 7 slots, sell frees 1: deposit sorts first under low space.
		expect(model.groups.now.map((r) => r.itemId)).toEqual([36041, 48805]);
	});

	it('sorts the "now" group by gold when space is plentiful (existing prioritizeSpaceFreeingActions behaviour)', () => {
		const model = buildSaleViewModel(baseInput({
			storageSpace: plentySpace,
			rows: [
				row({ itemId: 1, name: 'Barato', slotsUsed: 1, instantSellNetCopper: 100, decision: { action: 'sell', reason: 'bid_above_reference', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null } }),
				row({ itemId: 2, name: 'Caro', slotsUsed: 1, instantSellNetCopper: 900, decision: { action: 'sell', reason: 'bid_above_reference', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null } }),
			],
		}));
		expect(model.groups.now.map((r) => r.itemId)).toEqual([2, 1]);
	});
});

describe('sale view model: price age', () => {
	it('marks a quote stale once "until" has passed, and fresh before it', () => {
		const fresh = row({
			itemId: 1, name: 'Fresco',
			decision: {
				action: 'sell', reason: 'bid_above_reference',
				until: new Date(NOW_MS + 60_000).toISOString(), priceQuotedAt: new Date(NOW_MS - 180_000).toISOString(),
				sellWindowFromDay: null, sellWindowToDay: null,
			},
		});
		const stale = row({
			itemId: 2, name: 'Viejo',
			decision: {
				action: 'sell', reason: 'bid_above_reference',
				until: new Date(NOW_MS - 1_000).toISOString(), priceQuotedAt: new Date(NOW_MS - 960_000).toISOString(),
				sellWindowFromDay: null, sellWindowToDay: null,
			},
		});
		const model = buildSaleViewModel(baseInput({ rows: [fresh, stale] }));
		const freshRow = model.groups.now.find((r) => r.itemId === 1)!;
		const staleRow = model.groups.now.find((r) => r.itemId === 2)!;
		expect(freshRow.quote.stale).toBe(false);
		expect(staleRow.quote.stale).toBe(true);
		expect(model.capturedAtMs).toBe(NOW_MS - 180_000);
	});

	it('never marks a row stale when its decision carries no clock (reservations, reviews)', () => {
		const model = buildSaleViewModel(baseInput({
			rows: [row({ itemId: 1, name: 'Sin reloj', decision: { action: 'review', reason: 'price_unknown', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null } })],
		}));
		expect(model.groups.noData[0]!.quote.stale).toBe(false);
		expect(model.groups.noData[0]!.quote.quotedAtMs).toBeNull();
	});
});

describe('sale view model: hero card and calendar', () => {
	it('carries the hero row through the same low-space override and its own year threshold', () => {
		const model = buildSaleViewModel(baseInput({
			storageSpace: {
				bags: null, bank: null, sharedInventory: null,
				lowSpace: { freeSlots: 9, totalSlots: 370, thresholdFreeSlots: 20, isLow: true },
				materialCapacity: null,
			},
			hero: {
				...row({
					itemId: 36038, name: 'Saco de Halloween', ownedQuantity: 2350, slotsUsed: 10,
					decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
				}),
				yearThresholdCopper: 430,
			},
		}));
		expect(model.hero).toMatchObject({ itemId: 36038, action: 'sell', slotsFreedLabel: 10, yearThresholdCopper: 430 });
	});

	it('resolves a window\'s "open today" flag against the given instant', () => {
		const model = buildSaleViewModel(baseInput({
			calendar: [{ itemId: 36038, name: 'Saco de Halloween', icon: null, candidates: [
				{ fromDay: '2026-09-15', toDay: '2026-10-12' },
				{ fromDay: '2026-05-01', toDay: '2026-05-31' },
			] }],
		}));
		expect(model.calendar).toHaveLength(1);
		expect(model.calendar[0]!.spans).toEqual([
			{ fromDay: '2026-09-15', toDay: '2026-10-12', openToday: true },
			{ fromDay: '2026-05-01', toDay: '2026-05-31', openToday: false },
		]);
	});
});

describe('sale view model: instant-sell net fallback', () => {
	it('reproduces the maqueta\'s own Saco figure: 2350 x 0g3s42c bid, minus the 15% trading-post fee', () => {
		// 2350 * 342 = 803700 gross; GW2_TRADING_POST_FEE_POLICY charges 5% + 10% = 15% always.
		expect(computeInstantSellNetCopper(342, 2350)).toBe(683_145); // 68g 31s 45c, as printed in the maqueta.
	});

	it('returns null without a bid or with a non-positive quantity, never a guessed number', () => {
		expect(computeInstantSellNetCopper(null, 10)).toBeNull();
		expect(computeInstantSellNetCopper(100, 0)).toBeNull();
		expect(computeInstantSellNetCopper(100, -1)).toBeNull();
	});
});
