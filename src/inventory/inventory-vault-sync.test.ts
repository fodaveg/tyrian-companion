import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import { PINNED_SCHEMA, type ItemHolding, type StorageSnapshot } from '../account/storage-snapshot-model';
import { sha256Text } from '../assets/managed-asset-hash';
import type { InventoryItemPriceV1, InventoryPriceSnapshotV1 } from '../advisor/inventory-advisor-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import type { InventoryMarketDepthEvidenceV1 } from '../economy/commerce-listings';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { IndexedDbPriceSeedCacheStore } from '../economy/price-seed-cache-store';
import { seasonalWindowClosesAfterMs, type SeasonalWindowV1 } from '../economy/seasonal-window';
import type { PriceSeedDayV1, PriceSeedV1 } from '../economy/price-seed-model';
import {
	InventoryVaultCaptureService,
	InventoryVaultSyncService,
	prepareInventoryVaultSyncInput,
	type InventoryPositionRecommendationPort,
	type InventoryVaultFile,
	type InventoryVaultPort,
} from './inventory-vault-sync';

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';
const CAPTURED_AT = '2026-08-25T08:00:01.000Z';

/** Rule (a), M4: every port fixture in this file that predates it opts out entirely, matching M4 test 8. */
const LEGENDARY_DISABLED_PORT_FIELDS = {
	legendaryTargetItemIds: () => [],
	legendaryMaterialsTable: () => null,
	readLegendaryArmoryCounts: async () => null,
} as const;

