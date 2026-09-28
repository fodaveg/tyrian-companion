import { apiVersion, getLanguage, Platform, type App, type Plugin } from 'obsidian';
// @ts-expect-error Electron is provided by Obsidian desktop and externalized by the bundle.
import { shell } from 'electron';

import { browserAlertAudioContextFactory, playAlertSound } from '../../alerts/alert-sound';
import {
	hostSystemNotificationConstructor,
	showSystemNotification,
} from '../../alerts/alert-system-notification';
import { localDebugDirectory } from '../../core/local-debug-contract';
import { indexedDbPriceHistoryPort } from '../indexed-db-price-history';
import type { TyrianEnvironmentPort, TyrianHost, TyrianKvPort, TyrianPlatform } from '../tyrian-host';
import { createObsidianHttpPort } from './obsidian-http';
import { createNodeTcpServerPort } from './obsidian-tcp-server';
import { createObsidianUi } from './obsidian-ui';
import { createObsidianVault } from './obsidian-vault';

/**
 * `ObsidianHost`: the `TyrianHost` Obsidian gives the plugin. With `obsidian-http.ts`,
 * `obsidian-tcp-server.ts`, `obsidian-ui.ts` and `obsidian-vault.ts` it is the only part of the
 * core allowed to import `obsidian`, `electron` or `net` (`src/test/host-boundary.test.ts`).
 *
 * It is thin on purpose: each member is the one Obsidian, Electron or DOM call `main.ts` made
 * directly before R1a, moved here unchanged. Everything reads `plugin.app`, `plugin.manifest`,
 * `window` and `navigator` when it is called, not when the host is built, so it answers for the
 * vault and window actually open.
 */
export function createObsidianHost(plugin: Plugin): TyrianHost {
	const vault = createObsidianVault(plugin);
	const kv: TyrianKvPort = { get indexedDB() { return window.indexedDB; } };
	return {
		vault,
		http: createObsidianHttpPort(),
		// Synchronous, like `SecretStorage` itself: settings hold only the entry NAME.
		secrets: {
			list: () => plugin.app.secretStorage.listSecrets(),
			get: (id) => plugin.app.secretStorage.getSecret(id),
			set: (id, value) => { plugin.app.secretStorage.setSecret(id, value); },
		},
		settings: {
			load: async () => await plugin.loadData() as unknown,
			save: async (data) => { await plugin.saveData(data); },
		},
		// Per-vault, per-device, never synced. An app without the API keeps nothing: load answers
		// null and save does nothing, which is what the core did itself before R1c.
		localStorage: {
			load: (key) => {
				const app = plugin.app as Partial<Pick<App, 'loadLocalStorage'>>;
				return typeof app.loadLocalStorage === 'function' ? app.loadLocalStorage.call(plugin.app, key) as unknown : null;
			},
			save: (key, value) => {
				const app = plugin.app as Partial<Pick<App, 'saveLocalStorage'>>;
				if (typeof app.saveLocalStorage === 'function') app.saveLocalStorage.call(plugin.app, key, value);
			},
		},
		kv,
		priceHistory: indexedDbPriceHistoryPort(kv),
		tcpServer: createNodeTcpServerPort(),
		notify: {
			// Optional chaining for the same reason `obsidianPlatform` uses it: an embedding host
			// without `Platform` must degrade, not throw.
			system: (input) => showSystemNotification(hostSystemNotificationConstructor(window), {
				...input, platform: Platform?.isLinux ? 'linux' : 'other',
			}),
			sound: () => playAlertSound(browserAlertAudioContextFactory(window)),
		},
		clipboard: { writeText: async (text) => { await navigator.clipboard.writeText(text); } },
		shell: {
			openPath: async (absolutePath) => {
				const desktopShell = shell as unknown as { openPath(path: string): Promise<string> };
				return (await desktopShell.openPath(absolutePath)) === '';
			},
		},
		ui: createObsidianUi(plugin),
		locale: () => getLanguage(),
		diagnostics: {
			storage: vault.adapter,
			get directory() { return localDebugDirectory(plugin.app.vault.configDir); },
		},
		// Obsidian's process is never suspended, so there is nothing to hold.
		background: { hold: () => () => undefined },
		environment: obsidianEnvironment(plugin),
	};
}

function obsidianEnvironment(plugin: Plugin): TyrianEnvironmentPort {
	return {
		get platform() { return obsidianPlatform(); },
		get hostVersion() { return apiVersion; },
		get pluginId() { return plugin.manifest.id; },
		get pluginVersion() { return plugin.manifest.version; },
		isOnline: () => navigator.onLine,
		onConnectivityChange: (listener) => {
			let active = true;
			plugin.registerDomEvent(window, 'online', () => { if (active) listener(true); });
			plugin.registerDomEvent(window, 'offline', () => { if (active) listener(false); });
			return () => { active = false; };
		},
		onUncaughtError: (listener) => {
			let active = true;
			plugin.registerDomEvent(window, 'error', (event) => {
				if (!active) return;
				let failure: unknown = event;
				if (typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent) {
					const errorEvent = event as unknown as { readonly error: unknown; readonly message: string };
					failure = errorEvent.error ?? errorEvent.message;
				}
				listener(failure, 'window_error');
			});
			plugin.registerDomEvent(window, 'unhandledrejection', (event) => {
				if (!active) return;
				let failure: unknown = event;
				if (typeof PromiseRejectionEvent !== 'undefined' && event instanceof PromiseRejectionEvent) {
					failure = (event as unknown as { readonly reason: unknown }).reason;
				}
				listener(failure, 'unhandled_rejection');
			});
			return () => { active = false; };
		},
	};
}

/** Keeps export metadata intentionally coarse and stable across host versions. */
function obsidianPlatform(): TyrianPlatform {
	if (Platform?.isLinux) return 'linux';
	if (Platform?.isMacOS) return 'macos';
	if (Platform?.isWin) return 'windows';
	return 'unknown';
}
