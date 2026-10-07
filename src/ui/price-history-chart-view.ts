import type { Translator } from '../core/i18n';
import type { PriceHistoryDailyV1, PriceHistorySide } from '../economy/price-history-model';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';
import { formatLootMoney } from '../sessions/loot-presentation';
import {
	PRICE_HISTORY_SVG_HEIGHT,
	PRICE_HISTORY_SVG_PADDING,
	PRICE_HISTORY_SVG_WIDTH,
	priceHistorySvgElement,
} from './price-history-svg';
import {
	aggregatePriceHistoryChartPoints,
	filterPriceHistoryChartRange,
	mergePriceHistoryChartPoints,
	priceHistoryChartAggregationUnit,
	priceHistoryChartIndexAtOffset,
	priceHistoryChartSummary,
	priceHistoryChartWindowRange,
	priceHistoryDateAxisLabels,
	priceHistoryDateAxisTicks,
	priceHistoryPriceAxisTicks,
	PRICE_HISTORY_CHART_ALL_RANGE,
	PRICE_HISTORY_CHART_WINDOWS,
	type PriceHistoryChartAggregatedPoint,
	type PriceHistoryChartAggregationUnit,
	type PriceHistoryChartPoint,
	type PriceHistoryChartRange,
	type PriceHistoryChartWindowId,
} from './price-history-chart-model';

/**
 * H9.1/H9.2: the interactive chart widget shared by the settings panel and the
 * note-embedded piloto block. Everything a plain SVG could not give either one
 * on its own lives here: readable price/date axes, a max/min/last summary, and
 * a zoom the reader drives without ever asking the network for more.
 *
 * Zoom state lives ONLY in this module's `ZOOM_STATE` map, keyed by the
 * `container` element the caller passes in. It is never read from or written
 * to the note or the vault, and it resets the moment the underlying series
 * changes (a different item, a different side) so a stale pixel range is
 * never applied to data it was never measured against.
 */

export interface PriceHistoryChartMountOptions {
	readonly daily: readonly PriceHistoryDailyV1[];
	readonly side: PriceHistorySide;
	readonly seedDays: readonly PriceSeedDayV1[];
	/**
	 * The window presets to offer, in order. Default: the four of the settings panel and the note
	 * block. A surface that is for looking, not exploring, passes `PRICE_HISTORY_CHART_ROW_WINDOWS`.
	 */
	readonly windows?: ReadonlyArray<{ readonly id: PriceHistoryChartWindowId; readonly days: number | null }>;
	/**
	 * The preset a fresh series opens on (default: «all»). A series that does not reach back as far
	 * as the preset opens on «all», with that button pressed. A reader's own zoom outlives repaints.
	 */
	readonly initialWindow?: PriceHistoryChartWindowId;
	/**
	 * `false` leaves out everything that explores: the two range sliders, the drag selection and the
	 * custom-range reset. Default `true`.
	 */
	readonly explore?: boolean;
	/**
	 * `'compact'` draws the narrow variant: a small viewBox so an axis label stays readable at ~280 px,
	 * three price marks and two date marks. The caller measures its container once and decides;
	 * default `'wide'`.
	 */
	readonly layout?: 'wide' | 'compact';
}

interface ChartZoomState {
	seriesKey: string;
	windowId: PriceHistoryChartWindowId | 'custom';
	customRange: PriceHistoryChartRange | null;
}

const ZOOM_STATE = new WeakMap<HTMLElement, ChartZoomState>();

/** The plot's own inner width, in the units its ordinal x-axis already uses: one point per pixel is generous. */
const PLOT_INNER_WIDTH = PRICE_HISTORY_SVG_WIDTH - PRICE_HISTORY_SVG_PADDING * 2;

interface ChartGeometry {
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly plotLeft: number;
	readonly plotTop: number;
	readonly plotWidth: number;
	readonly plotHeight: number;
	readonly priceTickCount: number;
	readonly dateTickCount: number;
	readonly compact: boolean;
}

