import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';
import {
	mountRowPriceHistoryBlock,
	type InventoryAdvisorRowPriceHistory,
	type RowPriceHistoryBlock,
} from './inventory-advisor-price-history-block';
import { renderInventoryAdvisorView } from './inventory-advisor-view';
import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from './inventory-advisor-view-model';

/**
 * The «Histórico de precio de venta» block of a row's «Detalles». COUNT tests, never clock tests:
 * how many requests, chart containers and nodes a state costs, and what a repaint of the tab
 * rebuilds. Every state of the block has its own case.
 */

afterEach(() => vi.unstubAllGlobals());

const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };
const ITEM_ID = 36_038;
const translator = createTranslator('en');
/** What a chart, a figure or a facts list is made of. */
const HEAVY_TAGS: ReadonlySet<string> = new Set(['figure', 'figcaption', 'svg', 'polyline', 'line', 'text', 'circle', 'dl', 'dt', 'dd']);

describe('the price block of one row', () => {
	it('history off: says what is missing, offers the opt-in, and asks for nothing', () => {
		const harness = block({ enabled: false });

		expect(texts(harness.block.element)).toContain(translator.t('advisor.priceHistory.off'));
		const enable = only(buttons(harness.block.element));
		expect(enable.textContent).toBe(translator.t('view.optIn.priceHistory.enable'));
		expect(enable.disabled).toBe(false);
		expect(statusRole(harness.block.element)).toBe('status');
		expect(walk(harness.block.element).filter((element) => element.tag === 'svg')).toHaveLength(0);
		expect(harness.ensureSeed).toHaveBeenCalledTimes(0);
		expect(harness.getSeed).toHaveBeenCalledTimes(0);

		enable.dispatch('click');
		expect(harness.onEnable).toHaveBeenCalledTimes(1);
	});

	it('history off in consult mode: the button is disabled and the reason is on screen', () => {
		const harness = block({ enabled: false, consultOnly: true });

		expect(only(buttons(harness.block.element)).disabled).toBe(true);
		expect(texts(harness.block.element)).toContain(translator.t('productAction.reason.consult'));
		expect(harness.ensureSeed).toHaveBeenCalledTimes(0);
	});

	it('history off while the general opt-in banner is on screen: the row does not repeat what turning it on does', () => {
		const withBanner = block({ enabled: false, offerVisible: true });
		const alone = block({ enabled: false });

		expect(texts(withBanner.block.element)).not.toContain(translator.t('view.optIn.priceHistory.effect'));
		expect(texts(alone.block.element)).toContain(translator.t('view.optIn.priceHistory.effect'));
	});

	it('loading: one status line, no chart, one request', () => {
		const harness = block({ enabled: true, seed: idle() });

		expect(texts(harness.block.element)).toContain(translator.t('advisor.priceHistory.loading'));
		expect(statusRole(harness.block.element)).toBe('status');
		expect(walk(harness.block.element).filter((element) => element.tag === 'svg')).toHaveLength(0);
		expect(harness.ensureSeed).toHaveBeenCalledTimes(1);
		expect(harness.ensureSeed).toHaveBeenCalledWith(ITEM_ID);
	});

	it('ready: the shared chart with its summary, named, on the sell side and opened on the last 90 days', () => {
		const harness = block({ enabled: true, seed: seeded(300) });
		const root = harness.block.element;

		const figure = only(walk(root).filter((element) => element.tag === 'figure'));
		expect(figure.attributes.get('role')).toBe('group');
		expect(figure.attributes.get('aria-label')).toBe(translator.t('advisor.priceHistory.chartLabel', { name: 'Ancient grey amber chunk' }));
		expect(walk(root).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
		// Max / min / last: the textual summary the widget gives.
		expect(walk(root).filter((element) => element.className === 'tyrian-price-chart__summary')).toHaveLength(1);
		// 300 days of history, 90 shown: the real «3 months» window, pressed. Three buttons, nothing to explore with.
		expect(pressed(root)).toEqual(['3 months']);
		expect(walk(root).filter((element) => element.tag === 'button').map((element) => element.textContent)).toEqual(['3 months', '1 year', 'All']);
		expect(walk(root).filter((element) => element.tag === 'input' || element.className === 'tyrian-price-chart__reset')).toHaveLength(0);
		// The sell side: the plotted values are `askCopper` (1000 + day), never `bidCopper` (10 + day):
		// the last of 300 days reads 1299 copper, which the widget writes as 12s 99c.
		const summary = texts(only(walk(root).filter((element) => element.className === 'tyrian-price-chart__summary')));
		expect(summary.join(' ')).toContain('12s 99c');
	});

	it('ready with a series of five days: it opens on «All», pressed, with the same three buttons', () => {
		const harness = block({ enabled: true, seed: seeded(5) });

		expect(walk(harness.block.element).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
		expect(pressed(harness.block.element)).toEqual(['All']);
		expect(walk(harness.block.element).filter((element) => element.tag === 'button')).toHaveLength(3);
	});

	it('draws the wide chart with a width of 0 (not laid out) or 900, and the compact one at 280 and 390', () => {
		const shapes = (width: number): { viewBox: string | undefined; prices: number; dates: number; compact: boolean } => {
			const harness = block({ enabled: true, seed: seeded(300), width });
			const all = walk(harness.block.element);
			return {
				viewBox: all.find((element) => element.tag === 'svg')?.attributes.get('viewBox'),
				prices: all.filter((element) => element.className === 'tyrian-price-chart__price-label').length,
				dates: all.filter((element) => element.className.startsWith('tyrian-price-chart__date-label')).length,
				compact: chartContainer(harness.block.element).className.includes('tyrian-price-chart--compact'),
			};
		};

		for (const width of [0, 900, 480]) expect(shapes(width)).toEqual({ viewBox: '0 0 800 300', prices: 4, dates: 5, compact: false });
		for (const width of [280, 390, 479]) expect(shapes(width)).toEqual({ viewBox: '0 0 200 190', prices: 3, dates: 2, compact: true });
	});

	it('measures the width once, when it first paints, and never again on a repaint', () => {
		const measure = vi.fn(() => 280);
		installDom();
		const seed = seeded(300);
		const real = mountRowPriceHistoryBlock({
			itemId: ITEM_ID, itemName: 'Ancient grey amber chunk', hasMarket: true,
			source: () => ({ enabled: true, getSeed: () => seed, ensureSeed: () => undefined, onEnable: () => undefined }),
			translator: () => translator, measureWidth: measure,
		});
		expect(measure).toHaveBeenCalledTimes(0);
		real.update();
		for (let index = 0; index < 10; index += 1) real.update();

		expect(measure).toHaveBeenCalledTimes(1);
	});

	it('an item with no market: one line, no chart, nothing requested and no opt-in button even with history off', () => {
		for (const enabled of [true, false]) {
			const harness = block({ enabled, hasMarket: false, seed: idle() });

			expect(texts(harness.block.element)).toContain(translator.t('advisor.priceHistory.none'));
			expect(walk(harness.block.element).filter((element) => element.tag === 'svg' || element.tag === 'button')).toHaveLength(0);
			expect(harness.ensureSeed).toHaveBeenCalledTimes(0);
		}
	});

	it('a source without a series for the item (empty answer or an empty seed): the same single line, no empty chart', () => {
		for (const seed of [
			{ ...idle(), status: 'no_seed' as const, failureReason: 'empty' as const },
			{ ...idle(), status: 'no_seed' as const, failureReason: 'malformed' as const },
			{ ...idle(), status: 'seeded' as const, days: [] },
		]) {
			const harness = block({ enabled: true, seed });

			expect(texts(harness.block.element)).toContain(translator.t('advisor.priceHistory.none'));
			expect(walk(harness.block.element).filter((element) => element.tag === 'svg' || element.tag === 'button')).toHaveLength(0);
		}
	});

	it('a failed download: an alert and Retry; Retry asks again, shows loading, and ends on the new answer', () => {
		const harness = block({ enabled: true, seed: { ...idle(), status: 'no_seed', failureReason: 'unreachable' } });

		expect(texts(harness.block.element)).toContain(translator.t('advisor.priceHistory.failed'));
		expect(statusRole(harness.block.element)).toBe('alert');
		expect(harness.ensureSeed).toHaveBeenCalledTimes(1);
		const retry = only(buttons(harness.block.element));
		expect(retry.textContent).toBe(translator.t('advisor.priceHistory.retry'));

		let finish: () => void = () => undefined;
		harness.ensureSeed.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
		retry.dispatch('click');
		expect(harness.ensureSeed).toHaveBeenCalledTimes(2);
		expect(texts(harness.block.element)).toContain(translator.t('advisor.priceHistory.loading'));

		harness.seed.current = seeded(30);
		finish();
		return Promise.resolve().then(() => Promise.resolve()).then(() => {
			expect(walk(harness.block.element).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
		});
	});

	it('a local store that cannot open is a failure too, with Retry', () => {
		const harness = block({ enabled: true, seed: { ...idle(), status: 'store_unavailable' } });

		expect(statusRole(harness.block.element)).toBe('alert');
		expect(texts(harness.block.element)).toContain(translator.t('priceHistoryNote.state.unavailable'));
		expect(buttons(harness.block.element)).toHaveLength(1);
	});

	it('an ensure that throws ends as a failure instead of loading forever', async () => {
		const harness = block({ enabled: true, seed: idle(), ensure: () => Promise.reject(new Error('boom')) });
		await Promise.resolve();
		await Promise.resolve();

		expect(statusRole(harness.block.element)).toBe('alert');
	});

	it('twenty repaints with the same state: one request, the same nodes, none created, the zoom still there', () => {
		const harness = block({ enabled: true, seed: seeded(300) });
		const chart = chartContainer(harness.block.element);
		windowButton(harness.block.element, '1 year').dispatch('click');
		expect(windowButton(harness.block.element, '1 year').attributes.get('aria-pressed')).toBe('true');
		const plot = only(walk(harness.block.element).filter((element) => element.className === 'tyrian-price-chart__plot'));
		const created = countCreatedNodes(() => { for (let index = 0; index < 20; index += 1) harness.block.update(); });

		expect(created).toBe(0);
		expect(harness.ensureSeed).toHaveBeenCalledTimes(1);
		expect(chartContainer(harness.block.element)).toBe(chart);
		const plots = walk(harness.block.element).filter((element) => element.className === 'tyrian-price-chart__plot');
		expect(plots).toHaveLength(1);
		expect(plots[0] === plot).toBe(true);
		expect(windowButton(harness.block.element, '1 year').attributes.get('aria-pressed')).toBe('true');
	});

	it('a new day of history redraws the series inside the same container and keeps the zoom the reader chose', () => {
		const harness = block({ enabled: true, seed: seeded(300) });
		const chart = chartContainer(harness.block.element);
		windowButton(harness.block.element, '1 year').dispatch('click');

		harness.seed.current = seeded(301);
		harness.block.update();

		expect(chartContainer(harness.block.element)).toBe(chart);
		// A new last day is a new series for the widget: its zoom starts over, on the «3 months» default.
		expect(pressed(harness.block.element)).toEqual(['3 months']);
	});

	it('repaints each state exactly once: loading, then the chart when the seed lands', () => {
		const harness = block({ enabled: true, seed: idle() });
		expect(walk(harness.block.element).filter((element) => element.tag === 'svg')).toHaveLength(0);

		harness.seed.current = seeded(60);
		harness.block.update();

		expect(walk(harness.block.element).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
		expect(harness.ensureSeed).toHaveBeenCalledTimes(1);
	});

	it('turning the history on while the block is open asks for the seed then, once, and not before', () => {
		const harness = block({ enabled: false, seed: idle() });
		expect(harness.ensureSeed).toHaveBeenCalledTimes(0);

		harness.source.enabled = true;
		harness.block.update();
		harness.block.update();

		expect(harness.ensureSeed).toHaveBeenCalledTimes(1);
		expect(texts(harness.block.element)).toContain(translator.t('advisor.priceHistory.loading'));
	});

	it('paints nothing after dispose', () => {
		const harness = block({ enabled: true, seed: seeded(60) });
		harness.block.dispose();
		const created = countCreatedNodes(() => { harness.seed.current = seeded(61); harness.block.update(); });

		expect(created).toBe(0);
		expect(harness.ensureSeed).toHaveBeenCalledTimes(1);
	});
});

describe('the price block inside the Inventory tab', () => {
	it('a closed «Detalles» holds no block and asks for nothing, however often the tab repaints', () => {
		const tab = advisor({ enabled: true, seed: seeded(120) });
		const created = countCreatedNodes(() => { for (let index = 0; index < 20; index += 1) tab.repaint(); }, HEAVY_TAGS);

		expect(tab.blocks()).toHaveLength(0);
		expect(created).toBe(0);
		expect(tab.ensureSeed).toHaveBeenCalledTimes(0);
	});

	it('opening a row builds its block and asks for THAT row\'s item once; closing drops it', () => {
		const tab = advisor({ enabled: true, seed: seeded(120) });

		tab.toggle(0, true);
		expect(tab.blocks()).toHaveLength(1);
		expect(tab.ensureSeed).toHaveBeenCalledTimes(1);
		expect(tab.ensureSeed).toHaveBeenCalledWith(ITEM_ID);
		expect(walk(tab.blocks()[0]!).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);

		tab.toggle(0, false);
		expect(tab.blocks()).toHaveLength(0);
		expect(walk(tab.container).filter((element) => element.tag === 'figure')).toHaveLength(0);
	});

	it('opening, closing and opening again asks once per opening: the host\'s cache is what answers the second', () => {
		const tab = advisor({ enabled: true, seed: seeded(120) });

		tab.toggle(0, true);
		tab.toggle(0, false);
		tab.toggle(0, true);

		expect(tab.ensureSeed).toHaveBeenCalledTimes(2);
	});

	it('a repaint of the tab (a sync tick) neither rebuilds the open chart nor asks again, and keeps its zoom', () => {
		const tab = advisor({ enabled: true, seed: seeded(120) });
		tab.toggle(0, true);
		const block = tab.blocks()[0]!;
		const chart = chartContainer(block);
		windowButton(block, '1 year').dispatch('click');
		const created = countCreatedNodes(() => { for (let index = 0; index < 20; index += 1) tab.repaint(); }, HEAVY_TAGS);

		expect(tab.blocks()[0]).toBe(block);
		expect(chartContainer(block)).toBe(chart);
		expect(windowButton(block, '1 year').attributes.get('aria-pressed')).toBe('true');
		expect(tab.ensureSeed).toHaveBeenCalledTimes(1);
		// The tab repainted twenty times: what it rebuilds is its own chrome, never a chart, figure or table.
		expect(created).toBe(0);
	});

	it('a repaint that finds the history switched on reaches the block that is already open', () => {
		const tab = advisor({ enabled: false, seed: idle() });
		tab.toggle(0, true);
		expect(texts(tab.blocks()[0]!)).toContain(translator.t('advisor.priceHistory.off'));
		expect(tab.ensureSeed).toHaveBeenCalledTimes(0);

		tab.setSource({ enabled: true, seed: seeded(40) });
		tab.repaint();

		expect(tab.ensureSeed).toHaveBeenCalledTimes(1);
		expect(walk(tab.blocks()[0]!).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
	});

	it('without the host action there is no block at all', () => {
		const tab = advisor(null);

		tab.toggle(0, true);

		expect(tab.blocks()).toHaveLength(0);
	});
});

interface BlockSetup {
	enabled: boolean;
	consultOnly?: boolean;
	offerVisible?: boolean;
	hasMarket?: boolean;
	seed?: PriceHistoryPanelSeedState;
	ensure?: () => void | Promise<void>;
	/** The width the block measures when it paints for the first time. Default 0: a block that is not laid out. */
	width?: number;
}

function block(setup: BlockSetup) {
	installDom();
	const seed = { current: setup.seed ?? idle() };
	const source = {
		enabled: setup.enabled, consultOnly: setup.consultOnly, offerVisible: setup.offerVisible,
	};
	const ensureSeed = vi.fn(setup.ensure ?? (() => undefined));
	const getSeed = vi.fn(() => seed.current);
	const onEnable = vi.fn();
	const real: RowPriceHistoryBlock = mountRowPriceHistoryBlock({
		itemId: ITEM_ID, itemName: 'Ancient grey amber chunk', hasMarket: setup.hasMarket ?? true,
		source: () => ({ ...source, getSeed, ensureSeed, onEnable }),
		translator: () => translator,
		measureWidth: () => setup.width ?? 0,
	});
	// The host attaches the block and then asks it to paint, which is when it measures its width.
	real.update();
	const mounted = { element: real.element as unknown as FakeElement, update: () => real.update(), dispose: () => real.dispose() };
	return { block: mounted, seed, source, ensureSeed, getSeed, onEnable };
}

interface TabSource { enabled: boolean; seed: PriceHistoryPanelSeedState }

function advisor(initial: TabSource | null) {
	const document = installDom();
	const container = new FakeElement('div', document);
	let current = initial;
	const ensureSeed = vi.fn();
	const rowPriceHistory = (): InventoryAdvisorRowPriceHistory | undefined => current === null ? undefined : {
		enabled: current.enabled, getSeed: () => current!.seed, ensureSeed, onEnable: () => undefined,
	};
	const paint = (): void => renderInventoryAdvisorView(
		container as unknown as HTMLElement, icons, model(), translator, undefined, { rowPriceHistory: rowPriceHistory() },
	);
	paint();
	const detailsOf = (index: number): FakeElement => walk(container).filter((element) => element.className === 'tyrian-inventory__more')[index]!;
	return {
		container, ensureSeed, repaint: paint,
		setSource: (next: TabSource): void => { current = next; },
		toggle: (index: number, open: boolean): void => {
			const details = detailsOf(index);
			if (open) details.children[0]!.dispatch('click');
			details.open = open;
			details.dispatch('toggle');
		},
		blocks: (): FakeElement[] => walk(container).filter((element) => element.className === 'tyrian-inventory__price-history'),
	};
}

function idle(): PriceHistoryPanelSeedState {
	return { status: 'idle', itemId: ITEM_ID, days: [], failureReason: null, retrievedAt: null };
}

function seeded(count: number): PriceHistoryPanelSeedState {
	const days: PriceSeedDayV1[] = Array.from({ length: count }, (_unused, index) => ({
		dayUtc: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
		bidCopper: 10 + index, askCopper: 1_000 + index,
	}));
	return { status: 'seeded', itemId: ITEM_ID, days, failureReason: null, retrievedAt: '2026-10-07T00:00:00.000Z' };
}

function model(): InventoryAdvisorViewModel {
	return { status: 'ready', title: 'advisor', detail: 'ready', contentVersion: 1, groups: [{ key: 'market', rows: [row()] }] };
}

function row(): InventoryAdvisorViewRow {
	const state = 'complete' as const;
	return {
		id: '#/explanations/0/0', itemId: ITEM_ID, name: 'Ancient grey amber chunk', icon: null,
		ownedQuantity: 3, availableQuantity: 3, action: 'sell', quantity: 3,
		allocations: [{ positionRef: '#/positions/0', quantity: 3, location: { source: 'bank', slot: 1 } }],
		reasonCodes: ['rule_missing'], protectionReasons: [],
		value: { status: 'available', copper: 4_000, route: 'instant_sell' },
		marketComparison: null, burden: null,
		coverage: { snapshot: state, inventory: state, catalog: state, prices: state, reservations: state, accountSignals: state, rules: state },
		irreversibleReviewOnly: false, discardProof: null,
	};
}

/** The elements of the chart's own container: the one the widget keys its zoom by. */
function chartContainer(root: FakeElement): FakeElement {
	const found = walk(root).filter((element) => element.className.split(' ').includes('tyrian-inventory__price-history-chart'));
	return only(found);
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

/** Nodes `work` asks the host to create; a chart, a figure or a facts list is what the block must not rebuild. */
function countCreatedNodes(work: () => void, only: ReadonlySet<string> | null = null): number {
	let created = 0;
	const original = FakeElement.onCreate;
	FakeElement.onCreate = (element) => { if (only === null || only.has(element.tag)) created += 1; };
	try { work(); } finally { FakeElement.onCreate = original; }
	return created;
}

function installDom(): FakeDocument {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, document));
	vi.stubGlobal('createDiv', () => new FakeElement('div', document));
	vi.stubGlobal('createSpan', () => new FakeElement('span', document));
	return document;
}

function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }

class FakeDocument {
	activeElement: FakeElement | null = null;
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}

type FakeListener = (event: { preventDefault(): void }) => void;

class FakeElement {
	static onCreate: ((element: FakeElement) => void) | null = null;
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, FakeListener[]>();
	parent: FakeElement | null = null;
	className = '';
	id = '';
	scope = '';
	colSpan = 1;
	textContent: string | null = null;
	type = '';
	value = '';
	max = 0;
	placeholder = '';
	disabled = false;
	open = false;
	required = false;
	selected = false;
	checked = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) { FakeElement.onCreate?.(this); }

	get tagName(): string { return this.tag.toUpperCase(); }
	get isConnected(): boolean { return true; }
	contains(other: FakeElement | null): boolean {
		for (let node = other; node !== null; node = node.parent) if (node === this) return true;
		return false;
	}
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
