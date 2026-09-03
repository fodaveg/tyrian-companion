import { describe, expect, it } from 'vitest';

import { DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER } from './alert-contract';
import { alwaysAlertReasonsOf, decideLootAlert } from './loot-alert-criteria';

describe('H13.3 loot alert criteria', () => {
	it('alerts on total value at the threshold and stays quiet one copper below it', () => {
		const candidate = { itemId: 36_038, name: 'Bolsa', quantity: 5, alwaysAlertReasons: [] as const };
		expect(decideLootAlert({ ...candidate, totalCopper: 50_000 }, DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER))
			.toEqual({ kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa', quantity: 5, totalCopper: 50_000, reason: 'valuable' });
		expect(decideLootAlert({ ...candidate, totalCopper: 49_999 }, DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER)).toBeNull();
	});

	it('reads the TOTAL and not the unit price: five cheap copies clear a threshold one cannot', () => {
		const unitValue = 12_000;
		expect(decideLootAlert({
			itemId: 7, name: 'Trozo', quantity: 1, totalCopper: unitValue, alwaysAlertReasons: [],
		}, 50_000)).toBeNull();
		expect(decideLootAlert({
			itemId: 7, name: 'Trozo', quantity: 5, totalCopper: unitValue * 5, alwaysAlertReasons: [],
		}, 50_000)).toMatchObject({ kind: 'valuable_loot', totalCopper: 60_000 });
	});

	it('alerts on the value-free half of the OR with no quote at all', () => {
		expect(decideLootAlert({
			itemId: 9, name: 'Arma ligada', quantity: 1, totalCopper: null,
			alwaysAlertReasons: ['rare_unpriced_or_bound'],
		}, 50_000)).toEqual({
			kind: 'always_alert', itemId: 9, name: 'Arma ligada', quantity: 1, totalCopper: null,
			reason: 'rare_unpriced_or_bound',
		});
	});

	it('lets value take the headline when both halves of the OR hold', () => {
		expect(decideLootAlert({
			itemId: 9, name: 'Arma rara', quantity: 1, totalCopper: 900_000,
			alwaysAlertReasons: ['first_seen', 'skin_not_unlocked'],
		}, 50_000)).toMatchObject({ kind: 'valuable_loot', reason: 'valuable' });
	});

	it('is an OR and not an AND: a cheap first sighting still alerts', () => {
		expect(decideLootAlert({
			itemId: 11, name: 'Caramelo', quantity: 1, totalCopper: 3, alwaysAlertReasons: ['first_seen'],
		}, 50_000)).toMatchObject({ kind: 'always_alert', reason: 'first_seen' });
	});

	it('rejects a candidate or a threshold that is not a safe non-negative integer', () => {
		const candidate = { itemId: 1, name: 'X', quantity: 1, totalCopper: 100_000, alwaysAlertReasons: [] as const };
		expect(decideLootAlert(candidate, -1)).toBeNull();
		expect(decideLootAlert(candidate, 1.5)).toBeNull();
		expect(decideLootAlert({ ...candidate, quantity: 0 }, 0)).toBeNull();
		expect(decideLootAlert({ ...candidate, name: '' }, 0)).toBeNull();
	});

	it('drops the policy per-unit `valuable` reason and keeps only the value-free ones', () => {
		expect(alwaysAlertReasonsOf({ reasons: [
			{ code: 'valuable', netUnitCopper: 20_000, thresholdCopper: 10_000 },
			{ code: 'first_seen' },
			{ code: 'mini_not_unlocked', miniId: 3 },
		] })).toEqual(['first_seen', 'mini_not_unlocked']);
		expect(alwaysAlertReasonsOf({ reasons: [
			{ code: 'valuable', netUnitCopper: 20_000, thresholdCopper: 10_000 },
		] })).toEqual([]);
	});
});
