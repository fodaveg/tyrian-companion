import type { PriceHistoryDailyV1, PriceHistorySide } from '../economy/price-history-model';
import type { PriceSeedDayV1 } from '../economy/price-seed-model';

/**
 * Pure geometry and scale math for the price-history chart (H9.1 panel and
 * H9.2 note block). Nothing here touches the DOM: `price-history-chart-view.ts`
 * is the only caller, and it is the one place that draws.
 */

export type PriceHistoryChartPointSource = 'local' | 'seed';

export interface PriceHistoryChartPoint {
	readonly dayUtc: string;
	readonly source: PriceHistoryChartPointSource;
	/** The plotted value: local close, or the seed's bid/ask for the requested side. `null` when the day has no usable side data. */
	readonly value: number | null;
	/** Local-only day range; `null` for a seed point or a local day without side data. */
	readonly minValue: number | null;
	readonly maxValue: number | null;
}

/**
 * One ascending, day-unique series merging local captures and the datawars2
 * seed. Local always wins a shared day, matching the settings panel's
 * existing rule (`price-history-panel-view.ts`) that a capture of the
 * plugin's own is never overwritten by third-party data.
 */
export function mergePriceHistoryChartPoints(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	seedDays: readonly PriceSeedDayV1[],
): PriceHistoryChartPoint[] {
	const localDayUtcs = new Set(daily.map((entry) => entry.dayUtc));
	const seedPoints: PriceHistoryChartPoint[] = seedDays
		.filter((day) => !localDayUtcs.has(day.dayUtc))
		.map((day) => ({
			dayUtc: day.dayUtc, source: 'seed' as const,
			value: side === 'bid' ? day.bidCopper : day.askCopper,
			minValue: null, maxValue: null,
		}));
	const localPoints: PriceHistoryChartPoint[] = daily.map((entry) => {
		const values = entry[side];
		return {
			dayUtc: entry.dayUtc, source: 'local' as const,
			value: values?.closeCopper ?? null,
			minValue: values?.minCopper ?? null,
			maxValue: values?.maxCopper ?? null,
		};
	});
	return [...seedPoints, ...localPoints]
		.sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
}

/** The four zoom presets, in the order they are offered. `days: null` is the unbounded "all" window. */
export type PriceHistoryChartWindowId = '1m' | '1y' | '5y' | 'all';

export const PRICE_HISTORY_CHART_WINDOWS: ReadonlyArray<{ readonly id: PriceHistoryChartWindowId; readonly days: number | null }> =
	Object.freeze([
		{ id: '1m', days: 30 },
		{ id: '1y', days: 365 },
		{ id: '5y', days: 1_825 },
		{ id: 'all', days: null },
	]);

export interface PriceHistoryChartRange {
	readonly startDayUtc: string | null;
	readonly endDayUtc: string | null;
}

export const PRICE_HISTORY_CHART_ALL_RANGE: PriceHistoryChartRange = Object.freeze({ startDayUtc: null, endDayUtc: null });

/** The inclusive day range a preset window covers, anchored at the series' own most recent day. */
export function priceHistoryChartWindowRange(
	points: readonly { readonly dayUtc: string }[],
	windowId: PriceHistoryChartWindowId,
): PriceHistoryChartRange {
	if (points.length === 0 || windowId === 'all') return PRICE_HISTORY_CHART_ALL_RANGE;
	const days = PRICE_HISTORY_CHART_WINDOWS.find((entry) => entry.id === windowId)?.days ?? null;
	if (days === null) return PRICE_HISTORY_CHART_ALL_RANGE;
	const endDayUtc = points[points.length - 1]!.dayUtc;
	const startMs = Date.parse(`${endDayUtc}T00:00:00.000Z`) - (days - 1) * 86_400_000;
	return { startDayUtc: new Date(startMs).toISOString().slice(0, 10), endDayUtc };
}

