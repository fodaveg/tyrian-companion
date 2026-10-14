/**
 * The hourly series of the «1 semana» window and the parser that reduces datawars2's hourly feed to it.
 *
 * Measured on 14 oct 2026, items 36038 / 19721 / 24277: `v2/history/hourly/json?itemID=<id>` answers
 * a bare JSON array with ONE record per UTC hour and the last ~8 days only (197 records for the
 * first), gap-free; restricted to `fields=date,sell_price_min` it weighs ~10.4 KB (124 KB with every
 * field). `sell_price_min` is the lowest sell offer seen inside that hour (the feed samples the bazaar
 * about every 5 minutes, `count` ≈ 12 per hour), which is the same «lowest sell offer» the daily chart
 * plots, so the two read alike. The finest resolution that exists is therefore one point per hour; the
 * official price API is cached for minutes, so a per-minute series is not reachable from any source.
 *
 * Same rule as the daily seed: a record the parser cannot read is DROPPED, never guessed, and an hour
 * that is missing stays missing.
 */

/** The one place the hourly endpoint is written down. Item id and `fields` are appended by the caller. */
export const PRICE_HOURLY_BASE_URL = 'https://api.datawars2.ie/gw2/v2/history/hourly/json';

/** Exactly the fields `parseDatawars2Hourly` reads. */
export const PRICE_HOURLY_FIELDS = 'date,sell_price_min';

/** One week of hours: the window the button is named for. The feed holds a little more (~8 days). */
export const PRICE_HOURLY_MAX_HOURS = 168;

export interface PriceHourlyPointV1 {
	/** The start of the UTC hour, as a full ISO instant (`2026-10-14T04:00:00.000Z`). */
	hourUtc: string;
	askCopper: number;
}

/** What the chart and the block read for one item. `idle` means nothing was asked yet (and nothing sent). */
export interface PriceHourlyState {
	status: 'idle' | 'loading' | 'ready' | 'empty' | 'failed';
	/** Ascending by hour, unique by hour. Empty unless `status` is `ready`. */
	points: readonly PriceHourlyPointV1[];
}

export const PRICE_HOURLY_IDLE_STATE: PriceHourlyState = Object.freeze({ status: 'idle', points: Object.freeze([]) });

export type PriceHourlyResult =
	| { status: 'ok'; points: PriceHourlyPointV1[] }
	| { status: 'no_data'; reason: 'unreachable' | 'unavailable' | 'malformed' | 'empty' };

/** Reduces a datawars2 hourly payload to the newest `maxHours` readable hours. */
export function parseDatawars2Hourly(payload: unknown, maxHours: number = PRICE_HOURLY_MAX_HOURS): PriceHourlyResult {
	if (!Number.isSafeInteger(maxHours) || maxHours <= 0 || !Array.isArray(payload)) return { status: 'no_data', reason: 'malformed' };
	const byHour = new Map<string, PriceHourlyPointV1>();
	for (const record of payload) {
		if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
		const { date, sell_price_min: ask } = record as Record<string, unknown>;
		if (typeof date !== 'string' || !Number.isSafeInteger(ask) || (ask as number) <= 0) continue;
		const parsed = Date.parse(date);
		if (!Number.isFinite(parsed)) continue;
		const hourUtc = new Date(Math.floor(parsed / 3_600_000) * 3_600_000).toISOString();
		byHour.set(hourUtc, { hourUtc, askCopper: ask as number });
	}
	if (byHour.size === 0) return { status: 'no_data', reason: 'empty' };
	const points = [...byHour.values()]
		.sort((left, right) => (left.hourUtc < right.hourUtc ? -1 : left.hourUtc > right.hourUtc ? 1 : 0))
		.slice(-maxHours);
	return { status: 'ok', points };
}
