import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import {
	PINNED_SCHEMA,
	type ItemHolding,
	type SourceCoverage,
	type StorageFreeSlots,
	type StorageSnapshot,
} from '../account/storage-snapshot-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from '../advisor/inventory-advisor-contract';
import { sha256InventoryKnowledgePack } from '../advisor/inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from '../advisor/inventory-advisor-classifier-model';
import type { InventoryAdvisorEvidenceV1 } from '../advisor/inventory-advisor-evidence-model';
import type { AccountSignalsV1, InventoryItemPriceV1, InventoryPriceSnapshotV1, KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import {
	InventoryAdvisorWorkflow,
	type InventoryAdvisorRules,
	type InventoryObjectAnalysisPort,
} from '../advisor/inventory-advisor-workflow';
import type { InventoryObjectResultsV1 } from '../advisor/inventory-object-result';
import { inventoryManagedAssets } from '../assets/inventory-bases';
import type { CatalogItem, CatalogResolution } from '../catalog/public-catalog-model';
import type { InventoryMarketDepthEvidenceV1 } from '../economy/commerce-listings';
import type { LegendaryMaterialsTableV1 } from '../economy/legendary-materials';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { IndexedDbPriceSeedCacheStore } from '../economy/price-seed-cache-store';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';
import type { ReservationGoal } from '../economy/reservation-model';
import type { SeasonalWindowV1 } from '../economy/seasonal-window';
import { InventoryAdvisorPresentationController } from '../ui/inventory-advisor-controller';
import type { InventoryAdvisorViewRow } from '../ui/inventory-advisor-view-model';
import {
	InventoryAnalysisService,
	inventoryAnalysisReadyForNotes,
	inventoryVaultSyncInputFromAnalysis,
	type InventoryPositionRecommendationPort,
} from './inventory-analysis';
import {
	InventoryVaultSyncService,
	type InventoryVaultFile,
	type InventoryVaultPort,
	type InventoryVaultPosition,
} from './inventory-vault-sync';

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';
const AS_OF = '2026-12-20T12:00:00.000Z';
const AS_OF_MS = Date.parse(AS_OF);
const WINDOW: SeasonalWindowV1 = { version: 1, seasonId: 'h18-window', opensOn: '12-15', closesOn: '01-10', returnsInMonth: 12 };
const AUTUMN_WINDOW: SeasonalWindowV1 = { version: 1, seasonId: 'h18-autumn', opensOn: '10-01', closesOn: '11-15', returnsInMonth: 10 };
const SIGNAL = { minimumOfMaxBps: 9_000, referenceDays: 365, minimumReferenceDays: 30 } as const;

/**
 * H18.14 (audit 2026-09-24 §3.A, prueba 1): one account, one snapshot, one set of preferences.
 * The advisor view (its controller's model), the inventory notes (what the writer puts on disk)
 * and the Base (its own filters evaluated on those notes) must all carry the same decision.
 *
 * - 20: a keep exception on the whole stack. The advisor keeps it; at e693eba the notes ignored the
 *   preference and read `review`/`price_history_disabled` (or `sell` with history on).
 * - 21: a user goal reserving 3 of 5. Three kept for the goal, two sold now.
 * - 22: a festival item outside its selling window, today's bid well below its yearly high. Until
 *   H18.19 the moment was to wait for the season on the calendar's word; now nothing demonstrates
 *   that waiting pays (36 days of history, and no curated start for the 2027 edition), so every
 *   surface sells it now with "not enough data" as the reason.
 * - 23: a plain item without enough history: sold now, with no demonstrated advantage in waiting.
 */
describe('one result per object: the advisor view, the notes and the Base agree (H18.14)', () => {
	it('gives the same decision for every object in the view, in its note and in the Base', async () => {
		const holdings = [
			bank(20, 5, 0), bank(21, 5, 1), bank(22, 5, 2), bank(23, 5, 3),
		];
		const goals: ReservationGoal[] = [goal('build-21', 'Build', 21, 3)];
		const keepExceptions: KeepExceptionV1[] = [keepAll('keep-20', 20)];
		const port = recommendationPort({
			readDaily: async (itemId) => itemId === 22 ? dailySeries(itemId, 36, 1_000, 0, AS_OF_MS) : [],
			seasonalInputFor: (itemId) => itemId === 22 ? { window: AUTUMN_WINDOW, parameters: SIGNAL } : null,
		});
		const analysed = await analyse(holdings, { goals, keepExceptions, port });

		const rows = analysed.rows;
		const notes = analysed.notes;
		const base = await baseViews();

		// The view: the advisor's rows, each with its decision.
		expect(rowFor(rows, 20, 'keep')).toMatchObject({ action: 'keep', decision: { action: 'keep', reason: 'user_keep_exception' } });
		expect(rowFor(rows, 21, 'keep')).toMatchObject({ quantity: 3, decision: { action: 'keep', reason: 'reserved_for_goal' } });
		expect(rowFor(rows, 21, 'sell')).toMatchObject({ quantity: 2, decision: { action: 'sell', reason: 'price_history_insufficient' } });
		expect(rowFor(rows, 22, 'sell')).toMatchObject({
			action: 'sell', decision: {
				action: 'sell', reason: 'wait_evidence_insufficient', until: '2026-12-20T12:15:00.000Z',
				sellWindowFromDay: null, sellOrWait: { verdict: 'insufficient_data' },
			},
		});
		expect(rowFor(rows, 23, 'sell')).toMatchObject({ decision: { action: 'sell', reason: 'price_history_insufficient' } });

		// The notes: the same decisions, with the protected share counted as reserved.
		expect(notes.get(20)).toMatchObject({
			tc_recommendation: 'keep', tc_recommendation_reason: 'user_keep_exception',
			tc_reserved_quantity: 5, tc_free_quantity: 0, tc_actionable_quantity: 0,
		});
		expect(notes.get(21)).toMatchObject({
			tc_recommendation: 'sell', tc_recommendation_reason: 'price_history_insufficient',
			tc_reserved_quantity: 3, tc_free_quantity: 2, tc_actionable_quantity: 2,
		});
		expect(notes.get(22)).toMatchObject({
			tc_recommendation: 'sell', tc_recommendation_reason: 'wait_evidence_insufficient',
			tc_recommendation_until: '2026-12-20T12:15:00.000Z', tc_actionable_quantity: 5,
			tc_sell_window_from: null, tc_sell_window_to: null, tc_wait_verdict: 'insufficient_data', tc_wait_mode: 'instant',
		});
		expect(notes.get(23)).toMatchObject({ tc_recommendation: 'sell', tc_actionable_quantity: 5, tc_wait_verdict: null });

		// The Base, on those notes: sell now holds exactly the objects to act on now.
		expect([...notes].filter(([, note]) => base.sellNow(note)).map(([itemId]) => itemId)).toEqual([21, 22, 23]);
		expect([...notes].filter(([, note]) => base.waitToSell(note)).map(([itemId]) => itemId)).toEqual([]);

		// And generically: the note's decision is the one of the view row that covers its free share
		// (or its protected share, when nothing is free).
		for (const [itemId, note] of notes) {
			const row = primaryRowFor(rows, itemId, note);
			expect(row.decision, `item ${String(itemId)}`).toMatchObject({
				action: note.tc_recommendation, reason: note.tc_recommendation_reason,
				until: note.tc_recommendation_until,
			});
		}
	});

	it('reads the whole analysis from one capture: the notes never ask the account for anything', async () => {
		const capture = vi.fn();
		const analysed = await analyse([bank(23, 5, 0), character(23, 2, 'Alfa', 0)], { capture });
		expect(capture).toHaveBeenCalledOnce();
		// The notes' rows are the advisor's own snapshot, not a second read of the account.
		expect(analysed.input.capturedAt).toBe(analysed.source.input.snapshot.completedAt);
		expect(analysed.input.positions.map(({ source, quantity }) => ({ source, quantity }))).toEqual([
			{ source: 'bank', quantity: 5 }, { source: 'character', quantity: 2 },
		]);
		expect(analysed.objects.snapshotId).toBe(analysed.source.input.snapshot.snapshotId);
	});

	it('an invalid classification stays the view\'s own "invalid" and never reaches the notes', async () => {
		// Two goals with the same title: the reservation plan, and so the classification, is invalid.
		const goals = [goal('a', 'Same', 42, 1), goal('b', 'Same', 42, 1)];
		const snapshot = snapshotOf([bank(42, 5, 0)]);
		const evidence = evidenceOf(snapshot, {});
		const service = new InventoryAnalysisService(recommendationPort());
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture: async () => ({ status: 'complete' as const, evidence, marketDepth: marketDepthOf(evidence.prices) }) },
			preferences: { load: async () => ({ status: 'ready', value: { goals, keepExceptions: [] } }) },
			rules: { current: () => ({ status: 'available', value: rulesFixture() }) },
			now: () => AS_OF_MS,
			objects: { derivedGoals: async () => await service.derivedGoals(), evaluate: async (source, ids) => await service.evaluate(source, ids) },
		});
		const controller = new InventoryAdvisorPresentationController({ load: async () => await workflow.refresh('es') });
		await controller.refresh();
		expect(controller.current()).toMatchObject({ status: 'invalid' });
		expect(controller.current().blockedReason).toBeUndefined();
		const analysis = controller.analysis();
		if (analysis === null || analysis.objects === null) throw new Error('Expected the invalid analysis to be retained.');
		expect(analysis.objects.decisions).toEqual({});
		expect(inventoryAnalysisReadyForNotes(analysis.source, analysis.objects, AS_OF_MS)).toBe(false);
		await expect(inventoryVaultSyncInputFromAnalysis(analysis.source, analysis.objects)).rejects.toThrow('inventory_analysis_invalid');
	});

	it('only an analysis on a stable, complete and fresh snapshot may rewrite the notes', async () => {
		const analysed = await analyse([bank(23, 5, 0)]);
		const { source, objects } = analysed;
		expect(inventoryAnalysisReadyForNotes(source, objects, AS_OF_MS)).toBe(true);
		expect(inventoryAnalysisReadyForNotes(source, null, AS_OF_MS)).toBe(false);
		// Older than the advisor's own snapshot policy (15 min): a fresh analysis is needed.
		expect(inventoryAnalysisReadyForNotes(source, objects, AS_OF_MS + 16 * 60_000)).toBe(false);
		const unstable = structuredClone(source);
		unstable.input.snapshot.quality = 'unstable';
		expect(inventoryAnalysisReadyForNotes(unstable, objects, AS_OF_MS)).toBe(false);
		await expect(inventoryVaultSyncInputFromAnalysis(unstable, objects)).rejects.toThrow('inventory_capture_incomplete');
		const foreign: InventoryObjectResultsV1 = { ...objects, snapshotId: 'another-snapshot' };
		await expect(inventoryVaultSyncInputFromAnalysis(source, foreign)).rejects.toThrow('inventory_capture_identity_mismatch');
	});
});

