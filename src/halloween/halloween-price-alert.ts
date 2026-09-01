import { priceHistoryDayUtc, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import { HALLOWEEN_SEASONAL_WINDOW } from '../economy/models/halloween-season';
import { seasonalWindowStatusAtMs } from '../economy/seasonal-window';

const DAY_MS = 86_400_000;
export const HALLOWEEN_PRICE_ALERT_ITEM_ID = 36_038;
export const HALLOWEEN_PRICE_REFERENCE_DAYS = 30 as const;
export const HALLOWEEN_PRICE_ALERT_VERSION = 1 as const;

export type HalloweenPriceAlertCooldownHours = 6 | 12 | 24 | 48;

export interface HalloweenPriceAlertSettings {
	enabled: boolean;
	minimumAboveP90Bps: number;
	cooldownHours: HalloweenPriceAlertCooldownHours;
}

export interface HalloweenPriceValidProjection {
	status: 'below' | 'high';
	dayUtc: string;
	bidCopper: number;
	p90Copper: number;
	capturedAtMs: number;
	referenceDays: typeof HALLOWEEN_PRICE_REFERENCE_DAYS;
	minimumAboveP90Bps: number;
}

export type HalloweenPriceProjection =
	| { status: 'out_of_season'; returnsInMonth: number }
	| { status: 'insufficient_history'; capturedAtMs: number | null; missingDayUtc: string | null }
	| HalloweenPriceValidProjection;

export interface HalloweenPriceNoticeV1 {
	version: typeof HALLOWEEN_PRICE_ALERT_VERSION;
	vaultId: string;
	accountRef: string;
	noticeId: string;
	itemId: typeof HALLOWEEN_PRICE_ALERT_ITEM_ID;
	observedAt: string;
	dayUtc: string;
	wording: 'bid_above_local_p90';
	bidCopper: number;
	p90Copper: number;
	referenceDays: typeof HALLOWEEN_PRICE_REFERENCE_DAYS;
	capturedAtMs: number;
	minimumAboveP90Bps: number;
	cooldownHours: HalloweenPriceAlertCooldownHours;
	acknowledgedAt: string | null;
}

/** Evaluates only the current UTC close against 30 complete preceding UTC days. */
export function evaluateHalloweenPrice(
	daily: readonly PriceHistoryDailyV1[],
	nowMs: number,
	minimumAboveP90Bps: number,
): HalloweenPriceProjection {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || isoFromTimestamp(nowMs) === null || !validMinimum(minimumAboveP90Bps)) {
		return { status: 'insufficient_history', capturedAtMs: null, missingDayUtc: null };
	}
	// The bag quotes all year, so nothing in the price series ever says the
	// festival is over. Only the declared window does, and outside it a crossing
	// is noise: the alert is not armed rather than fired and later explained.
	// `undecidable` deliberately falls through: refusing to evaluate because a
	// calendar could not be read would mute the alert during the festival.
	if (seasonalWindowStatusAtMs(HALLOWEEN_SEASONAL_WINDOW, nowMs) === 'out_of_season') {
		return { status: 'out_of_season', returnsInMonth: HALLOWEEN_SEASONAL_WINDOW.returnsInMonth };
	}
	const today = priceHistoryDayUtc(nowMs);
	const byDay = new Map(daily.filter(({ itemId }) => itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID)
		.map((entry) => [entry.dayUtc, entry]));
	const current = byDay.get(today)?.bid;
	if (current === null || current === undefined || current.closeCapturedAtMs > nowMs ||
		priceHistoryDayUtc(current.closeCapturedAtMs) !== today) {
		return { status: 'insufficient_history', capturedAtMs: null, missingDayUtc: today };
	}
	const closes: number[] = [];
	for (let offset = HALLOWEEN_PRICE_REFERENCE_DAYS; offset >= 1; offset -= 1) {
		const dayUtc = priceHistoryDayUtc(nowMs - offset * DAY_MS);
		const side = byDay.get(dayUtc)?.bid;
		const close = side?.closeCopper;
		if (close === null || close === undefined || side === null || side === undefined ||
			priceHistoryDayUtc(side.closeCapturedAtMs) !== dayUtc) {
			return { status: 'insufficient_history', capturedAtMs: current.closeCapturedAtMs, missingDayUtc: dayUtc };
		}
		closes.push(close);
	}
	closes.sort((left, right) => left - right);
	const p90Copper = closes[26]!;
	const above = bidMeetsThreshold(current.closeCopper, p90Copper, minimumAboveP90Bps);
	return {
		status: above ? 'high' : 'below', dayUtc: today, bidCopper: current.closeCopper, p90Copper,
		capturedAtMs: current.closeCapturedAtMs, referenceDays: 30, minimumAboveP90Bps,
	};
}

