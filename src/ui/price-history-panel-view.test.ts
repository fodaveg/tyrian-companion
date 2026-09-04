import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import { priceHistoryPanelLayout, priceHistorySvg, renderPriceHistoryPanel } from './price-history-panel-view';

afterEach(() => vi.unstubAllGlobals());

describe('price-history panel', () => {
	it('renders the SVG byte-for-byte and splits lines across missing UTC days', () => {
		const svg = priceHistorySvg([daily('2026-08-01', 100), daily('2026-08-02', 120), daily('2026-08-04', 140)], 'ask');
		expect(svg).toBe('<svg viewBox="0 0 760 240" width="100%" role="img" aria-hidden="true"><g><line class="price-range" x1="28" y1="212" x2="28" y2="212"/><line class="price-range" x1="380" y1="120" x2="380" y2="120"/><line class="price-range" x1="732" y1="28" x2="732" y2="28"/><polyline class="price-median" points="28,212 380,120"/><circle class="price-median-marker" cx="732" cy="28" r="5"/><polyline class="price-close" points="28,212 380,120"/><rect class="price-close-marker" x="728" y="24" width="8" height="8"/></g></svg>');
	});

	it('renders visible DOM markers for a one-day or isolated observation', () => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('collecting'), watchItemIds: [36_038], selectedItemId: 36_038, daily: [daily('2026-08-29', 100)] },
			onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const elements = walk(mount.container);
		const median = elements.find((element) => element.tag === 'circle');
		const close = elements.find((element) => element.tag === 'rect');
		expect(median?.attributes).toEqual(new Map([['class', 'price-median-marker'], ['cx', '28'], ['cy', '212'], ['r', '5']]));
		expect(close?.attributes).toEqual(new Map([['class', 'price-close-marker'], ['x', '24'], ['y', '208'], ['width', '8'], ['height', '8']]));
	});

	it.each([[320, 'stacked'], [480, 'two-column'], [760, 'wide']] as const)(
		'uses the responsive layout at %ipx',
		(width, layout) => expect(priceHistoryPanelLayout(width)).toBe(layout),
	);

	it('uses only semantic theme variables and the matching 479/759 breakpoints', () => {
		const styles = readFileSync('styles.css', 'utf8');
		const panel = styles.slice(styles.indexOf('.tyrian-price-history {'), styles.indexOf('.tyrian-inventory-advisor__scope legend'));
		expect(panel).not.toMatch(/#[0-9a-f]{3,8}/iu);
		expect(panel).toContain('var(--background-secondary)');
		expect(styles).toMatch(/@container \(max-width: 759px\)[\s\S]*tyrian-price-history__controls/u);
		expect(styles).toMatch(/@container \(max-width: 479px\)[\s\S]*tyrian-price-history__controls/u);
	});

	it('renders disabled without running callbacks and activates only from the 44px control', () => {
		const mount = createMount();
		const enable = vi.fn();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('es'), {
			state: state('disabled'), onEnable: enable, onLoad: vi.fn(),
		});
		expect(enable).not.toHaveBeenCalled();
		const activate = walk(mount.container).find((element) => element.tag === 'button');
		expect(activate?.textContent).toBe('Activar histórico');
		activate?.dispatch('click');
		expect(enable).toHaveBeenCalledOnce();
		expect(readFileSync('styles.css', 'utf8')).toMatch(/tyrian-price-history button,[\s\S]*min-height:\s*44px/u);
	});

	it('renders figure, figcaption and a collapsible equivalent table with provisional and gap labels', () => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('partial'), watchItemIds: [36_038], selectedItemId: 36_038,
				daily: [daily('2026-08-28', 100), { ...daily('2026-08-29', 120), ask: null }], provisionalDayUtc: '2026-08-29' },
			onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const elements = walk(mount.container);
		for (const tag of ['figure', 'figcaption', 'details', 'summary', 'table', 'caption', 'th']) {
			expect(elements.some((element) => element.tag === tag)).toBe(true);
		}
		expect(elements.map(({ textContent }) => textContent).join('\n')).toContain('2026-08-29 (provisional)');
		expect(elements.some((element) => element.textContent === '—')).toBe(true);
	});

	it('keeps 400 ids usable, renders a long catalog name, and falls back to the numeric id', () => {
		const mount = createMount();
		const watchItemIds = Array.from({ length: 400 }, (_, index) => index + 1);
		const longName = 'A'.repeat(180);
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('collecting'), watchItemIds, selectedItemId: 1 },
			itemLabels: { 1: longName }, onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const itemSelect = walk(mount.container).find((element) => element.tag === 'select');
		expect(itemSelect?.children).toHaveLength(400);
		expect(itemSelect?.children[0]?.textContent).toBe(`${longName} (#1)`);
		expect(itemSelect?.children[1]?.textContent).toBe('Item #2');
	});

	it('keeps a 365-day large-copper SVG finite and reproducible', () => {
		const dailySeries = Array.from({ length: 365 }, (_, index) => daily(
			new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
			9_000_000_000_000 - index,
		));
		const first = priceHistorySvg(dailySeries, 'ask');
		expect(first).toBe(priceHistorySvg(dailySeries, 'ask'));
		expect(first).not.toMatch(/NaN|Infinity/u);
	});

	it.each([
		'loading', 'collecting', 'ready', 'partial', 'offline', 'backoff',
		'invalid_payload', 'store_unavailable', 'store_corrupt', 'store_future',
	] as const)('renders the %s state through i18n and marks failures as alerts', (status) => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('es'), {
			state: state(status), onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const statusElement = walk(mount.container).find((element) => element.className === 'tyrian-price-history__state');
		expect(statusElement?.textContent).not.toMatch(/^priceHistory\./u);
		expect(statusElement?.textContent).not.toContain('{{');
		expect(statusElement?.attributes.get('aria-live')).toBe('polite');
		if (['offline', 'backoff', 'invalid_payload', 'store_unavailable', 'store_corrupt', 'store_future'].includes(status)) {
			expect(statusElement?.attributes.get('role')).toBe('alert');
		}
	});

	it('shows the resolved name in the dropdown and the caption, and the icon for the selected item only', () => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('collecting'), watchItemIds: [36_038, 105_402], selectedItemId: 36_038, daily: [daily('2026-08-29', 100)] },
			itemLabels: { 36_038: 'Trick-or-Treat Bag' },
			itemIcons: { 36_038: 'https://render.guildwars2.com/x/y.png' },
			onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const elements = walk(mount.container);
		const itemSelect = elements.find((element) => element.tag === 'select');
		expect(itemSelect?.children[0]?.textContent).toBe('Trick-or-Treat Bag (#36038)');
		expect(itemSelect?.children[1]?.textContent).toBe('Item #105402');
		const caption = elements.find((element) => element.tag === 'figcaption');
		expect(caption?.textContent).toBe('Trick-or-Treat Bag (#36038) · Sell listing · last 42 UTC days');
		const icons = elements.filter((element) => element.className === 'tyrian-price-history__item-icon');
		expect(icons).toHaveLength(1);
		expect(icons[0]?.attributes.get('src')).toBe('https://render.guildwars2.com/x/y.png');
		expect(icons[0]?.attributes.get('alt')).toBe('');
	});

	it('never renders an icon from a host other than render.guildwars2.com', () => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('collecting'), watchItemIds: [36_038], selectedItemId: 36_038, daily: [daily('2026-08-29', 100)] },
			itemIcons: { 36_038: 'https://evil.example/x.png' },
			onEnable: vi.fn(), onLoad: vi.fn(),
		});
		expect(walk(mount.container).some((element) => element.className === 'tyrian-price-history__item-icon')).toBe(false);
	});

	it('keeps the panel working, fallback label included, when no icon or name resolved yet', () => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('collecting'), watchItemIds: [36_038], selectedItemId: 36_038, daily: [daily('2026-08-29', 100)] },
			onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const elements = walk(mount.container);
		expect(elements.find((element) => element.tag === 'select')?.children[0]?.textContent).toBe('Item #36038');
		expect(elements.find((element) => element.tag === 'figcaption')?.textContent).toBe('Item #36038 · Sell listing · last 42 UTC days');
		expect(elements.some((element) => element.className === 'tyrian-price-history__item-icon')).toBe(false);
	});

	it('says so and keeps rendering the local-only chart when datawars2 has no seed', () => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('ready'), watchItemIds: [36_038], selectedItemId: 36_038, daily: [daily('2026-08-29', 100)] },
			seed: { status: 'no_seed', itemId: 36_038, days: [], failureReason: 'unreachable', retrievedAt: null },
			onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const body = walk(mount.container).map(({ textContent }) => textContent).join('\n');
		expect(body).toContain('datawars2 is not available right now. Showing only your local capture.');
		expect(walk(mount.container).some((element) => element.tag === 'figure')).toBe(true);
	});

	it('draws the datawars2 gap as its own dashed price-seed line, distinct from the local price-close line', () => {
		const svg = priceHistorySvg(
			[daily('2026-08-29', 140)],
			'ask',
			[
				{ dayUtc: '2026-08-27', bidCopper: 90, askCopper: 100 },
				{ dayUtc: '2026-08-28', bidCopper: 95, askCopper: 105 },
				// This day is already covered locally: it must NOT also appear on the seed line.
				{ dayUtc: '2026-08-29', bidCopper: 130, askCopper: 138 },
			],
		);
		expect(svg).toContain('class="price-seed"');
		expect(svg).toContain('class="price-close-marker"');
		expect(svg.match(/points="[^"]*"/gu)).toHaveLength(1);
	});

	it('draws the seed line solid, never dashed, when there is no local capture to confuse it with (behaviour test 4)', () => {
		const svg = priceHistorySvg([], 'bid', [
			{ dayUtc: '2026-08-27', bidCopper: 90, askCopper: 100 },
			{ dayUtc: '2026-08-28', bidCopper: 95, askCopper: 105 },
		]);
		expect(svg).toContain('class="price-seed-solo"');
		expect(svg).not.toContain('class="price-seed"');
		expect(svg).not.toContain('class="price-median"');
		expect(svg).not.toContain('class="price-close"');
	});

	it('tags each row of the accessible table with its provenance, local capture never overwritten by the seed', () => {
		const mount = createMount();
		renderPriceHistoryPanel(mount.container as unknown as HTMLElement, createTranslator('en'), {
			state: { ...state('ready'), watchItemIds: [36_038], selectedItemId: 36_038, daily: [daily('2026-08-29', 140)] },
			seed: {
				status: 'seeded', itemId: 36_038, retrievedAt: '2026-09-01T00:00:00.000Z', failureReason: null,
				days: [
					{ dayUtc: '2026-08-27', bidCopper: 90, askCopper: 100 },
					{ dayUtc: '2026-08-29', bidCopper: 999, askCopper: 999 },
				],
			},
			onEnable: vi.fn(), onLoad: vi.fn(),
		});
		const rows = walk(mount.container).filter((element) => element.tag === 'tr').slice(1);
		const cellsOf = (row: FakeElement): string[] => row.children.map((cell) => cell.textContent ?? '');
		expect(rows).toHaveLength(2);
		expect(cellsOf(rows[0]!)).toEqual(['2026-08-27', 'datawars2 (third party)', '—', '—', '—', '100']);
		expect(cellsOf(rows[1]!)).toEqual(['2026-08-29', 'Own capture', '140', '140', '140', '140']);
		const seedNote = walk(mount.container).find((element) => element.className === 'tyrian-price-history__seed-note');
		expect(seedNote?.textContent).toBe('History extended with datawars2: 1 days before your own capture.');
	});
});

