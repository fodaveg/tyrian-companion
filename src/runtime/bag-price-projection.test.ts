import { describe, expect, it } from 'vitest';
import { projectBagPriceIngameState } from './farming-runtime-projection';

const NOW = Date.parse('2026-10-07T16:00:00Z');
const quote = (ageSeconds: number, bid: number | null = 345, ask: number | null = 367) =>
	({ bid, ask, capturedAt: NOW - ageSeconds * 1_000 });
const NO_FIGURES = { sell: null, sellStack: null, list: null, listStack: null };

describe('projectBagPriceIngameState', () => {
	it('is idle in every phase but active, even with a fresh quote', () => {
		for (const phase of ['idle', 'starting', 'stopping', 'complete', 'error'] as const) {
			expect(projectBagPriceIngameState({ phase, quote: quote(1), now: NOW })).toEqual({ st: 'idle', ...NO_FIGURES, age: null });
		}
	});

	it('is pending on an active session without a usable quote', () => {
		expect(projectBagPriceIngameState({ phase: 'active', quote: null, now: NOW })).toEqual({ st: 'pending', ...NO_FIGURES, age: null });
	});

	it('computes the stack on the total: bid 345 nets 73312, not 250 x 293', () => {
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(412), now: NOW }))
			.toEqual({ st: 'ok', sell: 293, sellStack: 73_312, list: 312, listStack: 77_987, age: 412 });
	});

	it('changes from ok to stale exactly at 600 s, and stale carries no figures', () => {
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(599), now: NOW })).toMatchObject({ st: 'ok', age: 599, sell: 293 });
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(600), now: NOW }))
			.toEqual({ st: 'stale', ...NO_FIGURES, age: 600 });
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(1_260), now: NOW })).toMatchObject({ st: 'stale', age: 1_260 });
	});

	it('sends null for the side the Trading Post has no order on, and ok with all null when neither has one', () => {
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(30, 345, null), now: NOW }))
			.toEqual({ st: 'ok', sell: 293, sellStack: 73_312, list: null, listStack: null, age: 30 });
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(30, null, 367), now: NOW }))
			.toEqual({ st: 'ok', sell: null, sellStack: null, list: 312, listStack: 77_987, age: 30 });
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(30, null, null), now: NOW }))
			.toEqual({ st: 'ok', ...NO_FIGURES, age: 30 });
	});

	it('never reports a negative age for a quote stamped in the future', () => {
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(-5), now: NOW })).toMatchObject({ st: 'ok', age: 0 });
	});

	it('sends null instead of an out-of-int32 net', () => {
		expect(projectBagPriceIngameState({ phase: 'active', quote: quote(1, 100_000_000, null), now: NOW }))
			.toMatchObject({ st: 'ok', sell: 85_000_000, sellStack: null });
	});
});
