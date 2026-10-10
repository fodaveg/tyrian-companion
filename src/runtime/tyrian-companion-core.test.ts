import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBootTrace } from '../core/boot-trace';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LocalDebugStoragePort } from '../core/local-debug-writer';
import { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '../core/settings';
import { IndexedDbInventoryPreferencesStore } from '../advisor/inventory-preferences-store';
import { sha256Text } from '../assets/managed-asset-hash';
import { indexedDbPriceHistoryPort } from '../host/indexed-db-price-history';
import type {
	TyrianCommandRegistration,
	TyrianHost,
	TyrianKvPort,
	TyrianMenuEntry,
	TyrianPanelRegistration,
	TyrianRibbonRegistration,
	TyrianSectionsViewRegistration,
	TyrianUiPort,
	TyrianVault,
	TyrianVaultFile,
	TyrianViewRegistration,
	TyrianViewSectionPatch,
} from '../host/tyrian-host';
import { PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE } from '../inventory/price-history-note-block';
import { COMPANION_VIEW_TYPE } from '../ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from '../ui/inventory-advisor-item-view';
import { PRODUCT_ACTION_IDS } from '../ui/product-action-controller';
import { SALE_VIEW_TYPE } from '../ui/sale-item-view';
import { ACHIEVEMENTS_VIEW_TYPE } from '../ui/achievements-item-view';
import { createTyrianRuntime } from './index';
import {
	ALERT_INGAME_SECRET_COMMAND_ID,
	CORE_MODULE_EVALUATED_MS,
	EXPORT_LEGACY_SESSION_COMMAND_ID,
	EXPORT_LIVE_SESSION_COMMAND_ID,
	TYRIAN_MAIN_VIEW_TYPE,
	UPDATE_LEYSPRING_ACHIEVEMENTS_COMMAND_ID,
} from './tyrian-companion-core';
import { VIEW_PLACEMENT_KEY } from './view-placement';

/**
 * R1c: the whole of Tyrian booted through `createTyrianRuntime(host).start()` over a host with no
 * Obsidian behind it at all, the way Hebra embeds it: an in-memory library, `fake-indexeddb` for
 * `kv`, and a UI port that only records what the core registers. Nothing here imports the plugin.
 */
function neutralHost(originStorage?: TyrianKvPort['storage']) {
	const notes = new Map<string, string>();
	const folders = new Set<string>();
	const logs = new Map<string, string>();
	const storage: LocalDebugStoragePort = {
		exists: async (path) => logs.has(path) || [...logs.keys()].some((file) => file.startsWith(`${path}/`)),
		read: async (path) => logs.get(path) ?? '',
		write: async (path, data) => { logs.set(path, data); },
		append: async (path, data) => { logs.set(path, `${logs.get(path) ?? ''}${data}`); },
		mkdir: async () => undefined,
		remove: async (path) => { logs.delete(path); },
		rename: async (path, destination) => { logs.set(destination, logs.get(path) ?? ''); logs.delete(path); },
	};
	const entry = (path: string): TyrianVaultFile | null => notes.has(path) ? { path, mtime: 1 } : folders.has(path) ? { path } : null;
	const vault: TyrianVault = {
		markdownFiles: () => [...notes.keys()].filter((path) => path.endsWith('.md')).map((path) => ({ path, mtime: 1 })),
		listFiles: () => [...notes.keys()].map((path) => ({ path, mtime: 1 })),
		exists: (path) => entry(path) !== null,
		file: entry,
		read: async (file) => notes.get(file.path) ?? '',
		process: async (file, update) => {
			const next = update(notes.get(file.path) ?? '');
			notes.set(file.path, next);
			return next;
		},
		createFolder: async (path) => { folders.add(path); },
		create: async (path, content) => { notes.set(path, content); return { path, mtime: 1 }; },
		trashFile: async (file) => { notes.delete(file.path); },
		trashIfUnchanged: async (file, expectedContent) => {
			if (notes.get(file.path) !== expectedContent) return { status: 'conflict' };
			notes.delete(file.path);
			return { status: 'trashed', guarantee: 'atomic' };
		},
		onChange: () => () => undefined,
		configDir: 'host-config',
		canonicalIdentity: () => 'hebra-library:test',
		basePath: () => null,
		fullPath: () => null,
		adapter: storage,
	};
	const registered = {
		views: [] as TyrianViewRegistration[],
		commands: [] as TyrianCommandRegistration[],
		ribbons: [] as Array<TyrianRibbonRegistration & { titles: string[] }>,
		codeBlocks: [] as string[],
		panels: [] as TyrianPanelRegistration[],
		ready: [] as Array<() => void>,
		menus: [] as TyrianMenuEntry[][],
		notices: [] as string[],
	};
	const ui: TyrianUiPort = {
		registerView: (view) => { registered.views.push(view); return () => undefined; },
		revealView: vi.fn(async () => undefined),
		registerCommand: (command) => { registered.commands.push(command); return () => undefined; },
		ribbon: (ribbon) => {
			const recorded = { ...ribbon, titles: [] as string[] };
			registered.ribbons.push(recorded);
			return { setTitle: (title) => { recorded.titles.push(title); }, setPending: () => undefined };
		},
		registerCodeBlock: (language) => { registered.codeBlocks.push(language); return () => undefined; },
		settingsPanel: (panel) => { registered.panels.push(panel); return () => undefined; },
		openSettings: vi.fn(),
		onReady: (callback) => { registered.ready.push(callback); },
		onVisibilityChange: () => () => undefined,
		openNote: vi.fn(),
		openModal: vi.fn(() => ({ close: () => undefined })),
		setIcon: vi.fn(),
		setTooltip: vi.fn(),
		openMenu: (entries) => { registered.menus.push([...entries]); },
		notice: (message) => { registered.notices.push(message); },
		pickFolder: () => () => undefined,
		setting: vi.fn(),
		secretPicker: () => () => undefined,
		openExternal: vi.fn(),
	};
	const kv: TyrianKvPort = { indexedDB: new IDBFactory(), ...(originStorage === undefined ? {} : { storage: originStorage }) };
	const request = vi.fn(async () => { throw new Error('No request is expected without an API key.'); });
	const host: TyrianHost = {
		vault,
		http: { request },
		secrets: { list: () => [], get: () => null, set: () => undefined },
		settings: {
			load: async () => ({
				...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: true, debugLoggingLevel: 'debug',
			}),
			save: async () => undefined,
		},
		kv,
		priceHistory: indexedDbPriceHistoryPort(kv),
		tcpServer: { listen: async () => { throw new Error('No bridge is expected with it off.'); } },
		notify: { system: vi.fn() as never, sound: vi.fn() as never },
		clipboard: { writeText: async () => undefined },
		shell: { openPath: async () => false },
		ui,
		locale: () => 'en',
		diagnostics: { storage, directory: 'host-config/plugins/tyrian-companion/logs' },
		background: { hold: () => () => undefined },
		environment: {
			platform: 'linux', hostVersion: 'hebra-test', pluginId: 'tyrian-companion', pluginVersion: '9.9.9',
			isOnline: () => true, onConnectivityChange: () => () => undefined, onUncaughtError: () => () => undefined,
		},
	};
	const records = (): Array<Record<string, unknown>> => [...logs.values()].join('')
		.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
	return { host, registered, request, records };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('createTyrianRuntime (R1c): the whole core over a neutral host', () => {
	it('registers every view, command, the ribbon, the code block and the settings panel through host.ui, and defers the boot', async () => {
		const { host, registered, request } = neutralHost();
		const runtime = createTyrianRuntime(host);

		await runtime.start();

		expect(registered.views.map(({ type, placement }) => [type, placement])).toEqual([
			[COMPANION_VIEW_TYPE, 'column'], [INVENTORY_ADVISOR_VIEW_TYPE, 'dialog'], [SALE_VIEW_TYPE, 'dialog'], [ACHIEVEMENTS_VIEW_TYPE, 'dialog'],
		]);
		expect(registered.commands.map(({ id }) => id)).toEqual([
			...PRODUCT_ACTION_IDS, ALERT_INGAME_SECRET_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID, EXPORT_LEGACY_SESSION_COMMAND_ID,
			UPDATE_LEYSPRING_ACHIEVEMENTS_COMMAND_ID,
		]);
		expect(registered.ribbons.map(({ icon }) => icon)).toEqual(['sword']);
		expect(registered.codeBlocks).toEqual([PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE]);
		expect(registered.panels).toHaveLength(1);
		expect(registered.panels[0]?.settingDefinitions?.().length).toBeGreaterThan(0);
		// The account, session and storage services wait for the host to say it is ready.
		expect(registered.ready).toHaveLength(1);
		expect(request).not.toHaveBeenCalled();
	});

	it('offers the two export commands only while there is something to export, and answers with a notice', async () => {
		const { host, registered } = neutralHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		const command = (id: string) => registered.commands.find((candidate) => candidate.id === id)!;
		const live = command(EXPORT_LIVE_SESSION_COMMAND_ID), legacy = command(EXPORT_LEGACY_SESSION_COMMAND_ID);
		expect(live.name).toBe('Export the current session (CSV)');
		expect(legacy.name).toBe('Export the saved old session');
		const core = runtime as unknown as Record<string, unknown>;
		const exportLive = vi.spyOn(runtime, 'exportLiveSession').mockResolvedValue();
		const exportLegacy = vi.spyOn(runtime, 'exportPreservedLegacySession').mockResolvedValue();

		// Nothing to export yet: unavailable, and a press does nothing.
		expect(live.checkCallback?.(true)).toBe(false); expect(legacy.checkCallback?.(true)).toBe(false);
		live.checkCallback?.(false); legacy.checkCallback?.(false);
		expect(exportLive).not.toHaveBeenCalled(); expect(exportLegacy).not.toHaveBeenCalled();

		core.runtimeReady = true;
		core.liveSessions = { getRuntime: () => ({ sessionId: 's' }) };
		core.sessions = { getPreservedLegacyRuntime: () => ({}) };
		expect(live.checkCallback?.(true)).toBe(true); expect(legacy.checkCallback?.(true)).toBe(true);
		expect(exportLive).not.toHaveBeenCalled();
		live.checkCallback?.(false);
		await vi.waitFor(() => expect(registered.notices).toContain('Export saved.'));
		expect(exportLive).toHaveBeenCalledWith('timeline', 'csv');
		exportLegacy.mockRejectedValueOnce(new Error('no'));
		legacy.checkCallback?.(false);
		await vi.waitFor(() => expect(registered.notices).toContain('Could not export. Your data is kept; try again.'));
		expect(exportLegacy).toHaveBeenCalledOnce();
	});

	it('registers "Update Leyspring achievements", waits for the runtime, and answers with the counts of the run', async () => {
		const { host, registered } = neutralHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		const command = registered.commands.find((candidate) => candidate.id === UPDATE_LEYSPRING_ACHIEVEMENTS_COMMAND_ID)!;
		expect(command.name).toBe('Update Leyspring achievements');
		// A manual action with no availability check: it works in consult mode like the inventory and wallet ones.
		expect('checkCallback' in command).toBe(false);

		command.callback?.();
		await vi.waitFor(() => expect(registered.notices).toContain('Tyrian Companion is still starting. Try again in a moment.'));

		const core = runtime as unknown as Record<string, unknown>;
		const run = vi.fn(async () => ({
			status: 'updated' as const, path: 'x.md',
			summary: { done: 22, total: 46, masteryName: 'Mastery', masteryCurrent: 22, masteryMax: 36 },
		}));
		core.runtimeReady = true;
		core.leyspringAchievements = { run };
		command.callback?.();
		await vi.waitFor(() => expect(registered.notices).toContain('Leyspring achievements updated: 22 of 46; mastery 22/36.'));
		expect(run).toHaveBeenCalledWith('Tyrian Companion', 'en');
	});

	it('boots the runtime when the host is ready, opens the ribbon menu through the host, and drains the log on stop', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, request, records } = neutralHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();

		registered.ready[0]!();
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({
				action: 'plugin_load', state: 'runtime_initialize', phase: 'success',
			}));
		}, { timeout: 10_000 });
		registered.ribbons[0]!.onClick({} as MouseEvent);
		await runtime.stop();

		expect(registered.menus).toHaveLength(1);
		expect(registered.menus[0]!.length).toBeGreaterThan(0);
		const actions = records().map((record) => `${String(record.action)}:${String(record.phase)}`);
		expect(actions).toEqual(expect.arrayContaining([
			'settings_load:success', 'plugin_load:success', 'plugin_unload:success', 'debug_flush:success',
		]));
		// No API key on this host: nothing reached the network.
		expect(request).not.toHaveBeenCalled();
	});

	// DU-13 (10 Oct 2026): `persist()` is asked once per load, and an engine that never answers does not hold the start.
	it('asks the host\'s storage manager once not to evict the origin, without waiting for its answer', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const persist = vi.fn(() => new Promise<boolean>(() => undefined));
		const { host, registered, records } = neutralHost({ persist });
		const runtime = createTyrianRuntime(host);
		await runtime.start();

		registered.ready[0]!();
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({
				action: 'plugin_load', state: 'runtime_initialize', phase: 'success',
			}));
		}, { timeout: 10_000 });
		await runtime.stop();

		expect(persist).toHaveBeenCalledTimes(1);
		const asked = records().filter((record) => (record.details as Record<string, unknown> | undefined)?.store === 'origin_storage');
		// Asked, and nothing settled: the start did not wait for it.
		expect(asked.map((record) => [record.component, record.action, record.phase])).toEqual([['plugin', 'plugin_load', 'start']]);
	});

	// The figures reach the local log through its sanitizer, not only the probe's event.
	it('records the answer and the origin\'s estimate in the local log', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const mib = 1024 * 1024;
		const { host, registered, records } = neutralHost({ persist: async () => true, estimate: async () => ({ usage: 12 * mib, quota: 4096 * mib }) });
		const runtime = createTyrianRuntime(host);
		await runtime.start();

		registered.ready[0]!();
		const settled = () => records().filter((record) => (record.details as Record<string, unknown> | undefined)?.store === 'origin_storage' && record.phase !== 'start');
		await vi.waitFor(() => { expect(settled()).toHaveLength(1); }, { timeout: 10_000 });
		await runtime.stop();

		expect(settled()[0]).toMatchObject({ component: 'plugin', action: 'plugin_load', phase: 'success', code: 'ok' });
		// Exactly these: the quota itself (which gives the size of the disk away) never reaches the log.
		expect(settled()[0]!.details).toEqual({
			store: 'origin_storage', operation: 'open', result: 'granted', usageMiB: '12', quotaUsedPercent: '1',
		});
	});

	// DU-13: the copy of the inventory preferences kept in the host's settings (`advisor/inventory-preferences-backup.ts`).
	describe('the copy of the inventory preferences in the host settings (DU-13)', () => {
		const copy = {
			version: 1,
			accounts: [{ accountId: 'account-a', goals: [], keepExceptions: [{ version: 1, exceptionId: 'keep-1', itemId: 7, status: 'active', basis: 'available', quantity: { mode: 'all' }, reason: 'user_keep' }] }],
		};
		const startWith = async (stored: Record<string, unknown>, logged = true) => {
			vi.stubGlobal('window', {
				setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
			});
			const { host, registered, records } = neutralHost();
			const store = { value: stored as unknown, saves: 0 };
			const runtime = createTyrianRuntime({ ...host, settings: {
				load: async () => structuredClone(store.value), save: async (value) => { store.value = structuredClone(value); store.saves += 1; },
			} });
			await runtime.start();
			registered.ready[0]!();
			// Settings from a newer release keep the log off for this run (DU-04), so there is no record to wait for.
			if (logged) {
				await vi.waitFor(() => {
					expect(records()).toContainEqual(expect.objectContaining({ action: 'plugin_load', state: 'runtime_initialize', phase: 'success' }));
				}, { timeout: 10_000 });
			}
			return { host, runtime, store, records };
		};
		const base = { ...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: true, debugLoggingLevel: 'debug' };

		it('restores the copy from the settings into an empty IndexedDB at the start, and logs it once', async () => {
			const { host, runtime, records } = await startWith({ ...base, inventoryPreferencesBackup: copy });
			await vi.waitFor(() => {
				expect(records().filter((record) => record.state === 'backup_restored')).toHaveLength(1);
			}, { timeout: 10_000 });
			await runtime.stop();

			const vaultId = await sha256Text('hebra-library:test');
			const stored = await new IndexedDbInventoryPreferencesStore(host.kv.indexedDB).readVault(vaultId);
			expect(stored).toMatchObject({ status: 'ok', records: [{ vaultId, accountId: 'account-a', generation: 1, goals: [], keepExceptions: [{ exceptionId: 'keep-1', itemId: 7 }] }] });
			expect(records().find((record) => record.state === 'backup_restored')).toMatchObject({
				component: 'advisor', action: 'inventory_preferences_write', phase: 'success', details: { count: 1 },
			});
		});

		it('writes the copy over the settings as they are saved, keeps what another device changed, and skips an identical copy', async () => {
			const { runtime, store } = await startWith({ ...base });
			const saves = store.saves;
			// Another device changed a setting after this one started.
			store.value = { ...(store.value as Record<string, unknown>), valuableLootThresholdCopper: 12_345 };
			const write = (runtime as unknown as { writeInventoryPreferencesBackup(backup: unknown): Promise<string> }).writeInventoryPreferencesBackup.bind(runtime);

			await expect(write(copy)).resolves.toBe('saved');
			expect(store.value).toMatchObject({ inventoryPreferencesBackup: copy, valuableLootThresholdCopper: 12_345 });
			expect(runtime.settings.inventoryPreferencesBackup).toEqual(copy);
			await expect(write(structuredClone(copy))).resolves.toBe('unchanged');
			expect(store.saves).toBe(saves + 1);
			await runtime.stop();
		});

		it('writes nothing over settings from a newer release (DU-04)', async () => {
			const { runtime, store } = await startWith({ ...base, schemaVersion: SETTINGS_SCHEMA_VERSION + 1 }, false);
			const write = (runtime as unknown as { writeInventoryPreferencesBackup(backup: unknown): Promise<string> }).writeInventoryPreferencesBackup.bind(runtime);
			await expect(write(copy)).resolves.toBe('read_only');
			expect(store.saves).toBe(0);
			await runtime.stop();
		});
	});

	it('registers each view with the title and the icon of its section, in the language of the settings', async () => {
		const { host, registered } = neutralHost();
		await createTyrianRuntime(host).start();

		expect(registered.views.map((view) => [view.type, view.title(), view.icon])).toEqual([
			[COMPANION_VIEW_TYPE, 'Tyrian companion', 'sword'],
			[INVENTORY_ADVISOR_VIEW_TYPE, 'Inventory advisor', 'package-search'],
			[SALE_VIEW_TYPE, 'Halloween sale', 'candy'],
			[ACHIEVEMENTS_VIEW_TYPE, 'Achievements', 'circle-check'],
		]);
		// A registration is exactly what `registerView` takes: nothing of the section leaks into it.
		for (const view of registered.views) {
			expect(Object.keys(view).sort()).toEqual(['icon', 'mount', 'placement', 'title', 'type', 'unmount']);
		}
	});
});

