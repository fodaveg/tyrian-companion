import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SETTINGS,
	migrateSettings,
	normalizeVaultFolder,
	SETTINGS_SCHEMA_VERSION,
} from './settings';

describe('migrateSettings', () => {
	it('migrates the unversioned 0.1.0 settings idempotently', () => {
		const migrated = migrateSettings({ apiKeySecret: 'gw2-primary' });

		expect(migrated).toEqual({
			...DEFAULT_SETTINGS,
			schemaVersion: SETTINGS_SCHEMA_VERSION,
			apiKeySecret: 'gw2-primary',
		});
		expect(migrateSettings(migrated)).toEqual(migrated);
	});

	it('validates enums, optional character, and polling interval', () => {
		expect(
			migrateSettings({
				language: 'fr',
				preferredCharacter: '  Kasmeer  ',
				pollingIntervalMinutes: 1,
				detectionMode: 'automatic',
			}),
		).toMatchObject({
			language: 'es',
			preferredCharacter: 'Kasmeer',
			pollingIntervalMinutes: 60,
			detectionMode: 'off',
		});
	});

	it('keeps only the SecretStorage name', () => {
		expect(
			migrateSettings({ apiKeySecret: 'gw2-primary', apiKey: 'must-not-be-persisted' }),
		).not.toHaveProperty('apiKey');
	});

	it('migrates v2 to v3 without scanning or claiming managed assets', () => {
		expect(migrateSettings({ schemaVersion: 2, outputFolder: 'Games/GW2' })).toMatchObject({
			schemaVersion: 3,
			managedAssetsRoot: null,
		});
		expect(migrateSettings({ schemaVersion: 3, managedAssetsRoot: 'Games/GW2' }).managedAssetsRoot).toBe('Games/GW2');
		expect(migrateSettings({ schemaVersion: 3, managedAssetsRoot: '../outside' }).managedAssetsRoot).toBeNull();
	});
});

describe('normalizeVaultFolder', () => {
	it('normalizes a safe vault-relative folder', () => {
		expect(normalizeVaultFolder('Games/Guild Wars 2')).toBe('Games/Guild Wars 2');
	});

	it.each([
		'/tmp/output',
		'../outside',
		'Games/../../outside',
		'.config/plugins',
		'C:\\tmp',
		'Games//Output',
		'Games/.',
		'Games/..',
		'Games/Bad:Name',
		'Games/Bad*Name',
		'Games/Bad?Name',
		'Games/Bad"Name',
		'Games/Bad<Name',
		'Games/Bad>Name',
		'Games/Bad|Name',
		'Games/Bad\0Name',
		'Games/Trailing.',
		'Games/Trailing ',
	])(
		'replaces unsafe path %s with the default',
		(path) => {
			expect(normalizeVaultFolder(path, '.config')).toBe(DEFAULT_SETTINGS.outputFolder);
		},
	);
});
