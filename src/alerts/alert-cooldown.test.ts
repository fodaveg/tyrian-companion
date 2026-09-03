import { describe, expect, it } from 'vitest';

import {
	alertCooldownReady,
	alertCooldownUntilMs,
	DEFAULT_ALERT_COOLDOWN_HOURS,
	isAlertCooldownHours,
	lastEmittedAtMs,
} from './alert-cooldown';
import type { AlertKind } from './alert-contract';
import type { EmittedAlertRecordV1 } from './alert-queue-record';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const HOUR = 3_600_000;

function record(kind: AlertKind, emittedAtMs: number): EmittedAlertRecordV1 {
	const emittedAt = new Date(emittedAtMs).toISOString();
	return {
		version: 1, vaultId: 'vault', accountRef: 'ref', alertId: `alert:${kind}:36038:${emittedAt}`,
		kind, itemId: 36_038, name: 'Trick-or-Treat Bag', quantity: 1, totalCopper: 1,
		reason: 'bid_above_reference', emittedAt,
	};
}

describe('H13.2 alert cooldown', () => {
	it('defaults to the 24 hours the signals are specified with', () => {
		expect(DEFAULT_ALERT_COOLDOWN_HOURS).toBe(24);
		expect(alertCooldownUntilMs(NOW, 24)).toBe(NOW + 24 * HOUR);
	});

	it('lets a kind that has never spoken speak', () => {
		expect(alertCooldownReady([], 'sell_signal', NOW, 24)).toBe(true);
	});

	it('silences a kind for exactly its cooldown, and not a millisecond more', () => {
		const emitted = [record('sell_signal', NOW - 24 * HOUR + 1)];

		expect(alertCooldownReady(emitted, 'sell_signal', NOW, 24)).toBe(false);
		expect(alertCooldownReady([record('sell_signal', NOW - 24 * HOUR)], 'sell_signal', NOW, 24)).toBe(true);
	});

	it('keeps the kinds independent, so a hold cannot silence a sell', () => {
		const emitted = [record('hold_signal', NOW - 60_000), record('valuable_loot', NOW - 60_000)];

		expect(alertCooldownReady(emitted, 'sell_signal', NOW, 24)).toBe(true);
		expect(alertCooldownReady(emitted, 'hold_signal', NOW, 24)).toBe(false);
	});

	/**
	 * The queue is documented newest first but is not trusted to be. A re-ordered
	 * read must not shorten a cooldown, so the newest emission wins wherever it
	 * sits in the list.
	 */
	it('takes the newest emission whatever order the queue arrives in', () => {
		const emitted = [record('sell_signal', NOW - 48 * HOUR), record('sell_signal', NOW - HOUR)];

		expect(lastEmittedAtMs(emitted, 'sell_signal')).toBe(NOW - HOUR);
		expect(alertCooldownReady(emitted, 'sell_signal', NOW, 24)).toBe(false);
		expect(alertCooldownReady([...emitted].reverse(), 'sell_signal', NOW, 24)).toBe(false);
	});

	it('stays quiet on unreadable input rather than alerting on every poll', () => {
		expect(alertCooldownReady([], 'sell_signal', Number.NaN, 24)).toBe(false);
		expect(alertCooldownReady([], 'sell_signal', -1, 24)).toBe(false);
		expect(alertCooldownReady([], 'sell_signal', NOW, 7 as never)).toBe(false);
	});

	it('ignores a record whose instant cannot be parsed instead of trusting it', () => {
		const broken = { ...record('sell_signal', NOW - HOUR), emittedAt: 'yesterday' };

		expect(lastEmittedAtMs([broken], 'sell_signal')).toBeNull();
		expect(alertCooldownReady([broken], 'sell_signal', NOW, 24)).toBe(true);
	});

	it('accepts only the four declared cooldowns', () => {
		for (const hours of [6, 12, 24, 48]) expect(isAlertCooldownHours(hours)).toBe(true);
		for (const hours of [0, 1, 7, 25, '24', null]) expect(isAlertCooldownHours(hours)).toBe(false);
	});
});
