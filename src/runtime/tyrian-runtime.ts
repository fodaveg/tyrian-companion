/**
 * The first step of Tyrian's boot (R1a, SPEC-TYRIAN-EN-HEBRA.md): the part with no UI in it.
 *
 * `createTyrianCoreRuntime(host).boot()` loads and migrates the settings through `host.settings`
 * and `host.locale()`, and brings up the local diagnostics log over `host.diagnostics`; `start()`
 * waits for that log and rethrows a settings load failure, `stop()` drains it.
 *
 * Since R1c the whole runtime is `createTyrianRuntime` (`tyrian-companion-core.ts`): its `onload`
 * boots through this object first, in the same order as before R1a, then registers the views and
 * commands and composes every service. This module stays apart so the boot can be tested and read
 * on its own.
 */

import type { TyrianHost, TyrianRuntime } from '../host/tyrian-host';
import type { BootTrace } from '../core/boot-trace';
import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { LocalDebugLogger } from '../core/local-debug-logger';
import { LocalDebugJsonlWriter } from '../core/local-debug-writer';
import { isNewerSettingsSchema, migrateSettings, shouldPersistSettingsOnLoad, type TyrianSettings } from '../core/settings';

/** What the boot read from the settings port, and whether it may ever write them back. */
export interface LoadedTyrianSettings {
	readonly settings: TyrianSettings;
	/** DU-04: the stored settings come from a newer settings schema; nothing writes them in this run. */
	readonly readOnly: boolean;
}

/**
 * The one production path that reads `data.json`: through the host's settings port, migrated to
 * the current schema (`hostLocale` answers only a missing language), and written back once when
 * the migration changed something `shouldPersistSettingsOnLoad` cares about (a dropped legacy
 * credential, a new schema). A file from a newer settings schema (DU-04) is migrated into memory
 * but never written back, and the answer says so. Rejects when the host cannot read or write the settings.
 */
export async function loadTyrianSettingsState(host: TyrianHost): Promise<LoadedTyrianSettings> {
	const persisted = await host.settings.load();
	const settings = migrateSettings(persisted, host.vault.configDir, host.locale());
	const readOnly = isNewerSettingsSchema(persisted);
	if (!readOnly && shouldPersistSettingsOnLoad(persisted, settings)) await host.settings.save(settings);
	return { settings, readOnly };
}

/** `loadTyrianSettingsState` without the read-only answer, for callers that only need the settings. */
export async function loadTyrianSettings(host: TyrianHost): Promise<TyrianSettings> {
	return (await loadTyrianSettingsState(host)).settings;
}

/** What the boot leaves ready before the diagnostics log has finished initializing. */
export interface TyrianBoot {
	/** The loaded settings, or the defaults when loading failed. */
	readonly settings: TyrianSettings;
	/** Why loading the settings failed; null when they loaded. */
	readonly settingsLoadFailure: unknown;
	/** DU-04: the stored settings come from a newer settings schema, so this run never writes them. */
	readonly settingsReadOnly: boolean;
	readonly localDebug: LocalDebugLogger;
	readonly localDebugActions: LocalDebugActionRunner;
	/**
	 * `debug_initialize`, then the `settings_load` success record when the settings loaded. It is
	 * left in flight on purpose: the core registers its views and commands while it runs.
	 */
	readonly diagnosticsReady: Promise<void>;
}

/** `TyrianRuntime` plus the two-step boot the core (`tyrian-companion-core.ts`) needs to keep its registration order. */
export interface TyrianCoreRuntime extends TyrianRuntime {
	/**
	 * Loads the settings and builds the diagnostics log, resolving as soon as both exist. Runs
	 * once; later calls return the same boot. `start()` calls it when nobody did.
	 */
	boot(): Promise<TyrianBoot>;
}

export function createTyrianCoreRuntime(host: TyrianHost, trace?: BootTrace): TyrianCoreRuntime {
	let booted: Promise<TyrianBoot> | null = null;
	const boot = (): Promise<TyrianBoot> => {
		booted ??= bootTyrian(host, trace ?? host.bootTrace);
		return booted;
	};
	return {
		boot,
		start: async () => {
			const { settingsLoadFailure, localDebug, localDebugActions, diagnosticsReady } = await boot();
			await diagnosticsReady;
			if (settingsLoadFailure === null) return;
			localDebugActions.event({
				component: 'settings', action: 'settings_load', level: 'error', phase: 'failure', code: 'storage_failure',
				message: settingsLoadFailure,
			});
			await localDebug.flush();
			throw settingsLoadFailure instanceof Error ? settingsLoadFailure : new Error('Settings load failed.');
		},
		stop: async () => {
			if (booted === null) return;
			const { localDebug, localDebugActions } = await booted;
			await flushTyrianLocalDebug(localDebug, localDebugActions);
		},
	};
}

async function bootTyrian(host: TyrianHost, trace: BootTrace | undefined): Promise<TyrianBoot> {
	let settings: TyrianSettings;
	let settingsReadOnly = false;
	let settingsLoadFailure: unknown = null;
	try {
		({ settings, readOnly: settingsReadOnly } = await loadTyrianSettingsState(host));
	} catch (error) {
		settings = migrateSettings(null, host.vault.configDir, host.locale());
		settingsLoadFailure = error;
	}
	const localDebug = new LocalDebugLogger({
		enabled: settings.debugLoggingEnabled,
		minimumLevel: settings.debugLoggingLevel,
		pluginVersion: host.environment.pluginVersion,
		// H14.21: a desktop-only value (mobile's adapter has no filesystem base path), read
		// lazily so it always reflects the vault actually open, not one cached at construction.
		vaultBasePath: () => host.vault.basePath(),
		writer: new LocalDebugJsonlWriter({
			storage: host.diagnostics.storage,
			directory: host.diagnostics.directory,
		}),
	});
	const localDebugActions = new LocalDebugActionRunner({ diagnostics: localDebug });
	const diagnosticsReady = initializeLocalDebug(localDebug, localDebugActions, settings, settingsLoadFailure === null, trace);
	return { settings, settingsLoadFailure, settingsReadOnly, localDebug, localDebugActions, diagnosticsReady };
}

async function initializeLocalDebug(
	localDebug: LocalDebugLogger,
	localDebugActions: LocalDebugActionRunner,
	settings: TyrianSettings,
	settingsLoaded: boolean,
	trace: BootTrace | undefined,
): Promise<void> {
	await localDebugActions.run(
		{ component: 'local_debug', action: 'debug_initialize' },
		async () => await localDebug.initialize(),
	);
	trace?.mark('diagnostics');
	if (settingsLoaded) localDebugActions.event({
		component: 'settings', action: 'settings_load', level: 'info', phase: 'success', code: 'ok',
		details: { schemaVersion: settings.schemaVersion },
	});
}

/**
 * Records the `debug_flush` terminal and then drains it, so the flush's own record reaches the
 * file too. The core's shutdown and `stop()` end the same way.
 */
export async function flushTyrianLocalDebug(
	localDebug: LocalDebugLogger | null,
	localDebugActions: LocalDebugActionRunner | null,
): Promise<void> {
	if (localDebug && localDebugActions) {
		await localDebugActions.run(
			{ component: 'local_debug', action: 'debug_flush' }, async () => { await localDebug.flush(); },
		);
		// The runner's terminal record is queued after its callback resolves.
		await localDebug.flush();
	} else if (localDebug) {
		await localDebug.flush();
	}
}
