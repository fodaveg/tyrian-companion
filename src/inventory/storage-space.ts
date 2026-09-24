import type { MaterialStorageCapacity } from '../core/settings';
import type { StorageFreeSlots } from '../account/storage-snapshot-model';
import {
	GUARANTEED_MATERIAL_STORAGE_CAPACITY,
	observedMaterialStorageMinimum,
	type MaterialStorageCapacitySource,
} from '../economy/material-storage-deposit-validation';

/**
 * H18.15 (Auditoría final consolidada, §3.E, §9). A pure module the entry that unifies the
 * advisor's per-object result, the notes and the Base (`inventory-vault-sync.ts`,
 * `recommendPosition`, the advisor view) can consume without depending on the capture pipeline
 * directly. Nothing here writes anything or reads the network; it only turns the free-slot data
 * `StorageSnapshotService` now captures into a storage-space verdict and a prioritized action
 * list.
 */

export interface ObservedMaterialStorageCapacity {
	quantity: number;
	source: MaterialStorageCapacitySource;
}

/**
 * Replaces the flat "250 invented" floor (`settings.ts`'s `resolveMaterialStorageCapacity`) with
 * what the observed stacks prove. Per the audit's acceptance criterion (§3.E): shown as "at least
 * N", never as an invented number. H18.18 wiring: N is the largest stack rounded up to the next
 * multiple of 250 (every real capacity is one), the exact rule the advisor's contract validates as
 * `observed_minimum`; with no stack above 250 it stays the `minimum_guaranteed` 250 older results
 * already carry.
 */
export function resolveObservedMaterialStorageCapacity(
	configured: MaterialStorageCapacity | null,
	materials: readonly { quantity: number }[],
): ObservedMaterialStorageCapacity {
	if (configured !== null) return { quantity: configured, source: 'configured' };
	const observed = observedMaterialStorageMinimum(materials.map((material) => material.quantity));
	return observed > GUARANTEED_MATERIAL_STORAGE_CAPACITY
		? { quantity: observed, source: 'observed_minimum' }
		: { quantity: GUARANTEED_MATERIAL_STORAGE_CAPACITY, source: 'minimum_guaranteed' };
}

export interface StorageSpaceState {
	freeSlots: number;
	totalSlots: number;
	thresholdFreeSlots: number;
	isLow: boolean;
}

/**
 * Sums free slots across every character's bags plus the bank (the boceto's definition of "poco
 * espacio", H18.31 decision 9) and compares the total against the threshold. Returns `null` when
 * the bank was not part of this capture (missing scope, restricted URL, or a failed request):
 * without it the total would silently under-count real free space, and the audit explicitly asks
 * not to invent a number when the account did not answer.
 */
export function resolveStorageSpaceState(
	freeSlots: Pick<StorageFreeSlots, 'bank' | 'characterBags'>,
	thresholdFreeSlots: number,
): StorageSpaceState | null {
	if (freeSlots.bank === null) return null;
	const bagsFree = freeSlots.characterBags.reduce((sum, bag) => sum + bag.free, 0);
	const bagsTotal = freeSlots.characterBags.reduce((sum, bag) => sum + bag.total, 0);
	const freeTotal = bagsFree + freeSlots.bank.free;
	const totalSlots = bagsTotal + freeSlots.bank.total;
	return {
		freeSlots: freeTotal,
		totalSlots,
		thresholdFreeSlots,
		isLow: freeTotal <= thresholdFreeSlots,
	};
}

export type SpaceFreeingActionSource = 'character' | 'shared_inventory' | 'bank';

export interface SlotClearingPosition {
	itemId: number;
	source: SpaceFreeingActionSource;
	character: string | null;
	quantity: number;
}

export interface SpaceFreeingAction extends SlotClearingPosition {
	slotsFreed: number;
	slotsFreedCertainty: 'exact';
}

/**
 * The only slot count this module can state as `'exact'` from a snapshot alone: each position is
 * one occupied slot (`ItemHolding`'s own contract), so fully clearing it — selling the whole
 * stack, discarding it, or moving it into material storage — always frees exactly that one slot.
 * A caller that only clears PART of a stack, or that cannot guarantee a full clear, is expected to
 * mark its own candidate `'estimated'` instead of reusing this list unchanged; this module never
 * invents a slot count for anything short of a full clear.
 */
export function buildSlotClearingActions(
	positions: readonly SlotClearingPosition[],
): SpaceFreeingAction[] {
	return positions.map((position) => ({ ...position, slotsFreed: 1, slotsFreedCertainty: 'exact' as const }));
}

export interface SpaceFreeingPriorityInput {
	slotsFreed: number;
	goldValue: number;
}

/**
 * David's 24 sep 2026 decision (§9, question 4): with little free space, prioritize whatever frees
 * the most slots first; with plenty of space, keep the existing gold-value order. `state === null`
 * (storage space unknown, e.g. the bank was not captured) behaves like plenty of space rather than
 * inventing urgency the snapshot cannot back. Ties keep every action's original relative order.
 */
export function prioritizeSpaceFreeingActions<T extends SpaceFreeingPriorityInput>(
	actions: readonly T[],
	state: Pick<StorageSpaceState, 'isLow'> | null,
): T[] {
	const isLow = state?.isLow ?? false;
	return actions
		.map((action, index) => ({ action, index }))
		.sort((left, right) => {
			const bySlots = right.action.slotsFreed - left.action.slotsFreed;
			const byGold = right.action.goldValue - left.action.goldValue;
			const primary = isLow ? bySlots : byGold;
			if (primary !== 0) return primary;
			const secondary = isLow ? byGold : bySlots;
			if (secondary !== 0) return secondary;
			return left.index - right.index;
		})
		.map((entry) => entry.action);
}
