import { ALERT_PRICE_STATUSES, type AlertPriceStatus, type AlertReason, type AlertV1 } from './alert-contract';
import type { HalloweenAlertItem } from '../halloween/halloween-model';

/**
 * The two criteria of H13.3, in OR, as one pure decision.
 *
 * They are deliberately not the same measurement. The value criterion reads the
 * TOTAL of the observed gain, because five copies of a two-gold drop is a five
 * gold find; the Halloween policy's own `valuable` reason reads the net value
 * per UNIT and stays where it is. Folding them into one number would have made
 * the alert fire on quantity alone for cheap stacks.
 *
 * The "always alert" half never looks at money at all: a bound rare, an item
 * seen for the first time and an unclaimed skin or mini are worth interrupting
 * a run for whatever the trading post says, and two of them have no quote by
 * construction.
 */
export const ALWAYS_ALERT_REASONS = [
	'rare_unpriced_or_bound',
	'first_seen',
	'skin_not_unlocked',
	'mini_not_unlocked',
] as const;
export type AlwaysAlertReason = typeof ALWAYS_ALERT_REASONS[number];

export interface LootAlertCandidate {
	readonly itemId: number;
	readonly name: string;
	readonly quantity: number;
	/** Net total of the observed gain, or null when the item has no usable quote. */
	readonly totalCopper: number | null;
	/** Whether `totalCopper` is a real quote, a confirmed absence of one, or a lookup that never completed. */
	readonly priceStatus: AlertPriceStatus;
	/** Policy reasons that alert regardless of value, in the policy's own order. */
	readonly alwaysAlertReasons: readonly AlwaysAlertReason[];
}

/**
 * Returns the alert a candidate earns, or null when it earns none.
 *
 * Value wins the headline when both criteria hold: the player asked to be told
 * when something GORDO drops, and a number is the fastest thing to read on a
 * banner. The policy reason is not lost, it is durable in the queue behind it.
 */
export function decideLootAlert(candidate: LootAlertCandidate, thresholdCopper: number): AlertV1 | null {
	if (!validCandidate(candidate) || !validThreshold(thresholdCopper)) return null;
	const meetsValue = candidate.totalCopper !== null && candidate.totalCopper >= thresholdCopper;
	const reason: AlertReason | undefined = meetsValue ? 'valuable' : candidate.alwaysAlertReasons[0];
	if (reason === undefined) return null;
	return {
		kind: meetsValue ? 'valuable_loot' : 'always_alert',
		itemId: candidate.itemId,
		name: candidate.name,
		quantity: candidate.quantity,
		totalCopper: candidate.totalCopper,
		priceStatus: candidate.priceStatus,
		reason,
	};
}

/** Projects a policy verdict onto the value-free half of the OR, dropping its per-unit reason. */
export function alwaysAlertReasonsOf(item: Pick<HalloweenAlertItem, 'reasons'>): AlwaysAlertReason[] {
	return item.reasons
		.map(({ code }) => code)
		.filter((code): code is AlwaysAlertReason => (ALWAYS_ALERT_REASONS as readonly string[]).includes(code));
}

/**
 * Translates a policy verdict's own price evidence into the pair `decideLootAlert` needs.
 *
 * The always-alert half of the OR never needs a quote to FIRE, but the player still deserves the
 * real number when the evidence has one: an item flagged bound or first-seen can perfectly well
 * also have a market price. `no_quote` is the only evidence status that has actually confirmed the
 * absence of one, so it is the only status this maps to `unquoted`; `unavailable`, `invalid` and
 * `rate_limited` all mean the lookup never answered and map to `unavailable`. `quote` only becomes
 * `known` once the unit price survives the multiplication by quantity: an overflow is not a
 * confirmed absence of a price either, so it falls back to `unavailable` rather than inventing a
 * number or lying that nothing was found.
 */
export function policyAlertPriceOf(
	item: Pick<HalloweenAlertItem, 'netUnitCopper' | 'priceStatus' | 'quantity'>,
): { totalCopper: number | null; priceStatus: AlertPriceStatus } {
	if (item.priceStatus === 'no_quote') return { totalCopper: null, priceStatus: 'unquoted' };
	if (item.priceStatus !== 'quote' || item.netUnitCopper === null) return { totalCopper: null, priceStatus: 'unavailable' };
	const totalCopper = safeProduct(item.netUnitCopper, item.quantity);
	return totalCopper === null ? { totalCopper: null, priceStatus: 'unavailable' } : { totalCopper, priceStatus: 'known' };
}

function safeProduct(unitCopper: number, quantity: number): number | null {
	const value = unitCopper * quantity;
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validCandidate(candidate: LootAlertCandidate): boolean {
	return positiveInteger(candidate.itemId) && positiveInteger(candidate.quantity) &&
		typeof candidate.name === 'string' && candidate.name.length > 0 &&
		(candidate.totalCopper === null || (Number.isSafeInteger(candidate.totalCopper) && candidate.totalCopper >= 0)) &&
		(ALERT_PRICE_STATUSES as readonly string[]).includes(candidate.priceStatus) &&
		(candidate.priceStatus === 'known' ? candidate.totalCopper !== null : candidate.totalCopper === null) &&
		Array.isArray(candidate.alwaysAlertReasons) &&
		candidate.alwaysAlertReasons.every((reason: string) => (ALWAYS_ALERT_REASONS as readonly string[]).includes(reason));
}

function validThreshold(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
