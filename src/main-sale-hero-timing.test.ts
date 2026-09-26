import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { createTranslator } from './core/i18n';
import TyrianCompanionPlugin, {
	resolveSaleCalendarCandidateSpan, resolveSaleSeasonalInputFor, saleOpenVsSellCopper, saleSourceRowFromAdvisorRow,
} from './main';
import { festivalCalendarEntryForItem, type FestivalCalendarCandidateV1 } from './economy/seasonal-window';
import { sellTimingHistoryBagDays } from './economy/__fixtures__/sell-timing-history-36038';
import type { PriceHistoryDailyV1 } from './economy/price-history-model';
import { recommendPosition } from './advisor/inventory-position-recommendation';
import { POSITION_RECOMMENDATION_REQUIRED_DAYS } from './inventory/inventory-analysis';
import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './ui/inventory-advisor-view-model';
import { buildSaleViewModel, type SaleViewModel, type SaleViewModelInput } from './ui/sale-view-model';
import { renderSaleView } from './ui/sale-view';
import { INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL, inventoryAdvisorBuiltinBundleProvider } from './advisor/inventory-advisor-builtin-bundle';

/**
 * Review fix (26 sep 2026): the Saco de Halloween's hero card verdict comes from
 * `recommendPosition`, the SAME rule every other Sale row uses, instead of the simpler
 * account-level sell signal. This file is cabling, not shape: every assertion runs the real
 * `resolveSaleSeasonalInputFor`/`computeSaleHeroTiming`/`buildSaleHeroInput` and the real,
 * curated 7-edition backtest fixture (`sell-timing-history-36038.ts`), then renders the real DOM
 * (`buildSaleViewModel` + `renderSaleView`) — nothing here reads the text of `main.ts`.
 */

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const SEPT_26_MS = Date.UTC(2026, 8, 26, 7, 35, 0);
const OCT_14_MS = Date.UTC(2026, 9, 14, 19, 10, 0);

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
 * The curated 36038 backtest's own last recorded bid (24 sep 2026,
 * `sell-timing-history-36038.ts`'s own final row) — the anchor every OTHER item's synthetic history
 * below scales against, so its relative day-to-day SHAPE (the real, audited seasonal pattern) is
 * reused at a different item's own price level, rather than one item's copper values standing in
 * unscaled for another's.
 */
const FIXTURE_ANCHOR_BID_COPPER = 378;

/**
 * A real item's own price history, standing in for whatever datawars2 would deliver once Fix A
 * (`inventory-analysis.ts`) actually asks for its seed: the curated 36038 backtest's real,
 * audited seasonal shape (`sell-timing-history-36038.ts`), scaled to `itemId`'s own live bid so
 * `recommendPosition` sees a plausible reference at the right order of magnitude, never 36038's
 * unscaled copper values standing in for a completely different item's price level.
 */
function syntheticDailyHistory(itemId: number, todayBidCopper: number): PriceHistoryDailyV1[] {
	const scale = todayBidCopper / FIXTURE_ANCHOR_BID_COPPER;
	return sellTimingHistoryBagDays().map((day) => {
		const bidCopper = Math.max(1, Math.round(day.bidCopper * scale));
		return {
			version: 1, vaultId: 'test-vault', itemId, dayUtc: day.dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
			bid: { count: 1, minCopper: bidCopper, maxCopper: bidCopper, medianCopperX2: bidCopper * 2, closeCopper: bidCopper, closeCapturedAtMs: 0 },
			ask: null,
		};
	});
}

describe('resolveSaleSeasonalInputFor: the calendar window really moves with the date', () => {
	it('resolves the pre-festival window (15 sep - 12 oct) on 26 sep, inside it', () => {
		const seasonal = resolveSaleSeasonalInputFor(36038, SEPT_26_MS);
		expect(seasonal?.window).toMatchObject({ seasonId: 'saco-halloween-antes-festival', opensOn: '09-15', closesOn: '10-12' });
	});

	it('resolves the May window on 14 oct, once the pre-festival window has closed and 2027 has no anchor yet', () => {
		const seasonal = resolveSaleSeasonalInputFor(36038, OCT_14_MS);
		expect(seasonal?.window).toMatchObject({ seasonId: 'saco-halloween-primavera', opensOn: '05-01', closesOn: '05-31' });
	});
});

