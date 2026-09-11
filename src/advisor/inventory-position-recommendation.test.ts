import { describe, expect, it } from 'vitest';

import {
	recommendPosition,
	type PositionRecommendationInput,
	type PositionRecommendationSeasonalInput,
} from './inventory-position-recommendation';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { seasonalWindowClosesAfterMs, seasonalWindowOpensAfterMs, type SeasonalWindowV1 } from '../economy/seasonal-window';

const CAPTURED_AT_MS = Date.parse('2026-09-11T12:00:00.000Z');
const MAX_PRICE_AGE_MS = 900_000;

function baseInput(overrides: Partial<PositionRecommendationInput> = {}): PositionRecommendationInput {
	return {
		capturedAtMs: CAPTURED_AT_MS,
		priceHistoryEnabled: true,
		totalSellCopper: 200_000,
		capitalThresholdCopper: 100_000,
		maxPriceAgeMs: MAX_PRICE_AGE_MS,
		priceHistoryDaily: [],
		priceHistoryWindowDays: 180,
		priceHistoryRequiredDays: 42,
		seasonal: null,
		...overrides,
	};
}

const WINTER_WINDOW: SeasonalWindowV1 = {
	version: 1, seasonId: 'winter-test', opensOn: '12-15', closesOn: '01-10', returnsInMonth: 12,
};
/** Inside `WINTER_WINDOW`, and outside `HALLOWEEN_SEASONAL_WINDOW` (10-01..11-15). */
const WINTER_CAPTURED_AT_MS = Date.parse('2026-12-20T12:00:00.000Z');

/**
 * The real measured windows from `src/advisor/inventory-advisor-builtin-bundle.ts`
 * (`FESTIVAL_CALENDAR_ENTRIES`, `docs/audit/2026-09-11-festivales-datawars2.md`), reproduced here
 * rather than imported: this module stays a pure function of its inputs, and the bundle's own
 * `festivalCalendar` test already covers that those windows are what got published.
 */
const SACO_WINDOW: SeasonalWindowV1 = {
	version: 1, seasonId: 'saco-halloween-primavera', opensOn: '05-01', closesOn: '05-31', returnsInMonth: 5,
};
const JORCAMELO_WINDOW: SeasonalWindowV1 = {
	version: 1, seasonId: 'jorcamelo-junio', opensOn: '06-01', closesOn: '06-30', returnsInMonth: 6,
};
const CARAMEL_BAR_WINDOW: SeasonalWindowV1 = {
	version: 1, seasonId: 'barra-caramelo-inicio-festival', opensOn: '10-05', closesOn: '10-24', returnsInMonth: 10,
};

function seasonalInput(overrides: Partial<PositionRecommendationSeasonalInput> = {}): PositionRecommendationSeasonalInput {
	return {
		window: WINTER_WINDOW,
		parameters: { minimumOfMaxBps: 9_000, referenceDays: 365, minimumReferenceDays: 30 },
		...overrides,
	};
}