describe('inventory Vault projection', () => {
	it('aggregates piles by item and location without extrapolating one buy quote to every pile', async () => {
		const snapshot = snapshotWith([
			holding(42, 2, characterBag('Alfa')),
			holding(42, 3, characterBag('Alfa')),
			holding(42, 7, characterBag('Beta / Dos')),
			holding(42, 11, { source: 'shared_inventory', slot: 0 }),
			holding(42, 13, { source: 'bank', slot: 0 }),
			holding(42, 17, { source: 'materials', category: 1 }),
			{ ...holding(42, 19, { source: 'bank', slot: 1 }), state: 'embedded_upgrade' },
			holding(42, 23, { source: 'character', character: 'Alfa', container: 'equipped_bag', bagIndex: 0 }),
		]);
		const projected = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'full', 'es');
		expect(projected.positions.map(({ source, character, quantity, totalSellCopper }) =>
			({ source, character, quantity, totalSellCopper }))).toEqual([
			{ source: 'bank', character: null, quantity: 13, totalSellCopper: null },
			{ source: 'character', character: 'Alfa', quantity: 5, totalSellCopper: null },
			{ source: 'character', character: 'Beta / Dos', quantity: 7, totalSellCopper: null },
			{ source: 'materials', character: null, quantity: 17, totalSellCopper: null },
			{ source: 'shared_inventory', character: null, quantity: 11, totalSellCopper: null },
		]);
	});

	it('consumes shared buy levels once across rows and exposes complete, partial and exhausted coverage', async () => {
		const snapshot = snapshotWith([
			holding(42, 5, characterBag('Alfa')),
			holding(42, 7, characterBag('Beta')),
			holding(42, 11, { source: 'shared_inventory', slot: 0 }),
			holding(42, 13, { source: 'bank', slot: 0 }),
			holding(42, 17, { source: 'materials', category: 1 }),
		]);
		const projected = await prepareInventoryVaultSyncInput(
			snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 100), 'full', 'es',
			marketDepthFor(42, [{ unitCopper: 100, quantity: 15 }, { unitCopper: 90, quantity: 15 }]),
		);
		expect(projected.positions.map((position) => ({
			source: position.source, total: position.totalSellCopper, status: position.sellDepthStatus,
			covered: position.sellCoveredQuantity, uncovered: position.sellUncoveredQuantity,
		}))).toEqual([
			{ source: 'bank', total: 1_105, status: 'complete', covered: 13, uncovered: 0 },
			{ source: 'character', total: 399, status: 'complete', covered: 5, uncovered: 0 },
			{ source: 'character', total: 535, status: 'complete', covered: 7, uncovered: 0 },
			{ source: 'materials', total: null, status: 'partial', covered: 5, uncovered: 12 },
			{ source: 'shared_inventory', total: null, status: 'no_market', covered: 0, uncovered: 11 },
		]);
	});

	it('produces stable portable identifiers without account or character names', async () => {
		const account = 'account-private-123';
		const character = 'Áine / NUL:Uno';
		const firstSnapshot = snapshotWith([holding(42, 2, characterBag(character))], { accountId: account });
		const reorderedSnapshot = snapshotWith([
			holding(99, 1, { source: 'bank', slot: 0 }),
			holding(42, 2, characterBag(character)),
		], { accountId: account });
		const first = await prepareInventoryVaultSyncInput(firstSnapshot, catalogFor(firstSnapshot), pricesFor(firstSnapshot, 42, 10), 'full', 'es');
		const second = await prepareInventoryVaultSyncInput(reorderedSnapshot, catalogFor(reorderedSnapshot), pricesFor(reorderedSnapshot, 42, 10), 'full', 'es');
		const id = first.positions[0]!.positionId;
		expect(second.positions.find((position) => position.itemId === 42)?.positionId).toBe(id);
		expect(id).toMatch(/^42-c-[a-f0-9]{24}$/u);
		expect(id).not.toContain(character);
		expect(id).not.toContain(account);
		expect(id).not.toMatch(/[:*?"<>|/\\]/u);
	});

	it('fails closed when snapshot, catalog, price or locale identity drifts', async () => {
		const snapshot = snapshotWith([holding(42, 1, { source: 'bank', slot: 0 })]);
		const catalog = catalogFor(snapshot);
		const prices = pricesFor(snapshot, 42, 10);
		for (const [changedCatalog, changedPrices, locale] of [
			[{ ...catalog, snapshotId: 'foreign' }, prices, 'es'],
			[catalog, { ...prices, accountId: 'foreign' }, 'es'],
			[catalog, { ...prices, schemaVersion: 'future' }, 'es'],
			[catalog, prices, 'en'],
		] as const) {
			await expect(prepareInventoryVaultSyncInput(
				snapshot,
				changedCatalog as CatalogResolution,
				changedPrices as InventoryPriceSnapshotV1,
				'full',
				locale,
			)).rejects.toThrow('inventory_capture_identity_mismatch');
		}
	});

	it('does no account capture until the explicit capture action is invoked', async () => {
		const client = { beginOperation: vi.fn(() => ({ requestDetailed: accountRequest() })) };
		const snapshots = { captureWithOperation: vi.fn(async () => snapshotWith([])) };
		const catalog = { resolve: vi.fn(async (snapshot: StorageSnapshot) => catalogFor(snapshot)) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 200, body: [], headers: {} })) };
		const service = new InventoryVaultCaptureService(client as never, snapshots, catalog, gateway);
		expect(client.beginOperation).not.toHaveBeenCalled();
		await service.capture('es');
		expect(client.beginOperation).toHaveBeenCalledOnce();
		expect(snapshots.captureWithOperation).toHaveBeenCalledOnce();
	});

	/**
	 * M1 criterion of closure 3 (docs/SPEC-recomendacion-por-objeto.md §5): the pure function
	 * verde alone never proves anyone calls it. `capitalThresholdCopper` is set unreachably high
	 * so the outcome is deterministic (`hold`/`below_capital_threshold`) without needing a real
	 * market-depth fixture: the point here is that `capture()` reads the port and writes the
	 * result into the DTO at all, not which branch of `recommendPosition` fires.
	 */
	it('wires recommendPosition into the capture DTO', async () => {
		const client = { beginOperation: vi.fn(() => ({ requestDetailed: accountRequest() })) };
		const snapshots = { captureWithOperation: vi.fn(async () => snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })])) };
		const catalog = { resolve: vi.fn(async (snapshot: StorageSnapshot) => catalogFor(snapshot)) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 200, body: [], headers: {} })) };
		const recommendation = {
			priceHistoryEnabled: () => true,
			capitalThresholdCopper: () => Number.MAX_SAFE_INTEGER,
			maxPriceAgeMs: () => 900_000,
			priceHistoryWindowDays: () => 180,
			readDaily: async () => [],
			readCachedSeed: async () => null,
			updateDerivedWatchList: async () => undefined,
			refreshPriceSeeds: async () => undefined,
			seasonalInputFor: () => null,
			...LEGENDARY_DISABLED_PORT_FIELDS,
		};
		const service = new InventoryVaultCaptureService(
			client as never, snapshots, catalog, gateway, recommendation, () => Date.parse(CAPTURED_AT),
		);
		const input = await service.capture('es');
		expect(input.positions[0]).toMatchObject({
			recommendation: 'hold', recommendationReason: 'below_capital_threshold',
			recommendationUntil: new Date(Date.parse(CAPTURED_AT) + 900_000).toISOString(),
			recommendationMissing: null,
		});
	});

	/**
	 * M2 criterion of closure, test 5 (docs/SPEC-recomendacion-por-objeto.md §5): `capture()` over
	 * two items with distinct series writes `tc_price_percentile`/`tc_price_coverage_days`
	 * coherent with each item's own series, never a percentile with zero days behind it.
	 */
	it('writes pricePercentile/priceCoverageDays coherent with each item\'s own daily series', async () => {
		const snapshot = snapshotWith([
			holding(42, 5, { source: 'bank', slot: 0 }),
			holding(99, 5, { source: 'bank', slot: 1 }),
		]);
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: 42, whitelisted: true, bid: { unitCopper: 100, quantity: 100 }, ask: { unitCopper: 110, quantity: 100 } },
			{ itemId: 99, whitelisted: true, bid: { unitCopper: 100, quantity: 100 }, ask: { unitCopper: 110, quantity: 100 } },
		]);
		const marketDepth: InventoryMarketDepthEvidenceV1 = {
			version: 1, capturedAt: CAPTURED_AT, source: 'gw2-commerce-listings', requestedItemIds: [42, 99], status: 'complete',
			items: [
				{ itemId: 42, coverage: 'complete', buys: [{ unitCopper: 100, quantity: 10 }], sells: [] },
				{ itemId: 99, coverage: 'complete', buys: [{ unitCopper: 100, quantity: 10 }], sells: [] },
			],
		};
		const dailyByItem = new Map<number, PriceHistoryDailyV1[]>([
			// Strictly increasing, 42 dense days: enough for `ready`, today at the top of the band.
			[42, dailySeriesFor(42, 42, 100, 10, Date.parse(CAPTURED_AT))],
			// Only 10 days: below the 42-day floor, so this one must stay `insufficient_history`.
			[99, dailySeriesFor(99, 10, 100, 10, Date.parse(CAPTURED_AT))],
		]);
		const input = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), prices, 'full', 'es', marketDepth, {
			priceHistoryEnabled: true,
			capitalThresholdCopper: 1,
			maxPriceAgeMs: 900_000,
			priceHistoryWindowDays: 180,
			priceHistoryRequiredDays: 42,
			dailyByItem,
			capturedAtMs: Date.parse(CAPTURED_AT),
			seasonalInputFor: () => null,
		});
		const byItem = new Map(input.positions.map((position) => [position.itemId, position]));
		const ready = byItem.get(42);
		const insufficient = byItem.get(99);
		expect(ready).toMatchObject({ recommendation: 'sell', pricePercentile: 100, priceCoverageDays: 42 });
		expect(insufficient).toMatchObject({
			recommendation: 'review', recommendationReason: 'price_history_insufficient',
			pricePercentile: null, priceCoverageDays: 10,
		});
		expect(insufficient?.priceCoverageDays).toBeLessThan(42);
		// Cierre medido: ninguna fila lleva percentil con cero días detrás.
		for (const position of input.positions) {
			if (position.pricePercentile !== null) expect(position.priceCoverageDays).toBeGreaterThan(0);
		}
	});

	/**
	 * Test 3, M3 fix cierre (docs/SPEC-recomendacion-por-objeto.md §3.b): `capture()`'s cableado, not
	 * just the pure `recommendPosition`. A festival item inside its own selling window writes `sell`
	 * with `tc_recommendation_until` at the close of ITS OWN window, never Halloween's; an item
	 * absent from `seasonalInputFor`'s table falls straight to rule (c).
	 */
	it('a festival item writes sell/seasonal_sell_window with `until` at the close of ITS OWN window; a non-calendar item falls to rule (c)', async () => {
		const festivalItemId = 47_909;
		const otherItemId = 99;
		const capturedAtMs = Date.parse('2026-12-20T12:00:00.000Z');
		const window: SeasonalWindowV1 = { version: 1, seasonId: 'test-window', opensOn: '12-15', closesOn: '01-10', returnsInMonth: 12 };
		const snapshot = snapshotWith([
			holding(festivalItemId, 5, { source: 'bank', slot: 0 }),
			holding(otherItemId, 5, { source: 'bank', slot: 1 }),
		]);
		// Ascending by itemId: the market-depth evidence type requires strictly ascending ids.
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: otherItemId, whitelisted: true, bid: { unitCopper: 100, quantity: 100 }, ask: { unitCopper: 110, quantity: 100 } },
			{ itemId: festivalItemId, whitelisted: true, bid: { unitCopper: 100, quantity: 100 }, ask: { unitCopper: 110, quantity: 100 } },
		]);
		const marketDepth: InventoryMarketDepthEvidenceV1 = {
			version: 1, capturedAt: CAPTURED_AT, source: 'gw2-commerce-listings', requestedItemIds: [otherItemId, festivalItemId], status: 'complete',
			items: [
				{ itemId: otherItemId, coverage: 'complete', buys: [{ unitCopper: 100, quantity: 10 }], sells: [] },
				{ itemId: festivalItemId, coverage: 'complete', buys: [{ unitCopper: 100, quantity: 10 }], sells: [] },
			],
		};
		// Flat 36-day series at 500 copper: today is at the reference floor for both items, but only
		// the festival item has a calendar entry that reads it as inside its own selling window.
		const dailyByItem = new Map<number, PriceHistoryDailyV1[]>([
			[festivalItemId, dailySeriesFor(festivalItemId, 36, 500, 0, capturedAtMs)],
			[otherItemId, dailySeriesFor(otherItemId, 36, 500, 0, capturedAtMs)],
		]);
		const input = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), prices, 'full', 'es', marketDepth, {
			priceHistoryEnabled: true,
			capitalThresholdCopper: 1,
			maxPriceAgeMs: 900_000,
			priceHistoryWindowDays: 180,
			priceHistoryRequiredDays: 42,
			dailyByItem,
			capturedAtMs,
			seasonalInputFor: (itemId) => itemId === festivalItemId
				? { window, parameters: { minimumOfMaxBps: 9_000, referenceDays: 365, minimumReferenceDays: 30 } }
				: null,
		});
		const byItem = new Map(input.positions.map((position) => [position.itemId, position]));
		const festival = byItem.get(festivalItemId);
		const other = byItem.get(otherItemId);
		const expectedUntil = new Date(seasonalWindowClosesAfterMs(window, capturedAtMs)!).toISOString();
		expect(festival).toMatchObject({ recommendation: 'sell', recommendationReason: 'seasonal_sell_window', recommendationUntil: expectedUntil });
		// Never Halloween's close for the same instant.
		expect(festival?.recommendationUntil).not.toBe(new Date(seasonalWindowClosesAfterMs(
			{ version: 1, seasonId: 'halloween', opensOn: '10-01', closesOn: '11-15', returnsInMonth: 10 }, capturedAtMs,
		)!).toISOString());
		// The non-calendar item falls to rule (c): flat series at its own reference floor sells or
		// holds on the percentile, never `sell_at_season`.
		expect(other?.recommendation).not.toBe('sell_at_season');
	});

	/**
	 * H15.x (2026-09-11, measured against 3292cd9): `capture()` fed `recommendPosition` only the
	 * plugin's own capture, never the datawars2 seed `PriceSeedBulkRefreshService` already cached in
	 * `tyrian-companion-price-seed-cache`. An item with zero of its own captures but 60 cached seed
	 * days stayed `review`/`price_history_insufficient` forever, defeating decision 4's whole point
	 * (never wait 42 days per item). This exercises the REAL `IndexedDbPriceSeedCacheStore` (the
	 * same fake IndexedDB `price-seed-cache-store.test.ts` and `price-seed-bulk-refresh.test.ts` use)
	 * and a `recommendation` port built the same way `main.ts` wires it (`readCachedSeed` reading
	 * that same cache, read-only), not a stub of `readDaily`.
	 */
	it('merges a cached datawars2 seed into the recommendation even with zero of the plugin\'s own captures', async () => {
		const itemId = 42;
		const capturedAtMs = Date.parse(CAPTURED_AT);
		const vaultId = 'vault-h15';
		const factory = new IDBFactory();
		const writeStore = await IndexedDbPriceSeedCacheStore.open(factory);
		await writeStore.put(vaultId, itemId, seedWith(seedDaysFor(60, 100, 1, capturedAtMs)), capturedAtMs);
		writeStore.close();
		// A second, independent connection to the same database: `main.ts` opens
		// `priceSeedBulkRefresh`'s writer and the recommendation port's reader separately too.
		const readStore = await IndexedDbPriceSeedCacheStore.open(factory);

		const snapshot: StorageSnapshot = { ...snapshotWith([holding(itemId, 5, { source: 'bank', slot: 0 })]), availableByItem: { [String(itemId)]: 5 } };
		const client = { beginOperation: vi.fn(() => ({ requestDetailed: accountRequest() })) };
		const snapshots = { captureWithOperation: vi.fn(async () => snapshot) };
		const catalog = { resolve: vi.fn(async (input: StorageSnapshot) => catalogFor(input)) };
		const gateway: PublicCatalogGateway = {
			requestDetailed: async (path) => {
				if (path.startsWith('commerce/listings?')) {
					return { status: 200, headers: {}, body: [{ id: itemId, buys: [{ listings: 1, unit_price: 100, quantity: 15 }], sells: [] }] };
				}
				if (path.startsWith('commerce/prices?')) {
					return { status: 200, headers: {}, body: [{ id: itemId, whitelisted: true, buys: { quantity: 1, unit_price: 100 }, sells: { quantity: 1, unit_price: 110 } }] };
				}
				throw new Error(`unexpected path in test gateway: ${path}`);
			},
		};
		const recommendation: InventoryPositionRecommendationPort = {
			priceHistoryEnabled: () => true,
			capitalThresholdCopper: () => 1,
			maxPriceAgeMs: () => 900_000,
			priceHistoryWindowDays: () => 180,
			// Zero of the plugin's own captures: exactly the fresh-watch-list-item case decision 4 exists for.
			readDaily: async () => [],
			readCachedSeed: async (id) => (await readStore.get(vaultId, id))?.seed ?? null,
			updateDerivedWatchList: async () => undefined,
			refreshPriceSeeds: async () => undefined,
			seasonalInputFor: () => null,
			...LEGENDARY_DISABLED_PORT_FIELDS,
		};
		const service = new InventoryVaultCaptureService(
			client as never, snapshots, catalog, gateway, recommendation, () => capturedAtMs,
		);
		const input = await service.capture('es');
		const position = input.positions.find((entry) => entry.itemId === itemId);
		// Measured failing on 3292cd9 (no `readCachedSeed` in the port, `readDailyByItem` reading
		// only `readDaily`): `toMatchObject({ priceCoverageDays: 60, pricePercentile: 100 })` fails
		// with `object.priceCoverageDays: expected 60, received 0` and `object.pricePercentile:
		// expected 100, received null` (recommendationReason `price_history_insufficient`).
		expect(position?.priceCoverageDays).toBeGreaterThanOrEqual(42);
		expect(typeof position?.pricePercentile).toBe('number');
		expect(position).toMatchObject({ recommendation: 'sell', recommendationReason: 'bid_above_reference', priceCoverageDays: 60, pricePercentile: 100 });
		readStore.close();
	});

	/**
	 * M2 test 4 (docs/SPEC-recomendacion-por-objeto.md, `docs/PLATFORM_POLICY.md`): the decision-3
	 * watch-list update and the decision-4 bulk seed refresh are both opt-in side effects of
	 * `capture()`, gated on `priceHistoryEnabled`. A fresh install (the default port, feature off)
	 * must never touch either, mirroring the H9.1 pattern of "off by default, nothing runs".
	 */
	it('never touches the derived watch list or the seed refresh port while price history is off', async () => {
		const client = { beginOperation: vi.fn(() => ({ requestDetailed: accountRequest() })) };
		const snapshots = { captureWithOperation: vi.fn(async () => snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })])) };
		const catalog = { resolve: vi.fn(async (input: StorageSnapshot) => catalogFor(input)) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 200, body: [], headers: {} })) };
		const updateDerivedWatchList = vi.fn(async () => undefined);
		const refreshPriceSeeds = vi.fn(async () => undefined);
		const recommendation = {
			priceHistoryEnabled: () => false,
			capitalThresholdCopper: () => 100_000,
			maxPriceAgeMs: () => 900_000,
			priceHistoryWindowDays: () => 180,
			readDaily: async () => [],
			readCachedSeed: async () => null,
			updateDerivedWatchList,
			refreshPriceSeeds,
			seasonalInputFor: () => null,
			...LEGENDARY_DISABLED_PORT_FIELDS,
		};
		const service = new InventoryVaultCaptureService(client as never, snapshots, catalog, gateway, recommendation);
		await service.capture('es');
		expect(updateDerivedWatchList).not.toHaveBeenCalled();
		expect(refreshPriceSeeds).not.toHaveBeenCalled();
	});

	it('calls the derived watch list and seed refresh ports exactly once per capture when price history is on', async () => {
		const client = { beginOperation: vi.fn(() => ({ requestDetailed: accountRequest() })) };
		const snapshots = { captureWithOperation: vi.fn(async () => snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })])) };
		const catalog = { resolve: vi.fn(async (input: StorageSnapshot) => catalogFor(input)) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 200, body: [], headers: {} })) };
		const updateDerivedWatchList = vi.fn(async () => undefined);
		const refreshPriceSeeds = vi.fn(async () => undefined);
		const recommendation = {
			priceHistoryEnabled: () => true,
			capitalThresholdCopper: () => 100_000,
			maxPriceAgeMs: () => 900_000,
			priceHistoryWindowDays: () => 180,
			readDaily: async () => [],
			readCachedSeed: async () => null,
			updateDerivedWatchList,
			refreshPriceSeeds,
			seasonalInputFor: () => null,
			...LEGENDARY_DISABLED_PORT_FIELDS,
		};
		const service = new InventoryVaultCaptureService(client as never, snapshots, catalog, gateway, recommendation);
		await service.capture('es');
		expect(updateDerivedWatchList).toHaveBeenCalledOnce();
		expect(refreshPriceSeeds).toHaveBeenCalledOnce();
	});

	it.each([
		['the request does not answer', async () => ({ status: 503, body: null, headers: {} })],
		['it answers for another account', async () => ({ status: 200, body: accountProfile('someone-else'), headers: {} })],
	])('aborts the capture when the account trading-post tier cannot be read because %s', async (_label, respond) => {
		const client = { beginOperation: vi.fn(() => ({ requestDetailed: vi.fn(respond) })) };
		const snapshots = { captureWithOperation: vi.fn(async () => snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })])) };
		const catalog = { resolve: vi.fn(async (snapshot: StorageSnapshot) => catalogFor(snapshot)) };
		const gateway = { requestDetailed: vi.fn(async () => ({ status: 200, body: [], headers: {} })) };
		const service = new InventoryVaultCaptureService(client as never, snapshots, catalog, gateway);
		// Degrading to 'unknown' here would price every position at null and write that
		// to Vault without a word, so the capture stops and the caller reports it.
		await expect(service.capture('es')).rejects.toThrow('inventory_trading_post_access_unavailable');
	});

	it('gives a full account the instant-sell value of an item the free-to-play whitelist excludes', async () => {
		const snapshot = snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })]);
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: 42, whitelisted: false, bid: { unitCopper: 10, quantity: 100 }, ask: { unitCopper: 11, quantity: 100 } },
		]);
		const projected = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), prices, 'full', 'es');
		expect(projected.positions[0]).toMatchObject({ unitSellCopper: 10, totalSellCopper: null });
	});

	it('leaves a free-to-play account without a value for an item the whitelist excludes', async () => {
		const snapshot = snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })]);
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: 42, whitelisted: false, bid: { unitCopper: 10, quantity: 100 }, ask: { unitCopper: 11, quantity: 100 } },
		]);
		const projected = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), prices, 'free_to_play', 'es');
		expect(projected.positions[0]).toMatchObject({ unitSellCopper: null, totalSellCopper: null, unitListCopper: null, totalListCopper: null });
	});

	it('leaves an account-bound item without any trading-post value even for a full account', async () => {
		const snapshot = snapshotWith([{ ...holding(42, 5, { source: 'bank', slot: 0 }), metadata: { binding: 'Account' } }]);
		const projected = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'full', 'es');
		expect(projected.positions[0]).toMatchObject({ unitSellCopper: null, totalSellCopper: null, unitListCopper: null, totalListCopper: null });
	});

	it('distinguishes a published listing without a current buy order from an item that cannot be sold at all', async () => {
		const snapshot = snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })]);
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: 42, whitelisted: true, bid: null, ask: { unitCopper: 20, quantity: 50 } },
		]);
		const projected = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), prices, 'full', 'es');
		// No buy order right now: the sell column stays null, but the item IS sellable,
		// which the published ask (list) column proves.
		expect(projected.positions[0]).toMatchObject({ unitSellCopper: null, totalSellCopper: null, unitListCopper: 20, totalListCopper: null });
	});

	it('updates an existing note whose sell value is null once the correct eligibility rule applies', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const snapshot = snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })]);
		const catalog = catalogFor(snapshot);
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: 42, whitelisted: false, bid: { unitCopper: 10, quantity: 100 }, ask: { unitCopper: 11, quantity: 100 } },
		]);
		// Simulates a note written while the wrong eligibility rule applied: same
		// snapshot and prices, but no trading-post access at all, so it lands null.
		const stale = await prepareInventoryVaultSyncInput(snapshot, catalog, prices, 'unknown', 'es');
		await service.apply(await service.preview(ROOT, stale));
		const stalePath = vault.markdownFiles()[0]!.path;
		expect(frontmatter(vault.contents.get(stalePath)!).tc_unit_sell_copper).toBeNull();

		const fixed = await prepareInventoryVaultSyncInput(snapshot, catalog, prices, 'full', 'es');
		const plan = await service.preview(ROOT, fixed);
		expect(plan.steps[0]).toMatchObject({ status: 'update' });
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', updated: 1 });
		expect(frontmatter(vault.contents.get(stalePath)!).tc_unit_sell_copper).toBe(10);
	});
});

