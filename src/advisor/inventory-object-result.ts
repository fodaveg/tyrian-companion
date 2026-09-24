import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { buildInventoryAdvisorReservationBalance, createReservationPlan } from '../economy/reservation';
import type { ReservationGoal } from '../economy/reservation-model';
import type { MaterialStorageCapacitySource } from '../economy/material-storage-deposit-validation';
import { INVENTORY_ADVISOR_REASON_CODES } from './inventory-advisor-contract';
import type { InventoryAdvisorReasonCode, InventoryRecommendationAction } from './inventory-advisor-model';
import {
	POSITION_RECOMMENDATION_ACTIONS,
	POSITION_RECOMMENDATION_REASON_CODES,
	type PositionRecommendationReasonCode,
	type PositionRecommendationV1,
} from './inventory-position-recommendation';

/**
 * H18.14 (audit 2026-09-24 §3.A): one result per object, read by the advisor view, the inventory
 * notes and the Base alike. Before this, two engines answered the same question: the advisor
 * (every route, the user's preferences, memory only) and `recommendPosition` (notes and Base,
 * sell/hold/wait only, blind to "conservar"). They disagreed on the same object.
 *
 * The advisor is now the SOURCE: its classification decides the route (sell, list, vendor,
 * salvage, use, open, deposit, keep, review) and how much of each position the user's goals and
 * keep exceptions protect. `recommendPosition` is kept, unchanged, as the MOMENT stage the
 * advisor's market routes consume: whether to act now, wait for the season, or hold for a better
 * price. Nothing here classifies an item on its own; every function below only combines those two
 * answers, so there is no third engine.
 *
 * The decision vocabulary is `recommendPosition`'s own (so every note already in a Vault stays
 * valid) plus the advisor's routes, appended.
 */
export const INVENTORY_OBJECT_DECISION_ACTIONS = [
	...POSITION_RECOMMENDATION_ACTIONS,
	'list', 'vendor', 'salvage', 'use', 'open', 'deposit_material', 'keep', 'discard_review',
] as const;
export type InventoryObjectDecisionAction = typeof INVENTORY_OBJECT_DECISION_ACTIONS[number];

/** A decision carries either the moment stage's reason or the advisor's own, never a new one. */
export type InventoryObjectDecisionReasonCode = PositionRecommendationReasonCode | InventoryAdvisorReasonCode;
export const INVENTORY_OBJECT_DECISION_REASON_CODES: readonly InventoryObjectDecisionReasonCode[] = Object.freeze([
	...new Set<InventoryObjectDecisionReasonCode>([...POSITION_RECOMMENDATION_REASON_CODES, ...INVENTORY_ADVISOR_REASON_CODES]),
]);

/** The advisor's route for one decision, with the irreversible discard kept apart as a review. */
export type InventoryObjectRoute = Exclude<InventoryRecommendationAction, 'discard_candidate'> | 'discard_review';

/** Routes the player can carry out right now; everything else waits, holds or asks for a look. */
const ACT_NOW_ROUTES: ReadonlySet<InventoryObjectDecisionAction> = new Set([
	'sell', 'list', 'vendor', 'salvage', 'use', 'open', 'deposit_material',
]);

/**
 * One object's decision. `until` keeps its three meanings apart exactly as `recommendPosition`
 * gives them (audit Anexo 3): a price verdict's expiry, a selling window's close, or the next
 * window's open; `priceQuotedAt`/`priceHistoryLastDay` date today's quote and the history
 * separately. Every evidence field is null when the decision does not rest on a price.
 */
export interface InventoryObjectDecisionV1 {
	action: InventoryObjectDecisionAction;
	reason: InventoryObjectDecisionReasonCode;
	until: string | null;
	missing: number | null;
	pricePercentile: number | null;
	priceCoverageDays: number | null;
	priceQuotedAt: string | null;
	priceHistoryLastDay: string | null;
}

