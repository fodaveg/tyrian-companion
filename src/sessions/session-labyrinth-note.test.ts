import { describe, expect, it } from 'vitest';

import { afterSnapshot, looseHolding, storageDeltaSnapshot, walletCurrency } from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { SessionPriceSnapshot } from '../economy/session-price-snapshot';
import type { SessionValuation } from '../economy/session-valuation';
import { buildLootPresentation } from './loot-presentation';
import { createSessionContaminationReview } from './session-contamination-review';
import { prepareSessionNote, type SessionNoteInput } from './session-note-model';
import { renderSessionNote } from './session-note-renderer';
import { buildSessionEconomyEvidence, type SessionEconomyEvidence } from './session-economy-evidence';
import { createSessionRuntimeRecord, type SessionRuntimeRecord } from './session-runtime-store';
import type { CompleteSessionState, SessionAuthority, SessionSnapshotReference } from './session';

/**
 * H14.1: a Mad King's Labyrinth session that opens Trick-or-Treat Bags (`36038`) and spends a
 * non-monetary wallet currency (a key), with no Trading Post activity at all. The REGLA firmada
 * 2026-09-08 (docs/PRODUCT.md) says this is farming, not contamination or even a degrade: the
 * session must come out `exact`/`high`, with a real hourly rate and zero rows withheld — the exact
 * opposite of the real 2026-09-07 note (101 of 122 rows "Oculto por fiabilidad", rate null).
 */
const SESSION_FROM = '2026-09-07T10:00:00.000Z';
const SESSION_TO = '2026-09-07T11:55:00.000Z';
const BAGS_OPENED = 20;
const KEYS_SPENT = 20;
const COIN_GAIN = 120_000;
/** The five ids the Labyrinth drops together (H3.6's `HALLOWEEN_RELEVANT_ITEM_RULE_SET`). */
const GAINED: ReadonlyArray<readonly [number, number]> = [[36_041, 40], [36_059, 12], [36_060, 8], [36_061, 15]];
const KEY_CURRENCY_ID = 37;
const SESSION_ID = 'session-labyrinth';
const authority: SessionAuthority = {
	machineId: 'machine', instanceId: 'instance', sessionId: SESSION_ID, fence: 1,
	acquiredAt: Date.parse('2026-09-07T09:59:58.000Z'),
};

describe('H14.1 · a real Labyrinth session (bags opened, keys spent, no bazaar)', () => {
	it('classifies the session as exact/high with recommend and grossPerHour granted', () => {
		const { review } = labyrinthSession();

		expect(review.classification).toMatchObject({ status: 'exact', confidence: 'high' });
		expect(review.classification.permissions).toMatchObject({
			finalize: true, showNet: true, valueNet: true, grossPerHour: true, recommend: true,
		});
		expect(review.classification.reasons).toContainEqual({ code: 'consumable_currency_spent' });
		expect(review.classification.reasons).toContainEqual({ code: 'item_losses_observed' });
		expect(review.classification.reasons).toContainEqual({ code: 'open_activity_declared' });
		expect(review.classification.reviewRequests).toEqual([]);
	});

	it('publishes a non-null hourly rate and withholds none of the loot rows', async () => {
		const session = labyrinthSession();
		const note = await renderedNote(session);
		const presentation = buildLootPresentation(preparedNote(session));

		expect(note.frontmatter.tc_classification).toBe('exact');
		expect(note.frontmatter.tc_immediate_copper_per_hour).toBeTypeOf('number');
		expect(note.frontmatter.tc_immediate_copper_per_hour as number).toBeGreaterThan(0);
		const gains = presentation.rows.filter((row) => row.direction === 'gain');
		expect(gains.length).toBeGreaterThan(0);
		expect(presentation.rows.map((row) => row.valuation.status)).not.toContain('withheld');
		expect(note.content).not.toContain('Oculto por fiabilidad');
	});

	// H14.4 point 5: the real 2026-09-07 note joined every motive with "., " into one line
	// ("- Motivos: ..., La declaración no es limpia., ..."). Each motive now gets its own bullet.
	it('renders each classification motive as its own bullet, never joined with "., "', async () => {
		const note = await renderedNote(labyrinthSession());

		expect(note.content).toContain('- Motivo: Declaraste haber abierto contenedores durante la sesión.');
		expect(note.content).toContain('- Motivo: La declaración no es limpia.');
		expect(note.content).not.toContain('., La declaración no es limpia., ');
	});

	it('shows the rate as a band promoted to the results header and a recommendation, never hidden', async () => {
		const note = await renderedNote(labyrinthSession());

		expect(note.content).toContain('Neto inmediato por hora (banda)');
		expect(note.content).not.toContain('recomendación necesita revisión');
	});
});

interface LabyrinthSession {
	delta: StorageDelta;
	review: NonNullable<ReturnType<typeof createSessionContaminationReview>>;
	runtime: SessionRuntimeRecord;
	economy: SessionEconomyEvidence & { valuation: SessionValuation };
}

