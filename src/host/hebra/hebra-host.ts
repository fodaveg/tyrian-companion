/**
 * `HebraHost`: the `TyrianHost` Tyrian gives its core inside Hebra, written against Hebra's public
 * plugin API (`hebra-plugin-api` v1, SPEC-PLUGINS-EXTERNOS.md §5) and nothing internal to Hebra.
 * It moved here from Hebra's `src/lib/modules/tyrian/` when Tyrian became an external plugin
 * (§2.1: each plugin ships its own adapter, so a change of `TyrianHost` never needs a Hebra build).
 *
 * Everything that depends on the ENVIRONMENT arrives injected (`HebraHostDeps`): the API, the
 * IndexedDB factory and the stores over it, the secrets backend, the window. The same code runs in
 * Hebra and in the tests, each with its doubles. What lives here is the composition and the
 * decisions that were Hebra's:
 *
 * - `canonicalIdentity` = `hebra-library:<libraryId>`, the same on every device of the library, so
 *   the core's IndexedDB records keep their `vaultId`;
 * - the output folder comes from the plugin settings (`outputFolder`, chosen among the real
 *   folders) and is LOOKED UP in the library, never created; when missing the vault is empty
 *   (consultation mode, no notes). It is read on start: choosing another one with the plugin on
 *   RESTARTS it (`api.workspace.restart()`, with the setting already saved) and until then the
 *   vault refuses every write;
 * - the index is seeded ONCE per output folder (empty index and folder present), adopting the notes
 *   already there with `canonicalPathFor`; seeding only reads the library and writes the local
 *   index. What is not adopted stays in a visible list (`unadopted`), reviewed on every start;
 * - managed assets (Obsidian parity): the `.base` files and their manifest are library files under
 *   the output folder (`vault-port.ts` rewrites them atomically). When Bases were imported already
 *   and the settings do not say where, their path is pointed at the output folder
 *   (`withManagedAssetsRoot`) so the core adopts and upgrades them after the next inventory dump;
 * - `priceHistory` uses the core's own IndexedDB databases on THIS device;
 * - `tcpServer` (R4) is Hebra's byte server through `api.tcp`; without it (web, iPhone) it refuses
 *   with `EHEBRA_NO_BRIDGE`. `notify.system` uses Hebra's system notifications when it has them and
 *   the browser `Notification` otherwise;
 * - `environment.onUncaughtError` only lets Tyrian's errors through, not Hebra's.
 */
import type { HebraPluginApi } from 'hebra-plugin-api';

import { browserAlertAudioContextFactory, closeBrowserAlertAudio, playAlertSound } from '../../alerts/alert-sound';
import { hostSystemNotificationConstructor, showSystemNotification } from '../../alerts/alert-system-notification';
import { MANAGED_ASSETS_MANIFEST } from '../../assets/managed-assets-model';
import { localDebugDirectory } from '../../core/local-debug-contract';
import { normalizeVaultFolder } from '../../core/settings';
import { indexedDbPriceHistoryPort } from '../indexed-db-price-history';
import type {
	CanonicalPathFor,
	TyrianDisposer,
	TyrianEnvironmentPort,
	TyrianHost,
	TyrianKvPort,
	TyrianPlatform,
	TyrianVault,
} from '../tyrian-host';
import { libraryFolderPaths, resolveFolderPath } from './folder-path';
import { createHebraTyrianUi } from './hebra-host-ui';
import { createTyrianHttpPort } from './http';
import {
	createLocalFileStorage,
	createTyrianLocalStoragePort,
	createTyrianSettingsPort,
	type LocalFileBackend,
} from './local-storage';
import { TyrianPathIndex } from './path-index';
import type { TyrianPathIndexKv } from './path-index-kv';
import { createPreloadedSecrets, type TyrianSecretsBackend } from './secrets';
import { refreshUnadoptedNotes, seedTyrianPathIndex, type TyrianSeedResult, type TyrianUnadoptedNote } from './seed';
import { createTcpServerPort, unavailableTcpServerPort } from './tcp-port';
import { createHebraTyrianVault, HEBRA_TYRIAN_CONFIG_DIR, relativeToOutputFolder } from './vault';
import { createTyrianVaultPort } from './vault-port';

