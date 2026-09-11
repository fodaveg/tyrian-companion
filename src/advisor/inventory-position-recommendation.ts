import { priceHistoryDayUtc, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import { calculatePriceHistoryPercentile } from '../economy/price-history-statistics';
import { evaluateSellSignal, type SellSignalParameters, type SellSignalSeries } from '../economy/sell-signal';
import { seasonalWindowClosesAfterMs, seasonalWindowOpensAfterMs, type SeasonalWindowV1 } from '../economy/seasonal-window';

/**
 * Per-position sell/hold recommendation (SPEC-recomendacion-por-objeto).
 *
 * `hold_for_legendary` is a member of the closed union the frontmatter schema needs from day one,
 * exactly like `docs/SPEC-recomendacion-por-objeto.md` §2.1 requires: `tc_recommendation` never
 * grows a new value on the day M4 lands. `recommendPosition` below implements rules (b) and (c)
 * (M3); it never emits `hold_for_legendary` (M4, still blocked on decision 1 as of this commit).
 */
export const POSITION_RECOMMENDATION_ACTIONS = ['sell', 'hold', 'hold_for_legendary', 'sell_at_season', 'review'] as const;
export type PositionRecommendationAction = typeof POSITION_RECOMMENDATION_ACTIONS[number];

/**
 * Closed reason-code set for rules (b) and (c). `hold_for_legendary` (M4) brings its own reason
 * codes when that milestone is implemented; widening this union is that milestone's commit, not a
 * speculative addition here.
 *
 * The four `undecidable`-shaped codes (`malformed_input`, `no_close_today`, `insufficient_reference`,
 * `undecidable_calendar`) are `evaluateSellSignal`'s OWN `SellSignalProjection['reason']` values
 * (`src/economy/sell-signal.ts`), carried through verbatim rather than re-coded: a `review` that
 * hides which of the four things went wrong is exactly the ambiguity §3.b's precedence exists to
 * avoid.
 */
export const POSITION_RECOMMENDATION_REASON_CODES = [
	'price_history_disabled',
	'below_capital_threshold',
	'price_history_insufficient',
	'bid_above_reference',
	'below_local_band',
	'seasonal_sell_window',
	'seasonal_hold',
	'malformed_input',
	'no_close_today',
	'insufficient_reference',
	'undecidable_calendar',
] as const;
export type PositionRecommendationReasonCode = typeof POSITION_RECOMMENDATION_REASON_CODES[number];

/**
 * Rule (b)'s per-item inputs: `null` when the item has no entry in the curated festival calendar,
 * which routes it straight to rule (c). Present, the window and parameters come from the calendar
 * entry (`FestivalCalendarEntryV1`) and the pack's `sellSignal` policy respectively; neither is
 * read from a store here, keeping this module's no-network-no-IndexedDB guarantee.
 */
export interface PositionRecommendationSeasonalInput {
	window: SeasonalWindowV1;
	parameters: SellSignalParameters;
}

export interface PositionRecommendationV1 {
	action: PositionRecommendationAction;
	reason: PositionRecommendationReasonCode;
	/** ISO-8601, or null when the recommendation (`review`) never had a price-based expiry. */
	until: string | null;
	/** Only meaningful for `hold_for_legendary` (M4); always null while M1 is the only rule that runs. */
	missing: number | null;
	/**
	 * `calculatePriceHistoryPercentile`'s own percentile, rounded to the nearest integer
	 * (SPEC-recomendacion-por-objeto.md §5, M2): populated only when the statistic actually ran
	 * (the `ready` branch of rule (c)), null on every earlier exit. Never a guess: a percentile
	 * with zero days behind it would be indistinguishable from a real one.
	 */
	pricePercentile: number | null;
	/**
	 * `coveredDays` from the same call, in both `ready` and `insufficient_history`: it is the one
	 * number that tells the note "how close is this to being trustworthy" even while the rule
	 * itself still says `review`. Null only when the percentile was never computed at all.
	 */
	priceCoverageDays: number | null;
}

export interface PositionRecommendationInput {
	/** The instant to evaluate against, in epoch ms. Never `Date.now()`: the caller supplies it. */
	capturedAtMs: number;
	/** `priceHistoryEnabled` from settings (opt-in, off by default). */
	priceHistoryEnabled: boolean;
	/** `tc_total_sell_copper`: demonstrated instant-sell value, or null when it cannot be demonstrated. */
	totalSellCopper: number | null;
	/** The capital-parked threshold below which selling is never worth recommending (settings, decision 5). */
	capitalThresholdCopper: number;
	/** `policy.maxPriceAgeMs`, the age at which a price-based recommendation stops being trustworthy. */
	maxPriceAgeMs: number;
	/** This item's daily aggregates, in any order; may be empty when nothing has been observed yet. */
	priceHistoryDaily: readonly PriceHistoryDailyV1[];
	/** Calendar-day width of the reference window the percentile is computed over. */
	priceHistoryWindowDays: number;
	/** Fewest covered days required before the percentile is trusted (`calculatePriceHistoryPercentile`'s own floor is 42). */
	priceHistoryRequiredDays: number;
	/**
	 * Rule (b), M3: `null` for an item with no entry in the curated festival calendar, which
	 * routes it straight to rule (c) exactly as before M3. Present, `recommendPosition` evaluates
	 * `evaluateSellSignal` over the SAME merged (seed ∪ capture) series `priceHistoryDaily` already
	 * carries for rule (c): festival items are not exempt from decision 4's watch-list merge, they
	 * just also get a calendar-shaped read of it.
	 */
	seasonal: PositionRecommendationSeasonalInput | null;
}

const DAY_MS = 86_400_000;

/**
 * Rules (b) and (c) of the recommendation spec, in precedence order. (a) is not implemented here
 * (M4, blocked on decision 1) and never emitted.
 *
 * Precedence is fixed and mirrors `evaluateSellSignal`'s discipline of taking the instant as an
 * argument: no network, no IndexedDB, no `Date.now()` inside this function.
 *
 * 1. Price history off → `review`/`price_history_disabled`. Nothing below this line runs on
 *    guesswork: `docs/PRODUCT.md:28` forbids treating "unknown" as "safe to sell". This gates rule
 *    (b) too: a festival item's window has nothing to read against without the merged series.
 * 2. Rule (b): the item has a festival calendar entry → `evaluateSeasonalRule` decides, and its
 *    verdict is final (never falls through to rule (c) below; only the absence of a calendar entry
 *    does that). `undecidable` → `review` with the EXACT reason `evaluateSellSignal` gave. Today
 *    inside the item's own selling window → `sell`/`seasonal_sell_window`, `until` = the window's
 *    own close. Today outside it with a qualifying bid → `sell`/`bid_above_reference`. Today
 *    outside it without one → `sell_at_season`/`seasonal_hold`, `until` = the window's NEXT open.
 * 3. Capital below the threshold → `hold`/`below_capital_threshold`. Too little is parked here to
 *    make the recommendation worth acting on either way.
 * 4. `insufficient_history` → `review`/`price_history_insufficient`, NEVER `hold`: "I don't know"
 *    and "it's cheap" are opposite recommendations that must never share an outcome.
 * 5. Percentile at or above the local p90 → `sell`/`bid_above_reference`; otherwise
 *    `hold`/`below_local_band`.
 */
export function recommendPosition(input: PositionRecommendationInput): PositionRecommendationV1 {
	if (!input.priceHistoryEnabled) {
		return {
			action: 'review', reason: 'price_history_disabled', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: null,
		};
	}
	if (input.seasonal !== null) {
		return evaluateSeasonalRule(input.seasonal, input.priceHistoryDaily, input.capturedAtMs, input);
	}
	if (input.totalSellCopper === null || input.totalSellCopper < input.capitalThresholdCopper) {
		return {
			action: 'hold', reason: 'below_capital_threshold', until: priceUntil(input), missing: null,
			pricePercentile: null, priceCoverageDays: null,
		};
	}
	// `calculatePriceHistoryPercentile` slices the last `windowDays` ENTRIES, not calendar days: a
	// series with holes can let `.slice(-windowDays)` reach back across a gap of missing days and
	// silently describe a longer span than the window's name promises. Filtering by `dayUtc` first
	// (the same discipline `evaluateSellSignal` already applies) guarantees the entries that reach
	// the statistic never fall outside the actual calendar window, holes and all.
	const windowed = filterByCalendarWindow(input.priceHistoryDaily, input.capturedAtMs, input.priceHistoryWindowDays);
	const percentile = calculatePriceHistoryPercentile(
		windowed, 'bid', input.priceHistoryWindowDays, input.priceHistoryRequiredDays,
	);
	if (percentile.status === 'insufficient_history') {
		return {
			action: 'review', reason: 'price_history_insufficient', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: percentile.coveredDays,
		};
	}
	return percentile.percentile >= 90
		? {
			action: 'sell', reason: 'bid_above_reference', until: priceUntil(input), missing: null,
			pricePercentile: Math.round(percentile.percentile), priceCoverageDays: percentile.coveredDays,
		}
		: {
			action: 'hold', reason: 'below_local_band', until: priceUntil(input), missing: null,
			pricePercentile: Math.round(percentile.percentile), priceCoverageDays: percentile.coveredDays,
		};
}

function priceUntil(input: PositionRecommendationInput): string {
	return new Date(input.capturedAtMs + input.maxPriceAgeMs).toISOString();
}

/**
 * Rule (b), corrected: the calendar window is when the item is worth SELLING (the measured peak),
 * not when its price sits on the floor. `evaluateSellSignal`'s own `inSeason` flag and `sell` signal
 * are read as-is rather than reinterpreted: `inSeason` is exactly "today is inside the item's
 * selling window" now that the window passed in IS that window, and `signal === 'sell'` is exactly
 * "today's bid clears `minimumOfMaxBps` of the trailing year's max" — the same comparison rule (c)'s
 * sibling statement uses, reused rather than rewritten. A calendar entry always produces a verdict
 * here; unlike before M3's fix, there is no case that falls through to rule (c).
 *
 * 1. `undecidable` → `review` with the EXACT reason `evaluateSellSignal` gave.
 * 2. Inside the window → `sell`/`seasonal_sell_window`, `until` = this window's own close. This is
 *    the measured best moment; no percentile is required on top of it.
 * 3. Outside the window, bid clears the reference → `sell`/`bid_above_reference` (an out-of-season
 *    opportunity, taken), `until` = the ordinary price-based expiry.
 * 4. Outside the window, bid does not clear it → `sell_at_season`/`seasonal_hold`, `until` = the
 *    window's NEXT open, not its close: the point is to wait for the next good moment to sell, not
 *    to expire the recommendation at a date that already passed.
 */
function evaluateSeasonalRule(
	seasonal: PositionRecommendationSeasonalInput,
	priceHistoryDaily: readonly PriceHistoryDailyV1[],
	capturedAtMs: number,
	input: PositionRecommendationInput,
): PositionRecommendationV1 {
	const series = toSellSignalSeries(priceHistoryDaily);
	const projection = evaluateSellSignal(series, capturedAtMs, seasonal.parameters, seasonal.window);
	if (projection.status === 'undecidable') {
		return {
			action: 'review', reason: projection.reason, until: null, missing: null,
			pricePercentile: null, priceCoverageDays: null,
		};
	}
	if (projection.inSeason) {
		const closesAfterMs = seasonalWindowClosesAfterMs(seasonal.window, capturedAtMs);
		if (closesAfterMs === null) {
			return {
				action: 'review', reason: 'undecidable_calendar', until: null, missing: null,
				pricePercentile: null, priceCoverageDays: null,
			};
		}
		return {
			action: 'sell', reason: 'seasonal_sell_window', until: new Date(closesAfterMs).toISOString(), missing: null,
			pricePercentile: null, priceCoverageDays: null,
		};
	}
	if (projection.signal === 'sell') {
		return {
			action: 'sell', reason: 'bid_above_reference', until: priceUntil(input), missing: null,
			pricePercentile: null, priceCoverageDays: null,
		};
	}
	const opensAfterMs = seasonalWindowOpensAfterMs(seasonal.window, capturedAtMs);
	if (opensAfterMs === null) {
		return {
			action: 'review', reason: 'undecidable_calendar', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: null,
		};
	}
	return {
		action: 'sell_at_season', reason: 'seasonal_hold', until: new Date(opensAfterMs).toISOString(), missing: null,
		pricePercentile: null, priceCoverageDays: null,
	};
}

/**
 * `priceHistoryDaily` is already the merged (seed ∪ capture) series decision 4 built for rule (c)
 * (`price-seed-history-merge.ts`, applied by the caller before this function runs): reusing it here
 * is what makes the SAME series answer both rules, as `docs/SPEC-recomendacion-por-objeto.md` §3.b
 * requires. This is a local, deliberately-duplicated slice of `mergeSellSignalSeries`'s own
 * dayUtc-keyed close extraction (`src/economy/sell-signal.ts`): the input shape here is a single
 * already-item-filtered list, not a seed plus a daily list to union, so calling that function would
 * need a synthetic empty seed for no benefit.
 */
function toSellSignalSeries(daily: readonly PriceHistoryDailyV1[]): SellSignalSeries {
	const byDay = new Map<string, number>();
	for (const entry of daily) {
		const close = entry.bid?.closeCopper;
		if (close === undefined || close === null || !Number.isSafeInteger(close) || close < 0) continue;
		byDay.set(entry.dayUtc, close);
	}
	const days = [...byDay.entries()]
		.map(([dayUtc, bidCopper]) => ({ dayUtc, bidCopper }))
		.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
	// `origin` is carried through to the projection but never read by anything downstream of it
	// here (`sellSignalGainCopper`'s absolute-gain math is the runtime's concern, not the note
	// field's); `'seeded'` is a documented, harmless placeholder rather than a third boolean no
	// caller needs.
	return { origin: 'seeded', days };
}

/** Keeps only the days that fall inside `windowDays` calendar days back from `nowMs`, today included. */
function filterByCalendarWindow(
	daily: readonly PriceHistoryDailyV1[],
	nowMs: number,
	windowDays: number,
): PriceHistoryDailyV1[] {
	const today = priceHistoryDayUtc(nowMs);
	const from = priceHistoryDayUtc(Math.max(0, nowMs - windowDays * DAY_MS));
	return daily.filter((entry) => entry.dayUtc > from && entry.dayUtc <= today);
}
