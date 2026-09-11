import { priceHistoryDayUtc, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import { calculatePriceHistoryPercentile } from '../economy/price-history-statistics';

/**
 * Per-position sell/hold recommendation (SPEC-recomendacion-por-objeto, M1).
 *
 * `hold_for_legendary` and `sell_at_season` are members of the closed union the frontmatter
 * schema needs from day one, exactly like `docs/SPEC-recomendacion-por-objeto.md` §2.1
 * requires: `tc_recommendation` never grows a new value on the day M3/M4 land. `recommendPosition`
 * below implements only rule (c) (M1) and never emits either of them.
 */
export const POSITION_RECOMMENDATION_ACTIONS = ['sell', 'hold', 'hold_for_legendary', 'sell_at_season', 'review'] as const;
export type PositionRecommendationAction = typeof POSITION_RECOMMENDATION_ACTIONS[number];

/**
 * Closed reason-code set for M1's rule (c) only. `hold_for_legendary` (M4) and `sell_at_season`
 * (M3) each bring their own reason codes when those milestones are implemented; widening this
 * union is that milestone's commit, not a speculative addition here.
 */
export const POSITION_RECOMMENDATION_REASON_CODES = [
	'price_history_disabled',
	'below_capital_threshold',
	'price_history_insufficient',
	'bid_above_reference',
	'below_local_band',
] as const;
export type PositionRecommendationReasonCode = typeof POSITION_RECOMMENDATION_REASON_CODES[number];

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
}

const DAY_MS = 86_400_000;

/**
 * Rule (c) of the recommendation spec: the only rule M1 implements.
 *
 * Precedence is fixed and mirrors `evaluateSellSignal`'s discipline of taking the instant as an
 * argument: no network, no IndexedDB, no `Date.now()` inside this function.
 *
 * 1. Price history off → `review`/`price_history_disabled`. Nothing below this line runs on
 *    guesswork: `docs/PRODUCT.md:28` forbids treating "unknown" as "safe to sell".
 * 2. Capital below the threshold → `hold`/`below_capital_threshold`. Too little is parked here to
 *    make the recommendation worth acting on either way.
 * 3. `insufficient_history` → `review`/`price_history_insufficient`, NEVER `hold`: "I don't know"
 *    and "it's cheap" are opposite recommendations that must never share an outcome.
 * 4. Percentile at or above the local p90 → `sell`/`bid_above_reference`; otherwise
 *    `hold`/`below_local_band`.
 */
export function recommendPosition(input: PositionRecommendationInput): PositionRecommendationV1 {
	if (!input.priceHistoryEnabled) {
		return {
			action: 'review', reason: 'price_history_disabled', until: null, missing: null,
			pricePercentile: null, priceCoverageDays: null,
		};
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
