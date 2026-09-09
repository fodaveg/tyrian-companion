import { describe, expect, it } from 'vitest';

import { DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER } from './alert-contract';
import { alertIngameContent } from './alert-ingame';
import { alwaysAlertReasonsOf, decideLootAlert, policyAlertPriceOf } from './loot-alert-criteria';

describe('H13.3 loot alert criteria', () => {
	it('alerts on total value at the threshold and stays quiet one copper below it', () => {
		const candidate = { itemId: 36_038, name: 'Bolsa', quantity: 5, priceStatus: 'known' as const, alwaysAlertReasons: [] as const };
		expect(decideLootAlert({ ...candidate, totalCopper: 50_000 }, DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER))
			.toEqual({
				kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa', quantity: 5, totalCopper: 50_000,
				priceStatus: 'known', reason: 'valuable',
			});
		expect(decideLootAlert({ ...candidate, totalCopper: 49_999 }, DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER)).toBeNull();
	});

	it('reads the TOTAL and not the unit price: five cheap copies clear a threshold one cannot', () => {
		const unitValue = 12_000;
		expect(decideLootAlert({
			itemId: 7, name: 'Trozo', quantity: 1, totalCopper: unitValue, priceStatus: 'known', alwaysAlertReasons: [],
		}, 50_000)).toBeNull();
		expect(decideLootAlert({
			itemId: 7, name: 'Trozo', quantity: 5, totalCopper: unitValue * 5, priceStatus: 'known', alwaysAlertReasons: [],
		}, 50_000)).toMatchObject({ kind: 'valuable_loot', totalCopper: 60_000 });
	});

	it('alerts on the value-free half of the OR with no quote at all', () => {
		expect(decideLootAlert({
			itemId: 9, name: 'Skin bloqueada', quantity: 1, totalCopper: null, priceStatus: 'unquoted',
			alwaysAlertReasons: ['skin_not_unlocked'],
		}, 50_000)).toEqual({
			kind: 'always_alert', itemId: 9, name: 'Skin bloqueada', quantity: 1, totalCopper: null,
			priceStatus: 'unquoted', reason: 'skin_not_unlocked',
		});
	});

	it('lets value take the headline when both halves of the OR hold', () => {
		expect(decideLootAlert({
			itemId: 9, name: 'Arma rara', quantity: 1, totalCopper: 900_000, priceStatus: 'known',
			alwaysAlertReasons: ['skin_not_unlocked', 'mini_not_unlocked'],
		}, 50_000)).toMatchObject({ kind: 'valuable_loot', reason: 'valuable' });
	});

	it('is an OR and not an AND: a cheap unclaimed skin still alerts', () => {
		expect(decideLootAlert({
			itemId: 11, name: 'Caramelo', quantity: 1, totalCopper: 3, priceStatus: 'known', alwaysAlertReasons: ['skin_not_unlocked'],
		}, 50_000)).toMatchObject({ kind: 'always_alert', reason: 'skin_not_unlocked' });
	});

	// H14.3 (David, 3 sep: "un solo aviso, sin interruptores"): a first sighting or a bound/unpriced
	// rare no longer alert on their own, only the total-value criterion decides them now.
	it('drops first_seen and rare_unpriced_or_bound from the always-alert half: only the value threshold decides them now', () => {
		const belowThreshold = {
			itemId: 83_008, name: 'Objeto nuevo', quantity: 1, totalCopper: 40_000, priceStatus: 'known' as const,
			alwaysAlertReasons: alwaysAlertReasonsOf({ reasons: [{ code: 'first_seen' }] }),
		};
		expect(decideLootAlert(belowThreshold, 50_000)).toBeNull();
		expect(decideLootAlert({ ...belowThreshold, totalCopper: 50_000 }, 50_000)).toMatchObject({ kind: 'valuable_loot', reason: 'valuable' });

		const boundRare = {
			itemId: 12_345, name: 'Rara ligada', quantity: 1, totalCopper: 40_000, priceStatus: 'known' as const,
			alwaysAlertReasons: alwaysAlertReasonsOf({ reasons: [{ code: 'rare_unpriced_or_bound', rarity: 'Rare' }] }),
		};
		expect(decideLootAlert(boundRare, 50_000)).toBeNull();
		expect(decideLootAlert({ ...boundRare, totalCopper: 50_000 }, 50_000)).toMatchObject({ kind: 'valuable_loot', reason: 'valuable' });
	});

	it('rejects a candidate or a threshold that is not a safe non-negative integer', () => {
		const candidate = {
			itemId: 1, name: 'X', quantity: 1, totalCopper: 100_000, priceStatus: 'known' as const, alwaysAlertReasons: [] as const,
		};
		expect(decideLootAlert(candidate, -1)).toBeNull();
		expect(decideLootAlert(candidate, 1.5)).toBeNull();
		expect(decideLootAlert({ ...candidate, quantity: 0 }, 0)).toBeNull();
		expect(decideLootAlert({ ...candidate, name: '' }, 0)).toBeNull();
	});

	it('rejects a candidate whose priceStatus contradicts its totalCopper', () => {
		expect(decideLootAlert({
			itemId: 1, name: 'X', quantity: 1, totalCopper: 100_000, priceStatus: 'unquoted', alwaysAlertReasons: [],
		}, 0)).toBeNull();
		expect(decideLootAlert({
			itemId: 1, name: 'X', quantity: 1, totalCopper: null, priceStatus: 'known', alwaysAlertReasons: ['mini_not_unlocked'],
		}, 0)).toBeNull();
	});

	it('drops the per-unit `valuable` reason and the H14.3-excluded first_seen/rare_unpriced_or_bound, keeping only the unlock ones', () => {
		expect(alwaysAlertReasonsOf({ reasons: [
			{ code: 'valuable', netUnitCopper: 20_000, thresholdCopper: 10_000 },
			{ code: 'rare_unpriced_or_bound', rarity: 'Rare' },
			{ code: 'first_seen' },
			{ code: 'mini_not_unlocked', miniId: 3 },
		] })).toEqual(['mini_not_unlocked']);
		expect(alwaysAlertReasonsOf({ reasons: [
			{ code: 'valuable', netUnitCopper: 20_000, thresholdCopper: 10_000 },
		] })).toEqual([]);
	});
});