function labyrinthSession(): LabyrinthSession {
	const before = baselineSnapshot();
	const after = finalSnapshot();
	const delta = compareStorageSnapshots(before, after);
	if (delta.status === 'invalid') throw new Error('Invalid session fixture.');
	const review = createSessionContaminationReview(before, after, delta, {
		certainty: 'unsure',
		activities: {
			open: true, salvage: false, consume: false, craft: false, tpBuy: false,
			tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
		},
	}, '2026-09-07T11:55:02.000Z');
	if (!review) throw new Error('Invalid review fixture.');
	const status = review.classification.status;
	if (status === 'invalid') throw new Error('Invalid review fixture.');
	const prices = capturedPrices(delta);
	const runtime = createSessionRuntimeRecord(
		completeState(before, after, status),
		before, after, delta, Date.parse('2026-09-07T11:55:02.000Z'), review, prices,
	);
	if (!runtime) throw new Error('Invalid runtime fixture.');
	const economy = buildSessionEconomyEvidence({ runtime, catalogItems: catalog(), goals: [] });
	if (economy.valuation === null) throw new Error('Invalid economy fixture.');
	return { delta, review, runtime, economy: { ...economy, valuation: economy.valuation } };
}

function baselineSnapshot(): StorageSnapshot {
	return storageDeltaSnapshot({
		snapshotId: 'snapshot-labyrinth-before',
		startedAt: '2026-09-07T09:59:59.000Z',
		completedAt: SESSION_FROM,
		// The bags themselves, before any of them are opened.
		holdings: [looseHolding(36_038, BAGS_OPENED, { source: 'bank', slot: 5 })],
		currencies: [walletCurrency(1, 500_000), walletCurrency(KEY_CURRENCY_ID, KEYS_SPENT)],
	});
}

function finalSnapshot(): StorageSnapshot {
	return afterSnapshot({
		snapshotId: 'snapshot-labyrinth-after',
		startedAt: SESSION_TO,
		completedAt: '2026-09-07T11:55:01.000Z',
		// Every bag was opened during the session: none remain, so it is simply absent here,
		// and the loot they contained is gained instead.
		holdings: GAINED.map(([id, gained], index) => looseHolding(id, gained, { source: 'bank', slot: index })),
		// Every key was spent opening bags; none remain, so it is simply absent here.
		currencies: [walletCurrency(1, 500_000 + COIN_GAIN)],
	});
}

function capturedPrices(delta: StorageDelta): SessionPriceSnapshot {
	const gained = delta.itemChanges.filter((change) => change.delta > 0)
		.sort((left, right) => left.id - right.id);
	return {
		version: 1, sessionId: SESSION_ID, capturedAt: '2026-09-07T11:55:01.000Z',
		source: 'gw2-commerce-prices', schemaVersion: '2024-07-20T01:00:00.000Z', status: 'complete',
		items: gained.map((change) => ({
			itemId: change.id, quantityGained: change.delta, whitelisted: true,
			bid: { quantity: 10_000, unitCopper: 20 },
			ask: { quantity: 10_000, unitCopper: 35 },
		})),
		missingItemIds: [],
		marketDepth: {
			version: 1, capturedAt: '2026-09-07T11:55:01.000Z', source: 'gw2-commerce-listings',
			requestedItemIds: gained.map((change) => change.id),
			status: 'complete',
			items: gained.map((change) => ({
				itemId: change.id, coverage: 'complete' as const,
				buys: [{ unitCopper: 20, quantity: 10_000 }],
				sells: [{ unitCopper: 35, quantity: 10_000 }],
			})),
		},
	};
}

function catalog(): Record<string, CatalogItem> {
	return Object.fromEntries(GAINED.map(([id]) => [String(id), {
		kind: 'item' as const, id, name: `Item ${String(id)}`, type: 'TrophyId', rarity: 'Basic',
		level: 0, vendorValue: 0, flags: [], gameTypes: [], restrictions: [],
	}]));
}

function completeState(
	before: StorageSnapshot,
	after: StorageSnapshot,
	classification: 'exact' | 'estimated' | 'contaminated',
): CompleteSessionState {
	return {
		version: 1, status: 'complete', sessionId: SESSION_ID, authority,
		requestedAt: '2026-09-07T09:59:58.000Z', baseline: reference(before),
		startContext: {
			characterName: 'Rinopopo', magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Guardian',
				specializations: [
					{ id: 3, traits: [1, 2, 3] },
					{ id: 52, traits: [4, 5, 6] },
					{ id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-09-07T10:00:01.000Z',
		},
		stopRequestedAt: SESSION_TO, stoppedAt: SESSION_TO,
		finalSnapshot: reference(after), finalizedAt: '2026-09-07T11:55:02.000Z', classification,
	};
}

function reference(snapshot: StorageSnapshot): SessionSnapshotReference {
	return {
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt, quality: snapshot.quality as 'stable',
	};
}

function noteInput(session: LabyrinthSession): SessionNoteInput {
	return {
		runtime: session.runtime, valuation: session.economy.valuation,
		reservation: session.economy.reservation, hold: session.economy.hold,
		recommendation: null, envelope: null,
		eventDeclaration: null, displayNames: {}, locale: 'es', outputFolder: 'Tyrian Companion',
	};
}

function preparedNote(session: LabyrinthSession) {
	const prepared = prepareSessionNote(noteInput(session));
	if (prepared.status !== 'ok') throw new Error(`Invalid note fixture: ${prepared.reason}`);
	return prepared.note;
}

async function renderedNote(session: LabyrinthSession) {
	const result = await renderSessionNote(preparedNote(session));
	if (result.status !== 'ok') throw new Error(`Render failed: ${result.reason}`);
	return result.note;
}
