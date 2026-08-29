import {
	DEFAULT_HALLOWEEN_VALUE_THRESHOLD_COPPER,
	type HalloweenAlertItem,
	type HalloweenAlertReason,
	type HalloweenItemEvidence,
	type HalloweenPolicy,
} from './halloween-model';

const RARITY_RANK: Readonly<Record<string, number>> = Object.freeze({
	Junk: 0, Basic: 1, Fine: 2, Masterwork: 3, Rare: 4, Exotic: 5, Ascended: 6, Legendary: 7,
});

export const DEFAULT_HALLOWEEN_POLICY: Readonly<HalloweenPolicy> = Object.freeze({
	valueThresholdCopper: DEFAULT_HALLOWEEN_VALUE_THRESHOLD_COPPER,
});

/** Pure, additive policy. Unknown future rarity never becomes rare by accident. */
export function evaluateHalloweenItem(
	evidence: HalloweenItemEvidence,
	policy: HalloweenPolicy = DEFAULT_HALLOWEEN_POLICY,
): HalloweenAlertItem | null {
	if (!validPolicy(policy) || evidence.quantity <= 0 || !Number.isSafeInteger(evidence.quantity)) return null;
	const reasons: HalloweenAlertReason[] = [];
	if (safeCopper(evidence.netUnitCopper) && evidence.netUnitCopper >= policy.valueThresholdCopper) {
		reasons.push({ code: 'valuable', netUnitCopper: evidence.netUnitCopper, thresholdCopper: policy.valueThresholdCopper });
	}
	const rarity = evidence.catalog?.rarity;
	if (rarity !== undefined && (RARITY_RANK[rarity] ?? -1) >= RARITY_RANK.Rare! &&
		(evidence.bound || evidence.netUnitCopper === null)) {
		reasons.push({ code: 'rare_unpriced_or_bound', rarity });
	}
	if (evidence.firstSeen && !evidence.learning) reasons.push({ code: 'first_seen' });
	if (evidence.unlocks.status === 'complete' && evidence.catalog?.details) {
		const lockedSkinIds = (evidence.catalog.details.skins ?? [])
			.filter((id) => !evidence.unlocks.unlockedSkinIds.includes(id));
		if (lockedSkinIds.length > 0) reasons.push({ code: 'skin_not_unlocked', skinIds: lockedSkinIds });
		const miniId = evidence.catalog.details.minipetId;
		if (miniId !== undefined && !evidence.unlocks.unlockedMiniIds.includes(miniId)) {
			reasons.push({ code: 'mini_not_unlocked', miniId });
		}
	}
	return reasons.length === 0 ? null : {
		itemId: evidence.itemId,
		quantity: evidence.quantity,
		name: evidence.catalog?.name ?? null,
		reasons,
	};
}

export function evaluateHalloweenItems(
	evidence: readonly HalloweenItemEvidence[],
	policy: HalloweenPolicy = DEFAULT_HALLOWEEN_POLICY,
): HalloweenAlertItem[] {
	return evidence.map((item) => evaluateHalloweenItem(item, policy))
		.filter((item): item is HalloweenAlertItem => item !== null)
		.sort((left, right) => left.itemId - right.itemId);
}

function validPolicy(policy: HalloweenPolicy): boolean {
	return Number.isSafeInteger(policy.valueThresholdCopper) && policy.valueThresholdCopper >= 0;
}

function safeCopper(value: number | null): value is number {
	return value !== null && Number.isSafeInteger(value) && value >= 0;
}
