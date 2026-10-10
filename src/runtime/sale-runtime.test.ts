import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaleRuntime, type SaleRuntimePort } from './sale-runtime';
import { resolveSaleSeasonalInputFor } from './core-sale-helpers';
import { createTranslator } from '../core/i18n';
import type { HttpRequest, HttpResponse, HttpTransport } from '../core/http';
import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { LocalDebugRecordInput } from '../core/local-debug-contract';
import type { LocalDebugLogger } from '../core/local-debug-logger';
import { runSerialTaskUnqueued, SerialTaskQueue } from '../core/serial-task-queue';
import { DEFAULT_SETTINGS, type CollectorMode } from '../core/settings';
import { inventoryAdvisorBuiltinBundleProvider, INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL } from '../advisor/inventory-advisor-builtin-bundle';
import { recommendPosition } from '../advisor/inventory-position-recommendation';
import { festivalCalendarEntryForItem } from '../economy/seasonal-window';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import {
	PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN,
	PriceSeedBulkRefreshService,
} from '../economy/price-seed-bulk-refresh';
import type { PriceSeedDayV1, PriceSeedResult, PriceSeedV1 } from '../economy/price-seed-model';
import { PriceHistoryPanelSeedService } from '../economy/price-seed-panel-service';
import { fetchPriceSeed } from '../economy/price-seed-source';
import { indexedDbPriceHistoryPort } from '../host/indexed-db-price-history';
import { POSITION_RECOMMENDATION_REQUIRED_DAYS } from '../inventory/inventory-analysis';
import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from '../ui/inventory-advisor-view-model';
import { buildSaleViewModel, type SaleViewModel } from '../ui/sale-view-model';
import { renderSaleView } from '../ui/sale-view';
import { sellTimingHistoryBagDays } from '../test/fixtures/economy/sell-timing-history-36038';
import { datawars2RealHistorySacoDays } from '../test/fixtures/economy/datawars2-real-history-36038-2026-09-26';
import { datawars2RealHistoryTrozoDays } from '../test/fixtures/economy/datawars2-real-history-36041-2026-09-26';
import { datawars2RealHistoryBarraDays } from '../test/fixtures/economy/datawars2-real-history-47909-2026-09-26';
import { datawars2RealHistoryJorcameloDays } from '../test/fixtures/economy/datawars2-real-history-43320-2026-09-26';
import { datawars2RealHistoryColmillosAltaCalidadDays } from '../test/fixtures/economy/datawars2-real-history-48805-2026-09-26';

/**
 * DE-01, step 2: `SaleRuntime` on its own, over a port the test writes. These tests used to drive
 * the same code as private methods of `TyrianCompanionCore` on a plain object cast to the core
 * (`main-sale-hero-timing.test.ts`, `main-sell-signal-wiring.test.ts`, `main-sale-refresh.test.ts`,
 * `main-price-seed-two-in-flight.test.ts`, `main-price-seed-phases.test.ts`); they keep their titles
 * and their assertions. Each port is checked against `SaleRuntimePort` with `satisfies`, so a member
 * the runtime starts to read and the test does not provide is a type error, not a silent `undefined`.
 *
 * Where a test needs what the core does around the runtime (its advisor refresh, a sync action, the
 * Settings opt-in, the unload), the port or the test does those same steps, and
 * `main-sale-runtime-wiring.test.ts` proves over the real core that it does take them.
 * The runtime's own state is read with `sale['field']`, never through a cast.
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** The host's `setIcon`, recording the Lucide id on the element as the Obsidian test double does. */
const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };

const SEPT_26_MS = Date.UTC(2026, 8, 26, 7, 35, 0);
const OCT_14_MS = Date.UTC(2026, 9, 14, 19, 10, 0);

/** `SaleRuntimePort` with fields a test can change while the runtime reads them, as the core's getters do. */
type WritableSaleRuntimePort = { -readonly [K in Exclude<keyof SaleRuntimePort, 'settings'>]: SaleRuntimePort[K] } & {
	settings: { -readonly [K in keyof SaleRuntimePort['settings']]: SaleRuntimePort['settings'][K] };
};

/** What every port below starts from: no service built, nothing on screen, a collector with history on. */
function idlePort(): WritableSaleRuntimePort {
	return {
		settings: { ...DEFAULT_SETTINGS, priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000 },
		runtimeReady: true,
		unloaded: false,
		collectorMode: 'collector',
		vaultId: null,
		localDebugActions: null,
		host: { priceHistory: { openSeedCache: async () => { throw new Error('This test opens no seed cache.'); } } },
		inventoryAdvisor: { analysis: () => null },
		priceHistory: null,
		priceSeedBulkRefresh: null,
		sellSignal: null,
		notifyConsultMode: () => undefined,
		getInventoryAdvisorViewModel: () => ({ status: 'loading', title: 'x', detail: 'y', groups: [] }),
		renderInventoryAdvisorViews: () => undefined,
		refreshInventoryAdvisor: async () => undefined,
	} satisfies SaleRuntimePort;
}

function heroRow(ownedQuantity: number): InventoryAdvisorViewRow {
	return {
		id: '#/sale/hero/36038', itemId: 36038, name: 'Saco de Halloween', icon: null,
		ownedQuantity, availableQuantity: ownedQuantity, action: 'open', quantity: ownedQuantity,
		allocations: [{ positionRef: '#/positions/36038/0', quantity: ownedQuantity, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } }],
		reasonCodes: [], protectionReasons: [], value: { status: 'not_applicable', route: null },
		marketComparison: null, burden: null,
		coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
		irreversibleReviewOnly: false, discardProof: null,
	};
}

function advisorModel(ownedQuantity: number): InventoryAdvisorViewModel {
	return { status: 'ready', title: 'x', detail: 'y', groups: [{ key: 'curated', rows: [heroRow(ownedQuantity)] }] };
}

function heroFixtureDaily(): PriceHistoryDailyV1[] {
	return sellTimingHistoryBagDays().map((day) => ({
		version: 1, vaultId: 'test-vault', itemId: 36038, dayUtc: day.dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
		bid: {
			count: 1, minCopper: day.bidCopper, maxCopper: day.bidCopper,
			medianCopperX2: day.bidCopper * 2, closeCopper: day.bidCopper, closeCapturedAtMs: 0,
		},
		ask: null,
	}));
}

/**
 * Round 3 (coordinator, 26 sep 2026): every earlier round scaled OTHER items' history off the
 * 36038 backtest's own shape — a real pattern, but not THAT item's real prices. Downloaded ONCE,
 * directly, from the SAME public datawars2 endpoint `fetchPriceSeed` uses
 * (`datawars2-real-history-<item>-2026-09-26.ts`, each with the SHA-256 of its complete response),
 * for exactly the 5 items this dump shows.
 *
 * Kept in FULL, not trimmed to 400 days: `sellOrWaitSeedMaxDays` (`economy/sell-or-wait.ts`) already
 * makes a real sync request `PRICE_SEED_CHART_MAX_DAYS` (the whole published history) for any item
 * with a `festivalCalendarEntryForItem` — all 5 of these qualify — never the 400-day
 * `PRICE_SEED_MAX_DAYS` default. A 400-day fixture (this file's own round-2 attempt) silently
 * starved `compareSellNowWithWaiting` of `SELL_TIMING_TRAIN_YEARS` (2014-2018) and most of
 * `SELL_TIMING_TEST_YEARS` (2019-2025), so it could never leave `insufficient_data` — a fixture
 * artifact, not what a real sync actually stores for these items. Whatever `recommendPosition` says
 * against the full series is the real answer — not adjusted to match what a note or a window
 * "should" say.
 */
const REAL_HISTORY_BY_ITEM_ID: ReadonlyMap<number, () => readonly { dayUtc: string; bidCopper: number }[]> = new Map([
	[36_038, datawars2RealHistorySacoDays],
	[36_041, datawars2RealHistoryTrozoDays],
	[47_909, datawars2RealHistoryBarraDays],
	[43_320, datawars2RealHistoryJorcameloDays],
	[48_805, datawars2RealHistoryColmillosAltaCalidadDays],
]);

function realDailyHistory(itemId: number): PriceHistoryDailyV1[] {
	const days = REAL_HISTORY_BY_ITEM_ID.get(itemId);
	if (days === undefined) throw new Error(`No real datawars2 fixture for item ${String(itemId)}.`);
	return days().map((day) => ({
		version: 1, vaultId: 'test-vault', itemId, dayUtc: day.dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
		bid: { count: 1, minCopper: day.bidCopper, maxCopper: day.bidCopper, medianCopperX2: day.bidCopper * 2, closeCopper: day.bidCopper, closeCapturedAtMs: 0 },
		ask: null,
	}));
}

/**
 * Review fix (26 sep 2026): the Saco de Halloween's hero card verdict comes from
 * `recommendPosition`, the SAME rule every other Sale row uses, instead of the simpler
 * account-level sell signal. Every assertion runs the real `computeSaleHeroTiming`/
 * `buildSaleHeroInput` and the real, curated 7-edition backtest fixture
 * (`sell-timing-history-36038.ts`), then renders the real DOM (`buildSaleViewModel` + `renderSaleView`).
 */