describe('the boot_timings line (Z26)', () => {
	/** A host whose boot clock moves 10 ms per reading, after the module evaluated, and whose log is on or off. */
	function timedHost(logging: boolean) {
		const base = neutralHost();
		let now = CORE_MODULE_EVALUATED_MS;
		const trace = createBootTrace(() => (now += 10), 0);
		const host: TyrianHost = {
			...base.host,
			bootTrace: trace,
			settings: {
				load: async () => ({
					...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: logging, debugLoggingLevel: 'debug',
				}),
				save: async () => undefined,
			},
		};
		return { ...base, host };
	}
	afterEach(() => { vi.restoreAllMocks(); });
	const bootLines = (records: () => Array<Record<string, unknown>>) =>
		records().filter((record) => record.action === 'plugin_load' && record.state === 'boot_timings');

	it('writes ONE line with every phase of the start, in order, and numbers only', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, records } = timedHost(true);
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		registered.ready[0]!();
		await vi.waitFor(() => { expect(bootLines(records)).toHaveLength(1); }, { timeout: 10_000 });
		await runtime.stop();

		const lines = bootLines(records);
		expect(lines).toHaveLength(1);
		const bootMs = (lines[0]!.details as { bootMs: Record<string, number> }).bootMs;
		expect(Object.keys(bootMs).sort()).toEqual([
			'diagnostics', 'halloween', 'live', 'mode', 'module', 'onload', 'priceHistory', 'ready', 'registered', 'renderRequested',
			'runtimeStart', 'sessions', 'settings',
		]);
		const values = Object.values(bootMs);
		expect(values.every((value) => Number.isInteger(value) && value >= 0)).toBe(true);
		expect(values).toEqual([...values].sort((left, right) => left - right));
		// The sequence the start walks: runtimeStart..renderRequested are in this order whatever the diagnostics' own timing.
		const order = Object.keys(bootMs);
		for (const [earlier, later] of [['module', 'onload'], ['onload', 'settings'], ['settings', 'registered'], ['registered', 'runtimeStart'],
			['runtimeStart', 'mode'], ['mode', 'sessions'], ['sessions', 'live'], ['live', 'ready'], ['ready', 'priceHistory'],
			['priceHistory', 'halloween'], ['halloween', 'renderRequested']] as const) {
			expect(order.indexOf(earlier), `${earlier} before ${later}`).toBeLessThan(order.indexOf(later));
		}
		expect(lines[0]).toMatchObject({ component: 'plugin', action: 'plugin_load', state: 'boot_timings', phase: 'success' });
	}, 30_000);

	it('writes nothing with the debug log off, and the trace is still spent once', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, records } = timedHost(false);
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		registered.ready[0]!();
		await vi.waitFor(() => { expect(host.bootTrace?.take()).toBeNull(); }, { timeout: 10_000 });
		await runtime.stop();
		expect(records()).toEqual([]);
	}, 30_000);

	it('a start that breaks halfway leaves the line with the phases it reached and the last one named', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, records } = timedHost(true);
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		// The live session store refuses to initialize: the start stops after `sessions`.
		vi.spyOn(LiveSessionLifecycle.prototype, 'initialize').mockRejectedValue(new Error('storage gone'));
		registered.ready[0]!();
		await vi.waitFor(() => { expect(bootLines(records)).toHaveLength(1); }, { timeout: 10_000 });
		const details = bootLines(records)[0]!.details as { bootMs: Record<string, number>; result: string; reason: string };
		expect(details.result).toBe('incomplete');
		expect(details.reason).toBe('sessions');
		expect(Object.keys(details.bootMs)).not.toContain('renderRequested');
		await runtime.stop();
	}, 30_000);
});

