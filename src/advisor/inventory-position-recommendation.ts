import { priceHistoryDayUtc, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import { calculatePriceHistoryPercentile } from '../economy/price-history-statistics';
import { compareSellNowWithWaiting, type SellOrWaitComparisonV1 } from '../economy/sell-or-wait';
import { evaluateSellSignal, type SellSignalParameters, type SellSignalSeries } from '../economy/sell-signal';
import { seasonalWindowClosesAfterMs, type SeasonalWindowV1 } from '../economy/seasonal-window';

/**
 * Per-position sell/hold recommendation (SPEC-recomendacion-por-objeto).
 *
 * `hold_for_legendary` is a member of the closed union the frontmatter schema needs from day one,
 * exactly like `docs/SPEC-recomendacion-por-objeto.md` §2.1 requires: `tc_recommendation` never
 * grows a new value on the day M4 lands. `recommendPosition` implements rule (a) (M4, this
 * commit) ahead of rules (b) and (c) (M3).
 */
export const POSITION_RECOMMENDATION_ACTIONS = ['sell', 'hold', 'hold_for_legendary', 'sell_at_season', 'review'] as const;
export type PositionRecommendationAction = typeof POSITION_RECOMMENDATION_ACTIONS[number];

/**
 * Closed reason-code set for rules (a), (b) and (c). `reserved_for_goal` is rule (a)'s only reason
 * (M4): every `hold_for_legendary` verdict carries it, there is no second legendary reason code to
 * distinguish.
 *
 * The four `undecidable`-shaped codes (`malformed_input`, `no_close_today`, `insufficient_reference`,
 * `undecidable_calendar`) are `evaluateSellSignal`'s OWN `SellSignalProjection['reason']` values
 * (`src/economy/sell-signal.ts`), carried through verbatim rather than re-coded: a `review` that
 * hides which of the four things went wrong is exactly the ambiguity §3.b's precedence exists to
 * avoid.
 *
 * H18.1/H18.2 (audit 2026-09-24 §3.A) add two codes, appended so every earlier value keeps its
 * meaning: `reservation_uncertain` (a chosen goal has no materials table, so how much of this
 * position is free is unknown, never assumed free) and `price_unknown` (no quote today, or no
 * demonstrated value: "I don't know what it's worth" is not "it's worth little"). `not_tradeable`
 * (the trading post will never quote it for this account: bound, or outside the free-to-play
 * whitelist) keeps "no price today" from reading as doubt when there is no price to have.
 *
 * H18.19 (audit 2026-09-24 §3.D) appends three, the outcomes of the sell-now-or-wait comparison
 * (`compareSellNowWithWaiting`): `wait_advantage_demonstrated` (waiting beat selling now out of
 * sample), `no_demonstrated_wait_advantage` ("sin ventaja demostrada para esperar": sell now, with
 * that reason in view) and `wait_evidence_insufficient` ("datos insuficientes": sell now too, since
 * nothing demonstrates that waiting pays). `seasonal_hold` stays in the list so every note already
 * written keeps validating, but no rule emits it any more: the calendar alone never makes anyone wait.
 */
export const POSITION_RECOMMENDATION_REASON_CODES = [
	'reserved_for_goal',
	'reservation_uncertain',
	'price_unknown',
	'not_tradeable',
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
	'wait_advantage_demonstrated',
	'no_demonstrated_wait_advantage',
	'wait_evidence_insufficient',
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
	/**
	 * How long this analysis holds (ISO-8601): the capture instant plus `maxPriceAgeMs`, or null
	 * when the verdict does not rest on today's price (reservations, `review` of any kind).
	 *
	 * H18.19: ONLY that. Before, a seasonal verdict put its window's open or close here instead
	 * (audit 2026-09-24, Anexo 3), so one field meant two clocks depending on the rule. The three
	 * clocks now live apart: when the price was quoted (`priceQuotedAt`, `priceHistoryLastDay`), how
	 * long the analysis holds (`until`), and the window it suggests selling in (`sellWindowFromDay`
	 * .. `sellWindowToDay`).
	 */
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
	/**
	 * H18.2: when the live quote this verdict read as TODAY's price was taken (ISO-8601), or null
	 * when the verdict does not rest on today's price (reservations, `review` of any kind). Its own
	 * field on purpose: `until` already alternates between a price expiry and a seasonal window's
	 * open or close (audit 2026-09-24, Anexo 3), and the quote's date is a third clock, not either.
	 */
	priceQuotedAt: string | null;
	/**
	 * H18.2: the last UTC day (`YYYY-MM-DD`) of the price HISTORY the verdict compared today's quote
	 * against, strictly before today, or null when no history was read (or none exists). A history
	 * that ends 60 days ago says so here instead of passing for today's price.
	 */
	priceHistoryLastDay: string | null;
	/**
	 * H18.19: the window this verdict suggests selling in, as inclusive UTC days (`YYYY-MM-DD`), or
	 * null when it suggests none. Set only by rule (b): the item's own calendar window when today's
	 * price confirms it (`seasonal_sell_window`), or the window a demonstrated wait points at
	 * (`wait_advantage_demonstrated`). Never a date the evidence does not back.
	 */
	sellWindowFromDay: string | null;
	sellWindowToDay: string | null;
	/**
	 * H18.19: sell now or wait, for this position's free quantity, in the instant-sale mode rule (b)
	 * reads (today's bid against the bid history). Computed for every item with a festival calendar
	 * entry once rule (b) can read its series, null everywhere else.
	 */
	sellOrWait: SellOrWaitComparisonV1 | null;
}

export interface PositionRecommendationInput {
	/** The instant to evaluate against, in epoch ms. Never `Date.now()`: the caller supplies it. */
	capturedAtMs: number;
	/** `priceHistoryEnabled` from settings (opt-in, off by default). */
	priceHistoryEnabled: boolean;
	/**
	 * The value rule (c)'s capital-threshold check (below) compares against `capitalThresholdCopper`.
	 * Since 11 sep 2026 (David) this is measured PER ITEM, not per position: the caller
	 * (`attachPositionRecommendations`, `src/inventory/inventory-vault-sync.ts`) sums
	 * `tc_total_sell_copper` across every position holding the same `itemId` before calling
	 * `recommendPosition`, so every position of one object gets the same threshold verdict. Before
	 * that date this was one position's own `tc_total_sell_copper`, which let an object split across
	 * several notes (different characters or containers) read `below_capital_threshold` on some of
	 * its notes while the object as a whole cleared the threshold comfortably.
	 */
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
	/**
	 * Rule (a), M4: `null` when this position's item is not part of any active legendary
	 * requirement this sync. A non-null, positive shortfall is the item-level (account-wide)
	 * missing quantity `createReservationPlan` computed for it — identical across every position
	 * holding the item, since the shortage is a property of the material, not of any one stack —
	 * and wins over every rule below unconditionally, including "price history disabled": whether
	 * to hold for a legendary goal never depends on having a price. A non-null shortfall of 0 means
	 * the material is fully reserved already; this position's own `totalSellCopper` is expected to
	 * already be scaled down to its free share by the caller (`scaledSellCopper`,
	 * `src/economy/legendary-goals.ts`) before rules (b)/(c) below ever see it.
	 */
	legendaryShortfall: number | null;
	/**
	 * H18.1: how much of THIS position no reservation holds back. The whole quantity when no goal
	 * touches the item; 0 when a goal reserves every unit of it (the position must never read
	 * `sell`, whatever its price or season); null when a chosen goal has no materials table (or the
	 * reservation plan could not be built), so the free share is unknown and never assumed free.
	 */
	freeQuantity: number | null;
	/**
	 * H18.2: today's instant-sell quote per unit (the best buy order), taken at `capturedAtMs` in
	 * the same capture, or null when there is none. This, never the last historical close, is
	 * "today's price": without it no time-bound recommendation is emitted at all.
	 */
	todayBidCopper: number | null;
	/**
	 * True only when this account can DEFINITELY not sell the item on the trading post: bound to
	 * the account or a character, or outside the free-to-play whitelist. The caller derives it from
	 * `classifyItemLiquidity`/`isTradingPostAccessible`; an unknown binding or a missing catalog
	 * entry is NOT untradeable, it stays a doubt (`price_unknown`).
	 */
	untradeable: boolean;
}

const DAY_MS = 86_400_000;

/** Every evidence field a verdict carries, all empty: each branch fills only what it measured. */
const NO_EVIDENCE = {
	missing: null, pricePercentile: null, priceCoverageDays: null, priceQuotedAt: null, priceHistoryLastDay: null,
	sellWindowFromDay: null, sellWindowToDay: null, sellOrWait: null,
} as const satisfies Partial<PositionRecommendationV1>;

/** A percentile at or above this is "the high band of its history" (rule (c)). */
const HIGH_BAND_PERCENTILE = 90;

/**
 * Rules (b) and (c) of the recommendation spec, in precedence order. (a) is not implemented here
 * (M4, blocked on decision 1) and never emitted.
 *
 * Precedence is fixed and mirrors `evaluateSellSignal`'s discipline of taking the instant as an
 * argument: no network, no IndexedDB, no `Date.now()` inside this function.
 *
 * 0. Rule (a), M4: `legendaryShortfall` is not null and greater than 0 → `hold_for_legendary`/
 *    `reserved_for_goal`, `missing` = the shortfall, `until` = null (no price-based expiry: the
 *    hold ends when the account has enough, not when a price quote goes stale). This precedes
 *    EVERY rule below, including rule 1: whether the account owns enough of a legendary's material
 *    has nothing to do with whether price history is on.
 *    H18.1: `freeQuantity` 0 (a goal reserves every unit of this position, shortfall or not) →
 *    `hold_for_legendary`/`reserved_for_goal` too: a reserved stack has nothing to sell, so no
 *    season, price or capital can turn it into `sell`. `freeQuantity` null (a chosen goal without
 *    a materials table) → `review`/`reservation_uncertain`: unknown is shown as unknown, not free.
 *    Then `untradeable` → `hold`/`not_tradeable`, `until` = null: an item the trading post will
 *    never quote for this account has no price to wait for, so it is neither a doubt (`review`)
 *    nor gated on price history being on.
 * 1. Price history off → `review`/`price_history_disabled`. Nothing below this line runs on
 *    guesswork: `docs/PRODUCT.md:28` forbids treating "unknown" as "safe to sell". This gates rule
 *    (b) too: a festival item's window has nothing to read against without the merged series.
 *    H18.2: no quote today (`todayBidCopper` null) → `review`/`price_unknown`, before rule (b):
 *    without today's price there is no time-bound recommendation to make, seasonal or not. From
 *    here on today's quote is the observation both rules compare, never the last historical close.
 * 2. Rule (b): the item has a festival calendar entry → `evaluateSeasonalRule` decides, and its
 *    verdict is final (never falls through to rule (c) below; only the absence of a calendar entry
 *    does that). `undecidable` → `review` with the EXACT reason `evaluateSellSignal` gave. H18.19:
 *    otherwise the sell-now-or-wait comparison decides whether to wait, and today's price, never the
 *    calendar alone, whether now is an opportunity; see `evaluateSeasonalRule`.
 * 3. No demonstrated value (`totalSellCopper` null) → `review`/`price_unknown` (H18.2): "I don't
 *    know what it's worth" is never "it's worth little". Capital below the threshold →
 *    `hold`/`below_capital_threshold`. Too little is parked here to make the recommendation worth
 *    acting on either way. Since 11 sep 2026, `totalSellCopper` is the caller's per-item sum (see
 *    the field's own doc comment), not this one position's value.
 * 4. `insufficient_history` → `review`/`price_history_insufficient`, NEVER `hold`: "I don't know"
 *    and "it's cheap" are opposite recommendations that must never share an outcome.
 * 5. Today's quote at or above the local p90 of the history → `sell`/`bid_above_reference`;
 *    otherwise `hold`/`below_local_band`. H18.19: a p90 reached only through ties (a flat series, or
 *    today at the level the history sits on) is not the high band of anything: the percentile
 *    counts every equal day as "at or below", so a flat series used to read p100. It is
 *    `sell`/`no_demonstrated_wait_advantage` instead, without a percentile: not an exceptional
 *    opportunity, and no sign that waiting would pay more either.
 */
export function recommendPosition(input: PositionRecommendationInput): PositionRecommendationV1 {
	if (input.legendaryShortfall !== null && input.legendaryShortfall > 0) {
		return {
			action: 'hold_for_legendary', reason: 'reserved_for_goal', until: null,
			...NO_EVIDENCE, missing: input.legendaryShortfall,
		};
	}
	if (input.freeQuantity === 0) {
		return {
			action: 'hold_for_legendary', reason: 'reserved_for_goal', until: null,
			...NO_EVIDENCE, missing: input.legendaryShortfall ?? 0,
		};
	}
	if (input.freeQuantity === null) {
		return { action: 'review', reason: 'reservation_uncertain', until: null, ...NO_EVIDENCE };
	}
	if (input.untradeable) {
		return { action: 'hold', reason: 'not_tradeable', until: null, ...NO_EVIDENCE };
	}
	if (!input.priceHistoryEnabled) {
		return { action: 'review', reason: 'price_history_disabled', until: null, ...NO_EVIDENCE };
	}
	if (input.todayBidCopper === null) {
		return { action: 'review', reason: 'price_unknown', until: null, ...NO_EVIDENCE };
	}
	const todayBidCopper = input.todayBidCopper;
	// Today's own day is dropped from the history: today's quote is the observation, and a close
	// the local capture already recorded for today must not also sit in its own reference.
	const history = historyBeforeToday(input.priceHistoryDaily, input.capturedAtMs);
	const priceHistoryLastDay = lastBidDay(history);
	const priceQuotedAt = new Date(input.capturedAtMs).toISOString();
	if (input.seasonal !== null) {
		return evaluateSeasonalRule(input.seasonal, history, todayBidCopper, priceHistoryLastDay, input);
	}
	if (input.totalSellCopper === null) {
		return { action: 'review', reason: 'price_unknown', until: null, ...NO_EVIDENCE };
	}
	if (input.totalSellCopper < input.capitalThresholdCopper) {
		return {
			action: 'hold', reason: 'below_capital_threshold', until: priceUntil(input), ...NO_EVIDENCE, priceQuotedAt,
		};
	}
	// `calculatePriceHistoryPercentile` slices the last `windowDays` ENTRIES, not calendar days: a
	// series with holes can let `.slice(-windowDays)` reach back across a gap of missing days and
	// silently describe a longer span than the window's name promises. Filtering by `dayUtc` first
	// (the same discipline `evaluateSellSignal` already applies) guarantees the entries that reach
	// the statistic never fall outside the actual calendar window, holes and all.
	const windowed = filterByCalendarWindow(history, input.capturedAtMs, input.priceHistoryWindowDays);
	const percentile = calculatePriceHistoryPercentile(
		windowed, 'bid', input.priceHistoryWindowDays, input.priceHistoryRequiredDays, todayBidCopper,
	);
	if (percentile.status === 'insufficient_history') {
		return {
			action: 'review', reason: 'price_history_insufficient', until: null,
			...NO_EVIDENCE, priceCoverageDays: percentile.coveredDays, priceHistoryLastDay,
		};
	}
	if (percentile.percentile >= HIGH_BAND_PERCENTILE && !clearsHighBandStrictly(windowed, todayBidCopper)) {
		return {
			action: 'sell', reason: 'no_demonstrated_wait_advantage', until: priceUntil(input),
			...NO_EVIDENCE, priceCoverageDays: percentile.coveredDays, priceQuotedAt, priceHistoryLastDay,
		};
	}
	const measured = {
		...NO_EVIDENCE, pricePercentile: Math.round(percentile.percentile), priceCoverageDays: percentile.coveredDays,
		priceQuotedAt, priceHistoryLastDay,
	};
	return percentile.percentile >= HIGH_BAND_PERCENTILE
		? { action: 'sell', reason: 'bid_above_reference', until: priceUntil(input), ...measured }
		: { action: 'hold', reason: 'below_local_band', until: priceUntil(input), ...measured };
}

/**
 * Whether today's quote reaches the high band counting only the days it strictly beats (today
 * itself included among the points, as `calculatePriceHistoryPercentile` does). `windowed` is
 * already the statistic's own reference: filtered to the calendar window and strictly before
 * today, so it never holds more than `windowDays - 1` entries and the statistic's slice is a no-op.
 */
function clearsHighBandStrictly(windowed: readonly PriceHistoryDailyV1[], todayCopper: number): boolean {
	const reference = windowed.map((entry) => entry.bid?.closeCopper ?? null).filter((value): value is number => value !== null);
	const strictlyBelow = reference.filter((value) => value < todayCopper).length;
	return (strictlyBelow / (reference.length + 1)) * 100 >= HIGH_BAND_PERCENTILE;
}

function priceUntil(input: PositionRecommendationInput): string {
	return new Date(input.capturedAtMs + input.maxPriceAgeMs).toISOString();
}

/** The entries strictly before `nowMs`'s own UTC day: the history today's quote is compared against. */
function historyBeforeToday(daily: readonly PriceHistoryDailyV1[], nowMs: number): PriceHistoryDailyV1[] {
	const today = priceHistoryDayUtc(nowMs);
	return daily.filter((entry) => entry.dayUtc < today);
}

/** The latest `dayUtc` carrying a usable bid close, or null when the history has none. */
function lastBidDay(history: readonly PriceHistoryDailyV1[]): string | null {
	let last: string | null = null;
	for (const entry of history) {
		const close = entry.bid?.closeCopper;
		if (close === undefined || close === null) continue;
		if (last === null || entry.dayUtc > last) last = entry.dayUtc;
	}
	return last;
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
 * 2. H18.19: the sell-now-or-wait comparison (`compareSellNowWithWaiting`, the published
 *    experiment's own out-of-sample criterion, for this position's free quantity at today's bid)
 *    demonstrates that waiting pays → `sell_at_season`/`wait_advantage_demonstrated`, with the
 *    window it points at as the suggested window. Only a demonstrated advantage makes anyone wait.
 * 3. Today's price confirms the opportunity: it clears the pack's share of the year's maximum
 *    (`minimumOfMaxBps`, the comparison `evaluateSellSignal` already makes) AND sits above the
 *    year's minimum, so neither a flat series nor the floor passes for a peak. Inside the item's
 *    selling window → `sell`/`seasonal_sell_window`, the window's own days as the suggested window;
 *    outside it → `sell`/`bid_above_reference`, an out-of-season opportunity taken.
 * 4. Anything else sells now with its reason in view: `no_demonstrated_wait_advantage` or, when the
 *    comparison had too few seasons, `wait_evidence_insufficient`. This is the audit's C05 fix: the
 *    calendar alone never made a sale right when the price contradicts it, and it no longer makes
 *    anyone wait either; selling cheap stays a valid decision, with the motive shown.
 *
 * `until` is always the price-based validity of the analysis, never a window date.
 *
 * H18.2: `history` holds only days before today, and today's close handed to `evaluateSellSignal`
 * is `todayBidCopper`, the live quote, never a historical close that happens to be the latest.
 */
function evaluateSeasonalRule(
	seasonal: PositionRecommendationSeasonalInput,
	history: readonly PriceHistoryDailyV1[],
	todayBidCopper: number,
	priceHistoryLastDay: string | null,
	input: PositionRecommendationInput,
): PositionRecommendationV1 {
	const capturedAtMs = input.capturedAtMs;
	const historySeries = toSellSignalSeries(history);
	const series: SellSignalSeries = {
		...historySeries,
		days: [...historySeries.days, { dayUtc: priceHistoryDayUtc(capturedAtMs), bidCopper: todayBidCopper }],
	};
	const projection = evaluateSellSignal(series, capturedAtMs, seasonal.parameters, seasonal.window);
	const undecided = { until: null, ...NO_EVIDENCE, priceHistoryLastDay } as const;
	if (projection.status === 'undecidable') {
		return { action: 'review', reason: projection.reason, ...undecided };
	}
	const sellOrWait = compareSellNowWithWaiting({
		nowMs: capturedAtMs,
		mode: 'instant',
		// Rule (b) only runs with a known, positive free quantity: every earlier exit handled 0 and null.
		quantity: input.freeQuantity ?? 0,
		todayUnitCopper: todayBidCopper,
		history: historySeries.days,
	});
	const decided = {
		...NO_EVIDENCE, until: priceUntil(input), priceQuotedAt: new Date(capturedAtMs).toISOString(), priceHistoryLastDay, sellOrWait,
	};
	if (sellOrWait.verdict === 'wait') {
		return {
			action: 'sell_at_season', reason: 'wait_advantage_demonstrated', ...decided,
			sellWindowFromDay: sellOrWait.windowFromDay, sellWindowToDay: sellOrWait.windowToDay,
		};
	}
	const priceConfirms = projection.bidCopper >= projection.sellThresholdCopper
		&& projection.bidCopper > projection.referenceMinCopper;
	if (priceConfirms && projection.inSeason) {
		const window = currentWindowDays(seasonal.window, capturedAtMs);
		if (window === null) return { action: 'review', reason: 'undecidable_calendar', ...undecided };
		return { action: 'sell', reason: 'seasonal_sell_window', ...decided, sellWindowFromDay: window.from, sellWindowToDay: window.to };
	}
	if (priceConfirms) return { action: 'sell', reason: 'bid_above_reference', ...decided };
	return {
		action: 'sell',
		reason: sellOrWait.verdict === 'insufficient_data' ? 'wait_evidence_insufficient' : 'no_demonstrated_wait_advantage',
		...decided,
	};
}

/**
 * The inclusive UTC days of the window `nowMs` sits inside: its closing day from
 * `seasonalWindowClosesAfterMs` (whose exclusive end is the next midnight), its opening day in the
 * same year, or the year before for a window that wraps across new year. Null for an unreadable
 * window or clock, like the function it builds on.
 */
function currentWindowDays(window: SeasonalWindowV1, nowMs: number): { from: string; to: string } | null {
	const endsAt = seasonalWindowClosesAfterMs(window, nowMs);
	if (endsAt === null) return null;
	const to = priceHistoryDayUtc(endsAt - DAY_MS);
	const closingYear = Number.parseInt(to.slice(0, 4), 10);
	const openingYear = window.opensOn <= window.closesOn ? closingYear : closingYear - 1;
	return { from: `${String(openingYear)}-${window.opensOn}`, to };
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
