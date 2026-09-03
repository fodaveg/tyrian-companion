import { describe, expect, it } from 'vitest';

import { afterSnapshot, looseHolding, storageDeltaSnapshot, walletCurrency } from '../account/__fixtures__/storage-delta';
import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { SessionPriceSnapshot } from '../economy/session-price-snapshot';
import type { SessionValuation } from '../economy/session-valuation';
import { buildLootPresentation } from './loot-presentation';
import { renderLootMarkdown } from './loot-presentation-markdown';
import { buildSessionEconomyEvidence, type SessionEconomyEvidence } from './session-economy-evidence';
import { createSessionContaminationReview } from './session-contamination-review';
import { prepareSessionNote, type SessionNoteInput } from './session-note-model';
import { renderSessionNote } from './session-note-renderer';
import { createSessionRuntimeRecord, type SessionRuntimeRecord } from './session-runtime-store';
import type { CompleteSessionState, SessionAuthority, SessionSnapshotReference } from './session';

/**
 * The first real human run, 2026-09-03, Rinopopo the Guardian, 53 min 51 s of Labyrinth farming.
 *
 * The published note produced no economic figure at all: `tc_classification: contaminated`,
 * `tc_observed_immediate_copper: null`, and all forty loot rows reading "Oculto por fiabilidad".
 * The single reason was that two wallet currencies went down — currency 37 is an Exalted Key and
 * currency 42 a Vial of Chak Acid, both spent on the chests that produced the loot — while
 * currency 1 (Coin) had gone UP by 46_083 copper.
 *
 * These are the deltas measured against `/v2/currencies` that day, not invented ones.
 */
const SESSION_FROM = '2026-09-03T05:30:49.000Z';
const SESSION_TO = '2026-09-03T06:24:40.000Z';
const COIN_GAIN = 46_083;
const KARMA_GAIN = 2_785;
/** Positive item deltas, `[itemId, quantity]`, as the note recorded them. */
const GAINED: ReadonlyArray<readonly [number, number]> = [
	[19_700, 16], [36_041, 17], [82_534, 19], [92_272, 13], [46_731, 12],
];
/** Negative item deltas: 239 Pieces of Unidentified Gear and 2 Bags of Alchemical Materials. */
const CONSUMED: ReadonlyArray<readonly [number, number]> = [[84_731, -239], [9_333, -2]];
/** The three gained kinds the Trading Post answered for; the other two came back without a quote. */
const PRICED_ITEM_IDS = [19_700, 36_041, 82_534];

const SESSION_ID = 'session-real-run';
const authority: SessionAuthority = {
	machineId: 'machine', instanceId: 'instance', sessionId: SESSION_ID, fence: 1,
	acquiredAt: Date.parse('2026-09-03T05:30:47.000Z'),
};

