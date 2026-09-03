import { HALLOWEEN_SEASONAL_WINDOW } from './models/halloween-season';
import { seasonalWindowStatusAtMs, type SeasonalWindowV1 } from './seasonal-window';
import type { PriceSeedV1 } from './price-seed-model';
import type { PriceHistoryDailyV1 } from './price-history-model';

/**
 * When to sell the bag and when to sit on it.
 *
 * This replaces a rule that could not fire. The previous one armed only inside
 * the festival window, compared today against the p90 of the PRECEDING THIRTY
 * DAYS, and required those thirty days to be consecutive captures of the
 * plugin's own. Every one of those three is wrong for this item:
 *
 * - The thirty days before the festival are September, the annual price peak,
 *   so the reference was at its highest exactly when the alert was armed.
 * - The bag is worth selling when it is EXPENSIVE, which is out of season. A
 *   rule armed only in season is armed only while the price is on the floor.
 * - Consecutive days meant one day without opening Obsidian voided the whole
 *   reference. The seeded series has real holes in it too (2025-10-25 to
 *   2025-10-29 is missing upstream), so consecutiveness is unobtainable.
 *
 * So the reference is a YEAR, sampled rather than enumerated: whatever days the
 * window happens to contain are the reference, a hole reduces the sample by one
 * day and nothing else. The only thing that can silence the rule is having
 * almost no days at all, which is a different statement and is said out loud as
 * `insufficient_reference`.
 */
export const SELL_SIGNAL_VERSION = 1 as const;

/** Length of the reference window, in days back from today. */
export const SELL_SIGNAL_REFERENCE_DAYS = 365;

/**
 * Fewest reference days the rule will decide on.
 *
 * Not a consecutiveness requirement: any thirty days inside the year will do,
 * in any arrangement. It exists so a fresh install with four days of capture
 * and no seed does not announce an annual maximum it measured over a long
 * weekend.
 */
export const SELL_SIGNAL_MINIMUM_REFERENCE_DAYS = 30;

export interface SellSignalSeriesDay {
	dayUtc: string;
	bidCopper: number;
}

/**
 * Where the series came from, carried so the interface can say it.
 *
 * `unseeded` is not a failure: it is the state of a plugin that has captured
 * its own days and never got the seed. The distinction matters because the
 * reference of an unseeded series covers weeks, not a year.
 */
export type SellSignalSeriesOrigin = 'seeded' | 'unseeded';

export interface SellSignalSeries {
	origin: SellSignalSeriesOrigin;
	/** Ascending by day and unique by day. */
	days: readonly SellSignalSeriesDay[];
}

export interface SellSignalParameters {
	/**
	 * Fraction of the annual maximum at which selling is worth saying, in basis
	 * points. It arrives from the curated pack, never from a constant here: the
	 * bag's amplitude drifts year on year and moving this must be a data
	 * publication that is hashed and reviewed, not an edit to a rule.
	 */
	minimumOfMaxBps: number;
	referenceDays: number;
	minimumReferenceDays: number;
}

export type SellSignalKind = 'sell' | 'hold' | 'none';

export interface SellSignalDecision {
	status: 'decided';
	signal: SellSignalKind;
	dayUtc: string;
	bidCopper: number;
	referenceMaxCopper: number;
	referenceMinCopper: number;
	/** How many days the window actually held. Holes reduce this; they do not void it. */
	referenceDayCount: number;
	/** The bid at which `sell` would start, derived from the pack percentage. */
	sellThresholdCopper: number;
	inSeason: boolean;
	origin: SellSignalSeriesOrigin;
}

export type SellSignalProjection =
	| { status: 'undecidable'; reason: 'malformed_input' | 'no_close_today' | 'insufficient_reference' | 'undecidable_calendar' }
	| SellSignalDecision;

const DAY_MS = 86_400_000;

/**
 * Evaluates today's close against the year behind it.
 *
 * The two signals are not symmetric on purpose. Selling is compared against a
 * PERCENTAGE of the maximum, because the exact annual top is a single day
 * nobody catches and waiting for it means never selling. Holding is compared
 * against the minimum exactly, because "this is the worst price of the year"
 * is a statement that should be true when it is made; the festival floor is a
 * flat fortnight, so the equality is reached, not skirted.
 */
