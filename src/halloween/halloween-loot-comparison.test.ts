import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import type { SessionClassificationStatus, SessionDeltaClassification } from '../account/contamination-model';
import {
	buildHalloweenLootComparison,
	isHalloweenComparisonRecord,
	isHalloweenOutcomeDeviation,
} from './halloween-loot-comparison';

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

	it('requires a comparable delta, a resolved classification, and net missing bags', () => {
		const cases = [
			{ mutate: (value: ReturnType<typeof input>) => { value.delta.status = 'limited'; }, reason: 'delta_not_comparable' },
			{ mutate: (value: ReturnType<typeof input>) => { value.classification = null; }, reason: 'classification_unavailable' },
			{ mutate: (value: ReturnType<typeof input>) => { value.classification = classification('contaminated'); }, reason: 'session_contaminated' },
			{ mutate: (value: ReturnType<typeof input>) => { value.classification = classification('invalid'); }, reason: 'session_contaminated' },
			{ mutate: (value: ReturnType<typeof input>) => { value.delta.itemChanges[0]!.delta = 1; }, reason: 'bags_not_decreased' },
		] as const;
		for (const entry of cases) {
			const value = input(1_100, []);
			entry.mutate(value);
			expect(buildHalloweenLootComparison(value)).toMatchObject({ eligible: false, reason: entry.reason });
		}
	});

	// Review finding (26 sep 2026): selling a bag on the Trading Post degrades the session to
	// `estimated`/`tp_sell_observed`, never `contaminated` — a status-only gate let it through and
	// counted the sold bags as opened. Each of these reasons on its own must exclude the session,
	// regardless of status, because the evidence itself cannot rule out items moving by something
	// other than opening.
	it.each<SessionDeltaClassification['reasons'][number]>([
		{ code: 'tp_sell_observed' },
		{ code: 'tp_buy_observed' },
		{ code: 'delivery_items_changed' },
		{ code: 'roster_changed' },
		{ code: 'character_unobserved' },
		{ code: 'delta_limited' },
		{ code: 'item_losses_observed' },
	])('excludes with external_item_movement when the classification carries %o', (reason) => {
		const value = input(1_100, [{ id: 36_041, delta: 4_006 }]);
		value.classification = classification('estimated', [reason]);
		expect(buildHalloweenLootComparison(value)).toMatchObject({ eligible: false, reason: 'external_item_movement' });
	});

	// H18.32 correction: `item_losses_observed` alone does not disqualify — only when it is NOT
	// tagged `detail: 'exempt'` (i.e. some loss was not farmed input; see `contamination.ts`).
	it('treats an exempt item-loss reason as clean but a non-exempt one as external movement', () => {
		const exempt = input(1_100, [{ id: 36_041, delta: 4_006 }]);
		exempt.classification = classification('exact', [{ code: 'item_losses_observed', detail: 'exempt' }]);
		expect(buildHalloweenLootComparison(exempt)).toMatchObject({ eligible: true, reason: null });

		const notExempt = input(1_100, [{ id: 36_041, delta: 4_006 }]);
		notExempt.classification = classification('estimated', [{ code: 'item_losses_observed' }]);
		expect(buildHalloweenLootComparison(notExempt)).toMatchObject({ eligible: false, reason: 'external_item_movement' });
	});

	// Per the review: wallet-only signals (an NPC purchase, a non-monetary currency spend, a legacy
	// declared opening, an ambiguous wallet increase) and the API-settlement-window reasons degrade
	// to `estimated` without ever moving an item count, so none of them exclude the comparison.
	it('stays eligible when estimated only by reasons that cannot move an item count', () => {
		const value = input(1_100, [{ id: 36_041, delta: 4_006 }]);
		value.classification = classification('estimated', [
			{ code: 'delivery_coins_changed' }, { code: 'wallet_decreased' }, { code: 'consumable_currency_spent' },
			{ code: 'open_activity_declared' }, { code: 'wallet_increased_ambiguous' },
			{ code: 'api_settlement_window_skipped' }, { code: 'api_settlement_window_exceeded' },
		]);
		expect(buildHalloweenLootComparison(value)).toMatchObject({ eligible: true, reason: null });
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

	it('pins model identity while accepting the legacy record schema and rejecting unknown future models', () => {
		const current = buildHalloweenLootComparison(input(1_100, [{ id: 36_041, delta: 4_006 }]));
		expect(current).toMatchObject({
			version: 2, modelId: 'halloween-trick-or-treat-bag-conservative', modelVersion: 1,
		});
		expect(isHalloweenComparisonRecord(current)).toBe(true);
		const { modelId: _modelId, modelVersion: _modelVersion, ...withoutModel } = current;
		const legacy = { ...withoutModel, version: 1 };
		expect(isHalloweenComparisonRecord(legacy)).toBe(true);
		expect(isHalloweenComparisonRecord({ ...current, modelVersion: 2 })).toBe(false);
		expect(isHalloweenComparisonRecord({ ...current, modelId: 'unknown-future-model' })).toBe(false);
	});

	it('keeps validating and rendering a pre-H18.32 record with the retired reason vocabulary', () => {
		const current = buildHalloweenLootComparison({ ...input(1_100, []), classification: classification('contaminated') });
		expect(current.reason).toBe('session_contaminated');
		const legacyReviewNotConfirmed = { ...current, reason: 'review_not_confirmed' };
		expect(isHalloweenComparisonRecord(legacyReviewNotConfirmed)).toBe(true);
		const legacyActivitiesNotOpenOnly = { ...current, reason: 'activities_not_open_only' };
		expect(isHalloweenComparisonRecord(legacyActivitiesNotOpenOnly)).toBe(true);
	});
});

function classification(
	status: SessionClassificationStatus,
	reasons: SessionDeltaClassification['reasons'] = [],
): Pick<SessionDeltaClassification, 'status' | 'reasons'> {
	return { status, reasons };
}

function input(bags: number, gains: { id: number; delta: number }[]): {
	vaultId: string; accountRef: string; episodeId: string; delta: StorageDelta;
	classification: Pick<SessionDeltaClassification, 'status' | 'reasons'> | null;
} {
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
		classification: classification('exact'),
	};
}