/**
 * The moment stage's own wiring (M1-M4, H18.1, H18.2), migrated from the notes' former private
 * capture: the same cases, now read from the advisor's analysis.
 */
describe('inventory analysis: the moment stage inside the one result', () => {
	it('carries the percentile and coverage of each object\'s own history into its decision (M2 test 5)', async () => {
		const port = recommendationPort({
			// Strictly increasing, 42 dense days ending today; today's bid (510) is its own close and
			// tops the band.
			readDaily: async (itemId) => itemId === 42 ? dailySeries(42, 42, 100, 10, AS_OF_MS) : dailySeries(99, 10, 100, 10, AS_OF_MS),
		});
		const { notes } = await analyse([bank(42, 5, 0), bank(99, 5, 1)], {
			port, prices: { 42: { bid: 510, ask: 520 }, 99: { bid: 100, ask: 110 } },
		});
		expect(notes.get(42)).toMatchObject({ tc_recommendation: 'sell', tc_price_percentile: 100, tc_price_coverage_days: 42 });
		// Too little history: no timing verdict, so the advisor's sale stands, saying why.
		expect(notes.get(99)).toMatchObject({
			tc_recommendation: 'sell', tc_recommendation_reason: 'price_history_insufficient',
			tc_price_percentile: null, tc_price_coverage_days: 10,
		});
	});

	it('merges a cached datawars2 seed into the timing even with zero of the plugin\'s own captures', async () => {
		const itemId = 42;
		const vaultId = 'vault-h18';
		const factory = new IDBFactory();
		const writeStore = await IndexedDbPriceSeedCacheStore.open(factory);
		await writeStore.put(vaultId, itemId, { version: 1, itemId, source: 'datawars2', retrievedAt: AS_OF, days: seedDays(60, 100, 1, AS_OF_MS) }, AS_OF_MS);
		writeStore.close();
		const readStore = await IndexedDbPriceSeedCacheStore.open(factory);
		const port = recommendationPort({
			readDaily: async () => [],
			readCachedSeed: async (id) => (await readStore.get(vaultId, id))?.seed ?? null,
		});
		const { notes } = await analyse([bank(itemId, 5, 0)], { port, prices: { 42: { bid: 200, ask: 210 } } });
		expect(notes.get(itemId)).toMatchObject({
			tc_recommendation: 'sell', tc_recommendation_reason: 'bid_above_reference',
			tc_price_coverage_days: 60, tc_price_percentile: 100,
		});
		readStore.close();
	});

	it('H18.19: each surface states the sell-now-or-wait comparison for its own units, on the free quantity', async () => {
		const port = recommendationPort({
			readDaily: async (itemId) => dailySeries(itemId, 36, 300, 5, AS_OF_MS),
			seasonalInputFor: () => ({ window: WINDOW, parameters: SIGNAL }),
		});
		const goals: ReservationGoal[] = [goal('build-24', 'Build', 24, 10)];
		const { rows, input, notes } = await analyse([bank(24, 60, 0), character(24, 40, 'Alfa', 0)], { port, goals });
		const note = (source: string) => input.positions.find((entry) => entry.itemId === 24 && entry.source === source);
		// The goal holds 10 back; each note compares what it has free, the sale row what it sells.
		const free = input.positions.map((entry) => entry.freeQuantity ?? 0);
		expect(free.reduce((sum, value) => sum + value, 0)).toBe(90);
		for (const source of ['bank', 'character']) {
			expect(note(source)?.sellOrWait).toMatchObject({ verdict: 'insufficient_data', mode: 'instant', quantity: note(source)?.freeQuantity });
		}
		expect(rowFor(rows, 24, 'sell').decision?.sellOrWait).toMatchObject({ quantity: 90 });
		expect(notes.get(24)).toMatchObject({ tc_wait_verdict: 'insufficient_data', tc_wait_mode: 'instant' });
	});

	it('touches the watch list and the seed download only for an inventory sync with price history on (decisions 3 and 4)', async () => {
		for (const [enabled, refreshSeeds, expected] of [[false, true, 0], [true, false, 0], [true, true, 1]] as const) {
			const updateDerivedWatchList = vi.fn(async () => undefined);
			const refreshPriceSeeds = vi.fn(async () => undefined);
			const port = recommendationPort({ priceHistoryEnabled: () => enabled, updateDerivedWatchList, refreshPriceSeeds });
			await analyse([bank(42, 5, 0)], { port, refreshSeeds });
			expect(updateDerivedWatchList, `enabled=${String(enabled)} refreshSeeds=${String(refreshSeeds)}`).toHaveBeenCalledTimes(expected);
			expect(refreshPriceSeeds).toHaveBeenCalledTimes(expected);
		}
	});

	/**
	 * Review fix (26 sep 2026): David's real note for the Saco de Halloween (#36038, one unit,
	 * 321 copper total sell value) read `tc_recommendation: review` /
	 * `tc_recommendation_reason: insufficient_reference` even though datawars2 carries its daily
	 * history back to 2020. `selectDerivedWatchListItemIds` (decision 3) ranks by CAPITAL, so a
	 * single cheap container never clears any realistic threshold and never enters the list
	 * `refreshPriceSeeds` (decision 4) actually downloads for — the datawars2 seed the seasonal rule
	 * needs is never fetched, regardless of how much history the API actually has. A festival
	 * calendar item (`seasonalInputFor` non-null) always needs its own price history for the
	 * seasonal rule to work at all, independent of how little the position itself is worth: this
	 * asserts the watch list still carries it even when its capital would otherwise exclude it.
	 */
	it('seeds a festival calendar item even when its own capital never clears the threshold (review fix, 26 sep 2026)', async () => {
		const CHEAP_SEASONAL_ITEM = 36038;
		const updateDerivedWatchList = vi.fn(async () => undefined);
		const refreshPriceSeeds = vi.fn(async () => undefined);
		const port = recommendationPort({
			// The plugin's real default (`DEFAULT_RECOMMENDATION_PORT.capitalThresholdCopper`, main.ts).
			capitalThresholdCopper: () => 100_000,
			seasonalInputFor: (itemId) => itemId === CHEAP_SEASONAL_ITEM ? { window: WINDOW, parameters: SIGNAL } : null,
			updateDerivedWatchList, refreshPriceSeeds,
		});
		// 1 unit at 3s21c net: 321 copper total, David's real note value — nowhere near 100_000.
		await analyse([bank(CHEAP_SEASONAL_ITEM, 1, 0)], {
			port, refreshSeeds: true, prices: { [CHEAP_SEASONAL_ITEM]: { bid: 321, ask: 330 } },
		});

		expect(updateDerivedWatchList).toHaveBeenCalledWith([CHEAP_SEASONAL_ITEM]);
		expect(refreshPriceSeeds).toHaveBeenCalledWith([CHEAP_SEASONAL_ITEM]);
	});

	it('an empty legendary-target setting never reads the legendary armory and reserves nothing (M4 test 8)', async () => {
		const readLegendaryArmoryCounts = vi.fn(async (): Promise<ReadonlyMap<number, number> | null> => null);
		const port = recommendationPort({ legendaryTargetItemIds: () => [], readLegendaryArmoryCounts });
		const { notes } = await analyse([bank(42, 5, 0)], { port });
		expect(readLegendaryArmoryCounts).not.toHaveBeenCalled();
		expect(notes.get(42)).toMatchObject({ tc_reserved_quantity: 0, tc_free_quantity: 5 });
	});
});

