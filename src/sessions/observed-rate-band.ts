import { API_SETTLEMENT_WINDOW_MS } from './session-api-settlement';

export const OBSERVED_RATE_BAND_VERSION = 1 as const;

/**
 * Uncertainty the account cache puts on each end of an observed session window.
 *
 * Guild Wars 2 never answers live: `session-api-settlement` documents the same 5-10 minute nested
 * cache chain and takes its ceiling as the grace window. That ceiling lands on both boundaries of
 * a session and it lands in opposite directions:
 *
 * - the baseline read at `window.from` describes the account as it was up to a ceiling *earlier*,
 *   so gains earned before the session opened can be counted inside it;
 * - the closing read describes the account as it was up to a ceiling *earlier* too, so the last
 *   minutes of play can be missing from it.
 *
 * The interval the loot actually accrued over is therefore the declared window give or take this
 * margin, which is why a rate over it is a band and not a figure. Deriving it from
 * `API_SETTLEMENT_WINDOW_MS` rather than restating «ten minutes» keeps the two ends of the same
 * measured fact from drifting apart.
 */
export const OBSERVED_WINDOW_CACHE_MARGIN_MS = API_SETTLEMENT_WINDOW_MS;

const MS_PER_HOUR = 3_600_000;

/**
 * A per-hour rate published as the interval the evidence supports, together with everything
 * needed to recompute it: nobody has to trust `low` and `high`, they can be re-derived from
 * `windowMs`, `marginMs` and the two windows below.
 *
 * `lower_bound_only` is the honest outcome for a session shorter than the margin: narrowing its
 * window by the cache uncertainty leaves nothing to divide by, so the upper end is unbounded and
 * is published as `null` instead of as a number that would be pure invention.
 */
export interface ObservedRateBand {
	version: typeof OBSERVED_RATE_BAND_VERSION;
	status: 'measured' | 'lower_bound_only' | 'unavailable';
	low: number | null;
	high: number | null;
	/** Window the session declared, before the cache margin is applied to either end. */
	windowMs: number | null;
	/** Cache uncertainty applied to each end, published so the band can be audited. */
	marginMs: number | null;
	/** `windowMs + marginMs`: the longest interval the loot can have accrued over. */
	widestWindowMs: number | null;
	/** `windowMs - marginMs`: the shortest one, or null when the margin swallows the window. */
	narrowestWindowMs: number | null;
}

/**
 * Brackets `amount` per hour over an observed window whose ends carry the account cache margin.
 *
 * `amount` is taken already scaled by the caller, exactly as `session-valuation` scales sacks by
 * a thousand before dividing, so this stays one arithmetic and not two. A negative amount is
 * legitimate — a session can end with less coin than it started — and the extremes are ordered by
 * value rather than by window, so `low` is always the smaller rate.
 */
export function observedRateBand(
	amount: number,
	windowMs: number,
	marginMs: number = OBSERVED_WINDOW_CACHE_MARGIN_MS,
): ObservedRateBand {
	if (
		!Number.isSafeInteger(amount) || !Number.isSafeInteger(windowMs) || windowMs <= 0 ||
		!Number.isSafeInteger(marginMs) || marginMs < 0
	) return unavailableRateBand();

	const widestWindowMs = windowMs + marginMs;
	const narrowestWindowMs = windowMs - marginMs;
	const overWidest = ratePerHour(amount, widestWindowMs);
	const overNarrowest = narrowestWindowMs > 0 ? ratePerHour(amount, narrowestWindowMs) : null;
	if (overWidest === null || (narrowestWindowMs > 0 && overNarrowest === null)) return unavailableRateBand();

	const shared = {
		version: OBSERVED_RATE_BAND_VERSION,
		windowMs,
		marginMs,
		widestWindowMs,
		narrowestWindowMs: narrowestWindowMs > 0 ? narrowestWindowMs : null,
	} as const;
	if (overNarrowest === null) {
		return { ...shared, status: 'lower_bound_only', low: overWidest, high: null };
	}
	return {
		...shared,
		status: 'measured',
		low: Math.min(overWidest, overNarrowest),
		high: Math.max(overWidest, overNarrowest),
	};
}

/** The band a caller publishes when it holds no window or no amount to divide. */
export function unavailableRateBand(): ObservedRateBand {
	return {
		version: OBSERVED_RATE_BAND_VERSION,
		status: 'unavailable',
		low: null,
		high: null,
		windowMs: null,
		marginMs: null,
		widestWindowMs: null,
		narrowestWindowMs: null,
	};
}

/**
 * Renders a milli-scaled rate as the unit the player counts in. One decimal is the whole of the
 * precision a thousandth carries once it is read as sacks, and the note and the live panel share
 * this so the two surfaces cannot round differently.
 */
export function formatMilliUnits(milli: number): string {
	return (milli / 1_000).toFixed(1);
}

/** Whole minutes of a duration, for the provenance line that states where a band came from. */
export function formatBandMinutes(durationMs: number): string {
	return String(Math.round(durationMs / 60_000));
}

function ratePerHour(amount: number, windowMs: number): number | null {
	const scaled = amount * MS_PER_HOUR;
	if (!Number.isSafeInteger(scaled)) return null;
	const result = Math.round(scaled / windowMs);
	return Number.isSafeInteger(result) ? result : null;
}
