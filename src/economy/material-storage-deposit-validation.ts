import type { StorageSnapshot } from '../account/storage-snapshot-model';

/** The per-material capacity every account has without buying a single expansion. */
export const GUARANTEED_MATERIAL_STORAGE_CAPACITY = 250;
/** Each expansion adds exactly this much, so every real capacity is a multiple of it. */
const MATERIAL_STORAGE_CAPACITY_STEP = 250;
/** The highest capacity the plugin models (the settings dropdown's own ceiling). */
const MAX_MATERIAL_STORAGE_CAPACITY = 3000;

/**
 * Where a material storage capacity comes from:
 * - `configured`: the user picked it in settings.
 * - `minimum_guaranteed`: nothing is known, so only the 250 every account has.
 * - `observed_minimum` (H18.15): nothing is configured, but the capture holds more than 250 of some
 *   material, so the capacity is AT LEAST the next multiple of 250 above that stack. Shown as
 *   "at least N", never as the account's real capacity, which the API does not report.
 */
export type MaterialStorageCapacitySource = 'configured' | 'minimum_guaranteed' | 'observed_minimum';

/**
 * The smallest capacity the observed stacks prove: the largest stored quantity rounded up to the
 * next multiple of 250 (every real capacity is one), never below the guaranteed 250 and never
 * above the modelled ceiling. A stack above that ceiling proves nothing the model can express.
 */
export function observedMaterialStorageMinimum(storedQuantities: Iterable<number>): number {
	let largest = 0;
	for (const quantity of storedQuantities) largest = Math.max(largest, quantity);
	const rounded = Math.ceil(largest / MATERIAL_STORAGE_CAPACITY_STEP) * MATERIAL_STORAGE_CAPACITY_STEP;
	return Math.min(MAX_MATERIAL_STORAGE_CAPACITY, Math.max(GUARANTEED_MATERIAL_STORAGE_CAPACITY, rounded));
}

/** Per-material quantities a snapshot holds in material storage, one entry per item. */
export function materialStorageStoredQuantities(snapshot: Pick<StorageSnapshot, 'holdings'>): number[] {
	const byItem = new Map<number, number>();
	for (const holding of snapshot.holdings) {
		if (holding.kind !== 'item' || holding.location.source !== 'materials') continue;
		byItem.set(holding.itemId, (byItem.get(holding.itemId) ?? 0) + holding.quantity);
	}
	return [...byItem.values()];
}

/**
 * The shape rule every decision and engine validator shares, with no snapshot at hand: a multiple
 * of 250 inside the modelled range, the guaranteed floor only as exactly 250, and an observed
 * minimum only above it (at 250 nothing was observed beyond the guarantee). Whether an observed
 * minimum matches ITS snapshot is checked where the snapshot is available
 * (`observedMaterialStorageMinimumMatches`).
 */
export function isMaterialStorageCapacity(capacity: unknown, source: unknown): boolean {
	if (typeof capacity !== 'number' || !Number.isSafeInteger(capacity)
		|| capacity < GUARANTEED_MATERIAL_STORAGE_CAPACITY || capacity > MAX_MATERIAL_STORAGE_CAPACITY
		|| capacity % MATERIAL_STORAGE_CAPACITY_STEP !== 0) return false;
	if (source === 'configured') return true;
	if (source === 'minimum_guaranteed') return capacity === GUARANTEED_MATERIAL_STORAGE_CAPACITY;
	return source === 'observed_minimum' && capacity > GUARANTEED_MATERIAL_STORAGE_CAPACITY;
}

/**
 * H18.15: replaces the flat "250 invented" floor with what the snapshot proves. A configured
 * capacity always wins; with nothing configured, a stack above 250 turns the guaranteed floor
 * into an `observed_minimum`. At or below 250 nothing changes, so every older result stays
 * byte-identical.
 */
export function materialStorageCapacityForSnapshot(
	capacity: { quantity: number; source: MaterialStorageCapacitySource },
	snapshot: Pick<StorageSnapshot, 'holdings'>,
): { quantity: number; source: MaterialStorageCapacitySource } {
	if (capacity.source === 'configured') return { ...capacity };
	const observed = observedMaterialStorageMinimum(materialStorageStoredQuantities(snapshot));
	return observed > GUARANTEED_MATERIAL_STORAGE_CAPACITY
		? { quantity: observed, source: 'observed_minimum' }
		: { quantity: GUARANTEED_MATERIAL_STORAGE_CAPACITY, source: 'minimum_guaranteed' };
}

/** An observed minimum is valid only as exactly what its own snapshot's stacks prove. */
export function observedMaterialStorageMinimumMatches(
	capacity: { quantity: number; source: string },
	snapshot: Pick<StorageSnapshot, 'holdings'>,
): boolean {
	return capacity.source !== 'observed_minimum'
		|| capacity.quantity === observedMaterialStorageMinimum(materialStorageStoredQuantities(snapshot));
}

export interface MaterialStorageDepositDecision {
	action: string;
	itemId: number;
	quantity: number;
	materialStorage?: {
		capacity: number;
		capacitySource: string;
		storedQuantity: number;
		spaceBefore: number;
	};
}

/** Validates the shared capacity budget across every deposit slice of one item. */
export function materialStorageDepositsFit(
	decisions: readonly MaterialStorageDepositDecision[],
): boolean {
	const deposits = new Map<number, { context: NonNullable<MaterialStorageDepositDecision['materialStorage']>; quantity: number }>();
	for (const decision of decisions) {
		if (decision.action !== 'deposit_material') continue;
		const context = decision.materialStorage;
		if (context === undefined) return false;
		const current = deposits.get(decision.itemId);
		if (current === undefined) {
			if (decision.quantity > context.spaceBefore) return false;
			deposits.set(decision.itemId, { context, quantity: decision.quantity });
			continue;
		}
		if (!sameContext(current.context, context)) return false;
		const quantity = current.quantity + decision.quantity;
		if (!Number.isSafeInteger(quantity) || quantity > context.spaceBefore) return false;
		current.quantity = quantity;
	}
	return true;
}

function sameContext(
	left: NonNullable<MaterialStorageDepositDecision['materialStorage']>,
	right: NonNullable<MaterialStorageDepositDecision['materialStorage']>,
): boolean {
	return left.capacity === right.capacity
		&& left.capacitySource === right.capacitySource
		&& left.storedQuantity === right.storedQuantity
		&& left.spaceBefore === right.spaceBefore;
}