/**
 * H18.1 (audit 2026-09-24 §3.A), now through the advisor: the chosen legendary targets become
 * reservation goals the advisor classifies like any other goal, so the view and the notes hold
 * back the same units. Every item sits inside a festival selling window with a quote today above
 * its rising history (H18.19: the price has to confirm the window), so without a reservation it
 * reads `sell`/`seasonal_sell_window` (OTHER is that control).
 */
describe('inventory analysis: legendary reservations through the advisor (H18.1)', () => {
	const MATERIAL = 42;
	const OTHER = 99;
	const LEGENDARY_A = 900_001;
	const LEGENDARY_B = 900_002;
	const UNTABLED = 900_009;
	const SELLS = { tc_recommendation: 'sell', tc_recommendation_reason: 'seasonal_sell_window' } as const;

	function tableWith(requirements: ReadonlyArray<readonly [legendaryItemId: number, quantity: number]>): LegendaryMaterialsTableV1 {
		return {
			version: 1, publishedAt: '2026-09-01T00:00:00.000Z', reviewedAt: '2026-09-02T00:00:00.000Z',
			validUntil: '2027-09-01T00:00:00.000Z', sources: [], sha256: '0'.repeat(64),
			entries: requirements.map(([legendaryItemId, quantity]) => ({
				legendaryItemId, currencyIds: [],
				materials: [{ itemId: MATERIAL, quantity, resolvable: true, sourceId: null }],
			})),
		};
	}

	async function withTargets(
		holdings: ItemHolding[],
		targets: number[],
		table: LegendaryMaterialsTableV1 | null,
		options: { owned?: ReadonlyMap<number, number>; goals?: ReservationGoal[] } = {},
	) {
		const port = recommendationPort({
			readDaily: async (itemId) => dailySeries(itemId, 36, 300, 5, AS_OF_MS),
			seasonalInputFor: () => ({ window: WINDOW, parameters: SIGNAL }),
			legendaryTargetItemIds: () => targets,
			legendaryMaterialsTable: () => table,
			readLegendaryArmoryCounts: async () => options.owned ?? new Map(),
		});
		const analysed = await analyse(holdings, { port, goals: options.goals ?? [] });
		const at = (itemId: number, source: string) => analysed.input.positions.find((entry) => entry.itemId === itemId && entry.source === source);
		return { ...analysed, at };
	}

	it('a reservation exactly covered by one bank stack: 100 reserved, 0 free, held for the goal, never sold', async () => {
		const { at, rows } = await withTargets([bank(MATERIAL, 100, 0), bank(OTHER, 5, 1)], [LEGENDARY_A], tableWith([[LEGENDARY_A, 100]]));
		expect(at(MATERIAL, 'bank')).toMatchObject({
			reservedQuantity: 100, freeQuantity: 0,
			recommendation: 'hold_for_legendary', recommendationReason: 'reserved_for_goal', recommendationMissing: 0,
		});
		expect(rowFor(rows, MATERIAL, 'keep').decision).toMatchObject({ action: 'hold_for_legendary', reason: 'reserved_for_goal' });
		expect(at(OTHER, 'bank')).toMatchObject({ recommendation: 'sell', recommendationReason: 'seasonal_sell_window', reservedQuantity: 0, freeQuantity: 5 });
	});

	it('a reservation split between bank and a character: the fully reserved stack holds, the rest sells only its free share', async () => {
		const { at, input } = await withTargets(
			[bank(MATERIAL, 60, 0), character(MATERIAL, 60, 'Alfa', 0), bank(OTHER, 5, 1)],
			[LEGENDARY_A], tableWith([[LEGENDARY_A, 100]]),
		);
		expect(at(MATERIAL, 'bank')).toMatchObject({ reservedQuantity: 60, freeQuantity: 0, recommendation: 'hold_for_legendary' });
		expect(at(MATERIAL, 'character')).toMatchObject({
			recommendation: 'sell', recommendationReason: 'seasonal_sell_window', reservedQuantity: 40, freeQuantity: 20, actionableQuantity: 20,
		});
		const material = input.positions.filter((entry) => entry.itemId === MATERIAL);
		expect(material.reduce((sum, entry) => sum + (entry.reservedQuantity ?? 0), 0)).toBe(100);
		expect(material.reduce((sum, entry) => sum + (entry.freeQuantity ?? 0), 0)).toBe(20);
	});

	it('overlapping goals add up on the shared material: short of it everything holds, above it only the surplus is free', async () => {
		const table = tableWith([[LEGENDARY_A, 60], [LEGENDARY_B, 50]]);
		const short = await withTargets([bank(MATERIAL, 100, 0)], [LEGENDARY_A, LEGENDARY_B], table);
		expect(short.at(MATERIAL, 'bank')).toMatchObject({
			reservedQuantity: 100, freeQuantity: 0, recommendation: 'hold_for_legendary', recommendationMissing: 10,
		});
		const surplus = await withTargets([bank(MATERIAL, 80, 0), character(MATERIAL, 40, 'Alfa', 0)], [LEGENDARY_A, LEGENDARY_B], table);
		expect(surplus.at(MATERIAL, 'bank')).toMatchObject({ reservedQuantity: 80, freeQuantity: 0, recommendation: 'hold_for_legendary' });
		expect(surplus.at(MATERIAL, 'character')).toMatchObject({ recommendation: 'sell', reservedQuantity: 30, freeQuantity: 10 });
	});

	it('a chosen legendary without a materials table makes the known legendary materials uncertain, in the view too', async () => {
		const { at, rows } = await withTargets([bank(MATERIAL, 100, 0), bank(OTHER, 5, 1)], [UNTABLED], tableWith([[LEGENDARY_A, 100]]));
		expect(at(MATERIAL, 'bank')).toMatchObject({
			reservedQuantity: null, freeQuantity: null, recommendation: 'review', recommendationReason: 'reservation_uncertain',
		});
		expect(rowFor(rows, MATERIAL, 'sell').decision).toMatchObject({ action: 'review', reason: 'reservation_uncertain' });
		expect(at(OTHER, 'bank')).toMatchObject({ recommendation: 'sell', reservedQuantity: 0, freeQuantity: 5 });
		const mixed = await withTargets(
			[bank(MATERIAL, 60, 0), character(MATERIAL, 60, 'Alfa', 0)], [LEGENDARY_A, UNTABLED], tableWith([[LEGENDARY_A, 100]]),
		);
		expect(mixed.at(MATERIAL, 'bank')).toMatchObject({ reservedQuantity: 60, freeQuantity: 0, recommendation: 'hold_for_legendary' });
		expect(mixed.at(MATERIAL, 'character')).toMatchObject({
			reservedQuantity: null, freeQuantity: null, recommendation: 'review', recommendationReason: 'reservation_uncertain',
		});
	});

	it('legendary goals whose combined plan cannot be built turn their materials uncertain and keep the user\'s own goals', async () => {
		// A user goal titled exactly like the derived legendary goal: the combined plan is invalid
		// (duplicate title). The derived goal is dropped, never the user's own.
		const clash = goal('mine', `legendary-goal-${String(LEGENDARY_A)}`, OTHER, 2);
		const { at } = await withTargets([bank(MATERIAL, 60, 0), bank(OTHER, 5, 1)], [LEGENDARY_A], tableWith([[LEGENDARY_A, 100]]), { goals: [clash] });
		expect(at(MATERIAL, 'bank')).toMatchObject({
			reservedQuantity: null, freeQuantity: null, recommendation: 'review', recommendationReason: 'reservation_uncertain',
		});
		expect(at(OTHER, 'bank')).toMatchObject({ reservedQuantity: 2, freeQuantity: 3, recommendation: 'sell' });
	});

	it('with the materials table forced to null, a chosen legendary makes the shipped table\'s materials uncertain', async () => {
		const SHIPPED_MATERIAL = 103_316; // Shard of Janthir Syntri, a leaf of the shipped Klobjarne Geirr entry.
		const holdings = [bank(SHIPPED_MATERIAL, 100, 0), bank(OTHER, 5, 1)];
		const { at } = await withTargets(holdings, [LEGENDARY_A], null);
		expect(at(SHIPPED_MATERIAL, 'bank')).toMatchObject({
			reservedQuantity: null, freeQuantity: null, recommendation: 'review', recommendationReason: 'reservation_uncertain',
		});
		const forged = await withTargets(holdings, [LEGENDARY_A], null, { owned: new Map([[LEGENDARY_A, 1]]) });
		expect(forged.at(SHIPPED_MATERIAL, 'bank')).toMatchObject({ ...pick(SELLS), reservedQuantity: 0, freeQuantity: 100 });
	});
});