const WIDE_GEOMETRY: ChartGeometry = {
	outerWidth: 800, outerHeight: 300, plotLeft: 84, plotTop: 8, plotWidth: 800 - 84 - 16, plotHeight: 232,
	priceTickCount: 4, dateTickCount: 5, compact: false,
};
/**
 * 200 units wide: at 280 px the block is ~196 px of drawing, so a label of 11 units reads at ~10.8 px
 * (the wide drawing, 800 units, put the same label at 2.9 px). The left margin holds «1g 55s 47c».
 */
const COMPACT_GEOMETRY: ChartGeometry = {
	outerWidth: 200, outerHeight: 190, plotLeft: 74, plotTop: 8, plotWidth: 118, plotHeight: 150,
	priceTickCount: 3, dateTickCount: 2, compact: true,
};
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Mounts (or repaints) the chart into `container`. `container` is replaced
 * wholesale on every call, exactly like the rest of this codebase's render
 * functions: the caller owns when a repaint happens, this only owns what gets
 * drawn once it does.
 */
export function mountPriceHistoryChart(
	container: HTMLElement,
	translator: Translator,
	options: PriceHistoryChartMountOptions,
): void {
	const merged = mergePriceHistoryChartPoints(options.daily, options.side, options.seedDays);
	container.replaceChildren();
	// Additive: the caller already carries its own bordering class
	// (`.tyrian-price-history__chart` or `.tyrian-price-history-note__chart`) and this widget's own
	// classes are namespaced separately, so neither styling layer overwrites the other.
	if (!container.className.split(/\s+/u).includes('tyrian-price-chart')) {
		container.className = container.className.length === 0 ? 'tyrian-price-chart' : `${container.className} tyrian-price-chart`;
	}
	if (merged.length === 0) return;

	const seriesKey = `${merged[0]!.dayUtc}:${merged.at(-1)!.dayUtc}:${String(merged.length)}`;
	const hasLocal = merged.some((point) => point.source === 'local');
	const stored = ZOOM_STATE.get(container);
	const state: ChartZoomState = stored !== undefined && stored.seriesKey === seriesKey
		? stored
		: initialChartZoom(seriesKey, merged, options.initialWindow, options.windows ?? PRICE_HISTORY_CHART_WINDOWS);
	ZOOM_STATE.set(container, state);

	const document = container.ownerDocument;
	const geometry = options.layout === 'compact' ? COMPACT_GEOMETRY : WIDE_GEOMETRY;
	const explore = options.explore !== false;
	const windows = options.windows ?? PRICE_HISTORY_CHART_WINDOWS;
	if (geometry.compact && !container.className.split(/\s+/u).includes('tyrian-price-chart--compact')) container.className += ' tyrian-price-chart--compact';

	const paint = (): void => {
		container.replaceChildren();
		const range = state.windowId === 'custom'
			? (state.customRange ?? PRICE_HISTORY_CHART_ALL_RANGE)
			: priceHistoryChartWindowRange(merged, state.windowId);
		let filtered = filterPriceHistoryChartRange(merged, range);
		if (filtered.length === 0) filtered = merged;
		const unit = priceHistoryChartAggregationUnit(filtered.length, PLOT_INNER_WIDTH);
		const aggregated = aggregatePriceHistoryChartPoints(filtered, unit);

		container.append(buildToolbar(translator, state, windows, explore, paint));
		container.append(buildPlot(document, options, geometry, explore, filtered, aggregated, hasLocal, translator, state, paint));
		if (explore) container.append(buildRangeControls(translator, state, merged, filtered, paint));
		container.append(buildSummary(translator, filtered));
		const aggregationNote = buildAggregationNote(translator, unit);
		if (aggregationNote !== null) container.append(aggregationNote);
	};

	paint();
}

function initialChartZoom(
	seriesKey: string,
	merged: readonly PriceHistoryChartPoint[],
	initialWindow: PriceHistoryChartWindowId | undefined,
	windows: ReadonlyArray<{ readonly id: PriceHistoryChartWindowId; readonly days: number | null }>,
): ChartZoomState {
	const all: ChartZoomState = { seriesKey, windowId: 'all', customRange: null };
	if (initialWindow === undefined || initialWindow === 'all') return all;
	const days = windows.find((entry) => entry.id === initialWindow)?.days ?? null;
	if (days === null) return all;
	// A series that starts inside the window is the whole series: «all», pressed, not a preset that shows the same.
	const range = priceHistoryChartWindowRange(merged, initialWindow);
	if (range.startDayUtc === null || merged[0]!.dayUtc >= range.startDayUtc) return all;
	return { seriesKey, windowId: initialWindow, customRange: null };
}