describe('the first repaint once the runtime is ready (Z20)', () => {
	it('leaves «starting» before the price history has opened, and repaints again once it has', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const base = neutralHost();
		const port = base.host.priceHistory;
		let releaseOpen!: () => void;
		const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
		const events: string[] = [];
		const host: TyrianHost = {
			...base.host,
			settings: {
				load: async () => ({ ...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, priceHistoryEnabled: true }),
				save: async () => undefined,
			},
			// The price history's IndexedDB stays closed until the test opens it: the history is what the start waits on.
			priceHistory: {
				...port,
				open: async (diagnostics) => {
					events.push('priceHistory:open');
					await openGate;
					const store = await port.open(diagnostics);
					events.push('priceHistory:opened');
					return store;
				},
			},
		};
		const runtime = createTyrianRuntime(host);
		const core = runtime as unknown as { runtimeReady: boolean; flushRenderViews(): void; getHalloweenState(): { status: string } };
		const flush = core.flushRenderViews.bind(core);
		// One entry per real repaint of the Session panel, with what the panel reads at that moment.
		vi.spyOn(core, 'flushRenderViews').mockImplementation(() => {
			events.push(`repaint:${core.runtimeReady ? 'ready' : 'starting'}:halloween=${core.getHalloweenState().status}`);
			flush();
		});
		await runtime.start();
		base.registered.ready[0]!();
		await vi.waitFor(() => { expect(events).toContain('priceHistory:open'); }, { timeout: 10_000 });
		await new Promise((resolve) => { setTimeout(resolve, 0); });

		// The history has not opened, and the panel already repainted as ready, showing Halloween as it will stay.
		expect(events.slice(events.indexOf('priceHistory:open'))).toEqual(['priceHistory:open', 'repaint:ready:halloween=disabled']);

		releaseOpen();
		await vi.waitFor(() => { expect(events).toContain('priceHistory:opened'); }, { timeout: 10_000 });
		// The start's own last repaint still comes once the history is in, and Halloween reads the same as in the early one.
		await vi.waitFor(() => {
			expect(new Set(events.slice(events.indexOf('priceHistory:opened')).filter((event) => event.startsWith('repaint:'))))
				.toEqual(new Set(['repaint:ready:halloween=disabled']));
		}, { timeout: 10_000 });
		await runtime.stop();
	}, 30_000);
});

