import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';
import type { InventoryAdvisorViewRow } from './inventory-advisor-view-model';
import { SaleItemView, type SaleViewActions } from './sale-item-view';
import { renderSaleView } from './sale-view';
import { buildSaleViewModel, type SaleSourceRow, type SaleViewModel, type SaleViewModelInput } from './sale-view-model';

/**
 * The «Detalles» of a Venta row (`sale-row-details.ts`): the Inventory tab's own disclosure and its
 * price block, on a page that is rebuilt on every repaint. COUNT tests, like the block's own: how
 * many requests, chart containers and nodes a state costs, and what a repaint of the page keeps.
 */

afterEach(() => vi.unstubAllGlobals());

const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };
const translator = createTranslator('en');
const NOW_MS = Date.UTC(2026, 8, 26, 7, 38, 0);
const FANGS = 48_805;
const CANDY_CORN = 43_320;
const SACO = 36_038;

describe('the «Detalles» of the Venta rows', () => {
	it('every row and the hero card carry the advisor\'s disclosure, closed, with nothing but its summary', () => {
		const page = sale({ enabled: true, seed: seeded(120), hero: true });

		const details = page.details();
		expect(details).toHaveLength(3);
		for (const detail of details) {
			expect(detail.open).toBe(false);
			expect(detail.children.map((child) => child.tag)).toEqual(['summary']);
			expect(detail.children[0]!.textContent).toBe(translator.t('advisor.view.list.detailsSummary'));
		}
		// Under the four cells of its row; after the quote line of the hero card.
		expect(page.rows().every((row) => row.children.at(-1)?.className === 'tyrian-inventory__more')).toBe(true);
		expect(page.hero().children.at(-1)?.className).toBe('tyrian-inventory__more');
		expect(page.blocks()).toHaveLength(0);
		expect(page.ensureSeed).toHaveBeenCalledTimes(0);
	});

	it('a host without price history paints no disclosure at all', () => {
		const page = sale({ enabled: true, seed: seeded(120), hero: true, withoutSource: true });

		expect(page.details()).toHaveLength(0);
		expect(page.rows()).toHaveLength(2);
	});

	it('history off: opening says what is missing, offers the opt-in with its effect, and asks for nothing', () => {
		const page = sale({ enabled: false });

		page.toggle(0, true);

		const block = only(page.blocks());
		expect(texts(block)).toContain(translator.t('advisor.priceHistory.off'));
		// Venta has no general opt-in banner, so the row itself says what turning it on does.
		expect(texts(block)).toContain(translator.t('view.optIn.priceHistory.effect'));
		const enable = only(buttons(block));
		expect(enable.textContent).toBe(translator.t('view.optIn.priceHistory.enable'));
		expect(enable.disabled).toBe(false);
		expect(statusRole(block)).toBe('status');
		expect(page.ensureSeed).toHaveBeenCalledTimes(0);
		expect(page.getSeed).toHaveBeenCalledTimes(0);

		enable.dispatch('click');
		expect(page.onEnable).toHaveBeenCalledTimes(1);
	});

	it('history off in consult mode: the button is disabled and the reason is on screen', () => {
		const page = sale({ enabled: false, consultOnly: true });

		page.toggle(0, true);

		expect(only(buttons(only(page.blocks()))).disabled).toBe(true);
		expect(texts(only(page.blocks()))).toContain(translator.t('productAction.reason.consult'));
	});

	it('with data: opening asks for THAT row\'s item once and draws the chart, named, with the row windows', () => {
		const page = sale({ enabled: true, seed: seeded(300) });

		page.toggle(0, true);

		expect(page.ensureSeed).toHaveBeenCalledTimes(1);
		expect(page.ensureSeed).toHaveBeenCalledWith(FANGS);
		const block = only(page.blocks());
		expect(walk(block).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
		const figure = only(walk(block).filter((element) => element.tag === 'figure'));
		expect(figure.attributes.get('aria-label')).toBe(translator.t('advisor.priceHistory.chartLabel', { name: 'High-quality plastic fangs' }));
		expect(texts(block)).toContain(translator.t('advisor.priceHistory.legend'));
		expect(buttons(block).map((button) => button.textContent)).toEqual(['3 months', '1 year', 'All']);
		expect(pressed(block)).toEqual(['3 months']);
		// The other row stays closed and asks for nothing.
		expect(page.details()[1]!.open).toBe(false);
	});

	it('loading: one status line, no chart', () => {
		const page = sale({ enabled: true, seed: idle() });

		page.toggle(0, true);

		expect(texts(only(page.blocks()))).toContain(translator.t('advisor.priceHistory.loading'));
		expect(walk(page.container).filter((element) => element.tag === 'svg')).toHaveLength(0);
	});

	it('no market: one line, no chart, nothing requested and no opt-in even with history off', () => {
		for (const enabled of [true, false]) {
			const page = sale({ enabled, seed: idle(), noMarket: true });

			page.toggle(0, true);

			expect(texts(only(page.blocks()))).toContain(translator.t('advisor.priceHistory.none'));
			expect(buttons(only(page.blocks()))).toHaveLength(0);
			expect(page.ensureSeed).toHaveBeenCalledTimes(0);
		}
	});

	it('a failed download: an alert and Retry; a local store that cannot open too', () => {
		const failed = sale({ enabled: true, seed: { ...idle(), status: 'no_seed', failureReason: 'unreachable' } });
		failed.toggle(0, true);
		expect(statusRole(only(failed.blocks()))).toBe('alert');
		expect(texts(only(failed.blocks()))).toContain(translator.t('advisor.priceHistory.failed'));
		expect(only(buttons(only(failed.blocks()))).textContent).toBe(translator.t('advisor.priceHistory.retry'));

		const store = sale({ enabled: true, seed: { ...idle(), status: 'store_unavailable' } });
		store.toggle(0, true);
		expect(statusRole(only(store.blocks()))).toBe('alert');
		expect(texts(only(store.blocks()))).toContain(translator.t('priceHistoryNote.state.unavailable'));
	});

	it('a repaint of the page keeps the open detail open, with the same block and chart, its zoom, and no second request', () => {
		const page = sale({ enabled: true, seed: seeded(300) });
		page.toggle(0, true);
		const block = only(page.blocks());
		const chart = chartContainer(block);
		windowButton(block, '1 year').dispatch('click');

		for (let index = 0; index < 5; index += 1) page.repaint();

		expect(page.details()[0]!.open).toBe(true);
		expect(only(page.blocks())).toBe(block);
		expect(chartContainer(block)).toBe(chart);
		expect(windowButton(block, '1 year').attributes.get('aria-pressed')).toBe('true');
		expect(page.ensureSeed).toHaveBeenCalledTimes(1);
		// The other row came back closed.
		expect(page.details()[1]!.open).toBe(false);
	});

	it('a repaint that finds the history switched on reaches the block that is already open', () => {
		const page = sale({ enabled: false, seed: seeded(40) });
		page.toggle(0, true);
		expect(page.ensureSeed).toHaveBeenCalledTimes(0);

		page.source.enabled = true;
		page.repaint();

		expect(page.ensureSeed).toHaveBeenCalledTimes(1);
		expect(walk(only(page.blocks())).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
	});

	it('closing drops the block; opening again asks once more (the host\'s cache answers)', () => {
		const page = sale({ enabled: true, seed: seeded(120) });
		page.toggle(0, true);

		page.toggle(0, false);
		expect(page.blocks()).toHaveLength(0);
		expect(walk(page.container).filter((element) => element.tag === 'figure')).toHaveLength(0);
		expect(page.details()[0]!.children.map((child) => child.tag)).toEqual(['summary']);

		page.toggle(0, true);
		expect(page.ensureSeed).toHaveBeenCalledTimes(2);
		expect(page.blocks()).toHaveLength(1);
	});

	it('a row that leaves the page takes its block with it; back on the page, its detail starts closed with a new block', () => {
		const page = sale({ enabled: true, seed: seeded(120) });
		page.toggle(0, true);
		const block = only(page.blocks());

		page.setModel(model({ rows: [row({ itemId: CANDY_CORN, name: 'Candy corn' })] }));
		page.repaint();
		expect(page.blocks()).toHaveLength(0);
		expect(page.details()).toHaveLength(1);

		page.setModel(model());
		page.repaint();
		expect(page.details()).toHaveLength(2);
		expect(page.details().every((detail) => !detail.open && detail.children.length === 1)).toBe(true);
		expect(page.ensureSeed).toHaveBeenCalledTimes(1);

		// Opened again: a fresh block (the old one was disposed, not kept) and its own request.
		page.toggle(0, true);
		expect(only(page.blocks())).not.toBe(block);
		expect(page.ensureSeed).toHaveBeenCalledTimes(2);
	});

	it('twenty repaints of the page with an open chart create no chart node and ask nothing more', () => {
		const page = sale({ enabled: true, seed: seeded(300) });
		page.toggle(0, true);

		const created = countCreatedNodes(() => { for (let index = 0; index < 20; index += 1) page.repaint(); }, CHART_TAGS);

		expect(created).toBe(0);
		expect(page.ensureSeed).toHaveBeenCalledTimes(1);
	});

	it('an empty list paints no detail, and drops whatever an earlier paint kept open', () => {
		const page = sale({ enabled: true, seed: seeded(120) });
		page.toggle(0, true);

		page.setModel(model({ status: 'empty', rows: [] }));
		page.repaint();

		expect(page.details()).toHaveLength(0);
		expect(page.blocks()).toHaveLength(0);
		expect(texts(page.container)).toContain(translator.t('sale.view.empty'));
	});

	it('a page that is loading, blocked or consult-only has no rows and so no detail', () => {
		for (const input of [
			{ status: 'loading' as const },
			{ status: 'blocked' as const },
			{ status: 'empty' as const, consultOnly: true },
		]) {
			const page = sale({ enabled: true, seed: seeded(120), model: model({ ...input, rows: [] }) });
			expect(page.details()).toHaveLength(0);
		}
	});

	it('the summary that had the focus gets it back after a repaint', () => {
		const page = sale({ enabled: true, seed: seeded(120) });
		const summary = page.details()[1]!.children[0]!;
		summary.focus();
		expect(page.document.activeElement).toBe(summary);

		page.repaint();

		const next = page.details()[1]!.children[0]!;
		expect(next).not.toBe(summary);
		expect(page.document.activeElement).toBe(next);
	});

	it('a zoom button of an open block that had the focus keeps it across a repaint', () => {
		const page = sale({ enabled: true, seed: seeded(300) });
		page.toggle(0, true);
		const button = windowButton(only(page.blocks()), '1 year');
		button.focus();

		page.repaint();

		expect(page.document.activeElement).toBe(button);
	});
});

describe('the body of a Venta row\'s «Detalles»: the Inventory tab\'s own', () => {
	it('with the advisor row: the facts list, the chart right under it and the sub-details, in the advisor\'s order', () => {
		const page = sale({ enabled: true, seed: seeded(300), advisorRow: advisorRow() });

		page.toggle(0, true);

		const detail = page.details()[0]!;
		expect(detail.children.map((child) => `${child.tag}.${child.className}`)).toEqual([
			'summary.', 'dl.', 'div.tyrian-inventory__price-history', 'dl.tyrian-inventory-advisor__row-context', 'details.tyrian-inventory-advisor__advanced-evidence',
		]);
		const facts = detail.children[1]!;
		expect(facts.children.filter((child) => child.tag === 'dt').map((child) => child.textContent)).toEqual([
			translator.t('advisor.view.list.headExplanation'), translator.t('advisor.view.owned'), translator.t('advisor.view.unitValue'),
			translator.t('advisor.view.location'), translator.t('advisor.view.evidence'),
		]);
		const owned = facts.children[facts.children.findIndex((child) => child.textContent === translator.t('advisor.view.owned')) + 1]!;
		expect(owned.textContent).toBe('3');
		expect(texts(detail.children[3]!)).toContain(translator.t('advisor.view.marketComparison.instant'));
		expect(texts(detail.children[4]!)).toContain(translator.t('advisor.view.advancedDetails'));
		expect(walk(detail).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
	});

	it('paints neither «Ver en Venta» nor the value concentration: one leads here, the other is the Inventory list\'s own', () => {
		const page = sale({ enabled: true, seed: seeded(30), advisorRow: { ...advisorRow(), containerEconomy: undefined } });

		page.toggle(0, true);

		const detail = page.details()[0]!;
		expect(walk(detail).filter((element) => element.className === 'mod-link')).toHaveLength(0);
		expect(texts(detail)).not.toContain(translator.t('advisor.view.list.viewInSale'));
		expect(texts(detail)).not.toContain(translator.t('sale.row.head.value'));
	});

	it('a repaint paints the facts again, once, around the same chart', () => {
		const page = sale({ enabled: true, seed: seeded(300), advisorRow: advisorRow() });
		page.toggle(0, true);
		const chart = chartContainer(only(page.blocks()));

		page.repaint();
		page.repaint();

		const detail = page.details()[0]!;
		expect(detail.open).toBe(true);
		expect(detail.children.filter((child) => child.tag === 'dl' && child.className === '')).toHaveLength(1);
		expect(chartContainer(only(page.blocks()))).toBe(chart);
		expect(page.ensureSeed).toHaveBeenCalledTimes(1);
	});

	it('with little space in the selected character\'s bags the body says what the row frees, named', () => {
		const page = sale({
			enabled: true, seed: seeded(30),
			model: model({
				storageSpace: {
					bags: { free: 5, total: 160 }, bank: { free: 4, total: 210 }, sharedInventory: { free: 0, total: 6 },
					lowSpace: { freeSlots: 9, totalSlots: 376, thresholdFreeSlots: 20, isLow: true },
					materialCapacity: null, bagCharacter: { character: 'Beta', source: 'addon' },
				},
				rows: [row({ itemId: FANGS, name: 'High-quality plastic fangs', bagSlotsUsed: 2, advisorRow: { ...advisorRow(), slotsFreed: 2 } })],
			}),
		});

		page.toggle(0, true);

		const context = only(walk(page.details()[0]!).filter((element) => element.className === 'tyrian-inventory-advisor__row-context'));
		expect(texts(context)).toContain(translator.t('advisor.view.slotsFreed.label'));
		expect(texts(context)).toContain(translator.t('advisor.view.slotsFreed.namedMany', { count: 2, character: 'Beta' }));
	});

	it('without the advisor row (a hero with no account row) the body is the block alone', () => {
		const page = sale({ enabled: true, seed: seeded(30) });

		page.toggle(0, true);

		expect(page.details()[0]!.children.map((child) => child.tag)).toEqual(['summary', 'div']);
	});
});

describe('SaleItemView and the rows\' «Detalles»', () => {
	it('with the host\'s price-history actions the rows carry the detail, off while the runtime says disabled', async () => {
		const host = view({ status: 'disabled' });
		await host.view.onOpen();

		host.toggle(0, true);
		const block = only(host.blocks());
		expect(texts(block)).toContain(translator.t('advisor.priceHistory.off'));
		expect(host.ensurePriceHistorySeed).toHaveBeenCalledTimes(0);

		only(buttons(block)).dispatch('click');
		expect(host.enablePriceHistory).toHaveBeenCalledTimes(1);
		// Busy while the enable runs: the repaint keeps the detail open and disables its button.
		expect(host.details()[0]!.open).toBe(true);
		expect(only(buttons(only(host.blocks()))).disabled).toBe(true);

		host.state.status = 'ready';
		host.finishEnable();
		await flush();
		// On now: the block asks for the seed and shows it loading, with no button to press.
		expect(host.ensurePriceHistorySeed).toHaveBeenCalledTimes(1);
		expect(host.ensurePriceHistorySeed).toHaveBeenCalledWith(FANGS);
		expect(texts(only(host.blocks()))).toContain(translator.t('advisor.priceHistory.loading'));
	});

	it('in consult the row\'s enable button is disabled with the reason', async () => {
		const host = view({ status: 'disabled', collectorMode: 'consult' });
		await host.view.onOpen();

		host.toggle(0, true);

		expect(only(buttons(only(host.blocks()))).disabled).toBe(true);
		expect(texts(only(host.blocks()))).toContain(translator.t('productAction.reason.consult'));
	});

	it('without the host\'s actions the rows carry no detail', async () => {
		const host = view(null);
		await host.view.onOpen();

		expect(host.details()).toHaveLength(0);
		expect(host.rows()).toHaveLength(2);
	});

	it('closing the view drops the open blocks; opened again, every detail starts closed', async () => {
		const host = view({ status: 'ready' });
		await host.view.onOpen();
		host.toggle(0, true);
		expect(host.ensurePriceHistorySeed).toHaveBeenCalledTimes(1);

		await host.view.onClose();
		await host.view.onOpen();

		expect(host.details()[0]!.open).toBe(false);
		expect(host.blocks()).toHaveLength(0);
		expect(host.ensurePriceHistorySeed).toHaveBeenCalledTimes(1);
	});
});

interface SaleSetup {
	enabled: boolean;
	consultOnly?: boolean;
	seed?: PriceHistoryPanelSeedState;
	hero?: boolean;
	noMarket?: boolean;
	withoutSource?: boolean;
	model?: SaleViewModel;
	/** The Inventory tab's row of the first Venta row, when its body is the advisor's. */
	advisorRow?: InventoryAdvisorViewRow;
}

function sale(setup: SaleSetup) {
	const document = installDom();
	const container = new FakeElement('div', document);
	const seed = { current: setup.seed ?? idle() };
	const source = { enabled: setup.enabled, consultOnly: setup.consultOnly, busy: false };
	const ensureSeed = vi.fn((): void | Promise<void> => undefined);
	const getSeed = vi.fn(() => seed.current);
	const onEnable = vi.fn();
	let current = setup.model ?? model({ withHero: setup.hero, noMarket: setup.noMarket, advisorRow: setup.advisorRow });
	const paint = (): void => renderSaleView(container as unknown as HTMLElement, icons, current, translator, {
		rowDetails: setup.withoutSource === true ? undefined : {
			priceHistory: () => ({ ...source, getSeed, ensureSeed, onEnable }),
			translator: () => translator,
		},
	});
	paint();
	return {
		container, document, seed, source, ensureSeed, getSeed, onEnable,
		repaint: paint,
		setModel: (next: SaleViewModel): void => { current = next; },
		...queries(container),
	};
}

interface ViewSetup {
	status: PriceHistoryRuntimeState['status'];
	collectorMode?: 'collector' | 'consult';
}

function view(setup: ViewSetup | null) {
	const document = installDom();
	const content = new FakeElement('div', document);
	const current = model();
	const state = { status: setup?.status ?? 'disabled' };
	let finish: () => void = () => undefined;
	const enablePriceHistory = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
	const ensurePriceHistorySeed = vi.fn(async () => undefined);
	const actions: SaleViewActions = {
		getSaleLocale: () => 'en',
		getSaleViewModel: () => current,
		...(setup === null ? {} : {
			getPriceHistoryState: () => ({ status: state.status } as PriceHistoryRuntimeState),
			enablePriceHistory,
			ensurePriceHistorySeed,
			getPriceHistorySeedState: () => idle(),
			getCollectorMode: () => setup.collectorMode ?? 'collector',
		}),
	};
	return {
		view: new SaleItemView(content as unknown as HTMLElement, icons, actions),
		state, enablePriceHistory, ensurePriceHistorySeed,
		finishEnable: (): void => { finish(); },
		...queries(content),
	};
}

function queries(root: FakeElement) {
	const details = (): FakeElement[] => walk(root).filter((element) => element.className === 'tyrian-inventory__more');
	return {
		details,
		rows: (): FakeElement[] => walk(root).filter((element) => element.className === 'tyrian-sale__row'),
		hero: (): FakeElement => only(walk(root).filter((element) => element.className.includes('tyrian-sale__card--hero'))),
		blocks: (): FakeElement[] => walk(root).filter((element) => element.className === 'tyrian-inventory__price-history'),
		/** Opens or closes the detail at `index` the way a reader does: the click on the summary, then the browser's toggle. */
		toggle: (index: number, open: boolean): void => {
			const detail = details()[index]!;
			if (open) detail.children[0]!.dispatch('click');
			detail.open = open;
			detail.dispatch('toggle');
		},
	};
}

/** Lets the enable's promise chain (the action, then the view's own repaint) settle. */
async function flush(): Promise<void> { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }

function row(overrides: Partial<SaleSourceRow> & Pick<SaleSourceRow, 'itemId' | 'name'>): SaleSourceRow {
	return {
		id: `#/row/${String(overrides.itemId)}`, icon: null, ownedQuantity: 3, slotsUsed: 1,
		materialStorageEligible: false, decision: null, bidCopper: null, instantSellNetCopper: null, listingNetCopper: null,
		...overrides,
	};
}

function model(overrides: Partial<SaleViewModelInput> & { withHero?: boolean; noMarket?: boolean; advisorRow?: InventoryAdvisorViewRow } = {}): SaleViewModel {
	const { withHero, noMarket, advisorRow, ...input } = overrides;
	return buildSaleViewModel({
		status: 'ready', nowMs: NOW_MS, festivalStartMs: Date.UTC(2026, 9, 13), maxPriceAgeMs: 900_000,
		hero: withHero === true
			? { ...row({ itemId: SACO, name: 'Trick-or-Treat Bag', ownedQuantity: 2_350, slotsUsed: 10, bidCopper: 342 }), yearThresholdCopper: null, openVsSell: null }
			: null,
		rows: [
			row({
				itemId: FANGS, name: 'High-quality plastic fangs', hasMarket: noMarket !== true,
				decision: { action: 'sell', reason: 'seasonal_sell_window', until: null, priceQuotedAt: null, sellWindowFromDay: '2026-09-22', sellWindowToDay: '2026-10-19' },
				...(advisorRow === undefined ? {} : { advisorRow }),
			}),
			row({ itemId: CANDY_CORN, name: 'Candy corn', decision: { action: 'hold', reason: 'no_demonstrated_wait_advantage', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null } }),
		],
		calendar: [],
		...input,
	});
}

/** The Inventory tab's row of the fangs: a market comparison (a context list) and one limited axis (an advanced disclosure). */
function advisorRow(): InventoryAdvisorViewRow {
	const state = 'complete' as const;
	return {
		id: '#/explanations/0/0', itemId: FANGS, name: 'High-quality plastic fangs', icon: null,
		ownedQuantity: 3, availableQuantity: 3, action: 'sell', quantity: 3,
		allocations: [{ positionRef: '#/positions/0', quantity: 3, location: { source: 'bank', slot: 1 } }],
		reasonCodes: ['rule_missing'], protectionReasons: [],
		value: { status: 'available', copper: 4_000, route: 'instant_sell' },
		marketComparison: { instantSellCopper: 34, listingCopper: 51, differenceCopper: 17, differenceBasisPoints: 5_000 },
		burden: null,
		coverage: { snapshot: state, inventory: state, catalog: state, prices: 'limited', reservations: state, accountSignals: state, rules: state },
		irreversibleReviewOnly: false, discardProof: null,
	};
}

function idle(): PriceHistoryPanelSeedState {
	return { status: 'idle', itemId: FANGS, days: [], failureReason: null, retrievedAt: null };
}

function seeded(count: number): PriceHistoryPanelSeedState {
	const days: PriceSeedDayV1[] = Array.from({ length: count }, (_unused, index) => ({
		dayUtc: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
		bidCopper: 10 + index, askCopper: 1_000 + index,
	}));
	return { status: 'seeded', itemId: FANGS, days, failureReason: null, retrievedAt: '2026-10-07T00:00:00.000Z' };
}

/** The elements of the chart's own container: the one the widget keys its zoom by. */
function chartContainer(root: FakeElement): FakeElement {
	return only(walk(root).filter((element) => element.className.split(' ').includes('tyrian-inventory__price-history-chart')));
}

function windowButton(root: FakeElement, label: string): FakeElement {
	return only(walk(root).filter((element) => element.tag === 'button' && element.textContent === label));
}

/** The labels of the zoom windows that are pressed. */
function pressed(root: FakeElement): string[] {
	return walk(root)
		.filter((element) => element.tag === 'button' && element.attributes.get('aria-pressed') === 'true')
		.map((element) => element.textContent ?? '');
}

function buttons(root: FakeElement): FakeElement[] {
	return walk(root).filter((element) => element.tag === 'button');
}

function texts(root: FakeElement): string[] {
	return walk(root).map((element) => element.textContent).filter((text): text is string => text !== null && text.length > 0);
}

/** The `role` of the first status line of the block. */
function statusRole(root: FakeElement): string | undefined {
	return walk(root).find((element) => element.className === 'tyrian-inventory__price-history-state')?.attributes.get('role');
}

function only<T>(items: readonly T[]): T {
	const item = items[0];
	if (items.length !== 1 || item === undefined) throw new Error(`Expected one item, received ${String(items.length)}.`);
	return item;
}

/** What a chart or a figure is made of: what a repaint of the page must not rebuild. */
const CHART_TAGS: ReadonlySet<string> = new Set(['figure', 'figcaption', 'svg', 'polyline', 'line', 'text', 'circle']);

/** Nodes of the given tags `work` asks the host to create. */
function countCreatedNodes(work: () => void, only: ReadonlySet<string>): number {
	let created = 0;
	const original = FakeElement.onCreate;
	FakeElement.onCreate = (element) => { if (only.has(element.tag)) created += 1; };
	try { work(); } finally { FakeElement.onCreate = original; }
	return created;
}

function installDom(): FakeDocument {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string, options?: FakeOptions) => new FakeElement(tag, document, options));
	vi.stubGlobal('createDiv', (options?: FakeOptions) => new FakeElement('div', document, options));
	vi.stubGlobal('createSpan', (options?: FakeOptions) => new FakeElement('span', document, options));
	return document;
}

function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }

interface FakeOptions { cls?: string; text?: string; attr?: Record<string, string> }

class FakeDocument {
	activeElement: FakeElement | null = null;
	hidden = false;
	private readonly listeners = new Map<string, Set<() => void>>();
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
	}
	removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}

type FakeListener = (event: { preventDefault(): void }) => void;

/** Obsidian's element helpers plus what the disclosure, the block and the chart touch of the DOM. */
class FakeElement {
	static onCreate: ((element: FakeElement) => void) | null = null;
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, FakeListener[]>();
	parent: FakeElement | null = null;
	className = '';
	id = '';
	textContent: string | null = null;
	type = '';
	disabled = false;
	open = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? null;
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
		FakeElement.onCreate?.(this);
	}

	get tagName(): string { return this.tag.toUpperCase(); }
	get isConnected(): boolean { return true; }
	get clientWidth(): number { return 0; }
	/** Obsidian's `contentEl.doc` / `contentEl.win`. */
	get doc(): FakeDocument { return this.ownerDocument; }
	readonly win = {
		setTimeout: (callback: () => void, milliseconds: number): number => globalThis.setTimeout(callback, milliseconds) as unknown as number,
		clearTimeout: (handle: number): void => { globalThis.clearTimeout(handle); },
	};
	contains(other: FakeElement | null): boolean {
		for (let node = other; node !== null; node = node.parent) if (node === this) return true;
		return false;
	}
	empty(): void { for (const child of [...this.children]) child.detach(); this.textContent = null; }
	append(...children: FakeElement[]): void {
		for (const child of children) { child.detach(); child.parent = this; this.children.push(child); }
	}
	prepend(...children: FakeElement[]): void {
		for (const child of [...children].reverse()) { child.detach(); child.parent = this; this.children.unshift(child); }
	}
	replaceChildren(...children: FakeElement[]): void {
		for (const child of [...this.children]) if (!children.includes(child)) child.detach();
		for (const child of children) child.detach();
		this.append(...children);
	}
	replaceWith(next: FakeElement): void {
		const index = this.parent?.children.indexOf(this) ?? -1;
		if (index < 0) return;
		next.parent = this.parent;
		this.parent!.children.splice(index, 1, next);
		this.parent = null;
	}
	createEl(tag: string, options?: FakeOptions): FakeElement { const child = new FakeElement(tag, this.ownerDocument, options); this.append(child); return child; }
	createDiv(options?: FakeOptions): FakeElement { return this.createEl('div', options); }
	createSpan(options?: FakeOptions): FakeElement { return this.createEl('span', options); }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	setAttribute(name: string, value: string): void {
		if (name === 'class') this.className = value; else this.attributes.set(name, value);
	}
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(type: string, listener: FakeListener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: FakeListener): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
	}
	dispatch(type: string): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ preventDefault() {} }); }
	focus(): void { this.ownerDocument.activeElement = this; }
	private detach(): void {
		if (this.parent === null) return;
		const active = this.ownerDocument.activeElement;
		if (active !== null && this.contains(active)) this.ownerDocument.activeElement = null;
		this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
}
