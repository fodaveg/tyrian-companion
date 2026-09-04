/**
 * The one shape every alert channel receives.
 *
 * H13.4 exists because the plugin had a single delivery, `new Notice`, and a
 * toast behind a full-screen game is a message nobody reads. Adding channels
 * one by one would have grown four copies of "what is worth saying"; instead
 * every producer builds this record and hands it to one exit point.
 *
 * `sell_signal` and `hold_signal` are declared here although H13.3 emits
 * neither: the kinds are part of the signed contract and the durable queue
 * validates against them, so H13.2 cables its detector without a schema change.
 */
export const ALERT_KINDS = ['valuable_loot', 'always_alert', 'sell_signal', 'hold_signal'] as const;
export type AlertKind = typeof ALERT_KINDS[number];

/**
 * Why the alert fired, as a closed code rather than as prose.
 *
 * The first five mirror `HalloweenAlertReason` one to one so a policy reason
 * survives the trip to a channel without being rewritten. The last two belong
 * to the price side and are only produced by the price runtime.
 */
export const ALERT_REASONS = [
	'valuable',
	'rare_unpriced_or_bound',
	'first_seen',
	'skin_not_unlocked',
	'mini_not_unlocked',
	'bid_above_reference',
	'bid_below_reference',
] as const;
export type AlertReason = typeof ALERT_REASONS[number];

/**
 * Whether `totalCopper` is a real quote, a confirmed absence of one, or a lookup that never
 * completed.
 *
 * `unquoted` and `unavailable` both leave `totalCopper` null, and that used to be the whole
 * story: a single `null` meant "the item has no quote," full stop. That is exactly what let a
 * `commerce/prices` 404 read to the player as "this item has no value" instead of "the plugin
 * could not check" — the two are not the same claim. `unquoted` means the price lookup answered
 * and this item genuinely has no usable bid; `unavailable` means the lookup itself failed (a bad
 * status, a rejected request, a timeout) and the item's real market status was never learned.
 */
export const ALERT_PRICE_STATUSES = ['known', 'unquoted', 'unavailable'] as const;
export type AlertPriceStatus = typeof ALERT_PRICE_STATUSES[number];

export interface AlertV1 {
	readonly kind: AlertKind;
	readonly itemId: number;
	readonly name: string;
	readonly quantity: number;
	/** Null unless `priceStatus` is `known`; see `AlertPriceStatus` for what a null one means. */
	readonly totalCopper: number | null;
	/** `known` implies `totalCopper` is a number; `unquoted` and `unavailable` are the two reasons it can be null. */
	readonly priceStatus: AlertPriceStatus;
	readonly reason: AlertReason;
}

/**
 * Declared delivery latency, in minutes.
 *
 * The account API answers from a documented 5-10 minute cache chain and the
 * session polls every 5 minutes, so the worst case is one full cache lag plus
 * one full poll period. The interface says this out loud instead of letting the
 * player read a timestamp and conclude the plugin is late.
 */
export const ALERT_LATENCY_MINUTES = Object.freeze({ minimum: 5, maximum: 20 });

/** Poll cadence while a session is active. Faster re-reads bytes the cache cannot have changed. */
export const ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS = 5 * 60_000;

/** Total net value from which a find alerts on its own. Five gold, editable in Settings. */
export const DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER = 50_000;

const MAX_NAME_LENGTH = 256;

export function isAlert(value: unknown): value is AlertV1 {
	if (!isRecord(value) || !exactKeys(value, ['kind', 'itemId', 'name', 'quantity', 'totalCopper', 'priceStatus', 'reason'])) return false;
	if (!(ALERT_KINDS as readonly string[]).includes(value.kind as string) ||
		!(ALERT_REASONS as readonly string[]).includes(value.reason as string) ||
		!(ALERT_PRICE_STATUSES as readonly string[]).includes(value.priceStatus as string) ||
		!positiveInteger(value.itemId) || !positiveInteger(value.quantity) ||
		typeof value.name !== 'string' || value.name.length === 0 || value.name.length > MAX_NAME_LENGTH) return false;
	// `known` and a real number travel together; the other two statuses only ever mean null.
	return value.priceStatus === 'known'
		? nonNegativeInteger(value.totalCopper)
		: value.totalCopper === null;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
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