describe('H13.6 · the 2026-09-03 farming session', () => {
	it('classifies spent farming inputs as estimated instead of contaminated', () => {
		const { review } = realSession();

		expect(review.classification.status).toBe('estimated');
		expect(review.classification.reasons).toContainEqual({ code: 'consumable_currency_spent' });
		expect(review.classification.reasons).toContainEqual({ code: 'item_losses_observed' });
		expect(review.classification.reasons).not.toContainEqual({ code: 'wallet_decreased' });
		expect(review.classification.reviewRequests).toContainEqual({ code: 'review_consumed_inputs' });
		expect(review.classification.permissions).toMatchObject({
			finalize: true, showNet: true, valueNet: true, grossPerHour: false,
		});
	});

	// The acceptance criterion of the ticket, taken from the published note: this session used to
	// come out with every economic field null. It has to come out with a number.
	it('publishes an economic figure in the note instead of hiding every row', async () => {
		const session = realSession();
		const note = await renderedNote(session);

		expect(note.frontmatter.tc_classification).toBe('estimated');
		expect(note.frontmatter.tc_observed_immediate_copper).toBeTypeOf('number');
		expect(note.frontmatter.tc_observed_immediate_copper)
			.toBe(session.economy.valuation.totals.observedImmediateCopper);
		expect(note.frontmatter.tc_observed_immediate_copper as number).toBeGreaterThan(COIN_GAIN);
		expect(note.content).not.toContain('La actividad externa impide atribuir valor');
		expect(note.content).toContain('Banda observada');
	});

	it('values every loot row it can price and withholds none of them for evidence quality', () => {
		const presentation = buildLootPresentation(preparedNote(realSession()));
		const gains = presentation.rows.filter((row) => row.direction === 'gain');

		expect(gains).toHaveLength(GAINED.length + 2);
		expect(gains.map((row) => row.valuation.status)).not.toContain('withheld');
		expect(gains.filter((row) => row.valuation.status === 'complete' || row.valuation.status === 'partial'))
			.not.toHaveLength(0);
		// What cannot be valued is declared apart with its own reason, not folded into the total.
		expect(presentation.economy.unvaluedItemKinds).toBeGreaterThan(0);
		expect(presentation.warnings).toContain('Faltan precios para parte del botín.');
		expect(presentation.warnings).toContain('Las pérdidas no se valoran como botín.');
	});

	it('brackets the yield with extremes read from the captured quotes and names why', () => {
		const session = realSession();
		const band = buildLootPresentation(preparedNote(session)).economy.attribution;

		expect(band.status).toBe('partially_attributed');
		expect(band.lowCopper).toBe(session.economy.valuation.totals.observedImmediateCopper);
		expect(band.highCopper).toBe(session.economy.valuation.totals.observedListingCopper);
		expect(band.lowCopper as number).toBeLessThan(band.highCopper as number);
		expect(band.causes).toEqual([
			'El extremo bajo vuelca el botín contra las pujas demostradas y el alto lo coloca a precio de venta.',
			'Los tipos que volvieron sin precio cuentan como cero en los dos extremos.',
			'Se consumieron insumos durante la sesión: parte del botín puede salir de existencias anteriores.',
		]);
	});

	// A band whose ends are constants would survive any change to the evidence. These do not: move
	// one observed buy order and the low end moves with it, by exactly the loot that quote covers.
	it('moves both ends when the observed quotes move, so neither end is a constant', () => {
		const base = realSession();
		const raised = realSession({ bidUnitCopper: 60, askUnitCopper: 90 });
		const baseBand = buildLootPresentation(preparedNote(base)).economy.attribution;
		const raisedBand = buildLootPresentation(preparedNote(raised)).economy.attribution;

		expect(raisedBand.lowCopper as number).toBeGreaterThan(baseBand.lowCopper as number);
		expect(raisedBand.highCopper as number).toBeGreaterThan(baseBand.highCopper as number);
		expect((baseBand.lowCopper as number) - COIN_GAIN)
			.toBe(base.economy.valuation.totals.itemImmediateCopper);
	});

	it('renders the band as an interval with both money amounts in the economy block', () => {
		const presentation = buildLootPresentation(preparedNote(realSession()));
		const economy = renderLootMarkdown(presentation).economy;
		const { lowCopper, highCopper } = presentation.economy.attribution;

		expect(economy).toContain(`Banda observada: de ${copper(lowCopper)} a ${copper(highCopper)}`);
		expect(economy).toContain('Atribución: Parcialmente atribuible');
	});

	// The distinction the ticket asks to preserve: gold leaving the wallet is a purchase, and a
	// purchase can inject loot the session never farmed. Same evidence, opposite verdict.
	it('still contaminates the very same session when the gold went DOWN', () => {
		const { review } = realSession({ coinDelta: -12_000 });

		expect(review.classification.status).toBe('contaminated');
		expect(review.classification.reasons).toContainEqual({ code: 'wallet_decreased' });
		expect(review.classification.permissions).toMatchObject({ valueNet: false, grossPerHour: false });
	});

	it('withholds the note economy again when the gold went down', async () => {
		const note = await renderedNote(realSession({ coinDelta: -12_000 }));

		expect(note.frontmatter.tc_classification).toBe('contaminated');
		expect(note.frontmatter.tc_observed_immediate_copper).toBeNull();
		expect(note.content).toContain('La actividad externa impide atribuir valor');
	});
});

interface RealSessionOverrides {
	coinDelta?: number;
	bidUnitCopper?: number;
	askUnitCopper?: number;
}

interface RealSession {
	delta: StorageDelta;
	review: NonNullable<ReturnType<typeof createSessionContaminationReview>>;
	runtime: SessionRuntimeRecord;
	economy: SessionEconomyEvidence & { valuation: SessionValuation };
}

/**
 * Rebuilds the measured session through the same units the plugin runs: the snapshot comparator,
 * the contamination review and `buildSessionEconomyEvidence`, which is what `main.ts` calls before
 * it builds a note. Nothing here re-implements a rule, so a rule that stops being called shows up.
 */
function realSession(overrides: RealSessionOverrides = {}): RealSession {
	const coinDelta = overrides.coinDelta ?? COIN_GAIN;
	const before = baselineSnapshot();
	const after = finalSnapshot(coinDelta);
	const delta = compareStorageSnapshots(before, after);
	if (delta.status === 'invalid') throw new Error('Invalid session fixture.');
	const review = createSessionContaminationReview(before, after, delta, {
		certainty: 'confirmed',
		activities: {
			open: false, salvage: false, consume: false, craft: false, tpBuy: false,
			tpSell: false, vendorBuy: false, vendorSell: false, transfer: false, other: false,
		},
	}, '2026-09-03T06:24:42.000Z');
	if (!review) throw new Error('Invalid review fixture.');
	const status = review.classification.status;
	if (status === 'invalid') throw new Error('Invalid review fixture.');
	const prices = capturedPrices(delta, overrides);
	const runtime = createSessionRuntimeRecord(
		completeState(before, after, status),
		before, after, delta, Date.parse('2026-09-03T06:24:42.000Z'), review, prices,
	);
	if (!runtime) throw new Error('Invalid runtime fixture.');
	const economy = buildSessionEconomyEvidence({ runtime, catalogItems: catalog(), goals: [] });
	if (economy.valuation === null) throw new Error('Invalid economy fixture.');
	return { delta, review, runtime, economy: { ...economy, valuation: economy.valuation } };
}

