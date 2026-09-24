import { calculateTradingPostFees } from './gw2-fees';
import { PRICE_SEED_CHART_MAX_DAYS } from './price-seed-model';
import { festivalCalendarEntryForItem, type FestivalCalendarV1 } from './seasonal-window';
import {
	HALLOWEEN_FESTIVAL_STARTS,
	SELL_TIMING_MINIMUM_TEST_YEARS_WITH_DATA,
	SELL_TIMING_TEST_YEARS,
	SELL_TIMING_TRAIN_YEARS,
	SELL_TIMING_WAIT_STRATEGIES,
	nextMayWindowFor,
	preFestivalWindowFor,
	runSellTimingExperiment,
	type SellTimingFestivalYear,
	type SellTimingPriceDay,
	type SellTimingOutOfSampleVerdict,
	type SellTimingStrategy,
	type SellTimingWindow,
	type SellTimingYearEvaluation,
} from './sell-timing-experiment';

/**
 * H18.19 (audit 2026-09-24 §3.D): "sell now or wait", as a quantified comparison instead of a
 * calendar.
 *
 * The question the player asks is whether waiting for a later window pays more than selling the
 * units they are free to sell, today, the same way (instant sale or listing). This answers it with
 * the SAME pipeline and the SAME out-of-sample criterion the published experiment uses
 * (`runSellTimingExperiment` + `summarizeOutOfSampleAdvantage`, `sell-timing-experiment.ts`): the
 * wait strategy is chosen on the training years alone, and it only counts as an advantage when it
 * also wins on the held-out years. No second criterion exists: this module never grades waiting on
 * its own.
 *
 * What it adds on top of the experiment, and nothing more:
 * - Today's own place in the festival calendar: every past year is graded from the same distance to
 *   its edition's real start as today is to the next one (`decisionOffsetDays`), and only with
 *   prices strictly before today. A past year whose windows have not both closed yet is not graded.
 * - Money, for the player's own stack: the median ratio and its range become a net advantage in
 *   copper for `quantity` units at today's quote, both sides after the same trading-post fees.
 * - An honest abstention: `insufficient_data` when either the training or the test years lack
 *   `SELL_TIMING_MINIMUM_TEST_YEARS_WITH_DATA` graded seasons (the experiment's own floor), or when
 *   the next edition has no curated start date. Without training data the experiment falls back to
 *   `sell_now` and would call that "no demonstrated advantage"; here that is "insufficient data",
 *   because nothing was measured at all.
 *
 * Pure: data in, data out. It never fetches, reads a store or looks at the clock.
 */
export const SELL_OR_WAIT_VERSION = 1 as const;

/** Same mode on both sides: an instant sale is compared with a later instant sale, a listing with a later listing. */
export const SELL_OR_WAIT_MODES = ['instant', 'listing'] as const;
export type SellOrWaitMode = typeof SELL_OR_WAIT_MODES[number];

/**
 * - `wait`: the training-chosen wait beat selling now on the held-out years too.
 * - `no_demonstrated_advantage`: it did not ("sin ventaja demostrada para esperar"), or the training
 *   years already said no wait beats selling now.
 * - `insufficient_data`: too few graded seasons to say either ("datos insuficientes").
 */
export const SELL_OR_WAIT_VERDICTS = ['wait', 'no_demonstrated_advantage', 'insufficient_data'] as const;
export type SellOrWaitVerdict = typeof SELL_OR_WAIT_VERDICTS[number];

export const SELL_OR_WAIT_STRATEGIES = ['sell_now', ...SELL_TIMING_WAIT_STRATEGIES] as const satisfies readonly SellTimingStrategy[];

export interface SellOrWaitInput {
	/** The instant the player decides at. Never `Date.now()`: the caller supplies it. */
	nowMs: number;
	mode: SellOrWaitMode;
	/** The units free to act on (not reserved, not kept). */
	quantity: number;
	/** Today's live quote per unit in `mode` (best buy order for `instant`, lowest listing for `listing`). */
	todayUnitCopper: number;
	/** The same side's daily closes (bid for `instant`, ask for `listing`). Days on or after today are ignored. */
	history: readonly SellTimingPriceDay[];
	/** Real per-year festival starts; defaults to the experiment's own table. */
	festivals?: readonly SellTimingFestivalYear[];
}

/**
 * One comparison. `quantity`, `unitCopper` and `mode` are its basis: a different free quantity (a
 * reservation or a keep exception moved), a different quote or the other sale mode is a different
 * comparison, and every analysis recomputes it from the live values rather than carrying an old one.
 *
 * The copper figures are net of trading-post fees and signed: positive when waiting would have paid
 * more than selling now, negative when it would have paid less. `netAdvantageCopper` is the median
 * season, `netAdvantageLowCopper`/`netAdvantageHighCopper` the worst and best graded seasons. They
 * are null for `insufficient_data`, whose few seasons are counted but never turned into a range.
 * `seasonsLost` is the risk of not selling now: the graded seasons in which waiting paid less.
 */