export const TYRIAN_PLUGIN_ID = 'tyrian-companion';

/** The window events and objects `environment`, `clipboard` and the notification fallback read
 *  (injectable for tests). */
export type HebraHostWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
	readonly navigator: Pick<Navigator, 'clipboard'>;
};

/**
 * Where the adapter's own failures go. Production code here may not print logs of its own (the
 * repository's security scan forbids it), and the core already keeps a diagnostic log: each
 * reported failure reaches the core through `environment.onUncaughtError`, where it is logged as
 * a `global_error` like any other of Tyrian's. Failures reported before the core subscribes (while
 * the host is being built) wait in a short buffer and are delivered when it does.
 */
export interface HostFailureChannel {
	report: (error: unknown, where: string) => void;
	subscribe: (listener: (failure: Error) => void) => TyrianDisposer;
}

export const HOST_FAILURE_BUFFER = 50;

export function createHostFailureChannel(limit = HOST_FAILURE_BUFFER): HostFailureChannel {
	const listeners = new Set<(failure: Error) => void>();
	const pending: Error[] = [];
	return {
		report(error, where) {
			const failure = new Error(`hebra host (${where}): ${error instanceof Error ? error.message : String(error)}`);
			if (error instanceof Error && error.stack) failure.stack = `${failure.message}\n${error.stack}`;
			if (listeners.size === 0) {
				if (pending.length >= limit) pending.shift();
				pending.push(failure);
				return;
			}
			for (const listener of [...listeners]) listener(failure);
		},
		subscribe(listener) {
			listeners.add(listener);
			for (const failure of pending.splice(0)) listener(failure);
			return () => { listeners.delete(listener); };
		},
	};
}

export interface HebraHostDeps {
	api: HebraPluginApi;
	/** The core's `kv`: its own IndexedDB databases, opened with the names they always had. */
	indexedDB: IDBFactory;
	pathIndexKv: TyrianPathIndexKv;
	fileBackend: LocalFileBackend;
	secretsBackend: TyrianSecretsBackend;
	canonicalPathFor: CanonicalPathFor;
	platform: TyrianPlatform;
	window: HebraHostWindow;
	report: (error: unknown, where: string) => void;
	/** The channel `report` feeds, read by `environment.onUncaughtError` (absent: only window errors). */
	failures?: Pick<HostFailureChannel, 'subscribe'>;
	/** The URL this module was loaded from (a `blob:` URL inside Hebra): a stack frame that names it
	 *  is Tyrian's (`isTyrianFailure`). */
	moduleUrl?: string;
	/** Tests only: replaces `OUTPUT_FOLDER_RESTART_FALLBACK_MS`. */
	restartFallbackMs?: number;
}

export interface HebraHostHandle {
	host: TyrianHost;
	/** Tyrian's output folder and its id in the library (null when it does not exist). */
	outputFolder: string;
	rootFolderId: string | null;
	/** The seeding result when it happened now (empty index and folder present). */
	seed: TyrianSeedResult | null;
	/** The Tyrian notes the index left out (of this seeding or an earlier one, minus the resolved
	 *  ones): shown in the plugin's settings (`unadopted-panel.ts`). */
	unadopted: readonly TyrianUnadoptedNote[];
	/** Waits for the pending keychain writes. */
	flush(): Promise<void>;
	/** Drops what this instance left armed (the pending restart, the watch of indexed files, the
	 *  background holds). The plugin's cleanup calls it before stopping the core. */
	dispose(): void;
	/** Closes the IndexedDB connections of the path index and the local files. Last of all: the
	 *  core still writes its diagnostics while it stops, and a later write would open a new one. */
	closeStorage(): void;
}

/** The output folder saved in some Tyrian settings, or the default. With the SAME normalization as
 *  the core (`normalizeVaultFolder`): comparing anything else, a value the core normalizes to the
 *  folder in use would restart the plugin for nothing. */
