import { describe, expect, it } from 'vitest';

import {
	compareSellNowWithWaiting,
	isSellOrWaitComparison,
	netAdvantageCopper,
	sellOrWaitForQuantity,
	sellOrWaitSeedMaxDays,
	type SellOrWaitInput,
} from './sell-or-wait';
import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
import { PRICE_SEED_CHART_MAX_DAYS } from './price-seed-model';
import {
	HALLOWEEN_FESTIVAL_STARTS,
	addUtcDays,
	runSellTimingExperiment,
	type SellTimingPriceDay,
} from './sell-timing-experiment';
import { SELL_TIMING_HISTORY_BAG_ITEM_ID, sellTimingHistoryBagDays } from './__fixtures__/sell-timing-history-36038';
import { SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays } from './__fixtures__/sell-timing-history-47909';

/** 2026-09-24 is the fixtures' download day and, 19 days before 13 October, 2026's decision day. */
const DECISION_MS = Date.parse('2026-09-24T12:00:00.000Z');

function todayQuote(days: readonly SellTimingPriceDay[]): number {
	const quote = days.find((day) => day.dayUtc === '2026-09-24')?.bidCopper;
	if (quote === undefined) throw new Error('fixture without a 2026-09-24 quote');
	return quote;
}

function fixtureInput(days: readonly SellTimingPriceDay[], overrides: Partial<SellOrWaitInput> = {}): SellOrWaitInput {
	return { nowMs: DECISION_MS, mode: 'instant', quantity: 250, todayUnitCopper: todayQuote(days), history: days, ...overrides };
}

/** Every day from 60 days before each edition through the following May, priced by `price(day, year)`. */
function syntheticSeries(price: (dayUtc: string, year: number) => number, lastYear = 2025): SellTimingPriceDay[] {
	const days: SellTimingPriceDay[] = [];
	for (const festival of HALLOWEEN_FESTIVAL_STARTS) {
		if (festival.year > lastYear) continue;
		for (let offset = -60; offset <= 0; offset += 1) {
			const dayUtc = addUtcDays(festival.startsOnUtc, offset);
			days.push({ dayUtc, bidCopper: price(dayUtc, festival.year) });
		}
		for (let day = 1; day <= 31; day += 1) {
			const dayUtc = `${String(festival.year + 1)}-05-${String(day).padStart(2, '0')}`;
			days.push({ dayUtc, bidCopper: price(dayUtc, festival.year) });
		}
	}
	return days.sort((left, right) => left.dayUtc.localeCompare(right.dayUtc));
}

describe('compareSellNowWithWaiting: the two real fixtures, graded by the experiment\'s own out-of-sample criterion (H18.19)', () => {
	it('the bag (36038) on 2026-09-24: "sin ventaja demostrada para esperar", with its net advantage, range, seasons and risk', () => {
		const comparison = compareSellNowWithWaiting(fixtureInput(sellTimingHistoryBagDays()));
		expect(comparison).toEqual({
			version: 1, verdict: 'no_demonstrated_advantage', mode: 'instant', strategy: 'wait_pre_festival',
			quantity: 250, unitCopper: 378, decisionOffsetDays: 19, windowFromDay: null, windowToDay: null,
			seasons: 7, seasonsWon: 3, seasonsLost: 4,
			medianRatio: 0.970357941834452, lowRatio: 0.9059653916211293, highRatio: 1.056437389770723,
			netAdvantageCopper: -2_381, netAdvantageLowCopper: -7_553, netAdvantageHighCopper: 4_533,
		});
	});

	it('the corn (47909) on 2026-09-24: "esperar" to the real 2026 pre-festival window, with its net advantage and range', () => {
		const comparison = compareSellNowWithWaiting(fixtureInput(sellTimingHistoryCornDays()));
		expect(comparison).toEqual({
			version: 1, verdict: 'wait', mode: 'instant', strategy: 'wait_pre_festival',
			quantity: 250, unitCopper: 45_681, decisionOffsetDays: 19, windowFromDay: '2026-09-25', windowToDay: '2026-10-12',
			seasons: 7, seasonsWon: 4, seasonsLost: 3,
			medianRatio: 1.0294472843979023, lowRatio: 0.9696768246201847, highRatio: 1.0933256119218593,
			netAdvantageCopper: 285_851, netAdvantageLowCopper: -294_353, netAdvantageHighCopper: 905_932,
		});
	});

	it.each([
		[SELL_TIMING_HISTORY_BAG_ITEM_ID, sellTimingHistoryBagDays()],
		[SELL_TIMING_HISTORY_CORN_ITEM_ID, sellTimingHistoryCornDays()],
	])('item %i: the runtime verdict and numbers are the published experiment\'s, not a second criterion', (itemId, days) => {
		const experiment = runSellTimingExperiment(itemId, days).outOfSample;
		const comparison = compareSellNowWithWaiting(fixtureInput(days));
		expect(comparison.verdict).toBe(experiment.verdict === 'advantage_demonstrated' ? 'wait' : experiment.verdict);
		expect(comparison).toMatchObject({
			strategy: experiment.strategy, seasons: experiment.yearsWithData, seasonsWon: experiment.yearsWon,
			seasonsLost: experiment.yearsLost, medianRatio: experiment.medianRatio, lowRatio: experiment.minRatio,
			highRatio: experiment.maxRatio,
		});
	});

	it('never reads a price on or after today: corrupting every such day changes nothing', () => {
		const days = sellTimingHistoryCornDays();
		const future = [...days.map((day) => (day.dayUtc >= '2026-09-24' ? { ...day, bidCopper: 9_999_999 } : day)),
			...Array.from({ length: 18 }, (_unused, index) => ({ dayUtc: addUtcDays('2026-09-25', index), bidCopper: 1 }))];
		const todayUnitCopper = todayQuote(days);
		expect(compareSellNowWithWaiting(fixtureInput(future, { todayUnitCopper })))
			.toEqual(compareSellNowWithWaiting(fixtureInput(days)));
	});
});