describe('the Saco hero card verdict: real recommendPosition, real curated backtest, real DOM', () => {
	it('says "Vender ahora" on 26 sep, inside the sale window, with today\'s bid below the 90% threshold', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(SEPT_26_MS);
		const port = {
			...idlePort(),
			getInventoryAdvisorViewModel: () => advisorModel(2350),
			inventoryAdvisor: { analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 342 } }] } } } }) },
			priceHistory: { readDaily: async () => heroFixtureDaily() },
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(port);
		await sale['computeSaleHeroTiming']();

		expect(sale['saleHeroTiming']).toMatchObject({ action: 'sell', reason: 'no_demonstrated_wait_advantage' });

		const hero = sale['buildSaleHeroInput'](heroRow(2350), 342);
		expect(hero).toMatchObject({ decision: { action: 'sell', reason: 'no_demonstrated_wait_advantage' } });

		const model = buildSaleViewModel({
			status: 'ready', nowMs: SEPT_26_MS, festivalStartMs: Date.UTC(2026, 9, 13), maxPriceAgeMs: 900_000,
			hero, rows: [], calendar: [],
		});
		expect(model.hero?.action).toBe('sell');

		vi.stubGlobal('createEl', (tag: string, options?: { text?: string; cls?: string }) => makeEl(tag, options));
		vi.stubGlobal('createDiv', (options?: { text?: string; cls?: string }) => makeEl('div', options));
		vi.stubGlobal('createSpan', (options?: { text?: string; cls?: string }) => makeEl('span', options));
		const container = makeEl('div');
		renderSaleView(container as unknown as HTMLElement, icons, model, createTranslator('es'));
		expect(textOf(container)).toContain('Vender ahora');
	});

	it('Z8: a bid kept from an older analysis is dated by its own capture, never by the failed refresh that recomputed the verdict', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(SEPT_26_MS);
		const capturedAt = new Date(SEPT_26_MS - 4 * 3_600_000).toISOString();
		const port = {
			...idlePort(),
			getInventoryAdvisorViewModel: () => advisorModel(2350),
			inventoryAdvisor: { analysis: () => ({ source: { input: { prices: { capturedAt, items: [{ itemId: 36038, bid: { unitCopper: 342 } }] } } } }) },
			priceHistory: { readDaily: async () => heroFixtureDaily() },
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(port);
		await sale['computeSaleHeroTiming']();

		expect(sale['saleHeroTiming']?.priceQuotedAt).toBe(capturedAt);
		expect(Date.parse(sale['saleHeroTiming']?.until ?? '')).toBeLessThan(SEPT_26_MS);
	});

	it('H18.33 (26 sep 2026): says "Todavía no", never "Vender ahora", once the festival has started and the bid sits at its floor', async () => {
		// David's report: at the festival floor (roughly 0.80x the 26 sep bid, per datawars2 2020-2025),
		// the hero card sold "en el suelo" because `compareSellNowWithWaiting` aborted to
		// `insufficient_data` the moment today rolled past the last catalogued festival start
		// (`HALLOWEEN_FESTIVAL_STARTS` has no 2027 entry yet). `referenceFestivalFor` (H18.33) keeps
		// the 2026 edition as the reference with a negative offset instead, so the real per-year data
		// this SAME curated fixture already carries (now extended with each year's own day-into-the-
		// festival price) demonstrates the advantage of waiting to next May. `sell_at_season` displays
		// as "Todavía no" (`sale-view-model.ts`'s own `not_yet` mapping, ficha decision 2 — unrelated
		// to this fix and unchanged by it), not "Esperar", which is `hold`'s own word for a wait with
		// no specific evidence-backed window.
		vi.useFakeTimers();
		vi.setSystemTime(OCT_14_MS);
		const floorBidCopper = Math.round(342 * 0.80);
		const port = {
			...idlePort(),
			getInventoryAdvisorViewModel: () => advisorModel(2350),
			inventoryAdvisor: { analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: floorBidCopper } }] } } } }) },
			priceHistory: { readDaily: async () => heroFixtureDaily() },
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(port);
		await sale['computeSaleHeroTiming']();

		expect(sale['saleHeroTiming']).toMatchObject({
			action: 'sell_at_season', reason: 'wait_advantage_demonstrated',
			sellWindowFromDay: '2027-05-01', sellWindowToDay: '2027-05-31',
		});

		const hero = sale['buildSaleHeroInput'](heroRow(2350), floorBidCopper);
		expect(hero).toMatchObject({ decision: { action: 'sell_at_season', reason: 'wait_advantage_demonstrated' } });

		const model = buildSaleViewModel({
			status: 'ready', nowMs: OCT_14_MS, festivalStartMs: Date.UTC(2026, 9, 13), maxPriceAgeMs: 900_000,
			hero, rows: [], calendar: [],
		});
		expect(model.hero?.action).toBe('not_yet');

		vi.stubGlobal('createEl', (tag: string, options?: { text?: string; cls?: string }) => makeEl(tag, options));
		vi.stubGlobal('createDiv', (options?: { text?: string; cls?: string }) => makeEl('div', options));
		vi.stubGlobal('createSpan', (options?: { text?: string; cls?: string }) => makeEl('span', options));
		const container = makeEl('div');
		renderSaleView(container as unknown as HTMLElement, icons, model, createTranslator('es'));
		const text = textOf(container);
		expect(text).toContain('Todavía no');
		expect(text).not.toContain('Vender ahora');
	});

	it('never fabricates a verdict for 0 owned units: the position is not a legendary reservation', async () => {
		const port = {
			...idlePort(),
			getInventoryAdvisorViewModel: () => advisorModel(0),
			priceHistory: { readDaily: async () => [] },
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(port);
		// A verdict already in place, so "null" below is the computation's own answer, not the initial one.
		sale['saleHeroTiming'] = recommendPosition({
			capturedAtMs: SEPT_26_MS, priceHistoryEnabled: true, totalSellCopper: null, capitalThresholdCopper: 100_000,
			maxPriceAgeMs: 900_000, priceHistoryDaily: [], priceHistoryWindowDays: 400,
			priceHistoryRequiredDays: POSITION_RECOMMENDATION_REQUIRED_DAYS, seasonal: null, legendaryShortfall: null,
			freeQuantity: 1, todayBidCopper: null, untradeable: false,
		});
		await sale['computeSaleHeroTiming']();
		expect(sale['saleHeroTiming']).toBeNull();
	});

	/**
	 * H18.34: `getSaleViewModel` recomputes `bundleLoad` fresh against `Date.now()` on every call, but
	 * `advisorModel.status` is whatever the LAST advisor refresh cached — it can still read `ready`
	 * well after the curated bundle's `validUntil`, because nothing forces a refresh the instant the
	 * clock crosses it. Before this fix, that left the Sale tab silently degrading to "Sin datos"
	 * (`resolveSaleSeasonalInputFor` returning null) with no explanation, unlike the Halloween price
	 * alert's own `out_of_season`, which always carries a dedicated, explained state. These run the
	 * real `getSaleViewModel` (not a hand-built `SaleViewModel`), then the real DOM (`renderSaleView`).
	 */
	describe('getSaleViewModel: an expired curated bundle is explained, never a silent "sin datos" (H18.34)', () => {
		const AFTER_VALID_UNTIL_MS = Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) + 1;

		function renderModel(model: SaleViewModel): string {
			vi.stubGlobal('createEl', (tag: string, options?: { text?: string; cls?: string }) => makeEl(tag, options));
			vi.stubGlobal('createDiv', (options?: { text?: string; cls?: string }) => makeEl('div', options));
			vi.stubGlobal('createSpan', (options?: { text?: string; cls?: string }) => makeEl('span', options));
			const container = makeEl('div');
			renderSaleView(container as unknown as HTMLElement, icons, model, createTranslator('es'));
			return textOf(container);
		}

		it('shows the explained expiry, in the view-model AND the DOM, even while the cached advisor model still reads "ready"', () => {
			vi.useFakeTimers();
			vi.setSystemTime(AFTER_VALID_UNTIL_MS);
			const port = {
				...idlePort(),
				// Deliberately stale: a real plugin would not necessarily have refreshed since validUntil
				// passed, and this is exactly the state that used to hide the caducity.
				getInventoryAdvisorViewModel: () => advisorModel(2350),
			} satisfies SaleRuntimePort;
			const model = new SaleRuntime(port).getSaleViewModel();

			expect(model.status).toBe('blocked');
			expect(model.rulesExpiredAtMs).toBe(Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL));
			expect(model.hero).toBeNull();

			const text = renderModel(model);
			expect(text).toContain('caducaron el');
			expect(text).not.toContain('Sin datos');
			expect(text).not.toContain('no está disponible ahora mismo');
		});

		it('does not override a merely stale-cache "ready" before validUntil is actually reached', () => {
			vi.useFakeTimers();
			vi.setSystemTime(Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) - 1);
			const port = { ...idlePort(), getInventoryAdvisorViewModel: () => advisorModel(0) } satisfies SaleRuntimePort;
			const model = new SaleRuntime(port).getSaleViewModel();

			expect(model.rulesExpiredAtMs).toBeNull();
			expect(model.status).toBe('ready');
		});

		function deepFreeze<T>(value: T): T {
			if (typeof value === 'object' && value !== null) {
				for (const child of Object.values(value)) deepFreeze(child);
				Object.freeze(value);
			}
			return value;
		}

		/**
		 * Z16-a: a Sale paint only READS the advisor's analysis, so it asks for the shared object
		 * (`readOnly: true`, no copy) and never for a detached one. The analysis handed over is deeply
		 * frozen: a paint that wrote to it would throw (modules are strict) and the snapshot below
		 * would differ. Sabotage: asking `analysis()` without `readOnly` in `getSaleViewModel` makes
		 * the first expectation fail.
		 */
		it('Z16-a: paints from the advisor analysis without copying it and without writing to it', () => {
			vi.useFakeTimers();
			vi.setSystemTime(Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) - 1);
			const frozen = deepFreeze({
				source: { input: { prices: {
					capturedAt: new Date(Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) - 60_000).toISOString(),
					items: [{ itemId: 36038, bid: { unitCopper: 342 }, ask: { unitCopper: 400 } }],
				} } },
				objects: null,
			});
			const before = JSON.stringify(frozen);
			const reads: Array<{ readOnly?: boolean } | undefined> = [];
			const port = {
				...idlePort(),
				getInventoryAdvisorViewModel: () => advisorModel(2350),
				inventoryAdvisor: { analysis: (options?: { readOnly?: boolean }) => { reads.push(options); return frozen; } },
			} satisfies SaleRuntimePort;
			const sale = new SaleRuntime(port);
			const model = sale.getSaleViewModel();
			renderModel(model);
			sale.getSaleViewModel();

			expect(reads.length).toBeGreaterThan(0);
			expect(reads.every((options) => options?.readOnly === true)).toBe(true);
			expect(JSON.stringify(frozen)).toBe(before);
		});

		/**
		 * Sabotage: reverting the caducity check to trust only the cached `advisorModel.status` (the
		 * pre-fix behaviour) makes this fail on `expect(model.status).toBe('blocked')` — it stays
		 * `'ready'`, and the DOM assertion above fails on `expect(text).toContain('caducaron el')`
		 * because `renderSaleView` never reaches `renderBlocked` at all.
		 */
	});

	/**
	 * R1b (Hebra's report, 28 sep 2026): `refreshInventoryAdvisor`/`refreshSale` both refuse in
	 * consult (`refusedInConsult`), so a consult device that captured nothing this session left
	 * `advisorModel.status` stuck at `loading` forever — Venta showed "Leyendo precios del
	 * bazar…" with nothing ever going to move it (8 s and counting, per the report). These run the
	 * real `getSaleViewModel`, then the real DOM (`renderSaleView`).
	 */
	describe('getSaleViewModel: a consult device with nothing captured reaches a final state, never stuck "loading" (R1b)', () => {
		function renderModel(model: SaleViewModel): string {
			vi.stubGlobal('createEl', (tag: string, options?: { text?: string; cls?: string }) => makeEl(tag, options));
			vi.stubGlobal('createDiv', (options?: { text?: string; cls?: string }) => makeEl('div', options));
			vi.stubGlobal('createSpan', (options?: { text?: string; cls?: string }) => makeEl('span', options));
			const container = makeEl('div');
			renderSaleView(container as unknown as HTMLElement, icons, model, createTranslator('es'));
			return textOf(container);
		}

		/** Never refreshed this session: exactly what `InventoryAdvisorPresentationController` starts as. */
		const loadingAdvisorModel: InventoryAdvisorViewModel = { status: 'loading', title: 'x', detail: 'y', groups: [] };

		it('consult, nothing captured: reaches a final state (never "loading"), names consult mode, and renders no refresh button', () => {
			const port = {
				...idlePort(),
				collectorMode: 'consult' as const,
				getInventoryAdvisorViewModel: () => loadingAdvisorModel,
			} satisfies SaleRuntimePort;
			const model = new SaleRuntime(port).getSaleViewModel();

			expect(model.status).not.toBe('loading');
			expect(model.consultOnly).toBe(true);
			expect(model.hero).toBeNull();

			const text = renderModel(model);
			expect(text).toContain('modo consulta');
			expect(text).not.toContain('Leyendo precios del bazar');
		});

		/** The collector path must not change at all: still the ordinary "Leyendo…" until its own refresh completes. */
		it('collector, nothing captured yet: keeps the ordinary "loading" state untouched', () => {
			const port = {
				...idlePort(),
				collectorMode: 'collector' as const,
				getInventoryAdvisorViewModel: () => loadingAdvisorModel,
			} satisfies SaleRuntimePort;
			const model = new SaleRuntime(port).getSaleViewModel();

			expect(model.status).toBe('loading');
			expect(model.consultOnly).toBeUndefined();
			expect(renderModel(model)).toContain('Leyendo precios del bazar');
		});
	});
});