/**
 * H18.15 (audit 2026-09-24 §3.E, §9): the object result carries the storage space of the same
 * capture, and how many whole slots each act-now decision empties, so the view can say how full
 * the account is and put the actions that free space first when it is low.
 */
describe('storage space in the one result per object (H18.15)', () => {
	const freeSlots: StorageFreeSlots = {
		bank: { total: 30, free: 4 },
		sharedInventory: { total: 10, free: 10 },
		characterBags: [
			{ character: 'Alfa', bagIndex: 0, bagItemId: 8_932, total: 20, free: 2 },
			{ character: 'Alfa', bagIndex: 1, bagItemId: 8_932, total: 10, free: 1 },
		],
	};

	it('reports free slots, the low-space state and the slots each act-now decision frees', async () => {
		const analysed = await analyse([
			// Sold whole, now: one bag slot.
			character(23, 5, 'Alfa', 0),
			// Three of five reserved for a goal: selling the other two empties no slot.
			bank(21, 5, 1),
			// Kept by the user: nothing to act on.
			bank(20, 5, 2),
		], {
			freeSlots,
			goals: [goal('build-21', 'Build', 21, 3)],
			keepExceptions: [keepAll('keep-20', 20)],
		});

		const sold = rowFor(analysed.rows, 23, 'sell');
		expect(analysed.objects.storageSpace).toEqual({
			bags: { free: 3, total: 30 },
			bank: { free: 4, total: 30 },
			sharedInventory: { free: 10, total: 10 },
			lowSpace: { freeSlots: 7, totalSlots: 60, thresholdFreeSlots: 20, isLow: true },
			materialCapacity: null,
			slotsFreedByDecision: { [sold.id]: 1 },
		});
		expect(sold.slotsFreed).toBe(1);
		expect(rowFor(analysed.rows, 21, 'sell').slotsFreed).toBe(0);
		expect(rowFor(analysed.rows, 20, 'keep').slotsFreed).toBe(0);
		expect(analysed.model.storageSpace).toMatchObject({
			bags: { free: 3, total: 30 }, lowSpace: { isLow: true, thresholdFreeSlots: 20 },
		});
	});

	it('reads the threshold from settings and never invents space for a store the capture missed', async () => {
		const plenty = await analyse([character(23, 5, 'Alfa', 0)], {
			freeSlots, port: recommendationPort({ lowStorageSpaceThresholdFreeSlots: () => 5 }),
		});
		expect(plenty.objects.storageSpace?.lowSpace).toEqual({ freeSlots: 7, totalSlots: 60, thresholdFreeSlots: 5, isLow: false });

		const withoutBank = await analyse([character(23, 5, 'Alfa', 0)], { freeSlots: { ...freeSlots, bank: null } });
		expect(withoutBank.objects.storageSpace).toMatchObject({ bank: null, lowSpace: null, bags: { free: 3, total: 30 } });
	});
});