/**
 * One note position's share of the object result. `reservedQuantity` is what the user's goals and
 * keep exceptions hold back, `freeQuantity` the rest; both null means uncertain (a chosen goal
 * without a materials table, H18.1), never free. `actionableQuantity` is how much the player can
 * act on right now: 0 while the decision waits, holds, keeps or asks for a review.
 */
export interface InventoryObjectPositionResultV1 extends InventoryObjectDecisionV1 {
	reservedQuantity: number | null;
	freeQuantity: number | null;
	actionableQuantity: number;
}

/**
 * Everything one analysis concluded, keyed so each surface finds its own rows: `decisions` by the
 * advisor's `explanationRef` (one per view row), `positions` by the note's `positionId`. Plain
 * data: it is cloned, cached and compared, never called.
 */
export interface InventoryObjectResultsV1 {
	version: 1;
	snapshotId: string;
	decisions: Record<string, InventoryObjectDecisionV1>;
	positions: Record<string, InventoryObjectPositionResultV1>;
	uncertainItemIds: number[];
	/** H18.15: the storage space this analysis saw. Absent on results built before H18.15. */
	storageSpace?: InventoryObjectStorageSpaceV1 | null;
}

/** Free and total slots of one kind of container, both as the capture counted them. */
export interface InventoryObjectSlotCountV1 {
	free: number;
	total: number;
}

/**
 * H18.15 (audit 2026-09-24 §3.E, §9): the storage space one analysis saw, for every surface that
 * orders or explains by it. Every count comes from the capture; a store the capture did not read
 * is `null`, never zero.
 *
 * - `bags` sums every character's equipped bags; `bank` and `sharedInventory` are the account
 *   stores.
 * - `lowSpace` compares bags + bank with the threshold (the boceto's decision 9); null without the
 *   bank, since the total would silently under-count real free space.
 * - `materialCapacity` is the per-material capacity the classification used: configured, the
 *   guaranteed 250, or the minimum the stacks prove ("at least N").
 * - `slotsFreedByDecision`, keyed like `decisions`: how many whole bag, shared-inventory or bank
 *   slots an act-now decision empties (only stacks it clears entirely count, so the number is
 *   exact). A decision that frees nothing is absent.
 */
export interface InventoryObjectStorageSpaceV1 {
	bags: InventoryObjectSlotCountV1 | null;
	bank: InventoryObjectSlotCountV1 | null;
	sharedInventory: InventoryObjectSlotCountV1 | null;
	lowSpace: { freeSlots: number; totalSlots: number; thresholdFreeSlots: number; isLow: boolean } | null;
	materialCapacity: { quantity: number; source: MaterialStorageCapacitySource } | null;
	slotsFreedByDecision: Record<string, number>;
}

const NO_EVIDENCE = {
	missing: null, pricePercentile: null, priceCoverageDays: null, priceQuotedAt: null, priceHistoryLastDay: null,
} as const;

/** The view's action for an advisor decision, discard candidates staying review-only. */
export function inventoryObjectRoute(action: InventoryRecommendationAction): InventoryObjectRoute {
	return action === 'discard_candidate' ? 'discard_review' : action;
}

/** True when the decision asks the player to do something now (not wait, hold, keep or review). */
export function isActNowInventoryDecision(action: InventoryObjectDecisionAction): boolean {
	return ACT_NOW_ROUTES.has(action);
}

/**
 * Combines the advisor's route with the moment stage's verdict for the same object.
 *
 * - A market route (`sell`/`list`) takes its moment from `timing`: sell now, wait for the season
 *   (`sell_at_season`) or hold for a better price (`hold`/`below_local_band`). When the moment
 *   stage cannot judge the timing (price history off, no quote, too little history, a calendar it
 *   cannot read) the advisor's route stands, carrying that reason: there is no demonstrated
 *   advantage in waiting, which is not the same as "do not sell".
 * - DECISION OF THIS LOT (H18.14, not in the plan): `below_capital_threshold` no longer turns a
 *   market route into "keep". The threshold says the capital is too small to be worth timing,
 *   so the advisor's route stands now instead of silently dropping its sale advice.
 * - Reservation outcomes (`hold_for_legendary`, `reservation_uncertain`) and `not_tradeable`
 *   always win: no route can sell what is held back or cannot be sold.
 * - Every other route (vendor, salvage, use, open, deposit, keep, review, discard review) has no
 *   timing model and stands as the advisor gave it, with the advisor's own reason.
 */
