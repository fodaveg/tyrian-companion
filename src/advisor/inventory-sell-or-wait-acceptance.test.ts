import { describe, expect, it } from 'vitest';

import { inventoryAdvisorBuiltinBundleProvider } from './inventory-advisor-builtin-bundle';
import { decideInventoryObjectRoute } from './inventory-object-result';
import {
	recommendPosition,
	type PositionRecommendationInput,
	type PositionRecommendationSeasonalInput,
} from './inventory-position-recommendation';
import { HALLOWEEN_FESTIVAL_ANCHORS } from '../economy/models/halloween-festival-anchors';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { festivalCalendarEntryForItem, resolveFestivalCalendarWindow } from '../economy/seasonal-window';
import { HALLOWEEN_FESTIVAL_STARTS, addUtcDays, type SellTimingPriceDay } from '../economy/sell-timing-experiment';
import { SELL_TIMING_HISTORY_BAG_ITEM_ID, sellTimingHistoryBagDays } from '../economy/__fixtures__/sell-timing-history-36038';
import { SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays } from '../economy/__fixtures__/sell-timing-history-47909';

/**
 * H18.19, audit 2026-09-24 §8 prueba 2 ("Precios") and §3.D's acceptance criteria, through the
 * moment stage every surface reads (`recommendPosition` → `decideInventoryObjectRoute`):
 * - a sunk price inside the selling window: the calendar alone does not sell; if it sells, it is
 *   with a reason of its own (sonda C05);
 * - a flat series is not an exceptional opportunity, but can sell now;
 * - the two real fixtures, 36038 and 47909, decided on 2026-09-24 with the pack's real windows;
 * - three clocks that never share a field.
 */
const DECISION_MS = Date.parse('2026-09-24T12:00:00.000Z');
const MAX_PRICE_AGE_MS = 900_000;
const DAY_MS = 86_400_000;

function toDaily(itemId: number, days: readonly SellTimingPriceDay[]): PriceHistoryDailyV1[] {
	return days.map((day) => ({
		version: 1, vaultId: 'vault', itemId, dayUtc: day.dayUtc, snapshotCount: 0, partialSnapshotCount: 0, ask: null,
		bid: { count: 1, minCopper: day.bidCopper, maxCopper: day.bidCopper, medianCopperX2: day.bidCopper * 2, closeCopper: day.bidCopper, closeCapturedAtMs: 0 },
	}));
}

/** The item's calendar window and sell-signal parameters exactly as `main.ts`'s `seasonalInputFor` resolves them. */
function realSeasonalInput(itemId: number, asOfMs: number): PositionRecommendationSeasonalInput {
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date(asOfMs).toISOString());
	if (loaded.status !== 'available') throw new Error('the built-in pack must be available on the decision day');
	const entry = festivalCalendarEntryForItem(loaded.bundle.festivalCalendar, itemId);
	if (entry === null) throw new Error(`no calendar entry for ${String(itemId)}`);
	const window = resolveFestivalCalendarWindow(entry, new Map([[HALLOWEEN_FESTIVAL_ANCHORS.festivalId, HALLOWEEN_FESTIVAL_ANCHORS]]), asOfMs);
	if (window === null) throw new Error(`no window for ${String(itemId)}`);
	return { window, parameters: { ...loaded.bundle.economyPack.sellSignal } };
}

function input(overrides: Partial<PositionRecommendationInput>): PositionRecommendationInput {
	return {
		capturedAtMs: DECISION_MS, priceHistoryEnabled: true, totalSellCopper: 10_000_000, capitalThresholdCopper: 100_000,
		maxPriceAgeMs: MAX_PRICE_AGE_MS, priceHistoryDaily: [], priceHistoryWindowDays: 180, priceHistoryRequiredDays: 42,
		seasonal: null, legendaryShortfall: null, freeQuantity: 250, todayBidCopper: 500, untradeable: false,
		...overrides,
	};
}

function fixtureInput(itemId: number, days: readonly SellTimingPriceDay[], overrides: Partial<PositionRecommendationInput> = {}): PositionRecommendationInput {
	const today = days.find((day) => day.dayUtc === '2026-09-24')?.bidCopper;
	if (today === undefined) throw new Error('fixture without its 2026-09-24 quote');
	return input({
		priceHistoryDaily: toDaily(itemId, days), todayBidCopper: today, seasonal: realSeasonalInput(itemId, DECISION_MS), ...overrides,
	});
}