/**
 * Product decision (coordinator, round 2, 26 sep 2026): Jorcamelo's (43320) curated calendar window
 * is a plain ANNUAL "1 jun - 30 jun" — confirmed real, audited data
 * (`inventory-advisor-builtin-bundle.ts`'s §5 verdict: "the festival is NOT this item's window...
 * keeps its plain annual June window"), unrelated to any Halloween anchor. On 26 sep, that window
 * already closed three months ago; before this fix the calendar showed it with no days-left text at
 * all rather than invent one for a stale date. Now it rolls to next year's SAME dates.
 */
describe('resolveSaleCalendarCandidateSpan: an annual window that already closed rolls to next year', () => {
	const ANNUAL_JUNE: FestivalCalendarCandidateV1 = {
		kind: 'annual',
		window: { version: 1, seasonId: 'jorcamelo-junio', opensOn: '06-01', closesOn: '06-30', returnsInMonth: 6 },
		auditRow: 'test',
	};

	it('on 26 sep (window already closed this year), resolves to next year\'s June, not this year\'s', () => {
		const span = resolveSaleCalendarCandidateSpan(ANNUAL_JUNE, new Map(), SEPT_26_MS);
		expect(span).toEqual({ fromDay: '2027-06-01', toDay: '2027-06-30' });
	});

	it('on 15 jun (inside the window), resolves to THIS year, never rolling forward mid-window', () => {
		const insideMs = Date.UTC(2026, 5, 15);
		const span = resolveSaleCalendarCandidateSpan(ANNUAL_JUNE, new Map(), insideMs);
		expect(span).toEqual({ fromDay: '2026-06-01', toDay: '2026-06-30' });
	});

	it('on 1 jan (window still ahead this year), resolves to THIS year, never a false rollover', () => {
		const beforeMs = Date.UTC(2026, 0, 1);
		const span = resolveSaleCalendarCandidateSpan(ANNUAL_JUNE, new Map(), beforeMs);
		expect(span).toEqual({ fromDay: '2026-06-01', toDay: '2026-06-30' });
	});
});

describe('saleOpenVsSellCopper: reads the curated container economy\'s own totals, never a new calculation', () => {
	it('converts the open EV from micro-copper to copper and passes the sell net through as-is', () => {
		const containerEconomy = {
			recommendation: { action: 'open' as const, quantity: 2350, ruleId: 'x' },
			recommendationBasis: 'liquid_only' as const,
			liquidOnly: {
				decision: { action: 'open' as const, quantity: 2350, ruleId: 'x' },
				explanation: {
					sellNow: { route: 'instant_sell', unitCopper: 342, grossCopper: 803700, listingFeeCopper: 40185, exchangeFeeCopper: 80370, totalFeesCopper: 120555, netCopper: 201 },
					open: { evPerContainerMicroCopper: 125_000, totalExpectedMicroCopper: '295000000', coverage: 'complete', noCounterpartyItemIds: [] },
					threshold: { minimumOfMaxBps: 9000 },
					comparison: { differenceMicroCopper: '94000000', advantageBps: 4676, rule: 'open_at_or_above_threshold' as const },
					freshness: { asOf: '2026-09-26T07:35:00.000Z', priceCapturedAt: '2026-09-26T07:30:00.000Z', priceAgeMs: 300000 },
					caveats: [], preferredSaleBasis: 'immediate' as const, routes: [], tail: null,
				},
			},
			personal: { valuation: { status: 'incomplete' }, openEvPerContainerMicroCopper: null, totalExpectedMicroCopper: null, decision: null, comparison: null },
		} as unknown as InventoryAdvisorViewRow['containerEconomy'];

		expect(saleOpenVsSellCopper(containerEconomy)).toEqual({ openCopper: 295, sellCopper: 201 });
	});

	it('is null when the advisor row carries no container economy at all', () => {
		expect(saleOpenVsSellCopper(null)).toBeNull();
		expect(saleOpenVsSellCopper(undefined)).toBeNull();
	});
});