function buildToolbar(
	translator: Translator,
	state: ChartZoomState,
	windows: ReadonlyArray<{ readonly id: PriceHistoryChartWindowId }>,
	explore: boolean,
	repaint: () => void,
): HTMLElement {
	const toolbar = createDiv();
	toolbar.className = 'tyrian-price-chart__toolbar';
	const group = createDiv();
	group.className = 'tyrian-price-chart__window-group';
	group.setAttribute('role', 'group');
	group.setAttribute('aria-label', translator.t('priceHistory.chart.windowGroupLabel'));
	for (const window of windows) {
		const active = state.windowId === window.id;
		const windowButton = createEl('button');
		windowButton.type = 'button';
		windowButton.textContent = translator.t(`priceHistory.chart.window.${window.id}`);
		windowButton.setAttribute('aria-pressed', String(active));
		const selectWindow = (): void => {
			state.windowId = window.id;
			state.customRange = null;
			repaint();
		};
		windowButton.addEventListener('click', selectWindow);
		group.append(windowButton);
	}
	toolbar.append(group);
	if (explore && state.windowId === 'custom') {
		const reset = createEl('button');
		reset.type = 'button';
		reset.className = 'tyrian-price-chart__reset';
		reset.textContent = translator.t('priceHistory.chart.reset');
		const resetZoom = (): void => {
			state.windowId = 'all';
			state.customRange = null;
			repaint();
		};
		reset.addEventListener('click', resetZoom);
		toolbar.append(reset);
	}
	return toolbar;
}

function buildPlot(
	document: Document,
	options: PriceHistoryChartMountOptions,
	geometry: ChartGeometry,
	explore: boolean,
	filtered: readonly PriceHistoryChartPoint[],
	aggregated: readonly PriceHistoryChartAggregatedPoint[],
	hasLocal: boolean,
	translator: Translator,
	state: ChartZoomState,
	repaint: () => void,
): HTMLElement {
	const plotWrap = createDiv();
	plotWrap.className = 'tyrian-price-chart__plot';
	const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
	svg.setAttribute('viewBox', `0 0 ${String(geometry.outerWidth)} ${String(geometry.outerHeight)}`);
	svg.setAttribute('width', '100%');
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-hidden', 'true');

	const dateTicks = priceHistoryDateAxisTicks(aggregated, geometry.dateTickCount);
	const priceTicks = priceHistoryPriceAxisTicks(aggregated, geometry.priceTickCount);
	const bounds = valueBoundsOf(aggregated);
	const toOuterX = (index: number): number => geometry.plotLeft + xInner(index, aggregated.length) * (geometry.plotWidth / PRICE_HISTORY_SVG_WIDTH);
	const toOuterY = (value: number): number => bounds === null
		? geometry.plotTop + geometry.plotHeight / 2
		: geometry.plotTop + yInner(value, bounds) * (geometry.plotHeight / PRICE_HISTORY_SVG_HEIGHT);

	for (const value of priceTicks) {
		const y = round(toOuterY(value));
		const gridline = document.createElementNS(SVG_NAMESPACE, 'line');
		gridline.setAttribute('class', 'tyrian-price-chart__gridline');
		gridline.setAttribute('x1', String(geometry.plotLeft)); gridline.setAttribute('x2', String(geometry.plotLeft + geometry.plotWidth));
		gridline.setAttribute('y1', String(y)); gridline.setAttribute('y2', String(y));
		svg.append(gridline);
		const label = document.createElementNS(SVG_NAMESPACE, 'text');
		label.setAttribute('class', 'tyrian-price-chart__price-label');
		label.setAttribute('x', String(geometry.plotLeft - 6));
		label.setAttribute('y', String(y));
		label.textContent = formatLootMoney(value, translator.locale).visual;
		svg.append(label);
	}
	const dateLabels = priceHistoryDateAxisLabels(dateTicks, translator.locale, daySpan(aggregated));
	for (const [position, tick] of dateTicks.entries()) {
		const x = round(toOuterX(tick.index));
		const label = document.createElementNS(SVG_NAMESPACE, 'text');
		// Compact: the first mark starts at the plot's left edge and the last one ends at its right, so neither leaves the drawing.
		const edge = geometry.compact && dateTicks.length > 1 ? (position === 0 ? ' tyrian-price-chart__date-label--start' : position === dateTicks.length - 1 ? ' tyrian-price-chart__date-label--end' : '') : '';
		label.setAttribute('class', `tyrian-price-chart__date-label${edge}`);
		label.setAttribute('x', String(edge.length > 0 ? (position === 0 ? geometry.plotLeft : geometry.plotLeft + geometry.plotWidth) : x));
		label.setAttribute('y', String(geometry.outerHeight - 6));
		label.textContent = dateLabels[position]!;
		svg.append(label);
	}

	const dayLevel = aggregated.length === filtered.length && aggregated.every((point) => point.dayCount === 1);
	if (dayLevel) {
		// Day-level: the exact plot engine the settings panel has always drawn with (H9.1),
		// range/median/close geometry included, only re-hosted inside the axis frame above it.
		const localSlice = options.daily.filter((entry) => inRange(entry.dayUtc, filtered));
		const seedSlice = options.seedDays.filter((day) => inRange(day.dayUtc, filtered));
		const inner = priceHistorySvgElement(localSlice, options.side, seedSlice, document);
		positionNestedPlot(inner, geometry);
		svg.append(inner);
	} else {
		const aggregatedSvg = document.createElementNS(SVG_NAMESPACE, 'svg');
		aggregatedSvg.setAttribute('viewBox', `0 0 ${String(PRICE_HISTORY_SVG_WIDTH)} ${String(PRICE_HISTORY_SVG_HEIGHT)}`);
		aggregatedSvg.setAttribute('role', 'img');
		aggregatedSvg.setAttribute('aria-hidden', 'true');
		aggregatedSvg.append(aggregatedPlotGroup(document, aggregated, hasLocal));
		positionNestedPlot(aggregatedSvg, geometry);
		svg.append(aggregatedSvg);
	}

	if (explore) attachDragSelection(svg, plotWrap, geometry, aggregated, state, repaint);
	plotWrap.append(svg);
	return plotWrap;
}