export function createHalloweenPriceNotice(
	vaultId: string,
	accountRef: string,
	projection: HalloweenPriceValidProjection,
	cooldownHours: HalloweenPriceAlertCooldownHours,
): HalloweenPriceNoticeV1 {
	return {
		version: 1, vaultId, accountRef,
		noticeId: `price:${String(HALLOWEEN_PRICE_ALERT_ITEM_ID)}:${String(projection.capturedAtMs)}`,
		itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID,
		observedAt: new Date(projection.capturedAtMs).toISOString(),
		dayUtc: projection.dayUtc,
		wording: 'bid_above_local_p90',
		bidCopper: projection.bidCopper,
		p90Copper: projection.p90Copper,
		referenceDays: projection.referenceDays,
		capturedAtMs: projection.capturedAtMs,
		minimumAboveP90Bps: projection.minimumAboveP90Bps,
		cooldownHours,
		acknowledgedAt: null,
	};
}

export function isHalloweenPriceNotice(value: unknown): value is HalloweenPriceNoticeV1 {
	if (!record(value) || !exactKeys(value, ['version', 'vaultId', 'accountRef', 'noticeId', 'itemId', 'observedAt', 'dayUtc',
		'wording', 'bidCopper', 'p90Copper', 'referenceDays', 'capturedAtMs', 'minimumAboveP90Bps', 'cooldownHours',
		'acknowledgedAt']) || value.version !== 1 || !text(value.vaultId) || !text(value.accountRef) || !text(value.noticeId) ||
		value.itemId !== HALLOWEEN_PRICE_ALERT_ITEM_ID || !iso(value.observedAt) || !utcDay(value.dayUtc) ||
		value.wording !== 'bid_above_local_p90' || !nonNegative(value.bidCopper) || !nonNegative(value.p90Copper) ||
		value.referenceDays !== 30 || !nonNegative(value.capturedAtMs) || !validMinimum(value.minimumAboveP90Bps) ||
		![6, 12, 24, 48].includes(value.cooldownHours as number) ||
		(value.acknowledgedAt !== null && !iso(value.acknowledgedAt))) return false;
	const capturedIso = isoFromTimestamp(value.capturedAtMs);
	return capturedIso !== null && value.observedAt === capturedIso && value.dayUtc === capturedIso.slice(0, 10) &&
		value.noticeId === `price:${String(HALLOWEEN_PRICE_ALERT_ITEM_ID)}:${String(value.capturedAtMs)}` &&
		bidMeetsThreshold(value.bidCopper, value.p90Copper, value.minimumAboveP90Bps);
}

export function isHalloweenPriceValidProjection(value: unknown): value is HalloweenPriceValidProjection {
	if (!record(value) || !exactKeys(value, ['status', 'dayUtc', 'bidCopper', 'p90Copper', 'capturedAtMs', 'referenceDays',
		'minimumAboveP90Bps']) || (value.status !== 'below' && value.status !== 'high') || !utcDay(value.dayUtc) ||
		!nonNegative(value.bidCopper) || !nonNegative(value.p90Copper) || !nonNegative(value.capturedAtMs) ||
		value.referenceDays !== 30 || !validMinimum(value.minimumAboveP90Bps)) return false;
	const capturedIso = isoFromTimestamp(value.capturedAtMs);
	if (capturedIso === null || value.dayUtc !== capturedIso.slice(0, 10)) return false;
	return (value.status === 'high') === bidMeetsThreshold(value.bidCopper, value.p90Copper, value.minimumAboveP90Bps);
}

function bidMeetsThreshold(bidCopper: number, p90Copper: number, minimumAboveP90Bps: number): boolean {
	return bidCopper > p90Copper &&
		BigInt(bidCopper - p90Copper) * 10_000n >= BigInt(p90Copper) * BigInt(minimumAboveP90Bps);
}

function isoFromTimestamp(value: unknown): string | null {
	if (!nonNegative(value)) return null;
	try {
		const isoValue = new Date(value).toISOString();
		return Number.isFinite(Date.parse(isoValue)) ? isoValue : null;
	} catch { return null; }
}

function validMinimum(value: unknown): value is number { return nonNegative(value) && value <= 100_000; }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function utcDay(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
