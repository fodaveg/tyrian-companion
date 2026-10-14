import { describe, expect, it } from 'vitest';

import { GAME_MAGIC_FIND_FRESH_MS, LiveGameMagicFind } from './live-game-magic-find';

const NOW = 1_760_000_000_000;
const A = 'AQEBAQEBAQEBAQEBAQEBAQ';
const B = 'AgICAgICAgICAgICAgICAg';

describe('the game Magic Find the panel shows', () => {
	it('is null until the addon reports a figure, and the figure while it is fresh', () => {
		const held = new LiveGameMagicFind();
		expect(held.current(NOW)).toBeNull();
		expect(held.observe({ connectionId: A, value: 333, observedAtMs: NOW - 12 }, NOW)).toBe(true);
		expect(held.current(NOW)).toBe(333);
		expect(held.current(NOW - 12 + GAME_MAGIC_FIND_FRESH_MS)).toBe(333);
	});

	it('lets a figure go two minutes after its reading, so the account figure comes back', () => {
		const held = new LiveGameMagicFind();
		held.observe({ connectionId: A, value: 333, observedAtMs: NOW }, NOW);
		expect(GAME_MAGIC_FIND_FRESH_MS).toBe(120_000);
		expect(held.current(NOW + GAME_MAGIC_FIND_FRESH_MS + 1)).toBeNull();
		// A report already past the window never shows.
		const late = new LiveGameMagicFind();
		expect(late.observe({ connectionId: A, value: 333, observedAtMs: NOW - GAME_MAGIC_FIND_FRESH_MS - 1 }, NOW)).toBe(false);
		expect(late.current(NOW)).toBeNull();
	});

	it('answers whether what it shows changed: a repeated figure is no change, a new one is', () => {
		const held = new LiveGameMagicFind();
		expect(held.observe({ connectionId: A, value: 333, observedAtMs: NOW }, NOW)).toBe(true);
		expect(held.observe({ connectionId: A, value: 333, observedAtMs: NOW + 60_000 }, NOW + 60_000)).toBe(false);
		expect(held.observe({ connectionId: A, value: 363, observedAtMs: NOW + 65_000 }, NOW + 65_000)).toBe(true);
		expect(held.current(NOW + 65_000)).toBe(363);
	});

	it('drops the figure on a null of the same connection, never on another connection\'s', () => {
		const held = new LiveGameMagicFind();
		held.observe({ connectionId: A, value: 333, observedAtMs: NOW }, NOW);
		expect(held.observe({ connectionId: B, value: null, observedAtMs: NOW + 1 }, NOW + 1)).toBe(false);
		expect(held.current(NOW + 1)).toBe(333);
		expect(held.observe({ connectionId: A, value: null, observedAtMs: NOW + 2 }, NOW + 2)).toBe(true);
		expect(held.current(NOW + 2)).toBeNull();
	});

	it('takes the newest figure whichever connection said it', () => {
		const held = new LiveGameMagicFind();
		held.observe({ connectionId: A, value: 333, observedAtMs: NOW }, NOW);
		held.observe({ connectionId: B, value: 363, observedAtMs: NOW + 1 }, NOW + 1);
		held.observe({ connectionId: A, value: null, observedAtMs: NOW + 2 }, NOW + 2);
		expect(held.current(NOW + 2)).toBe(363);
	});
});
