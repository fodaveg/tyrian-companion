/**
 * H18.11, prueba 7 of the audit (§8.7): a move between characters, a move between storages,
 * opening containers and the Trading Post, each as a whole closed session through the real delta,
 * classifier, valuation and note renderer. The summary must keep liquid gold, sellable item value
 * and attribution apart, never count the same thing twice, and never present the attribution as
 * exact: it is declared uncertain, with the causes the evidence actually shows.
 */
import { describe, expect, it } from 'vitest';

import {
	afterSnapshot,
	deliveryCurrency,
	deliveryHolding,
	looseHolding,
	storageDeltaSnapshot,
	walletCurrency,
} from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import type { ItemHolding, StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { SessionPriceSnapshot } from '../economy/session-price-snapshot';
import { formatLootMoney } from './loot-presentation';
import { sessionAttributionSummary } from './session-attribution';
import { createSessionContaminationReview } from './session-contamination-review';
import { buildSessionEconomyEvidence } from './session-economy-evidence';
import { prepareSessionNote, type PreparedSessionNote } from './session-note-model';
import { renderSessionNote } from './session-note-renderer';
import { createSessionRuntimeRecord } from './session-runtime-store';
import type { CompleteSessionState, SessionAuthority, SessionSnapshotReference, SessionStopBoundary } from './session';

const SESSION_ID = 'session-attribution';
const STOPPED_AT = '2026-08-13T09:00:00.000Z';
/** The final capture reads the account twelve minutes after the end, as a real wait would. */
const FINAL_STARTED_AT = '2026-08-13T09:12:00.000Z';
const FINAL_COMPLETED_AT = '2026-08-13T09:12:01.000Z';
const TRICK_OR_TREAT_BAG = 36_038;
const authority: SessionAuthority = {
	machineId: 'machine', instanceId: 'instance', sessionId: SESSION_ID, fence: 1,
	acquiredAt: Date.parse('2026-08-13T07:59:58.000Z'),
};
const characterA = { source: 'character' as const, character: 'Astra Uno', container: 'bag' as const, bagIndex: 0, slot: 0 };
const characterB = { source: 'character' as const, character: 'Astra Dos', container: 'bag' as const, bagIndex: 0, slot: 0 };

describe('prueba 7: attribution without double counting or false exactness (H18.11)', () => {
	it('A→B between characters: nothing gained, nothing to sell, and the move is not loot', async () => {
		const note = closedSession(
			[looseHolding(500, 3, characterA)],
			[looseHolding(500, 3, characterB)],
		);
		const summary = sessionAttributionSummary(note);

		expect(note.runtime.delta.itemChanges.filter((change) => change.delta !== 0)).toEqual([]);
		expect(summary).toMatchObject({ liquidCopper: 0, sellableNowCopper: 0, sellableListedCopper: 0 });
		expect(summary.causes.map((cause) => cause.code)).toEqual(['start_not_settled', 'after_end_window']);
		const rendered = await render(note);
		expect(rendered.frontmatter.tc_positive_item_deltas_json).toBe('[]');
		expect(rendered.frontmatter.tc_classification).toBe('exact');
	});

	it('moving items between storages (bag, bank, materials) is not a gain either', () => {
		const note = closedSession(
			[looseHolding(500, 3, characterA), looseHolding(600, 10, { source: 'bank', slot: 1 })],
			[looseHolding(500, 3, { source: 'bank', slot: 2 }), looseHolding(600, 10, { source: 'materials', category: 5 })],
		);
		const summary = sessionAttributionSummary(note);

		expect(summary).toMatchObject({ sellableNowCopper: 0, sellableListedCopper: 0, liquidCopper: 0 });
		expect(summary.causes.map((cause) => cause.code)).not.toContain('trading_post_activity');
	});

	it('opening containers values only what came out, once, and says part of it may be older stock', () => {
		const note = closedSession(
			[looseHolding(TRICK_OR_TREAT_BAG, 20, characterA)],
			[looseHolding(700, 30, characterA), looseHolding(701, 5, characterA)],
			{ coinBefore: 100_000, coinAfter: 150_000 },
		);
		const summary = sessionAttributionSummary(note);
		const valuation = valuationOf(note);

		// The bags are an input, not a loss the value subtracts, and never a gain.
		expect(valuation.lines.map((line) => line.itemId)).toEqual([700, 701]);
		expect(summary.sellableNowCopper).toBe(sum(valuation.lines.map((line) => line.immediateBestCopper ?? 0)));
		expect(summary.sellableNowCopper).toBeGreaterThan(0);
		expect(summary.sellableListedCopper).toBeGreaterThanOrEqual(summary.sellableNowCopper!);
		// Liquid gold is the coin alone, and the observed total is exactly items plus coin: no overlap.
		expect(summary.liquidCopper).toBe(50_000);
		expect(valuation.totals.observedImmediateCopper).toBe(summary.sellableNowCopper! + summary.liquidCopper!);
		expect(summary.causes.map((cause) => cause.code)).toContain('consumed_inputs');
	});

	it('the Trading Post degrades the reading and is declared as a cause, never hidden in the total', async () => {
		const note = closedSession(
			[looseHolding(500, 3, characterA)],
			[looseHolding(500, 1, characterA), deliveryHolding(800, 4)],
			{ coinBefore: 100_000, coinAfter: 80_000, deliveryCoinAfter: 5_000 },
		);
		const summary = sessionAttributionSummary(note);

		expect(note.runtime.review.classification.status).toBe('estimated');
		expect(summary.causes.map((cause) => cause.code)).toContain('trading_post_activity');
		// Wallet and pick-up coin together: spent 20 000, 5 000 waiting at the Trading Post.
		expect(summary.liquidCopper).toBe(-15_000);
		expect(valuationOf(note).lines.map((line) => line.itemId)).toEqual([800]);
		const rendered = await render(note);
		expect(rendered.content).toContain('Hubo movimiento del bazar durante la sesión');
	});

	it('writes the three figures apart in the summary and never calls the attribution exact', async () => {
		const note = closedSession(
			[looseHolding(TRICK_OR_TREAT_BAG, 20, characterA)],
			[looseHolding(700, 30, characterA), looseHolding(701, 5, characterA)],
			{ coinBefore: 100_000, coinAfter: 150_000 },
		);
		const summary = sessionAttributionSummary(note);
		const content = (await render(note)).blocks.summary.content;

		expect(content).toContain(`- Oro líquido (moneda neta): ${formatLootMoney(50_000, 'es').visual}`);
		expect(content).toContain(`- Valor vendible de los objetos: ${formatLootMoney(summary.sellableNowCopper!, 'es').visual} vendiendo ya · ${formatLootMoney(summary.sellableListedCopper!, 'es').visual} publicándolo en el bazar`);
		expect(content).toContain('- Atribución a la sesión: incierta');
		expect(content).toContain('puede contar botín de hasta 10 min antes del inicio');
		expect(content).toContain('La foto final leyó la cuenta 12 min después del fin');
		expect(content).toContain('Se abrieron contenedores o se gastaron insumos');
		expect(content).not.toMatch(/Atribución a la sesión: exacta/u);
	});

	it('declares an interrupted end as its own cause', () => {
		const note = closedSession([looseHolding(500, 3, characterA)], [looseHolding(500, 3, characterA)], {
			stopBoundary: 'last_saved_evidence',
		});
		expect(sessionAttributionSummary(note).causes.map((cause) => cause.code)).toContain('end_uncertain');
	});

	it('shows no figure the classification withholds instead of printing zero', () => {
		const note = closedSession([looseHolding(500, 3, characterA)], [looseHolding(500, 3, characterA)]);
		note.runtime.review.classification.permissions.showNet = false;
		note.runtime.review.classification.permissions.valueNet = false;
		expect(sessionAttributionSummary(note)).toMatchObject({
			liquidCopper: null, sellableNowCopper: null, sellableListedCopper: null, unvaluedItemKinds: null,
		});
	});
});

interface SessionOptions {
	coinBefore?: number;
	coinAfter?: number;
	deliveryCoinAfter?: number;
	stopBoundary?: SessionStopBoundary;
}

/** One complete session through the real delta, classifier, valuation and note model. */
function closedSession(before: ItemHolding[], after: ItemHolding[], options: SessionOptions = {}): PreparedSessionNote {
	const baseline = twoCharacters(storageDeltaSnapshot({
		holdings: before,
		currencies: [walletCurrency(1, options.coinBefore ?? 100_000)],
	}));
	const final = twoCharacters(afterSnapshot({
		startedAt: FINAL_STARTED_AT,
		completedAt: FINAL_COMPLETED_AT,
		holdings: after,
		currencies: [
			walletCurrency(1, options.coinAfter ?? options.coinBefore ?? 100_000),
			...(options.deliveryCoinAfter === undefined ? [] : [deliveryCurrency(1, options.deliveryCoinAfter)]),
		],
	}));
	const delta = compareStorageSnapshots(baseline, final);
	if (delta.status === 'invalid') throw new Error('Invalid delta fixture.');
	const review = createSessionContaminationReview(
		baseline, final, delta, '2026-08-13T09:12:02.000Z', 'settled', [TRICK_OR_TREAT_BAG],
	);
	if (!review || review.classification.status === 'invalid') throw new Error('Invalid review fixture.');
	const state: CompleteSessionState = {
		version: 1, status: 'complete', sessionId: SESSION_ID, authority,
		requestedAt: '2026-08-13T07:59:59.000Z', baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] },
					{ id: 52, traits: [4, 5, 6] },
					{ id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: STOPPED_AT, stoppedAt: STOPPED_AT,
		...(options.stopBoundary === undefined ? {} : { stopBoundary: options.stopBoundary }),
		finalSnapshot: reference(final), finalizedAt: '2026-08-13T09:12:03.000Z', classification: review.classification.status,
	};
	const runtime = createSessionRuntimeRecord(
		state, baseline, final, delta, Date.parse(state.finalizedAt), review, prices(delta),
	);
	if (!runtime) throw new Error('Invalid runtime fixture.');
	const economy = buildSessionEconomyEvidence({ runtime, catalogItems: catalog(delta), goals: [] });
	if (economy.valuation === null) throw new Error('Invalid economy fixture.');
	const prepared = prepareSessionNote({
		runtime, valuation: economy.valuation, reservation: economy.reservation, hold: economy.hold,
		recommendation: null, envelope: null, eventDeclaration: null, displayNames: {},
		firstSeenItemIds: [], rareUnpricedOrBoundItemIds: [], locale: 'es', outputFolder: 'Tyrian Companion',
	});
	if (prepared.status !== 'ok') throw new Error(`Invalid note fixture: ${prepared.reason}`);
	return prepared.note;
}