/** A recording dropdown for a settings row rendered outside a page, as the host's settings search does. */
function recordingDropdown() {
	const state = {
		options: [] as Array<[string, string]>, shown: null as string | null, change: async (_value: string): Promise<void> => undefined,
		/** The lines the row appends under its description, with their class. */
		hints: [] as Array<{ cls?: string; text?: string }>,
	};
	const dropdown = {
		addOption: (value: string, display: string) => { state.options.push([value, display]); return dropdown; },
		setValue: (value: string) => { state.shown = value; return dropdown; },
		setDisabled: () => dropdown,
		onChange: (callback: (value: string) => Promise<void>) => { state.change = callback; return dropdown; },
	};
	const row = {
		descEl: { createDiv: (options: { cls?: string; text?: string }) => { state.hints.push(options); return {}; } },
		addDropdown: (build: (control: typeof dropdown) => unknown) => { build(dropdown); return row; },
	};
	return { state, row };
}

describe('main screen or sidebar: this device\'s choice, behind a host capability', () => {
	const PLACEMENT_ROW = 'Where it is shown';
	const settingNames = (registered: ReturnType<typeof neutralHost>['registered']): string[] =>
		registered.panels[0]!.settingDefinitions!().map(({ name }) => name);
	const ownViews = [
		[COMPANION_VIEW_TYPE, 'column'], [INVENTORY_ADVISOR_VIEW_TYPE, 'dialog'], [SALE_VIEW_TYPE, 'dialog'], [ACHIEVEMENTS_VIEW_TYPE, 'dialog'],
	];

	it.each<[string, TyrianHost['capabilities']]>([
		['says nothing of its capabilities', undefined],
		['declares no capability at all', {}],
		['declares the capabilities Hebra declares today', { managedAssets: true, supportPackageAsNote: true }],
		['declares it has no main view', { mainView: false }],
	])('offers no such choice in Settings on a host that %s', async (_label, capabilities) => {
		const { host, registered } = neutralHost();
		const runtime = createTyrianRuntime(capabilities === undefined ? host : { ...host, capabilities });
		await runtime.start();

		expect(runtime.mainViewSupported()).toBe(false);
		expect(settingNames(registered)).not.toContain(PLACEMENT_ROW);
		// The default still reads as the main screen; nothing acts on it.
		expect(runtime.getViewPlacement()).toBe('main');
		expect(registered.views.map(({ type, placement }) => [type, placement])).toEqual(ownViews);
	});

	it('offers it right after the mode on a host that declares a main view, and keeps the choice in the device storage only', async () => {
		const { host, registered, records } = neutralHost();
		const device = new Map<string, unknown>();
		const saveSettings = vi.fn(async () => undefined);
		const runtime = createTyrianRuntime({
			...host,
			capabilities: { mainView: true },
			localStorage: { load: (key) => device.get(key) ?? null, save: (key, value) => { device.set(key, value); } },
			settings: { load: () => host.settings.load(), save: saveSettings },
		});
		await runtime.start();

		expect(runtime.mainViewSupported()).toBe(true);
		const names = settingNames(registered);
		expect(names.indexOf(PLACEMENT_ROW)).toBe(names.indexOf('This installation\'s mode') + 1);
		const definition = registered.panels[0]!.settingDefinitions!().find(({ name }) => name === PLACEMENT_ROW)!;
		expect(definition.desc).toBe('On the main screen or in the sidebar. Affects this device only.');
		const { state, row } = recordingDropdown();
		definition.render(row as never);
		expect(state.options).toEqual([['main', 'Main screen'], ['sidebar', 'Sidebar']]);
		expect(state.shown).toBe('main');
		// Chosen from the host's Settings, the main screen is not what closing them shows: the row says where it opens.
		expect(state.hints).toEqual([{
			cls: 'tyrian-companion-settings__hint', text: 'On the main screen, open it with "Open companion" in the Tyrian Companion button\'s menu.',
		}]);
		expect(device.size).toBe(0);

		const settingsSavesBefore = saveSettings.mock.calls.length;
		await state.change('sidebar');

		expect([...device.entries()]).toEqual([[VIEW_PLACEMENT_KEY, 'sidebar']]);
		expect(runtime.getViewPlacement()).toBe('sidebar');
		// This device's, like the mode: the synced settings never carry it.
		expect(saveSettings.mock.calls.length).toBe(settingsSavesBefore);
		expect(runtime.settings).not.toHaveProperty('viewPlacement');
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({
				component: 'settings', action: 'settings_save', state: 'view_placement', phase: 'success',
			}));
		});
		// This host declares the main view but has no port to register one: saving the choice is
		// all it does, and the three views stay registered where they were.
		expect(registered.views.map(({ type, placement }) => [type, placement])).toEqual(ownViews);

		await state.change('main');
		expect(device.get(VIEW_PLACEMENT_KEY)).toBe('main');
		expect(runtime.getViewPlacement()).toBe('main');
	});

	it('reads the choice this device stored, and the main screen for a stored value it does not know', async () => {
		const stored = async (value: unknown) => {
			const { host } = neutralHost();
			const runtime = createTyrianRuntime({
				...host,
				capabilities: { mainView: true },
				localStorage: { load: (key) => (key === VIEW_PLACEMENT_KEY ? value : null), save: () => undefined },
			});
			await runtime.start();
			return runtime.getViewPlacement();
		};

		expect(await stored('sidebar')).toBe('sidebar');
		expect(await stored('main')).toBe('main');
		expect(await stored('floating')).toBe('main');
		expect(await stored(null)).toBe('main');
	});
});