/**
 * Acceptance test (task D, review 26 sep 2026): the real `getSaleViewModel` + `computeSaleHeroTiming`
 * + `buildSaleViewModel` + `renderSaleView` pipeline, fed David's REAL Halloween inventory —
 * quantities, bids and recommendations read from his own notes in
 * `42.31 Datos de cuenta de Guild Wars 2/Inventory/Positions/` (read-only; no account id, no
 * character name — "Personaje 1" stands in for "Rinopopo"). The curated festival calendar comes
 * from the REAL `inventoryAdvisorBuiltinBundleProvider`, never a hand-built one. The hero's own
 * timing runs the REAL `recommendPosition` against the curated 2019-2025 backtest fixture
 * (`sell-timing-history-36038`), simulating the state Fix A (`inventory-analysis.ts`) now reaches
 * once a real sync seeds it — this file only proves the RENDER is coherent once history exists,
 * `inventory-analysis.test.ts` proves the seeding wiring that gets it there.
 *
 * Allocations below group recorded holdings by storage; they are technical test scaffolding,
 * not evidence of physical occupied slots or order-book depth. Visual QA must use null for
 * unavailable counts/timestamps and the note's recorded net, never infer either from this scaffold.
 * The optional JSON dump is a controlled presentation input, not a live account snapshot.
 */