describe('inventory Vault preview and apply', () => {
	it('rejects a distinct plan while another apply is in flight instead of borrowing its result', async () => {
		const vault = new PausingInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const firstPlan = await service.preview(ROOT, await oneBankInput());
		const secondInput = await oneBankInput();
		secondInput.capturedAt = '2026-08-25T08:01:00.000Z';
		const secondPlan = await service.preview(ROOT, secondInput);
		const first = service.apply(firstPlan);
		await vault.createStarted;
		await expect(service.apply(secondPlan)).resolves.toEqual({
			status: 'invalid', message: 'Another inventory plan is already being applied.',
		});
		vault.resumeCreate();
		await expect(first).resolves.toMatchObject({ status: 'applied' });
	});

	it('keeps preview read-only and converges through explicit idempotent apply', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await inputWithAllSources();
		const preview = await service.preview(ROOT, input);
		expect(preview.steps).toHaveLength(5);
		expect(preview.steps.every((entry) => entry.status === 'create')).toBe(true);
		expect(vault.mutations).toBe(0);
		expect(await service.apply(preview)).toEqual({ status: 'applied', created: 5, updated: 0, deactivated: 0 });
		const second = await service.preview(ROOT, input);
		expect(second.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
		const writes = vault.mutations;
		expect(await service.apply(second)).toEqual({ status: 'unchanged', created: 0, updated: 0, deactivated: 0 });
		expect(vault.mutations).toBe(writes);
	});

	it('reports onStep progress from the plan\'s own steps, not from a timer', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await inputWithAllSources();
		const preview = await service.preview(ROOT, input);
		const ticks: Array<[number, number]> = [];
		await service.apply(preview, (completed, total) => ticks.push([completed, total]));
		expect(preview.steps).toHaveLength(5);
		expect(ticks.every(([, total]) => total === 5)).toBe(true);
		expect(ticks.at(0)).toEqual([0, 5]);
		expect(ticks.at(-1)).toEqual([5, 5]);
		expect(ticks.map(([completed]) => completed)).toEqual([0, 1, 2, 3, 4, 5]);

		const second = await service.preview(ROOT, input);
		expect(second.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
		const unchangedTicks: Array<[number, number]> = [];
		await service.apply(second, (completed, total) => unchangedTicks.push([completed, total]));
		expect(unchangedTicks).toEqual([[5, 5]]);
	});

	// H15.11 (2026-09-10 incident): a `create` rejection with nothing landed at the path was
	// mapped to `conflict` ("An inventory note occupied a planned path."), even though the
	// preceding writes had already updated the Vault and there was no colliding note at all.
	it('reports a storage_failure with how many notes already landed when create is denied mid-apply', async () => {
		const vault = new FlakyCreateInventoryVault(2);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await inputWithAllSources();
		const preview = await service.preview(ROOT, input);
		expect(preview.steps.filter((entry) => entry.status === 'create')).toHaveLength(5);
		await expect(service.apply(preview)).resolves.toEqual({
			status: 'storage_failure', message: 'An inventory note could not be created.', written: 2, errorName: 'EACCES',
		});
		expect(vault.markdownFiles()).toHaveLength(2);
	});

	it('writes deterministic opaque filenames and redacts capture identities and raw credentials', async () => {
		const accountId = 'account-private-123';
		const snapshotId = 'snapshot-private-456';
		const token = 'token-private-789';
		const character = 'Beta / Dos';
		const snapshot = snapshotWith([holding(42, 2, characterBag(character))], { accountId, snapshotId });
		const input = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'full', 'es');
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await service.apply(await service.preview(ROOT, input));
		const [path] = vault.markdownFiles().map((file) => file.path);
		const bytes = [...vault.contents.values()].join('\n');
		expect(path).toMatch(/^Tyrian Companion\/Inventory\/Positions\/42-c-[a-f0-9]{24}\.md$/u);
		expect(path).not.toContain(character);
		for (const secret of [accountId, snapshotId, token]) expect(bytes).not.toContain(secret);
		expect(bytes).not.toContain('payload');
	});

	it('embeds the price-history piloto block only for the four allow-listed items', async () => {
		const snapshot = snapshotWith([
			holding(36_038, 2, { source: 'bank', slot: 0 }),
			holding(42, 5, { source: 'bank', slot: 1 }),
		]);
		const input = await prepareInventoryVaultSyncInput(
			snapshot, catalogFor(snapshot), pricesFor(snapshot, 36_038, 10), 'full', 'es',
		);
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await service.apply(await service.preview(ROOT, input));
		const pilotNote = [...vault.contents.entries()].find(([path]) => path.startsWith(`${ROOT}/Inventory/Positions/36038-`))![1];
		const otherNote = [...vault.contents.entries()].find(([path]) => path.startsWith(`${ROOT}/Inventory/Positions/42-`))![1];
		expect(pilotNote).toContain('```tyrian-price-history\n# Objeto 36038 (#36038)\nitemId: 36038\n```');
		expect(otherNote).not.toContain('tyrian-price-history');
		// A second, unmodified preview must still see the pilot note as unchanged: the block
		// is part of what the marker hash covers, not a live patch applied outside the plan.
		const second = await service.preview(ROOT, input);
		expect(second.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
	});

	it('deletes stale owned positions instead of leaving a tc_active: false note behind', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const current = await inputWithAllSources();
		await service.apply(await service.preview(ROOT, current));
		const stalePath = (await service.preview(ROOT, current)).steps.find((entry) => entry.positionId.includes('-b-'))!.path;
		const reduced = { ...current, capturedAt: '2026-08-25T08:01:00.000Z', positions: current.positions.filter((position) => position.source !== 'bank') };
		const preview = await service.preview(ROOT, reduced);
		expect(preview.steps.find((entry) => entry.path === stalePath)).toMatchObject({ status: 'deactivate', after: null });
		expect(await service.apply(preview)).toMatchObject({ status: 'applied', deactivated: 1 });
		expect(vault.contents.has(stalePath)).toBe(false);
	});

	it('does not rewrite a position note when only the capture timestamp changed', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const first = await oneBankInput();
		await service.apply(await service.preview(ROOT, first));
		const mutationsAfterFirst = vault.mutations;
		const second = { ...first, capturedAt: '2026-08-25T09:00:00.000Z' };
		const plan = await service.preview(ROOT, second);
		expect(plan.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
		expect(await service.apply(plan)).toMatchObject({ status: 'unchanged' });
		expect(vault.mutations).toBe(mutationsAfterFirst);
	});

	it('keeps position notes free of tc_captured_at so their hash stays stable across captures', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await oneBankInput();
		await service.apply(await service.preview(ROOT, input));
		const [path] = vault.markdownFiles().map((file) => file.path);
		expect(frontmatter(vault.contents.get(path!)!)).not.toHaveProperty('tc_captured_at');
	});

	it.each([
		['foreign target', (_content: string) => '# foreign\n'],
		['human modification', (content: string) => `${content}\nhuman edit\n`],
		['future schema', (content: string) => content.replace('schema=1', 'schema=2')],
	])('blocks %s without mutating Vault', async (_label, corrupt) => {
		const input = await oneBankInput();
		const cleanVault = new MemoryInventoryVault();
		const cleanService = new InventoryVaultSyncService(cleanVault, CONFIG_DIR);
		const cleanPlan = await cleanService.preview(ROOT, input);
		const path = cleanPlan.steps[0]!.path;
		if (_label === 'foreign target') cleanVault.contents.set(path, corrupt(''));
		else {
			await cleanService.apply(cleanPlan);
			cleanVault.contents.set(path, corrupt(cleanVault.contents.get(path)!));
		}
		const mutations = cleanVault.mutations;
		const blocked = await cleanService.preview(ROOT, input);
		expect(blocked.canApply).toBe(false);
		expect(blocked.steps.some((entry) => entry.status === 'conflict')).toBe(true);
		expect(await cleanService.apply(blocked)).toMatchObject({ status: 'invalid' });
		expect(cleanVault.mutations).toBe(mutations);
	});

	it('blocks an unrelated foreign note inside the owned positions folder', async () => {
		const foreignPath = `${ROOT}/Inventory/Positions/manual.md`;
		const foreign = '# Manual note\n';
		const vault = new MemoryInventoryVault([[foreignPath, foreign]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const plan = await service.preview(ROOT, await oneBankInput());
		expect(plan.canApply).toBe(false);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: foreignPath, status: 'conflict' }));
		const mutations = vault.mutations;
		expect(await service.apply(plan)).toMatchObject({ status: 'invalid' });
		expect(vault.mutations).toBe(mutations);
	});

	it('blocks duplicate owned identity without changing either collision', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await oneBankInput();
		await service.apply(await service.preview(ROOT, input));
		const originalPath = vault.markdownFiles()[0]!.path;
		const duplicatePath = `${ROOT}/Inventory/Positions/duplicate.md`;
		vault.contents.set(duplicatePath, vault.contents.get(originalPath)!);
		const before = new Map(vault.contents);
		const plan = await service.preview(ROOT, input);
		expect(plan.canApply).toBe(false);
		expect(await service.apply(plan)).toMatchObject({ status: 'invalid' });
		expect(vault.contents).toEqual(before);
	});

	it('preflights every CAS before writing when a file changes after preview', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const initial = await inputWithAllSources();
		await service.apply(await service.preview(ROOT, initial));
		const changed = {
			...initial,
			capturedAt: '2026-08-25T08:02:00.000Z',
			positions: initial.positions.map((position) => ({
				...position, quantity: position.quantity + 1,
				totalSellCopper: null,
				sellDepthStatus: 'unavailable' as const,
				sellUncoveredQuantity: position.sellUncoveredQuantity + 1,
				totalListCopper: null,
			})),
		};
		const plan = await service.preview(ROOT, changed);
		const last = plan.steps.at(-1)!;
		vault.contents.set(last.path, `${vault.contents.get(last.path)!}\nraced\n`);
		const before = new Map(vault.contents);
		expect(await service.apply(plan)).toMatchObject({ status: 'conflict' });
		expect(vault.contents).toEqual(before);
	});

	it('leaves legacy gw2 notes untouched and creates separate owned notes', async () => {
		const legacyPath = '02 - Areas/Guild Wars 2/Wiki/Existencias/legacy.md';
		const legacy = '---\ngw2_managed_type: inventory_holding_v1\ngw2_id: 42\ngw2_amount: 7\n---\n# Legacy\n';
		const vault = new MemoryInventoryVault([[legacyPath, legacy]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await oneBankInput();
		const plan = await service.preview(ROOT, input);
		expect(plan.canApply).toBe(true);
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', created: 1 });
		expect(vault.contents.get(legacyPath)).toBe(legacy);
		expect(vault.markdownFiles()).toHaveLength(2);
	});

	it('migrates a note written before the list-price fields existed instead of blocking on it', async () => {
		const notePath = `${ROOT}/Inventory/Positions/${LEGACY_NOTE_POSITION_ID}.md`;
		const legacyTopQuoteTotal = await resign(NOTE_WRITTEN_BY_0_1_11.replace(
			'tc_total_sell_copper: null', 'tc_total_sell_copper: 1234',
		));
		const vault = new MemoryInventoryVault([[notePath, legacyTopQuoteTotal]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const snapshot = snapshotWith([holding(LEGACY_NOTE_ITEM_ID, 1, characterBag(LEGACY_NOTE_CHARACTER))]);
		// Not whitelisted but with a live buy order: the very shape that left most of the
		// notes in a real Vault at a null sell value, so this also proves that fix lands.
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: LEGACY_NOTE_ITEM_ID, whitelisted: false, bid: { unitCopper: 1234, quantity: 5 }, ask: { unitCopper: 1300, quantity: 5 } },
		]);
		const input = await prepareInventoryVaultSyncInput(snapshot, legacyNoteCatalog(snapshot), prices, 'full', 'es');

		const plan = await service.preview(ROOT, input);
		expect(plan.steps).toEqual([expect.objectContaining({ path: notePath, status: 'update' })]);
		expect(plan.canApply).toBe(true);
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', updated: 1 });
		const fields = frontmatter(vault.contents.get(notePath)!);
		expect(Object.keys(fields)).toEqual(expect.arrayContaining(['tc_unit_list_copper', 'tc_total_list_copper']));
		expect(fields).toMatchObject({
			tc_unit_sell_copper: 1234, tc_total_sell_copper: null,
			tc_unit_list_copper: 1300, tc_total_list_copper: null,
		});
		// The 0.1.11 fixture carries `tc_captured_at`; H14.21 migrates it away on this same
		// rewrite instead of blocking the note as an unknown key.
		expect(fields).not.toHaveProperty('tc_captured_at');
	});

	it.each([
		['appended by hand', async (content: string) => `${content}\nnota mia\n`],
		['carrying an unknown key, re-signed', async (content: string) =>
			await resign(content.replace('descripcion:', 'tc_nota_mia: recordar\ndescripcion:'))],
		['claiming a position the marker does not', async (content: string) =>
			await resign(content.replace('tc_position_id: 100063-c-', 'tc_position_id: 100064-c-'))],
	])('still blocks a note in that older format %s', async (_label, corrupt) => {
		const notePath = `${ROOT}/Inventory/Positions/${LEGACY_NOTE_POSITION_ID}.md`;
		const vault = new MemoryInventoryVault([[notePath, await corrupt(NOTE_WRITTEN_BY_0_1_11)]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const snapshot = snapshotWith([holding(LEGACY_NOTE_ITEM_ID, 1, characterBag(LEGACY_NOTE_CHARACTER))]);
		const input = await prepareInventoryVaultSyncInput(
			snapshot, legacyNoteCatalog(snapshot), pricesFor(snapshot, LEGACY_NOTE_ITEM_ID, 10), 'full', 'es');
		const plan = await service.preview(ROOT, input);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: notePath, status: 'conflict' }));
		expect(plan.canApply).toBe(false);
		const mutations = vault.mutations;
		expect(await service.apply(plan)).toMatchObject({ status: 'invalid' });
		expect(vault.mutations).toBe(mutations);
	});

	/**
	 * M1 criterion of closure 1 (docs/SPEC-recomendacion-por-objeto.md §5): a sync over a note
	 * written before the four `tc_recommendation*` keys existed must migrate, never conflict.
	 * The negative half of this (removing the registration and watching it go red) is done by
	 * hand and reported, not committed as a second permanent test — see the implementation report.
	 */
	it('a sync over 0.1.33 frontmatter (no recommendation keys yet) produces zero conflict steps', async () => {
		const input = await oneBankInput();
		const created = (await new InventoryVaultSyncService(new MemoryInventoryVault(), CONFIG_DIR).preview(ROOT, input)).steps[0];
		if (!created || created.status !== 'create' || created.after === null) throw new Error('Expected a rendered create step.');
		const preM1 = await resign(created.after
			.replace(/^tc_recommendation: .*\n/mu, '')
			.replace(/^tc_recommendation_reason: .*\n/mu, '')
			.replace(/^tc_recommendation_until: .*\n/mu, '')
			.replace(/^tc_recommendation_missing: .*\n/mu, ''));
		expect(frontmatter(preM1)).not.toHaveProperty('tc_recommendation');
		const vault = new MemoryInventoryVault([[created.path, preM1]]);
		const plan = await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input);
		// Counted, not merely absent from a spot-check: a single `conflict` anywhere in the plan
		// means the whole sync writes nothing (docs/inventory-vault-sync.ts:151-163's landmine).
		expect(plan.steps.filter((step) => step.status === 'conflict')).toHaveLength(0);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: created.path, status: 'update' }));
	});

	/**
	 * M2 test 1 (docs/SPEC-recomendacion-por-objeto.md §5): a sync over the frontmatter M1 writes
	 * (with `tc_recommendation*` but WITHOUT `tc_price_percentile`/`tc_price_coverage_days`) must
	 * migrate, never conflict. Same landmine as M1's own criterion 1, one commit later.
	 *
	 * Verified by hand, not committed as a second permanent test (same discipline as the M1 test
	 * above): temporarily removing `tc_price_percentile`/`tc_price_coverage_days` from
	 * `INVENTORY_NOTE_KEYS_ADDED_LATER` turns this test red on
	 * `expect(plan.steps.filter((step) => step.status === 'conflict')).toHaveLength(0)`, with
	 * `AssertionError: expected [ {…(5)}, {…(5)} ] to have a length of +0 but got 2` — so the
	 * assertion is the one that would catch the landmine, not a name in a list.
	 */
	it('a sync over 0.1.33 frontmatter (no price-percentile keys yet) produces zero conflict steps', async () => {
		const input = await oneBankInput();
		const created = (await new InventoryVaultSyncService(new MemoryInventoryVault(), CONFIG_DIR).preview(ROOT, input)).steps[0];
		if (!created || created.status !== 'create' || created.after === null) throw new Error('Expected a rendered create step.');
		const preM2 = await resign(created.after
			.replace(/^tc_price_percentile: .*\n/mu, '')
			.replace(/^tc_price_coverage_days: .*\n/mu, ''));
		expect(frontmatter(preM2)).not.toHaveProperty('tc_price_percentile');
		expect(frontmatter(preM2)).not.toHaveProperty('tc_price_coverage_days');
		const vault = new MemoryInventoryVault([[created.path, preM2]]);
		const plan = await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input);
		expect(plan.steps.filter((step) => step.status === 'conflict')).toHaveLength(0);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: created.path, status: 'update' }));
	});

	/**
	 * M4 test 4 (docs/SPEC-recomendacion-por-objeto.md, 85b8c96): a sync over the frontmatter M3
	 * wrote (WITHOUT `tc_reserved_quantity`/`tc_free_quantity`) must migrate, never conflict. Same
	 * landmine as the two tests above, one M later.
	 *
	 * Verified by hand, not committed as a second permanent test (same discipline as the two tests
	 * above): temporarily removing `tc_reserved_quantity`/`tc_free_quantity` from
	 * `INVENTORY_NOTE_KEYS_ADDED_LATER` turns this test red on
	 * `expect(plan.steps.filter((step) => step.status === 'conflict')).toHaveLength(0)`, with
	 * `AssertionError: expected [ { …(5) }, { …(5) } ] to have a length of +0 but got 2` (measured
	 * by hand, 2026-09-11: `oneBankInput()` fans out to two positions, both go conflict).
	 */
	it('a sync over 85b8c96 frontmatter (no legendary-reservation keys yet) produces zero conflict steps', async () => {
		const input = await oneBankInput();
		const created = (await new InventoryVaultSyncService(new MemoryInventoryVault(), CONFIG_DIR).preview(ROOT, input)).steps[0];
		if (!created || created.status !== 'create' || created.after === null) throw new Error('Expected a rendered create step.');
		const pre85b8c96 = await resign(created.after
			.replace(/^tc_reserved_quantity: .*\n/mu, '')
			.replace(/^tc_free_quantity: .*\n/mu, ''));
		expect(frontmatter(pre85b8c96)).not.toHaveProperty('tc_reserved_quantity');
		expect(frontmatter(pre85b8c96)).not.toHaveProperty('tc_free_quantity');
		const vault = new MemoryInventoryVault([[created.path, pre85b8c96]]);
		const plan = await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input);
		expect(plan.steps.filter((step) => step.status === 'conflict')).toHaveLength(0);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: created.path, status: 'update' }));
	});

	it('rejects non-portable roots before any mutation', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		for (const root of ['/absolute', '../escape', 'Bad:Root', `${CONFIG_DIR}/Inventory`, 'CON']) {
			await expect(service.preview(root, await oneBankInput())).rejects.toThrow('invalid_inventory_sync_input');
		}
		expect(vault.mutations).toBe(0);
	});
});

