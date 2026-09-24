import { describe, expect, it } from 'vitest';

import { createReservationPlan } from './reservation';
import type { ReservationBalance } from './reservation-model';
import {
	buildLegendaryReservationGoals,
	scaledSellCopper,
} from './legendary-goals';
import { LEGENDARY_MATERIALS_TABLE, LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR } from './legendary-materials';

const SHARD_OF_JANTHIR_SYNTRI = 103_316;

function balanceFor(itemId: number, quantity: number): ReservationBalance {
	return {
		accountId: 'acct-1', snapshotId: 'snap-1', capturedAt: '2026-09-11T00:00:00.000Z',
		coverage: { item: 'complete', currency: 'complete' },
		assets: [{
			key: `item:${String(itemId)}`, namespace: 'item', id: itemId,
			ownedQuantity: quantity, availableQuantity: quantity, coverage: 'complete',
		}],
	};
}

describe('buildLegendaryReservationGoals', () => {
	it('builds one requirement per resolvable leaf for a chosen, not-yet-forged legendary', () => {
		const { goals, withoutTable } = buildLegendaryReservationGoals(
			[LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR], new Map(), LEGENDARY_MATERIALS_TABLE,
		);
		expect(withoutTable).toEqual([]);
		expect(goals).toHaveLength(1);
		const goal = goals[0]!;
		expect(goal.reason).toBe('legendary');
		expect(goal.requirements).toHaveLength(71); // 77 leaves - 6 unresolved
		const requirement = goal.requirements.find((entry) => entry.id === SHARD_OF_JANTHIR_SYNTRI);
		expect(requirement).toMatchObject({
			key: `item:${String(SHARD_OF_JANTHIR_SYNTRI)}`, targetQuantity: 100, creditedQuantity: 0,
			basis: 'owned', intendedUse: 'hold',
		});
	});

	it('test 2: a legendary already forged (count >= 1) gets no goal at all', () => {
		const owned = new Map([[LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR, 1]]);
		const { goals, withoutTable } = buildLegendaryReservationGoals(
			[LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR], owned, LEGENDARY_MATERIALS_TABLE,
		);
		expect(goals).toEqual([]);
		expect(withoutTable).toEqual([]);
	});

	it('test 3: a chosen legendary with no table entry gets no goal, and is reported', () => {
		const untabled = 999_999;
		const { goals, withoutTable } = buildLegendaryReservationGoals(
			[untabled], new Map(), LEGENDARY_MATERIALS_TABLE,
		);
		expect(goals).toEqual([]);
		expect(withoutTable).toEqual([untabled]);
	});
});

/**
 * The legendary goals' reservation (test 1: 60 owned of a 100-target shard is fully reserved and
 * 40 short; 273 owned leaves 173 free), laid onto the plan the advisor classifies with. Since
 * H18.14 the per-position split is the advisor's own (`splitLegendaryReservationsByPosition` is
 * gone); `inventory-analysis.test.ts` checks it position by position, in the view and the notes.
 */
describe('legendary goals in the reservation plan (test 1)', () => {
	it('60 owned of a 100-target shard: all 60 protected, 40 short', () => {
		const { goals } = buildLegendaryReservationGoals(
			[LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR], new Map(), LEGENDARY_MATERIALS_TABLE,
		);
		const planResult = createReservationPlan({ goals, balance: balanceFor(SHARD_OF_JANTHIR_SYNTRI, 60) });
		if (planResult.status !== 'ok') throw new Error('plan should be valid');
		expect(planResult.plan.assets.find((asset) => asset.id === SHARD_OF_JANTHIR_SYNTRI))
			.toMatchObject({ protectedAvailable: 60, unprotectedAvailable: 0, shortfall: 40 });
	});

	it('273 owned of a 100-target shard: 100 protected, 173 free, no shortfall', () => {
		const { goals } = buildLegendaryReservationGoals(
			[LEGENDARY_ARMORY_ITEM_ID_KLOBJARNE_GEIRR], new Map(), LEGENDARY_MATERIALS_TABLE,
		);
		const planResult = createReservationPlan({ goals, balance: balanceFor(SHARD_OF_JANTHIR_SYNTRI, 273) });
		if (planResult.status !== 'ok') throw new Error('plan should be valid');
		expect(planResult.plan.assets.find((asset) => asset.id === SHARD_OF_JANTHIR_SYNTRI))
			.toMatchObject({ protectedAvailable: 100, unprotectedAvailable: 173, shortfall: 0 });
	});
});

describe('scaledSellCopper', () => {
	it('scales the demonstrated value linearly to the free share', () => {
		expect(scaledSellCopper(2_730_000, 173, 273)).toBe(Math.floor((2_730_000 * 173) / 273));
	});

	it('returns the original value untouched when the whole stack is free', () => {
		expect(scaledSellCopper(1_000, 60, 60)).toBe(1_000);
	});

	it('returns 0 when nothing is free', () => {
		expect(scaledSellCopper(1_000, 0, 60)).toBe(0);
	});

	it('propagates null (no demonstrated value)', () => {
		expect(scaledSellCopper(null, 10, 60)).toBeNull();
	});
});