describe('acceptance: the real Venta pipeline renders David\'s real Halloween inventory without contradictions', () => {
	interface RealPosition { quantity: number; location: InventoryAdvisorViewRow['allocations'][number]['location'] }

	/**
	 * Coordinator round 2, point 7: David's real Trozo de caramelo (#36041) is split across THREE
	 * positions (bank, materials, one character) that all share the SAME decision — the dump only
	 * modeled one of them (720 of 4953) and showed an impossible "720 · 1 hueco" (bank stacks cap at
	 * 250). `inventory-analysis.test.ts`'s own "sums into ONE row" test proves the REAL advisor
	 * pipeline already aggregates every position of an item into one row when they share a decision;
	 * this fixture now lists every real position instead of only the first one read.
	 */
	function realRow(fields: {
		itemId: number; name: string; positions: readonly RealPosition[];
		decision: NonNullable<InventoryAdvisorViewRow['decision']> | null;
	}): InventoryAdvisorViewRow {
		const decision = fields.decision;
		const ownedQuantity = fields.positions.reduce((sum, position) => sum + position.quantity, 0);
		return {
			id: `#/sale/row/${String(fields.itemId)}`, itemId: fields.itemId, name: fields.name, icon: null,
			ownedQuantity, availableQuantity: ownedQuantity,
			action: decision === null ? 'review' : (decision.action === 'hold' ? 'keep' : decision.action === 'sell' || decision.action === 'sell_at_season' ? 'sell' : 'review'),
			quantity: ownedQuantity,
			allocations: fields.positions.map((position, index) => ({
				positionRef: `#/positions/${String(fields.itemId)}/${String(index)}`, quantity: position.quantity, location: position.location,
			})),
			decision: decision ?? undefined,
			reasonCodes: [], protectionReasons: [], value: { status: 'not_applicable', route: null },
			// Real note: none of these positions had a `marketComparison` from the advisor's own route
			// classification (review fix's whole point — `saleSourceRowFromAdvisorRow` no longer needs one).
			marketComparison: null, burden: null,
			coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
			irreversibleReviewOnly: false, discardProof: null,
		};
	}

	/**
	 * Round 3 (coordinator, 26 sep 2026): no more hand-copied decisions from notes written BEFORE
	 * this review's fixes, and no more synthetic history — every row (hero included, via
	 * `computeSaleHeroTiming` below) runs the SAME real `recommendPosition`, fed the real calendar
	 * (`resolveSaleSeasonalInputFor`) and the REAL datawars2 history downloaded for this exact item
	 * (`realDailyHistory`). Whatever verdict comes out is reported as-is, never adjusted to match a
	 * note or a window's own dates.
	 */
	function computeRealDecision(
		itemId: number, todayBidCopper: number | null, ownedQuantity: number, nowMs: number,
	): NonNullable<InventoryAdvisorViewRow['decision']> | null {
		if (ownedQuantity <= 0) return null;
		const seasonal = resolveSaleSeasonalInputFor(itemId, nowMs);
		const result = recommendPosition({
			capturedAtMs: nowMs, priceHistoryEnabled: true,
			totalSellCopper: todayBidCopper === null ? null : todayBidCopper * ownedQuantity,
			capitalThresholdCopper: 100_000, maxPriceAgeMs: 900_000,
			priceHistoryDaily: todayBidCopper === null ? [] : realDailyHistory(itemId),
			priceHistoryWindowDays: 400, priceHistoryRequiredDays: POSITION_RECOMMENDATION_REQUIRED_DAYS,
			seasonal, legendaryShortfall: null, freeQuantity: ownedQuantity, todayBidCopper, untradeable: false,
		});
		return {
			action: result.action, reason: result.reason, until: result.until, missing: result.missing,
			pricePercentile: result.pricePercentile, priceCoverageDays: result.priceCoverageDays,
			priceQuotedAt: result.priceQuotedAt, priceHistoryLastDay: result.priceHistoryLastDay,
			sellWindowFromDay: result.sellWindowFromDay, sellWindowToDay: result.sellWindowToDay, sellOrWait: result.sellOrWait,
		} satisfies NonNullable<InventoryAdvisorViewRow['decision']>;
	}

	it('shows a coherent hero, coherent rows and a marked calendar for the real Halloween positions', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(SEPT_26_MS);

		// Real quantities and bids, `tyrian-companion/…/Inventory/Positions/*.md` (26 sep 2026 read).
		// Character name replaced with "Personaje 1" throughout (David's real note: "Rinopopo").
		const CANDY_BAR_QUANTITY = 71;
		const JORCAMELO_QUANTITY = 31;
		const FANGS_PREMIUM_QUANTITY = 20;
		const PLAIN_FANGS_QUANTITY = 698;
		// Three real positions summing to 4953, not just the bank stack (720).
		const CANDY_PIECE_QUANTITY = 720 + 1250 + 2983;
		const CANDY_BAR_BID = 41_539;
		const JORCAMELO_BID = 44_498;
		const FANGS_PREMIUM_BID = 3_419;
		const CANDY_PIECE_BID = 72;

		const HERO_ROW = realRow({
			itemId: 36038, name: 'Saco de Halloween',
			positions: [{ quantity: 1, location: { source: 'character', character: 'Personaje 1', container: 'bag', bagIndex: 0, slot: 0 } }],
			decision: null, // the hero's OWN timing comes from `computeSaleHeroTiming`, not this field.
		});
		const CANDY_BAR = realRow({
			itemId: 47909, name: 'Barra de caramelo',
			positions: [{ quantity: CANDY_BAR_QUANTITY, location: { source: 'materials', category: 7 } }],
			decision: computeRealDecision(47909, CANDY_BAR_BID, CANDY_BAR_QUANTITY, SEPT_26_MS),
		});
		const JORCAMELO = realRow({
			itemId: 43320, name: 'Jorcamelo',
			positions: [{ quantity: JORCAMELO_QUANTITY, location: { source: 'materials', category: 7 } }],
			decision: computeRealDecision(43320, JORCAMELO_BID, JORCAMELO_QUANTITY, SEPT_26_MS),
		});
		const FANGS_PREMIUM = realRow({
			itemId: 48805, name: 'Colmillos de plástico de alta calidad',
			positions: [{ quantity: FANGS_PREMIUM_QUANTITY, location: { source: 'materials', category: 7 } }],
			decision: computeRealDecision(48805, FANGS_PREMIUM_BID, FANGS_PREMIUM_QUANTITY, SEPT_26_MS),
		});
		const PLAIN_FANGS = realRow({
			// Real note: `tc_unit_sell_copper: null` — genuinely no bid, sell depth unavailable; not a
			// festival calendar item either (no curated entry for 36059 — confirmed absent below).
			itemId: 36059, name: 'Colmillos de plástico',
			positions: [{ quantity: PLAIN_FANGS_QUANTITY, location: { source: 'materials', category: 7 } }],
			decision: computeRealDecision(36059, null, PLAIN_FANGS_QUANTITY, SEPT_26_MS),
		});
		const CANDY_PIECE = realRow({
			itemId: 36041, name: 'Trozo de caramelo',
			positions: [
				{ quantity: 720, location: { source: 'bank', slot: 0 } },
				{ quantity: 1250, location: { source: 'materials', category: 7 } },
				{ quantity: 2983, location: { source: 'character', character: 'Personaje 1', container: 'bag', bagIndex: 0, slot: 1 } },
			],
			decision: computeRealDecision(36041, CANDY_PIECE_BID, CANDY_PIECE_QUANTITY, SEPT_26_MS),
		});
		const rows = [HERO_ROW, CANDY_BAR, JORCAMELO, FANGS_PREMIUM, PLAIN_FANGS, CANDY_PIECE];
		// bid + ask: David's real note carries a listing price (`tc_unit_list_copper`) for the Saco
		// (376) too — point 5: a figure the app CAN fill from real data is never "Sin datos".
		const pricesByItemId = new Map([
			[36038, { bid: 374, ask: 376 }],
			[47909, { bid: CANDY_BAR_BID, ask: null }],
			[43320, { bid: JORCAMELO_BID, ask: null }],
			[48805, { bid: FANGS_PREMIUM_BID, ask: null }],
			[36059, { bid: null, ask: null }],
			[36041, { bid: CANDY_PIECE_BID, ask: null }],
		]);

		const port = {
			...idlePort(),
			getInventoryAdvisorViewModel: (): InventoryAdvisorViewModel => ({
				status: 'ready', title: 'x', detail: 'y', groups: [{ key: 'curated', rows }],
			}),
			inventoryAdvisor: {
				analysis: () => ({
					source: {
						input: {
							prices: {
								items: [...pricesByItemId].map(([itemId, price]) => ({
									itemId,
									bid: price.bid === null ? null : { unitCopper: price.bid },
									ask: price.ask === null ? null : { unitCopper: price.ask },
								})),
							},
						},
					},
				}),
			},
			// Round 3: simulates the state Fix A reaches after a real sync seeds 36038's datawars2
			// history — `readDaily` now returns the REAL, freshly-downloaded series
			// (`datawars2-real-history-36038-2026-09-26.ts`), not the older curated experiment fixture.
			priceHistory: { readDaily: async () => realDailyHistory(36_038) },
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(port);
		await sale['computeSaleHeroTiming']();
		// The whole point of Fix A: with real history available, the hero gets a REAL verdict, never
		// `review`/`insufficient_reference` (David's exact reported contradiction).
		expect(sale['saleHeroTiming']?.action).not.toBe('review');
		// Point 6: every row's decision comes from the same real function run just now, not a note.
		for (const row of [CANDY_BAR, JORCAMELO, FANGS_PREMIUM, CANDY_PIECE]) {
			expect(row.decision).toBeDefined();
			expect(row.decision?.action).not.toBe('review');
		}

		const model = sale.getSaleViewModel();
		const modelDump = process.env.TYRIAN_SALE_MODEL_DUMP;
		if (modelDump !== undefined) writeFileSync(modelDump, JSON.stringify(model, null, 2), 'utf8');

		vi.stubGlobal('createEl', (tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) => makeEl(tag, options));
		vi.stubGlobal('createDiv', (options?: { text?: string; cls?: string; attr?: Record<string, string> }) => makeEl('div', options));
		vi.stubGlobal('createSpan', (options?: { text?: string; cls?: string; attr?: Record<string, string> }) => makeEl('span', options));
		const container = makeEl('div');
		renderSaleView(container as unknown as HTMLElement, icons, model, createTranslator('es'));

		const lines = textOf(container).split('\n').filter((line) => line.trim() !== '');
		const dump = lines.join('\n');
		const dumpPath = '/tmp/claude-1000/-home-fodaveg-code-tyrian-companion/d3671ce6-a44c-4f1c-8165-fef8a1aaa2c8/scratchpad/venta-render-real.txt';
		if (existsSync(dirname(dumpPath))) writeFileSync(dumpPath, dump, 'utf8');

		// Criterion 1: no row carrying a bid ever reads "Sin cotización" or "Sin datos".
		const pricedNames = ['Barra de caramelo', 'Jorcamelo', 'Colmillos de plástico de alta calidad', 'Trozo de caramelo', 'Saco de Halloween'];
		for (const name of pricedNames) expect(dump).not.toMatch(new RegExp(`${name}[\\s\\S]{0,400}Sin cotizaci[oó]n`));
		expect(dump).not.toContain('Neto si vendes ya: Sin datos');
		// Point 5, second half: the hero never shows "Sin datos" for any of its own figures.
		expect(dump).not.toMatch(/Saco de Halloween[\s\S]*?Sin datos/);

		// Point 4: 36059 (Colmillos de plástico, no bid) is correctly absent — confirm the reason.
		expect(dump).not.toContain('Colmillos de plástico\n');

		// Criterion 2: the Saco states its owned quantity and a real verdict, plus the comparison figures.
		expect(model.hero?.ownedQuantity).toBe(1);
		expect(model.hero?.action).not.toBe('no_data');
		expect(dump).toContain('Saco de Halloween');
		expect(dump).toContain('1 · 1 hueco');

		// Point 7: Trozo de caramelo shows its TRUE total (4953), not just the bank stack (720).
		expect(dump).toContain(`${String(CANDY_PIECE_QUANTITY)} · 3 huecos`);
		expect(dump).not.toContain('720 · 1 hueco');

		// Criterion 3: every calendar window says how much is left or how much is missing.
		expect(model.calendar.length).toBeGreaterThan(0);
		expect(dump).toMatch(/quedan \d+ días|faltan \d+ días/);
		// Point 3: Jorcamelo's real annual June window (already closed) rolls to next year's dates.
		expect(dump).toContain('faltan');

		// Point 1: no doubled "hace hace" or a nonsensical "dentro de 0 segundos" for a fresh quote.
		expect(dump).not.toMatch(/hace\s+hace/u);
		expect(dump).not.toContain('dentro de 0 segundos');

		expect(model.groups.noData.some((row) => row.itemId === 48805)).toBe(false);
	});

	/**
	 * Point 4: confirms WHY 36059 (Colmillos de plástico, no bid) never reaches the Sale tab's rows
	 * at all — `getSaleViewModel`'s own filter: `if (itemId === HALLOWEEN_PRICE_ALERT_
	 * ITEM_ID || !calendarItemIds.has(itemId)) continue;`. 36059 genuinely has no curated festival
	 * calendar entry (`inventory-advisor-builtin-bundle.ts`'s own comment: "36059 (Plastic Fangs) has
	 * NO entry: its buy_price_avg is 0 or null across its whole measured history... falls to rule
	 * (c)"), unlike its "de alta calidad" sibling (48805), which does. This is the correct, audited
	 * exclusion, not a bug: the Sale tab is specifically the festival-calendar items tab.
	 */
	it('point 4: a materials-storage item with no curated festival entry never reaches the Sale tab rows', () => {
		const bundleLoad = inventoryAdvisorBuiltinBundleProvider.load(new Date(SEPT_26_MS).toISOString());
		expect(bundleLoad.status).toBe('available');
		if (bundleLoad.status !== 'available') return;
		expect(festivalCalendarEntryForItem(bundleLoad.bundle.festivalCalendar, 36_059)).toBeNull();
		expect(festivalCalendarEntryForItem(bundleLoad.bundle.festivalCalendar, 48_805)).not.toBeNull();
	});
});

/** A day on which the published series clears 90 % of its annual maximum. */
const SELL_DAY_MS = Date.parse('2026-05-31T12:00:00.000Z');