export function outputFolderFromSettings(settings: unknown): string {
	const value = typeof settings === 'object' && settings !== null
		? (settings as { outputFolder?: unknown }).outputFolder
		: undefined;
	return normalizeVaultFolder(value, HEBRA_TYRIAN_CONFIG_DIR);
}

/**
 * Is there anything of Tyrian's managed assets in the output folder? A manifest that is not
 * `detached` (the user removed them: never adopted again on their own) or, without a manifest,
 * some `.base` in `Bases/` (the copies imported from Obsidian arrive without one). Reads only.
 * A manifest that cannot be read is handed to `onUnreadable` and counts as a footprint.
 */
export async function hasManagedAssetsFootprint(
	vault: Pick<TyrianVault, 'file' | 'read' | 'listFiles'>,
	outputFolder: string,
	onUnreadable?: (error: unknown) => void,
): Promise<boolean> {
	const manifest = vault.file(`${outputFolder}/${MANAGED_ASSETS_MANIFEST}`);
	if (manifest) {
		try {
			const parsed = JSON.parse(await vault.read(manifest)) as { state?: unknown } | null;
			return parsed?.state !== 'detached';
		} catch (error) {
			// Unreadable (in Hebra, a file whose bytes are not on this device reads as a missing
			// blob): it is still Tyrian's; the core shows it as a conflict in its settings.
			onUnreadable?.(error);
			return true;
		}
	}
	const bases = `${outputFolder}/Bases/`;
	return vault.listFiles().some((file) => file.path.startsWith(bases)
		&& !file.path.slice(bases.length).includes('/') && file.path.endsWith('.base'));
}

/**
 * The settings with the managed-assets path pointing at the output folder when it pointed nowhere
 * (`managedAssetsRoot` and `legacyManagedAssetsRoot` unset). In Obsidian the "Install" button left
 * that path long ago; in Hebra the settings start empty even when the Bases arrive imported, and
 * without it the core never adopts nor upgrades them after a dump. Only called with a footprint
 * (`hasManagedAssetsFootprint`); a path already chosen, even another one, is never touched.
 */
export function withManagedAssetsRoot(settings: unknown, outputFolder: string): unknown {
	if (settings !== null && (typeof settings !== 'object' || Array.isArray(settings))) return settings;
	const current = (settings ?? {}) as Record<string, unknown>;
	const unset = (value: unknown): boolean => value === undefined || value === null;
	if (!unset(current.managedAssetsRoot) || !unset(current.legacyManagedAssetsRoot)) return settings;
	return { ...current, managedAssetsRoot: outputFolder };
}

/**
 * Namespace of the path→id index: one per library AND per output folder (its id, which survives a
 * rename). The index paths are RELATIVE to the output folder: shared between folders, a path of a
 * new folder would resolve to a note id of the old one and the core would rewrite it.
 */
export function pathIndexNamespace(libraryId: string, rootFolderId: string | null): string {
	return `${libraryId}/${rootFolderId ?? '-'}`;
}

/** The notice when the plugin restarted because another output folder was chosen. */
export function outputFolderChangedNotice(folder: string): string {
	return `Tyrian Companion se ha reiniciado para usar «${folder}».`;
}

/** The notice when that restart did not bring the plugin back. */
export function outputFolderRestartFailedNotice(folder: string): string {
	return `Tyrian Companion no ha podido reiniciarse con «${folder}». Apágalo y vuelve a encenderlo en los ajustes de Hebra.`;
}

/**
 * How long, AT MOST, to wait for the folder picker to report that the core finished its settings
 * update (`onFolderSettled`) before restarting anyway. It only covers a setting saved some other
 * way: what the core still does after `save` are local awaits (IndexedDB, reconciling Bases).
 */
export const OUTPUT_FOLDER_RESTART_FALLBACK_MS = 3000;

/** Is this failure Tyrian's? By the file or the stack: the module's own URL (a `blob:` URL inside
 *  Hebra) or a frame that names Tyrian (the source files in development). */
export function isTyrianFailure(failure: unknown, filename?: string, moduleUrl?: string): boolean {
	const mentions = (text: unknown): boolean => typeof text === 'string'
		&& (/tyrian/iu.test(text) || (moduleUrl !== undefined && moduleUrl !== '' && text.includes(moduleUrl)));
	if (mentions(filename)) return true;
	if (failure instanceof Error) return mentions(failure.stack);
	return false;
}