describe('compareSellNowWithWaiting: honest abstention', () => {
	it('a history of about a year (the sell rule\'s own seed) is "datos insuficientes", never "sin ventaja demostrada"', () => {
		const lastYear = sellTimingHistoryCornDays().filter((day) => day.dayUtc >= '2025-09-01');
		const comparison = compareSellNowWithWaiting(fixtureInput(lastYear));
		expect(comparison).toMatchObject({
			verdict: 'insufficient_data', strategy: 'sell_now', windowFromDay: null, seasons: 1,
			netAdvantageCopper: null, netAdvantageLowCopper: null, netAdvantageHighCopper: null,
		});
	});

	it('no curated start for the next edition (after 13 October 2026) is "datos insuficientes", never a guessed date', () => {
		const comparison = compareSellNowWithWaiting(fixtureInput(sellTimingHistoryCornDays(), {
			nowMs: Date.parse('2026-11-01T12:00:00.000Z'),
		}));
		expect(comparison).toMatchObject({ verdict: 'insufficient_data', decisionOffsetDays: null, windowFromDay: null });
	});

	it('a flat series is not an opportunity to wait for: "sin ventaja demostrada", so selling now stands', () => {
		const flat = syntheticSeries(() => 500);
		const comparison = compareSellNowWithWaiting({
			nowMs: DECISION_MS, mode: 'instant', quantity: 10, todayUnitCopper: 500, history: flat,
		});
		expect(comparison).toMatchObject({
			verdict: 'no_demonstrated_advantage', strategy: 'sell_now', netAdvantageCopper: 0, windowFromDay: null,
		});
	});
});