/** Points inside `range`, inclusive on both ends. A `null` bound is unbounded on that side. */
export function filterPriceHistoryChartRange<T extends { readonly dayUtc: string }>(
	points: readonly T[],
	range: PriceHistoryChartRange,
): T[] {
	return points.filter((point) =>
		(range.startDayUtc === null || point.dayUtc >= range.startDayUtc)
		&& (range.endDayUtc === null || point.dayUtc <= range.endDayUtc));
}

export type PriceHistoryChartAggregationUnit = 'day' | 'week' | 'month';

/**
 * Which bucket width keeps the series at or under the pixels available to
 * draw it. `plotWidthPx` is the plot's own inner width, not the whole chart:
 * one point per pixel is already generous, and a day-per-pixel window never
 * aggregates.
 */
export function priceHistoryChartAggregationUnit(pointCount: number, plotWidthPx: number): PriceHistoryChartAggregationUnit {
	if (!Number.isFinite(plotWidthPx) || plotWidthPx <= 0) return 'day';
	if (pointCount <= plotWidthPx) return 'day';
	if (Math.ceil(pointCount / 7) <= plotWidthPx) return 'week';
	return 'month';
}

export interface PriceHistoryChartAggregatedPoint {
	/** The last day the bucket covers; buckets are labelled by where they end, not where they start. */
	readonly dayUtc: string;
	readonly source: PriceHistoryChartPointSource | 'mixed';
	/** The last known value inside the bucket. */
	readonly value: number | null;
	readonly minValue: number | null;
	readonly maxValue: number | null;
	/** How many source days this bucket summarizes. Always 1 for `unit: 'day'`. */
	readonly dayCount: number;
}

/**
 * Reduces the series to one point per bucket. `'day'` is a lossless pass
 * through (kept so callers never special-case it). `'week'` groups by ISO
 * week (Monday-start), `'month'` by UTC calendar month.
 */
export function aggregatePriceHistoryChartPoints(
	points: readonly PriceHistoryChartPoint[],
	unit: PriceHistoryChartAggregationUnit,
): PriceHistoryChartAggregatedPoint[] {
	if (unit === 'day') {
		return points.map((point) => ({
			dayUtc: point.dayUtc, source: point.source, value: point.value,
			minValue: point.minValue ?? point.value, maxValue: point.maxValue ?? point.value, dayCount: 1,
		}));
	}
	const bucketKey = unit === 'week' ? isoWeekKey : monthKey;
	const buckets = new Map<string, PriceHistoryChartPoint[]>();
	for (const point of points) {
		const key = bucketKey(point.dayUtc);
		const bucket = buckets.get(key);
		if (bucket === undefined) buckets.set(key, [point]);
		else bucket.push(point);
	}
	return [...buckets.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, bucket]) => aggregateBucket(bucket));
}

/**
 * One bucket to one point. The representative value is the bucket's LAST
 * known day, not an average: averaging would blur a real price move into a
 * rate that never actually traded.
 */
function aggregateBucket(bucket: readonly PriceHistoryChartPoint[]): PriceHistoryChartAggregatedPoint {
	const sources = new Set(bucket.map((point) => point.source));
	const mins = bucket.flatMap((point) => {
		const value = point.minValue ?? point.value;
		return value === null ? [] : [value];
	});
	const maxs = bucket.flatMap((point) => {
		const value = point.maxValue ?? point.value;
		return value === null ? [] : [value];
	});
	const lastWithValue = [...bucket].reverse().find((point) => point.value !== null) ?? null;
	return {
		dayUtc: bucket[bucket.length - 1]!.dayUtc,
		source: sources.size === 1 ? [...sources][0]! : 'mixed',
		value: lastWithValue?.value ?? null,
		minValue: mins.length === 0 ? null : Math.min(...mins),
		maxValue: maxs.length === 0 ? null : Math.max(...maxs),
		dayCount: bucket.length,
	};
}

/** UTC calendar month, e.g. `2026-08`. */
function monthKey(dayUtc: string): string {
	return dayUtc.slice(0, 7);
}