/** One closing bid per day, ending on `endMs`'s own day. `bidCopper(index)` decides the value. */
function bidSeries(days: number, endMs: number, bidCopper: (index: number) => number): PriceHistoryDailyV1[] {
	const out: PriceHistoryDailyV1[] = [];
	for (let index = 0; index < days; index += 1) {
		const dayUtc = new Date(endMs - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
		const copper = bidCopper(index);
		out.push({
			version: 1, vaultId: 'vault', itemId: 1, dayUtc, snapshotCount: 1, partialSnapshotCount: 0, ask: null,
			bid: { count: 1, minCopper: copper, maxCopper: copper, medianCopperX2: copper * 2, closeCopper: copper, closeCapturedAtMs: endMs },
		});
	}
	return out;
}

/** One daily row per day, closing bid rising by `step` from `startCopper`, ending on `capturedAtMs`'s own day. */
function dailySeries(days: number, startCopper: number, step: number, endMs = CAPTURED_AT_MS): PriceHistoryDailyV1[] {
	const out: PriceHistoryDailyV1[] = [];
	for (let index = 0; index < days; index += 1) {
		const dayUtc = new Date(endMs - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
		out.push({
			version: 1, vaultId: 'vault', itemId: 1, dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
			ask: null,
			bid: {
				count: 1, minCopper: startCopper + index * step, maxCopper: startCopper + index * step,
				medianCopperX2: (startCopper + index * step) * 2, closeCopper: startCopper + index * step, closeCapturedAtMs: endMs,
			},
		});
	}
	return out;
}

describe('recommendPosition (SPEC-recomendacion-por-objeto, M1, regla c)', () => {
	it('rule 1: price history disabled always reviews, regardless of capital or price data', () => {
		const result = recommendPosition(baseInput({ priceHistoryEnabled: false, totalSellCopper: 999_999_999 }));
		expect(result).toEqual({
			action: 'review', reason: 'price_history_disabled', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: null,
		});
	});

	it('rule 2: capital below the threshold holds, even with price history enabled', () => {
		const result = recommendPosition(baseInput({ totalSellCopper: 99_999, capitalThresholdCopper: 100_000 }));
		expect(result.action).toBe('hold');
		expect(result.reason).toBe('below_capital_threshold');
		expect(result.until).toBe(new Date(CAPTURED_AT_MS + MAX_PRICE_AGE_MS).toISOString());
		expect(result.missing).toBeNull();
	});

	it('rule 2: a null totalSellCopper (undemonstrated) is treated as below threshold, not as "unknown but fine"', () => {
		const result = recommendPosition(baseInput({ totalSellCopper: null }));
		expect(result).toMatchObject({ action: 'hold', reason: 'below_capital_threshold' });
	});

	it('rule 3: insufficient history reviews, and NEVER holds — "unknown" and "cheap" must never share an outcome', () => {
		const result = recommendPosition(baseInput({ priceHistoryDaily: dailySeries(10, 100, 1), priceHistoryRequiredDays: 42 }));
		expect(result.action).toBe('review');
		expect(result.reason).toBe('price_history_insufficient');
		expect(result.action).not.toBe('hold');
		expect(result.until).toBeNull();
		expect(result.missing).toBeNull();
		// M2: `coveredDays` is at the note's disposal even while the rule itself says "review", but
		// a percentile is never invented for a series that never reached the statistic.
		expect(result.pricePercentile).toBeNull();
		expect(result.priceCoverageDays).toBe(10);
	});

	it('an item with no history at all is insufficient_history, not a crash or a silent sell', () => {
		const result = recommendPosition(baseInput({ priceHistoryDaily: [] }));
		expect(result).toEqual({
			action: 'review', reason: 'price_history_insufficient', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: 0,
		});
	});

	it('rule 4: today at the top of its own 42-day band sells', () => {
		// Strictly increasing series: the last (today's) value is the maximum, so its percentile is 100.
		const daily = dailySeries(42, 100, 10);
		const result = recommendPosition(baseInput({ priceHistoryDaily: daily, priceHistoryWindowDays: 180, priceHistoryRequiredDays: 42 }));
		expect(result.action).toBe('sell');
		expect(result.reason).toBe('bid_above_reference');
		expect(result.until).toBe(new Date(CAPTURED_AT_MS + MAX_PRICE_AGE_MS).toISOString());
		expect(result.pricePercentile).toBe(100);
		expect(result.priceCoverageDays).toBe(42);
	});

	it('rule 4: today at the bottom of its own band holds instead of selling at the floor', () => {
		// Strictly decreasing: today (the last day) is the minimum, percentile 0.
		const daily = dailySeries(42, 100, -1);
		const result = recommendPosition(baseInput({ priceHistoryDaily: daily, priceHistoryWindowDays: 180, priceHistoryRequiredDays: 42 }));
		expect(result.action).toBe('hold');
		expect(result.reason).toBe('below_local_band');
		expect(result.until).toBe(new Date(CAPTURED_AT_MS + MAX_PRICE_AGE_MS).toISOString());
		// Nearest-rank empirical percentile: today (the minimum) is still `<= itself`, so its rank
		// is 1 of 42 (~2.38%, rounded to 2), not 0 — low enough to fall well under the p90 band either way.
		expect(result.pricePercentile).toBe(2);
		expect(result.priceCoverageDays).toBe(42);
	});

	it('rule 2: below the capital threshold never carries a percentile, even with enough history to compute one', () => {
		const result = recommendPosition(baseInput({
			totalSellCopper: 1, capitalThresholdCopper: 100_000, priceHistoryDaily: dailySeries(42, 100, 10),
		}));
		expect(result).toMatchObject({ action: 'hold', reason: 'below_capital_threshold', pricePercentile: null, priceCoverageDays: null });
	});

	it('filters the series by calendar dayUtc before the percentile, dropping entries older than the window even when that leaves fewer than windowDays entries', () => {
		// 50 entries total, but they span 100 calendar days (one entry every other day): a
		// `.slice(-windowDays)` over ENTRIES with windowDays=42 would silently reach back across
		// the gaps into a window wider than 42 real days. Filtering by `dayUtc` first must instead
		// keep only the ~21 entries that actually fall inside the last 42 calendar days, which is
		// below the 42-day requirement — so the correct outcome is `insufficient_history`, not a
		// percentile computed over a window that quietly spans twice its declared width.
		const daily: PriceHistoryDailyV1[] = [];
		for (let index = 0; index < 50; index += 1) {
			const dayUtc = new Date(CAPTURED_AT_MS - (49 - index) * 2 * 86_400_000).toISOString().slice(0, 10);
			daily.push({
				version: 1, vaultId: 'vault', itemId: 1, dayUtc, snapshotCount: 1, partialSnapshotCount: 0, ask: null,
				bid: { count: 1, minCopper: 100, maxCopper: 100, medianCopperX2: 200, closeCopper: 100, closeCapturedAtMs: CAPTURED_AT_MS },
			});
		}
		const result = recommendPosition(baseInput({ priceHistoryDaily: daily, priceHistoryWindowDays: 42, priceHistoryRequiredDays: 42 }));
		expect(result.action).toBe('review');
		expect(result.reason).toBe('price_history_insufficient');
	});

	it('filtering by dayUtc still lets a full, dense window through to the percentile', () => {
		// The mirror of the case above: 42 consecutive daily entries all fall inside the 42-day
		// window, so filtering removes nothing and the percentile still runs.
		const daily = dailySeries(42, 500, 0);
		const result = recommendPosition(baseInput({ priceHistoryDaily: daily, priceHistoryWindowDays: 42, priceHistoryRequiredDays: 42 }));
		expect(result.action).not.toBe('review');
	});

	it('never emits hold_for_legendary or sell_at_season for an item outside the festival calendar (seasonal: null)', () => {
		const scenarios = [
			baseInput({ priceHistoryEnabled: false }),
			baseInput({ totalSellCopper: 0 }),
			baseInput({ priceHistoryDaily: [] }),
			baseInput({ priceHistoryDaily: dailySeries(42, 100, 10) }),
			baseInput({ priceHistoryDaily: dailySeries(42, 100, -1) }),
		];
		for (const input of scenarios) {
			expect(['sell', 'hold', 'review']).toContain(recommendPosition(input).action);
		}
	});
});

describe('recommendPosition (SPEC-recomendacion-por-objeto, M3 fix, regla b)', () => {
	it('precedence: (b) decides even when capital is below the threshold that gates rule (c)', () => {
		// 35 flat reference days plus today, all inside the window: `sell`/`seasonal_sell_window`
		// fires regardless of how little capital is parked here.
		const daily = bidSeries(36, WINTER_CAPTURED_AT_MS, () => 500);
		const result = recommendPosition(baseInput({
			capturedAtMs: WINTER_CAPTURED_AT_MS, totalSellCopper: 1, capitalThresholdCopper: 1_000_000,
			priceHistoryDaily: daily, seasonal: seasonalInput(),
		}));
		expect(result.action).toBe('sell');
		expect(result.reason).toBe('seasonal_sell_window');
	});

	/**
	 * Branch 2 of the M3 fix. Against `dcd1bfc` (the pre-fix code, where the window still meant
	 * "the floor" instead of "the selling window") this exact assertion fails: that code returns
	 * `{ action: 'sell_at_season', reason: 'seasonal_hold', ... }` for this same series and window
	 * (`evaluateSellSignal` decides `inSeason: true, signal: 'hold'` here — verified directly against
	 * the unchanged `evaluateSellSignal`), the opposite of "sell now, it's the best moment".
	 */
	it('in season -> sell/seasonal_sell_window, with `until` at the CLOSE OF ITS OWN WINDOW, not Halloween\'s', () => {
		const daily = bidSeries(36, WINTER_CAPTURED_AT_MS, () => 500);
		const result = recommendPosition(baseInput({
			capturedAtMs: WINTER_CAPTURED_AT_MS, priceHistoryDaily: daily, seasonal: seasonalInput(),
		}));
		const expectedCloses = seasonalWindowClosesAfterMs(WINTER_WINDOW, WINTER_CAPTURED_AT_MS);
		expect(result).toMatchObject({ action: 'sell', reason: 'seasonal_sell_window' });
		expect(result.until).toBe(new Date(expectedCloses!).toISOString());
		// Distinct from what Halloween's own window would have said for the same instant.
		expect(result.until).not.toBe(new Date(seasonalWindowClosesAfterMs(
			{ version: 1, seasonId: 'halloween', opensOn: '10-01', closesOn: '11-15', returnsInMonth: 10 }, WINTER_CAPTURED_AT_MS,
		)!).toISOString());
	});

	it('out of season, bid clears the reference -> sell/bid_above_reference, until the ordinary price expiry', () => {
		// Strictly increasing series, evaluated OUTSIDE the winter window: today is the maximum,
		// out of season, so the bid-clears-the-reference branch fires.
		const daily = bidSeries(40, CAPTURED_AT_MS, (index) => 100 + index * 10);
		const result = recommendPosition(baseInput({ priceHistoryDaily: daily, seasonal: seasonalInput() }));
		expect(result.action).toBe('sell');
		expect(result.reason).toBe('bid_above_reference');
		expect(result.until).toBe(new Date(CAPTURED_AT_MS + MAX_PRICE_AGE_MS).toISOString());
	});

	it('out of season, no qualifying bid -> sell_at_season/seasonal_hold, until the window\'s NEXT open (never falls through to rule (c))', () => {
		// Flat reference at 500, today far below it: out of season for the winter window (default
		// `CAPTURED_AT_MS` is September), today does not clear the 90 % sell threshold. Before the
		// M3 fix this landed on rule (c) via `evaluateSellSignal`'s `none`; the fix removes that
		// fall-through entirely for an item with a calendar entry.
		const daily = bidSeries(42, CAPTURED_AT_MS, (index) => (index === 41 ? 100 : 500));
		const withoutSeasonal = recommendPosition(baseInput({ priceHistoryDaily: daily }));
		const withSeasonal = recommendPosition(baseInput({ priceHistoryDaily: daily, seasonal: seasonalInput() }));
		const expectedOpens = seasonalWindowOpensAfterMs(WINTER_WINDOW, CAPTURED_AT_MS);
		expect(withSeasonal).toMatchObject({ action: 'sell_at_season', reason: 'seasonal_hold' });
		expect(withSeasonal.until).toBe(new Date(expectedOpens!).toISOString());
		expect(withSeasonal).not.toEqual(withoutSeasonal);
	});

	it('undecidable (insufficient_reference) -> review with the EXACT reason, not a generic one', () => {
		const daily = bidSeries(5, WINTER_CAPTURED_AT_MS, () => 500);
		const result = recommendPosition(baseInput({
			capturedAtMs: WINTER_CAPTURED_AT_MS, priceHistoryDaily: daily, seasonal: seasonalInput(),
		}));
		expect(result).toEqual({
			action: 'review', reason: 'insufficient_reference', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: null,
		});
	});

	it('undecidable (no_close_today) -> review, never a silent fall-through to rule (c)', () => {
		// The series ends 5 days before `capturedAtMs`: there is no entry for today at all.
		const daily = bidSeries(30, WINTER_CAPTURED_AT_MS - 5 * 86_400_000, () => 500);
		const result = recommendPosition(baseInput({
			capturedAtMs: WINTER_CAPTURED_AT_MS, priceHistoryDaily: daily, seasonal: seasonalInput(),
		}));
		expect(result).toEqual({
			action: 'review', reason: 'no_close_today', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: null,
		});
	});

	it('an item with no festival calendar entry (seasonal: null) is unaffected by this rule', () => {
		const daily = bidSeries(36, WINTER_CAPTURED_AT_MS, () => 500);
		const result = recommendPosition(baseInput({ capturedAtMs: WINTER_CAPTURED_AT_MS, priceHistoryDaily: daily, seasonal: null }));
		expect(result.action).not.toBe('sell_at_season');
	});
});

/**
 * The four branches against the pack's REAL measured windows (`FESTIVAL_CALENDAR_ENTRIES`), on
 * concrete dates, per the M3 fix's own closing criterion.
 */
describe('recommendPosition (SPEC-recomendacion-por-objeto, M3 fix, real festival calendar dates)', () => {
	it('saco, 15 May (inside its window), price at the floor -> sell/seasonal_sell_window, until 1 June 00:00 UTC', () => {
		const capturedAtMs = Date.parse('2026-05-15T12:00:00.000Z');
		const daily = bidSeries(36, capturedAtMs, () => 500);
		const result = recommendPosition(baseInput({
			capturedAtMs, priceHistoryDaily: daily,
			seasonal: seasonalInput({ window: SACO_WINDOW }),
		}));
		expect(result).toMatchObject({ action: 'sell', reason: 'seasonal_sell_window' });
		expect(seasonalWindowClosesAfterMs(SACO_WINDOW, capturedAtMs)).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
		expect(result.until).toBe('2026-06-01T00:00:00.000Z');
	});

	it('saco, 11 September (outside its window), price at the floor -> sell_at_season, until 1 May NEXT YEAR 00:00 UTC', () => {
		const capturedAtMs = CAPTURED_AT_MS; // 2026-09-11
		const daily = bidSeries(42, capturedAtMs, (index) => (index === 41 ? 100 : 500));
		const result = recommendPosition(baseInput({
			capturedAtMs, priceHistoryDaily: daily,
			seasonal: seasonalInput({ window: SACO_WINDOW }),
		}));
		expect(result).toMatchObject({ action: 'sell_at_season', reason: 'seasonal_hold' });
		expect(result.until).toBe('2027-05-01T00:00:00.000Z');
	});

	it('Jorcamelo, 11 September (outside its window), bid clears the sell threshold -> sell/bid_above_reference', () => {
		const capturedAtMs = CAPTURED_AT_MS; // 2026-09-11, outside 06-01..06-30
		const daily = bidSeries(40, capturedAtMs, (index) => 100 + index * 10); // strictly increasing, today is the max
		const result = recommendPosition(baseInput({
			capturedAtMs, priceHistoryDaily: daily,
			seasonal: seasonalInput({ window: JORCAMELO_WINDOW }),
		}));
		expect(result).toMatchObject({ action: 'sell', reason: 'bid_above_reference' });
		expect(result.until).toBe(new Date(capturedAtMs + MAX_PRICE_AGE_MS).toISOString());
	});

	it('barra de caramelo, 10 October (inside its window) -> sell/seasonal_sell_window', () => {
		const capturedAtMs = Date.parse('2026-10-10T12:00:00.000Z');
		const daily = bidSeries(36, capturedAtMs, () => 500);
		const result = recommendPosition(baseInput({
			capturedAtMs, priceHistoryDaily: daily,
			seasonal: seasonalInput({ window: CARAMEL_BAR_WINDOW }),
		}));
		expect(result).toMatchObject({ action: 'sell', reason: 'seasonal_sell_window' });
		expect(result.until).toBe(new Date(seasonalWindowClosesAfterMs(CARAMEL_BAR_WINDOW, capturedAtMs)!).toISOString());
	});
});