function pick(value: { tc_recommendation: string; tc_recommendation_reason: string }): Pick<InventoryVaultPosition, 'recommendation' | 'recommendationReason'> {
	return {
		recommendation: value.tc_recommendation as InventoryVaultPosition['recommendation'],
		recommendationReason: value.tc_recommendation_reason as InventoryVaultPosition['recommendationReason'],
	};
}

interface AnalyseOptions {
	goals?: ReservationGoal[];
	keepExceptions?: KeepExceptionV1[];
	port?: InventoryPositionRecommendationPort;
	prices?: Record<number, { bid: number; ask: number }>;
	refreshSeeds?: boolean;
	capture?: ReturnType<typeof vi.fn>;
	freeSlots?: StorageFreeSlots;
}

/**
 * The real pipeline, end to end: the advisor workflow on one captured evidence, its analysis port
 * wired exactly as `main.ts` wires it, the view's controller, the notes' sync input and writer.
 */
async function analyse(holdings: ItemHolding[], options: AnalyseOptions = {}) {
	const snapshot = { ...snapshotOf(holdings), ...(options.freeSlots === undefined ? {} : { freeSlots: options.freeSlots }) };
	const evidence = evidenceOf(snapshot, options.prices ?? {});
	const marketDepth = marketDepthOf(evidence.prices);
	const capture = options.capture ?? vi.fn();
	capture.mockImplementation(async () => ({ status: 'complete' as const, evidence: structuredClone(evidence), marketDepth: structuredClone(marketDepth) }));
	const service = new InventoryAnalysisService(options.port ?? recommendationPort());
	const objects: InventoryObjectAnalysisPort = {
		derivedGoals: async () => await service.derivedGoals(),
		evaluate: async (source, uncertainItemIds) => await service.evaluate(source, uncertainItemIds, { refreshSeeds: options.refreshSeeds ?? false }),
	};
	const workflow = new InventoryAdvisorWorkflow({
		capture: { capture: capture as never },
		preferences: { load: async () => ({ status: 'ready', value: { goals: options.goals ?? [], keepExceptions: options.keepExceptions ?? [] } }) },
		rules: { current: () => ({ status: 'available', value: rulesFixture() }) },
		now: () => AS_OF_MS,
		objects,
	});
	const controller = new InventoryAdvisorPresentationController({ load: async () => await workflow.refresh('es') });
	await controller.refresh();
	const analysis = controller.analysis();
	if (analysis === null || analysis.objects === null) throw new Error(`Expected a ready analysis: ${JSON.stringify(controller.current().blockedReason ?? controller.current().status)}`);
	const rows = controller.current().groups.flatMap((group) => group.rows);
	const input = await inventoryVaultSyncInputFromAnalysis(analysis.source, analysis.objects);
	const vault = new MemoryVault();
	const writer = new InventoryVaultSyncService(vault, CONFIG_DIR);
	await writer.apply(await writer.preview(ROOT, input));
	const notes = new Map<number, Record<string, unknown>>();
	for (const content of vault.contents.values()) {
		const fields = frontmatter(content);
		if (!notes.has(fields.tc_item_id as number)) notes.set(fields.tc_item_id as number, fields);
	}
	return {
		source: analysis.source, objects: analysis.objects, rows, input, model: controller.current(),
		notes: new Map([...notes].sort(([left], [right]) => left - right)),
	};
}