describe('compareSellNowWithWaiting: the basis it answers for', () => {
	/** Every pre-festival day 10 % above every other day: waiting for it always wins. */
	const rising = syntheticSeries((dayUtc, year) => {
		const start = HALLOWEEN_FESTIVAL_STARTS.find((festival) => festival.year === year)!.startsOnUtc;
		return dayUtc >= addUtcDays(start, -18) && dayUtc < start ? 1_100 : 1_000;
	});

	it('a demonstrated wait decided on another day of the calendar keeps only the pre-festival days still ahead', () => {
		const comparison = compareSellNowWithWaiting({
			nowMs: Date.parse('2026-10-08T12:00:00.000Z'), mode: 'instant', quantity: 10, todayUnitCopper: 1_100, history: rising,
		});
		// Decided 5 days before 13 October: the wait window is -4..-1, and every past year is graded
		// from its own day -5, which already sits inside the dear stretch: no advantage left to wait for.
		expect(comparison).toMatchObject({ decisionOffsetDays: 5, verdict: 'no_demonstrated_advantage' });
		const early = compareSellNowWithWaiting({
			nowMs: DECISION_MS, mode: 'instant', quantity: 10, todayUnitCopper: 1_000, history: rising,
		});
		expect(early).toMatchObject({
			verdict: 'wait', strategy: 'wait_pre_festival', windowFromDay: '2026-09-25', windowToDay: '2026-10-12', seasons: 7, seasonsWon: 7,
		});
	});

	it('scales with the free quantity and today\'s quote: a moved reservation or a new price is a new comparison', () => {
		const base = { nowMs: DECISION_MS, mode: 'instant' as const, history: rising };
		const ten = compareSellNowWithWaiting({ ...base, quantity: 10, todayUnitCopper: 1_000 });
		const twenty = compareSellNowWithWaiting({ ...base, quantity: 20, todayUnitCopper: 1_000 });
		const dearer = compareSellNowWithWaiting({ ...base, quantity: 10, todayUnitCopper: 1_500 });
		expect(ten.netAdvantageCopper).toBe(netAdvantageCopper(1_000, 10, 1.1));
		expect(twenty.netAdvantageCopper).toBe(netAdvantageCopper(1_000, 20, 1.1));
		expect(dearer.netAdvantageCopper).toBe(netAdvantageCopper(1_500, 10, 1.1));
		expect(new Set([ten.netAdvantageCopper, twenty.netAdvantageCopper, dearer.netAdvantageCopper]).size).toBe(3);
		expect([ten.quantity, twenty.quantity, dearer.unitCopper]).toEqual([10, 20, 1_500]);
	});

	it('restated for another share of the same object, it is exactly the comparison for those units', () => {
		const base = { nowMs: DECISION_MS, mode: 'instant' as const, todayUnitCopper: 45_681, history: sellTimingHistoryCornDays() };
		const whole = compareSellNowWithWaiting({ ...base, quantity: 250 });
		expect(sellOrWaitForQuantity(whole, 60)).toEqual(compareSellNowWithWaiting({ ...base, quantity: 60 }));
		expect(sellOrWaitForQuantity(whole, 250)).toBe(whole);
		expect(sellOrWaitForQuantity(whole, 0)).toBeNull();
		const thin = compareSellNowWithWaiting({ ...base, quantity: 250, history: sellTimingHistoryCornDays().filter((day) => day.dayUtc >= '2025-09-01') });
		expect(sellOrWaitForQuantity(thin, 60)).toMatchObject({ verdict: 'insufficient_data', quantity: 60, netAdvantageCopper: null });
	});

	it('compares within one sale mode: a listing is graded on the listing series and today\'s listing price', () => {
		const comparison = compareSellNowWithWaiting({
			nowMs: DECISION_MS, mode: 'listing', quantity: 10, todayUnitCopper: 1_000, history: rising,
		});
		expect(comparison).toMatchObject({ mode: 'listing', verdict: 'wait', unitCopper: 1_000 });
	});

	it('both sides pay the same trading-post fees: a 10 % better price is 10 % more net, never the gross difference', () => {
		// 10 000 gross now → 8 500 net; 11 000 gross later → 9 350 net.
		expect(netAdvantageCopper(1_000, 10, 1.1)).toBe(850);
		expect(netAdvantageCopper(1_000, 10, 0.9)).toBe(-850);
	});

	it('keeps the whole published seed only for items the festival calendar covers, and nothing extra without a calendar', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load('2026-09-24T12:00:00.000Z');
		if (loaded.status !== 'available') throw new Error('the built-in pack must be available');
		const calendar = loaded.bundle.festivalCalendar;
		expect(sellOrWaitSeedMaxDays(calendar, SELL_TIMING_HISTORY_BAG_ITEM_ID)).toBe(PRICE_SEED_CHART_MAX_DAYS);
		expect(sellOrWaitSeedMaxDays(calendar, SELL_TIMING_HISTORY_CORN_ITEM_ID)).toBe(PRICE_SEED_CHART_MAX_DAYS);
		expect(sellOrWaitSeedMaxDays(calendar, 19_721)).toBeUndefined();
		expect(sellOrWaitSeedMaxDays(null, SELL_TIMING_HISTORY_BAG_ITEM_ID)).toBeUndefined();
	});

	it('the structural check accepts what it computes and refuses a wait without a window', () => {
		const comparison = compareSellNowWithWaiting(fixtureInput(sellTimingHistoryCornDays()));
		expect(isSellOrWaitComparison(comparison)).toBe(true);
		expect(isSellOrWaitComparison({ ...comparison, windowFromDay: null, windowToDay: null })).toBe(false);
		expect(isSellOrWaitComparison({ ...comparison, verdict: 'maybe' })).toBe(false);
	});
});