describe('H13.2 sell signal cabling', () => {
	// H15.18 (2026-09-10 incident): `ensureSeed`/`evaluate` throwing an unexpected error (not the
	// modeled `unreachable` outcome) died silently inside the price-history compaction that
	// calls this, with nothing in the local debug log to say the sell signal had stopped running.
	it('registers a price_history_compact failure when ensureSeed throws unexpectedly', async () => {
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		const diagnostics = { record } as unknown as LocalDebugLogger;
		const port = {
			...idlePort(),
			sellSignal: { getState: vi.fn(), ensureSeed: vi.fn(async () => { throw new Error('indexeddb unavailable'); }), evaluate: vi.fn() },
			localDebugActions: new LocalDebugActionRunner({ diagnostics, createId: () => 'sell-signal-compact' }),
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(port);

		await expect(sale.evaluateSellSignal({ nowMs: SELL_DAY_MS, readDaily: async () => [] })).resolves.toBeUndefined();

		const failure = record.mock.calls.map(([input]) => input).find(
			(input) => input.component === 'price_history' && input.action === 'price_history_compact' && input.phase === 'failure',
		);
		expect(failure).toMatchObject({ code: 'unknown_failure', state: 'sell_signal' });
	});
});

const NOW_MS = Date.parse('2026-09-26T07:35:00.000Z');
const STALE_AT_MS = NOW_MS - 25 * 60 * 60 * 1000;

describe('Sale refresh: explicit action to real cache, merge and hero recommendation', () => {
	const daysById = new Map<number, () => readonly PriceSeedDayV1[]>([
		[36038, datawars2RealHistorySacoDays], [36041, datawars2RealHistoryTrozoDays],
		[47909, datawars2RealHistoryBarraDays], [43320, datawars2RealHistoryJorcameloDays],
		[48805, datawars2RealHistoryColmillosAltaCalidadDays],
	]);

	it('leaves auto-open read-only, respects opt-in, then seeds before the same advisor/hero refresh and reuses the cache', async () => {
		const factory = new IDBFactory();
		vi.stubGlobal('window', { indexedDB: factory });
		vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
		const fetched: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: 'sale-refresh-test', now: () => NOW_MS,
			serialize: runSerialTaskUnqueued,
			fetchSeed: async (itemId) => {
				fetched.push(itemId);
				const days = daysById.get(itemId)?.();
				if (days === undefined) throw new Error('Missing real item history.');
				return { status: 'seeded', seed: { version: 1, itemId, source: 'datawars2', retrievedAt: new Date(NOW_MS).toISOString(), days: [...days] } };
			},
		});
		// The account boundary is recorded input. Everything from refreshSale through IndexedDB,
		// cache merging and recommendPosition runs production code; no pre-seeded test cache.
		const port = {
			...idlePort(),
			vaultId: 'sale-refresh-test',
			host: { priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }) },
			priceSeedBulkRefresh: service,
			priceHistory: { readDaily: async () => [] },
			getInventoryAdvisorViewModel: () => advisorModel(1),
			inventoryAdvisor: {
				analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 374 } }] } } } }),
			},
			// What the core's advisor refresh does for Sale: the hero card's verdict rides it.
			refreshInventoryAdvisor: async () => { await sale.refreshSaleHeroTiming(); },
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(port);
		try {
			await sale.refreshSale({ refreshSeeds: false });
			expect(fetched).toEqual([]);
			expect(sale['saleHeroTiming']).toMatchObject({ action: 'review', reason: 'insufficient_reference' });
			port.settings.priceHistoryEnabled = false;
			await sale.refreshSale();
			expect(fetched).toEqual([]);
			port.settings.priceHistoryEnabled = true;
			await sale.refreshSale();
			expect([...fetched].sort()).toEqual([...daysById.keys()].sort());
			expect(sale['saleHeroTiming']?.action).not.toBe('review');
			expect(sale['saleHeroTiming']?.sellOrWait?.seasons).toBe(7);
			await sale.refreshSale();
			expect(fetched).toHaveLength(5);
		} finally {
			service.dispose();
			sale.dispose();
		}
	});
});

/** An item no calendar entry uses: the one the person picks in the panel. */
const PANEL_ITEM_ID = 999_001;

/**
 * `docs/PLATFORM_POLICY.md`: the datawars2 seed requests go one at a time, never two in flight, for
 * the whole plugin (task 0812d53e). A seed pass (`PriceSeedBulkRefreshService`) and a panel load
 * (`PriceHistoryPanelSeedService`) send through the same transport, so they take turns in one
 * `SerialTaskQueue`: the panel's request, which somebody is looking at, goes right after the request
 * in flight, ahead of the pass's items that have not started, and the pass goes on afterwards.
 *
 * The real Sale refresh and deferred pass of `SaleRuntime`, the two real services, a real IndexedDB,
 * and one transport instrumented once for both paths, every request held until the test releases it.
 * The services are built the way `initializeRuntime` builds them (same transport, one queue,
 * `fetchPriceSeed` for the bulk service); the panel load is what the core's `loadPriceHistorySeries`
 * asks of the panel service. That wiring is copied here, and observed over the real
 * `initializeRuntime` in `main-price-seed-serial-wiring.test.ts`.
 */
describe('price seed downloads: a panel load next to a seed pass is never a second request in flight', () => {
	const VAULT = 'two-in-flight-test';
	const open: Array<() => void> = [];

	afterEach(() => {
		for (const release of open.splice(0)) release();
	});

	async function setup(staleItemIds: readonly number[]) {
		const factory = new IDBFactory();
		vi.stubGlobal('window', { indexedDB: factory });
		vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
		const cache = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		for (const itemId of staleItemIds) await cache.put(VAULT, itemId, seedOf(itemId), STALE_AT_MS);
		cache.close();
		const transport = transportProbe();
		const priceHistory = indexedDbPriceHistoryPort({ indexedDB: factory });
		const downloads = new SerialTaskQueue();
		let passItemsQueued = 0;
		const bulk = new PriceSeedBulkRefreshService({
			priceHistory, vaultId: VAULT, now: () => NOW_MS,
			fetchSeed: async (itemId, actionContext) => await fetchPriceSeed(itemId, { transport, now: () => NOW_MS, actionContext }),
			serialize: async (task) => { passItemsQueued += 1; return await downloads.run('background', task); },
		});
		const panel = new PriceHistoryPanelSeedService({
			priceHistory, vaultId: VAULT, transport, now: () => NOW_MS, serialize: downloads.runner('interactive'),
		});
		const harness = {
			...idlePort(),
			vaultId: VAULT,
			settings: { ...DEFAULT_SETTINGS, priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400 },
			host: { priceHistory },
			priceSeedBulkRefresh: bulk,
			priceHistory: { readDaily: async () => [] },
			getInventoryAdvisorViewModel: () => advisorModel(1),
			inventoryAdvisor: {
				analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 374 } }] } } } }),
			},
			notifyConsultMode: vi.fn(),
			renderInventoryAdvisorViews: vi.fn(),
			// What the core's advisor refresh does for Sale: the hero card's verdict rides it.
			refreshInventoryAdvisor: async () => { await sale.refreshSaleHeroTiming(); },
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(harness);
		open.push(() => { transport.open(); bulk.dispose(); panel.dispose(); sale.dispose(); });
		return {
			harness, sale, transport,
			refreshSale: async () => { await sale.refreshSale(); },
			// What the core's `loadPriceHistorySeries` asks of the panel's seed service.
			panelLoad: async () => { await panel.ensure(PANEL_ITEM_ID); },
			/**
			 * Resolves once the panel has read its cache and reached its download: the service marks the
			 * item `loading` right before it asks for it, queued or not.
			 */
			panelReachedItsDownload: async () => {
				await vi.waitFor(() => { expect(panel.getState(PANEL_ITEM_ID).status).toBe('loading'); });
			},
			/** Resolves once a pass has an item waiting in the queue, or has already sent a second request. */
			passReachedItsDownload: async () => {
				await vi.waitFor(() => { expect(passItemsQueued + transport.requestedItemIds().length).toBeGreaterThan(1); });
			},
		};
	}

	it('panel load during the missing phase of a Sale refresh: the panel request waits for the one in flight', async () => {
		const { transport, refreshSale, panelLoad, panelReachedItsDownload } = await setup([]);

		const sale = refreshSale();
		await transport.started();
		const panelLoading = panelLoad();
		await panelReachedItsDownload();

		expect(transport.inFlight()).toBe(1);
		transport.open();
		await Promise.all([sale, panelLoading]);
		expect(transport.maxInFlight()).toBe(1);
		expect(transport.requestedItemIds()).toContain(PANEL_ITEM_ID);
	});

	it('panel load during the deferred pass of a Sale refresh: the panel request waits for the one in flight', async () => {
		const calendar = calendarItemIds();
		const { sale, transport, refreshSale, panelLoad, panelReachedItsDownload } = await setup(calendar);

		const deferredStarted = transport.started();
		await refreshSale();
		await deferredStarted;
		const panelLoading = panelLoad();
		await panelReachedItsDownload();

		expect(transport.inFlight()).toBe(1);
		transport.open();
		await Promise.all([sale['priceSeedDeferredPass'], panelLoading]);
		expect(transport.maxInFlight()).toBe(1);
		expect(transport.requestedItemIds()).toContain(PANEL_ITEM_ID);
	});

	it('the panel request goes right after the one in flight, and the pass then goes on in order, each item once, within its cap', async () => {
		const calendar = calendarItemIds();
		const { transport, refreshSale, panelLoad, panelReachedItsDownload } = await setup([]);
		// More than one item still to come in the pass, or "ahead of the pass" would prove nothing.
		expect(calendar.length).toBeGreaterThan(2);

		const sale = refreshSale();
		await transport.started();
		const panelLoading = panelLoad();
		await panelReachedItsDownload();
		expect(transport.requestedItemIds()).toEqual([calendar[0]]);

		const next = transport.started();
		transport.releaseOldest();
		await next;
		expect(transport.requestedItemIds()).toEqual([calendar[0], PANEL_ITEM_ID]);
		expect(transport.inFlight()).toBe(1);

		transport.open();
		await Promise.all([sale, panelLoading]);
		const passItems = calendar.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(transport.requestedItemIds()).toEqual([passItems[0], PANEL_ITEM_ID, ...passItems.slice(1)]);
		expect(transport.maxInFlight()).toBe(1);
	});

	it.each([
		['the price history opt-in switched off', (harness: { settings: SaleRuntimePort['settings'] }) => { harness.settings = { ...harness.settings, priceHistoryEnabled: false }; }],
		['the device turned to consult', (harness: { collectorMode: CollectorMode | undefined }) => { harness.collectorMode = 'consult'; }],
	] as const)('%s while a pass item waits behind the panel request: that item is not requested', async (_name, withdraw) => {
		const { harness, transport, refreshSale, panelLoad, passReachedItsDownload } = await setup([]);

		const panelStarted = transport.started();
		const panelLoading = panelLoad();
		await panelStarted;
		const sale = refreshSale();
		await passReachedItsDownload();
		withdraw(harness);
		transport.releaseOldest();
		// The pass item's turn comes the moment the panel request ends, before the panel load returns.
		await panelLoading;
		expect(transport.requestedItemIds()).toEqual([PANEL_ITEM_ID]);

		await sale;
		expect(transport.requestedItemIds()).toEqual([PANEL_ITEM_ID]);
	});
});