describe('policyAlertPriceOf', () => {
	it('reports a known price with its total, computed from the unit price and quantity', () => {
		// Item 83008: flagged mini-not-unlocked (a reason that needs no quote to fire) while its evidence
		// carries a real bid of 1_921 copper. The verdict must say so, not "no quoted value".
		expect(policyAlertPriceOf({ netUnitCopper: 1_921, priceStatus: 'quote', quantity: 3 }))
			.toEqual({ totalCopper: 5_763, priceStatus: 'known' });
	});

	it('reports unquoted only for a confirmed absence of a quote', () => {
		expect(policyAlertPriceOf({ netUnitCopper: null, priceStatus: 'no_quote', quantity: 1 }))
			.toEqual({ totalCopper: null, priceStatus: 'unquoted' });
	});

	it('reports unavailable, never unquoted, for every flavour of a lookup that never answered', () => {
		for (const priceStatus of ['unavailable', 'invalid', 'rate_limited'] as const) {
			expect(policyAlertPriceOf({ netUnitCopper: null, priceStatus, quantity: 1 }))
				.toEqual({ totalCopper: null, priceStatus: 'unavailable' });
		}
	});

	it('falls back to unavailable instead of inventing a total when the multiplication overflows', () => {
		expect(policyAlertPriceOf({ netUnitCopper: Number.MAX_SAFE_INTEGER, priceStatus: 'quote', quantity: 2 }))
			.toEqual({ totalCopper: null, priceStatus: 'unavailable' });
	});

	it('produces player-visible text that tells a known price apart from an unquoted and an unavailable one', () => {
		const base = { itemId: 83_008, name: 'Objeto de Halloween', quantity: 1, alwaysAlertReasons: ['mini_not_unlocked'] as const };
		const knownAlert = decideLootAlert({ ...base, ...policyAlertPriceOf({ netUnitCopper: 1_921, priceStatus: 'quote', quantity: 1 }) }, 0);
		const unquotedAlert = decideLootAlert({ ...base, ...policyAlertPriceOf({ netUnitCopper: null, priceStatus: 'no_quote', quantity: 1 }) }, 0);
		const unavailableAlert = decideLootAlert({ ...base, ...policyAlertPriceOf({ netUnitCopper: null, priceStatus: 'unavailable', quantity: 1 }) }, 0);
		expect(knownAlert && alertIngameContent(knownAlert)).toBe('Objeto de Halloween ×1 · 1921 copper');
		expect(unquotedAlert && alertIngameContent(unquotedAlert)).toBe('Objeto de Halloween ×1 · no quoted value');
		expect(unavailableAlert && alertIngameContent(unavailableAlert)).toBe('Objeto de Halloween ×1 · price unavailable');
		expect(new Set([knownAlert, unquotedAlert, unavailableAlert].map((alert) => alert && alertIngameContent(alert)))).toHaveProperty('size', 3);
	});
});
