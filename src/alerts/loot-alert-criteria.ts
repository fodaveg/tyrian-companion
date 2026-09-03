import type { AlertReason, AlertV1 } from './alert-contract';
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
		reason,
	};
}

/** Projects a policy verdict onto the value-free half of the OR, dropping its per-unit reason. */
export function alwaysAlertReasonsOf(item: Pick<HalloweenAlertItem, 'reasons'>): AlwaysAlertReason[] {
	return item.reasons
		.map(({ code }) => code)
		.filter((code): code is AlwaysAlertReason => (ALWAYS_ALERT_REASONS as readonly string[]).includes(code));
}

function validCandidate(candidate: LootAlertCandidate): boolean {
	return positiveInteger(candidate.itemId) && positiveInteger(candidate.quantity) &&
		typeof candidate.name === 'string' && candidate.name.length > 0 &&
		(candidate.totalCopper === null || (Number.isSafeInteger(candidate.totalCopper) && candidate.totalCopper >= 0)) &&
		Array.isArray(candidate.alwaysAlertReasons) &&
		candidate.alwaysAlertReasons.every((reason: string) => (ALWAYS_ALERT_REASONS as readonly string[]).includes(reason));
}

function validThreshold(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