/**
 * 1 oct 2026: an explicit action waits only for the seeds that are MISSING. A copy past its 24 h is
 * what the analysis reads, and its refresh starts once the action that left it has ended.
 *
 * Every test runs the real `SaleRuntime` methods (`refreshSale`, `runPriceSeedSyncAction` around a
 * sync, the sync's own seed pass) over the real `PriceSeedBulkRefreshService` and a real IndexedDB;
 * the one-click controller is replaced by the steps it takes, and only the download is a probe whose
 * answers the test releases by hand, so nothing here waits on a clock. The core's side of an action
 * (its advisor refresh, the sync around the analyses, the Settings opt-in, the unload) is written
 * out below as the steps the core takes; `main-sale-runtime-wiring.test.ts` proves the real core
 * takes them.
 */
describe('price seed phases through the core: missing seeds before the result, stale copies after it', () => {
	const VAULT = 'seed-phases-test';
	const open: Array<() => void> = [];

	afterEach(() => {
		for (const release of open.splice(0)) release();
	});

	async function setup(staleItemIds: readonly number[]) {
		const factory = new IDBFactory();
		vi.stubGlobal('window', { indexedDB: factory });
		vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
		const cache = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		for (const itemId of staleItemIds) await cache.put(VAULT, itemId, seedOf(itemId), STALE_AT_MS);
		cache.close();
		const probe = seedProbe();
		const service = new PriceSeedBulkRefreshService({
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: VAULT, now: () => NOW_MS,
			fetchSeed: probe.fetchSeed,
			// No queue shared with a panel here: these tests are about the passes among themselves.
			serialize: runSerialTaskUnqueued,
		});
		/** The derived watch list of each analysis a sync runs, in order; an analysis past the last one seeds nothing. */
		const syncLists: Array<readonly number[]> = [];
		const analysisHolds: Gate[] = [];
		let syncSteps: () => Promise<void> = async () => undefined;
		/** The core's `inventoryAnalysisForSync`: true while an analysis runs on behalf of a sync. */
		let analysisForSync = false;
		const renderInventoryAdvisorViews = vi.fn();
		// What the workflow does inside an analysis that runs on behalf of a sync: the analysis port's
		// seed pass over that analysis's watch list, then the result. Any other analysis seeds nothing.
		const analyse = vi.fn(async () => {
			const itemIds = analysisForSync ? syncLists.shift() : undefined;
			if (itemIds !== undefined) {
				if (itemIds.length > 0) await sale.refreshPriceSeedsForSync(itemIds);
				await analysisHolds.shift()?.wait();
			}
			return { status: 'ready' };
		});
		const harness = {
			...idlePort(),
			vaultId: VAULT,
			notifyConsultMode: vi.fn(),
			host: { priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }) },
			priceSeedBulkRefresh: service,
			priceHistory: { readDaily: async () => [] },
			getInventoryAdvisorViewModel: () => advisorModel(1),
			// No object results: an analysis the notes cannot be written from, so a sync that goes on to
			// its notes runs the recovery read (`inventoryAnalysisForNotes`), a second analysis.
			inventoryAdvisor: {
				analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 374 } }] } } }, objects: null }),
			},
			renderInventoryAdvisorViews,
			// The core's `refreshInventoryAdvisor`: the analysis and its paint, then the hero card's verdict and a paint.
			refreshInventoryAdvisor: async () => {
				const operation = analyse();
				renderInventoryAdvisorViews();
				await operation;
				await sale.refreshSaleHeroTiming();
				renderInventoryAdvisorViews();
			},
		} satisfies SaleRuntimePort;
		const sale = new SaleRuntime(harness);
		open.push(() => { probe.open(); service.dispose(); sale.dispose(); });
		const readCachedAt = async (itemId: number): Promise<number | null> => {
			const reader = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
			try { return (await reader.get(VAULT, itemId))?.cachedAtMs ?? null; } finally { reader.close(); }
		};
		/** The core's `refreshInventoryAdvisorForSync`: the advisor refresh, as an analysis on behalf of the sync. */
		const refreshInventoryAdvisorForSync = async (): Promise<void> => {
			analysisForSync = true;
			try { await harness.refreshInventoryAdvisor(); } finally { analysisForSync = false; }
		};
		/**
		 * The core's `inventoryAnalysisForNotes` over an analysis with no object results: one more
		 * analysis on behalf of the sync, which cannot be written from either, so it rejects.
		 */
		const inventoryAnalysisForNotes = async (): Promise<never> => {
			analysisForSync = true;
			try { await harness.refreshInventoryAdvisor(); } finally { analysisForSync = false; }
			throw new Error('objects_null');
		};
		/**
		 * One whole "Sincronizar inventario", the way the core's `runInventoryVaultSync` runs it inside
		 * one seed action: the sync's own analysis, then (with `recoveryRead`) the second analysis the
		 * notes ask for, then (with `notesHold`) the time it spends writing notes. `lists` is the watch
		 * list of each analysis.
		 */
		const sync = (
			lists: ReadonlyArray<readonly number[]>,
			options: { recoveryRead?: boolean; analysisHold?: Gate; notesHold?: Gate; failAfterAnalysis?: boolean } = {},
		): Promise<void> => {
			syncLists.splice(0, syncLists.length, ...lists);
			analysisHolds.splice(0, analysisHolds.length, ...(options.analysisHold ? [options.analysisHold] : []));
			syncSteps = async () => {
				await refreshInventoryAdvisorForSync();
				if (options.failAfterAnalysis) throw new Error('The sync run rejected after its analysis.');
				// The recovery read cannot be written from either in this harness; the run settles on it
				// as the controller does, with an error it records and does not rethrow.
				if (options.recoveryRead) await inventoryAnalysisForNotes().catch(() => undefined);
				await options.notesHold?.wait();
			};
			return sale.runPriceSeedSyncAction(async () => { await syncSteps(); });
		};
		return {
			harness, sale, probe, service, renderInventoryAdvisorViews, readCachedAt, analyse, sync,
			/** One explicit Sale refresh: the calendar's seed pass, then an analysis that is not a sync's. */
			refreshSale: () => sale.refreshSale(),
			/** One "Sincronizar inventario", start to end, whose derived watch list is `itemIds`. */
			syncRefresh: (itemIds: readonly number[]) => sync([itemIds]),
			/** The analysis the manual preview asks for, with no `runInventoryVaultSync` around it. */
			recoveryReadAlone: async (itemIds: readonly number[]): Promise<void> => {
				syncLists.splice(0, syncLists.length, itemIds);
				await inventoryAnalysisForNotes().catch(() => undefined);
			},
			/** What the core's `updateSettings` does with the price history opt-in. */
			priceHistoryOptIn: (enabled: boolean): void => {
				harness.settings.priceHistoryEnabled = enabled;
				if (!enabled) sale.dropPriceSeedDeferredRequest();
			},
			/** What the core's `shutdownRuntime` does to the Sale runtime and the seed service. */
			shutdownRuntime: (): void => {
				harness.unloaded = true;
				service.dispose();
				sale.dispose();
			},
			/** Whatever is still queued in the service has run once this resolves. */
			drain: async () => { await sale['priceSeedDeferredPass']; await service.run([]); },
		};
	}

	it('Sale, only stale copies: the refresh resolves with no download made, and they follow one at a time', async () => {
		const calendar = calendarItemIds();
		const { sale, probe, refreshSale, readCachedAt } = await setup(calendar);

		expect(await firstOf(refreshSale(), probe)).toBe('resolved');
		expect(probe.calls).toEqual([]);

		await probe.started();
		expect(probe.calls).toHaveLength(1);
		probe.open();
		await sale['priceSeedDeferredPass'];

		expect([...probe.calls].sort(byId)).toEqual([...calendar].sort(byId));
		expect(probe.maxInFlight()).toBe(1);
		expect(await readCachedAt(calendar[0]!)).toBe(NOW_MS);
	});

	it('Sale, missing and stale together: the refresh waits for the missing seeds and only for those', async () => {
		const calendar = calendarItemIds();
		const missing = calendar.slice(0, 2);
		const stale = calendar.slice(2);
		const { sale, probe, refreshSale } = await setup(stale);

		const refresh = refreshSale();
		for (let answered = 0; answered < missing.length; answered += 1) {
			await probe.started();
			probe.releaseOne();
		}
		expect(await firstOf(refresh, probe)).toBe('resolved');
		expect([...probe.calls].sort(byId)).toEqual([...missing].sort(byId));

		probe.open();
		await sale['priceSeedDeferredPass'];
		expect([...probe.calls.slice(missing.length)].sort(byId)).toEqual([...stale].sort(byId));
		expect(probe.maxInFlight()).toBe(1);
	});

	it('sync, more than the cap: the missing seeds first, and 25 downloads per action between the two phases', async () => {
		const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
		const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
		const { probe, syncRefresh, drain } = await setup(stale);
		probe.open();

		await syncRefresh([...stale, ...missing]);
		expect(probe.calls).toEqual(missing);

		await drain();
		expect(probe.calls).toEqual([...missing, ...stale.slice(0, 5)]);
		expect(probe.calls).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(probe.maxInFlight()).toBe(1);
	});

	it('sync, the missing seeds alone reach the cap: no stale copy is refreshed by that action', async () => {
		const stale = [1, 2, 3];
		const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN + 4 }, (_unused, index) => index + 11);
		const { probe, syncRefresh, drain } = await setup(stale);
		probe.open();

		await syncRefresh([...stale, ...missing]);
		await drain();

		expect(probe.calls).toEqual(missing.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN));
	});

	it('sync, one missing seed and stale copies: the coverage comes with the result and the deferred pass repaints it once', async () => {
		const { sale, probe, syncRefresh, renderInventoryAdvisorViews, analyse } = await setup([1, 2, 3]);

		// Item 4 has no seed: the action waits for it, and for nothing else.
		const refresh = syncRefresh([1, 2, 3, 4]);
		expect(await firstOf(refresh, probe)).toBe('fetch_started');
		expect(probe.calls).toEqual([4]);
		probe.releaseOne();
		expect(await firstOf(refresh, probe)).toBe('resolved');
		// The three stale copies already count as data: the line is complete with the result.
		expect(sale.getPriceSeedQueueCoverage()).toEqual({ total: 4, seeded: 4, noData: 0, pending: 0 });
		const rendersWithTheResult = renderInventoryAdvisorViews.mock.calls.length;
		expect(probe.calls).toEqual([4]);

		probe.open();
		await sale['priceSeedDeferredPass'];

		expect(probe.calls).toEqual([4, 1, 2, 3]);
		expect(sale.getPriceSeedQueueCoverage()).toEqual({ total: 4, seeded: 4, noData: 0, pending: 0 });
		expect(renderInventoryAdvisorViews.mock.calls.length).toBe(rendersWithTheResult + 1);
		// What the deferred pass downloaded is for the next analysis: it starts none itself.
		expect(analyse).toHaveBeenCalledTimes(1);
	});

	it('unload in the middle of the deferred pass: it stops, stores nothing more, and repaints nothing', async () => {
		const { harness, sale, probe, service, syncRefresh, renderInventoryAdvisorViews, readCachedAt } = await setup([1, 2, 3]);

		expect(await firstOf(syncRefresh([1, 2, 3]), probe)).toBe('resolved');
		const coverageWithTheResult = sale.getPriceSeedQueueCoverage();
		expect(coverageWithTheResult).toEqual({ total: 3, seeded: 3, noData: 0, pending: 0 });
		await probe.started();
		const rendersBeforeUnload = renderInventoryAdvisorViews.mock.calls.length;

		// What `shutdownRuntime` does to this service.
		harness.unloaded = true;
		service.dispose();
		probe.open();
		await sale['priceSeedDeferredPass'];

		expect(probe.calls).toEqual([1]);
		expect(await readCachedAt(1)).toBe(STALE_AT_MS);
		expect(renderInventoryAdvisorViews.mock.calls.length).toBe(rendersBeforeUnload);
		expect(sale.getPriceSeedQueueCoverage()).toEqual(coverageWithTheResult);
	});

	it('a second action while a deferred pass is alive: no second deferred pass, its missing seeds wait their turn', async () => {
		const { probe, syncRefresh, drain } = await setup([1, 2, 3, 7, 8]);

		expect(await firstOf(syncRefresh([1, 2, 3]), probe)).toBe('resolved');
		await probe.started();
		expect(probe.calls).toEqual([1]);

		// 7 and 8 are stale copies only the second action knows; 9 and 10 have no seed at all.
		const second = syncRefresh([1, 2, 3, 7, 8, 9, 10]);
		probe.open();
		await second;
		await drain();

		expect(probe.calls).toEqual([1, 2, 3, 9, 10]);
		expect(probe.maxInFlight()).toBe(1);
	});

	it('a Sale refresh while a sync\'s deferred pass is alive: the calendar\'s stale copies are not queued behind it', async () => {
		const calendar = calendarItemIds();
		const { probe, syncRefresh, refreshSale, drain } = await setup([1, 2, 3, ...calendar]);

		expect(await firstOf(syncRefresh([1, 2, 3]), probe)).toBe('resolved');
		await probe.started();

		const sale = refreshSale();
		probe.open();
		await sale;
		await drain();

		expect(probe.calls).toEqual([1, 2, 3]);
		expect(probe.maxInFlight()).toBe(1);
	});

	/**
	 * Review of 1 oct 2026. The deferred pass belongs to the action that left it: it starts when that
	 * whole action ends, only while the opt-in still stands, and nothing else can start it.
	 */
	describe('the deferred pass is started by its own action, at its end, and only while it is still allowed', () => {
		it('sync with a second analysis: its missing seeds are not queued behind the stale copies, which start when the whole action ends', async () => {
			const missing = [11, 12, 13, 14, 15];
			const later = [21, 22];
			const { harness, sale, probe, service, sync, drain, analyse } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3, ...missing], [1, 2, 3, ...missing, ...later]], { recoveryRead: true, notesHold: notes });
			await notes.reached;
			// "Analizar" pressed while the sync is still writing its notes: it starts nothing either.
			await harness.refreshInventoryAdvisor();
			await service.run([]);

			expect(probe.calls).toEqual([...missing, ...later]);
			expect(sale['priceSeedDeferredPass']).toBeNull();

			notes.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([...missing, ...later, 1, 2, 3]);
			expect(probe.maxInFlight()).toBe(1);
			expect(analyse).toHaveBeenCalledTimes(3);
		});

		it('sync with a second analysis: the cap of 25 is the action\'s, and the second analysis does not get a new one', async () => {
			const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
			const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
			const later = Array.from({ length: 10 }, (_unused, index) => index + 41);
			const { probe, sync, drain } = await setup(stale);
			probe.open();

			await sync([[...stale, ...missing], [...stale, ...missing, ...later]], { recoveryRead: true });
			await drain();

			// 20 missing seeds in the first analysis, the 5 left of the cap in the second, and no stale copy.
			expect(probe.calls).toEqual([...missing, ...later.slice(0, 5)]);
			expect(probe.calls).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		});

		it('sync with a second analysis that leaves no stale copies of its own: the first analysis\'s are kept and refreshed out of what the action has left of its cap', async () => {
			const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
			const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
			const later = [41, 42, 43];
			const { probe, sync, drain } = await setup(stale);
			probe.open();

			// The second analysis's list has no copy past its 24 h: three missing seeds and nothing else.
			await sync([[...stale, ...missing], later], { recoveryRead: true });
			await drain();

			// 20 + 3 missing seeds leave 2 of the cap: two stale copies of the first list, not the 5 it had left.
			expect(probe.calls).toEqual([...missing, ...later, 1, 2]);
			expect(probe.calls).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
			expect(probe.maxInFlight()).toBe(1);
		});

		it('sync with a second analysis that spends the rest of the cap and leaves no stale copies of its own: nothing is kept and no deferred pass starts', async () => {
			const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
			const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
			const later = Array.from({ length: 10 }, (_unused, index) => index + 41);
			const { sale, probe, sync, drain } = await setup(stale);
			probe.open();

			await sync([[...stale, ...missing], later], { recoveryRead: true });

			expect(sale['priceSeedDeferredPass']).toBeNull();
			expect(sale['priceSeedDeferredRequest']).toBeNull();
			await drain();
			expect(probe.calls).toEqual([...missing, ...later.slice(0, 5)]);
		});

		it('sync that rejects after its analysis: the stale copies it left are started by that same action, and nothing stays in the slot', async () => {
			const { sale, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();

			await expect(sync([[1, 2, 3]], { failAfterAnalysis: true })).rejects.toThrow('The sync run rejected after its analysis.');

			expect(sale['priceSeedDeferredRequest']).toBeNull();
			expect(sale['priceSeedSyncAction']).toBeNull();
			await drain();
			expect(probe.calls).toEqual([1, 2, 3]);
		});

		it('sync, the device turned to consult between two missing seeds: the downloads stop after the one in flight', async () => {
			const { harness, probe, sync, drain } = await setup([]);

			const action = sync([[11, 12, 13]]);
			await probe.started();
			expect(probe.calls).toEqual([11]);
			harness.collectorMode = 'consult';
			probe.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([11]);
		});

		it('the opt-in switched off before the action ends: no deferred pass starts', async () => {
			const { harness, sale, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			// Straight on the settings, not through `updateSettings`, which empties the slot itself.
			harness.settings.priceHistoryEnabled = false;
			notes.open();
			await action;

			expect(sale['priceSeedDeferredPass']).toBeNull();
			await drain();
			expect(probe.calls).toEqual([]);
		});

		it('the opt-in switched off in the middle of the deferred pass: it stops at the next item', async () => {
			const { harness, sale, probe, sync } = await setup([1, 2, 3]);

			expect(await firstOf(sync([[1, 2, 3]]), probe)).toBe('resolved');
			await probe.started();
			expect(probe.calls).toEqual([1]);

			harness.settings.priceHistoryEnabled = false;
			probe.open();
			await sale['priceSeedDeferredPass'];

			expect(probe.calls).toEqual([1]);
		});

		it('the opt-in switched off in Settings while the stale copies wait: the slot is emptied, and switching it back on starts nothing', async () => {
			const { sale, probe, sync, drain, priceHistoryOptIn } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			expect(sale['priceSeedDeferredRequest']).not.toBeNull();

			priceHistoryOptIn(false);
			expect(sale['priceSeedDeferredRequest']).toBeNull();

			priceHistoryOptIn(true);
			notes.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([]);
		});

		it('Sale, the device turned to consult while the missing seed downloads: the stale copies are dropped, and a later "Analizar" starts nothing', async () => {
			const calendar = calendarItemIds();
			const missing = calendar.slice(0, 1);
			const { harness, sale, probe, refreshSale, drain } = await setup(calendar.slice(1));

			const refresh = refreshSale();
			await probe.started();
			// The advisor refresh that closes this Sale refresh is now refused before it starts.
			harness.collectorMode = 'consult';
			probe.releaseOne();
			await refresh;

			expect(sale['priceSeedDeferredRequest']).toBeNull();

			harness.collectorMode = 'collector';
			await harness.refreshInventoryAdvisor();
			probe.open();
			await drain();

			expect(probe.calls).toEqual(missing);
		});

		it('sync, the device turned to consult while the notes are written, with no refresh refused: no deferred pass starts and the slot is left empty', async () => {
			const { harness, sale, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			expect(sale['priceSeedDeferredRequest']).not.toBeNull();
			// Nothing asks for an advisor refresh from here on, so nothing is refused in consult.
			harness.collectorMode = 'consult';
			notes.open();
			await action;

			expect(sale['priceSeedDeferredPass']).toBeNull();
			expect(sale['priceSeedDeferredRequest']).toBeNull();
			await drain();
			expect(probe.calls).toEqual([]);
		});

		it('sync, an "Analizar" pressed in consult while the notes are written: it runs (a manual action) and downloads no seed, the slot keeps what the sync left', async () => {
			const { harness, sale, probe, sync, drain, analyse } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			const slot = sale['priceSeedDeferredRequest'];
			expect(slot).not.toBeNull();
			const before = analyse.mock.calls.length;
			harness.collectorMode = 'consult';
			await harness.refreshInventoryAdvisor();
			expect(analyse.mock.calls.length).toBe(before + 1);
			expect(sale['priceSeedDeferredRequest']).toBe(slot);
			expect(harness.notifyConsultMode).not.toHaveBeenCalled();
			// The device is still in consult when the sync ends: its stale copies are never downloaded.
			notes.open();
			await action;
			await drain();

			expect(sale['priceSeedDeferredRequest']).toBeNull();
			expect(probe.calls).toEqual([]);
		});

		it('sync, the opt-in switched off between two missing seeds: the downloads stop after the one in flight', async () => {
			const { harness, probe, sync, drain } = await setup([]);

			const action = sync([[11, 12, 13]]);
			await probe.started();
			expect(probe.calls).toEqual([11]);
			harness.settings.priceHistoryEnabled = false;
			probe.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([11]);
		});

		it('Sale, the opt-in switched off between two missing seeds: the downloads stop after the one in flight', async () => {
			const calendar = calendarItemIds();
			const { harness, probe, refreshSale, drain } = await setup([]);

			const refresh = refreshSale();
			await probe.started();
			harness.settings.priceHistoryEnabled = false;
			probe.open();
			await refresh;
			await drain();

			expect(probe.calls).toEqual(calendar.slice(0, 1));
		});

		it('a sync and a Sale refresh overlapping, neither with a deferred pass alive when it arrived: the first to leave its stale copies keeps the slot', async () => {
			const calendar = calendarItemIds();
			const { probe, sync, refreshSale, drain } = await setup([1, 2, 3, ...calendar]);
			const analysis = gate();

			// The sync waits for its one missing seed; the Sale refresh arrives meanwhile, and its own
			// missing phase (nothing to request) queues behind it.
			const action = sync([[1, 2, 3, 4]], { analysisHold: analysis });
			await probe.started();
			const sale = refreshSale();
			probe.releaseOne();
			// The sync has left its stale copies and is still analysing when the Sale refresh finishes.
			await analysis.reached;
			await sale;
			analysis.open();
			await action;
			probe.open();
			await drain();

			expect(probe.calls).toEqual([4, 1, 2, 3]);
			expect(probe.maxInFlight()).toBe(1);
		});

		it('a deferred pass of an older sync list: once a newer sync has started it neither rewrites the coverage nor repaints', async () => {
			const { sale, probe, sync, renderInventoryAdvisorViews } = await setup([1, 2, 3]);

			expect(await firstOf(sync([[1, 2, 3]]), probe)).toBe('resolved');
			await probe.started();
			const coverageOfTheOlderSync = sale.getPriceSeedQueueCoverage();

			const newer = sync([[1, 2, 3, 5]]);
			const rendersOnceTheNewerSyncStarted = renderInventoryAdvisorViews.mock.calls.length;
			// The older pass's three downloads answer; the next one to start is the newer sync's missing seed.
			for (let answered = 0; answered < 3; answered += 1) {
				const next = probe.started();
				probe.releaseOne();
				await next;
			}
			expect(probe.calls).toEqual([1, 2, 3, 5]);

			expect(renderInventoryAdvisorViews.mock.calls.length).toBe(rendersOnceTheNewerSyncStarted);
			expect(sale.getPriceSeedQueueCoverage()).toBe(coverageOfTheOlderSync);

			probe.open();
			await newer;
			expect(sale.getPriceSeedQueueCoverage()).toEqual({ total: 4, seeded: 4, noData: 0, pending: 0 });
		});

		it('a sync\'s analysis outside the sync action (the manual preview\'s recovery read): the missing seed is requested and no stale copy is left waiting', async () => {
			const { sale, probe, recoveryReadAlone, drain } = await setup([1, 2, 3]);
			probe.open();

			await recoveryReadAlone([1, 2, 3, 4]);
			await drain();

			expect(probe.calls).toEqual([4]);
			expect(sale['priceSeedDeferredRequest']).toBeNull();
		});

		it('the real shutdownRuntime while the stale copies wait: the slot is emptied and the action\'s end starts nothing', async () => {
			const { sale, probe, sync, shutdownRuntime } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			expect(sale['priceSeedDeferredRequest']).not.toBeNull();

			shutdownRuntime();
			expect(sale['priceSeedDeferredRequest']).toBeNull();

			notes.open();
			await action;
			expect(sale['priceSeedDeferredPass']).toBeNull();
			expect(probe.calls).toEqual([]);
		});
	});
});