function positionNestedPlot(element: SVGSVGElement, geometry: ChartGeometry): void {
	element.setAttribute('x', String(geometry.plotLeft));
	element.setAttribute('y', String(geometry.plotTop));
	element.setAttribute('width', String(geometry.plotWidth));
	element.setAttribute('height', String(geometry.plotHeight));
	// The compact frame is far narrower than the 760x240 plot it hosts: stretch it to the frame (the
	// line's width is kept in pixels by the stylesheet) instead of letterboxing it into a sliver.
	if (geometry.compact) element.setAttribute('preserveAspectRatio', 'none');
}

function inRange(dayUtc: string, points: readonly { readonly dayUtc: string }[]): boolean {
	return points.length > 0 && dayUtc >= points[0]!.dayUtc && dayUtc <= points.at(-1)!.dayUtc;
}

function xInner(index: number, pointCount: number): number {
	return round(PRICE_HISTORY_SVG_PADDING + index * ((PRICE_HISTORY_SVG_WIDTH - PRICE_HISTORY_SVG_PADDING * 2) / Math.max(1, pointCount - 1)));
}

function yInner(value: number, bounds: { readonly minimum: number; readonly maximum: number }): number {
	const spread = Math.max(1, bounds.maximum - bounds.minimum);
	return round(PRICE_HISTORY_SVG_HEIGHT - PRICE_HISTORY_SVG_PADDING - ((value - bounds.minimum) / spread) * (PRICE_HISTORY_SVG_HEIGHT - PRICE_HISTORY_SVG_PADDING * 2));
}

/**
 * The bounds `priceHistoryPriceAxisTicks` derives its ticks from, recomputed
 * here from the SAME points with the SAME extraction so the plot's y-mapping
 * and the axis gridlines never drift apart.
 */