function snapshotWith(
	holdings: ItemHolding[],
	identity: { accountId?: string; snapshotId?: string } = {},
): StorageSnapshot {
	return {
		snapshotId: identity.snapshotId ?? 'snapshot-a',
		accountId: identity.accountId ?? 'account-a',
		startedAt: '2026-08-25T08:00:00.000Z',
		completedAt: CAPTURED_AT,
		passCoverages: [], quality: 'stable', passes: 2, schemaVersion: PINNED_SCHEMA,
		holdings, currencies: [], availableByItem: {}, ownedByItem: {}, currencyById: {},
		coverage: {
			sources: {
				characters: { status: 'complete' }, shared_inventory: { status: 'complete' },
				bank: { status: 'complete' }, materials: { status: 'complete' }, wallet: { status: 'complete' },
				commerce_delivery: { status: 'complete' },
			},
			characters: {},
		},
		roster: [],
	};
}

function accountProfile(accountId: string): Record<string, unknown> {
	return { id: accountId, name: 'Cuenta.1234', world: 1001, created: '2015-08-28T10:00:00Z', access: ['GuildWars2'], commander: false };
}

function accountRequest(): ReturnType<typeof vi.fn> {
	return vi.fn(async () => ({ status: 200, body: accountProfile('account-a'), headers: {} }));
}

