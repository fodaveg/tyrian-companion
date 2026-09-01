import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SETTINGS,
	hasLegacyPaths,
	mergeSettingsUpdate,
	migrateSettings,
	normalizeVaultFolder,
	POLLING_INTERVAL_OPTIONS,
	resolveMaterialStorageCapacity,
	resolveEquipmentSalvagePreferences,
	resolveVaultFolderInput,
	SETTINGS_SCHEMA_VERSION,
	shouldPersistSettingsOnLoad,
} from './settings';

const NESTED_CONFIG_DIR = `config/.${'obsidian'}`;

describe('migrateSettings', () => {
	it('leaves diagnostics off for a pre-v11 install and preserves valid v11 preferences', () => {
		expect(migrateSettings({ schemaVersion: 10, debugLoggingEnabled: false, debugLoggingLevel: 'error' }))
			.toMatchObject({ schemaVersion: 12, debugLoggingEnabled: false, debugLoggingLevel: 'warn' });
		expect(migrateSettings({ schemaVersion: 11, debugLoggingEnabled: false, debugLoggingLevel: 'warn' }))
			.toMatchObject({ debugLoggingEnabled: false, debugLoggingLevel: 'warn' });
		expect(migrateSettings({ schemaVersion: 12, debugLoggingEnabled: true, debugLoggingLevel: 'trace' }))
			.toMatchObject({ debugLoggingEnabled: true, debugLoggingLevel: 'warn' });
	});

	it('does not write a diagnostic journal on a default install', () => {
		expect(migrateSettings(null)).toMatchObject({ debugLoggingEnabled: false, debugLoggingLevel: 'warn' });
	});

	it('rewrites the polling cadence once when upgrading and respects explicit v12 edits', () => {
		const upgraded = migrateSettings({
			schemaVersion: 11,
			pollingIntervalMinutes: 60,
		});

		expect(upgraded).toMatchObject({ schemaVersion: 12, pollingIntervalMinutes: 10 });
		expect(shouldPersistSettingsOnLoad({ schemaVersion: 11, pollingIntervalMinutes: 60 }, upgraded)).toBe(true);
		expect(migrateSettings({ ...upgraded, pollingIntervalMinutes: 15 }).pollingIntervalMinutes).toBe(15);
		expect(mergeSettingsUpdate(upgraded, { pollingIntervalMinutes: 60 }).pollingIntervalMinutes).toBe(60);
		// A v12 install keeps the cadence it already persisted, inherited default included.
		expect(migrateSettings({ ...upgraded, pollingIntervalMinutes: 30 }).pollingIntervalMinutes).toBe(30);
	});

	it('keeps the default cadence inside the offered options', () => {
		expect(POLLING_INTERVAL_OPTIONS).toContain(DEFAULT_SETTINGS.pollingIntervalMinutes);
	});

	it('offers no cadence below the account API cache ceiling', () => {
		// The API serves account data from a 5-10 minute cache chain; a faster poll only spends
		// the shared request budget on bytes that cannot have changed yet.
		expect(POLLING_INTERVAL_OPTIONS).toEqual([10, 15, 30, 60, 120, 240]);
		expect(Math.min(...POLLING_INTERVAL_OPTIONS)).toBeGreaterThanOrEqual(10);
	});

	it('rewrites a persisted two-minute cadence that is no longer offered', () => {
		const persisted = { ...migrateSettings({ schemaVersion: 11 }), pollingIntervalMinutes: 2 };

		const migrated = migrateSettings(persisted);

		expect(migrated.pollingIntervalMinutes).toBe(10);
		// The correction is written back, so the install does not reload the retired value.
		expect(shouldPersistSettingsOnLoad(persisted, migrated)).toBe(true);
		expect(mergeSettingsUpdate(migrated, { pollingIntervalMinutes: 2 }).pollingIntervalMinutes).toBe(10);
	});

	it('deep-freezes defaults and returns isolated nested valuation instances', () => {
		expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
		expect(Object.isFrozen(DEFAULT_SETTINGS.halloweenPersonalValuation)).toBe(true);
		expect(Object.isFrozen(DEFAULT_SETTINGS.halloweenPersonalValuation.values)).toBe(true);
		const shallowCopy = { ...DEFAULT_SETTINGS };
		expect(() => shallowCopy.halloweenPersonalValuation.values.push({
			outcomeKey: 'item:36031', unitCopper: 1, origin: 'manual',
		})).toThrow();

		const first = migrateSettings(null);
		const second = migrateSettings(undefined);
		first.halloweenPersonalValuation.values.push({
			outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual',
		});
		expect(second.halloweenPersonalValuation.values).toEqual([]);
		expect(DEFAULT_SETTINGS.halloweenPersonalValuation.values).toEqual([]);
	});

	it('clones a persisted valuation instead of retaining its nested values array', () => {
		const persisted = { halloweenPersonalValuation: { version: 1 as const, values: [
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' as const },
		] } };
		const migrated = migrateSettings(persisted);
		persisted.halloweenPersonalValuation.values[0]!.unitCopper = 50;
		expect(migrated.halloweenPersonalValuation.values[0]?.unitCopper).toBe(25);
	});

	it('isolates nested valuation values between successive settings instances', () => {
		const current = migrateSettings({ halloweenPersonalValuation: { version: 1, values: [
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
		] } });
		const updated = mergeSettingsUpdate(current, { preferredCharacter: 'Kasmeer' });
		expect(updated.halloweenPersonalValuation).not.toBe(current.halloweenPersonalValuation);
		expect(updated.halloweenPersonalValuation.values).not.toBe(current.halloweenPersonalValuation.values);
		updated.halloweenPersonalValuation.values[0]!.unitCopper = 50;
		expect(current.halloweenPersonalValuation.values[0]?.unitCopper).toBe(25);
	});

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
			language: 'en',
			preferredCharacter: 'Kasmeer',
			pollingIntervalMinutes: 10,
			detectionMode: 'off',
		});
		expect(migrateSettings({ pollingIntervalMinutes: 2 })).toMatchObject({ pollingIntervalMinutes: 10 });
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
				outputFolder: 'Guild Wars 2/CON',
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
			outputFolder: 'Guild Wars 2/CON',
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

	it('migrates v2 to v12 without scanning, claiming assets, price history, Halloween or storage upgrades', () => {
		expect(migrateSettings({ schemaVersion: 2, outputFolder: 'Games/GW2' })).toMatchObject({
			schemaVersion: 12,
			managedAssetsRoot: null,
			priceHistoryEnabled: false,
			halloweenEnabled: false,
			halloweenValueThresholdCopper: 10_000,
			halloweenPersonalValuation: { version: 1, values: [] },
			materialStorageCapacity: null,
		});
		expect(migrateSettings({ schemaVersion: 3, managedAssetsRoot: 'Games/GW2' }).managedAssetsRoot).toBe('Games/GW2');
		expect(migrateSettings({ schemaVersion: 3, managedAssetsRoot: '../outside' }).managedAssetsRoot).toBeNull();
	});

	it('migrates v7 to v12 with an empty manual overlay and canonicalizes valid values', () => {
		expect(migrateSettings({ schemaVersion: 7 })).toMatchObject({
			schemaVersion: 12,
			halloweenPersonalValuation: { version: 1, values: [] },
		});
		expect(migrateSettings({
			schemaVersion: 8,
			halloweenPersonalValuation: { version: 1, values: [
				{ outcomeKey: 'item:45176', unitCopper: 0, origin: 'manual' },
				{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
			] },
		}).halloweenPersonalValuation).toEqual({ version: 1, values: [
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
			{ outcomeKey: 'item:45176', unitCopper: 0, origin: 'manual' },
		] });
	});

	it('fails closed for unknown material-storage upgrades and exposes the safe provenance', () => {
		expect(migrateSettings({ schemaVersion: 8 }).materialStorageCapacity).toBeNull();
		for (const invalid of [0, 251, 3_250, '500']) {
			expect(migrateSettings({ materialStorageCapacity: invalid }).materialStorageCapacity).toBeNull();
		}
		expect(migrateSettings({ materialStorageCapacity: 250 }).materialStorageCapacity).toBe(250);
		expect(migrateSettings({ materialStorageCapacity: 3_000 }).materialStorageCapacity).toBe(3_000);
		expect(resolveMaterialStorageCapacity(null)).toEqual({ quantity: 250, source: 'minimum_guaranteed' });
		expect(resolveMaterialStorageCapacity(1_000)).toEqual({ quantity: 1_000, source: 'configured' });

		const current = migrateSettings({ materialStorageCapacity: 750 });
		expect(mergeSettingsUpdate(current, { materialStorageCapacity: 251 as never }).materialStorageCapacity).toBe(750);
		expect(mergeSettingsUpdate(current, { materialStorageCapacity: null }).materialStorageCapacity).toBeNull();
	});

	it('keeps every salvage preference optional and rejects hostile interactive updates', () => {
		const empty = migrateSettings({ schemaVersion: 9 });
		expect(resolveEquipmentSalvagePreferences(empty)).toEqual({
			version: 1, kit: null, saleStrategy: null, time: null,
		});
		const configured = migrateSettings({
			salvageKit: 'silver_fed', salvageSaleStrategy: 'listing',
			salvageSecondsPerItem: 3, salvageOpportunityCostCopperPerHour: 12_345,
		});
		expect(resolveEquipmentSalvagePreferences(configured)).toEqual({
			version: 1, kit: 'silver_fed', saleStrategy: 'listing',
			time: { secondsPerItem: 3, opportunityCostCopperPerHour: 12_345 },
		});
		const partial = migrateSettings({ salvageSecondsPerItem: 2 });
		expect(resolveEquipmentSalvagePreferences(partial).time).toBeNull();

		const current = migrateSettings({
			salvageKit: 'master', salvageSaleStrategy: 'instant_sell',
			salvageSecondsPerItem: 2, salvageOpportunityCostCopperPerHour: 10_000,
		});
		expect(mergeSettingsUpdate(current, {
			salvageKit: 'future' as never,
			salvageSaleStrategy: 'average' as never,
			salvageSecondsPerItem: -1,
			salvageOpportunityCostCopperPerHour: Number.MAX_SAFE_INTEGER,
		})).toMatchObject({
			salvageKit: 'master', salvageSaleStrategy: 'instant_sell',
			salvageSecondsPerItem: 2, salvageOpportunityCostCopperPerHour: 10_000,
		});
	});

	it('purges foreign, duplicate, liquid and unsafe personal values without inventing defaults', () => {
		for (const values of [
			[{ outcomeKey: 'item:999999', unitCopper: 1, origin: 'manual' }],
			[{ outcomeKey: 'item:36041', unitCopper: 1, origin: 'manual' }],
			[{ outcomeKey: 'item:36031', unitCopper: 1, origin: 'manual' },
				{ outcomeKey: 'item:36031', unitCopper: 2, origin: 'manual' }],
			[{ outcomeKey: 'item:36031', unitCopper: -1, origin: 'manual' }],
		]) {
			expect(migrateSettings({ halloweenPersonalValuation: { version: 1, values } })
				.halloweenPersonalValuation).toEqual({ version: 1, values: [] });
		}
	});

	it('preserves the last saved overlay when an interactive update is invalid', () => {
		const current = migrateSettings({ halloweenPersonalValuation: { version: 1, values: [
			{ outcomeKey: 'item:36031', unitCopper: 25, origin: 'manual' },
		] } });
		const updated = mergeSettingsUpdate(current, {
			halloweenPersonalValuation: { version: 1, values: [
				{ outcomeKey: 'item:36031', unitCopper: -1, origin: 'manual' },
			] },
		});
		expect(updated.halloweenPersonalValuation).toEqual(current.halloweenPersonalValuation);
	});

	it('keeps the Halloween p90 alert opt-in and sanitizes its margin and cooldown', () => {
		expect(migrateSettings({
			halloweenPriceAlertEnabled: true,
			halloweenPriceAlertMinimumAboveP90Bps: 1_250,
			halloweenPriceAlertCooldownHours: 48,
		})).toMatchObject({
			halloweenPriceAlertEnabled: true,
			halloweenPriceAlertMinimumAboveP90Bps: 1_250,
			halloweenPriceAlertCooldownHours: 48,
		});
		expect(migrateSettings({
			halloweenPriceAlertEnabled: 'yes',
			halloweenPriceAlertMinimumAboveP90Bps: 100_001,
			halloweenPriceAlertCooldownHours: 7,
		})).toMatchObject({
			halloweenPriceAlertEnabled: false,
			halloweenPriceAlertMinimumAboveP90Bps: 0,
			halloweenPriceAlertCooldownHours: 24,
		});
	});

	it('validates every price-history option and keeps opt-in explicit', () => {
		expect(migrateSettings({
			priceHistoryEnabled: true,
			priceHistoryIntervalMinutes: 5,
			priceHistoryRawRetentionDays: 30,
			priceHistoryDailyRetentionDays: 365,
		})).toMatchObject({
			priceHistoryEnabled: true,
			priceHistoryIntervalMinutes: 5,
			priceHistoryRawRetentionDays: 30,
			priceHistoryDailyRetentionDays: 365,
		});
		expect(migrateSettings({
			priceHistoryEnabled: 'yes',
			priceHistoryIntervalMinutes: 1,
			priceHistoryRawRetentionDays: 365,
			priceHistoryDailyRetentionDays: 7,
		})).toMatchObject({
			priceHistoryEnabled: false,
			priceHistoryIntervalMinutes: 15,
			priceHistoryRawRetentionDays: 7,
			priceHistoryDailyRetentionDays: 180,
		});
	});

	it('retains b05e656 legacy paths in the canonical rewrite', () => {
		const b05e656 = {
			schemaVersion: 3,
			outputFolder: 'Guild Wars 2/CON',
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

	it.each(['Guild Wars 2/CON', 'Guild Wars 2/COM1', 'a'.repeat(129)])(
		'retains each b05e656 path class %j as legacy evidence',
		(path) => {
			const migrated = migrateSettings({ schemaVersion: 3, outputFolder: path, managedAssetsRoot: path });
			expect(migrated.legacyOutputFolder).toBe(path);
			expect(migrated.legacyManagedAssetsRoot).toBe(path);
		},
	);

	it('tolerates a pre-0.1.7 install with no inventorySyncLastRun field', () => {
		expect(migrateSettings({ apiKeySecret: 'gw2-primary' }).inventorySyncLastRun).toBeNull();
	});

	it('round-trips a valid inventorySyncLastRun and purges an invalid or foreign one', () => {
		const outcome = {
			status: 'success' as const, finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 86694,
			summary: { positions: 2909, create: 1616, update: 1167, unchanged: 79, deactivate: 0, conflicts: 0 },
			error: null,
		};
		expect(migrateSettings({ inventorySyncLastRun: outcome }).inventorySyncLastRun).toEqual(outcome);
		expect(migrateSettings({ inventorySyncLastRun: { status: 'error', finishedAt: '2026-08-25T07:00:13.750Z',
			durationMs: 40, summary: null, error: 'write_unavailable' } }).inventorySyncLastRun).toEqual({
			status: 'error', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 40, summary: null, error: 'write_unavailable',
		});
		for (const invalid of [
			{ status: 'error', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 1, summary: null, error: null },
			{ status: 'made-up', finishedAt: '2026-08-25T07:00:13.750Z', durationMs: 1, summary: null, error: null },
			{ ...outcome, finishedAt: 'not-a-date' },
			{ ...outcome, durationMs: -1 },
			'RAW_STRING',
			42,
		]) {
			expect(migrateSettings({ inventorySyncLastRun: invalid }).inventorySyncLastRun).toBeNull();
		}
		expect(migrateSettings({
			inventorySyncLastRun: { ...outcome, summary: { ...outcome.summary, create: -1 } },
		}).inventorySyncLastRun).toEqual({ ...outcome, summary: null });
		expect(migrateSettings({
			inventorySyncLastRun: { ...outcome, summary: { positions: 1 } },
		}).inventorySyncLastRun).toEqual({ ...outcome, summary: null });
	});

	it('preserves legacy paths through unrelated saves and clears each only after its explicit replacement', () => {
		const legacy = migrateSettings({
			schemaVersion: 3,
			outputFolder: 'Guild Wars 2/CON',
			managedAssetsRoot: 'Guild Wars 2/COM¹',
		});
		const unrelated = mergeSettingsUpdate(legacy, { language: 'en' });
		expect(unrelated.legacyOutputFolder).toBe('Guild Wars 2/CON');
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

	it('accepts an NFD-decomposed accent and stores it in NFC instead of falling back to the default', () => {
		const nfd = 'Games/e\u0301xito';
		expect(normalizeVaultFolder(nfd, '.config')).toBe('Games/\u00e9xito');
		expect(normalizeVaultFolder(nfd, '.config')).not.toBe(DEFAULT_SETTINGS.outputFolder);
	});
});

describe('resolveVaultFolderInput', () => {
	it('accepts a safe vault-relative folder unchanged', () => {
		expect(resolveVaultFolderInput('Games/Guild Wars 2')).toEqual({ status: 'valid', value: 'Games/Guild Wars 2' });
	});

	it('accepts an NFD-decomposed accent and normalizes it to NFC', () => {
		expect(resolveVaultFolderInput('Games/e\u0301xito')).toEqual({ status: 'valid', value: 'Games/\u00e9xito' });
	});

	it.each(['Games/Bad:Name', 'Games/Bad\\Name', 'Games/CON', 'Games/Trailing.'])(
		'rejects an unsafe path %s without producing a substitute value',
		(path) => {
			expect(resolveVaultFolderInput(path, '.config')).toEqual({ status: 'invalid' });
		},
	);
});
