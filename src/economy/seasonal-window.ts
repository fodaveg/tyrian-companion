export const SEASONAL_WINDOW_VERSION = 1 as const;

/**
 * A recurring festival window declared as data.
 *
 * The plugin used to have no calendar at all, so a Halloween surface armed in
 * October stayed armed in March: the bag quotes all year, so nothing in the
 * numbers ever said the festival was over. The window lives here as two
 * `MM-DD` boundaries instead of as a comparison hidden inside the logic, so it
 * travels inside the curated pack, is hashed with it, and can be reviewed
 * without reading code.
 *
 * The boundaries are UTC calendar days and both ends are inclusive. A window
 * whose closing day precedes its opening day wraps across new year, which is
 * how a December-to-January festival is expressed.
 */
export interface SeasonalWindowV1 {
	version: typeof SEASONAL_WINDOW_VERSION;
	seasonId: string;
	/** Inclusive first UTC day of the window, as `MM-DD`. */
	opensOn: string;
	/** Inclusive last UTC day of the window, as `MM-DD`. */
	closesOn: string;
	/** Month named to the player while the window is closed, 1-12. */
	returnsInMonth: number;
}

export type SeasonalWindowStatus = 'in_season' | 'out_of_season' | 'undecidable';

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isSeasonalWindow(value: unknown): value is SeasonalWindowV1 {
	if (!record(value) || !exactKeys(value, ['version', 'seasonId', 'opensOn', 'closesOn', 'returnsInMonth'])
		|| value.version !== SEASONAL_WINDOW_VERSION || !identifier(value.seasonId)
		|| !monthDay(value.opensOn) || !monthDay(value.closesOn)) return false;
	return value.returnsInMonth === monthOf(value.opensOn);
}

/**
 * Reads the window at an instant given in epoch milliseconds.
 *
 * `undecidable` is a third answer on purpose: a malformed window or clock must
 * not silently collapse into `in_season`, because that is exactly the failure
 * this module exists to remove. Each caller decides what an unreadable
 * calendar means for it, out loud.
 */
export function seasonalWindowStatusAtMs(window: unknown, epochMs: unknown): SeasonalWindowStatus {
	if (!isSeasonalWindow(window) || typeof epochMs !== 'number' || !Number.isSafeInteger(epochMs)) {
		return 'undecidable';
	}
	const day = utcMonthDay(epochMs);
	if (day === null) return 'undecidable';
	const open = window.opensOn <= window.closesOn
		? day >= window.opensOn && day <= window.closesOn
		: day >= window.opensOn || day <= window.closesOn;
	return open ? 'in_season' : 'out_of_season';
}

/** Same reading from an ISO-8601 instant, the form every curated pack carries. */
export function seasonalWindowStatusAt(window: unknown, asOf: unknown): SeasonalWindowStatus {
	if (typeof asOf !== 'string') return 'undecidable';
	const parsed = Date.parse(asOf);
	if (!Number.isFinite(parsed)) return 'undecidable';
	return seasonalWindowStatusAtMs(window, parsed);
}

/**
 * End of the first closing day of the window at or after `fromMs`, exclusive.
 *
 * H13.7 exists because a pack expired on 12 November while the window it
 * describes stays open until the 15th: for three days the plugin would have had
 * a live festival and a dead pack, and nothing said so. Expressing "the pack
 * must outlive its own window" needs this instant, so it is computed from the
 * window rather than written down beside it, where it would rot the next time
 * the boundaries move.
 *
 * Returns null for an unreadable window or clock, never a guess.
 */
export function seasonalWindowClosesAfterMs(window: unknown, fromMs: unknown): number | null {
	if (!isSeasonalWindow(window) || typeof fromMs !== 'number' || !Number.isSafeInteger(fromMs)) return null;
	const from = new Date(fromMs);
	const iso = Number.isFinite(from.getTime()) ? from.toISOString() : null;
	if (iso === null) return null;
	const year = Number.parseInt(iso.slice(0, 4), 10);
	// The day after the closing day, at midnight: the window includes its closing
	// day in full, so anything valid "until the close" must reach past midnight.
	for (const candidate of [year, year + 1]) {
		const closes = Date.parse(`${String(candidate)}-${window.closesOn}T00:00:00.000Z`);
		if (!Number.isFinite(closes)) return null;
		const endsAt = closes + 86_400_000;
		if (endsAt >= fromMs) return endsAt;
	}
	return null;
}

function utcMonthDay(epochMs: number): string | null {
	const date = new Date(epochMs);
	const iso = Number.isFinite(date.getTime()) ? date.toISOString() : null;
	return iso === null ? null : iso.slice(5, 10);
}

function monthOf(value: string): number {
	return Number.parseInt(value.slice(0, 2), 10);
}

/**
 * `02-29` is rejected rather than accepted. As a boundary it exists in one
 * calendar year out of four, so a window pinned to it would silently shift by
 * a day for three years running with nothing turning red.
 */
function monthDay(value: unknown): value is string {
	if (typeof value !== 'string' || !MONTH_DAY.test(value)) return false;
	const month = Number.parseInt(value.slice(0, 2), 10);
	const day = Number.parseInt(value.slice(3, 5), 10);
	return day <= DAYS_IN_MONTH[month - 1]!;
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 64;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