function holding(itemId: number, quantity: number, location: ItemHolding['location']): ItemHolding {
	return { kind: 'item', itemId, quantity, state: 'loose', location, metadata: {} };
}

function characterBag(character: string): ItemHolding['location'] {
	return { source: 'character', character, container: 'bag', bagIndex: 0, slot: 0 };
}

function catalogFor(snapshot: StorageSnapshot): CatalogResolution {
	const ids = [...new Set(snapshot.holdings.map((entry) => entry.itemId))];
	return {
		snapshotId: snapshot.snapshotId, locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: CAPTURED_AT,
		items: Object.fromEntries(ids.map((id) => [String(id), {
			kind: 'item', id, name: `Objeto ${String(id)}`, type: 'Material', rarity: 'Fine', level: 0,
			vendorValue: 0, flags: [], gameTypes: [], restrictions: [],
		}])),
		currencies: {}, materials: {}, warnings: [], coverage: { items: {}, currencies: {}, materials: {} },
	};
}

function priceSnapshotWith(snapshot: StorageSnapshot, items: InventoryItemPriceV1[]): InventoryPriceSnapshotV1 {
	return {
		version: 1, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
		capturedAt: CAPTURED_AT, source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA,
		requestedItemIds: items.map((item) => item.itemId), status: 'complete', missingItemIds: [],
		items,
	};
}