export function decideInventoryObjectRoute(
	route: InventoryObjectRoute,
	advisorReason: InventoryAdvisorReasonCode,
	timing: PositionRecommendationV1 | null,
): InventoryObjectDecisionV1 {
	if ((route === 'sell' || route === 'list') && timing !== null) {
		const evidence = {
			missing: timing.missing, pricePercentile: timing.pricePercentile, priceCoverageDays: timing.priceCoverageDays,
			priceQuotedAt: timing.priceQuotedAt, priceHistoryLastDay: timing.priceHistoryLastDay,
		};
		if (timing.action === 'hold_for_legendary' || timing.reason === 'reservation_uncertain'
			|| timing.reason === 'not_tradeable') return { ...timing };
		if (timing.action === 'sell_at_season') return { ...timing };
		if (timing.action === 'hold' && timing.reason === 'below_local_band') return { ...timing };
		if (timing.action === 'review') return { action: route, reason: timing.reason, until: null, ...evidence };
		return { action: route, reason: timing.reason, until: timing.until, ...evidence };
	}
	return { action: route, reason: advisorReason, until: null, ...NO_EVIDENCE };
}

/**
 * A stack the user's preferences protect entirely: a goal reservation (held for a legendary when
 * the goal is one, kept otherwise, `missing` = how much the goal still lacks) or a keep exception.
 */
export function decideProtectedInventoryObject(
	protection: 'goal' | 'keep',
	legendaryGoal: boolean,
	shortfall: number,
): InventoryObjectDecisionV1 {
	return protection === 'goal'
		? { action: legendaryGoal ? 'hold_for_legendary' : 'keep', reason: 'reserved_for_goal', until: null, ...NO_EVIDENCE, missing: shortfall }
		: { action: 'keep', reason: 'user_keep_exception', until: null, ...NO_EVIDENCE };
}

/** H18.1: a chosen goal without a materials table leaves the free share unknown, shown as such. */
export function uncertainInventoryObjectDecision(): InventoryObjectDecisionV1 {
	return { action: 'review', reason: 'reservation_uncertain', until: null, ...NO_EVIDENCE };
}

/**
 * Goals the plugin derives itself (the legendary targets in settings, M4) join the user's own
 * goals before classification, so the advisor reserves them exactly like any other goal and every
 * surface reads the same protected quantity. They are never persisted with the preferences.
 *
 * H18.1 is preserved: when the combined reservation plan cannot be built, the derived goals are
 * dropped and every item they require turns uncertain (never free) rather than invalidating the
 * user's own goals or the whole classification.
 */
export function mergeDerivedReservationGoals(
	snapshot: StorageSnapshot,
	userGoals: readonly ReservationGoal[],
	derived: { goals: readonly ReservationGoal[]; uncertainItemIds: readonly number[] },
): { goals: ReservationGoal[]; uncertainItemIds: number[] } {
	const uncertain = new Set(derived.uncertainItemIds);
	const own = structuredClone([...userGoals]);
	if (derived.goals.length === 0) return { goals: own, uncertainItemIds: sortedIds(uncertain) };
	const combined = [...own, ...structuredClone([...derived.goals])];
	const balance = buildInventoryAdvisorReservationBalance(snapshot);
	const plan = balance.status === 'ok' ? createReservationPlan({ goals: combined, balance: balance.balance }) : null;
	if (plan !== null && plan.status === 'ok') return { goals: combined, uncertainItemIds: sortedIds(uncertain) };
	for (const goal of derived.goals) for (const requirement of goal.requirements) {
		if (requirement.namespace === 'item') uncertain.add(requirement.id);
	}
	return { goals: own, uncertainItemIds: sortedIds(uncertain) };
}

function sortedIds(values: ReadonlySet<number>): number[] {
	return [...values].sort((left, right) => left - right);
}
