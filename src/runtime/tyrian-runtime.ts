/**
 * `createTyrianRuntime(host)`: the host-neutral runtime Hebra embeds (R1a, SPEC-TYRIAN-EN-HEBRA.md).
 *
 * R1a scope. `start()` runs the part of the plugin's boot that has no UI and no Obsidian in it:
 * it loads and migrates the settings through `host.settings` and `host.locale()`, and brings up
 * the local diagnostics log over `host.diagnostics`. `stop()` drains that log. `main.ts` boots
 * through this same object (`createTyrianCoreRuntime`), in the same order as before R1a, so what
 * Hebra runs here is exactly what Obsidian runs.
 *
 * The account, session, inventory, price-history, Halloween and alert services are NOT started
 * here yet: they are composed by `TyrianCompanionPlugin.initializeRuntime` and driven by ~150
 * plugin methods that the views call directly (`plugin.getSessionState()`, modals, notices,
 * repaints). They move behind this function together with the views they feed (R1c).
 */

import { installDomHelpers } from '../host/dom-polyfill';
import type { CreateTyrianRuntime, TyrianHost, TyrianRuntime } from '../host/tyrian-host';
import { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { LocalDebugLogger } from '../core/local-debug-logger';
import { LocalDebugJsonlWriter } from '../core/local-debug-writer';
import { migrateSettings, shouldPersistSettingsOnLoad, type TyrianSettings } from '../core/settings';

/**
 * The one production path that reads `data.json`: through the host's settings port, migrated to
 * the current schema (`hostLocale` answers only a missing language), and written back once when
 * the migration changed something `shouldPersistSettingsOnLoad` cares about (a dropped legacy
 * credential, a new schema). Rejects when the host cannot read or write the settings.
 */
export async function loadTyrianSettings(host: TyrianHost): Promise<TyrianSettings> {
	const persisted = await host.settings.load();
	const settings = migrateSettings(persisted, host.vault.configDir, host.locale());
	if (shouldPersistSettingsOnLoad(persisted, settings)) await host.settings.save(settings);
	return settings;
}

/** What the boot leaves ready before the diagnostics log has finished initializing. */
export interface TyrianBoot {
	/** The loaded settings, or the defaults when loading failed. */
	readonly settings: TyrianSettings;
	/** Why loading the settings failed; null when they loaded. */
	readonly settingsLoadFailure: unknown;
	readonly localDebug: LocalDebugLogger;
	readonly localDebugActions: LocalDebugActionRunner;
	/**
	 * `debug_initialize`, then the `settings_load` success record when the settings loaded. It is
	 * left in flight on purpose: `main.ts` registers its views and commands while it runs.
	 */
	readonly diagnosticsReady: Promise<void>;
}

/** `TyrianRuntime` plus the two-step boot `main.ts` needs to keep its registration order. */
export interface TyrianCoreRuntime extends TyrianRuntime {
	/**
	 * Loads the settings and builds the diagnostics log, resolving as soon as both exist. Runs
	 * once; later calls return the same boot. `start()` calls it when nobody did.
	 */
	boot(): Promise<TyrianBoot>;
}

export function createTyrianCoreRuntime(host: TyrianHost): TyrianCoreRuntime {
	let booted: Promise<TyrianBoot> | null = null;
	const boot = (): Promise<TyrianBoot> => {
		booted ??= bootTyrian(host);
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

/**
 * The host-neutral runtime for an embedding host (Hebra). See the module comment for its R1a scope.
 * R1c: it first adds Obsidian's DOM helpers the UI builds with to a webview that lacks them
 * (`installDomHelpers`, a no-op where they exist); `main.ts` does not come through here.
 */
export const createTyrianRuntime: CreateTyrianRuntime = (host) => {
	installDomHelpers();
	return createTyrianCoreRuntime(host);
};

async function bootTyrian(host: TyrianHost): Promise<TyrianBoot> {
	let settings: TyrianSettings;
	let settingsLoadFailure: unknown = null;
	try {
		settings = await loadTyrianSettings(host);
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
	const diagnosticsReady = initializeLocalDebug(localDebug, localDebugActions, settings, settingsLoadFailure === null);
	return { settings, settingsLoadFailure, localDebug, localDebugActions, diagnosticsReady };
}

async function initializeLocalDebug(
	localDebug: LocalDebugLogger,
	localDebugActions: LocalDebugActionRunner,
	settings: TyrianSettings,
	settingsLoaded: boolean,
): Promise<void> {
	await localDebugActions.run(
		{ component: 'local_debug', action: 'debug_initialize' },
		async () => await localDebug.initialize(),
	);
	if (settingsLoaded) localDebugActions.event({
		component: 'settings', action: 'settings_load', level: 'info', phase: 'success', code: 'ok',
		details: { schemaVersion: settings.schemaVersion },
	});
}

/**
 * Records the `debug_flush` terminal and then drains it, so the flush's own record reaches the
 * file too. `main.ts`'s shutdown and `stop()` end the same way.
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