interface Gate {
	/** Resolves once the code under test has reached this point. */
	readonly reached: Promise<void>;
	/** What the code under test awaits: it marks the point as reached and waits for `open`. */
	wait(): Promise<void>;
	open(): void;
}

/** A point where the test holds the action until it decides to let it go on. */
function gate(): Gate {
	let open!: () => void;
	let reach!: () => void;
	const opened = new Promise<void>((resolve) => { open = resolve; });
	const reached = new Promise<void>((resolve) => { reach = resolve; });
	return { reached, open, wait: async () => { reach(); await opened; } };
}

const byId = (left: number, right: number): number => left - right;

/** The festival calendar's items, the list an explicit Sale refresh seeds. */
function calendarItemIds(): number[] {
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date(NOW_MS).toISOString());
	if (loaded.status !== 'available') throw new Error('Expected the built-in bundle to be available.');
	return loaded.bundle.festivalCalendar.entries.map((entry) => entry.itemId);
}

function seedOf(itemId: number): PriceSeedV1 {
	return { version: 1, itemId, source: 'datawars2', retrievedAt: new Date(NOW_MS).toISOString(), days: [{ dayUtc: '2026-09-25', bidCopper: 100, askCopper: 110 }] };
}

/** Which happens first: the action resolves, or a download starts while it is still pending. */
async function firstOf(action: Promise<void>, probe: ReturnType<typeof seedProbe>): Promise<'resolved' | 'fetch_started'> {
	return await Promise.race([
		action.then(() => 'resolved' as const),
		probe.started().then(() => 'fetch_started' as const),
	]);
}

