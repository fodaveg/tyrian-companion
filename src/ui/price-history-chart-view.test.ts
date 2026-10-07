import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTranslator } from '../core/i18n';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';
import { mountPriceHistoryChart } from './price-history-chart-view';
import { PRICE_HISTORY_CHART_ROW_WINDOWS } from './price-history-chart-model';

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

describe('price history chart widget: the opt-in options of a surface that is for looking', () => {
	const seedDays = (count: number): PriceSeedDayV1[] => Array.from({ length: count }, (_unused, index) => (
		{ dayUtc: dayAt(index), bidCopper: 10, askCopper: 100 + index }
	));
	const pressedLabels = (container: FakeElement): string[] => walk(container)
		.filter((element) => element.tag === 'button' && element.attributes.get('aria-pressed') === 'true')
		.map((element) => element.textContent ?? '');
	const buttonLabels = (container: FakeElement): string[] => walk(container).filter((element) => element.tag === 'button').map((element) => element.textContent ?? '');
	const looking = { windows: PRICE_HISTORY_CHART_ROW_WINDOWS, initialWindow: '3m' as const, explore: false };

	it('offers only the listed windows and opens on a real 90-day window, pressed', () => {
		const mount = createMount();
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily: [], side: 'ask', seedDays: seedDays(300), ...looking });

		// Day 299 is the last one: 100 + 299 = 399 copper; the first of the 90 shown is day 210 (310 copper).
		expect(summaryOf(mount.container)).toContain('0g 3s 99c · 2026-10-27');
		expect(summaryOf(mount.container)).toContain('0g 3s 10c · 2026-07-30');
		expect(buttonLabels(mount.container)).toEqual(['3 months', '1 year', 'All']);
		expect(pressedLabels(mount.container)).toEqual(['3 months']);
	});

	it('draws no range slider, no reset and no drag selection when explore is off', () => {
		const mount = createMount();
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily: [], side: 'ask', seedDays: seedDays(300), ...looking });
		const all = walk(mount.container);

		expect(all.filter((element) => element.tag === 'input')).toHaveLength(0);
		expect(all.filter((element) => element.className === 'tyrian-price-chart__range')).toHaveLength(0);
		expect(all.filter((element) => element.tag === 'svg').every((element) => (element.listeners?.size ?? 0) === 0)).toBe(true);
	});

	it('opens on «All», pressed, when the series does not reach back as far as the window', () => {
		const mount = createMount();
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily: [], side: 'ask', seedDays: seedDays(5), ...looking });

		expect(pressedLabels(mount.container)).toEqual(['All']);
	});

	it('is the old behaviour without the options: the four windows, everything, sliders', () => {
		const mount = createMount();
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily: [], side: 'ask', seedDays: seedDays(300) });

		expect(buttonLabels(mount.container)).toEqual(['1 month', '1 year', '5 years', 'All']);
		expect(pressedLabels(mount.container)).toEqual(['All']);
		expect(walk(mount.container).filter((element) => element.tag === 'input')).toHaveLength(2);
	});

	it('a reader\'s own zoom wins over the initial window on a repaint of the same series', () => {
		const mount = createMount();
		const options = { daily: [], side: 'ask' as const, seedDays: seedDays(300), ...looking };
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), options);
		walk(mount.container).find((element) => element.tag === 'button' && element.textContent === 'All')!.dispatch('click');
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), options);

		expect(pressedLabels(mount.container)).toEqual(['All']);
	});

	it('draws the compact layout: a 200-unit frame, three price marks, two date marks, first starting and last ending', () => {
		const mount = createMount();
		mountPriceHistoryChart(mount.container as unknown as HTMLElement, createTranslator('en'), { daily: [], side: 'ask', seedDays: seedDays(300), ...looking, layout: 'compact' });
		const all = walk(mount.container);

		expect(all.find((element) => element.tag === 'svg')?.attributes.get('viewBox')).toBe('0 0 200 190');
		for (const [compactWidth, viewBox] of [[100, '0 0 200 190'], [306, '0 0 306 190'], [900, '0 0 479 190']] as const) {
			const other = createMount();
			mountPriceHistoryChart(other.container as unknown as HTMLElement, createTranslator('en'), { daily: [], side: 'ask', seedDays: seedDays(300), ...looking, layout: 'compact', compactWidth });
			expect(walk(other.container).find((element) => element.tag === 'svg')?.attributes.get('viewBox')).toBe(viewBox);
		}
		expect(all.filter((element) => element.className === 'tyrian-price-chart__price-label')).toHaveLength(3);
		expect(all.filter((element) => element.className.startsWith('tyrian-price-chart__date-label')).map((element) => element.className)).toEqual([
			'tyrian-price-chart__date-label tyrian-price-chart__date-label--start',
			'tyrian-price-chart__date-label tyrian-price-chart__date-label--end',
		]);
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