function rowFor(rows: readonly InventoryAdvisorViewRow[], itemId: number, action: string): InventoryAdvisorViewRow {
	const row = rows.find((entry) => entry.itemId === itemId && entry.action === action);
	if (row === undefined) throw new Error(`Expected a ${action} row for item ${String(itemId)}: ${JSON.stringify(rows.map((entry) => [entry.itemId, entry.action]))}`);
	return row;
}

/** The row covering most of the note's free share, or its protected share when nothing is free. */
function primaryRowFor(rows: readonly InventoryAdvisorViewRow[], itemId: number, note: Record<string, unknown>): InventoryAdvisorViewRow {
	const candidates = rows.filter((row) => row.itemId === itemId);
	const free = note.tc_free_quantity === 0 ? candidates : candidates.filter((row) => row.decision?.reason !== 'reserved_for_goal'
		&& row.decision?.reason !== 'user_keep_exception');
	const [primary] = [...free].sort((left, right) => right.quantity - left.quantity);
	if (primary === undefined) throw new Error(`No view row for item ${String(itemId)}.`);
	return primary;
}

type NoteRow = Record<string, unknown>;
type Filter = string | { and: Filter[] } | { or: Filter[] };

/** The Inventory Base's own filters, evaluated on a note's frontmatter (the grammar the Base uses). */
async function baseViews(): Promise<{ sellNow(note: NoteRow): boolean; waitToSell(note: NoteRow): boolean }> {
	const asset = (await inventoryManagedAssets()).find((entry) => entry.relativePath === 'Inventory.base' && entry.locale === 'es');
	if (asset === undefined) throw new Error('Expected the Spanish Inventory Base.');
	const document = parseYaml(asset.bytes) as { filters: Filter; views: Array<{ name: string; filters?: Filter }> };
	const view = (name: string) => {
		const found = document.views.find((entry) => entry.name === name);
		if (found === undefined) throw new Error(`Expected the "${name}" view.`);
		return (note: NoteRow) => matches(document.filters, note) && matches(found.filters, note);
	};
	return { sellNow: view('Vender ahora'), waitToSell: view('Esperar para vender') };
}