describe('the three sections on a host with a main screen', () => {
	/** The neutral host, declaring a main view and recording what the core does with it. */
	function mainScreenHost(options: { load?: (key: string) => unknown; withoutPort?: boolean } = {}) {
		const neutral = neutralHost();
		const device = new Map<string, unknown>();
		const sectionsViews: TyrianSectionsViewRegistration[] = [];
		const disposed: string[] = [];
		const revealed: Array<[string, string]> = [];
		const patched: Array<[string, string, TyrianViewSectionPatch]> = [];
		const revealedViews: string[] = [];
		const host: TyrianHost = {
			...neutral.host,
			capabilities: { mainView: true },
			localStorage: {
				load: options.load ?? ((key) => device.get(key) ?? null),
				save: (key, value) => { device.set(key, value); },
			},
			ui: {
				...neutral.host.ui,
				registerView: (view) => {
					neutral.registered.views.push(view);
					return () => { disposed.push(view.type); };
				},
				revealView: async (type) => { revealedViews.push(type); },
				...(options.withoutPort === true ? {} : {
					registerSectionsView: (view: TyrianSectionsViewRegistration) => {
						sectionsViews.push(view);
						return () => { disposed.push(view.type); };
					},
					revealSection: async (type: string, sectionId: string) => { revealed.push([type, sectionId]); },
					updateSection: (type: string, sectionId: string, patch: TyrianViewSectionPatch) => { patched.push([type, sectionId, patch]); },
				}),
			},
		};
		return { ...neutral, host, device, sectionsViews, disposed, revealed, revealedViews, patched };
	}

	it('registers ONE view that lists Session, Inventory, Sale and Achievements under their short labels, and counts one view in the load journal', async () => {
		const { host, registered, sectionsViews, records } = mainScreenHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();

		expect(registered.views).toEqual([]);
		expect(sectionsViews).toHaveLength(1);
		const view = sectionsViews[0]!;
		expect([view.type, view.title(), view.icon]).toEqual([TYRIAN_MAIN_VIEW_TYPE, 'Tyrian Companion', 'sword']);
		expect(view.sections.map((section) => [section.id, section.title(), section.icon])).toEqual([
			['session', 'Session', 'sword'], ['inventory', 'Inventory', 'package-search'], ['sale', 'Sale', 'candy'], ['achievements', 'Achievements', 'circle-check'],
		]);
		for (const section of view.sections) {
			// Only Achievements carries a badge (the followed count); the others list none.
			expect(Object.keys(section).sort()).toEqual(section.id === 'achievements'
				? ['badge', 'icon', 'id', 'mount', 'setVisible', 'title', 'unmount']
				: ['icon', 'id', 'mount', 'setVisible', 'title', 'unmount']);
		}
		expect(runtime.hostListsSections()).toBe(true);
		await vi.waitFor(() => {
			const loaded = records().find((record) => record.action === 'plugin_load' && record.phase === 'success');
			expect((loaded?.details as { viewCount?: number } | undefined)?.viewCount).toBe(1);
		});
	});

	it('a device storage that throws when the choice is read is the main screen, and the failure reaches the log', async () => {
		const { host, registered, sectionsViews, records } = mainScreenHost({
			load: (key) => {
				if (key === VIEW_PLACEMENT_KEY) throw new Error('The device storage cannot be read.');
				return null;
			},
		});
		const runtime = createTyrianRuntime(host);
		await runtime.start();

		expect(runtime.getViewPlacement()).toBe('main');
		expect(sectionsViews).toHaveLength(1);
		expect(registered.views).toEqual([]);
		// Read once: the default stands for this run instead of asking a broken storage on every paint.
		runtime.getViewPlacement();
		await vi.waitFor(() => {
			expect(records().filter((record) => record.action === 'settings_load' && record.state === 'view_placement')).toEqual([
				expect.objectContaining({ component: 'settings', phase: 'failure', level: 'warn', code: 'storage_failure' }),
			]);
		});
	});

	it('a host that declares the main view but has no way to register it gets the four views', async () => {
		const { host, registered } = mainScreenHost({ withoutPort: true });
		const runtime = createTyrianRuntime(host);
		await runtime.start();

		expect(registered.views.map(({ type }) => type)).toEqual([COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE, ACHIEVEMENTS_VIEW_TYPE]);
		expect(runtime.hostListsSections()).toBe(false);
	});

	it('swaps the one view for the four, and back, when the device changes its choice; the same choice again swaps nothing', async () => {
		const { host, registered, sectionsViews, disposed } = mainScreenHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();

		await runtime.updateViewPlacement('sidebar');
		expect(disposed).toEqual([TYRIAN_MAIN_VIEW_TYPE]);
		expect(registered.views.map(({ type, placement }) => [type, placement])).toEqual([
			[COMPANION_VIEW_TYPE, 'column'], [INVENTORY_ADVISOR_VIEW_TYPE, 'dialog'], [SALE_VIEW_TYPE, 'dialog'], [ACHIEVEMENTS_VIEW_TYPE, 'dialog'],
		]);
		expect(registered.views.map((view) => view.title())).toEqual(['Tyrian companion', 'Inventory advisor', 'Halloween sale', 'Achievements']);
		expect(runtime.hostListsSections()).toBe(false);

		await runtime.updateViewPlacement('sidebar');
		expect(disposed).toHaveLength(1);
		expect(registered.views).toHaveLength(4);

		await runtime.updateViewPlacement('main');
		expect(disposed).toEqual([TYRIAN_MAIN_VIEW_TYPE, COMPANION_VIEW_TYPE, INVENTORY_ADVISOR_VIEW_TYPE, SALE_VIEW_TYPE, ACHIEVEMENTS_VIEW_TYPE]);
		expect(sectionsViews).toHaveLength(2);
		expect(runtime.hostListsSections()).toBe(true);
	});

	it('opens a section of the one view from the commands, and the view of its own once the sidebar is chosen', async () => {
		const { host, registered, revealed, revealedViews } = mainScreenHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		const run = async (id: string): Promise<void> => {
			registered.commands.find((candidate) => candidate.id === id)!.checkCallback?.(false);
			await vi.waitFor(() => expect(revealed.length + revealedViews.length).toBeGreaterThan(0));
		};

		await run('open-inventory-advisor');
		expect(revealed).toEqual([[TYRIAN_MAIN_VIEW_TYPE, 'inventory']]);
		expect(revealedViews).toEqual([]);

		await runtime.updateViewPlacement('sidebar');
		revealed.length = 0;
		await run('open-sale');
		expect(revealed).toEqual([]);
		expect(revealedViews).toEqual([SALE_VIEW_TYPE]);
	});

	it.each([
		['open-companion', 'Open companion', 'session'],
		['open-inventory-advisor', 'Open inventory advisor', 'inventory'],
		['open-sale', 'Open Halloween sale', 'sale'],
		['open-achievements', 'Open achievements', 'achievements'],
	])('has a palette command for each section that enters it on the main screen: %s', async (id, name, section) => {
		const { host, registered, revealed, revealedViews } = mainScreenHost();
		await createTyrianRuntime(host).start();
		const command = registered.commands.find((candidate) => candidate.id === id)!;
		expect(command.name).toBe(name);
		// Available with nothing started: a way into the section in any layout of the host.
		expect(command.checkCallback?.(true)).toBe(true);

		command.checkCallback?.(false);

		await vi.waitFor(() => expect(revealed).toEqual([[TYRIAN_MAIN_VIEW_TYPE, section]]));
		expect(revealedViews).toEqual([]);
	});

	it('relabels the listed sections when the language is changed in Settings, and only then', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, patched, records } = mainScreenHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		// `updateSettings` is refused until the runtime is ready.
		registered.ready[0]!();
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({ action: 'plugin_load', state: 'runtime_initialize', phase: 'success' }));
		}, { timeout: 10_000 });
		expect(runtime.settings.language).toBe('en');

		// A save that leaves the language alone relabels nothing.
		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 20_000 })).resolves.toMatchObject({ status: 'saved' });
		expect(patched).toEqual([]);

		await expect(runtime.updateSettings({ language: 'es' })).resolves.toMatchObject({ status: 'saved' });
		expect(patched).toEqual([
			[TYRIAN_MAIN_VIEW_TYPE, 'session', { title: 'Sesión' }],
			[TYRIAN_MAIN_VIEW_TYPE, 'inventory', { title: 'Inventario' }],
			[TYRIAN_MAIN_VIEW_TYPE, 'sale', { title: 'Venta' }],
			[TYRIAN_MAIN_VIEW_TYPE, 'achievements', { title: 'Logros' }],
		]);
		await runtime.stop();
	});

	it('lists «Logros» with the followed count as its badge (none at zero) and tells the host on every change of the list, and only then', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, sectionsViews, patched, records } = mainScreenHost();
		// A store that keeps what is saved: every save re-reads it first, so a stale one would bring the old list back.
		const store = { value: { ...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: true, debugLoggingLevel: 'debug', trackedAchievementIds: [10, 20] } as unknown };
		const runtime = createTyrianRuntime({ ...host, settings: { load: async () => store.value, save: async (value) => { store.value = value; } } });
		await runtime.start();
		const section = sectionsViews[0]!.sections[3]!;
		expect([section.id, section.title(), section.icon, section.badge?.()]).toEqual(['achievements', 'Achievements', 'circle-check', 2]);

		registered.ready[0]!();
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({ action: 'plugin_load', state: 'runtime_initialize', phase: 'success' }));
		}, { timeout: 10_000 });
		expect(patched).toEqual([]);

		await expect(runtime.updateSettings({ trackedAchievementIds: [10, 20, 30] })).resolves.toMatchObject({ status: 'saved' });
		expect(patched).toEqual([[TYRIAN_MAIN_VIEW_TYPE, 'achievements', { badge: 3 }]]);
		expect(section.badge?.()).toBe(3);
		await runtime.updateSettings({ trackedAchievementIds: [] });
		expect(patched.at(-1)).toEqual([TYRIAN_MAIN_VIEW_TYPE, 'achievements', { badge: null }]);
		// A save that leaves the list alone, or the same list again, says nothing to the host.
		patched.length = 0;
		await runtime.updateSettings({ valuableLootThresholdCopper: 20_000 });
		await runtime.updateSettings({ trackedAchievementIds: [] });
		expect(patched).toEqual([]);
		await runtime.stop();
	});

	it('the «Logros» refresh failure reaches the sanitized local log with its stage: the record is read back from the log, after the sanitizer', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, records } = mainScreenHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		registered.ready[0]!();
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({ action: 'plugin_load', state: 'runtime_initialize', phase: 'success' }));
		}, { timeout: 10_000 });

		runtime.localDebugAchievementsRefreshFailure('reload');
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({
				component: 'ui', action: 'view_render', phase: 'failure', state: 'achievements_refresh',
				details: { surface: 'achievements', operation: 'reload' },
			}));
		}, { timeout: 3_000 });
		await runtime.stop();
	});

	it('toggleTrackedAchievement computes the list inside the serialized write, so two quick follows keep both; a save that throws answers refused', async () => {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, records } = mainScreenHost();
		const store = { value: { ...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: true, debugLoggingLevel: 'debug' } as Record<string, unknown> };
		let hold: Promise<void> | null = null;
		let fail = false;
		const saves: Array<readonly number[]> = [];
		const runtime = createTyrianRuntime({ ...host, settings: {
			load: async () => store.value,
			save: async (value) => {
				if (hold) await hold;
				if (fail) throw new Error('disk full');
				store.value = value as Record<string, unknown>;
				saves.push((value as { trackedAchievementIds: readonly number[] }).trackedAchievementIds);
			},
		} });
		await runtime.start();
		registered.ready[0]!();
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({ action: 'plugin_load', state: 'runtime_initialize', phase: 'success' }));
		}, { timeout: 10_000 });
		saves.length = 0;

		let release: () => void = () => undefined;
		hold = new Promise<void>((resolve) => { release = resolve; });
		const first = runtime.toggleTrackedAchievement(10, true);
		const second = runtime.toggleTrackedAchievement(20, true);
		release();
		expect(await Promise.all([first, second])).toEqual(['saved', 'saved']);
		expect(saves).toEqual([[10], [10, 20]]);
		expect(runtime.settings.trackedAchievementIds).toEqual([10, 20]);
		hold = null;

		expect(await runtime.toggleTrackedAchievement(10, false)).toBe('saved');
		expect(runtime.settings.trackedAchievementIds).toEqual([20]);
		// The same id again is idempotent, and the 101st is refused as the limit.
		expect(await runtime.toggleTrackedAchievement(20, true)).toBe('saved');
		expect(runtime.settings.trackedAchievementIds).toEqual([20]);
		// At the limit, a follow is refused before any write: data.json is not rewritten and no reaction runs.
		const full = Array.from({ length: 100 }, (_, index) => 1000 + index);
		await runtime.updateSettings({ trackedAchievementIds: full });
		saves.length = 0;
		expect(await runtime.toggleTrackedAchievement(7, true)).toBe('limit');
		expect(saves).toEqual([]);
		expect(runtime.settings.trackedAchievementIds).toEqual(full);
		// One already followed is not a new one: it still saves (idempotent), and unfollowing works at the limit.
		expect(await runtime.toggleTrackedAchievement(1000, true)).toBe('saved');
		expect(await runtime.toggleTrackedAchievement(1000, false)).toBe('saved');
		expect(runtime.settings.trackedAchievementIds).toHaveLength(99);

		fail = true;
		await expect(runtime.toggleTrackedAchievement(8, true)).resolves.toBe('refused');
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({ action: 'settings_save', phase: 'failure' }));
		});
		await runtime.stop();
	});

	it('keeps the choice it had, and what it had registered, when the device storage refuses the write', async () => {
		const failure = new Error('The device storage is full.');
		const { host, registered, sectionsViews, disposed } = mainScreenHost();
		const refusing: TyrianHost = {
			...host,
			localStorage: { load: () => null, save: () => { throw failure; } },
		};
		const runtime = createTyrianRuntime(refusing);
		await runtime.start();

		await expect(runtime.updateViewPlacement('sidebar')).rejects.toBe(failure);

		expect(runtime.getViewPlacement()).toBe('main');
		expect(runtime.hostListsSections()).toBe(true);
		expect(disposed).toEqual([]);
		expect(sectionsViews).toHaveLength(1);
		expect(registered.views).toEqual([]);
	});

	it('tells the host the new labels of the listed sections after a language change, and nothing while they are views of their own', async () => {
		const { host, patched } = mainScreenHost();
		const runtime = createTyrianRuntime(host);
		await runtime.start();
		const core = runtime as unknown as { relabelListedSections(): void; settings: { language: string } };

		core.settings = { ...core.settings, language: 'es' };
		core.relabelListedSections();
		expect(patched).toEqual([
			[TYRIAN_MAIN_VIEW_TYPE, 'session', { title: 'Sesión' }],
			[TYRIAN_MAIN_VIEW_TYPE, 'inventory', { title: 'Inventario' }],
			[TYRIAN_MAIN_VIEW_TYPE, 'sale', { title: 'Venta' }],
			[TYRIAN_MAIN_VIEW_TYPE, 'achievements', { title: 'Logros' }],
		]);

		await runtime.updateViewPlacement('sidebar');
		patched.length = 0;
		core.relabelListedSections();
		expect(patched).toEqual([]);
	});
});