/**
 * The platform the core sees (`environment.platform`: Linux notification urgency, diagnostics and
 * the collector fingerprint), from `api.env.platform`: the desktop apps say it; iPhone and iPad
 * give `unknown` (`TyrianPlatform` has no iOS value), and so does the web. The compiled module read
 * the web's OS from the user agent; the plugin does not (the repository's lint forbids detecting the
 * OS that way, and Hebra's API does not say it): on the web the collector does not run anyway.
 */
export function tyrianPlatform(env: Pick<HebraPluginApi['env'], 'platform'>): TyrianPlatform {
	return env.platform === 'macos' || env.platform === 'linux' || env.platform === 'windows' ? env.platform : 'unknown';
}

function createEnvironment(deps: HebraHostDeps): TyrianEnvironmentPort {
	const { api } = deps;
	const win = deps.window;
	return {
		platform: deps.platform,
		// Obsidian records its `apiVersion` here; Hebra's analogue is the plugin API it implements.
		hostVersion: api.apiVersion,
		pluginId: TYRIAN_PLUGIN_ID,
		pluginVersion: api.plugin.version,
		isOnline: () => api.env.online,
		onConnectivityChange: (listener) => api.env.onOnlineChange(listener),
		onUncaughtError(listener) {
			const onError = (event: Event): void => {
				const errorEvent = event as ErrorEvent;
				const failure: unknown = errorEvent.error ?? errorEvent.message ?? event;
				if (isTyrianFailure(failure, errorEvent.filename, deps.moduleUrl)) listener(failure, 'window_error');
			};
			const onRejection = (event: Event): void => {
				const reason: unknown = (event as PromiseRejectionEvent).reason;
				if (isTyrianFailure(reason, undefined, deps.moduleUrl)) listener(reason, 'unhandled_rejection');
			};
			win.addEventListener('error', onError);
			win.addEventListener('unhandledrejection', onRejection);
			// The adapter's own failures: caught by the host, so reported as handled rejections.
			const unsubscribeHost = deps.failures?.subscribe((failure) => listener(failure, 'unhandled_rejection'));
			return () => {
				win.removeEventListener('error', onError);
				win.removeEventListener('unhandledrejection', onRejection);
				unsubscribeHost?.();
			};
		},
	};
}

/**
 * The core's `background.hold(owner)` over `api.background`, which has one hold per plugin: Hebra
 * is held while ANY owner holds it, and released when the last one lets go. Without background in
 * this Hebra (the web), a no-op, as before.
 */
function createBackground(deps: HebraHostDeps): { hold(owner: string): TyrianDisposer; dispose(): void } {
	const { api } = deps;
	const owners = new Map<string, number>();
	let held = 0;
	const release = (): void => {
		api.background.release().catch((error: unknown) => deps.report(error, 'background'));
	};
	return {
		hold(owner) {
			if (!api.has('background')) return () => undefined;
			owners.set(owner, (owners.get(owner) ?? 0) + 1);
			held += 1;
			if (held === 1) api.background.hold().catch((error: unknown) => deps.report(error, 'background'));
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const left = (owners.get(owner) ?? 1) - 1;
				if (left > 0) owners.set(owner, left);
				else owners.delete(owner);
				held -= 1;
				if (held === 0) release();
			};
		},
		dispose() {
			if (held === 0) return;
			owners.clear();
			held = 0;
			release();
		},
	};
}