/**
 * The download, instrumented: every call is recorded and held until the test releases it, so the
 * order of the calls and how many are in flight together are facts the test reads, not timings.
 */
function seedProbe() {
	const calls: number[] = [];
	const held: Array<() => void> = [];
	const waitingForACall: Array<() => void> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let opened = false;
	return {
		calls,
		maxInFlight: () => maxInFlight,
		fetchSeed: async (itemId: number): Promise<PriceSeedResult> => {
			calls.push(itemId);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			for (const notify of waitingForACall.splice(0)) notify();
			if (!opened) await new Promise<void>((resolve) => { held.push(resolve); });
			inFlight -= 1;
			return { status: 'seeded', seed: seedOf(itemId) };
		},
		/** Resolves when the next download starts. */
		started: () => new Promise<void>((resolve) => { waitingForACall.push(resolve); }),
		releaseOne: () => { held.shift()?.(); },
		/** Releases every held download and lets the later ones answer at once. */
		open: () => { opened = true; for (const release of held.splice(0)) release(); },
	};
}

/**
 * The one transport both services send through, instrumented: a single in-flight counter that the
 * seed pass and the panel share, each request held until the test releases it. It answers 404 (a
 * `no_seed`), which is all these tests need: they count and order requests, not seeds.
 */
function transportProbe() {
	const requested: number[] = [];
	const held: Array<() => void> = [];
	const waitingForACall: Array<() => void> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let opened = false;
	const transport: HttpTransport = {
		send: async (request: HttpRequest): Promise<HttpResponse> => {
			requested.push(Number(new URL(request.url).searchParams.get('itemID')));
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			for (const notify of waitingForACall.splice(0)) notify();
			if (!opened) await new Promise<void>((resolve) => { held.push(resolve); });
			inFlight -= 1;
			return { status: 404, headers: {}, body: null };
		},
	};
	return {
		...transport,
		inFlight: () => inFlight,
		maxInFlight: () => maxInFlight,
		requestedItemIds: () => [...requested],
		/** Resolves when the next request starts. */
		started: () => new Promise<void>((resolve) => { waitingForACall.push(resolve); }),
		/** Answers the request that has been held the longest, and only that one. */
		releaseOldest: () => {
			const release = held.shift();
			if (release === undefined) throw new Error('No request is held.');
			release();
		},
		/** Releases every held download and lets the later ones answer at once. */
		open: () => { opened = true; for (const release of held.splice(0)) release(); },
	};
}

interface FakeElement {
	tag: string;
	children: FakeElement[];
	textContent: string | null;
	className: string;
	attributes: Map<string, string>;
	append(...children: FakeElement[]): void;
	createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeElement;
	createDiv(options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeElement;
	createSpan(options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeElement;
	setAttribute(name: string, value: string): void;
	setAttr(name: string, value: string): void;
	setText(value: string): void;
	addClass(value: string): void;
	addEventListener(type: string, listener: () => void): void;
	empty(): void;
	hidden: boolean;
	disabled: boolean;
}

function makeEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }): FakeElement {
	const attributes = new Map<string, string>(Object.entries(options?.attr ?? {}));
	const el: FakeElement = {
		tag, children: [], textContent: options?.text ?? null, className: options?.cls ?? '', attributes,
		hidden: false, disabled: false,
		append(...children) { el.children.push(...children); },
		createEl(childTag, childOptions) { const child = makeEl(childTag, childOptions); el.children.push(child); return child; },
		createDiv(childOptions) { const child = makeEl('div', childOptions); el.children.push(child); return child; },
		createSpan(childOptions) { const child = makeEl('span', childOptions); el.children.push(child); return child; },
		setAttribute(name, value) { attributes.set(name, value); },
		setAttr(name, value) { attributes.set(name, value); },
		setText(value) { el.textContent = value; },
		addClass(value) { el.className = `${el.className} ${value}`.trim(); },
		addEventListener() { /* no click dispatched in this test */ },
		empty() { el.children.splice(0); el.textContent = null; },
	};
	return el;
}

function textOf(el: FakeElement): string {
	return [el.textContent ?? '', ...el.children.map(textOf)].join('\n');
}
