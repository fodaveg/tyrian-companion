import { describe, expect, it } from 'vitest';

import { compareStorageSnapshots } from '../account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { HttpResponse } from '../core/http';
import {
	SessionPriceSnapshotService,
	type SessionPriceSnapshot,
} from '../economy/session-price-snapshot';
import { HALLOWEEN_TOT_BAG_ITEM_ID } from '../economy/session-valuation';
import { prepareSessionNote } from './session-note-model';
import {
	buildSessionEconomyEvidence,
	sessionBindingEvidence,
	sessionValuationItemIds,
	SESSION_SACK_ITEM_IDS,
} from './session-economy-evidence';
import type { CompleteSessionState, SessionSnapshotReference } from './session';
import { createSessionContaminationReview } from './session-contamination-review';
import { createSessionRuntimeRecord, type SessionRuntimeRecord } from './session-runtime-store';

const OTHER_ITEM_ID = 24_295;
const SACKS_GAINED = 6;
const STOPPED_AT = '2026-08-13T09:00:00.000Z';
const PRICES_CAPTURED_AT = '2026-08-13T09:10:01.000Z';

describe('binding evidence read off the closing snapshot', () => {
	it('reports an item held only without binding metadata as unbound', () => {
		const snapshot = afterSnapshot({
			holdings: [looseHolding(HALLOWEEN_TOT_BAG_ITEM_ID, 4, { source: 'bank', slot: 0 })],
		});
		expect(sessionBindingEvidence(snapshot, [HALLOWEEN_TOT_BAG_ITEM_ID]))
			.toEqual({ [String(HALLOWEEN_TOT_BAG_ITEM_ID)]: 'unbound' });
	});

	it('keeps the strictest evidence when the same item is held bound and unbound', () => {
		const snapshot = afterSnapshot({
			holdings: [
				looseHolding(OTHER_ITEM_ID, 4, { source: 'bank', slot: 0 }),
				looseHolding(OTHER_ITEM_ID, 1, { source: 'bank', slot: 1 }, { binding: 'Account' }),
				looseHolding(OTHER_ITEM_ID, 1, { source: 'bank', slot: 2 }, { binding: 'Character', boundTo: 'Astra Uno' }),
			],
		});
		expect(sessionBindingEvidence(snapshot, [OTHER_ITEM_ID]))
			.toEqual({ [String(OTHER_ITEM_ID)]: 'character_bound' });
	});

	it('refuses to guess for an item the closing snapshot does not hold', () => {
		const snapshot = afterSnapshot({ holdings: [looseHolding(100, 2, { source: 'bank', slot: 0 })] });
		expect(sessionBindingEvidence(snapshot, [OTHER_ITEM_ID]))
			.toEqual({ [String(OTHER_ITEM_ID)]: 'unknown' });
	});

	it('maps an unrecognised binding string to unknown rather than to unbound', () => {
		const snapshot = afterSnapshot({
			holdings: [looseHolding(OTHER_ITEM_ID, 1, { source: 'bank', slot: 0 }, { binding: 'Guild' })],
		});
		expect(sessionBindingEvidence(snapshot, [OTHER_ITEM_ID]))
			.toEqual({ [String(OTHER_ITEM_ID)]: 'unknown' });
	});
});