function state(status: PriceHistoryRuntimeState['status']): PriceHistoryRuntimeState {
	return { status, watchItemIds: [], selectedItemId: null, selectedSide: 'ask', windowDays: 42,
		daily: [], lastSampleAtMs: null, nextCaptureAtMs: null, provisionalDayUtc: null };
}
function daily(dayUtc: string, close: number): PriceHistoryDailyV1 {
	return { version: 1, vaultId: 'vault', itemId: 36_038, dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
		bid: null, ask: { count: 1, minCopper: close, maxCopper: close, medianCopperX2: close * 2, closeCopper: close, closeCapturedAtMs: Date.parse(`${dayUtc}T12:00:00.000Z`) } };
}
function createMount(): { container: FakeElement } {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string) => new FakeElement(tag, document));
	vi.stubGlobal('createDiv', () => new FakeElement('div', document));
	vi.stubGlobal('createSpan', () => new FakeElement('span', document));
	return { container: new FakeElement('div', document) };
}
function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }
class FakeDocument {
	activeElement: FakeElement | null = null;
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}
class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = ''; textContent: string | null = null; type = ''; value = ''; disabled = false; scope = '';
	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	addEventListener(type: string, listener: () => void): void { const entries = this.listeners.get(type) ?? []; entries.push(listener); this.listeners.set(type, entries); }
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
}
