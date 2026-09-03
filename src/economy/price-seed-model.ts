/**
 * The seed series and the parser that reduces a third-party history to it.
 *
 * The plugin can only observe prices from the day it was installed, and the
 * sell rule needs a year of them. datawars2 publishes that year, so it is read
 * ONCE as a starting point and the plugin's own capture extends it from there.
 *
 * Three properties of the real response, measured on
 * `https://api.datawars2.ie/gw2/v1/history?itemID=36038`, are what this module
 * exists to absorb:
 *
 * - It is 2.2 MB and 4.961 daily records reaching back to 2012. None of that is
 *   kept: the response is trimmed while it is parsed, down to the newest
 *   `PRICE_SEED_MAX_DAYS` days and to the two prices, so what reaches storage
 *   is kilobytes rather than megabytes.
 * - Its schema is NOT uniform. Old records carry only `buy_price_max` and
 *   `buy_price_min`; recent ones add `buy_price_avg`, quantities and volumes.
 *   A parser that required the average would silently drop the older half of
 *   the series, so the midpoint of the two bounds is the documented fallback.
 * - It has HOLES. The 2025 series is missing 2025-10-25 to 2025-10-29. So a
 *   seed day is never synthesised to bridge a gap: a missing day stays missing
 *   and the rule that consumes the series is the one that tolerates it.
 */
export const PRICE_SEED_VERSION = 1 as const;

/** Newest days kept from the response. A year of reference plus a month of margin. */
export const PRICE_SEED_MAX_DAYS = 400;

/** The one place the seed endpoint is written down. Item id is appended by the caller. */
export const PRICE_SEED_BASE_URL = 'https://api.datawars2.ie/gw2/v1/history';

export interface PriceSeedDayV1 {
	dayUtc: string;
	bidCopper: number;
	/** Null when the record has no usable sell side; the sell rule never reads it. */
	askCopper: number | null;
}

export interface PriceSeedV1 {
	version: typeof PRICE_SEED_VERSION;
	itemId: number;
	source: 'datawars2';
	retrievedAt: string;
	/** Ascending by day, unique by day, never synthesised. */
	days: PriceSeedDayV1[];
}

/**
 * Why there is no seed.
 *
 * `unreachable` is the network answering badly, `malformed` is it answering
 * something that is not a daily history, `empty` is a well-formed answer with
 * no usable day in it. They are separated because only the first is worth
 * retrying on a later session.
 */
export type PriceSeedFailureReason = 'unreachable' | 'malformed' | 'empty';

export type PriceSeedResult =
	| { status: 'seeded'; seed: PriceSeedV1 }
	| { status: 'no_seed'; reason: PriceSeedFailureReason };

const DAY_UTC = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Reduces a datawars2 history payload to a seed, or declares there is none.
 *
 * Records the parser cannot read are DROPPED, one by one, rather than failing
 * the whole payload or being replaced by a guess. A history that is half
 * readable is still a better reference than eleven months of nothing, and the
 * consumer is told how many days it actually got.
 */
export function parseDatawars2History(
	payload: unknown,
	itemId: number,
	retrievedAt: string,
	maxDays: number = PRICE_SEED_MAX_DAYS,
): PriceSeedResult {
	if (!Number.isSafeInteger(itemId) || itemId <= 0 || !isIso(retrievedAt)) return { status: 'no_seed', reason: 'malformed' };
	if (!Number.isSafeInteger(maxDays) || maxDays <= 0) return { status: 'no_seed', reason: 'malformed' };
	if (!Array.isArray(payload)) return { status: 'no_seed', reason: 'malformed' };

	// Keyed by day so a duplicated date collapses to its last record instead of
	// entering the series twice and skewing the maximum it feeds.
	const byDay = new Map<string, PriceSeedDayV1>();
	for (const record of payload) {
		const day = seedDay(record);
		if (day !== null) byDay.set(day.dayUtc, day);
	}
	if (byDay.size === 0) return { status: 'no_seed', reason: 'empty' };

	const days = [...byDay.values()]
		.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0))
		.slice(-maxDays);
	return { status: 'seeded', seed: { version: PRICE_SEED_VERSION, itemId, source: 'datawars2', retrievedAt, days } };
}

export function isPriceSeed(value: unknown): value is PriceSeedV1 {
	if (!isRecord(value) || !exactKeys(value, ['version', 'itemId', 'source', 'retrievedAt', 'days'])) return false;
	if (value.version !== PRICE_SEED_VERSION || !Number.isSafeInteger(value.itemId) || (value.itemId as number) <= 0) return false;
	if (value.source !== 'datawars2' || !isIso(value.retrievedAt) || !Array.isArray(value.days)) return false;
	let previous = '';
	for (const day of value.days) {
		if (!isRecord(day) || !exactKeys(day, ['dayUtc', 'bidCopper', 'askCopper'])) return false;
		if (typeof day.dayUtc !== 'string' || !DAY_UTC.test(day.dayUtc) || day.dayUtc <= previous) return false;
		if (!nonNegativeInteger(day.bidCopper)) return false;
		if (day.askCopper !== null && !nonNegativeInteger(day.askCopper)) return false;
		previous = day.dayUtc;
	}
	return true;
}

/**
 * One record to one seed day, or null.
 *
 * The bid is what the rule reads, so a record without a usable bid is not a
 * seed day at all. The ask is best effort: it is carried for the interface and
 * its absence never discards the day.
 */
function seedDay(record: unknown): PriceSeedDayV1 | null {
	if (!isRecord(record)) return null;
	const dayUtc = utcDayOf(record.date);
	if (dayUtc === null) return null;
	const bidCopper = sideCopper(record.buy_price_avg, record.buy_price_max, record.buy_price_min);
	if (bidCopper === null) return null;
	return { dayUtc, bidCopper, askCopper: sideCopper(record.sell_price_avg, record.sell_price_max, record.sell_price_min) };
}

/**
 * Average when the record has one, midpoint of the bounds when it does not.
 *
 * The fallback is what makes the pre-2017 half of the series usable at all: it
 * carries only `*_price_max` and `*_price_min`. The midpoint is rounded to a
 * whole copper because every price in this plugin is an integer of copper, and
 * a fractional one would fail every validator downstream.
 */
function sideCopper(average: unknown, maximum: unknown, minimum: unknown): number | null {
	if (isFiniteNumber(average) && average >= 0) return Math.round(average);
	if (!isFiniteNumber(maximum) || !isFiniteNumber(minimum)) return null;
	if (maximum < 0 || minimum < 0 || maximum < minimum) return null;
	return Math.round((maximum + minimum) / 2);
}

/** Accepts the `date` field in both forms the endpoint has used: a UTC day and a full instant. */
function utcDayOf(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (DAY_UTC.test(value)) return value;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed).toISOString().slice(0, 10);
}

function isIso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length &&
		keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