describe('saving settings re-reads the store first', { timeout: 20_000 }, () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	/** A host whose settings live in a store the test can change from outside, as another device would. */
	async function readyOverStore(load?: () => Promise<unknown>, initial?: Record<string, unknown>) {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered, records } = neutralHost();
		const store = { value: { ...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: true, debugLoggingLevel: 'debug', ...initial } as Record<string, unknown> | null };
		const patched: string[] = [];
		const saves: Array<Record<string, unknown>> = [];
		const wired: TyrianHost = {
			...host,
			capabilities: { mainView: true },
			ui: {
				...host.ui,
				registerSectionsView: () => () => undefined,
				revealSection: async () => undefined,
				updateSection: (_type: string, sectionId: string) => { patched.push(sectionId); },
			},
			settings: {
				load: load ? () => load() : async () => store.value,
				save: async (value) => { saves.push(value as never); store.value = value as never; },
			},
		};
		const runtime = createTyrianRuntime(wired);
		await runtime.start();
		registered.ready[0]!();
		await vi.waitFor(() => {
			expect(records()).toContainEqual(expect.objectContaining({ action: 'plugin_load', state: 'runtime_initialize', phase: 'success' }));
		}, { timeout: 10_000 });
		const bootSaves = saves.splice(0);
		return { runtime, store, patched, saves, bootSaves, notices: registered.notices };
	}

	it('keeps a key that changed in the store while the plugin was running', async () => {
		const { runtime, store, saves } = await readyOverStore();
		store.value = { ...store.value, preferredCharacter: 'Kasmeer' };

		await runtime.updateSettings({ valuableLootThresholdCopper: 20_000 });

		expect(saves.at(-1)).toMatchObject({ preferredCharacter: 'Kasmeer', valuableLootThresholdCopper: 20_000 });
		expect(runtime.settings).toMatchObject({ preferredCharacter: 'Kasmeer', valuableLootThresholdCopper: 20_000 });
	});

	it('reacts to a key it discovers at save time, by the comparison that already exists', async () => {
		const { runtime, store, patched } = await readyOverStore();
		store.value = { ...store.value, language: 'es' };

		await runtime.updateSettings({ valuableLootThresholdCopper: 20_000 });

		expect(runtime.settings.language).toBe('es');
		expect(patched).toEqual(['session', 'inventory', 'sale', 'achievements']);
	});

	it('falls back to its memory when the store answers something that is not a settings object', async () => {
		const { runtime, store, saves } = await readyOverStore();
		store.value = null;

		await runtime.updateSettings({ valuableLootThresholdCopper: 20_000 });

		expect(saves).toHaveLength(1);
		expect(saves[0]).toMatchObject({ valuableLootThresholdCopper: 20_000, language: 'en' });
	});

	it('writes nothing when the store cannot be read, and the next save still works', async () => {
		let failing = false;
		const failure = new Error('The store is unreadable.');
		const { runtime, saves } = await readyOverStore(async () => {
			if (failing) throw failure;
			return { ...DEFAULT_SETTINGS, schemaVersion: SETTINGS_SCHEMA_VERSION, debugLoggingEnabled: true, debugLoggingLevel: 'debug' };
		});
		failing = true;

		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 20_000 })).rejects.toBe(failure);

		expect(saves).toEqual([]);
		expect(runtime.settings.valuableLootThresholdCopper).toBe(DEFAULT_SETTINGS.valuableLootThresholdCopper);
		failing = false;
		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 30_000 })).resolves.toMatchObject({ status: 'saved' });
		expect(saves).toHaveLength(1);
	});

	it('loses neither of two concurrent updates', async () => {
		const { runtime, saves } = await readyOverStore();

		await Promise.all([
			runtime.updateSettings({ valuableLootThresholdCopper: 20_000 }),
			runtime.updateSettings({ preferredCharacter: 'Kasmeer' }),
		]);

		expect(saves).toHaveLength(2);
		expect(saves.at(-1)).toMatchObject({ valuableLootThresholdCopper: 20_000, preferredCharacter: 'Kasmeer' });
		expect(runtime.settings).toMatchObject({ valuableLootThresholdCopper: 20_000, preferredCharacter: 'Kasmeer' });
	});

	it('does not overwrite a key changed in the store with the inventory sync receipt', async () => {
		const { runtime, store, saves } = await readyOverStore();
		store.value = { ...store.value, preferredCharacter: 'Kasmeer' };
		const receipt = { at: 1 } as never;

		await (runtime as unknown as { recordInventorySyncOutcome(o: never): Promise<void> }).recordInventorySyncOutcome(receipt);

		expect(saves.at(-1)).toMatchObject({ preferredCharacter: 'Kasmeer', inventorySyncLastRun: receipt });
	});

	it('publishes only the receipt in memory, so a language changed outside still reacts at the next save', async () => {
		const { runtime, store, saves, patched } = await readyOverStore();
		store.value = { ...store.value, language: 'es' };
		const receipt = { at: 1 } as never;

		await (runtime as unknown as { recordInventorySyncOutcome(o: never): Promise<void> }).recordInventorySyncOutcome(receipt);
		expect(saves.at(-1)).toMatchObject({ language: 'es', inventorySyncLastRun: receipt });
		expect(runtime.settings.language).toBe('en');
		expect(patched).toEqual([]);

		await runtime.updateSettings({ valuableLootThresholdCopper: 20_000 });

		expect(saves.at(-1)).toMatchObject({ language: 'es', valuableLootThresholdCopper: 20_000 });
		expect(patched).toEqual(['session', 'inventory', 'sale', 'achievements']);
	});

	it.each([
		['an older schema', { schemaVersion: SETTINGS_SCHEMA_VERSION - 1 }],
		['an empty object', null],
	])('keeps its memory as the base when the store holds %s', async (_label, foreign) => {
		const { runtime, store, saves } = await readyOverStore();
		await runtime.updateSettings({ pollingIntervalMinutes: 30, apiKeySecret: 'gw2-primary' });
		saves.length = 0;
		store.value = foreign === null ? {} : { ...store.value, ...foreign, pollingIntervalMinutes: 60, apiKeySecret: '' };
		const memory = { ...runtime.settings };

		await runtime.updateSettings({ valuableLootThresholdCopper: 20_000 });

		expect(saves).toHaveLength(1);
		expect(saves[0]).toMatchObject({ ...memory, valuableLootThresholdCopper: 20_000 });
		expect(saves[0]).toMatchObject({ pollingIntervalMinutes: 30, apiKeySecret: 'gw2-primary', schemaVersion: SETTINGS_SCHEMA_VERSION });
	});

	it('bumps the API key revision the «Logros» view reads only when the selected key changes', async () => {
		const { runtime } = await readyOverStore();
		const before = runtime.getApiKeyRevision();
		await runtime.updateSettings({ valuableLootThresholdCopper: 20_000 });
		expect(runtime.getApiKeyRevision()).toBe(before);
		await runtime.updateSettings({ apiKeySecret: 'gw2-primary' });
		expect(runtime.getApiKeyRevision()).toBe(before + 1);
		await runtime.updateSettings({ apiKeySecret: 'gw2-primary' });
		expect(runtime.getApiKeyRevision()).toBe(before + 1);
		await runtime.updateSettings({ apiKeySecret: 'gw2-other' });
		expect(runtime.getApiKeyRevision()).toBe(before + 2);
	});

	it('leaves the chain usable when a save rejects', async () => {
		const { runtime, store } = await readyOverStore();
		const failure = new Error('The store refuses the write.');
		const host = (runtime as unknown as { host: TyrianHost }).host;
		vi.spyOn(host.settings, 'save').mockRejectedValueOnce(failure);

		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 20_000 })).rejects.toBe(failure);

		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 30_000 })).resolves.toMatchObject({ status: 'saved' });
		expect(store.value).toMatchObject({ valuableLootThresholdCopper: 30_000 });
	});

	it('loses none of three concurrent writers: a Settings edit, the inventory sync receipt and another edit (DU-04)', async () => {
		const { runtime, saves, store } = await readyOverStore();
		// A receipt the settings migration accepts: the save after it re-reads the store and keeps it only if it is valid.
		const receipt = { status: 'success', finishedAt: '2026-10-10T10:00:00.000Z', durationMs: 5, summary: null, error: null } as never;

		await Promise.all([
			runtime.updateSettings({ valuableLootThresholdCopper: 20_000 }),
			(runtime as unknown as { recordInventorySyncOutcome(o: never): Promise<void> }).recordInventorySyncOutcome(receipt),
			runtime.updateSettings({ preferredCharacter: 'Kasmeer' }),
		]);

		expect(saves).toHaveLength(3);
		expect(store.value).toMatchObject({ valuableLootThresholdCopper: 20_000, preferredCharacter: 'Kasmeer', inventorySyncLastRun: receipt });
		expect(runtime.settings).toMatchObject({ valuableLootThresholdCopper: 20_000, preferredCharacter: 'Kasmeer', inventorySyncLastRun: receipt });
	});
});