/** One closing bid a day for `days` days ending the day before `endMs`, priced by `price(index)`. */
function history(days: number, endMs: number, price: (index: number) => number): PriceHistoryDailyV1[] {
	return toDaily(1, Array.from({ length: days }, (_unused, index) => ({
		dayUtc: new Date(endMs - (days - index) * DAY_MS).toISOString().slice(0, 10), bidCopper: price(index),
	})));
}

/** Every day from 60 days before each edition (2014-2025) through the following May, at `price`. */
function flatSeasons(price: number): PriceHistoryDailyV1[] {
	const days: SellTimingPriceDay[] = [];
	for (const festival of HALLOWEEN_FESTIVAL_STARTS.filter((entry) => entry.year <= 2025)) {
		for (let offset = -60; offset <= 0; offset += 1) days.push({ dayUtc: addUtcDays(festival.startsOnUtc, offset), bidCopper: price });
		for (let day = 1; day <= 31; day += 1) days.push({ dayUtc: `${String(festival.year + 1)}-05-${String(day).padStart(2, '0')}`, bidCopper: price });
	}
	// And the last year before the decision, so the sell signal has its reference.
	for (let offset = 1; offset <= 120; offset += 1) days.push({ dayUtc: addUtcDays('2026-09-24', -offset), bidCopper: price });
	return toDaily(1, [...new Map(days.map((day) => [day.dayUtc, day])).values()]);
}

const SACO_MAY = { version: 1, seasonId: 'saco-halloween-primavera', opensOn: '05-01', closesOn: '05-31', returnsInMonth: 5 } as const;
const SELL_SIGNAL = { minimumOfMaxBps: 9_000, referenceDays: 365, minimumReferenceDays: 30 };

describe('§8 prueba 2: the calendar against the price (sonda C05)', () => {
	const inMay = Date.parse('2026-05-15T12:00:00.000Z');
	const dearYear = history(60, inMay, () => 100);

	it('inside the selling window with the price sunk (1 against 100), the calendar does not sell: the motive is its own', () => {
		const result = recommendPosition(input({
			capturedAtMs: inMay, priceHistoryDaily: dearYear, todayBidCopper: 1, seasonal: { window: SACO_MAY, parameters: SELL_SIGNAL },
		}));
		expect(result.reason).not.toBe('seasonal_sell_window');
		expect(result.sellWindowFromDay).toBeNull();
		// Selling cheap stays valid, with the reason in view: nothing demonstrates that waiting pays.
		expect(result).toMatchObject({ action: 'sell', reason: 'wait_evidence_insufficient', sellOrWait: { verdict: 'insufficient_data' } });
	});

	it('the same window with the price confirming it still says "the selling window", with the window as its own clock', () => {
		const result = recommendPosition(input({
			capturedAtMs: inMay, priceHistoryDaily: dearYear, todayBidCopper: 120, seasonal: { window: SACO_MAY, parameters: SELL_SIGNAL },
		}));
		expect(result).toMatchObject({
			action: 'sell', reason: 'seasonal_sell_window', sellWindowFromDay: '2026-05-01', sellWindowToDay: '2026-05-31',
		});
	});
});

describe('§8 prueba 2: a flat series', () => {
	it('rule (c): a flat series is not "the high band of its history" (it read p100), but it sells now', () => {
		const flat = history(60, DECISION_MS, () => 500);
		const result = recommendPosition(input({ priceHistoryDaily: flat, todayBidCopper: 500 }));
		expect(result).toMatchObject({ action: 'sell', reason: 'no_demonstrated_wait_advantage', pricePercentile: null, priceCoverageDays: 61 });
		// A quote genuinely above a flat history still is.
		const above = recommendPosition(input({ priceHistoryDaily: flat, todayBidCopper: 600 }));
		expect(above).toMatchObject({ action: 'sell', reason: 'bid_above_reference', pricePercentile: 100 });
	});

	it('rule (b): twelve flat seasons show no advantage in waiting, so a festival item sells now, never as an opportunity', () => {
		const result = recommendPosition(input({
			priceHistoryDaily: flatSeasons(500), todayBidCopper: 500, seasonal: { window: SACO_MAY, parameters: SELL_SIGNAL },
		}));
		expect(result).toMatchObject({
			action: 'sell', reason: 'no_demonstrated_wait_advantage', sellWindowFromDay: null,
			sellOrWait: { verdict: 'no_demonstrated_advantage', strategy: 'sell_now', netAdvantageCopper: 0 },
		});
	});
});

