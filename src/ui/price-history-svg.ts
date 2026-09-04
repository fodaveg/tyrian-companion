import type { PriceHistoryDailyV1, PriceHistorySide } from '../economy/price-history-model';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';

/**
 * The hand-drawn SVG plot engine (H9.1/H9.2). Pulled out of
 * `price-history-panel-view.ts` so `price-history-chart-view.ts` (the axis
 * frame and zoom built around this plot) can import it without the two
 * modules importing each other.
 */

/** The plot's own inner geometry; exported so `price-history-chart-view.ts` can align an axis frame around it pixel for pixel. */
export const PRICE_HISTORY_SVG_WIDTH = 760;
export const PRICE_HISTORY_SVG_HEIGHT = 240;
export const PRICE_HISTORY_SVG_PADDING = 28;

export interface PriceHistoryValueRange {
	readonly minimum: number;
	readonly maximum: number;
}

/**
 * The min/max `priceHistorySvg` scales its y-axis to. Exposed so an axis frame
 * drawn around the plot (`price-history-chart-view.ts`) can compute gridlines
 * from the SAME bounds instead of a parallel reimplementation that could drift
 * out of alignment. `null` when there is nothing plottable, matching the empty
 * SVG `priceHistorySvg` returns in that case.
 */
export function priceHistoryValueRange(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[] = [],
): PriceHistoryValueRange | null {
	const localDayUtcs = new Set(daily.map((entry) => entry.dayUtc));
	const seedValues = seedDays
		.filter((day) => !localDayUtcs.has(day.dayUtc))
		.map((day) => (side === 'bid' ? day.bidCopper : day.askCopper))
		.filter((value): value is number => value !== null);
	const localValues = daily.flatMap((entry) => {
		const value = entry[side];
		return value === null ? [] : [value.minCopper, value.maxCopper, value.medianCopperX2 / 2, value.closeCopper];
	});
	const values = [...seedValues, ...localValues];
	if (values.length === 0) return null;
	return { minimum: Math.min(...values), maximum: Math.max(...values) };
}

/**
 * Deterministic local SVG. Missing UTC days split every line instead of inventing observations.
 *
 * `seedDays` is optional and additive: when present, every day it carries that the local `daily`
 * series does NOT already cover is drawn first, ahead of the range/median/close geometry so a
 * local day always wins the pixel. Passing no `seedDays` (or an empty one) reproduces the exact
 * local-only geometry byte for byte, index for index: the two series share one ordinal x-axis
 * built from the COMBINED point count, and an empty seed leaves that count, and every coordinate
 * on it, unchanged.
 *
 * The seed line is DASHED (`price-seed`) only while a local line shares the chart to be confused
 * with; with no local capture at all (`daily.length === 0`, the note-embedded piloto chart's only
 * case) it is drawn SOLID (`price-seed-solo`) instead, at the same visual weight as a local close
 * line, because it is then the one and only series on screen.
 */