/** ISO 8601 week key (`GGGG-Www`, Monday-start, week 1 owns the year's first Thursday). */
function isoWeekKey(dayUtc: string): string {
	const date = new Date(`${dayUtc}T00:00:00.000Z`);
	const dayNumber = (date.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
	const thursday = new Date(date.getTime());
	thursday.setUTCDate(thursday.getUTCDate() - dayNumber + 3);
	const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
	const firstThursdayOffset = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayOffset + 3);
	const weekNumber = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
	return `${String(thursday.getUTCFullYear())}-W${String(weekNumber).padStart(2, '0')}`;
}

/** Evenly spaced tick values from the lowest to the highest value plotted, inclusive of both ends. */
export function priceHistoryPriceAxisTicks(
	points: ReadonlyArray<{ readonly value: number | null; readonly minValue: number | null; readonly maxValue: number | null }>,
	tickCount = 4,
): number[] {
	const values = points.flatMap((point) => [point.value, point.minValue, point.maxValue])
		.filter((value): value is number => value !== null);
	if (values.length === 0) return [];
	const minimum = Math.min(...values);
	const maximum = Math.max(...values);
	if (minimum === maximum) return [minimum];
	const count = Math.max(2, tickCount);
	return Array.from({ length: count }, (_unused, index) => Math.round(minimum + ((maximum - minimum) * index) / (count - 1)));
}

export interface PriceHistoryDateAxisTick {
	readonly index: number;
	readonly dayUtc: string;
}

/** Up to `tickCount` evenly spaced index positions across the series, always including both ends. */
export function priceHistoryDateAxisTicks(
	points: ReadonlyArray<{ readonly dayUtc: string }>,
	tickCount = 5,
): PriceHistoryDateAxisTick[] {
	if (points.length === 0) return [];
	if (points.length === 1) return [{ index: 0, dayUtc: points[0]!.dayUtc }];
	const count = Math.min(Math.max(2, tickCount), points.length);
	const seen = new Set<number>();
	const ticks: PriceHistoryDateAxisTick[] = [];
	for (let step = 0; step < count; step += 1) {
		const index = Math.round((step * (points.length - 1)) / (count - 1));
		if (seen.has(index)) continue;
		seen.add(index);
		ticks.push({ index, dayUtc: points[index]!.dayUtc });
	}
	return ticks;
}

export interface PriceHistoryChartSummaryEntry {
	readonly value: number;
	readonly dayUtc: string;
}

export interface PriceHistoryChartSummary {
	readonly max: PriceHistoryChartSummaryEntry | null;
	readonly min: PriceHistoryChartSummaryEntry | null;
	readonly last: PriceHistoryChartSummaryEntry | null;
}

/** The maximum, minimum and most recent value of whichever points are handed in (already zoom-filtered). */
export function priceHistoryChartSummary(points: ReadonlyArray<{ readonly dayUtc: string; readonly value: number | null }>): PriceHistoryChartSummary {
	const withValue = points.filter((point): point is { dayUtc: string; value: number } => point.value !== null);
	if (withValue.length === 0) return { max: null, min: null, last: null };
	let max = withValue[0]!;
	let min = withValue[0]!;
	for (const point of withValue) {
		if (point.value > max.value) max = point;
		if (point.value < min.value) min = point;
	}
	const last = withValue[withValue.length - 1]!;
	return {
		max: { value: max.value, dayUtc: max.dayUtc },
		min: { value: min.value, dayUtc: min.dayUtc },
		last: { value: last.value, dayUtc: last.dayUtc },
	};
}

/** Maps a pointer offset inside the plot area to the nearest point index, clamped to the series. */
export function priceHistoryChartIndexAtOffset(offsetX: number, plotLeft: number, plotWidth: number, pointCount: number): number {
	if (pointCount <= 1) return 0;
	if (!Number.isFinite(offsetX) || !Number.isFinite(plotWidth) || plotWidth <= 0) return 0;
	const ratio = clamp((offsetX - plotLeft) / plotWidth, 0, 1);
	return Math.round(ratio * (pointCount - 1));
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, value));
}
