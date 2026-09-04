import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';
import { mountPriceHistoryChart } from './price-history-chart-view';

afterEach(() => vi.unstubAllGlobals());

describe('price history chart widget (H9.1/H9.2 shared)', () => {
	it('covers the real value range and reports the known series max/min/last (behaviour test 1)', () => {
		const mount = createMount();
		const daily = [daily_('2026-01-01', 100), daily_('2026-01-02', 300), daily_('2026-01-03', 200)];
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily, side: 'ask', seedDays: [] });
		const elements = walk(mount.container);
		const priceLabels = elements.filter((element) => element.className === 'tyrian-price-chart__price-label').map((element) => element.textContent);
		// formatLootMoney(100,...) === '0g 1s 0c', formatLootMoney(300,...) === '0g 3s 0c'.
		expect(priceLabels).toContain('0g 1s 0c');
		expect(priceLabels).toContain('0g 3s 0c');
		const summaryText = elements.filter((element) => element.tag === 'dd').map((element) => element.textContent);
		expect(summaryText).toContain('0g 3s 0c · 2026-01-02');
		expect(summaryText).toContain('0g 1s 0c · 2026-01-01');
		expect(summaryText).toContain('0g 2s 0c · 2026-01-03');
	});

	it('changing the zoom window redraws the summary and never touches the network (behaviour test 2)', () => {
		const mount = createMount();
		const daily = Array.from({ length: 400 }, (_unused, index) => daily_(dayAt(index), 100 + index));
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily, side: 'ask', seedDays: [] });
		const before = summaryOf(mount.container);
		const oneMonthButton = walk(mount.container).find((element) => element.tag === 'button' && element.textContent === '1 month');
		expect(oneMonthButton).toBeDefined();
		oneMonthButton?.dispatch('click');
		const after = summaryOf(mount.container);
		expect(after).not.toEqual(before);
		// `mountPriceHistoryChart` never receives (and this module never imports) any transport,
		// fetch, or IndexedDB capability: the interaction above cannot have asked the network for
		// anything, structurally, not just because nothing was observed to fire.
	});

	it('provides a keyboard-operable range control equivalent to dragging a selection', () => {
		const mount = createMount();
		const daily = Array.from({ length: 40 }, (_unused, index) => daily_(dayAt(index), 100 + index));
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily, side: 'ask', seedDays: [] });
		const rangeInputs = walk(mount.container).filter((element) => element.tag === 'input' && element.type === 'range');
		expect(rangeInputs).toHaveLength(2);
		const before = summaryOf(mount.container);
		rangeInputs[0]!.value = '10';
		rangeInputs[0]!.dispatch('change');
		const after = summaryOf(mount.container);
		expect(after).not.toEqual(before);
	});

	it('aggregates once the series has more days than plot pixels, and declares it (behaviour test 3)', () => {
		const mount = createMount();
		const daily = Array.from({ length: 1_000 }, (_unused, index) => daily_(dayAt(index), 100 + (index % 50)));
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily, side: 'ask', seedDays: [] });
		const note = walk(mount.container).find((element) => element.className === 'tyrian-price-chart__aggregation-note');
		expect(note?.textContent).toContain('Aggregated by week');
	});

	it('never aggregates (and never declares it) when the series fits the plot', () => {
		const mount = createMount();
		const daily = [daily_('2026-01-01', 100), daily_('2026-01-02', 300)];
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily, side: 'ask', seedDays: [] });
		const note = walk(mount.container).find((element) => element.className === 'tyrian-price-chart__aggregation-note');
		expect(note).toBeUndefined();
	});

	it('draws the seed line solid with no local series, dashed once a local series shares the chart (behaviour test 4)', () => {
		const seedOnlyMount = createMount();
		mountPriceHistoryChart(seedOnlyMount.container as unknown as HTMLElement, createTranslator('en'), {
			daily: [], side: 'bid', seedDays: [seedDay('2026-08-01', 100), seedDay('2026-08-02', 120)],
		});
		const seedOnlyElements = walk(seedOnlyMount.container);
		expect(seedOnlyElements.some((element) => element.className === 'price-seed-solo')).toBe(true);
		expect(seedOnlyElements.some((element) => element.className === 'price-seed')).toBe(false);

		const mixedMount = createMount();
		mountPriceHistoryChart(mixedMount.container as unknown as HTMLElement, createTranslator('en'), {
			daily: [daily_('2026-08-29', 140)], side: 'ask',
			seedDays: [seedDay('2026-08-27', 90, 100), seedDay('2026-08-28', 95, 105)],
		});
		const mixedElements = walk(mixedMount.container);
		expect(mixedElements.some((element) => element.className === 'price-seed')).toBe(true);
		expect(mixedElements.some((element) => element.className === 'price-seed-solo')).toBe(false);
	});

	it('resets to an empty container for an empty series instead of drawing an empty widget', () => {
		const mount = createMount();
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily: [], side: 'ask', seedDays: [] });
		expect(mount.container.children).toHaveLength(0);
	});
});

function summaryOf(container: FakeElement): string[] {
	return walk(container).filter((element) => element.tag === 'dd').map((element) => element.textContent ?? '');
}

function daily_(dayUtc: string, closeCopper: number): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId: 36_038, dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
		bid: null,
		ask: {
			count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2,
			closeCopper, closeCapturedAtMs: Date.parse(`${dayUtc}T12:00:00.000Z`),
		},
	};
}

function seedDay(dayUtc: string, bidCopper: number, askCopper: number | null = null): PriceSeedDayV1 {
	return { dayUtc, bidCopper, askCopper };
}

function dayAt(offsetFromEpochAnchor: number): string {
	return new Date(Date.UTC(2026, 0, 1) + offsetFromEpochAnchor * 86_400_000).toISOString().slice(0, 10);
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
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = ''; textContent: string | null = null; type = ''; value = ''; disabled = false;
	constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
	append(...children: FakeElement[]): void { this.children.push(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	addEventListener(type: string, listener: () => void): void { const entries = this.listeners.get(type) ?? []; entries.push(listener); this.listeners.set(type, entries); }
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	setAttribute(name: string, value: string): void {
		if (name === 'class') this.className = value; else this.attributes.set(name, value);
	}
}