export function evaluateSellSignal(
	series: SellSignalSeries,
	nowMs: number,
	parameters: SellSignalParameters,
	window: SeasonalWindowV1 = HALLOWEEN_SEASONAL_WINDOW,
): SellSignalProjection {
	if (!validSeries(series) || !validParameters(parameters) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
		return { status: 'undecidable', reason: 'malformed_input' };
	}
	const seasonal = seasonalWindowStatusAtMs(window, nowMs);
	if (seasonal === 'undecidable') return { status: 'undecidable', reason: 'undecidable_calendar' };
	const today = utcDay(nowMs);
	if (today === null) return { status: 'undecidable', reason: 'malformed_input' };

	const todayBid = series.days.find((day) => day.dayUtc === today)?.bidCopper;
	if (todayBid === undefined) return { status: 'undecidable', reason: 'no_close_today' };

	// Half-open on purpose: today is the observation, never part of its own
	// reference, or a new annual high would be compared against itself.
	const from = utcDay(nowMs - parameters.referenceDays * DAY_MS);
	if (from === null) return { status: 'undecidable', reason: 'malformed_input' };
	const reference = series.days.filter((day) => day.dayUtc >= from && day.dayUtc < today);
	if (reference.length < parameters.minimumReferenceDays) {
		return { status: 'undecidable', reason: 'insufficient_reference' };
	}

	const bids = reference.map((day) => day.bidCopper);
	const referenceMaxCopper = Math.max(...bids);
	const referenceMinCopper = Math.min(...bids);
	const sellThresholdCopper = Math.ceil((referenceMaxCopper * parameters.minimumOfMaxBps) / 10_000);
	const inSeason = seasonal === 'in_season';
	// Integer comparison rather than the ceiling, so the threshold shown in the
	// interface and the threshold that fires are the same number.
	const meetsSell = todayBid * 10_000 >= referenceMaxCopper * parameters.minimumOfMaxBps;
	const signal: SellSignalKind = !inSeason && meetsSell ? 'sell'
		: inSeason && todayBid <= referenceMinCopper ? 'hold'
			: 'none';
	return {
		status: 'decided', signal, dayUtc: today, bidCopper: todayBid,
		referenceMaxCopper, referenceMinCopper, referenceDayCount: reference.length,
		sellThresholdCopper, inSeason, origin: series.origin,
	};
}

/**
 * What the decision is worth on a real stack, in copper.
 *
 * A percentage tells nobody whether to act. The bag's annual amplitude is about
 * 1,35x, which sounds enormous and is about five gold on the five hundred bags
 * a festival run produces: that is the number the player needs to decide, and
 * it is the number the interface says.
 *
 * Each direction is measured against the outcome it is arguing against: selling
 * now is worth what it beats the annual floor by, holding is worth what the
 * annual ceiling beats today by. Returns zero rather than a negative number
 * when there is nothing to gain.
 */
export function sellSignalGainCopper(decision: SellSignalDecision, quantity: number): number {
	if (!Number.isSafeInteger(quantity) || quantity <= 0) return 0;
	const unit = decision.signal === 'sell' ? decision.bidCopper - decision.referenceMinCopper
		: decision.signal === 'hold' ? decision.referenceMaxCopper - decision.bidCopper
			: 0;
	if (unit <= 0) return 0;
	const total = unit * quantity;
	return Number.isSafeInteger(total) ? total : 0;
}

/**
 * Merges the seed with what the plugin captured, captured days winning.
 *
 * The plugin's own observation is preferred wherever the two overlap: it is
 * this vault's measurement of this item, and the seed is a third party's
 * summary of the same day. Neither side invents a day the other is missing,
 * which is what leaves the holes in place for the rule above to absorb.
 */
export function mergeSellSignalSeries(
	seed: PriceSeedV1 | null,
	daily: readonly PriceHistoryDailyV1[],
	itemId: number,
): SellSignalSeries {
	const byDay = new Map<string, number>();
	if (seed !== null && seed.itemId === itemId) {
		for (const day of seed.days) byDay.set(day.dayUtc, day.bidCopper);
	}
	for (const entry of daily) {
		if (entry.itemId !== itemId) continue;
		const close = entry.bid?.closeCopper;
		if (close === undefined || close === null || !Number.isSafeInteger(close) || close < 0) continue;
		byDay.set(entry.dayUtc, close);
	}
	const days = [...byDay.entries()]
		.map(([dayUtc, bidCopper]) => ({ dayUtc, bidCopper }))
		.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
	return { origin: seed === null ? 'unseeded' : 'seeded', days };
}

function validSeries(series: unknown): series is SellSignalSeries {
	if (typeof series !== 'object' || series === null) return false;
	const candidate = series as SellSignalSeries;
	if (candidate.origin !== 'seeded' && candidate.origin !== 'unseeded') return false;
	// `isArray` rather than `Array.isArray`: the latter narrows the typed array to
	// `any[]` and every field read below it stops being checked.
	if (!isArray(candidate.days)) return false;
	let previous = '';
	for (const day of candidate.days) {
		if (typeof day?.dayUtc !== 'string' || day.dayUtc <= previous) return false;
		if (!Number.isSafeInteger(day.bidCopper) || day.bidCopper < 0) return false;
		previous = day.dayUtc;
	}
	return true;
}

function validParameters(parameters: unknown): parameters is SellSignalParameters {
	if (typeof parameters !== 'object' || parameters === null) return false;
	const candidate = parameters as SellSignalParameters;
	return Number.isSafeInteger(candidate.minimumOfMaxBps) && candidate.minimumOfMaxBps > 0 &&
		candidate.minimumOfMaxBps <= 10_000 &&
		Number.isSafeInteger(candidate.referenceDays) && candidate.referenceDays > 0 && candidate.referenceDays <= 3_650 &&
		Number.isSafeInteger(candidate.minimumReferenceDays) && candidate.minimumReferenceDays > 0 &&
		candidate.minimumReferenceDays <= candidate.referenceDays;
}

/** A runtime array check that answers a boolean and narrows nothing. */
function isArray(value: unknown): boolean {
	return Array.isArray(value);
}

function utcDay(epochMs: number): string | null {
	if (!Number.isSafeInteger(epochMs) || epochMs < 0) return null;
	try {
		const iso = new Date(epochMs).toISOString();
		return Number.isFinite(Date.parse(iso)) ? iso.slice(0, 10) : null;
	} catch { return null; }
}
