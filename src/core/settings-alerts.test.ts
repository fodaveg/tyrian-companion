import { describe, expect, it } from 'vitest';

import { DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER } from '../alerts/alert-contract';
import {
	alertWebhookDestination,
	DEFAULT_SETTINGS,
	migrateSettings,
	SETTINGS_SCHEMA_VERSION,
} from './settings';

describe('H13.3 and H13.4 settings', () => {
	it('ships the drop alert at five gold and the webhook off', () => {
		expect(DEFAULT_SETTINGS.valuableLootThresholdCopper).toBe(DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER);
		expect(DEFAULT_SETTINGS.valuableLootThresholdCopper).toBe(50_000);
		expect(DEFAULT_SETTINGS.alertWebhookUrl).toBe('');
	});

	/**
	 * The per-unit Halloween threshold and the per-total alert threshold are two
	 * numbers on purpose. Folding them into one would have rewritten the policy
	 * of every install that had tuned the old field.
	 */
	it('keeps the per-unit Halloween threshold independent from the alert threshold', () => {
		const migrated = migrateSettings({
			schemaVersion: SETTINGS_SCHEMA_VERSION, halloweenValueThresholdCopper: 25_000,
		});
		expect(migrated.halloweenValueThresholdCopper).toBe(25_000);
		expect(migrated.valuableLootThresholdCopper).toBe(50_000);
	});

	it('adopts the new fields on a pre-H13.3 install without discarding anything it had', () => {
		const persisted = {
			schemaVersion: SETTINGS_SCHEMA_VERSION,
			pollingIntervalMinutes: 60,
			debugLoggingEnabled: true,
			debugLoggingLevel: 'debug',
			halloweenEnabled: true,
			halloweenValueThresholdCopper: 25_000,
			preferredCharacter: 'Astra Uno',
		};
		const migrated = migrateSettings(persisted);

		expect(migrated.valuableLootThresholdCopper).toBe(50_000);
		expect(migrated.alertWebhookUrl).toBe('');
		// No schema bump: the deliberate cadence, the debug opt-in and the character survive.
		expect(migrated.pollingIntervalMinutes).toBe(60);
		expect(migrated.debugLoggingEnabled).toBe(true);
		expect(migrated.debugLoggingLevel).toBe('debug');
		expect(migrated.halloweenEnabled).toBe(true);
		expect(migrated.preferredCharacter).toBe('Astra Uno');
	});

	it('retains only an HTTPS webhook destination', () => {
		expect(alertWebhookDestination('https://discord.example/api/webhooks/1/abc'))
			.toBe('https://discord.example/api/webhooks/1/abc');
		expect(alertWebhookDestination(' https://discord.example/x ')).toBe('https://discord.example/x');
		for (const rejected of [
			'http://discord.example/x', 'ftp://host/x', 'javascript:alert(1)', 'not a url', '', '   ', 42, null,
			`https://host/${'x'.repeat(600)}`,
		]) {
			expect(alertWebhookDestination(rejected), String(rejected)).toBe('');
		}
	});

	it('discards a stored plain-HTTP destination on load instead of using it in the clear', () => {
		expect(migrateSettings({ alertWebhookUrl: 'http://leaky.example/hook' }).alertWebhookUrl).toBe('');
		expect(migrateSettings({ alertWebhookUrl: 'https://ok.example/hook' }).alertWebhookUrl)
			.toBe('https://ok.example/hook');
	});

	it('refuses a threshold that is not a safe non-negative integer', () => {
		for (const rejected of [-1, 1.5, Number.NaN, '50000', null]) {
			expect(migrateSettings({ valuableLootThresholdCopper: rejected }).valuableLootThresholdCopper).toBe(50_000);
		}
		expect(migrateSettings({ valuableLootThresholdCopper: 0 }).valuableLootThresholdCopper).toBe(0);
	});
});