describe('economic evidence for a completed session', () => {
	it('values the session and hands the note a pair it accepts', async () => {
		const runtime = await completedRecord();
		const evidence = buildSessionEconomyEvidence({ runtime, catalogItems: catalog(), goals: [] });

		expect(evidence.valuation).not.toBeNull();
		expect(evidence.reservation).not.toBeNull();
		expect(evidence.valuation?.coverage).toBe('complete');
		expect(evidence.valuation?.rates.sacks).toBe(SACKS_GAINED);
		expect(evidence.valuation?.totals.observedImmediateCopper).toBeGreaterThan(0);
		expect(evidence.reservation?.overlay.sackItemIds).toEqual([...SESSION_SACK_ITEM_IDS]);
		// Nothing can declare a hold intent yet, so the plan says the whole gain is free. Without
		// this the loot block calls the entire economy invalid for want of an allocation.
		expect(evidence.hold?.allocations).toEqual([]);
		expect(evidence.hold?.items).toEqual([
			{ itemId: OTHER_ITEM_ID, inputFreeQuantity: 2, heldQuantity: 0, remainingFreeQuantity: 2 },
			{ itemId: HALLOWEEN_TOT_BAG_ITEM_ID, inputFreeQuantity: SACKS_GAINED, heldQuantity: 0, remainingFreeQuantity: SACKS_GAINED },
		]);

		const prepared = prepareSessionNote({
			runtime, valuation: evidence.valuation, reservation: evidence.reservation,
			hold: evidence.hold, recommendation: null, envelope: null, eventDeclaration: null,
			displayNames: {}, locale: 'es', outputFolder: 'Tyrian Companion',
		});
		if (prepared.status !== 'ok') throw new Error(`The note rejected the evidence: ${prepared.reason}.`);
		expect(prepared.note.valuation.status).toBe('valid');
		expect(prepared.note.reservation.status).toBe('valid');
		expect(prepared.note.hold.status).toBe('valid');
	});

	it('counts sacks only when the reservation that declares them travels with the valuation', async () => {
		const runtime = await completedRecord();
		const evidence = buildSessionEconomyEvidence({ runtime, catalogItems: catalog(), goals: [] });

		// Dropping the reservation is exactly what the note does when it cannot revalidate one, and
		// it re-checks the valuation against an empty sack list. A pair that disagreed here would be
		// published as `invalid`, which is why the two are always emitted together.
		const orphaned = prepareSessionNote({
			runtime, valuation: evidence.valuation, reservation: null,
			hold: null, recommendation: null, envelope: null, eventDeclaration: null,
			displayNames: {}, locale: 'es', outputFolder: 'Tyrian Companion',
		});
		if (orphaned.status !== 'ok') throw new Error(`Unexpected note failure: ${orphaned.reason}.`);
		expect(orphaned.note.valuation.status).toBe('invalid');
	});

	it('still values a session whose catalog could not be resolved, and says the coverage is partial', async () => {
		const runtime = await completedRecord();
		const evidence = buildSessionEconomyEvidence({ runtime, catalogItems: {}, goals: [] });

		expect(evidence.valuation?.coverage).toBe('partial');
		expect(evidence.valuation?.warnings).toContain('catalog_missing');
		expect(evidence.valuation?.rates.sacks).toBe(SACKS_GAINED);
		expect(evidence.valuation?.totals.observedImmediateCopper).toBe(0);
	});

	it('leaves a session without close-time prices unevaluated instead of inventing one', async () => {
		const runtime = await completedRecord(null);
		expect(buildSessionEconomyEvidence({ runtime, catalogItems: catalog(), goals: [] }))
			.toEqual({ valuation: null, reservation: null, hold: null });
	});

	it('lists exactly the gained item ids, ascending', async () => {
		expect(sessionValuationItemIds(await completedRecord()))
			.toEqual([OTHER_ITEM_ID, HALLOWEEN_TOT_BAG_ITEM_ID]);
	});
});

function catalog(): Record<string, CatalogItem> {
	return {
		[String(HALLOWEEN_TOT_BAG_ITEM_ID)]: item(HALLOWEEN_TOT_BAG_ITEM_ID, 'Trick-or-Treat Bag', 10),
		[String(OTHER_ITEM_ID)]: item(OTHER_ITEM_ID, 'Vial of Powerful Blood', 33),
	};
}

function item(id: number, name: string, vendorValue: number): CatalogItem {
	return {
		kind: 'item', id, name, type: 'Trophy', rarity: 'Fine', level: 0,
		vendorValue, flags: [], gameTypes: ['Pve'], restrictions: [],
	};
}