describe('the Saco hero card verdict: real recommendPosition, real curated backtest, real DOM', () => {
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

	/** Isolated invocation of the private method, same pattern `main-sell-signal-wiring.test.ts` and `main.test.ts` already use for one-method cabling tests. */
	async function runComputeSaleHeroTiming(harness: {
		getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
		inventoryAdvisor: { analysis(): { source: { input: { prices: { items: { itemId: number; bid: { unitCopper: number } | null }[] } } } } | null };
		settings: { priceHistoryEnabled: boolean; priceHistoryDailyRetentionDays: number; recommendationCapitalThresholdCopper: number };
		priceHistory: { readDaily(itemId: number, fromDayUtc: string): Promise<PriceHistoryDailyV1[]> } | null;
		vaultId: string | null;
	}): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated harness below.
		const compute = (TyrianCompanionPlugin.prototype as unknown as {
			computeSaleHeroTiming(this: typeof harness): Promise<void>;
		}).computeSaleHeroTiming;
		await compute.call(harness);
	}

	it('says "Vender ahora" on 26 sep, inside the sale window, with today\'s bid below the 90% threshold', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(SEPT_26_MS);
		const harness = {
			getInventoryAdvisorViewModel: () => advisorModel(2350),
			inventoryAdvisor: { analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 342 } }] } } } }) },
			settings: { priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000 },
			priceHistory: { readDaily: async () => heroFixtureDaily() },
			vaultId: null,
			saleHeroTiming: null as unknown,
		};
		await runComputeSaleHeroTiming(harness);

		expect(harness.saleHeroTiming).toMatchObject({ action: 'sell', reason: 'no_demonstrated_wait_advantage' });

		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated harness below.
		const buildHero = (TyrianCompanionPlugin.prototype as unknown as {
			buildSaleHeroInput(this: typeof harness & { getSellSignalState(): null }, row: InventoryAdvisorViewRow | null, bidCopper: number | null): SaleViewModelInput['hero'];
		}).buildSaleHeroInput;
		const hero = buildHero.call({ ...harness, getSellSignalState: () => null }, heroRow(2350), 342);
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
		renderSaleView(container as unknown as HTMLElement, model, createTranslator('es'));
		expect(textOf(container)).toContain('Vender ahora');
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
		const harness = {
			getInventoryAdvisorViewModel: () => advisorModel(2350),
			inventoryAdvisor: { analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: floorBidCopper } }] } } } }) },
			settings: { priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000 },
			priceHistory: { readDaily: async () => heroFixtureDaily() },
			vaultId: null,
			saleHeroTiming: null as unknown,
		};
		await runComputeSaleHeroTiming(harness);

		expect(harness.saleHeroTiming).toMatchObject({
			action: 'sell_at_season', reason: 'wait_advantage_demonstrated',
			sellWindowFromDay: '2027-05-01', sellWindowToDay: '2027-05-31',
		});

		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated harness below.
		const buildHero = (TyrianCompanionPlugin.prototype as unknown as {
			buildSaleHeroInput(this: typeof harness & { getSellSignalState(): null }, row: InventoryAdvisorViewRow | null, bidCopper: number | null): SaleViewModelInput['hero'];
		}).buildSaleHeroInput;
		const hero = buildHero.call({ ...harness, getSellSignalState: () => null }, heroRow(2350), floorBidCopper);
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
		renderSaleView(container as unknown as HTMLElement, model, createTranslator('es'));
		const text = textOf(container);
		expect(text).toContain('Todavía no');
		expect(text).not.toContain('Vender ahora');
	});

	it('never fabricates a verdict for 0 owned units: the position is not a legendary reservation', async () => {
		const harness = {
			getInventoryAdvisorViewModel: () => advisorModel(0),
			inventoryAdvisor: { analysis: () => null },
			settings: { priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000 },
			priceHistory: { readDaily: async () => [] },
			vaultId: null,
			saleHeroTiming: 'sentinel' as unknown,
		};
		await runComputeSaleHeroTiming(harness);
		expect(harness.saleHeroTiming).toBeNull();
	});

	/**
	 * H18.34: `getSaleViewModel` recomputes `bundleLoad` fresh against `Date.now()` on every call, but
	 * `advisorModel.status` is whatever the LAST advisor refresh cached — it can still read `ready`
	 * well after the curated bundle's `validUntil`, because nothing forces a refresh the instant the
	 * clock crosses it. Before this fix, that left the Sale tab silently degrading to "Sin datos"
	 * (`resolveSaleSeasonalInputFor` returning null) with no explanation, unlike the Halloween price
	 * alert's own `out_of_season`, which always carries a dedicated, explained state. These run the
	 * real `getSaleViewModel` (not a hand-built `SaleViewModel`) through the isolated-method pattern
	 * this file already uses, then the real DOM (`renderSaleView`).
	 */
	describe('getSaleViewModel: an expired curated bundle is explained, never a silent "sin datos" (H18.34)', () => {
		const AFTER_VALID_UNTIL_MS = Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) + 1;

		function runGetSaleViewModel(harness: {
			runtimeReady: boolean;
			getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
			inventoryAdvisor: { analysis(): null };
			saleHeroTiming: unknown;
			getSellSignalState(): null;
		}): SaleViewModel {
			type Harness = typeof harness & { buildSaleHeroInput: unknown };
			const proto = TyrianCompanionPlugin.prototype as unknown as {
				getSaleViewModel(this: Harness): SaleViewModel;
				buildSaleHeroInput: unknown;
			};
			return proto.getSaleViewModel.call({ ...harness, buildSaleHeroInput: proto.buildSaleHeroInput });
		}

		function renderModel(model: SaleViewModel): string {
			vi.stubGlobal('createEl', (tag: string, options?: { text?: string; cls?: string }) => makeEl(tag, options));
			vi.stubGlobal('createDiv', (options?: { text?: string; cls?: string }) => makeEl('div', options));
			vi.stubGlobal('createSpan', (options?: { text?: string; cls?: string }) => makeEl('span', options));
			const container = makeEl('div');
			renderSaleView(container as unknown as HTMLElement, model, createTranslator('es'));
			return textOf(container);
		}

		it('shows the explained expiry, in the view-model AND the DOM, even while the cached advisor model still reads "ready"', () => {
			vi.useFakeTimers();
			vi.setSystemTime(AFTER_VALID_UNTIL_MS);
			const harness = {
				runtimeReady: true,
				// Deliberately stale: a real plugin would not necessarily have refreshed since validUntil
				// passed, and this is exactly the state that used to hide the caducity.
				getInventoryAdvisorViewModel: () => advisorModel(2350),
				inventoryAdvisor: { analysis: () => null },
				saleHeroTiming: null as unknown,
				getSellSignalState: () => null,
			};
			const model = runGetSaleViewModel(harness);

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
			const harness = {
				runtimeReady: true,
				getInventoryAdvisorViewModel: () => advisorModel(0),
				inventoryAdvisor: { analysis: () => null },
				saleHeroTiming: null as unknown,
				getSellSignalState: () => null,
			};
			const model = runGetSaleViewModel(harness);

			expect(model.rulesExpiredAtMs).toBeNull();
			expect(model.status).toBe('ready');
		});

		/**
		 * Sabotage: reverting the caducity check to trust only the cached `advisorModel.status` (the
		 * pre-fix behaviour) makes this fail on `expect(model.status).toBe('blocked')` — it stays
		 * `'ready'`, and the DOM assertion above fails on `expect(text).toContain('caducaron el')`
		 * because `renderSaleView` never reaches `renderBlocked` at all.
		 */
	});

	/**
	 * H18.35: the Asesor tab had the SAME silent-staleness gap H18.34 fixed on the Venta tab —
	 * `InventoryAdvisorPresentationController.open()` returns whatever the last refresh cached, and
	 * nothing forces a rebuild the instant the clock crosses the curated bundle's own `validUntil`.
	 * `getInventoryAdvisorViewModel` now re-checks live on every call, exactly like `getSaleViewModel`.
	 */
	describe('getInventoryAdvisorViewModel: a cached "ready" model is blocked once the live clock crosses validUntil (H18.35)', () => {
		const AFTER_VALID_UNTIL_MS = Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) + 1;

		function runGetInventoryAdvisorViewModel(harness: {
			runtimeReady: boolean;
			inventoryAdvisor: { open(): InventoryAdvisorViewModel };
		}): InventoryAdvisorViewModel {
			const proto = TyrianCompanionPlugin.prototype as unknown as {
				getInventoryAdvisorViewModel(this: typeof harness): InventoryAdvisorViewModel;
			};
			return proto.getInventoryAdvisorViewModel.call(harness);
		}

		/**
		 * Sabotage: reverting `getInventoryAdvisorViewModel` to `return this.inventoryAdvisor.open()`
		 * (the pre-fix behaviour, trusting only the cached controller result) makes this fail on
		 * `expect(model.status).toBe('blocked')` — it stays `'ready'`, with the stale row still in
		 * `model.groups`, exactly the silent staleness this fix removes.
		 */
		it('shows the explained expiry even while the cached advisor result still reads "ready"', () => {
			vi.useFakeTimers();
			vi.setSystemTime(AFTER_VALID_UNTIL_MS);
			const harness = {
				runtimeReady: true,
				// Deliberately stale: `InventoryAdvisorPresentationController.open()` reprojects the last
				// refresh's cache and never re-checks the bundle's own caducity on its own.
				inventoryAdvisor: { open: () => advisorModel(2350) },
			};
			const model = runGetInventoryAdvisorViewModel(harness);

			expect(model.status).toBe('blocked');
			expect(model.blockedReason).toBe('rules_expired');
			expect(model.groups).toEqual([]);
		});

		it('does not override a merely stale-cache "ready" before validUntil is actually reached', () => {
			vi.useFakeTimers();
			vi.setSystemTime(Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) - 1);
			const harness = { runtimeReady: true, inventoryAdvisor: { open: () => advisorModel(2350) } };
			const model = runGetInventoryAdvisorViewModel(harness);

			expect(model.status).toBe('ready');
			expect(model.groups).not.toEqual([]);
		});
	});
});

