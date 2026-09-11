import type { ReservationGoal, ReservationPlan, ReservationRequirement } from './reservation-model';
import {
	legendaryMaterialsEntryFor,
	legendaryResolvableRequirements,
	type LegendaryMaterialsTableV1,
} from './legendary-materials';

/**
 * M4 (`docs/SPEC-recomendacion-por-objeto.md`): a fresh, per-sync computation, never persisted
 * into `InventoryPreferencesV1.goals` (the reason `container-recommendation.ts` and
 * `inventory-advisor-presentation-model.ts` both document why `'legendary'` never shows up in
 * THEIR goal lists). `InventoryVaultCaptureService.capture` calls this once per "Sincronizar
 * inventario" with the settings' target list and the freshly-read `GET
 * /v2/account/legendaryarmory` counts, and feeds the result straight into `createReservationPlan`.
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

export interface LegendaryReservationSplit {
	reservedQuantity: number;
	freeQuantity: number;
	/** The item-level (account-wide) shortfall; identical for every position holding this item. */
	shortfall: number;
}

/**
 * Distributes each legendary-reserved item's account-wide reservation across the positions that
 * hold it, in the exact order `positions` is given (M4 test 7): the caller must pass the same
 * canonical order `buildInventoryVaultPositionCores` already sorts by (itemId, source,
 * character), never a re-sort here, so the split stays reproducible run to run.
 *
 * Reservation fills positions in that order, one at a time, up to each position's own quantity,
 * until the item-level reserved total (`quantityAcrossPositions - asset.unprotectedAvailable`) is
 * exhausted; whatever is left over on a position is free. `plan` must be the one
 * `createReservationPlan` returned for THIS sync's legendary-only goal set (never a plan that also
 * carries achievement/purchase/personal goals): every `item:` asset in it is assumed to exist
 * solely because of a legendary requirement.
 */
export function splitLegendaryReservationsByPosition(
	positions: readonly { positionId: string; itemId: number; quantity: number }[],
	plan: ReservationPlan,
): Map<string, LegendaryReservationSplit> {
	const totalByItemId = new Map<number, number>();
	for (const position of positions) {
		totalByItemId.set(position.itemId, (totalByItemId.get(position.itemId) ?? 0) + position.quantity);
	}
	const remainingByItemId = new Map<number, number>();
	const shortfallByItemId = new Map<number, number>();
	for (const asset of plan.assets) {
		if (asset.namespace !== 'item') continue;
		const total = totalByItemId.get(asset.id);
		if (total === undefined) continue;
		remainingByItemId.set(asset.id, Math.max(0, total - asset.unprotectedAvailable));
		shortfallByItemId.set(asset.id, asset.shortfall);
	}
	const result = new Map<string, LegendaryReservationSplit>();
	for (const position of positions) {
		const remaining = remainingByItemId.get(position.itemId);
		if (remaining === undefined) continue;
		const reservedQuantity = Math.min(remaining, position.quantity);
		remainingByItemId.set(position.itemId, remaining - reservedQuantity);
		result.set(position.positionId, {
			reservedQuantity,
			freeQuantity: position.quantity - reservedQuantity,
			shortfall: shortfallByItemId.get(position.itemId) ?? 0,
		});
	}
	return result;
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
