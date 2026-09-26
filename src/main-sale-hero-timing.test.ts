import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { createTranslator } from './core/i18n';
import TyrianCompanionPlugin, { resolveSaleSeasonalInputFor, saleOpenVsSellCopper } from './main';
import { sellTimingHistoryBagDays } from './economy/__fixtures__/sell-timing-history-36038';
import type { PriceHistoryDailyV1 } from './economy/price-history-model';
import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './ui/inventory-advisor-view-model';
import { buildSaleViewModel, type SaleViewModelInput } from './ui/sale-view-model';
import { renderSaleView } from './ui/sale-view';

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
