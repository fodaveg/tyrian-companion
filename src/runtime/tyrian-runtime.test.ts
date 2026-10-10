import { describe, expect, it } from 'vitest';

import type { LocalDebugStoragePort } from '../core/local-debug-writer';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '../core/settings';
import type { TyrianHost } from '../host/tyrian-host';
import { createTyrianCoreRuntime, loadTyrianSettings } from './tyrian-runtime';

/**
 * R1a: what the boot runs is only what any host can give it. This host has no
 * Obsidian behind it at all: settings, locale, config dir and a diagnostics store in memory.
 */
function neutralHost(persisted: unknown, options: { locale?: string; loadFails?: Error } = {}) {
	const files = new Map<string, string>();
	const saved: unknown[] = [];
	const storage: LocalDebugStoragePort = {
		exists: async (path) => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
		read: async (path) => files.get(path) ?? '',
		write: async (path, data) => { files.set(path, data); },
		append: async (path, data) => { files.set(path, `${files.get(path) ?? ''}${data}`); },
		mkdir: async () => undefined,
		remove: async (path) => { files.delete(path); },
		rename: async (path, destination) => { files.set(destination, files.get(path) ?? ''); files.delete(path); },
	};
	const host = {
		vault: { configDir: 'host-config', basePath: () => null },
		settings: {
			load: async () => { if (options.loadFails) throw options.loadFails; return structuredClone(persisted); },
			save: async (data: unknown) => { saved.push(structuredClone(data)); },
		},
		locale: () => options.locale ?? 'en',
		diagnostics: { storage, directory: 'host-config/plugins/tyrian-companion/logs' },
		environment: { pluginVersion: '9.9.9' },
	} as unknown as TyrianHost;
	const records = (): Array<Record<string, unknown>> => [...files.values()].join('')
		.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
	return { host, saved, records };
}

const LOGGING = {
	...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: true, debugLoggingLevel: 'debug',
};

describe('createTyrianCoreRuntime: the boot, before any UI (R1a)', () => {
	it('loads the settings through the host and brings the diagnostics log up and down', async () => {
		const { host, records } = neutralHost(LOGGING);
		const runtime = createTyrianCoreRuntime(host);

		await runtime.start();
		await runtime.stop();

		const actions = records().map((record) => `${String(record.action)}:${String(record.phase)}`);
		expect(actions).toEqual(expect.arrayContaining([
			'debug_initialize:start', 'debug_initialize:success', 'settings_load:success', 'debug_flush:success',
		]));
		expect(records().find((record) => record.action === 'settings_load')).toMatchObject({
			pluginVersion: '9.9.9', details: { schemaVersion: SETTINGS_SCHEMA_VERSION },
		});
	});

	it('asks the host language only for a first run, and writes the migration back through the host', async () => {
		const { host } = neutralHost(null, { locale: 'es-ES' });
		const boot = await createTyrianCoreRuntime(host).boot();
		expect(boot.settings.language).toBe('es');
		expect(boot.settingsLoadFailure).toBeNull();
		await boot.diagnosticsReady;

		const legacy = neutralHost({ ...LOGGING, apiKey: 'legacy-value', language: 'en' }, { locale: 'es' });
		await expect(loadTyrianSettings(legacy.host)).resolves.toMatchObject({ language: 'en' });
		expect(legacy.saved).toHaveLength(1);
		expect(legacy.saved[0]).not.toHaveProperty('apiKey');
	});

	it('R1b: loading the settings never writes a mode into data.json; the mode is per device', async () => {
		const previousRelease = { ...DEFAULT_SETTINGS, apiKeySecret: 'gw2-main' };
		const upgraded = neutralHost(previousRelease);
		const settings = await loadTyrianSettings(upgraded.host);
		expect(settings).not.toHaveProperty('collectorMode');
		expect(upgraded.saved).toEqual([]);
	});

	it('DU-04: a data.json from a newer settings schema is used as read but never written back', async () => {
		const newer = neutralHost({ ...LOGGING, schemaVersion: SETTINGS_SCHEMA_VERSION + 1, preferredCharacter: 'Kasmeer', futureOnlyKey: 1 });
		const boot = await createTyrianCoreRuntime(newer.host).boot();
		await boot.diagnosticsReady;

		expect(newer.saved).toEqual([]);
		expect(boot.settingsReadOnly).toBe(true);
		expect(boot.settings).toMatchObject({ preferredCharacter: 'Kasmeer', schemaVersion: SETTINGS_SCHEMA_VERSION });
	});

	it('DU-04: an older or equal settings schema boots as always, writable and migrated when it changed', async () => {
		const older = neutralHost({ ...LOGGING, schemaVersion: SETTINGS_SCHEMA_VERSION - 1 });
		const olderBoot = await createTyrianCoreRuntime(older.host).boot();
		await olderBoot.diagnosticsReady;
		expect(olderBoot.settingsReadOnly).toBe(false);
		expect(older.saved).toEqual([expect.objectContaining({ schemaVersion: SETTINGS_SCHEMA_VERSION })]);

		const same = neutralHost(LOGGING);
		const sameBoot = await createTyrianCoreRuntime(same.host).boot();
		await sameBoot.diagnosticsReady;
		expect(sameBoot.settingsReadOnly).toBe(false);
		expect(sameBoot.settings).toMatchObject({ debugLoggingEnabled: true, debugLoggingLevel: 'debug' });
	});

	it('records a settings load failure, flushes it and rethrows it from start', async () => {
		const failure = new Error('settings unreadable');
		const { host } = neutralHost(LOGGING, { loadFails: failure });
		const runtime = createTyrianCoreRuntime(host);
		const boot = await runtime.boot();
		expect(boot.settingsLoadFailure).toBe(failure);
		// The defaults stand in for what could not be read, exactly as the plugin's boot did.
		expect(boot.settings).toMatchObject({ debugLoggingEnabled: DEFAULT_SETTINGS.debugLoggingEnabled });

		await expect(runtime.start()).rejects.toBe(failure);
		expect(await runtime.boot()).toBe(boot);
	});

	it('stops cleanly when it was never started', async () => {
		const { host } = neutralHost(LOGGING);
		await expect(createTyrianCoreRuntime(host).stop()).resolves.toBeUndefined();
	});
});