describe('§8 prueba 2 and 16: the two real fixtures, decided on 2026-09-24 with the pack\'s real windows', () => {
	it('the bag (36038) sells now, with no demonstrated advantage in waiting and the numbers that say so', () => {
		const result = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_BAG_ITEM_ID, sellTimingHistoryBagDays()));
		expect(result.action).toBe('sell');
		expect(['seasonal_sell_window', 'no_demonstrated_wait_advantage']).toContain(result.reason);
		expect(result.sellOrWait).toMatchObject({
			verdict: 'no_demonstrated_advantage', strategy: 'wait_pre_festival', mode: 'instant', quantity: 250, unitCopper: 378,
			seasons: 7, seasonsWon: 3, seasonsLost: 4, netAdvantageCopper: -2_381, netAdvantageLowCopper: -7_553, netAdvantageHighCopper: 4_533,
		});
	});

	it('the corn (47909) waits for the real 2026 pre-festival window, with its advantage, range, seasons and risk', () => {
		const result = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays()));
		expect(result).toMatchObject({
			action: 'sell_at_season', reason: 'wait_advantage_demonstrated',
			sellWindowFromDay: '2026-09-25', sellWindowToDay: '2026-10-12',
			sellOrWait: {
				verdict: 'wait', strategy: 'wait_pre_festival', mode: 'instant', quantity: 250, unitCopper: 45_681,
				seasons: 7, seasonsWon: 4, seasonsLost: 3,
				netAdvantageCopper: 285_851, netAdvantageLowCopper: -294_353, netAdvantageHighCopper: 905_932,
			},
		});
	});

	it('three clocks, three fields: the quote\'s date, the analysis\' validity and the suggested window never share one', () => {
		const result = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays()));
		expect(result.priceQuotedAt).toBe('2026-09-24T12:00:00.000Z');
		expect(result.priceHistoryLastDay).toBe('2026-05-31');
		expect(result.until).toBe(new Date(DECISION_MS + MAX_PRICE_AGE_MS).toISOString());
		expect([result.sellWindowFromDay, result.sellWindowToDay]).toEqual(['2026-09-25', '2026-10-12']);
	});

	it('is revisited when the free quantity (reservations) or the price changes: the comparison is rebuilt from them', () => {
		const base = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays()));
		const fewerFree = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays(), { freeQuantity: 100 }));
		const newPrice = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays(), { todayBidCopper: 40_000 }));
		expect(fewerFree.sellOrWait).toMatchObject({ quantity: 100 });
		expect(newPrice.sellOrWait).toMatchObject({ unitCopper: 40_000 });
		expect(fewerFree.sellOrWait?.netAdvantageCopper).not.toBe(base.sellOrWait?.netAdvantageCopper);
		expect(newPrice.sellOrWait?.netAdvantageCopper).not.toBe(base.sellOrWait?.netAdvantageCopper);
		// A goal that now reserves every unit leaves nothing to compare.
		const allReserved = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays(), {
			freeQuantity: 0, legendaryShortfall: 0,
		}));
		expect(allReserved).toMatchObject({ action: 'hold_for_legendary', sellOrWait: null, sellWindowFromDay: null });
	});

	it('the one result per object keeps the comparison in its own sale mode: a listing never borrows the instant-sale wait', () => {
		const timing = recommendPosition(fixtureInput(SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays()));
		expect(decideInventoryObjectRoute('sell', 'rule_missing', timing)).toMatchObject({
			action: 'sell_at_season', sellOrWait: { mode: 'instant', verdict: 'wait' }, sellWindowFromDay: '2026-09-25',
		});
		expect(decideInventoryObjectRoute('list', 'rule_missing', timing)).toMatchObject({
			action: 'list', reason: 'wait_evidence_insufficient', sellOrWait: null, sellWindowFromDay: null, sellWindowToDay: null,
		});
	});
});