function twoCharacters(snapshot: StorageSnapshot): StorageSnapshot {
	return {
		...snapshot,
		roster: ['Astra Uno', 'Astra Dos'],
		coverage: {
			...snapshot.coverage,
			characters: { 'Astra Uno': { status: 'complete' }, 'Astra Dos': { status: 'complete' } },
		},
	};
}

function prices(delta: ReturnType<typeof compareStorageSnapshots>): SessionPriceSnapshot {
	const gained = delta.status === 'invalid' ? [] : delta.itemChanges.filter((change) => change.delta > 0)
		.sort((left, right) => left.id - right.id);
	return {
		version: 1, sessionId: SESSION_ID, capturedAt: FINAL_COMPLETED_AT,
		source: 'gw2-commerce-prices', schemaVersion: '2024-07-20T01:00:00.000Z', status: 'complete',
		items: gained.map((change) => ({
			itemId: change.id, quantityGained: change.delta, whitelisted: true,
			bid: { quantity: 10_000, unitCopper: 200 },
			ask: { quantity: 10_000, unitCopper: 350 },
		})),
		missingItemIds: [],
		marketDepth: {
			version: 1, capturedAt: FINAL_COMPLETED_AT, source: 'gw2-commerce-listings',
			requestedItemIds: gained.map((change) => change.id),
			status: 'complete',
			items: gained.map((change) => ({
				itemId: change.id, coverage: 'complete' as const,
				buys: [{ unitCopper: 200, quantity: 10_000 }],
				sells: [{ unitCopper: 350, quantity: 10_000 }],
			})),
		},
	};
}

function catalog(delta: ReturnType<typeof compareStorageSnapshots>): Record<string, CatalogItem> {
	const ids = delta.status === 'invalid' ? [] : delta.itemChanges.filter((change) => change.delta > 0).map((change) => change.id);
	return Object.fromEntries(ids.map((id) => [String(id), {
		kind: 'item' as const, id, name: `Item ${String(id)}`, type: 'Trophy', rarity: 'Basic',
		level: 0, vendorValue: 0, flags: [], gameTypes: [], restrictions: [],
	}]));
}

function reference(snapshot: StorageSnapshot): SessionSnapshotReference {
	return {
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt, quality: snapshot.quality as 'stable',
	};
}

function valuationOf(note: PreparedSessionNote) {
	if (note.valuation.status !== 'valid') throw new Error('Valuation fixture was not valid.');
	return note.valuation.value;
}

async function render(note: PreparedSessionNote) {
	const result = await renderSessionNote(note);
	if (result.status !== 'ok') throw new Error(`Render failed: ${result.reason}`);
	return result.note;
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}