function valueBoundsOf(
	points: ReadonlyArray<{ readonly value: number | null; readonly minValue: number | null; readonly maxValue: number | null }>,
): { readonly minimum: number; readonly maximum: number } | null {
	const values = points.flatMap((point) => [point.value, point.minValue, point.maxValue]).filter((value): value is number => value !== null);
	if (values.length === 0) return null;
	return { minimum: Math.min(...values), maximum: Math.max(...values) };
}

/**
 * The aggregated (week/month) plot: one range tick and one value line per
 * bucket, ordinal x-axis like the day-level engine. Buckets are already a
 * coarse summary, so unlike the day-level plot this draws ONE continuous
 * line without splitting on a day-to-day gap: at week/month resolution a
 * multi-day hole in the underlying series is not worth a visible break.
 */
function aggregatedPlotGroup(document: Document, points: readonly PriceHistoryChartAggregatedPoint[], hasLocal: boolean): SVGGElement {
	const group = document.createElementNS(SVG_NAMESPACE, 'g');
	const bounds = valueBoundsOf(points);
	const className = hasLocal ? 'price-close' : 'price-seed-solo';
	for (const [index, point] of points.entries()) {
		if (point.minValue === null || point.maxValue === null || bounds === null) continue;
		const line = document.createElementNS(SVG_NAMESPACE, 'line');
		line.setAttribute('class', 'price-range');
		line.setAttribute('x1', String(xInner(index, points.length)));
		line.setAttribute('x2', String(xInner(index, points.length)));
		line.setAttribute('y1', String(yInner(point.minValue, bounds)));
		line.setAttribute('y2', String(yInner(point.maxValue, bounds)));
		group.append(line);
	}
	const coordinates = points
		.map((point, index) => (point.value === null || bounds === null ? null : `${String(xInner(index, points.length))},${String(yInner(point.value, bounds))}`))
		.filter((value): value is string => value !== null);
	if (coordinates.length > 1) {
		const polyline = document.createElementNS(SVG_NAMESPACE, 'polyline');
		polyline.setAttribute('class', className);
		polyline.setAttribute('points', coordinates.join(' '));
		group.append(polyline);
	} else if (coordinates.length === 1) {
		const [pointX, pointY] = coordinates[0]!.split(',');
		const marker = document.createElementNS(SVG_NAMESPACE, 'circle');
		marker.setAttribute('class', `${className}-marker`);
		marker.setAttribute('cx', pointX!); marker.setAttribute('cy', pointY!); marker.setAttribute('r', '5');
		group.append(marker);
	}
	return group;
}

/**
 * Pointer-drag range selection. A real-DOM-only interaction (it reads
 * `getBoundingClientRect`, absent from this repo's Node test environment);
 * the pixel math it delegates to (`priceHistoryChartIndexAtOffset`) is unit
 * tested on its own in `price-history-chart-model.test.ts`. The range
 * sliders built by `buildRangeControls` are the keyboard-operable equivalent
 * of the same "select a custom range" action.
 */
function attachDragSelection(
	svg: SVGSVGElement,
	plotWrap: HTMLElement,
	geometry: ChartGeometry,
	aggregated: readonly PriceHistoryChartAggregatedPoint[],
	state: ChartZoomState,
	repaint: () => void,
): void {
	if (aggregated.length < 2) return;
	let dragStartIndex: number | null = null;
	const indexAt = (clientX: number): number => {
		const rect = plotWrap.getBoundingClientRect?.();
		if (rect === undefined || rect.width <= 0) return 0;
		const scale = geometry.outerWidth / rect.width;
		const offsetX = (clientX - rect.left) * scale;
		return priceHistoryChartIndexAtOffset(offsetX, geometry.plotLeft, geometry.plotWidth, aggregated.length);
	};
	const onPointerDown = (event: PointerEvent): void => {
		dragStartIndex = indexAt(event.clientX);
	};
	const onPointerUp = (event: PointerEvent): void => {
		if (dragStartIndex === null) return;
		const endIndex = indexAt(event.clientX);
		const from = Math.min(dragStartIndex, endIndex);
		const to = Math.max(dragStartIndex, endIndex);
		dragStartIndex = null;
		if (from === to) return;
		state.windowId = 'custom';
		state.customRange = { startDayUtc: aggregated[from]!.dayUtc, endDayUtc: aggregated[to]!.dayUtc };
		repaint();
	};
	svg.addEventListener('pointerdown', onPointerDown);
	svg.addEventListener('pointerup', onPointerUp);
}

