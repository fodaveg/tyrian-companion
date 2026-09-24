import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type ItemHolding, type StorageSnapshot } from '../account/storage-snapshot-model';
import { sha256Text } from '../assets/managed-asset-hash';
import type { InventoryItemPriceV1, InventoryPriceSnapshotV1 } from '../advisor/inventory-advisor-model';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import type { InventoryMarketDepthEvidenceV1 } from '../economy/commerce-listings';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { seasonalWindowClosesAfterMs, type SeasonalWindowV1 } from '../economy/seasonal-window';
import {
	attachPositionRecommendations,
	sumSellCopperByItem,
	InventoryVaultSyncService,
	prepareInventoryVaultSyncInput,
	type InventoryPositionRecommendationInputs,
	type InventoryVaultFile,
	type InventoryVaultPort,
	type InventoryVaultPositionCore,
} from './inventory-vault-sync';

const ROOT = 'Tyrian Companion';
const CONFIG_DIR = 'vault-config';
const CAPTURED_AT = '2026-08-25T08:00:01.000Z';

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

	// H18.16: the notes no longer capture anything of their own. The cases that exercised that private
	// capture (the capture-on-demand guard, M1 closure 3, M4 test 8, the seed merge, the watch-list
	// gating and H18.1's legendary reservations) now run through the advisor's analysis in
	// `inventory-analysis.test.ts`. The trading-post tier guard lives where the tier is now read: the
	// advisor evidence capture refuses to produce evidence when `account` does not answer.

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
		// H18.2: today's quote is what gets ranked; item 42's (510) matches its series' own close for
		// today, so "today at the top of the band" still holds for the reason this test was written.
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: 42, whitelisted: true, bid: { unitCopper: 510, quantity: 100 }, ask: { unitCopper: 520, quantity: 100 } },
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
		// 36 days rising 60..95 copper, today's quote 100 above all of them: only the festival item has
		// a calendar entry that reads it as inside its own selling window, confirmed by the price
		// (H18.19: a flat series or the floor no longer confirms a window).
		const dailyByItem = new Map<number, PriceHistoryDailyV1[]>([
			[festivalItemId, dailySeriesFor(festivalItemId, 36, 60, 1, capturedAtMs)],
			[otherItemId, dailySeriesFor(otherItemId, 36, 60, 1, capturedAtMs)],
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
		// H18.19: the window is its own clock (inclusive days, across new year); `until` is the
		// analysis' validity, the capture plus the price age.
		expect(festival).toMatchObject({
			recommendation: 'sell', recommendationReason: 'seasonal_sell_window',
			recommendationUntil: new Date(capturedAtMs + 900_000).toISOString(),
			sellWindowFromDay: '2026-12-15', sellWindowToDay: '2027-01-10',
		});
		expect(Date.parse(`${festival!.sellWindowToDay!}T00:00:00Z`) + 86_400_000).toBe(seasonalWindowClosesAfterMs(window, capturedAtMs));
		// Never Halloween's close for the same instant.
		expect(Date.parse(`${festival!.sellWindowToDay!}T00:00:00Z`) + 86_400_000).not.toBe(seasonalWindowClosesAfterMs(
			{ version: 1, seasonId: 'halloween', opensOn: '10-01', closesOn: '11-15', returnsInMonth: 10 }, capturedAtMs,
		));
		// The non-calendar item falls to rule (c): flat series at its own reference floor sells or
		// holds on the percentile, never `sell_at_season`.
		expect(other?.recommendation).not.toBe('sell_at_season');
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

	/**
	 * Revocation of decision 3 of the H18 lote (coordinator, 24 sep 2026): an item the trading post
	 * will never quote for this account is `hold`/`not_tradeable`, not `review`/`price_unknown`;
	 * only a TRADEABLE item without today's quote is the doubt. Read from `classifyItemLiquidity`
	 * (catalog `AccountBound`/`SoulbindOnAcquire`, or the holding's own binding) and the
	 * free-to-play whitelist, never from `NoSell`, which only forbids vendor sales.
	 */
	it('an account-bound item without a quote holds as not_tradeable; a tradeable one without a quote is price_unknown', async () => {
		const snapshot = snapshotWith([
			holding(42, 5, { source: 'bank', slot: 0 }),
			holding(43, 5, { source: 'bank', slot: 1 }),
			{ ...holding(44, 5, { source: 'bank', slot: 2 }), metadata: { binding: 'Character' } },
			holding(45, 5, { source: 'bank', slot: 3 }),
		]);
		const base = catalogFor(snapshot);
		const catalog: CatalogResolution = {
			...base,
			items: {
				...base.items,
				'42': { ...base.items['42']!, flags: ['AccountBound'] },
				// `NoSell` forbids selling to a vendor, not listing on the trading post.
				'45': { ...base.items['45']!, flags: ['NoSell'] },
			},
		};
		const noQuotes = priceSnapshotWith(snapshot, []);
		const projected = await prepareInventoryVaultSyncInput(snapshot, catalog, noQuotes, 'full', 'es', undefined, {
			capturedAtMs: Date.parse(CAPTURED_AT), priceHistoryEnabled: true, capitalThresholdCopper: 1, maxPriceAgeMs: 900_000,
			priceHistoryWindowDays: 180, priceHistoryRequiredDays: 42, dailyByItem: new Map(), seasonalInputFor: () => null,
		});
		const byItem = new Map(projected.positions.map((position) => [position.itemId, position]));
		const notTradeable = { recommendation: 'hold', recommendationReason: 'not_tradeable', recommendationUntil: null };
		const priceUnknown = { recommendation: 'review', recommendationReason: 'price_unknown', recommendationUntil: null };
		expect(byItem.get(42)).toMatchObject(notTradeable);
		expect(byItem.get(43)).toMatchObject(priceUnknown);
		expect(byItem.get(44)).toMatchObject(notTradeable);
		expect(byItem.get(45)).toMatchObject(priceUnknown);
	});

	it('a free-to-play account holds a quoted item outside the whitelist as not_tradeable; a full account does not', async () => {
		const snapshot = snapshotWith([holding(42, 5, { source: 'bank', slot: 0 })]);
		const prices = priceSnapshotWith(snapshot, [
			{ itemId: 42, whitelisted: false, bid: { unitCopper: 10, quantity: 100 }, ask: { unitCopper: 11, quantity: 100 } },
		]);
		const inputs = {
			capturedAtMs: Date.parse(CAPTURED_AT), priceHistoryEnabled: true, capitalThresholdCopper: 1, maxPriceAgeMs: 900_000,
			priceHistoryWindowDays: 180, priceHistoryRequiredDays: 42, dailyByItem: new Map(), seasonalInputFor: () => null,
		};
		const freeToPlay = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), prices, 'free_to_play', 'es', undefined, inputs);
		expect(freeToPlay.positions[0]).toMatchObject({ recommendation: 'hold', recommendationReason: 'not_tradeable' });
		const full = await prepareInventoryVaultSyncInput(snapshot, catalogFor(snapshot), prices, 'full', 'es', undefined, inputs);
		expect(full.positions[0]?.recommendationReason).not.toBe('not_tradeable');
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

describe('sumSellCopperByItem (SPEC-recomendacion-por-objeto.md §3.c / §7 decision 5, 11 sep 2026)', () => {
	it('sums totalSellCopper across positions of the same item, leaving other items untouched', () => {
		const result = sumSellCopperByItem([
			{ itemId: 36_041, totalSellCopper: 34_884 },
			{ itemId: 36_041, totalSellCopper: 140_350 },
			{ itemId: 36_041, totalSellCopper: 59_500 },
			{ itemId: 99, totalSellCopper: 10 },
		]);
		expect(result.get(36_041)).toBe(234_734);
		expect(result.get(99)).toBe(10);
	});

	it('a null position contributes nothing to the sum without turning it null when another position has a value', () => {
		const result = sumSellCopperByItem([
			{ itemId: 1, totalSellCopper: 60_000 },
			{ itemId: 1, totalSellCopper: null },
			{ itemId: 1, totalSellCopper: 50_000 },
		]);
		expect(result.get(1)).toBe(110_000);
	});

	it('stays null when every position of the item is null, exactly like a single undemonstrated position', () => {
		const result = sumSellCopperByItem([{ itemId: 1, totalSellCopper: null }, { itemId: 1, totalSellCopper: null }]);
		expect(result.get(1)).toBeNull();
	});
});

/**
 * David, 11 sep 2026: the capital-parked threshold (rule (c), condition 1) is measured PER OBJECT
 * (the sum of `tc_total_sell_copper` across every position holding that `itemId`), never per note.
 * Before this decision `recommendPosition` compared each position's OWN `totalSellCopper`: the
 * Trozo de caramelo (36041) sitting in three notes of 34 884, 140 350 and 59 500 copper had two of
 * them read `below_capital_threshold` even though the object as a whole is worth more than 23 gold.
 */
describe('attachPositionRecommendations: capital threshold measured per object (11 sep 2026)', () => {
	function coreFixture(overrides: Partial<InventoryVaultPositionCore> & { positionId: string; itemId: number }): InventoryVaultPositionCore {
		// H18.2: every fixture has a quote today (`unitSellCopper`), so these cases measure the
		// capital threshold, not the "no price today" gate that now precedes it.
		return {
			source: 'bank', character: null, quantity: 1,
			unitSellCopper: 100, sellDepthStatus: 'unavailable', sellCoveredQuantity: 0, sellUncoveredQuantity: 1,
			unitListCopper: null, totalListCopper: null, totalSellCopper: null,
			name: `Objeto ${String(overrides.itemId)}`, type: null, rarity: null, icon: null, untradeable: false,
			...overrides,
		};
	}

	function recommendationInputsFixture(overrides: Partial<InventoryPositionRecommendationInputs> = {}): InventoryPositionRecommendationInputs {
		return {
			capturedAtMs: Date.parse(CAPTURED_AT),
			priceHistoryEnabled: true,
			capitalThresholdCopper: 100_000,
			maxPriceAgeMs: 900_000,
			priceHistoryWindowDays: 180,
			priceHistoryRequiredDays: 42,
			dailyByItem: new Map(),
			seasonalInputFor: () => null,
			...overrides,
		};
	}

	const baseInputs = recommendationInputsFixture();

	it('measured failing on 31b6359: three notes of one object at 34 884 / 140 350 / 59 500 copper (threshold 100 000) never read below_capital_threshold once compared by object sum', () => {
		const cores: InventoryVaultPositionCore[] = [
			coreFixture({ positionId: 'a', itemId: 36_041, source: 'bank', totalSellCopper: 34_884 }),
			coreFixture({ positionId: 'b', itemId: 36_041, source: 'character', character: 'Alfa', totalSellCopper: 140_350 }),
			coreFixture({ positionId: 'c', itemId: 36_041, source: 'character', character: 'Beta', totalSellCopper: 59_500 }),
		];
		const positions = attachPositionRecommendations(cores, baseInputs);
		// On 31b6359 (per-position threshold, `recommendPosition` reading `core.totalSellCopper`
		// straight) this fails for positions 'a' and 'c': `expect(received).not.toBe(expected)` /
		// `expected: not "below_capital_threshold"` / `received: "below_capital_threshold"`, since
		// 34 884 and 59 500 are each individually under the 100 000 threshold.
		for (const position of positions) {
			expect(position.recommendationReason).not.toBe('below_capital_threshold');
		}
	});

	it('two notes of one object at 30 000 and 40 000 (object sum 70 000, still under 100 000) both stay hold/below_capital_threshold', () => {
		const cores: InventoryVaultPositionCore[] = [
			coreFixture({ positionId: 'a', itemId: 1, source: 'bank', totalSellCopper: 30_000 }),
			coreFixture({ positionId: 'b', itemId: 1, source: 'character', character: 'Alfa', totalSellCopper: 40_000 }),
		];
		const positions = attachPositionRecommendations(cores, baseInputs);
		for (const position of positions) {
			expect(position).toMatchObject({ recommendation: 'hold', recommendationReason: 'below_capital_threshold' });
		}
	});

	it('a null note never turns a known object sum "undemonstrated": 60 000 + 50 000 + null clears the threshold for all three', () => {
		const cores: InventoryVaultPositionCore[] = [
			coreFixture({ positionId: 'a', itemId: 1, source: 'bank', totalSellCopper: 60_000 }),
			coreFixture({ positionId: 'b', itemId: 1, source: 'character', character: 'Alfa', totalSellCopper: 50_000 }),
			coreFixture({ positionId: 'c', itemId: 1, source: 'character', character: 'Beta', totalSellCopper: null }),
		];
		const positions = attachPositionRecommendations(cores, baseInputs);
		for (const position of positions) {
			expect(position.recommendationReason).not.toBe('below_capital_threshold');
		}
	});

	it('two different objects never share a sum: each stays below its own threshold independently', () => {
		const cores: InventoryVaultPositionCore[] = [
			coreFixture({ positionId: 'a', itemId: 1, source: 'bank', totalSellCopper: 60_000 }),
			coreFixture({ positionId: 'b', itemId: 2, source: 'bank', totalSellCopper: 60_000 }),
		];
		const positions = attachPositionRecommendations(cores, baseInputs);
		for (const position of positions) {
			expect(position).toMatchObject({ recommendation: 'hold', recommendationReason: 'below_capital_threshold' });
		}
	});

	it('rule (a) active: the object sum uses each note\'s FREE share (scaledSellCopper), not its raw totalSellCopper', () => {
		const cores: InventoryVaultPositionCore[] = [
			coreFixture({ positionId: 'a', itemId: 1, source: 'bank', quantity: 10, totalSellCopper: 100_000 }),
			coreFixture({ positionId: 'b', itemId: 1, source: 'character', character: 'Alfa', quantity: 10, totalSellCopper: 100_000 }),
		];
		// Both notes half-reserved (freeQuantity 5 of 10): free share is 50 000 each, summing to
		// exactly 100 000 - not the 200 000 the raw totals would sum to.
		const reservations = new Map([
			['a', { reservedQuantity: 5, freeQuantity: 5, shortfall: 0 }],
			['b', { reservedQuantity: 5, freeQuantity: 5, shortfall: 0 }],
		]);
		const aboveTheFreeSum = attachPositionRecommendations(
			cores, recommendationInputsFixture({ capitalThresholdCopper: 100_001 }), reservations,
		);
		for (const position of aboveTheFreeSum) {
			expect(position).toMatchObject({ recommendation: 'hold', recommendationReason: 'below_capital_threshold' });
		}
		const atTheFreeSum = attachPositionRecommendations(
			cores, recommendationInputsFixture({ capitalThresholdCopper: 100_000 }), reservations,
		);
		for (const position of atTheFreeSum) {
			expect(position.recommendationReason).not.toBe('below_capital_threshold');
		}
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
		expect(await service.apply(preview)).toEqual({ status: 'applied', created: 5, updated: 0, deactivated: 0, conflicts: 0 });
		const second = await service.preview(ROOT, input);
		expect(second.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
		const writes = vault.mutations;
		expect(await service.apply(second)).toEqual({ status: 'unchanged', created: 0, updated: 0, deactivated: 0, conflicts: 0 });
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

	/**
	 * H18.16: a note the plugin cannot safely rewrite is a conflict for that note alone. It is never
	 * written, and it no longer blocks the plan (`canApply` stays true): at e693eba any of these
	 * turned the whole sync into `invalid` and wrote nothing at all.
	 */
	it.each([
		['foreign target', (_content: string) => '# foreign\n'],
		['edit inside the managed block', (content: string) => content.replace('\n# Objeto 42\n', '\n# Objeto 42 (mío)\n')],
		['future schema', (content: string) => content.replace('schema=1', 'schema=2')],
	])('keeps a %s as its own conflict, untouched, without blocking the plan', async (_label, corrupt) => {
		const input = await oneBankInput();
		const cleanVault = new MemoryInventoryVault();
		const cleanService = new InventoryVaultSyncService(cleanVault, CONFIG_DIR);
		const cleanPlan = await cleanService.preview(ROOT, input);
		const path = cleanPlan.steps[0]!.path;
		if (_label === 'foreign target') cleanVault.contents.set(path, corrupt(''));
		else {
			await cleanService.apply(cleanPlan);
			const corrupted = corrupt(cleanVault.contents.get(path)!);
			expect(corrupted).not.toBe(cleanVault.contents.get(path));
			cleanVault.contents.set(path, corrupted);
		}
		const kept = cleanVault.contents.get(path);
		const mutations = cleanVault.mutations;
		const plan = await cleanService.preview(ROOT, input);
		expect(plan.canApply).toBe(true);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path, status: 'conflict' }));
		expect(await cleanService.apply(plan)).toMatchObject({ status: 'unchanged', conflicts: 1 });
		expect(cleanVault.mutations).toBe(mutations);
		expect(cleanVault.contents.get(path)).toBe(kept);
	});

	it('leaves an unrelated foreign note inside the owned positions folder alone and writes every other note', async () => {
		const foreignPath = `${ROOT}/Inventory/Positions/manual.md`;
		const foreign = '# Manual note\n';
		const vault = new MemoryInventoryVault([[foreignPath, foreign]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const plan = await service.preview(ROOT, await oneBankInput());
		expect(plan.canApply).toBe(true);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: foreignPath, status: 'conflict' }));
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', created: 1, conflicts: 1 });
		expect(vault.contents.get(foreignPath)).toBe(foreign);
		expect(vault.markdownFiles()).toHaveLength(2);
	});

	it('keeps a duplicate owned identity as a conflict without changing either collision', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await oneBankInput();
		await service.apply(await service.preview(ROOT, input));
		const originalPath = vault.markdownFiles()[0]!.path;
		const duplicatePath = `${ROOT}/Inventory/Positions/duplicate.md`;
		vault.contents.set(duplicatePath, vault.contents.get(originalPath)!);
		const before = new Map(vault.contents);
		const plan = await service.preview(ROOT, input);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: duplicatePath, status: 'conflict' }));
		expect(await service.apply(plan)).toMatchObject({ status: 'unchanged', conflicts: 1 });
		expect(vault.contents).toEqual(before);
	});

	it('skips a note that changed after preview and still writes every other planned note', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const initial = await inputWithAllSources();
		await service.apply(await service.preview(ROOT, initial));
		const changed = {
			...initial,
			capturedAt: '2026-08-25T08:02:00.000Z',
			positions: initial.positions.map((position) => ({
				...position, quantity: position.quantity + 1,
				// H18.1: an untouched position's free share is its whole stack, so it grows with it.
				freeQuantity: position.quantity + 1,
				totalSellCopper: null,
				sellDepthStatus: 'unavailable' as const,
				sellUncoveredQuantity: position.sellUncoveredQuantity + 1,
				totalListCopper: null,
			})),
		};
		const plan = await service.preview(ROOT, changed);
		const last = plan.steps.at(-1)!;
		const raced = `${vault.contents.get(last.path)!}\nraced\n`;
		vault.contents.set(last.path, raced);
		// The raced note keeps what was typed into it; the other four are rewritten.
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', updated: 4, conflicts: 1 });
		expect(vault.contents.get(last.path)).toBe(raced);
		for (const entry of plan.steps.slice(0, -1)) expect(vault.contents.get(entry.path)).toBe(entry.after);
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

	it('still refuses a note in that older format that claims a position its marker does not', async () => {
		const notePath = `${ROOT}/Inventory/Positions/${LEGACY_NOTE_POSITION_ID}.md`;
		const claiming = await resign(NOTE_WRITTEN_BY_0_1_11.replace('tc_position_id: 100063-c-', 'tc_position_id: 100064-c-'));
		const vault = new MemoryInventoryVault([[notePath, claiming]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const snapshot = snapshotWith([holding(LEGACY_NOTE_ITEM_ID, 1, characterBag(LEGACY_NOTE_CHARACTER))]);
		const input = await prepareInventoryVaultSyncInput(
			snapshot, legacyNoteCatalog(snapshot), pricesFor(snapshot, LEGACY_NOTE_ITEM_ID, 10), 'full', 'es');
		const plan = await service.preview(ROOT, input);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: notePath, status: 'conflict' }));
		const mutations = vault.mutations;
		expect(await service.apply(plan)).toMatchObject({ status: 'unchanged', conflicts: 1 });
		expect(vault.mutations).toBe(mutations);
		expect(vault.contents.get(notePath)).toBe(claiming);
	});

	/**
	 * H18.16: text a user appended to a note in that older format, or a property the user added to
	 * it, is the user's, not a corruption. At e693eba both blocked the whole sync; now the note is
	 * migrated and what the user wrote survives the rewrite.
	 */
	it.each([
		['text appended by hand', async (content: string) => `${content}\nnota mia\n`, (after: string) => after.endsWith('\nnota mia\n')],
		['a property of its own, re-signed', async (content: string) =>
			await resign(content.replace('descripcion:', 'tc_nota_mia: recordar\ndescripcion:')),
		(after: string) => frontmatter(after).tc_nota_mia === 'recordar'],
	])('migrates a note in that older format carrying %s and keeps it', async (_label, edit, kept) => {
		const notePath = `${ROOT}/Inventory/Positions/${LEGACY_NOTE_POSITION_ID}.md`;
		const vault = new MemoryInventoryVault([[notePath, await edit(NOTE_WRITTEN_BY_0_1_11)]]);
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const snapshot = snapshotWith([holding(LEGACY_NOTE_ITEM_ID, 1, characterBag(LEGACY_NOTE_CHARACTER))]);
		const input = await prepareInventoryVaultSyncInput(
			snapshot, legacyNoteCatalog(snapshot), pricesFor(snapshot, LEGACY_NOTE_ITEM_ID, 10), 'full', 'es');
		const plan = await service.preview(ROOT, input);
		expect(plan.steps).toEqual([expect.objectContaining({ path: notePath, status: 'update' })]);
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', updated: 1, conflicts: 0 });
		const after = vault.contents.get(notePath)!;
		expect(kept(after)).toBe(true);
		expect(frontmatter(after)).toMatchObject({ tc_unit_sell_copper: 10, tc_quantity: 1 });
		// Written once, it is stable: the next sync with the same data writes nothing.
		expect((await service.preview(ROOT, input)).steps.map((entry) => entry.status)).toEqual(['unchanged']);
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
		// Counted, not merely absent from a spot-check: a `conflict` here would leave this note
		// unwritten forever (before H18.16 it even stopped the whole sync; that was the landmine).
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

	it('a sync over a2584af frontmatter (no H18.2 price-date keys yet) produces zero conflict steps', async () => {
		const input = await oneBankInput();
		const created = (await new InventoryVaultSyncService(new MemoryInventoryVault(), CONFIG_DIR).preview(ROOT, input)).steps[0];
		if (!created || created.status !== 'create' || created.after === null) throw new Error('Expected a rendered create step.');
		const preH18 = await resign(created.after
			.replace(/^tc_price_quoted_at: .*\n/mu, '')
			.replace(/^tc_price_history_last_day: .*\n/mu, ''));
		expect(frontmatter(preH18)).not.toHaveProperty('tc_price_quoted_at');
		expect(frontmatter(preH18)).not.toHaveProperty('tc_price_history_last_day');
		const vault = new MemoryInventoryVault([[created.path, preH18]]);
		const plan = await new InventoryVaultSyncService(vault, CONFIG_DIR).preview(ROOT, input);
		expect(plan.steps.filter((step) => step.status === 'conflict')).toHaveLength(0);
		expect(plan.steps).toContainEqual(expect.objectContaining({ path: created.path, status: 'update' }));
	});

	it('writes today\'s quote date and the history\'s last day as their own note fields, and reads them back unchanged', async () => {
		const input = await oneBankInput();
		const dated = {
			...input,
			positions: input.positions.map((position) => ({
				...position, recommendation: 'hold' as const, recommendationReason: 'below_local_band' as const,
				recommendationUntil: '2026-08-25T08:15:01.000Z', pricePercentile: 40, priceCoverageDays: 61,
				priceQuotedAt: '2026-08-25T08:00:01.000Z', priceHistoryLastDay: '2026-06-26',
			})),
		};
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const created = (await service.preview(ROOT, dated)).steps[0];
		if (!created?.after) throw new Error('Expected a rendered create step.');
		expect(frontmatter(created.after)).toMatchObject({
			tc_recommendation_until: '2026-08-25T08:15:01.000Z',
			tc_price_quoted_at: '2026-08-25T08:00:01.000Z',
			tc_price_history_last_day: '2026-06-26',
		});
		await service.apply(await service.preview(ROOT, dated));
		const again = await service.preview(ROOT, dated);
		expect(again.steps.map((step) => step.status)).toEqual(dated.positions.map(() => 'unchanged'));
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

/**
 * H18.16 (audit 2026-09-24 §3.E, prueba 9): resync without a data change against resync with a new
 * price, with the user's own text and properties in the notes. At e693eba the price verdict's
 * `until` and the quote date (the capture instant) rewrote every note on every sync, and any byte
 * the user added to a note turned the whole sync into a conflict that wrote nothing.
 */
describe('resync: no rewrite by the clock, managed fields only, the user\'s text kept (H18.16)', () => {
	const T1 = '2026-08-25T08:00:01.000Z';
	const T2 = '2026-08-25T09:30:07.000Z';

	/** One bank note whose price verdict carries the capture instant, as every real sync does. */
	async function pricedAt(capturedAt: string, unitSellCopper = 10) {
		const input = await oneBankInput();
		const plus15 = new Date(Date.parse(capturedAt) + 900_000).toISOString();
		return {
			...input,
			capturedAt,
			positions: input.positions.map((position) => ({
				...position, unitSellCopper,
				recommendation: 'sell' as const, recommendationReason: 'bid_above_reference' as const,
				recommendationUntil: plus15, pricePercentile: 95, priceCoverageDays: 60,
				priceQuotedAt: capturedAt, priceHistoryLastDay: '2026-08-24', actionableQuantity: position.quantity,
			})),
		};
	}

	/** What a user does in Obsidian: a property of their own, and their own text after the note. */
	function editedByUser(content: string): string {
		return `${content.replace('\n---\n', '\ntags:\n  - gw2\n  - vender\n---\n')}\n## Mis notas\n\nVender en Halloween.\n`;
	}

	/** Every line of a note except the managed ones: the user's part, byte for byte. */
	function userLines(content: string): string[] {
		return content.split('\n').filter((line) => !/^(?:tc_[a-z_]+|descripcion):/u.test(line)
			&& !line.startsWith('<!-- tyrian-companion-inventory '));
	}

	it('a resync with the same data writes nothing, even when the capture clock moved', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await service.apply(await service.preview(ROOT, await pricedAt(T1)));
		const written = new Map(vault.contents);
		const mutations = vault.mutations;
		const plan = await service.preview(ROOT, await pricedAt(T2));
		expect(plan.steps.map((entry) => entry.status)).toEqual(['unchanged']);
		expect(await service.apply(plan)).toMatchObject({ status: 'unchanged', created: 0, updated: 0 });
		expect(vault.mutations).toBe(mutations);
		expect(vault.contents).toEqual(written);
	});

	it('a real date still counts: a wait whose suggested window moves is rewritten, its validity is not', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		// H18.19: the window is its own pair of fields; `until` is always the capture plus the price
		// age, so it never counts as a change on its own.
		const waiting = async (capturedAt: string, window: [string, string]) => {
			const input = await pricedAt(capturedAt);
			return { ...input, positions: input.positions.map((position) => ({
				...position, recommendation: 'sell_at_season' as const, recommendationReason: 'wait_advantage_demonstrated' as const,
				recommendationUntil: new Date(Date.parse(capturedAt) + 900_000).toISOString(), actionableQuantity: 0,
				sellWindowFromDay: window[0], sellWindowToDay: window[1],
			})) };
		};
		await service.apply(await service.preview(ROOT, await waiting(T1, ['2026-09-25', '2026-10-12'])));
		expect((await service.preview(ROOT, await waiting(T2, ['2026-09-25', '2026-10-12']))).steps.map((entry) => entry.status))
			.toEqual(['unchanged']);
		expect((await service.preview(ROOT, await waiting(T2, ['2027-05-01', '2027-05-31']))).steps.map((entry) => entry.status))
			.toEqual(['update']);
	});

	it('H18.19: the note carries the three clocks apart and the sell-now-or-wait comparison; a moved comparison rewrites it', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const comparison = {
			version: 1 as const, verdict: 'wait' as const, mode: 'instant' as const, strategy: 'wait_pre_festival' as const,
			quantity: 3, unitCopper: 10, decisionOffsetDays: 19, windowFromDay: '2026-09-25', windowToDay: '2026-10-12',
			seasons: 7, seasonsWon: 4, seasonsLost: 3, medianRatio: 1.03, lowRatio: 0.97, highRatio: 1.09,
			netAdvantageCopper: 1, netAdvantageLowCopper: -1, netAdvantageHighCopper: 2,
		};
		const waiting = async (capturedAt: string, sellOrWait: typeof comparison) => {
			const input = await pricedAt(capturedAt);
			return { ...input, positions: input.positions.map((position) => ({
				...position, recommendation: 'sell_at_season' as const, recommendationReason: 'wait_advantage_demonstrated' as const,
				actionableQuantity: 0, sellWindowFromDay: sellOrWait.windowFromDay, sellWindowToDay: sellOrWait.windowToDay, sellOrWait,
			})) };
		};
		await service.apply(await service.preview(ROOT, await waiting(T1, comparison)));
		const [path] = vault.markdownFiles().map((file) => file.path);
		expect(frontmatter(vault.contents.get(path!)!)).toMatchObject({
			tc_price_quoted_at: T1,
			tc_recommendation_until: new Date(Date.parse(T1) + 900_000).toISOString(),
			tc_sell_window_from: '2026-09-25', tc_sell_window_to: '2026-10-12',
			tc_wait_verdict: 'wait', tc_wait_mode: 'instant', tc_wait_strategy: 'wait_pre_festival',
			tc_wait_advantage_copper: 1, tc_wait_advantage_low_copper: -1, tc_wait_advantage_high_copper: 2,
			tc_wait_seasons: 7, tc_wait_seasons_lost: 3,
		});
		// The note it wrote reads back as its own: same data later is not a change.
		expect((await service.preview(ROOT, await waiting(T2, comparison))).steps.map((entry) => entry.status)).toEqual(['unchanged']);
		// A comparison that moved (another free quantity, another advantage) is.
		expect((await service.preview(ROOT, await waiting(T2, { ...comparison, quantity: 2, netAdvantageCopper: 0 })))
			.steps.map((entry) => entry.status)).toEqual(['update']);
	});

	it('a new price rewrites only the managed fields and keeps the user\'s properties and text', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		await service.apply(await service.preview(ROOT, await pricedAt(T1)));
		const [path] = vault.markdownFiles().map((file) => file.path);
		vault.contents.set(path!, editedByUser(vault.contents.get(path!)!));
		const before = vault.contents.get(path!)!;
		const plan = await service.preview(ROOT, await pricedAt(T2, 12));
		expect(plan.canApply).toBe(true);
		expect(plan.steps).toEqual([expect.objectContaining({ path, status: 'update' })]);
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', updated: 1, conflicts: 0 });
		const after = vault.contents.get(path!)!;
		expect(frontmatter(after)).toMatchObject({ tc_unit_sell_copper: 12, tags: ['gw2', 'vender'], tc_price_quoted_at: T2 });
		expect(after.endsWith('\n## Mis notas\n\nVender en Halloween.\n')).toBe(true);
		// Only managed lines differ; everything the user wrote is byte for byte where it was.
		expect(userLines(after)).toEqual(userLines(before));
		// And the next sync with that same price writes nothing again.
		expect((await service.preview(ROOT, await pricedAt(T2, 12))).steps.map((entry) => entry.status)).toEqual(['unchanged']);
	});

	it('a note the user edited outside its managed parts, with the same data, is not rewritten and blocks nothing', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const input = await inputWithAllSources();
		await service.apply(await service.preview(ROOT, input));
		const [edited, ...others] = vault.markdownFiles().map((file) => file.path);
		// Obsidian's property editor writes a null as an empty value: the same data, other bytes.
		vault.contents.set(edited!, editedByUser(vault.contents.get(edited!)!).replace('tc_icon: null', 'tc_icon:'));
		const mutations = vault.mutations;
		const same = await service.preview(ROOT, input);
		expect(same.steps.every((entry) => entry.status === 'unchanged')).toBe(true);
		expect(await service.apply(same)).toMatchObject({ status: 'unchanged' });
		expect(vault.mutations).toBe(mutations);
		// A change on the other notes still lands; the edited note keeps its text.
		const moved = { ...input, positions: input.positions.map((position) => ({ ...position, unitSellCopper: 11 })) };
		const plan = await service.preview(ROOT, moved);
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', updated: 5, conflicts: 0 });
		expect(vault.contents.get(edited!)!.endsWith('Vender en Halloween.\n')).toBe(true);
		for (const path of others) expect(frontmatter(vault.contents.get(path)!).tc_unit_sell_copper).toBe(11);
	});

	it('keeps a note the user wrote in, inactive, when its position leaves the account, instead of trashing it', async () => {
		const vault = new MemoryInventoryVault();
		const service = new InventoryVaultSyncService(vault, CONFIG_DIR);
		const current = await inputWithAllSources();
		await service.apply(await service.preview(ROOT, current));
		const bankPath = (await service.preview(ROOT, current)).steps.find((entry) => entry.positionId.includes('-b-'))!.path;
		vault.contents.set(bankPath, editedByUser(vault.contents.get(bankPath)!));
		const reduced = { ...current, positions: current.positions.filter((position) => position.source !== 'bank') };
		const plan = await service.preview(ROOT, reduced);
		const step = plan.steps.find((entry) => entry.path === bankPath);
		expect(step).toMatchObject({ status: 'deactivate' });
		expect(step?.after).not.toBeNull();
		expect(await service.apply(plan)).toMatchObject({ status: 'applied', deactivated: 1 });
		const after = vault.contents.get(bankPath)!;
		expect(frontmatter(after)).toMatchObject({ tc_active: false, tc_quantity: 0, tc_free_quantity: 0, tags: ['gw2', 'vender'] });
		expect(after.endsWith('Vender en Halloween.\n')).toBe(true);
		// Already inactive: the next sync neither rewrites it nor asks to deactivate it again.
		expect((await service.preview(ROOT, reduced)).steps.find((entry) => entry.path === bankPath)).toMatchObject({ status: 'unchanged' });
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

/**
 * Re-signs an edited note so it fails validation on its fields, not on a stale hash. A note with the
 * H18.16 end marker signs its managed block only; an older one signed the whole note.
 */
async function resign(content: string): Promise<string> {
	const endAt = content.indexOf(`\n${END_MARKER}`);
	if (endAt >= 0) {
		const blockAt = content.indexOf(' -->\n', content.indexOf('<!-- tyrian-companion-inventory ')) + ' -->\n'.length;
		const block = content.slice(blockAt, endAt + 1);
		return content.replace(/ hash=[a-f0-9]{64} -->/u, ` hash=${await sha256Text(block)} -->`);
	}
	const unsigned = content.replace(/ hash=[a-f0-9]{64} -->/u, ' -->');
	return unsigned.replace(' -->', ` hash=${await sha256Text(unsigned)} -->`);
}

const END_MARKER = '<!-- /tyrian-companion-inventory -->';

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
