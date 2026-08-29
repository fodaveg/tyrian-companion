import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import type { SessionContaminationReview } from '../sessions/session-contamination-review';
import { buildHalloweenLootComparison, isHalloweenOutcomeDeviation } from './halloween-loot-comparison';

describe('Halloween loot comparison', () => {
	it('keeps all 18 model rows, including zero observations, in canonical order', () => {
		const result = buildHalloweenLootComparison(input(1_100, [{ id: 36_041, delta: 4_006 }]));
		expect(result).toMatchObject({ eligible: true, reason: null, bagsDisappearedNet: 1_100, minimumBags: 1_100 });
		expect(result.outcomes).toHaveLength(18);
		expect(result.outcomes.map(({ itemId }) => itemId)).toEqual(
			[...result.outcomes.map(({ itemId }) => itemId)].sort((left, right) => left - right),
		);
		expect(result.outcomes.find(({ itemId }) => itemId === 36_032)?.observedUnits).toBe(0);
		expect(result.outcomes.find(({ itemId }) => itemId === 36_041)?.expectedNumerator).toBe(String(386_935 * 1_100));
	});

	it('requires a comparable delta, confirmed review, open-only declaration, and net missing bags', () => {
		const cases = [
			{ mutate: (value: ReturnType<typeof input>) => { value.delta.status = 'limited'; }, reason: 'delta_not_comparable' },
			{ mutate: (value: ReturnType<typeof input>) => { value.review.answers.certainty = 'unsure'; }, reason: 'review_not_confirmed' },
			{ mutate: (value: ReturnType<typeof input>) => { value.review.answers.activities.salvage = true; }, reason: 'activities_not_open_only' },
			{ mutate: (value: ReturnType<typeof input>) => { value.delta.itemChanges[0]!.delta = 1; }, reason: 'bags_not_decreased' },
		] as const;
		for (const entry of cases) {
			const value = input(1_100, []);
			entry.mutate(value);
			expect(buildHalloweenLootComparison(value)).toMatchObject({ eligible: false, reason: entry.reason });
		}
	});

	it('applies every conservative gate at the 1100, E=20, 10%, and Bonferroni z boundaries', () => {
		const deviation = (overrides: Partial<Parameters<typeof isHalloweenOutcomeDeviation>[0]> = {}) =>
			isHalloweenOutcomeDeviation({
				eligible: true, bagsDisappearedNet: 1_100, observedUnits: 10_000,
				expectedSampleUnits: 10, expectedSampleBags: 10,
				...overrides,
			});
		expect(deviation({ bagsDisappearedNet: 1_099 })).toBe(false);
		expect(deviation()).toBe(true);
		expect(deviation({ expectedSampleUnits: 1_999, expectedSampleBags: 110_000 })).toBe(false);
		expect(deviation({ expectedSampleUnits: 2, expectedSampleBags: 110 })).toBe(true);
		expect(deviation({ bagsDisappearedNet: 1_200, observedUnits: 1_319 })).toBe(false);
		expect(deviation({ bagsDisappearedNet: 1_200, observedUnits: 1_320 })).toBe(true);
		expect(deviation({ observedUnits: 577, expectedSampleUnits: 5, expectedSampleBags: 11 })).toBe(false);
		expect(deviation({ observedUnits: 578, expectedSampleUnits: 5, expectedSampleBags: 11 })).toBe(true);
	});

	it('uses BigInt intermediates and bounds display projections for safe-integer deltas', () => {
		const result = buildHalloweenLootComparison(input(Number.MAX_SAFE_INTEGER, [
			{ id: 36_041, delta: Number.MAX_SAFE_INTEGER },
		]));
		expect(result.outcomes[0]?.expectedNumerator.length).toBeGreaterThan(15);
		expect(result.outcomes.every(({ zMilli, differenceBasisPoints }) =>
			Number.isSafeInteger(zMilli) && Number.isSafeInteger(differenceBasisPoints))).toBe(true);
	});
});

function input(bags: number, gains: { id: number; delta: number }[]): {
	vaultId: string; accountRef: string; episodeId: string; delta: StorageDelta; review: SessionContaminationReview;
} {
	const activities = { open: true, salvage: false, consume: false, craft: false, tpBuy: false, tpSell: false,
		vendorBuy: false, vendorSell: false, transfer: false, other: false };
	return {
		vaultId: 'vault', accountRef: 'account', episodeId: 'session:test',
		delta: {
			version: 1, status: 'comparable', accountId: 'account-id', beforeSnapshotId: 'before', afterSnapshotId: 'after',
			window: { from: '2026-08-28T10:00:00.000Z', to: '2026-08-28T11:00:00.000Z' }, surface: 'core_only',
			currencySurface: 'unavailable', reasons: [], warnings: [],
			itemChanges: [{ id: 36_038, before: bags, after: 0, delta: -bags },
				...gains.map(({ id, delta }) => ({ id, before: 0, after: delta, delta }))],
			currencyChanges: [], availabilityChanges: [], compositionChanges: [],
		},
		review: {
			version: 1, reviewedAt: '2026-08-28T11:00:01.000Z', answers: { certainty: 'confirmed', activities },
			declaration: { status: 'activities', activities: ['open'] },
			boundary: {} as SessionContaminationReview['boundary'], classification: {} as SessionContaminationReview['classification'],
		},
	};
}