export interface SellOrWaitComparisonV1 {
	version: typeof SELL_OR_WAIT_VERSION;
	verdict: SellOrWaitVerdict;
	mode: SellOrWaitMode;
	/** The wait the training years chose (`sell_now` when none beat selling now). */
	strategy: SellTimingStrategy;
	quantity: number;
	unitCopper: number;
	/** Days from today to the next edition's real start; null when that edition has no curated start. */
	decisionOffsetDays: number | null;
	/** The window to sell in when waiting, inclusive UTC days; null unless `verdict` is `wait`. */
	windowFromDay: string | null;
	windowToDay: string | null;
	seasons: number;
	seasonsWon: number;
	seasonsLost: number;
	medianRatio: number | null;
	lowRatio: number | null;
	highRatio: number | null;
	netAdvantageCopper: number | null;
	netAdvantageLowCopper: number | null;
	netAdvantageHighCopper: number | null;
}

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** Sell now or wait, for `quantity` units in `mode`, graded by the experiment's out-of-sample criterion. */
export function compareSellNowWithWaiting(input: SellOrWaitInput): SellOrWaitComparisonV1 {
	const festivals = [...(input.festivals ?? HALLOWEEN_FESTIVAL_STARTS)].sort((left, right) => left.year - right.year);
	const today = utcDay(input.nowMs);
	const basis = {
		version: SELL_OR_WAIT_VERSION, mode: input.mode, quantity: input.quantity, unitCopper: input.todayUnitCopper,
	} as const;
	const next = today === null ? undefined : festivals.find((festival) => festival.startsOnUtc > today);
	if (today === null || next === undefined || !positiveInteger(input.quantity) || !positiveInteger(input.todayUnitCopper)) {
		return abstain(basis, null, 0);
	}
	const decisionOffsetDays = Math.round((Date.parse(`${next.startsOnUtc}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
	// No look-ahead: a day on or after today is a price the player has not seen yet.
	const history = input.history.filter((day) => day.dayUtc < today && Number.isFinite(day.bidCopper) && day.bidCopper > 0);
	const byYear = new Map(festivals.map((festival) => [festival.year, festival]));
	// A season is graded only once both of its windows have closed before today.
	const closed = (year: number): boolean => {
		const festival = byYear.get(year);
		return festival !== undefined && festival.year < next.year && nextMayWindowFor(festival).toUtc < today;
	};
	const trainYears = SELL_TIMING_TRAIN_YEARS.filter(closed);
	const testYears = SELL_TIMING_TEST_YEARS.filter(closed);
	// The experiment's item id only labels its report; nothing here reads it.
	const result = runSellTimingExperiment(0, history, { trainYears, testYears, festivals, decisionOffsetDays });
	const trainSeasons = seasonsWithAWait(result.trainEvaluations);
	const testSeasons = seasonsWithAWait(result.testEvaluations);
	if (trainSeasons < SELL_TIMING_MINIMUM_TEST_YEARS_WITH_DATA || testSeasons < SELL_TIMING_MINIMUM_TEST_YEARS_WITH_DATA) {
		return abstain(basis, decisionOffsetDays, testSeasons);
	}
	const summary = result.outOfSample;
	const verdict = verdictOf(summary.verdict);
	if (verdict === 'insufficient_data') return abstain(basis, decisionOffsetDays, summary.yearsWithData);
	const window = verdict === 'wait' ? waitWindow(summary.strategy, next, decisionOffsetDays) : null;
	const advantage = (ratio: number | undefined): number | null => ratio === undefined ? null
		: netAdvantageCopper(input.todayUnitCopper, input.quantity, ratio);
	return {
		...basis,
		verdict,
		strategy: summary.strategy,
		decisionOffsetDays,
		windowFromDay: window?.fromUtc ?? null,
		windowToDay: window?.toUtc ?? null,
		seasons: summary.yearsWithData,
		seasonsWon: summary.yearsWon,
		seasonsLost: summary.yearsLost,
		medianRatio: summary.medianRatio ?? null,
		lowRatio: summary.minRatio ?? null,
		highRatio: summary.maxRatio ?? null,
		netAdvantageCopper: advantage(summary.medianRatio),
		netAdvantageLowCopper: advantage(summary.minRatio),
		netAdvantageHighCopper: advantage(summary.maxRatio),
	};
}

/**
 * What waiting would add (or take away) over selling now, net of the same trading-post fees on both
 * sides, for `quantity` units whose price moves by `ratio`. The fee policy is `gw2-fees.ts`'s own.
 */
export function netAdvantageCopper(unitCopper: number, quantity: number, ratio: number): number {
	const grossNow = unitCopper * quantity;
	return netProceedsCopper(Math.round(grossNow * ratio)) - netProceedsCopper(grossNow);
}

/**
 * The same comparison for another number of units at the same quote: the seasons, verdict and
 * ratios do not depend on the quantity, the copper figures do. Used where one object's comparison
 * is read for a different share of it (an advisor row covering several notes, or one note of
 * several), so every surface states the advantage for exactly the units it shows. Null for no units.
 */
export function sellOrWaitForQuantity(comparison: SellOrWaitComparisonV1, quantity: number): SellOrWaitComparisonV1 | null {
	if (!positiveInteger(quantity)) return null;
	if (quantity === comparison.quantity) return comparison;
	const advantage = (ratio: number | null): number | null => ratio === null ? null
		: netAdvantageCopper(comparison.unitCopper, quantity, ratio);
	return {
		...comparison,
		quantity,
		netAdvantageCopper: advantage(comparison.medianRatio),
		netAdvantageLowCopper: advantage(comparison.lowRatio),
		netAdvantageHighCopper: advantage(comparison.highRatio),
	};
}

/**
 * How many days of the datawars2 seed to keep for `itemId`: the whole published history for an item
 * the festival calendar covers (the comparison grades seasons back to 2014, and the sell rule's own
 * year would leave it one season, always "insufficient data"), the seed's own default otherwise.
 * No calendar (the curated pack unavailable or expired) keeps the default: no comparison runs then.
 */
export function sellOrWaitSeedMaxDays(calendar: FestivalCalendarV1 | null, itemId: number): number | undefined {
	return calendar !== null && festivalCalendarEntryForItem(calendar, itemId) !== null ? PRICE_SEED_CHART_MAX_DAYS : undefined;
}

/** Structural check for a comparison carried through notes and cached results. */
export function isSellOrWaitComparison(value: unknown): value is SellOrWaitComparisonV1 {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return entry.version === SELL_OR_WAIT_VERSION
		&& (SELL_OR_WAIT_VERDICTS as readonly unknown[]).includes(entry.verdict)
		&& (SELL_OR_WAIT_MODES as readonly unknown[]).includes(entry.mode)
		&& (SELL_OR_WAIT_STRATEGIES as readonly unknown[]).includes(entry.strategy)
		&& positiveInteger(entry.quantity) && positiveInteger(entry.unitCopper)
		&& (entry.decisionOffsetDays === null || positiveInteger(entry.decisionOffsetDays))
		&& nullableDay(entry.windowFromDay) && nullableDay(entry.windowToDay)
		&& (entry.windowFromDay === null) === (entry.windowToDay === null)
		&& (entry.windowFromDay !== null) === (entry.verdict === 'wait')
		&& nonNegativeInteger(entry.seasons) && nonNegativeInteger(entry.seasonsWon) && nonNegativeInteger(entry.seasonsLost)
		&& entry.seasonsWon + entry.seasonsLost <= entry.seasons
		&& nullableRatio(entry.medianRatio) && nullableRatio(entry.lowRatio) && nullableRatio(entry.highRatio)
		&& nullableInteger(entry.netAdvantageCopper) && nullableInteger(entry.netAdvantageLowCopper)
		&& nullableInteger(entry.netAdvantageHighCopper);
}

function abstain(
	basis: Pick<SellOrWaitComparisonV1, 'version' | 'mode' | 'quantity' | 'unitCopper'>,
	decisionOffsetDays: number | null,
	seasons: number,
): SellOrWaitComparisonV1 {
	return {
		...basis, verdict: 'insufficient_data', strategy: 'sell_now', decisionOffsetDays,
		windowFromDay: null, windowToDay: null, seasons, seasonsWon: 0, seasonsLost: 0,
		medianRatio: null, lowRatio: null, highRatio: null,
		netAdvantageCopper: null, netAdvantageLowCopper: null, netAdvantageHighCopper: null,
	};
}

function verdictOf(verdict: SellTimingOutOfSampleVerdict): SellOrWaitVerdict {
	return verdict === 'advantage_demonstrated' ? 'wait' : verdict;
}

function waitWindow(strategy: SellTimingStrategy, next: SellTimingFestivalYear, decisionOffsetDays: number): SellTimingWindow | null {
	if (strategy === 'wait_pre_festival') return preFestivalWindowFor(next, decisionOffsetDays);
	if (strategy === 'wait_next_may') return nextMayWindowFor(next);
	return null;
}

/** Seasons whose decision day had a price and at least one wait window had days: the ones that grade anything. */
function seasonsWithAWait(evaluations: readonly SellTimingYearEvaluation[]): number {
	return evaluations.filter((evaluation) => evaluation.status === 'evaluated'
		&& SELL_TIMING_WAIT_STRATEGIES.some((strategy) => evaluation.ratios[strategy] !== undefined)).length;
}

function netProceedsCopper(grossCopper: number): number {
	if (!Number.isSafeInteger(grossCopper) || grossCopper <= 0) return 0;
	const fees = calculateTradingPostFees(grossCopper);
	return fees.status === 'ok' ? grossCopper - fees.fees.totalFeesCopper : 0;
}

function utcDay(epochMs: number): string | null {
	if (!Number.isSafeInteger(epochMs) || epochMs < 0) return null;
	const date = new Date(epochMs);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableInteger(value: unknown): boolean {
	return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function nullableRatio(value: unknown): boolean {
	return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function nullableDay(value: unknown): boolean {
	return value === null || (typeof value === 'string' && DAY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)));
}