describe('a data.json written by a newer release (DU-04)', { timeout: 20_000 }, () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	const NEWER = { schemaVersion: SETTINGS_SCHEMA_VERSION + 1, preferredCharacter: 'Kasmeer', futureOnlyKey: 'kept' };
	const warning = (): string => translateRuntime(createTranslator('en'), 'notices.settingsNewerSchema');

	/** Same host as above: a settings store the test reads and changes from outside. */
	async function bootOver(initial: Record<string, unknown>) {
		vi.stubGlobal('window', {
			setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
		});
		const { host, registered } = neutralHost();
		const store = { value: { ...DEFAULT_SETTINGS, debugLoggingEnabled: true, debugLoggingLevel: 'debug', ...initial } as Record<string, unknown> };
		const saves: Array<Record<string, unknown>> = [];
		const wired: TyrianHost = {
			...host,
			settings: {
				load: async () => structuredClone(store.value),
				save: async (value) => { saves.push(structuredClone(value) as never); store.value = structuredClone(value) as never; },
			},
		};
		const runtime = createTyrianRuntime(wired);
		await runtime.start();
		registered.ready[0]!();
		// Not through the log: a schema other than this one reads the debug opt-in as its default, off.
		await vi.waitFor(() => {
			expect((runtime as unknown as { runtimeReady: boolean }).runtimeReady).toBe(true);
		}, { timeout: 10_000 });
		return { runtime, store, saves, notices: registered.notices };
	}

	it('starts without writing the settings, warns once, and refuses every later settings write', async () => {
		const { runtime, store, saves, notices } = await bootOver(NEWER);
		const untouched = structuredClone(store.value);

		expect(saves).toEqual([]);
		expect(runtime.settings.preferredCharacter).toBe('Kasmeer');
		expect(notices.filter((notice) => notice === warning())).toHaveLength(1);

		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 20_000 })).resolves.toEqual({ status: 'blocked', reason: 'settings_read_only' });
		await (runtime as unknown as { recordInventorySyncOutcome(o: never): Promise<void> }).recordInventorySyncOutcome({ at: 1 } as never);

		expect(saves).toEqual([]);
		expect(store.value).toEqual(untouched);
		expect(runtime.settings.valuableLootThresholdCopper).toBe(DEFAULT_SETTINGS.valuableLootThresholdCopper);
		// A refused Settings edit says why, with the same warning.
		expect(notices.filter((notice) => notice === warning())).toHaveLength(2);
	});

	it('stops writing as soon as a save finds that another device wrote a newer schema meanwhile', async () => {
		const { runtime, store, saves, notices } = await bootOver({ schemaVersion: SETTINGS_SCHEMA_VERSION });
		saves.length = 0;
		store.value = { ...store.value, ...NEWER };
		const untouched = structuredClone(store.value);

		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 20_000 })).resolves.toEqual({ status: 'blocked', reason: 'settings_read_only' });
		await (runtime as unknown as { recordInventorySyncOutcome(o: never): Promise<void> }).recordInventorySyncOutcome({ at: 1 } as never);

		expect(saves).toEqual([]);
		expect(store.value).toEqual(untouched);
		expect(notices.filter((notice) => notice === warning())).toHaveLength(1);
	});

	it.each([
		['the same schema', SETTINGS_SCHEMA_VERSION],
		['an older schema', SETTINGS_SCHEMA_VERSION - 1],
	])('keeps the usual behaviour over %s: no warning, and Settings saves', async (_label, schemaVersion) => {
		const { runtime, store, notices } = await bootOver({ schemaVersion });

		await expect(runtime.updateSettings({ valuableLootThresholdCopper: 20_000 })).resolves.toMatchObject({ status: 'saved' });

		expect(store.value).toMatchObject({ schemaVersion: SETTINGS_SCHEMA_VERSION, valuableLootThresholdCopper: 20_000 });
		expect(notices).not.toContain(warning());
	});
});
