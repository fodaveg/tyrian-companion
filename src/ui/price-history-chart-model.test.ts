import { describe, expect, it } from 'vitest';

import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import {
	aggregatePriceHistoryChartPoints,
	filterPriceHistoryChartRange,
	mergePriceHistoryChartPoints,
	priceHistoryChartAggregationUnit,
	priceHistoryChartIndexAtOffset,
	priceHistoryChartSummary,
	priceHistoryChartWindowRange,
	priceHistoryDateAxisTicks,
	priceHistoryPriceAxisTicks,
} from './price-history-chart-model';

describe('price history chart model', () => {
	describe('mergePriceHistoryChartPoints', () => {
		it('keeps local capture and lets it win over a seed day for the same UTC day', () => {
			const merged = mergePriceHistoryChartPoints(
				[daily('2026-08-29', 140)],
				'ask',
				[
					{ dayUtc: '2026-08-27', bidCopper: 90, askCopper: 100 },
					{ dayUtc: '2026-08-29', bidCopper: 999, askCopper: 999 },
				],
			);
			expect(merged.map((point) => [point.dayUtc, point.source, point.value])).toEqual([
				['2026-08-27', 'seed', 100],
				['2026-08-29', 'local', 140],
			]);
		});
	});

	describe('windows, scales and the accessible summary (behaviour test 1)', () => {
		it('covers the real value range and matches the known series max/min/last', () => {
			const series = [
				daily('2026-01-01', 100), daily('2026-01-02', 300), daily('2026-01-03', 200),
			];
			const merged = mergePriceHistoryChartPoints(series, 'ask', []);
			const priceTicks = priceHistoryPriceAxisTicks(merged);
			expect(Math.min(...priceTicks)).toBe(100);
			expect(Math.max(...priceTicks)).toBe(300);
			const summary = priceHistoryChartSummary(merged);
			expect(summary.max).toEqual({ value: 300, dayUtc: '2026-01-02' });
			expect(summary.min).toEqual({ value: 100, dayUtc: '2026-01-01' });
			expect(summary.last).toEqual({ value: 200, dayUtc: '2026-01-03' });
		});

		it('produces date ticks that always include the first and last day', () => {
			const merged = mergePriceHistoryChartPoints(
				Array.from({ length: 30 }, (_unused, index) => daily(dayAt(index), 100 + index)),
				'ask', [],
			);
			const ticks = priceHistoryDateAxisTicks(merged, 5);
			expect(ticks[0]?.dayUtc).toBe(merged[0]?.dayUtc);
			expect(ticks.at(-1)?.dayUtc).toBe(merged.at(-1)?.dayUtc);
			expect(ticks.length).toBeLessThanOrEqual(5);
		});
	});

	describe('zoom windows (behaviour test 2)', () => {
		it('changing the window changes which days are in range', () => {
			const merged = mergePriceHistoryChartPoints(
				Array.from({ length: 400 }, (_unused, index) => daily(dayAt(index), 100 + index)),
				'ask', [],
			);
			const oneMonth = filterPriceHistoryChartRange(merged, priceHistoryChartWindowRange(merged, '1m'));
			const oneYear = filterPriceHistoryChartRange(merged, priceHistoryChartWindowRange(merged, '1y'));
			const all = filterPriceHistoryChartRange(merged, priceHistoryChartWindowRange(merged, 'all'));
			expect(oneMonth.length).toBe(30);
			expect(oneYear.length).toBe(365);
			expect(all.length).toBe(400);
			expect(oneMonth.at(-1)?.dayUtc).toBe(merged.at(-1)?.dayUtc);
			// Different windows redraw a genuinely different slice, not the same data relabelled.
			expect(oneMonth.length).not.toBe(all.length);
		});

		it('always anchors the window at the series own most recent day, not a wall clock', () => {
			const merged = mergePriceHistoryChartPoints(
				Array.from({ length: 40 }, (_unused, index) => daily(dayAt(index), 100 + index)),
				'ask', [],
			);
			const range = priceHistoryChartWindowRange(merged, '1m');
			expect(range.endDayUtc).toBe(merged.at(-1)?.dayUtc);
		});
	});

	describe('aggregation (behaviour test 3)', () => {
		it('stays at day granularity when the series fits the pixel budget', () => {
			const merged = mergePriceHistoryChartPoints(
				Array.from({ length: 100 }, (_unused, index) => daily(dayAt(index), 100 + index)),
				'ask', [],
			);
			expect(priceHistoryChartAggregationUnit(merged.length, 700)).toBe('day');
			const aggregated = aggregatePriceHistoryChartPoints(merged, 'day');
			expect(aggregated).toHaveLength(100);
			expect(aggregated.every((point) => point.dayCount === 1)).toBe(true);
		});

		it('aggregates by week once the series has more days than plot pixels, and declares it', () => {
			const merged = mergePriceHistoryChartPoints(
				Array.from({ length: 1_000 }, (_unused, index) => daily(dayAt(index), 100 + index)),
				'ask', [],
			);
			const unit = priceHistoryChartAggregationUnit(merged.length, 700);
			expect(unit).toBe('week');
			const aggregated = aggregatePriceHistoryChartPoints(merged, unit);
			expect(aggregated.length).toBeLessThan(merged.length);
			expect(aggregated.length).toBeLessThanOrEqual(700);
			expect(aggregated.every((point) => point.dayCount > 1)).toBe(true);
			// The last known value of the bucket survives, not an average that never traded.
			expect(aggregated.at(-1)?.value).toBe(merged.at(-1)?.value);
		});

		it('aggregates by month for a multi-year series, coarser than weekly', () => {
			const merged = mergePriceHistoryChartPoints(
				Array.from({ length: 6_000 }, (_unused, index) => daily(dayAt(index - 5_999), 100 + (index % 300))),
				'ask', [],
			);
			const unit = priceHistoryChartAggregationUnit(merged.length, 700);
			expect(unit).toBe('month');
			const aggregated = aggregatePriceHistoryChartPoints(merged, unit);
			expect(aggregated.length).toBeLessThanOrEqual(700);
			expect(aggregated.length).toBeGreaterThan(0);
		});

		it('never widens a whole-year price move into an averaged flat line: min/max survive the bucket', () => {
			// 2026-01-01 through 2026-01-04 fall in the same ISO week (Mon 2025-12-29 to Sun 2026-01-04).
			const days = [daily('2026-01-01', 100), daily('2026-01-02', 900), daily('2026-01-04', 100)];
			const merged = mergePriceHistoryChartPoints(days, 'ask', []);
			const aggregated = aggregatePriceHistoryChartPoints(merged, 'week');
			expect(aggregated).toHaveLength(1);
			expect(aggregated[0]?.maxValue).toBe(900);
			expect(aggregated[0]?.minValue).toBe(100);
		});
	});

	describe('local vs seed provenance survives a merge and a filter', () => {
		it('keeps the source tag through range filtering', () => {
			const merged = mergePriceHistoryChartPoints(
				[daily('2026-08-29', 140)], 'ask',
				[{ dayUtc: '2026-08-01', bidCopper: 90, askCopper: 100 }],
			);
			const filtered = filterPriceHistoryChartRange(merged, { startDayUtc: '2026-08-29', endDayUtc: null });
			expect(filtered).toEqual([expect.objectContaining({ dayUtc: '2026-08-29', source: 'local' })]);
		});
	});

	describe('pixel-to-index mapping for drag selection', () => {
		it('clamps to the series bounds and rounds to the nearest point', () => {
			expect(priceHistoryChartIndexAtOffset(-50, 0, 100, 11)).toBe(0);
			expect(priceHistoryChartIndexAtOffset(500, 0, 100, 11)).toBe(10);
			expect(priceHistoryChartIndexAtOffset(50, 0, 100, 11)).toBe(5);
		});
	});
});

function daily(dayUtc: string, closeCopper: number): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId: 36_038, dayUtc, snapshotCount: 1, partialSnapshotCount: 0,
		bid: null,
		ask: {
			count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2,
			closeCopper, closeCapturedAtMs: Date.parse(`${dayUtc}T12:00:00.000Z`),
		},
	};
}

function dayAt(offsetFromEpochAnchor: number): string {
	return new Date(Date.UTC(2026, 0, 1) + offsetFromEpochAnchor * 86_400_000).toISOString().slice(0, 10);
}