function pricesFor(snapshot: StorageSnapshot, itemId: number, unitCopper: number): InventoryPriceSnapshotV1 {
	return priceSnapshotWith(snapshot, [
		{ itemId, whitelisted: true, bid: { unitCopper, quantity: 100 }, ask: { unitCopper: unitCopper + 1, quantity: 100 } },
	]);
}

function marketDepthFor(
	itemId: number,
	buys: InventoryMarketDepthEvidenceV1['items'][number]['buys'],
): InventoryMarketDepthEvidenceV1 {
	return {
		version: 1,
		capturedAt: CAPTURED_AT,
		source: 'gw2-commerce-listings',
		requestedItemIds: [itemId],
		status: 'complete',
		items: [{ itemId, coverage: 'complete', buys, sells: [] }],
	};
}

/** One daily row per day, closing bid rising by `step` from `startCopper`, ending on `endMs`'s own day. */
function dailySeriesFor(itemId: number, days: number, startCopper: number, step: number, endMs: number): PriceHistoryDailyV1[] {
	const out: PriceHistoryDailyV1[] = [];
	for (let index = 0; index < days; index += 1) {
		const dayUtc = new Date(endMs - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
		out.push({
			version: 1, vaultId: 'vault', itemId, dayUtc, snapshotCount: 1, partialSnapshotCount: 0, ask: null,
			bid: {
				count: 1, minCopper: startCopper + index * step, maxCopper: startCopper + index * step,
				medianCopperX2: (startCopper + index * step) * 2, closeCopper: startCopper + index * step, closeCapturedAtMs: endMs,
			},
		});
	}
	return out;
}

function seedWith(days: PriceSeedDayV1[]): PriceSeedV1 {
	return { version: 1, itemId: 42, source: 'datawars2', retrievedAt: CAPTURED_AT, days };
}

/** One seed day per day, bid rising by `step` from `startCopper`, ending on `endMs`'s own day. */
function seedDaysFor(days: number, startCopper: number, step: number, endMs: number): PriceSeedDayV1[] {
	const out: PriceSeedDayV1[] = [];
	for (let index = 0; index < days; index += 1) {
		const dayUtc = new Date(endMs - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
		out.push({ dayUtc, bidCopper: startCopper + index * step, askCopper: null });
	}
	return out;
}

/**
 * A note copied verbatim out of a real Vault, written by 0.1.11 before
 * `tc_unit_list_copper`/`tc_total_list_copper` existed. Its marker hash is the real one
 * and covers this exact text, so reflowing or reindenting it makes the note stop
 * validating for the wrong reason.
 */
const NOTE_WRITTEN_BY_0_1_11 = `---
tc_schema: 1
tc_kind: gw2_inventory_position
tc_marker: tyrian_companion_inventory_position
tc_position_id: 100063-c-54a014e68376be0c2fa8f7ca
tc_item_id: 100063
tc_source: character
tc_character: Rinorrata
tc_quantity: 1
tc_unit_sell_copper: null
tc_total_sell_copper: null
tc_active: true
tc_captured_at: 2026-08-26T12:42:21.605Z
tc_item_name: Reliquia de sobrecarga
tc_item_type: Relic
tc_item_rarity: Exotic
tc_icon: https://render.guildwars2.com/file/755D9F3BA1C2C42CDAEBF59BBF4564B77ADC105D/3592840.png
descripcion: Existencia de inventario gestionada por Tyrian Companion.
---
<!-- tyrian-companion-inventory schema=1 marker=tyrian_companion_inventory_position position=100063-c-54a014e68376be0c2fa8f7ca hash=e90be601c8fbabfdd6890491386fc9d3cb69f482bab1556eecf78b2829b4ede2 -->
# Reliquia de sobrecarga

Existencia de inventario gestionada por Tyrian Companion.
`;
const LEGACY_NOTE_POSITION_ID = '100063-c-54a014e68376be0c2fa8f7ca';
const LEGACY_NOTE_ITEM_ID = 100063;
const LEGACY_NOTE_CHARACTER = 'Rinorrata';

/** Re-signs an edited note so it fails validation on its fields, not on a stale hash. */
async function resign(content: string): Promise<string> {
	const unsigned = content.replace(/ hash=[a-f0-9]{64} -->/u, ' -->');
	return unsigned.replace(' -->', ` hash=${await sha256Text(unsigned)} -->`);
}

function legacyNoteCatalog(snapshot: StorageSnapshot): CatalogResolution {
	return {
		...catalogFor(snapshot),
		items: {
			[String(LEGACY_NOTE_ITEM_ID)]: {
				kind: 'item', id: LEGACY_NOTE_ITEM_ID, name: 'Reliquia de sobrecarga', type: 'Relic',
				rarity: 'Exotic', level: 0, vendorValue: 0, flags: [], gameTypes: [], restrictions: [],
			},
		},
	};
}

async function inputWithAllSources() {
	const snapshot = snapshotWith([
		holding(42, 2, characterBag('Alfa')),
		holding(42, 3, characterBag('Beta')),
		holding(42, 4, { source: 'shared_inventory', slot: 0 }),
		holding(42, 5, { source: 'bank', slot: 0 }),
		holding(42, 6, { source: 'materials', category: 1 }),
	]);
	return await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'full', 'es');
}

async function oneBankInput() {
	const snapshot = snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })]);
	return await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), pricesFor(snapshot, 42, 10), 'full', 'es');
}

function frontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!match) throw new Error('Missing test frontmatter.');
	return parseYaml(match[1]!) as Record<string, unknown>;
}

class MemoryInventoryVault implements InventoryVaultPort {
	readonly contents: Map<string, string>;
	readonly folders = new Set<string>();
	mutations = 0;

	constructor(entries: Iterable<readonly [string, string]> = []) { this.contents = new Map(entries); }
	file(path: string): InventoryVaultFile | null {
		return this.contents.has(path) || this.folders.has(path) ? { path } : null;
	}
	markdownFiles(): readonly InventoryVaultFile[] {
		return [...this.contents.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path }));
	}
	async read(file: InventoryVaultFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error('not_file');
		return content;
	}
	async createFolder(path: string): Promise<void> {
		if (this.file(path)) throw new Error('exists');
		this.mutations += 1;
		this.folders.add(path);
	}
	async create(path: string, content: string): Promise<InventoryVaultFile> {
		if (this.file(path)) throw new Error('exists');
		this.mutations += 1;
		this.contents.set(path, content);
		return { path };
	}
	async process(file: InventoryVaultFile, update: (content: string) => string): Promise<string> {
		const current = await this.read(file);
		const next = update(current);
		if (next !== current) {
			this.mutations += 1;
			this.contents.set(file.path, next);
		}
		return next;
	}
	async trashFile(file: InventoryVaultFile): Promise<void> {
		if (!this.contents.has(file.path)) throw new Error('not_file');
		this.mutations += 1;
		this.contents.delete(file.path);
	}
}

/** Succeeds the first `okCount` creates, then rejects every further one with a permission error. */
class FlakyCreateInventoryVault extends MemoryInventoryVault {
	private creates = 0;
	constructor(private readonly okCount: number) { super(); }
	override async create(path: string, content: string): Promise<InventoryVaultFile> {
		this.creates += 1;
		if (this.creates > this.okCount) throw Object.assign(new Error('permission denied'), { name: 'EACCES' });
		return await super.create(path, content);
	}
}

class PausingInventoryVault extends MemoryInventoryVault {
	readonly createStarted: Promise<void>;
	private signalCreateStarted!: () => void;
	private readonly createResumed: Promise<void>;
	private signalCreateResumed!: () => void;

	constructor() {
		super();
		this.createStarted = new Promise((resolve) => { this.signalCreateStarted = resolve; });
		this.createResumed = new Promise((resolve) => { this.signalCreateResumed = resolve; });
	}

	resumeCreate(): void { this.signalCreateResumed(); }

	override async create(path: string, content: string): Promise<InventoryVaultFile> {
		this.signalCreateStarted();
		await this.createResumed;
		return await super.create(path, content);
	}
}