function baselineSnapshot(): StorageSnapshot {
	return storageDeltaSnapshot({
		snapshotId: 'snapshot-real-before',
		startedAt: '2026-09-03T05:30:48.000Z',
		completedAt: SESSION_FROM,
		holdings: [
			...GAINED.map(([id], index) => looseHolding(id, 1, { source: 'bank', slot: index })),
			...CONSUMED.map(([id, delta], index) => looseHolding(id, -delta, { source: 'bank', slot: 10 + index })),
		],
		currencies: [
			walletCurrency(1, 1_000_000), walletCurrency(2, 500_000),
			walletCurrency(37, 5), walletCurrency(42, 3),
		],
	});
}

function finalSnapshot(coinDelta: number): StorageSnapshot {
	return afterSnapshot({
		snapshotId: 'snapshot-real-after',
		startedAt: SESSION_TO,
		completedAt: '2026-09-03T06:24:41.000Z',
		holdings: GAINED.map(([id, gained], index) => looseHolding(id, 1 + gained, { source: 'bank', slot: index })),
		currencies: [
			walletCurrency(1, 1_000_000 + coinDelta), walletCurrency(2, 500_000 + KARMA_GAIN),
			// The two that invalidated the whole run: one key and one vial spent on chests.
			walletCurrency(37, 4), walletCurrency(42, 2),
		],
	});
}

/** The quotes the public Trading Post answered, three of five kinds; the rest came back empty. */
function capturedPrices(delta: StorageDelta, overrides: RealSessionOverrides): SessionPriceSnapshot {
	const bidUnitCopper = overrides.bidUnitCopper ?? 40;
	const askUnitCopper = overrides.askUnitCopper ?? 70;
	const gained = delta.itemChanges.filter((change) => change.delta > 0)
		.sort((left, right) => left.id - right.id);
	const priced = gained.filter((change) => PRICED_ITEM_IDS.includes(change.id));
	return {
		version: 1, sessionId: SESSION_ID, capturedAt: '2026-09-03T06:24:41.000Z',
		source: 'gw2-commerce-prices', schemaVersion: '2024-07-20T01:00:00.000Z', status: 'partial',
		items: priced.map((change) => ({
			itemId: change.id, quantityGained: change.delta, whitelisted: true,
			bid: { quantity: 10_000, unitCopper: bidUnitCopper },
			ask: { quantity: 10_000, unitCopper: askUnitCopper },
		})),
		missingItemIds: gained.filter((change) => !PRICED_ITEM_IDS.includes(change.id))
			.map((change) => change.id),
		marketDepth: {
			version: 1, capturedAt: '2026-09-03T06:24:41.000Z', source: 'gw2-commerce-listings',
			requestedItemIds: gained.map((change) => change.id),
			status: 'partial',
			items: gained.map((change) => PRICED_ITEM_IDS.includes(change.id)
				? {
					itemId: change.id, coverage: 'complete' as const,
					buys: [{ unitCopper: bidUnitCopper, quantity: 10_000 }],
					sells: [{ unitCopper: askUnitCopper, quantity: 10_000 }],
				}
				: { itemId: change.id, coverage: 'unavailable' as const, buys: [], sells: [] }),
		},
	};
}

function catalog(): Record<string, CatalogItem> {
	return Object.fromEntries(GAINED.map(([id]) => [String(id), {
		kind: 'item' as const, id, name: `Item ${String(id)}`, type: 'Consumable', rarity: 'Basic',
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
		requestedAt: '2026-09-03T05:30:47.000Z', baseline: reference(before),
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
			capturedAt: '2026-09-03T05:30:50.000Z',
		},
		stopRequestedAt: SESSION_TO, stoppedAt: SESSION_TO,
		finalSnapshot: reference(after), finalizedAt: '2026-09-03T06:24:42.000Z', classification,
	};
}

function reference(snapshot: StorageSnapshot): SessionSnapshotReference {
	return {
		snapshotId: snapshot.snapshotId, accountId: snapshot.accountId, schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt, completedAt: snapshot.completedAt, quality: snapshot.quality as 'stable',
	};
}

function noteInput(session: RealSession): SessionNoteInput {
	return {
		runtime: session.runtime, valuation: session.economy.valuation,
		reservation: session.economy.reservation, hold: session.economy.hold,
		recommendation: null, envelope: null,
		eventDeclaration: null, displayNames: {}, locale: 'es', outputFolder: 'Tyrian Companion',
	};
}

function preparedNote(session: RealSession) {
	const prepared = prepareSessionNote(noteInput(session));
	if (prepared.status !== 'ok') throw new Error(`Invalid note fixture: ${prepared.reason}`);
	return prepared.note;
}

async function renderedNote(session: RealSession) {
	const result = await renderSessionNote(preparedNote(session));
	if (result.status !== 'ok') throw new Error(`Render failed: ${result.reason}`);
	return result.note;
}

function copper(value: number | null): string {
	if (value === null) throw new Error('The band has no amount.');
	const gold = Math.floor(value / 10_000);
	const silver = Math.floor(value / 100) % 100;
	return `${String(gold)}g ${String(silver)}s ${String(value % 100)}c`;
}
