import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import { disposeInventoryAdvisorView, renderInventoryAdvisorView } from './inventory-advisor-view';
import type { InventoryAdvisorViewModel } from './inventory-advisor-view-model';
import {
	mountPriceHistoryPanel,
	renderPriceHistoryPanel,
	type PriceHistoryPanelInteractions,
} from './price-history-panel-view';

/**
 * Audit V1, finding 3.2. The price panel lives inside the Inventory tab's closed-by-default
 * `<details>`, and the tab repaints on every sync tick. These are COUNT tests, never clock tests:
 * how many chart and table nodes exist while the disclosure is closed, whether opening it builds
 * them, and whether the chart's zoom is still there after the tab repaints.
 */

afterEach(() => vi.unstubAllGlobals());

const DAYS = 120;
const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };

describe('the price panel inside the Inventory tab disclosure', () => {
	it('creates no chart, figure or table node while the disclosure is closed', () => {
		const mount = advisor(interactions());

		expect(mount.disclosure().open).toBe(false);
		expect(heavyNodes(mount.disclosure())).toBe(0);
	});

	it('still creates none after twenty repaints with the disclosure closed', () => {
		const mount = advisor(interactions());
		const created = countCreatedNodes(() => { for (let index = 0; index < 20; index += 1) mount.repaint(interactions()); });

		expect(heavyNodes(mount.disclosure())).toBe(0);
		// The closed panel still paints its own controls and status lines, nothing per day of history.
		expect(created.chartOrTable).toBe(0);
	});

	it('builds the chart and the table when the disclosure opens, and drops them when it closes', () => {
		const mount = advisor(interactions());

		mount.toggle(true);
		const open = walk(mount.disclosure());
		expect(open.filter((element) => element.tag === 'figure')).toHaveLength(1);
		expect(open.filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
		expect(open.filter((element) => element.tag === 'table')).toHaveLength(1);
		// One row per day of history plus the header row.
		expect(open.filter((element) => element.tag === 'tr')).toHaveLength(DAYS + 1);

		mount.toggle(false);
		expect(heavyNodes(mount.disclosure())).toBe(0);
	});

	it('keeps the chart zoom across a repaint of the tab', () => {
		const mount = advisor(interactions());
		mount.toggle(true);
		windowButton(mount.disclosure(), '1 month').dispatch('click');
		expect(windowButton(mount.disclosure(), '1 month').attributes.get('aria-pressed')).toBe('true');

		mount.repaint(interactions());

		expect(windowButton(mount.disclosure(), '1 month').attributes.get('aria-pressed')).toBe('true');
		expect(windowButton(mount.disclosure(), 'All').attributes.get('aria-pressed')).toBe('false');
	});

	it('keeps the zoom across closing and reopening the disclosure', () => {
		const mount = advisor(interactions());
		mount.toggle(true);
		windowButton(mount.disclosure(), '1 month').dispatch('click');

		mount.toggle(false);
		mount.toggle(true);

		expect(windowButton(mount.disclosure(), '1 month').attributes.get('aria-pressed')).toBe('true');
	});

	it('keeps the same chart container while item and side stay the same, and replaces it when either changes', () => {
		const mount = advisor(interactions());
		mount.toggle(true);
		const first = chartContainer(mount.disclosure());

		mount.repaint(interactions());
		expect(chartContainer(mount.disclosure())).toBe(first);

		// The other side of the same item is a different series: a fresh container, the zoom starts over.
		mount.repaint(interactions({ selectedSide: 'bid' }));
		const bid = chartContainer(mount.disclosure());
		expect(bid).not.toBe(first);

		mount.repaint(interactions({ selectedSide: 'bid', selectedItemId: 19_721, watchItemIds: [36_038, 19_721] }));
		expect(chartContainer(mount.disclosure())).not.toBe(bid);
	});

	it('starts the zoom over when the side changes, never carrying the other side\'s window', () => {
		const mount = advisor(interactions());
		mount.toggle(true);
		windowButton(mount.disclosure(), '1 month').dispatch('click');

		mount.repaint(interactions({ selectedSide: 'bid' }));

		expect(windowButton(mount.disclosure(), '1 month').attributes.get('aria-pressed')).toBe('false');
		expect(windowButton(mount.disclosure(), 'All').attributes.get('aria-pressed')).toBe('true');
	});

	it('paints, once open, exactly what the one-shot panel render paints: same nodes, classes, attributes and texts in the same order', () => {
		const mount = advisor(interactions());
		mount.toggle(true);
		const reference = new FakeElement('div', mount.document);
		renderPriceHistoryPanel(reference as unknown as HTMLElement, createTranslator('en'), interactions());

		const panel = mount.disclosure().children[1]!;
		expect(serialize(panel)).toEqual(serialize(reference));
	});

	it('keeps the disclosure and panel roles, live regions and tab order', () => {
		const mount = advisor(interactions());
		const disclosure = mount.disclosure();
		// A native disclosure: `<summary>` first, the panel second, no role or aria-expanded of its own.
		expect(disclosure.tag).toBe('details');
		expect(disclosure.children.map((child) => child.tag)).toEqual(['summary', 'div']);
		expect(disclosure.children[0]!.textContent).toBe('Local price history');
		expect([...disclosure.attributes.keys()]).toEqual([]);
		const panel = disclosure.children[1]!;
		expect(panel.className).toBe('tyrian-price-history');
		expect(panel.attributes.get('title')).toBe(createTranslator('en').t('priceHistory.intro'));

		mount.toggle(true);
		const elements = walk(disclosure);
		const state = elements.find((element) => element.className === 'tyrian-price-history__state')!;
		expect(state.attributes.get('aria-live')).toBe('polite');
		expect(state.attributes.has('role')).toBe(false);
		const group = elements.find((element) => element.className === 'tyrian-price-chart__window-group')!;
		expect(group.attributes.get('role')).toBe('group');
		expect(group.attributes.get('aria-label')).toBe(createTranslator('en').t('priceHistory.chart.windowGroupLabel'));
		const svg = elements.find((element) => element.tag === 'svg')!;
		expect(svg.attributes.get('aria-hidden')).toBe('true');
		expect(elements.filter((element) => element.tag === 'th').every((cell) => cell.scope === 'col')).toBe(true);

		// Tab order is DOM order: the disclosure's own summary, the three selectors, load, the zoom
		// windows, the two range handles, and the table's own summary last.
		expect(tabStops(disclosure)).toEqual([
			'summary:Local price history',
			'select', 'select', 'select',
			'button:Load local chart',
			'button:1 month', 'button:1 year', 'button:5 years', 'button:All',
			'input', 'input',
			'summary:Show accessible table',
		]);
	});

	it('leaves the tab stops of a closed disclosure as they were: the summary, the selectors and load', () => {
		const mount = advisor(interactions());

		expect(tabStops(mount.disclosure())).toEqual([
			'summary:Local price history', 'select', 'select', 'select', 'button:Load local chart',
		]);
	});

	it('removes its toggle subscription when the Inventory view is disposed', () => {
		const mount = advisor(interactions());
		expect(mount.disclosure().listeners.get('toggle')).toHaveLength(1);
		const disclosure = mount.disclosure();

		disposeInventoryAdvisorView(mount.container as unknown as HTMLElement);

		expect(disclosure.listeners.get('toggle')).toHaveLength(0);
		disclosure.open = true;
		disclosure.dispatch('toggle');
		expect(heavyNodes(disclosure)).toBe(0);
	});
});

describe('mountPriceHistoryPanel, repainted with the disclosure open', () => {
	it('keeps the open accessible table and the very same selectors, focus and chosen values across a repaint', () => {
		const mounted = openPanel();
		mounted.panel.update(createTranslator('en'), interactions({ selectedSide: 'bid', windowDays: 90 }));
		const selects = walk(mounted.container).filter((element) => element.tag === 'select');
		const tableDetails = tableDisclosure(mounted.container);
		tableDetails.open = true;
		selects[1]!.focus();

		mounted.panel.update(createTranslator('en'), interactions({ selectedSide: 'bid', windowDays: 90 }));

		expect(tableDisclosure(mounted.container).open).toBe(true);
		const after = walk(mounted.container).filter((element) => element.tag === 'select');
		expect(after).toHaveLength(3);
		after.forEach((select, index) => expect(select).toBe(selects[index]));
		expect(mounted.document.activeElement).toBe(selects[1]);
		expect(after.map((select) => select.value)).toEqual(['36038', 'bid', '90']);
	});

	it('calls the onLoad of the LAST paint from the kept selectors and button, never an earlier one', () => {
		const mounted = openPanel();
		const first = vi.fn();
		const second = vi.fn();
		mounted.panel.update(createTranslator('en'), { ...interactions(), onLoad: first });
		mounted.panel.update(createTranslator('en'), { ...interactions(), onLoad: second });
		const controls = walk(mounted.container).filter((element) => element.className === 'tyrian-price-history__controls')[0]!;
		const selects = walk(controls).filter((element) => element.tag === 'select');
		const load = walk(controls).find((element) => element.tag === 'button')!;

		selects[2]!.value = '90';
		selects[2]!.dispatch('change');
		load.dispatch('click');

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(2);
		expect(second).toHaveBeenLastCalledWith(36_038, 'ask', 90);
	});

	it('shows the new data, not the old, when the same controls are repainted for another item and history', () => {
		const mounted = openPanel();
		mounted.panel.update(createTranslator('en'), interactions());
		const selects = walk(mounted.container).filter((element) => element.tag === 'select');
		tableDisclosure(mounted.container).open = true;
		const rowsBefore = walk(tableDisclosure(mounted.container)).filter((element) => element.tag === 'tr').length;
		expect(rowsBefore).toBe(DAYS + 1);

		mounted.panel.update(createTranslator('en'), interactions({
			selectedItemId: 19_721, watchItemIds: [36_038, 19_721], selectedSide: 'bid',
			daily: Array.from({ length: 3 }, (_unused, index) => daily(index)).map((entry) => ({ ...entry, itemId: 19_721 })),
		}));

		const table = tableDisclosure(mounted.container);
		expect(table.open).toBe(true);
		expect(walk(table).filter((element) => element.tag === 'tr')).toHaveLength(4);
		const after = walk(mounted.container).filter((element) => element.tag === 'select');
		expect(after[0]).toBe(selects[0]);
		expect(after.map((select) => select.value)).toEqual(['19721', 'bid', '42']);
		expect(after[0]!.children.map((option) => option.value)).toEqual(['36038', '19721']);
	});
});

describe('mountPriceHistoryPanel', () => {
	it('paints nothing more after dispose, on update or on toggle, and holds no listener', () => {
		const document = installDom();
		const disclosure = new FakeElement('details', document);
		const container = new FakeElement('div', document);
		disclosure.append(new FakeElement('summary', document), container);
		const panel = mountPriceHistoryPanel(container as unknown as HTMLElement, disclosure as unknown as HTMLDetailsElement);
		disclosure.open = true;
		panel.update(createTranslator('en'), interactions());
		expect(heavyNodes(disclosure)).toBeGreaterThan(0);
		const painted = serialize(container);

		panel.dispose();

		expect(disclosure.listeners.get('toggle')).toHaveLength(0);
		panel.update(createTranslator('es'), interactions({ selectedSide: 'bid' }));
		expect(serialize(container)).toEqual(painted);
	});

	it('builds the chart on the first update when the disclosure is already open', () => {
		const document = installDom();
		const disclosure = new FakeElement('details', document);
		const container = new FakeElement('div', document);
		disclosure.open = true;
		disclosure.append(new FakeElement('summary', document), container);

		mountPriceHistoryPanel(container as unknown as HTMLElement, disclosure as unknown as HTMLDetailsElement)
			.update(createTranslator('en'), interactions());

		expect(walk(container).filter((element) => element.className === 'tyrian-price-chart__plot')).toHaveLength(1);
	});
});

function openPanel() {
	const document = installDom();
	const disclosure = new FakeElement('details', document);
	const container = new FakeElement('div', document);
	disclosure.open = true;
	disclosure.append(new FakeElement('summary', document), container);
	const panel = mountPriceHistoryPanel(container as unknown as HTMLElement, disclosure as unknown as HTMLDetailsElement);
	return { document, container, panel };
}

function tableDisclosure(root: FakeElement): FakeElement {
	const found = walk(root).filter((element) => element.className === 'tyrian-price-history__table-details');
	if (found.length !== 1) throw new Error(`Expected one table disclosure, found ${String(found.length)}.`);
	return found[0]!;
}

function interactions(overrides: Partial<PriceHistoryRuntimeState> = {}): PriceHistoryPanelInteractions {
	return {
		state: {
			status: 'ready', watchItemIds: [36_038], selectedItemId: 36_038, selectedSide: 'ask', windowDays: 42,
			daily: Array.from({ length: DAYS }, (_unused, index) => daily(index)),
			lastSampleAtMs: null, nextCaptureAtMs: null, provisionalDayUtc: null,
			...overrides,
		},
		onEnable: () => undefined, onLoad: () => undefined,
	};
}

function daily(index: number): PriceHistoryDailyV1 {
	const dayUtc = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
	const values = {
		count: 1, minCopper: 100 + index, maxCopper: 100 + index, medianCopperX2: (100 + index) * 2,
		closeCopper: 100 + index, closeCapturedAtMs: Date.parse(`${dayUtc}T12:00:00.000Z`),
	};
	return { version: 1, vaultId: 'vault', itemId: 36_038, dayUtc, snapshotCount: 1, partialSnapshotCount: 0, bid: values, ask: values };
}

function model(): InventoryAdvisorViewModel {
	return { status: 'ready', title: 'advisor', detail: 'ready', groups: [] };
}

function advisor(priceHistory: PriceHistoryPanelInteractions) {
	const document = installDom();
	const container = new FakeElement('div', document);
	const paint = (next: PriceHistoryPanelInteractions): void => renderInventoryAdvisorView(
		container as unknown as HTMLElement, icons, model(), createTranslator('en'), undefined, { priceHistory: next },
	);
	paint(priceHistory);
	const disclosure = (): FakeElement => {
		const found = walk(container).filter((element) => element.className === 'tyrian-inventory-advisor__price-history');
		if (found.length !== 1) throw new Error(`Expected one price-history disclosure, found ${String(found.length)}.`);
		return found[0]!;
	};
	return {
		container, document, disclosure, repaint: paint,
		/** What the browser does when the user clicks the summary: flips `open`, then fires `toggle`. */
		toggle: (open: boolean): void => { const element = disclosure(); element.open = open; element.dispatch('toggle'); },
	};
}

/** Every node the chart and the daily table are made of: what a closed disclosure must not hold. */
function heavyNodes(root: FakeElement): number {
	return walk(root)
		.filter((element) => element.tag === 'figure' || element.className === 'tyrian-price-history__table-details')
		.reduce((total, element) => total + walk(element).length, 0);
}

/** Counts the nodes `work` asks the host to create, split by whether a chart or a table needs them. */
function countCreatedNodes(work: () => void): { total: number; chartOrTable: number } {
	const created: FakeElement[] = [];
	const heavyTags = new Set(['figure', 'figcaption', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'svg', 'dl', 'dt', 'dd']);
	const original = FakeElement.onCreate;
	FakeElement.onCreate = (element) => { created.push(element); };
	try { work(); } finally { FakeElement.onCreate = original; }
	return { total: created.length, chartOrTable: created.filter((element) => heavyTags.has(element.tag)).length };
}

function windowButton(root: FakeElement, label: string): FakeElement {
	const found = walk(root).filter((element) => element.tag === 'button' && element.textContent === label);
	if (found.length !== 1) throw new Error(`Expected one "${label}" button, found ${String(found.length)}.`);
	return found[0]!;
}

function chartContainer(root: FakeElement): FakeElement {
	const found = walk(root).filter((element) => element.className.split(' ').includes('tyrian-price-history__chart'));
	if (found.length !== 1) throw new Error(`Expected one chart container, found ${String(found.length)}.`);
	return found[0]!;
}

/** Focusable elements in DOM order, the order Tab walks them; a button or summary carries its text. */
function tabStops(root: FakeElement): string[] {
	return walk(root)
		.filter((element) => ['summary', 'select', 'button', 'input'].includes(element.tag) && !element.disabled)
		.map((element) => (element.tag === 'summary' || element.tag === 'button' ? `${element.tag}:${element.textContent ?? ''}` : element.tag));
}

interface SerializedNode {
	tag: string; className: string; text: string | null; attributes: Array<[string, string]>; children: SerializedNode[];
}

function serialize(element: FakeElement): SerializedNode {
	return {
		tag: element.tag, className: element.className, text: element.textContent,
		attributes: [...element.attributes.entries()], children: element.children.map(serialize),
	};
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
	parent: FakeElement | null = null;
	append(...children: FakeElement[]): void { for (const child of children) { child.parent = this; this.children.push(child); } }
	/** Like the browser, dropping a node from the tree blurs it when it, or something inside it, had the focus. */
	replaceChildren(...children: FakeElement[]): void {
		for (const removed of this.children.splice(0, this.children.length)) removed.detached();
		this.append(...children);
	}
	insertBefore(child: FakeElement, anchor: FakeElement): void {
		child.parent = this;
		this.children.splice(this.children.indexOf(anchor), 0, child);
	}
	remove(): void {
		if (this.parent === null) return;
		this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.detached();
	}
	private detached(): void {
		this.parent = null;
		const active = this.ownerDocument.activeElement;
		if (active !== null && walk(this).includes(active)) this.ownerDocument.activeElement = null;
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
}
