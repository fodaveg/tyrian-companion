import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { storageDeltaSnapshot, looseHolding } from './account/__fixtures__/storage-delta';
import {
	TyrianCompanionCore,
	resolveSaleCalendarCandidateSpan,
	resolveSaleSeasonalInputFor,
	saleOpenVsSellCopper,
	saleSourceRowFromAdvisorRow,
	saleBagSlotsUsed,
} from './runtime/tyrian-companion-core';
import type { FestivalCalendarCandidateV1 } from './economy/seasonal-window';
import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './ui/inventory-advisor-view-model';
import { buildSaleViewModel } from './ui/sale-view-model';
import { INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL } from './advisor/inventory-advisor-builtin-bundle';

/**
 * The Sale tab's calendar and row helpers, and the Asesor tab's live expiry check, as the core
 * re-exports and runs them. The hero card's verdict, `getSaleViewModel` and the acceptance render
 * of the real Halloween inventory moved with `SaleRuntime` to `src/runtime/sale-runtime.test.ts`
 * (DE-01, step 2).
 */

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const SEPT_26_MS = Date.UTC(2026, 8, 26, 7, 35, 0);
const OCT_14_MS = Date.UTC(2026, 9, 14, 19, 10, 0);

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
			const proto = TyrianCompanionCore.prototype as unknown as {
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

describe('sale bag liberation producer', () => {
	it('counts fully allocated selected-character bag stacks once, excluding bank, other characters and partial stacks', () => {
		const holding = (character: string, quantity: number) => looseHolding(36038, quantity, { source: 'character', character, container: 'bag', bagIndex: 0, slot: 0 });
		const holdings = [holding('Astra Uno', 20), holding('Other', 20), looseHolding(36038, 20, { source: 'bank', slot: 0 }), holding('Astra Uno', 20)];
		const snapshot = storageDeltaSnapshot({ holdings });
		const row = { allocations: holdings.map((entry, index) => ({ positionRef: `#/positions/36038/${String(index)}`, quantity: index === 3 ? 10 : entry.quantity, location: entry.location })) };
		row.allocations.push({ ...row.allocations[0]! });
		expect(saleBagSlotsUsed(row, snapshot, 'Astra Uno')).toBe(1);
		expect(saleBagSlotsUsed(row, snapshot, null)).toBeNull();
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
describe('saleSourceRowFromAdvisorRow: instant proceeds require depth-aware valuation', () => {
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

	it('keeps the unit bid but never extrapolates a full stack net when depth is unknown', () => {
		const result = saleSourceRowFromAdvisorRow(reviewRow(), REAL_BID_COPPER);
		expect(result.bidCopper).toBe(REAL_BID_COPPER);
		expect(result.instantSellNetCopper).toBeNull();
	});

	it('reuses the exact position valuation even when the route has no market comparison', () => {
		const row = reviewRow();
		row.value = { status: 'available', route: 'instant_sell', copper: 2_501_205 };
		expect(saleSourceRowFromAdvisorRow(row, REAL_BID_COPPER).instantSellNetCopper).toBe(2_501_205);
		row.quantity = 1;
		expect(saleSourceRowFromAdvisorRow(row, REAL_BID_COPPER).instantSellNetCopper).toBeNull();
	});

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
		expect(rendered?.instantSellNetCopper).toBeNull();
	});
});