function matches(filter: Filter | undefined, row: NoteRow): boolean {
	if (filter === undefined) return true;
	if (typeof filter !== 'string') {
		return 'and' in filter ? filter.and.every((entry) => matches(entry, row)) : filter.or.some((entry) => matches(entry, row));
	}
	const match = filter.match(/^([a-z_]+) (==|!=|>) (.+)$/u);
	if (!match) throw new Error(`Unsupported filter in test evaluator: ${filter}`);
	const left = row[match[1]!] ?? null;
	const right = JSON.parse(match[3]!) as unknown;
	if (match[2] === '==') return left === right;
	if (match[2] === '!=') return left !== right;
	return typeof left === 'number' && typeof right === 'number' && left > right;
}

function recommendationPort(overrides: Partial<InventoryPositionRecommendationPort> = {}): InventoryPositionRecommendationPort {
	return {
		priceHistoryEnabled: () => true,
		capitalThresholdCopper: () => 1,
		maxPriceAgeMs: () => 900_000,
		priceHistoryWindowDays: () => 180,
		readDaily: async () => [],
		readCachedSeed: async () => null,
		updateDerivedWatchList: async () => undefined,
		refreshPriceSeeds: async () => undefined,
		seasonalInputFor: () => null,
		legendaryTargetItemIds: () => [],
		legendaryMaterialsTable: () => null,
		readLegendaryArmoryCounts: async () => null,
		lowStorageSpaceThresholdFreeSlots: () => 20,
		...overrides,
	};
}

function bank(itemId: number, quantity: number, slot: number): ItemHolding {
	return { kind: 'item', itemId, quantity, state: 'loose', location: { source: 'bank', slot }, metadata: {} };
}

function character(itemId: number, quantity: number, name: string, slot: number): ItemHolding {
	return { kind: 'item', itemId, quantity, state: 'loose', location: { source: 'character', character: name, container: 'bag', bagIndex: 0, slot }, metadata: {} };
}

function goal(goalId: string, title: string, itemId: number, quantity: number): ReservationGoal {
	return {
		schemaVersion: 1, goalId, title, status: 'active', priority: 100, reason: 'personal',
		requirements: [{
			key: `item:${String(itemId)}`, namespace: 'item', id: itemId, targetQuantity: quantity, creditedQuantity: 0,
			basis: 'available', intendedUse: 'hold',
		}],
	};
}

function keepAll(exceptionId: string, itemId: number): KeepExceptionV1 {
	return { version: 1, exceptionId, itemId, status: 'active', basis: 'owned', quantity: { mode: 'all' }, reason: 'user_keep' };
}

