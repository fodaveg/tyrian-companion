import { describe, expect, it } from 'vitest';

import type { StorageFreeSlots } from '../account/storage-snapshot-model';
import {
	buildSlotClearingActions,
	prioritizeSpaceFreeingActions,
	resolveObservedMaterialStorageCapacity,
	resolveStorageSpaceState,
} from './storage-space';

describe('resolveObservedMaterialStorageCapacity', () => {
	it('returns the configured capacity untouched when the user set one', () => {
		expect(resolveObservedMaterialStorageCapacity(1_250, [{ quantity: 3_000 }])).toEqual({
			quantity: 1_250,
			source: 'configured',
		});
	});

	it('floors at the guaranteed 250 when nothing observed exceeds it', () => {
		expect(resolveObservedMaterialStorageCapacity(null, [{ quantity: 10 }, { quantity: 249 }])).toEqual({
			quantity: 250,
			source: 'minimum_observed',
		});
	});

	it('reports the largest quantity actually observed, never the invented 250', () => {
		expect(resolveObservedMaterialStorageCapacity(null, [
			{ quantity: 10 }, { quantity: 1_250 }, { quantity: 900 },
		])).toEqual({ quantity: 1_250, source: 'minimum_observed' });
	});

	it('floors at 250 with no materials observed at all', () => {
		expect(resolveObservedMaterialStorageCapacity(null, [])).toEqual({
			quantity: 250,
			source: 'minimum_observed',
		});
	});
});

describe('resolveStorageSpaceState', () => {
	const freeSlots = (overrides: Partial<Pick<StorageFreeSlots, 'bank' | 'characterBags'>> = {}): Pick<
		StorageFreeSlots, 'bank' | 'characterBags'
	> => ({
		bank: { total: 200, free: 30 },
		characterBags: [
			{ character: 'A', bagIndex: 0, bagItemId: 1, total: 20, free: 5 },
			{ character: 'B', bagIndex: 0, bagItemId: 1, total: 20, free: 3 },
		],
		...overrides,
	});

	it('returns null when the bank was not captured instead of inventing a total', () => {
		expect(resolveStorageSpaceState(freeSlots({ bank: null }), 20)).toBeNull();
	});

	it('sums bags plus bank and flags low space at or under the threshold', () => {
		expect(resolveStorageSpaceState(freeSlots(), 40)).toEqual({
			freeSlots: 38,
			totalSlots: 240,
			thresholdFreeSlots: 40,
			isLow: true,
		});
	});

	it('reports plenty of space above the threshold', () => {
		expect(resolveStorageSpaceState(freeSlots(), 20)).toMatchObject({ isLow: false });
	});

	it('counts zero character bags without crashing', () => {
		expect(resolveStorageSpaceState(freeSlots({ characterBags: [] }), 20)).toEqual({
			freeSlots: 30,
			totalSlots: 200,
			thresholdFreeSlots: 20,
			isLow: false,
		});
	});
});

describe('buildSlotClearingActions', () => {
	it('marks every fully-cleared position as freeing exactly one slot, with exact certainty', () => {
		expect(buildSlotClearingActions([
			{ itemId: 1, source: 'bank', character: null, quantity: 250 },
			{ itemId: 2, source: 'character', character: 'A', quantity: 1 },
		])).toEqual([
			{ itemId: 1, source: 'bank', character: null, quantity: 250, slotsFreed: 1, slotsFreedCertainty: 'exact' },
			{ itemId: 2, source: 'character', character: 'A', quantity: 1, slotsFreed: 1, slotsFreedCertainty: 'exact' },
		]);
	});
});

describe('prioritizeSpaceFreeingActions', () => {
	const actions = [
		{ id: 'a', slotsFreed: 1, goldValue: 300 },
		{ id: 'b', slotsFreed: 3, goldValue: 100 },
		{ id: 'c', slotsFreed: 2, goldValue: 200 },
	];

	it('with little free space, orders by slots freed first', () => {
		expect(prioritizeSpaceFreeingActions(actions, { isLow: true }).map((a) => a.id))
			.toEqual(['b', 'c', 'a']);
	});

	it('with plenty of space, keeps the existing gold order', () => {
		expect(prioritizeSpaceFreeingActions(actions, { isLow: false }).map((a) => a.id))
			.toEqual(['a', 'c', 'b']);
	});

	it('treats an unknown storage state like plenty of space rather than inventing urgency', () => {
		expect(prioritizeSpaceFreeingActions(actions, null).map((a) => a.id))
			.toEqual(['a', 'c', 'b']);
	});

	it('keeps original order on an exact tie', () => {
		const tied = [
			{ id: 'x', slotsFreed: 1, goldValue: 50 },
			{ id: 'y', slotsFreed: 1, goldValue: 50 },
		];
		expect(prioritizeSpaceFreeingActions(tied, { isLow: true }).map((a) => a.id)).toEqual(['x', 'y']);
	});
});
