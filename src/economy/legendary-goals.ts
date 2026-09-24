import type { ReservationGoal, ReservationRequirement } from './reservation-model';
import {
	legendaryMaterialsEntryFor,
	legendaryResolvableRequirements,
	type LegendaryMaterialsTableV1,
} from './legendary-materials';

/**
 * M4 (`docs/SPEC-recomendacion-por-objeto.md`): a fresh, per-sync computation, never persisted
 * into `InventoryPreferencesV1.goals` (the reason `container-recommendation.ts` and
 * `inventory-advisor-presentation-model.ts` both document why `'legendary'` never shows up in
 * THEIR goal lists). `InventoryAnalysisService.derivedGoals` calls this once per advisor analysis
 * with the settings' target list and the freshly-read `GET /v2/account/legendaryarmory` counts; the
 * advisor workflow joins the result to the user's own goals (`mergeDerivedReservationGoals`) before
 * classifying, so the advisor reserves them like any other goal (H18.14).
 */
export interface LegendaryGoalsResult {
	goals: ReservationGoal[];
	/** Target ids with no `LegendaryMaterialsTableV1` entry: the settings panel's own concern
	 * ("sin tabla de materiales"), never a `ReservationRequirement`. */
	withoutTable: number[];
}

/** One priority for every legendary goal: `createReservationPlan`'s own tie-break (goalId, then
 * requirement key, both lexical) is deterministic without needing distinct priorities here, and
 * nothing in M4 ranks one chosen legendary above another. */
const LEGENDARY_GOAL_PRIORITY = 500;

/**
 * Builds one `ReservationGoal` per chosen, not-yet-forged legendary that has a curated materials
 * table entry. `owned` is `GET /v2/account/legendaryarmory`'s per-id `count`; a legendary already
 * forged (`count >= 1`) never gets a goal (M4 test 2). A target without a table entry is reported
 * in `withoutTable` and skipped (M4 test 3): no requirement, no reservation.
 *
 * Pure: no network, no store, matching `src/advisor/inventory-advisor-architecture.test.ts`'s and
 * `src/economy/recommendation-envelope-architecture.test.ts`'s boundary discipline.
 */
export function buildLegendaryReservationGoals(
	targetLegendaryItemIds: readonly number[],
	owned: ReadonlyMap<number, number>,
	table: LegendaryMaterialsTableV1,
): LegendaryGoalsResult {
	const goals: ReservationGoal[] = [];
	const withoutTable: number[] = [];
	for (const legendaryItemId of [...new Set(targetLegendaryItemIds)].sort((left, right) => left - right)) {
		if ((owned.get(legendaryItemId) ?? 0) >= 1) continue;
		const entry = legendaryMaterialsEntryFor(table, legendaryItemId);
		if (entry === null) {
			withoutTable.push(legendaryItemId);
			continue;
		}
		const requirements: ReservationRequirement[] = legendaryResolvableRequirements(entry)
			.map((leaf) => ({
				key: `item:${String(leaf.itemId)}`,
				namespace: 'item' as const,
				id: leaf.itemId,
				targetQuantity: leaf.quantity,
				creditedQuantity: 0,
				basis: 'owned' as const,
				intendedUse: 'hold' as const,
			}));
		if (requirements.length === 0) continue;
		goals.push({
			schemaVersion: 1,
			goalId: `legendary:${String(legendaryItemId)}`,
			title: `legendary-goal-${String(legendaryItemId)}`,
			status: 'active',
			priority: LEGENDARY_GOAL_PRIORITY,
			reason: 'legendary',
			requirements,
		});
	}
	return { goals, withoutTable };
}

/**
 * One position's protected share and the item's goal shortfall. Since H18.14 the split is not
 * computed here any more: the advisor's classification allocates every goal reservation and keep
 * exception to the exact stacks it protects, and `InventoryAnalysisService.evaluate` reads that
 * allocation back per note position (the former `splitLegendaryReservationsByPosition` filled note
 * positions in their own order, which could disagree with the advisor's rows).
 */
export interface LegendaryReservationSplit {
	reservedQuantity: number;
	freeQuantity: number;
	/** The item-level (account-wide) shortfall; identical for every position holding this item. */
	shortfall: number;
}

/**
 * Values the free part of a position "as if the stack were that size"
 * (`docs/SPEC-recomendacion-por-objeto.md` M4): a linear share of the position's own demonstrated
 * instant-sell value, since `recommendPosition`'s only quantity-sensitive use of this number is
 * the capital-threshold gate (rule 3) — the percentile comparison (rule 5) reads price history,
 * never quantity. Floored to stay an integer copper amount; `null` propagates (no demonstrated
 * value to scale).
 */
export function scaledSellCopper(
	totalSellCopper: number | null,
	freeQuantity: number,
	quantity: number,
): number | null {
	if (totalSellCopper === null || quantity <= 0) return totalSellCopper;
	if (freeQuantity >= quantity) return totalSellCopper;
	if (freeQuantity <= 0) return 0;
	return Math.floor((totalSellCopper * freeQuantity) / quantity);
}
