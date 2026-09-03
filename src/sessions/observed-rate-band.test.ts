import { describe, expect, it } from 'vitest';

import { API_SETTLEMENT_WINDOW_MS } from './session-api-settlement';
import {
	OBSERVED_WINDOW_CACHE_MARGIN_MS,
	formatBandMinutes,
	formatMilliUnits,
	observedRateBand,
	unavailableRateBand,
} from './observed-rate-band';

const HOUR_MS = 3_600_000;

describe('observedRateBand', () => {
	it('takes its default margin from the documented account settlement window', () => {
		expect(OBSERVED_WINDOW_CACHE_MARGIN_MS).toBe(API_SETTLEMENT_WINDOW_MS);
		expect(observedRateBand(120_000, HOUR_MS).marginMs).toBe(API_SETTLEMENT_WINDOW_MS);
	});

	it('collapses to the exact rate when there is no cache margin to carry', () => {
		const band = observedRateBand(120_000, HOUR_MS, 0);

		expect(band).toMatchObject({
			status: 'measured', low: 120_000, high: 120_000,
			windowMs: HOUR_MS, marginMs: 0, widestWindowMs: HOUR_MS, narrowestWindowMs: HOUR_MS,
		});
	});

	/**
	 * The perturbation test. Every extreme below is a division of the same amount by a window the
	 * margin moved, so an implementation that published a literal — even the right literal for the
	 * default margin — disagrees with at least three of these four rows.
	 */
	it.each([
		{ marginMs: 0, widestWindowMs: 3_600_000, narrowestWindowMs: 3_600_000, low: 120_000, high: 120_000 },
		{ marginMs: 300_000, widestWindowMs: 3_900_000, narrowestWindowMs: 3_300_000, low: 110_769, high: 130_909 },
		{ marginMs: 600_000, widestWindowMs: 4_200_000, narrowestWindowMs: 3_000_000, low: 102_857, high: 144_000 },
		{ marginMs: 1_200_000, widestWindowMs: 4_800_000, narrowestWindowMs: 2_400_000, low: 90_000, high: 180_000 },
	])('derives both extremes from a $marginMs ms margin on the observed window', (expected) => {
		const band = observedRateBand(120_000, HOUR_MS, expected.marginMs);

		expect(band).toMatchObject({ status: 'measured', windowMs: HOUR_MS, ...expected });
		// Each extreme is the amount over the window it names, never a stored figure.
		expect(band.low).toBe(Math.round(120_000 * HOUR_MS / expected.widestWindowMs));
		expect(band.high).toBe(Math.round(120_000 * HOUR_MS / expected.narrowestWindowMs));
	});

	it('widens the band monotonically as the cache margin grows', () => {
		const bands = [0, 300_000, 600_000, 1_200_000].map((margin) => observedRateBand(120_000, HOUR_MS, margin));
		const lows = bands.map((band) => band.low);
		const highs = bands.map((band) => band.high);

		expect(lows).toEqual([...lows].sort((left, right) => (right ?? 0) - (left ?? 0)));
		expect(highs).toEqual([...highs].sort((left, right) => (left ?? 0) - (right ?? 0)));
		expect(new Set(lows).size).toBe(4);
		expect(new Set(highs).size).toBe(4);
	});

	it('publishes a lower bound only when the margin swallows the whole window', () => {
		const band = observedRateBand(10_000, 600_000);

		expect(band).toMatchObject({
			status: 'lower_bound_only', low: 30_000, high: null,
			windowMs: 600_000, marginMs: 600_000, widestWindowMs: 1_200_000, narrowestWindowMs: null,
		});
	});

	it('orders a negative amount by value rather than by window', () => {
		const band = observedRateBand(-120_000, HOUR_MS, 600_000);

		expect(band).toMatchObject({ status: 'measured', low: -144_000, high: -102_857 });
	});

	it.each([
		{ amount: 1.5, windowMs: HOUR_MS, marginMs: 0 },
		{ amount: Number.NaN, windowMs: HOUR_MS, marginMs: 0 },
		{ amount: 1, windowMs: 0, marginMs: 0 },
		{ amount: 1, windowMs: -HOUR_MS, marginMs: 0 },
		{ amount: 1, windowMs: HOUR_MS, marginMs: -1 },
		{ amount: Number.MAX_SAFE_INTEGER, windowMs: HOUR_MS, marginMs: 0 },
	])('fails closed on unusable inputs %#', ({ amount, windowMs, marginMs }) => {
		expect(observedRateBand(amount, windowMs, marginMs)).toEqual(unavailableRateBand());
	});

	it('states an unavailable band without any number to misread', () => {
		expect(unavailableRateBand()).toEqual({
			version: 1, status: 'unavailable', low: null, high: null,
			windowMs: null, marginMs: null, widestWindowMs: null, narrowestWindowMs: null,
		});
	});
});

describe('band formatting', () => {
	it.each([
		[120_000, '120.0'],
		[102_857, '102.9'],
		[0, '0.0'],
	])('renders %i milli units as %s', (milli, expected) => expect(formatMilliUnits(milli)).toBe(expected));

	it.each([
		[3_600_000, '60'],
		[600_000, '10'],
		[90_000, '2'],
	])('renders %i ms as %s whole minutes', (ms, expected) => expect(formatBandMinutes(ms)).toBe(expected));
});