/** Passing `null` builds the same session without the close-time price snapshot. */
async function completedRecord(prices: 'captured' | null = 'captured'): Promise<SessionRuntimeRecord> {
	const baseline = storageDeltaSnapshot({
		startedAt: '2026-08-13T07:59:59.000Z', completedAt: '2026-08-13T08:00:00.000Z',
	});
	const final = afterSnapshot({
		startedAt: '2026-08-13T09:10:00.000Z', completedAt: PRICES_CAPTURED_AT,
		holdings: [
			...baseline.holdings,
			looseHolding(HALLOWEEN_TOT_BAG_ITEM_ID, SACKS_GAINED, { source: 'bank', slot: 1 }),
			looseHolding(OTHER_ITEM_ID, 2, { source: 'materials', category: 5 }),
		],
	});
	const delta = compareStorageSnapshots(baseline, final);
	const reviewedAt = '2026-08-13T09:10:05.000Z';
	const review = createSessionContaminationReview(baseline, final, delta, {
		certainty: 'confirmed',
		activities: {
			open: false, salvage: false, consume: false, craft: false, tpBuy: false,
			tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
		},
	}, reviewedAt);
	if (delta.status === 'invalid' || review === null || review.classification.status === 'invalid') {
		throw new Error('The completed-session fixture is invalid.');
	}
	const record = createSessionRuntimeRecord(
		completeState(baseline, final, review.classification.status, reviewedAt),
		baseline, final, delta, Date.parse(reviewedAt), review,
		prices === null ? null : await capturePrices(delta),
	);
	if (record === null) throw new Error('The completed-session fixture is invalid.');
	return record;
}

async function capturePrices(delta: StorageDelta): Promise<SessionPriceSnapshot> {
	const captured = await new SessionPriceSnapshotService(
		marketGateway(), () => Date.parse(PRICES_CAPTURED_AT),
	).capture('session-1', delta);
	if (captured.status !== 'complete') {
		throw new Error(`The price fixture must be complete, not ${captured.status}.`);
	}
	return captured;
}

function marketGateway(): PublicCatalogGateway {
	const quotes: Record<number, { bid: number; ask: number }> = {
		[HALLOWEEN_TOT_BAG_ITEM_ID]: { bid: 60, ask: 96 },
		[OTHER_ITEM_ID]: { bid: 2_000, ask: 2_400 },
	};
	return {
		requestDetailed: async (path: string): Promise<HttpResponse> => {
			const ids = /[?&]ids=([0-9,]+)/u.exec(path)?.[1]?.split(',').map(Number);
			if (ids === undefined) return { status: 404, headers: {}, body: [] };
			if (path.startsWith('commerce/prices')) {
				return { status: 200, headers: {}, body: ids.map((id) => ({
					id, whitelisted: true,
					buys: { quantity: 10_000, unit_price: quotes[id]?.bid ?? 1 },
					sells: { quantity: 10_000, unit_price: quotes[id]?.ask ?? 2 },
				})) };
			}
			if (path.startsWith('commerce/listings')) {
				return { status: 200, headers: {}, body: ids.map((id) => ({
					id,
					buys: [{ listings: 1, unit_price: quotes[id]?.bid ?? 1, quantity: 10_000 }],
					sells: [{ listings: 1, unit_price: quotes[id]?.ask ?? 2, quantity: 10_000 }],
				})) };
			}
			return { status: 404, headers: {}, body: [] };
		},
	};
}

function completeState(
	baseline: StorageSnapshot,
	final: StorageSnapshot,
	classification: CompleteSessionState['classification'],
	finalizedAt: string,
): CompleteSessionState {
	const reference = (snapshot: StorageSnapshot): SessionSnapshotReference => ({
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion, startedAt: snapshot.startedAt,
		completedAt: snapshot.completedAt,
		quality: snapshot.quality as SessionSnapshotReference['quality'],
	});
	return {
		version: 1, status: 'complete', sessionId: 'session-1',
		authority: {
			machineId: 'machine-1', instanceId: 'instance-1', sessionId: 'session-1',
			fence: 1, acquiredAt: Date.parse('2026-08-13T07:59:58.000Z'),
		},
		requestedAt: '2026-08-13T07:59:58.500Z',
		baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno',
			magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] }, { id: 52, traits: [4, 5, 6] }, { id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: STOPPED_AT, stoppedAt: STOPPED_AT,
		finalSnapshot: reference(final), finalizedAt, classification,
	};
}