function buildRangeControls(
	translator: Translator,
	state: ChartZoomState,
	merged: readonly PriceHistoryChartPoint[],
	filtered: readonly PriceHistoryChartPoint[],
	repaint: () => void,
): HTMLElement {
	const wrap = createDiv();
	wrap.className = 'tyrian-price-chart__range';
	if (merged.length < 2) return wrap;
	const firstFiltered = filtered[0];
	const lastFiltered = filtered.at(-1);
	const startIndex = firstFiltered === undefined ? 0 : merged.findIndex((point) => point.dayUtc === firstFiltered.dayUtc);
	const endIndexFound = lastFiltered === undefined ? -1 : merged.findIndex((point) => point.dayUtc === lastFiltered.dayUtc);
	const endIndex = endIndexFound < 0 ? merged.length - 1 : endIndexFound;
	const from = buildRangeField(translator.t('priceHistory.chart.rangeFrom'), merged.length, Math.max(0, startIndex));
	const to = buildRangeField(translator.t('priceHistory.chart.rangeTo'), merged.length, endIndex);
	const applyCustomRange = (): void => {
		const fromIndex = clampIndex(Number(from.input.value), merged.length);
		const toIndex = clampIndex(Number(to.input.value), merged.length);
		const lowIndex = Math.min(fromIndex, toIndex);
		const highIndex = Math.max(fromIndex, toIndex);
		state.windowId = 'custom';
		state.customRange = { startDayUtc: merged[lowIndex]!.dayUtc, endDayUtc: merged[highIndex]!.dayUtc };
		repaint();
	};
	from.input.addEventListener('change', applyCustomRange);
	to.input.addEventListener('change', applyCustomRange);
	wrap.append(from.label, to.label);
	return wrap;
}

function clampIndex(value: number, length: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(length - 1, Math.max(0, Math.round(value)));
}

function buildRangeField(text: string, pointCount: number, value: number): { label: HTMLLabelElement; input: HTMLInputElement } {
	const label = createEl('label');
	label.className = 'tyrian-price-chart__range-field';
	const span = createSpan();
	span.textContent = text;
	const input = createEl('input');
	input.type = 'range';
	input.setAttribute('min', '0');
	input.setAttribute('max', String(Math.max(0, pointCount - 1)));
	input.value = String(value);
	label.append(span, input);
	return { label, input };
}

function buildSummary(translator: Translator, filtered: readonly PriceHistoryChartPoint[]): HTMLElement {
	const summary = priceHistoryChartSummary(filtered);
	const list = createEl('dl');
	list.className = 'tyrian-price-chart__summary';
	for (const [key, entry] of [
		['max', summary.max], ['min', summary.min], ['last', summary.last],
	] as const) {
		if (entry === null) continue;
		const row = createDiv();
		const term = createEl('dt');
		term.textContent = translator.t(`priceHistory.chart.summary.${key}`);
		const definition = createEl('dd');
		definition.textContent = `${formatLootMoney(entry.value, translator.locale).visual} · ${entry.dayUtc}`;
		row.append(term, definition);
		list.append(row);
	}
	return list;
}

function buildAggregationNote(translator: Translator, unit: PriceHistoryChartAggregationUnit): HTMLElement | null {
	if (unit === 'day') return null;
	const note = createEl('p');
	note.className = 'tyrian-price-chart__aggregation-note';
	note.setAttribute('aria-live', 'polite');
	note.textContent = translator.t(`priceHistory.chart.aggregation.${unit}`);
	return note;
}

function daySpan(points: ReadonlyArray<{ readonly dayUtc: string }>): number {
	if (points.length < 2) return 0;
	return Math.round((Date.parse(`${points.at(-1)!.dayUtc}T00:00:00.000Z`) - Date.parse(`${points[0]!.dayUtc}T00:00:00.000Z`)) / 86_400_000);
}

function round(value: number): number { return Math.round(value * 100) / 100; }