function snapshotOf(holdings: ItemHolding[]): StorageSnapshot {
	const owned: Record<string, number> = {};
	const available: Record<string, number> = {};
	for (const entry of holdings) {
		owned[String(entry.itemId)] = (owned[String(entry.itemId)] ?? 0) + entry.quantity;
		if (entry.state === 'loose' || entry.state === 'pending_claim') {
			available[String(entry.itemId)] = (available[String(entry.itemId)] ?? 0) + entry.quantity;
		}
	}
	const roster = [...new Set(holdings.flatMap((entry) => entry.location.source === 'character' ? [entry.location.character] : []))].sort();
	const complete: SourceCoverage = { status: 'complete' };
	const coverage = () => ({
		sources: Object.fromEntries(['characters', 'shared_inventory', 'bank', 'materials', 'wallet', 'commerce_delivery']
			.map((source) => [source, { ...complete }])) as StorageSnapshot['coverage']['sources'],
		characters: Object.fromEntries(roster.map((name) => [name, { ...complete }])),
	});
	return {
		snapshotId: 'snapshot-h18', accountId: 'account-h18', startedAt: new Date(AS_OF_MS - 1_000).toISOString(), completedAt: AS_OF,
		schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2, holdings, currencies: [],
		availableByItem: available, ownedByItem: owned, currencyById: {}, roster,
		coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
}

function evidenceOf(snapshot: StorageSnapshot, prices: Record<number, { bid: number; ask: number }>): InventoryAdvisorEvidenceV1 {
	const ownedIds = Object.keys(snapshot.ownedByItem).map(Number).sort((left, right) => left - right);
	const availableIds = Object.keys(snapshot.availableByItem).map(Number).sort((left, right) => left - right);
	const item = (id: number): CatalogItem => ({
		kind: 'item', id, name: `Objeto ${String(id)}`, type: 'CraftingMaterial', rarity: 'Fine', level: 0,
		vendorValue: 1, flags: [], gameTypes: [], restrictions: [],
	});
	const catalog: CatalogResolution = {
		snapshotId: snapshot.snapshotId, locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: AS_OF,
		items: Object.fromEntries(ownedIds.map((id) => [String(id), item(id)])),
		currencies: {}, materials: {}, warnings: [],
		coverage: {
			items: Object.fromEntries(ownedIds.map((id) => [String(id), { status: 'resolved' as const, source: 'network' as const }])),
			currencies: {}, materials: {},
		},
	};
	const quotes: InventoryItemPriceV1[] = availableIds.map((itemId) => ({
		itemId, whitelisted: true,
		bid: { unitCopper: prices[itemId]?.bid ?? 500, quantity: 10_000 },
		ask: { unitCopper: prices[itemId]?.ask ?? 520, quantity: 10_000 },
	}));
	const priceSnapshot: InventoryPriceSnapshotV1 = {
		version: 1, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId, capturedAt: AS_OF,
		source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: availableIds,
		status: 'complete', items: quotes, missingItemIds: [],
	};
	const endpoint = { status: 'complete' as const, capturedAt: AS_OF, reason: null };
	const accountSignals: AccountSignalsV1 = {
		version: 1, source: 'gw2-account-api', accountId: snapshot.accountId, capturedAt: AS_OF, schemaVersion: PINNED_SCHEMA,
		tradingPostAccess: 'full',
		endpointCoverage: { account: endpoint, recipes: endpoint, skins: endpoint, minis: endpoint, achievements: endpoint },
		unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
		achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
	};
	return {
		version: 1, scope: 'supported_storage_v1', accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
		schemaVersion: PINNED_SCHEMA, capturedAt: snapshot.completedAt, finishedAt: AS_OF, locale: 'es', snapshot,
		snapshotFingerprint: sha256CanonicalValue(snapshot),
		ttl: { snapshotMs: 900_000, catalogMs: 604_800_000, pricesMs: 900_000, accountSignalsMs: 86_400_000 },
		coverage: { snapshot: 'complete', catalog: 'complete', prices: 'complete', accountSignals: 'complete' },
		catalog, prices: priceSnapshot, accountSignals,
	};
}

/** Demonstrated demand at each item's own bid, deep enough for every stack in these fixtures. */
function marketDepthOf(prices: InventoryPriceSnapshotV1): InventoryMarketDepthEvidenceV1 {
	return {
		version: 1, capturedAt: AS_OF, source: 'gw2-commerce-listings', requestedItemIds: [...prices.requestedItemIds], status: 'complete',
		items: prices.items.map((entry) => ({
			itemId: entry.itemId, coverage: 'complete' as const, sells: [],
			buys: [{ unitCopper: entry.bid!.unitCopper, quantity: 10_000 }],
		})),
	};
}

function rulesFixture(): InventoryAdvisorRules {
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-12-01T00:00:00.000Z',
		reviewedAt: '2026-12-02T00:00:00.000Z', validUntil: '2027-06-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-12-02T00:00:00.000Z' }],
		rules: [{ ruleId: 'discard-10', itemId: 10, action: 'discard_candidate' as const, status: 'approved' as const,
			assertion: 'applicable' as const, reason: 'curated_discard_review' as const, sourceIds: ['rule-source'] }],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledgePack: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-12-01T00:00:00.000Z',
		reviewedAt: '2026-12-02T00:00:00.000Z', validUntil: '2027-06-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'knowledge-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-12-02T00:00:00.000Z' }],
		entries: [{
			itemId: 10,
			use: { status: 'not_applicable', assertionId: 'use-none', sourceIds: ['knowledge-source'] },
			open: { status: 'not_applicable', assertionId: 'open-none', sourceIds: ['knowledge-source'] },
			salvage: { status: 'not_applicable', assertionId: 'salvage-none', sourceIds: ['knowledge-source'] },
		}],
	};
	knowledgePack.sha256 = sha256InventoryKnowledgePack(knowledgePack);
	return { rulePack, knowledgePack, policy: {
		version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
		maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
		listingMinimumAdvantageBps: 1_000,
	} };
}

/** One daily row per day, closing bid rising by `step` from `startCopper`, ending on `endMs`'s own day. */
function dailySeries(itemId: number, days: number, startCopper: number, step: number, endMs: number): PriceHistoryDailyV1[] {
	const out: PriceHistoryDailyV1[] = [];
	for (let index = 0; index < days; index += 1) {
		const dayUtc = new Date(endMs - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
		const close = startCopper + index * step;
		out.push({
			version: 1, vaultId: 'vault', itemId, dayUtc, snapshotCount: 1, partialSnapshotCount: 0, ask: null,
			bid: { count: 1, minCopper: close, maxCopper: close, medianCopperX2: close * 2, closeCopper: close, closeCapturedAtMs: endMs },
		});
	}
	return out;
}

function seedDays(days: number, startCopper: number, step: number, endMs: number): PriceSeedDayV1[] {
	const out: PriceSeedDayV1[] = [];
	for (let index = 0; index < days; index += 1) {
		out.push({ dayUtc: new Date(endMs - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10), bidCopper: startCopper + index * step, askCopper: null });
	}
	return out;
}

function frontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!match) throw new Error('Missing note frontmatter.');
	return parseYaml(match[1]!) as Record<string, unknown>;
}

class MemoryVault implements InventoryVaultPort {
	readonly contents = new Map<string, string>();
	readonly folders = new Set<string>();
	file(path: string): InventoryVaultFile | null { return this.contents.has(path) || this.folders.has(path) ? { path } : null; }
	markdownFiles(): readonly InventoryVaultFile[] { return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path })); }
	async read(file: InventoryVaultFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error('not_file');
		return content;
	}
	async createFolder(path: string): Promise<void> { this.folders.add(path); }
	async create(path: string, content: string): Promise<InventoryVaultFile> {
		if (this.file(path)) throw new Error('exists');
		this.contents.set(path, content);
		return { path };
	}
	async process(file: InventoryVaultFile, update: (content: string) => string): Promise<string> {
		const next = update(await this.read(file));
		this.contents.set(file.path, next);
		return next;
	}
	async trashFile(file: InventoryVaultFile): Promise<void> { this.contents.delete(file.path); }
}