export async function createHebraHost(deps: HebraHostDeps): Promise<HebraHostHandle> {
	const { api } = deps;
	const libraryId = api.vault.libraryId();
	const libraryRootId = api.vault.rootFolderId();
	const storedSettings = createTyrianSettingsPort(api.storage);
	const outputFolder = outputFolderFromSettings(await storedSettings.load());
	const rootFolderId = resolveFolderPath(await api.vault.foldersList(), libraryRootId, outputFolder);

	// The vault below is bound to THIS start's output folder, but the core adopts a new setting
	// LIVE. Saving another folder, with the setting already persisted, ARMS the plugin restart (the
	// next start resolves the folder, loads its index and reconciles it). When it fires:
	// - normally, when the folder picker's `onSelect` ends (`onFolderSettled`), i.e. when the core
	//   finished ALL of its `updateSettings` (it has several awaits after `save`: the core is
	//   never stopped halfway through an update);
	// - as a fallback, `OUTPUT_FOLDER_RESTART_FALLBACK_MS` later, when the folder was saved some
	//   other way and that signal does not come.
	// Meanwhile `stale()` makes the vault refuse every write.
	let latestFolder = outputFolder;
	let restartArmed = false;
	let restartTimer: number | undefined;
	let disposed = false;
	const stale = (): boolean => latestFolder !== outputFolder;
	const disarmRestart = (): void => {
		restartArmed = false;
		if (restartTimer !== undefined) window.clearTimeout(restartTimer);
		restartTimer = undefined;
	};
	const fireRestart = async (): Promise<void> => {
		const armed = restartArmed;
		disarmRestart();
		// Back to this start's folder in the meantime: nothing to restart.
		if (!armed || disposed || !stale()) return;
		const folder = latestFolder;
		let restarted = false;
		try {
			restarted = await api.workspace.restart();
		} catch (error) {
			deps.report(error, 'restart');
		}
		api.ui.notice(restarted ? outputFolderChangedNotice(folder) : outputFolderRestartFailedNotice(folder));
	};
	const settings: typeof storedSettings = {
		...storedSettings,
		async load() {
			const data = await storedSettings.load();
			return adoptManagedAssetsRoot ? withManagedAssetsRoot(data, outputFolder) : data;
		},
		async save(data) {
			await storedSettings.save(data);
			latestFolder = outputFolderFromSettings(data);
			if (!stale()) {
				disarmRestart();
				return;
			}
			if (restartArmed || disposed) return;
			restartArmed = true;
			restartTimer = window.setTimeout(() => void fireRestart(), deps.restartFallbackMs ?? OUTPUT_FOLDER_RESTART_FALLBACK_MS);
		},
	};

	const index = await TyrianPathIndex.load(
		deps.pathIndexKv,
		pathIndexNamespace(libraryId, rootFolderId),
		(error) => deps.report(error, 'path-index.storage'),
	);
	// Decided after seeding the index (below) and before the core loads its settings.
	let adoptManagedAssetsRoot = false;
	let seed: TyrianSeedResult | null = null;
	let unadopted: readonly TyrianUnadoptedNote[];
	if (rootFolderId && index.size === 0) {
		seed = await seedTyrianPathIndex({
			library: api.vault,
			index,
			rootFolderId,
			root: outputFolder,
			canonicalPathFor: deps.canonicalPathFor,
		});
		unadopted = seed.unadopted;
	} else if (rootFolderId) {
		// A saved index (another start, or back to a folder used before) is reconciled with
		// today's library: there may be Tyrian notes the index does not know (another device, sync
		// while another folder was in use) and entries of notes deleted or trashed; without this,
		// `file(path)` would be null and the core would create duplicates, or write to dead ids.
		const reconciled = await seedTyrianPathIndex({
			library: api.vault,
			index,
			rootFolderId,
			root: outputFolder,
			canonicalPathFor: deps.canonicalPathFor,
			reconcile: true,
		});
		unadopted = reconciled.unadopted;
	} else {
		unadopted = await refreshUnadoptedNotes(api.vault, index);
	}

	const adapter = createLocalFileStorage(deps.fileBackend, libraryId);
	const vaultPort = rootFolderId
		? createTyrianVaultPort({
			library: api.vault,
			index,
			rootFolderId,
			canonicalPathFor: (text) => deps.canonicalPathFor(outputFolder, text),
			onError: (error) => deps.report(error, 'vault.sync'),
		})
		: null;
	const vault = createHebraTyrianVault({
		port: vaultPort,
		index,
		outputFolder,
		libraryId,
		adapter,
		writeBlockedReason: () => (stale()
			? `the saved output folder is «${latestFolder}» and this vault is still on «${outputFolder}»; the plugin restarts`
			: null),
		onReject: (error) => deps.report(error, 'vault.refusal'),
	});
	adoptManagedAssetsRoot = await hasManagedAssetsFootprint(vault, outputFolder, (error) => deps.report(error, 'vault.file'));
	// An indexed file (a Base, the manifest) someone trashes or purges in Hebra (Files, another
	// device through sync) leaves the index: otherwise `file(path)` would keep returning it and the
	// core would fail reading it instead of creating it again. Notes are followed by `onChange`.
	const unwatchIndexedFiles = rootFolderId
		? api.vault.onChange((event) => {
			if (event.kind !== 'library-changed') return;
			for (const id of event.ids) {
				if (index.getKindForId(id) !== 'file') continue;
				api.vault.fileRead(id)
					.then((row) => (row && row.trashedAt === null ? undefined : index.deleteById(id)))
					.catch((error: unknown) => deps.report(error, 'vault.file'));
			}
		})
		: () => undefined;
	const secrets = await createPreloadedSecrets(deps.secretsBackend, (error) => deps.report(error, 'keychain.write'));
	const kv: TyrianKvPort = { indexedDB: deps.indexedDB };
	const background = createBackground(deps);
	const win = deps.window;

	const host: TyrianHost = {
		// Managed assets as in Obsidian: the Bases and their manifest are library files under the
		// output folder; the settings show the section and the core adopts and upgrades them.
		capabilities: { managedAssets: true, supportPackageAsNote: true },
		vault,
		http: createTyrianHttpPort(api),
		secrets,
		settings,
		localStorage: createTyrianLocalStoragePort(api.storage),
		kv,
		priceHistory: indexedDbPriceHistoryPort(kv),
		tcpServer: api.has('tcp')
			? createTcpServerPort(api.tcp, deps.report)
			: unavailableTcpServerPort('the TCP bridge only exists in the desktop app (macOS, Linux, Windows)'),
		notify: {
			system: (input) => (api.has('notify.system')
				? api.notify.system({ title: input.title, body: input.body })
				: showSystemNotification(hostSystemNotificationConstructor(win), {
					...input,
					platform: deps.platform === 'linux' ? 'linux' : 'other',
				})),
			sound: () => playAlertSound(browserAlertAudioContextFactory(win)),
		},
		clipboard: {
			writeText: async (text) => {
				await win.navigator.clipboard.writeText(text);
			},
		},
		// No file system of its own (`basePath()` is null): there is no folder to open.
		shell: { openPath: async () => false },
		ui: createHebraTyrianUi({
			api,
			secrets,
			folderPaths: async () => libraryFolderPaths(await api.vault.foldersList(), libraryRootId),
			openNote: (path) => {
				const relative = relativeToOutputFolder(outputFolder, path);
				const id = relative === null ? undefined : index.getIdForPath(relative);
				if (id !== undefined && index.getKindForId(id) === 'note') api.workspace.openNote(id);
				else api.ui.notice(`No encuentro «${path}» en la biblioteca.`);
			},
			report: deps.report,
			savedFolder: () => outputFolderFromSettings(settings.latest()),
			onFolderSettled: () => {
				// A separate task: let the picker finish painting what was saved before restarting.
				if (restartArmed) window.setTimeout(() => void fireRestart(), 0);
			},
		}),
		locale: () => api.env.locale(),
		diagnostics: { storage: adapter, directory: localDebugDirectory(HEBRA_TYRIAN_CONFIG_DIR) },
		background: { hold: (owner) => background.hold(owner) },
		environment: createEnvironment(deps),
	};

	return {
		host,
		outputFolder,
		rootFolderId,
		seed,
		unadopted,
		flush: () => secrets.flush(),
		dispose: () => {
			disposed = true;
			try {
				disarmRestart();
				unwatchIndexedFiles();
				vaultPort?.dispose();
				background.dispose();
			} finally {
				// Last, but not skipped when an earlier dispose throws: a live AudioContext outlives a reload.
				closeBrowserAlertAudio(win);
			}
		},
		closeStorage: () => {
			deps.pathIndexKv.close?.();
			deps.fileBackend.close?.();
		},
	};
}
