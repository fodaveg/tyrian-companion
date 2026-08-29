import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import type { SessionContaminationReview } from '../sessions/session-contamination-review';
import { buildHalloweenLootComparison } from './halloween-loot-comparison';
import type { HalloweenObservationV1 } from './halloween-model';
import { IndexedDbHalloweenStore } from './halloween-store';

describe('Halloween comparison store', () => {
	it('writes all 18 outcomes atomically with the final episode seal and stays idempotent', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), `h11-comparison-${crypto.randomUUID()}`);
		const comparison = buildHalloweenLootComparison(input());
		const observation = finalObservation();
		await store.replaceEpisodeNotice('vault', 'account', 'session:test', observation, null, comparison);
		await store.replaceEpisodeNotice('vault', 'account', 'session:test', observation, null, comparison);
		const persisted = await store.readLatestComparison('vault', 'account');
		expect(persisted).toEqual(comparison);
		expect(persisted?.outcomes).toHaveLength(18);
		store.close();
	});

	it('aborts both the comparison and terminal seal when the record is corrupt', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), `h11-comparison-corrupt-${crypto.randomUUID()}`);
		const comparison = buildHalloweenLootComparison(input());
		comparison.outcomes.pop();
		await expect(store.replaceEpisodeNotice('vault', 'account', 'session:test', finalObservation(), null, comparison))
			.rejects.toMatchObject({ failure: 'corrupt' });
		expect(await store.readLatestComparison('vault', 'account')).toBeNull();
		const valid = buildHalloweenLootComparison(input());
		await expect(store.replaceEpisodeNotice('vault', 'account', 'session:test', finalObservation(), null, valid))
			.resolves.toMatchObject({ changed: true });
		store.close();
	});
});

function input() {
	const delta: StorageDelta = {
		version: 1, status: 'comparable', accountId: 'account-id', beforeSnapshotId: 'a', afterSnapshotId: 'b',
		window: { from: '2026-08-28T10:00:00.000Z', to: '2026-08-28T11:00:00.000Z' }, surface: 'core_only',
		currencySurface: 'unavailable', reasons: [], warnings: [], itemChanges: [
			{ id: 36_038, before: 1_100, after: 0, delta: -1_100 },
			{ id: 36_041, before: 0, after: 4_006, delta: 4_006 },
		], currencyChanges: [], availabilityChanges: [], compositionChanges: [],
	};
	const review: SessionContaminationReview = {
		version: 1, reviewedAt: '2026-08-28T11:00:01.000Z',
		answers: { certainty: 'confirmed', activities: { open: true, salvage: false, consume: false, craft: false,
			tpBuy: false, tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false } },
		declaration: { status: 'activities', activities: ['open'] },
		boundary: {} as SessionContaminationReview['boundary'], classification: {} as SessionContaminationReview['classification'],
	};
	return { vaultId: 'vault', accountRef: 'account', episodeId: 'session:test', delta, review };
}

function finalObservation(): HalloweenObservationV1 {
	return { version: 1, vaultId: 'vault', accountRef: 'account', observationId: 'session_final:a:b',
		episodeId: 'session:test', observedAt: '2026-08-28T11:00:00.000Z', source: 'session_final', coverage: 'complete',
		gains: [{ itemId: 36_041, quantity: 4_006 }] };
}
