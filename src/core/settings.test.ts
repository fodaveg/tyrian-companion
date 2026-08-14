import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SETTINGS,
	hasLegacyPaths,
	mergeSettingsUpdate,
	migrateSettings,
	normalizeVaultFolder,
	SETTINGS_SCHEMA_VERSION,
	shouldPersistSettingsOnLoad,
} from './settings';

const NESTED_CONFIG_DIR = `config/.${'obsidian'}`;

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

	it.each(['apiKey', 'apiToken', 'bearerToken', 'credential'])(
		'forces a canonical rewrite that purges unknown top-level field %s',
		(field) => {
			const persisted = {
				...DEFAULT_SETTINGS,
				outputFolder: 'Guild Wars 2/e\u0301',
				[field]: 'must-not-be-persisted',
			};
			const migrated = migrateSettings(persisted);
			expect(hasLegacyPaths(migrated)).toBe(true);
			expect(shouldPersistSettingsOnLoad(persisted, migrated)).toBe(true);
			expect(migrated).toEqual({
				...DEFAULT_SETTINGS,
				legacyOutputFolder: persisted.outputFolder,
			});
		},
	);

	it('purges nested unknown and secret-like data while retaining authorized current and legacy fields', () => {
		const persisted = {
			...DEFAULT_SETTINGS,
			apiKeySecret: 'gw2-primary',
			outputFolder: 'Guild Wars 2/e\u0301',
			legacyManagedAssetsRoot: 'Guild Wars 2/COM\u00b9',
			unknown: {
				apiToken: 'must-not-be-persisted',
				nested: { bearerToken: 'must-not-be-persisted', credential: 'must-not-be-persisted' },
			},
		};
		const migrated = migrateSettings(persisted);

		expect(migrated).toEqual({
			...DEFAULT_SETTINGS,
			apiKeySecret: 'gw2-primary',
			legacyOutputFolder: persisted.outputFolder,
			legacyManagedAssetsRoot: persisted.legacyManagedAssetsRoot,
		});
		expect(shouldPersistSettingsOnLoad(persisted, migrated)).toBe(true);
		expect(JSON.stringify(migrated)).not.toMatch(/apiToken|bearerToken|credential|unknown/u);
	});

	it('migrates v2 to v4 without scanning or claiming managed assets', () => {
		expect(migrateSettings({ schemaVersion: 2, outputFolder: 'Games/GW2' })).toMatchObject({
			schemaVersion: 4,
			managedAssetsRoot: null,
		});
		expect(migrateSettings({ schemaVersion: 3, managedAssetsRoot: 'Games/GW2' }).managedAssetsRoot).toBe('Games/GW2');
		expect(migrateSettings({ schemaVersion: 3, managedAssetsRoot: '../outside' }).managedAssetsRoot).toBeNull();
	});

	it('retains b05e656 legacy paths in the canonical rewrite', () => {
		const b05e656 = {
			schemaVersion: 3,
			outputFolder: 'Guild Wars 2/e\u0301',
			managedAssetsRoot: 'Guild Wars 2/COM¹',
		};
		const migrated = migrateSettings(b05e656);
		expect(migrated).toMatchObject({
			schemaVersion: SETTINGS_SCHEMA_VERSION,
			outputFolder: DEFAULT_SETTINGS.outputFolder,
			managedAssetsRoot: null,
			legacyOutputFolder: b05e656.outputFolder,
			legacyManagedAssetsRoot: b05e656.managedAssetsRoot,
		});
		expect(hasLegacyPaths(migrated)).toBe(true);
		expect(shouldPersistSettingsOnLoad(b05e656, migrated)).toBe(true);
		expect(shouldPersistSettingsOnLoad(migrated, migrateSettings(migrated))).toBe(false);
	});

	it.each(['Guild Wars 2/e\u0301', 'Guild Wars 2/COM1', 'a'.repeat(129)])(
		'retains each b05e656 path class %j as legacy evidence',
		(path) => {
			const migrated = migrateSettings({ schemaVersion: 3, outputFolder: path, managedAssetsRoot: path });
			expect(migrated.legacyOutputFolder).toBe(path);
			expect(migrated.legacyManagedAssetsRoot).toBe(path);
		},
	);

	it('preserves legacy paths through unrelated saves and clears each only after its explicit replacement', () => {
		const legacy = migrateSettings({
			schemaVersion: 3,
			outputFolder: 'Guild Wars 2/e\u0301',
			managedAssetsRoot: 'Guild Wars 2/COM¹',
		});
		const unrelated = mergeSettingsUpdate(legacy, { language: 'en' });
		expect(unrelated.legacyOutputFolder).toBe('Guild Wars 2/e\u0301');
		expect(unrelated.legacyManagedAssetsRoot).toBe('Guild Wars 2/COM¹');
		const outputMoved = mergeSettingsUpdate(unrelated, { outputFolder: 'Tyrian Companion Safe' });
		expect(outputMoved.legacyOutputFolder).toBeNull();
		expect(outputMoved.legacyManagedAssetsRoot).toBe('Guild Wars 2/COM¹');
		const assetsMoved = mergeSettingsUpdate(outputMoved, { managedAssetsRoot: 'Tyrian Companion Safe' });
		expect(assetsMoved.legacyManagedAssetsRoot).toBeNull();
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
		'Games/Bad\u0001Name',
		'Games/Bad\ud800Name',
		'Games/Trailing.',
		'Games/Trailing ',
		'Games/CON',
		'Games/AUX.md',
		'Games/COM1 .md',
		'Games/COM².md',
		`Games/${'a'.repeat(121)}`,
		'a'.repeat(129),
		'Games/e\u0301',
	])(
		'replaces unsafe path %s with the default',
		(path) => {
			expect(normalizeVaultFolder(path, '.config')).toBe(DEFAULT_SETTINGS.outputFolder);
		},
	);

	it('reserves a nested configured directory by path prefix', () => {
		expect(normalizeVaultFolder(`Config/${NESTED_CONFIG_DIR.slice('config/'.length)}/plugins`, NESTED_CONFIG_DIR)).toBe(DEFAULT_SETTINGS.outputFolder);
		expect(normalizeVaultFolder(`Config/${NESTED_CONFIG_DIR.slice('config/'.length)}-copy`, NESTED_CONFIG_DIR)).toBe(`Config/${NESTED_CONFIG_DIR.slice('config/'.length)}-copy`);
	});
});