export function priceHistorySvg(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[] = [],
): string {
	const width = PRICE_HISTORY_SVG_WIDTH;
	const height = PRICE_HISTORY_SVG_HEIGHT;
	const padding = PRICE_HISTORY_SVG_PADDING;
	const localDayUtcs = new Set(daily.map((entry) => entry.dayUtc));
	const seedOnly = seedDays
		.filter((day) => !localDayUtcs.has(day.dayUtc))
		.map((day) => ({ dayUtc: day.dayUtc, value: side === 'bid' ? day.bidCopper : day.askCopper }))
		.filter((entry): entry is { dayUtc: string; value: number } => entry.value !== null)
		.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
	const combinedLength = seedOnly.length + daily.length;
	if (combinedLength === 0) return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"></svg>`;
	const x = (index: number): number =>
		round(padding + index * ((width - padding * 2) / Math.max(1, combinedLength - 1)));
	const localOffset = seedOnly.length;
	const localPoints = daily.map((entry, index) => ({ entry, index: index + localOffset, value: entry[side] }));
	const bounds = priceHistoryValueRange(daily, side, seedDays);
	if (bounds === null) return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"></svg>`;
	const spread = Math.max(1, bounds.maximum - bounds.minimum);
	const y = (value: number): number => round(height - padding - ((value - bounds.minimum) / spread) * (height - padding * 2));
	const ranges = localPoints.filter(({ value }) => value !== null).map(({ index, value }) =>
		`<line class="price-range" x1="${x(index)}" y1="${y(value!.minCopper)}" x2="${x(index)}" y2="${y(value!.maxCopper)}"/>`,
	).join('');
	const seed = segmentedPaths(
		seedOnly.map((point, index) => ({ dayUtc: point.dayUtc, index, value: point.value })),
		x, y, daily.length === 0 ? 'price-seed-solo' : 'price-seed', 'circle',
	);
	const median = segmentedPaths(
		localPoints.map(({ entry, index, value }) => ({ dayUtc: entry.dayUtc, index, value: value === null ? null : value.medianCopperX2 / 2 })),
		x, y, 'price-median', 'circle',
	);
	const close = segmentedPaths(
		localPoints.map(({ entry, index, value }) => ({ dayUtc: entry.dayUtc, index, value: value === null ? null : value.closeCopper })),
		x, y, 'price-close', 'square',
	);
	return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-hidden="true"><g>${seed}${ranges}${median}${close}</g></svg>`;
}

function segmentedPaths(
	points: ReadonlyArray<{ dayUtc: string; index: number; value: number | null }>,
	x: (index: number) => number,
	y: (value: number) => number,
	className: string,
	marker: 'circle' | 'square',
): string {
	const segments: string[][] = [];
	let current: string[] = [];
	let previousDay: number | null = null;
	for (const point of points) {
		const day = Date.parse(`${point.dayUtc}T00:00:00.000Z`);
		if (point.value === null || (previousDay !== null && day - previousDay !== 86_400_000)) {
			if (current.length > 0) segments.push(current);
			current = [];
		}
		if (point.value !== null) current.push(`${x(point.index)},${y(point.value)}`);
		previousDay = point.value === null ? null : day;
	}
	if (current.length > 0) segments.push(current);
	return segments.map((segment) => {
		if (segment.length > 1) return `<polyline class="${className}" points="${segment.join(' ')}"/>`;
		const [pointX, pointY] = segment[0]!.split(',');
		return marker === 'circle'
			? `<circle class="${className}-marker" cx="${pointX}" cy="${pointY}" r="5"/>`
			: `<rect class="${className}-marker" x="${round(Number(pointX) - 4)}" y="${round(Number(pointY) - 4)}" width="8" height="8"/>`;
	}).join('');
}

function round(value: number): number { return Math.round(value * 100) / 100; }

/**
 * The DOM twin of `priceHistorySvg`: same geometry, built as live `SVGElement`s
 * instead of a string so it can be mounted straight into a container. Exported so
 * `price-history-chart-view.ts` draws with this exact engine rather than a second one.
 */
export function priceHistorySvgElement(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[],
	document: Document,
): SVGSVGElement {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(namespace, 'svg');
	const attributes: ReadonlyArray<readonly [string, string]> = [
		['viewBox', '0 0 760 240'], ['width', '100%'], ['role', 'img'], ['aria-hidden', 'true'],
	];
	for (const [name, value] of attributes) {
		svg.setAttribute(name, value);
	}
	const source = priceHistorySvg(daily, side, seedDays);
	const group = document.createElementNS(namespace, 'g');
	for (const match of source.matchAll(/<line class="([^"]+)" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"\/>/gu)) {
		const line = document.createElementNS(namespace, 'line');
		line.setAttribute('class', match[1]!);
		line.setAttribute('x1', match[2]!);
		line.setAttribute('y1', match[3]!);
		line.setAttribute('x2', match[4]!);
		line.setAttribute('y2', match[5]!);
		group.append(line);
	}
	for (const match of source.matchAll(/<polyline class="([^"]+)" points="([^"]*)"\/>/gu)) {
		const polyline = document.createElementNS(namespace, 'polyline');
		polyline.setAttribute('class', match[1]!);
		polyline.setAttribute('points', match[2]!);
		group.append(polyline);
	}
	for (const match of source.matchAll(/<circle class="([^"]+)" cx="([^"]+)" cy="([^"]+)" r="([^"]+)"\/>/gu)) {
		const circle = document.createElementNS(namespace, 'circle');
		circle.setAttribute('class', match[1]!);
		circle.setAttribute('cx', match[2]!);
		circle.setAttribute('cy', match[3]!);
		circle.setAttribute('r', match[4]!);
		group.append(circle);
	}
	for (const match of source.matchAll(/<rect class="([^"]+)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"\/>/gu)) {
		const rect = document.createElementNS(namespace, 'rect');
		rect.setAttribute('class', match[1]!);
		rect.setAttribute('x', match[2]!);
		rect.setAttribute('y', match[3]!);
		rect.setAttribute('width', match[4]!);
		rect.setAttribute('height', match[5]!);
		group.append(rect);
	}
	svg.append(group);
	return svg;
}