/**
 * Review fix (26 sep 2026): David's own screenshot of the "Sin datos" group showed "Puja por
 * unidad 4g 13s 45c" next to "Neto si vendes ya: Sin datos" — a live bid, but no net — for the same
 * row (Barra de caramelo, #47909). `row.marketComparison` (`advisor row → SaleSourceRow`) only
 * exists for a route the advisor already classified `sell`/`list`/`vendor`
 * (`marketComparisonsForLine`); a row still on `review` never gets one, even though `bidCopper`
 * comes from the account's own live price snapshot, set independently of that classification.
 */
describe('saleSourceRowFromAdvisorRow: a live bid always produces a net, even with no advisor market comparison', () => {
	const CANDY_BAR_ITEM_ID = 47909; // Barra de caramelo, David's real note: 71 units, bid ~4g13s45c.
	const REAL_BID_COPPER = 41_345;
	const REAL_OWNED_QUANTITY = 71;

	function reviewRow(): InventoryAdvisorViewRow {
		return {
			id: '#/sale/row/47909', itemId: CANDY_BAR_ITEM_ID, name: 'Barra de caramelo', icon: null,
			ownedQuantity: REAL_OWNED_QUANTITY, availableQuantity: REAL_OWNED_QUANTITY, action: 'review', quantity: REAL_OWNED_QUANTITY,
			allocations: [{ positionRef: '#/positions/47909/0', quantity: REAL_OWNED_QUANTITY, location: { source: 'materials', category: 1 } }],
			reasonCodes: [], protectionReasons: [], value: { status: 'not_applicable', route: null },
			// The advisor never computed a comparison for a `review` route: exactly David's real case.
			marketComparison: null, burden: null,
			coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
			irreversibleReviewOnly: false, discardProof: null,
		};
	}

	it('computes an instant-sell net from the bid itself, never leaving it null just because the route stalled on review', () => {
		const result = saleSourceRowFromAdvisorRow(reviewRow(), REAL_BID_COPPER);
		expect(result.bidCopper).toBe(REAL_BID_COPPER);
		expect(result.instantSellNetCopper).not.toBeNull();
		expect(result.instantSellNetCopper).toBeGreaterThan(0);
	});

	/**
	 * Sabotage: reverting `saleSourceRowFromAdvisorRow`'s `instantSellNetCopper` to
	 * `row.marketComparison?.instantSellCopper ?? null` (dropping the `computeInstantSellNetCopper`
	 * fallback) makes this fail on `expect(result.instantSellNetCopper).not.toBeNull()`.
	 */
	it('never shows the "no quote" badge for a row that carries a real bid, once fed through the real view model', () => {
		const sourceRow = saleSourceRowFromAdvisorRow(reviewRow(), REAL_BID_COPPER);
		const model = buildSaleViewModel({
			status: 'ready', nowMs: Date.UTC(2026, 8, 26), festivalStartMs: null, maxPriceAgeMs: 900_000,
			hero: null, rows: [sourceRow], calendar: [],
		});
		const rendered = [...model.groups.now, ...model.groups.wait, ...model.groups.noData]
			.find((row) => row.itemId === CANDY_BAR_ITEM_ID);
		expect(rendered).toBeDefined();
		expect(rendered?.action).not.toBe('no_data');
		expect(rendered?.instantSellNetCopper).not.toBeNull();
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
 * The full rendered text is dumped to the scratchpad for a line-by-line human check.
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
	 * Coordinator round 2, points 2 and 6: no more hand-copied decisions from notes written BEFORE
	 * this review's fixes — every row (hero included, via `computeSaleHeroTiming` below) runs the
	 * SAME real `recommendPosition`, fed the real calendar (`resolveSaleSeasonalInputFor`) and a
	 * synthetic-but-scaled history (`syntheticDailyHistory`) standing in for what Fix A now actually
	 * asks datawars2 for. A stale note's `review`/`no_close_today` (48805) or `review`/
	 * `insufficient_reference` (36038) cannot survive this: either the code, run today, still
	 * produces it — and the text is judged as-is — or it does not, and the note was simply stale.
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
			priceHistoryDaily: todayBidCopper === null ? [] : syntheticDailyHistory(itemId, todayBidCopper),
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

		const harness = {
			runtimeReady: true,
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
			settings: { priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000 },
			// Simulates the state Fix A reaches after a real sync seeds 36038's datawars2 history: the
			// full curated backtest is what `readDaily` returns (this file's OWN sanctioned fixture).
			priceHistory: { readDaily: async () => heroFixtureDaily() },
			vaultId: null,
			saleHeroTiming: null as unknown,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicitly invoked with the isolated harness below.
		const compute = (TyrianCompanionPlugin.prototype as unknown as {
			computeSaleHeroTiming(this: typeof harness): Promise<void>;
		}).computeSaleHeroTiming;
		await compute.call(harness);
		// The whole point of Fix A: with real history available, the hero gets a REAL verdict, never
		// `review`/`insufficient_reference` (David's exact reported contradiction).
		expect((harness.saleHeroTiming as { action: string } | null)?.action).not.toBe('review');
		// Point 6: every row's decision comes from the same real function run just now, not a note.
		for (const row of [CANDY_BAR, JORCAMELO, FANGS_PREMIUM, CANDY_PIECE]) {
			expect(row.decision).toBeDefined();
			expect(row.decision?.action).not.toBe('review');
		}

		type Harness = typeof harness & { buildSaleHeroInput: unknown; getSellSignalState(): null };
		const proto = TyrianCompanionPlugin.prototype as unknown as {
			getSaleViewModel(this: Harness): SaleViewModel;
			buildSaleHeroInput: unknown;
		};
		const model = proto.getSaleViewModel.call({ ...harness, buildSaleHeroInput: proto.buildSaleHeroInput, getSellSignalState: () => null });

		vi.stubGlobal('createEl', (tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) => makeEl(tag, options));
		vi.stubGlobal('createDiv', (options?: { text?: string; cls?: string; attr?: Record<string, string> }) => makeEl('div', options));
		vi.stubGlobal('createSpan', (options?: { text?: string; cls?: string; attr?: Record<string, string> }) => makeEl('span', options));
		const container = makeEl('div');
		renderSaleView(container as unknown as HTMLElement, model, createTranslator('es'));

		const lines = textOf(container).split('\n').filter((line) => line.trim() !== '');
		const dump = lines.join('\n');
		const dumpPath = '/tmp/claude-1000/-home-fodaveg-code-tyrian-companion/d3671ce6-a44c-4f1c-8165-fef8a1aaa2c8/scratchpad/venta-render-real.txt';
		writeFileSync(dumpPath, dump, 'utf8');

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
	 * at all — `getSaleViewModel`'s own filter (`main.ts`): `if (itemId === HALLOWEEN_PRICE_ALERT_
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
