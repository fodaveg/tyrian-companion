import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalDebugStoragePort } from '../core/local-debug-writer';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION } from '../core/settings';
import { indexedDbPriceHistoryPort } from '../host/indexed-db-price-history';
import type {
	TyrianCommandRegistration,
	TyrianHost,
	TyrianKvPort,
	TyrianMenuEntry,
	TyrianPanelRegistration,
	TyrianRibbonRegistration,
	TyrianUiPort,
	TyrianVault,
	TyrianVaultFile,
	TyrianViewRegistration,
} from '../host/tyrian-host';
import { PRICE_HISTORY_NOTE_CODE_BLOCK_LANGUAGE } from '../inventory/price-history-note-block';
import { COMPANION_VIEW_TYPE } from '../ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE } from '../ui/inventory-advisor-item-view';
import { PRODUCT_ACTION_IDS } from '../ui/product-action-controller';
import { SALE_VIEW_TYPE } from '../ui/sale-item-view';
import { createTyrianRuntime } from './index';
import { ALERT_INGAME_SECRET_COMMAND_ID, EXPORT_LEGACY_SESSION_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID } from './tyrian-companion-core';
import { VIEW_PLACEMENT_KEY } from './view-placement';

/**
 * R1c: the whole of Tyrian booted through `createTyrianRuntime(host).start()` over a host with no
 * Obsidian behind it at all, the way Hebra embeds it: an in-memory library, `fake-indexeddb` for
 * `kv`, and a UI port that only records what the core registers. Nothing here imports the plugin.
 */
function neutralHost() {
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
	const kv: TyrianKvPort = { indexedDB: new IDBFactory() };
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
			[COMPANION_VIEW_TYPE, 'column'], [INVENTORY_ADVISOR_VIEW_TYPE, 'dialog'], [SALE_VIEW_TYPE, 'dialog'],
		]);
		expect(registered.commands.map(({ id }) => id)).toEqual([
			...PRODUCT_ACTION_IDS, ALERT_INGAME_SECRET_COMMAND_ID, EXPORT_LIVE_SESSION_COMMAND_ID, EXPORT_LEGACY_SESSION_COMMAND_ID,
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

	it('registers each view with the title and the icon of its section, in the language of the settings', async () => {
		const { host, registered } = neutralHost();
		await createTyrianRuntime(host).start();

		expect(registered.views.map((view) => [view.type, view.title(), view.icon])).toEqual([
			[COMPANION_VIEW_TYPE, 'Tyrian companion', 'sword'],
			[INVENTORY_ADVISOR_VIEW_TYPE, 'Inventory advisor', 'package-search'],
			[SALE_VIEW_TYPE, 'Halloween sale', 'candy'],
		]);
		// A registration is exactly what `registerView` takes: nothing of the section leaks into it.
		for (const view of registered.views) {
			expect(Object.keys(view).sort()).toEqual(['icon', 'mount', 'placement', 'title', 'type', 'unmount']);
		}
	});
});

/** A recording dropdown for a settings row rendered outside a page, as the host's settings search does. */
function recordingDropdown() {
	const state = { options: [] as Array<[string, string]>, shown: null as string | null, change: async (_value: string): Promise<void> => undefined };
	const dropdown = {
		addOption: (value: string, display: string) => { state.options.push([value, display]); return dropdown; },
		setValue: (value: string) => { state.shown = value; return dropdown; },
		setDisabled: () => dropdown,
		onChange: (callback: (value: string) => Promise<void>) => { state.change = callback; return dropdown; },
	};
	const row = { addDropdown: (build: (control: typeof dropdown) => unknown) => { build(dropdown); return row; } };
	return { state, row };
}

describe('main screen or sidebar: this device\'s choice, behind a host capability', () => {
	const PLACEMENT_ROW = 'Where it is shown';
	const settingNames = (registered: ReturnType<typeof neutralHost>['registered']): string[] =>
		registered.panels[0]!.settingDefinitions!().map(({ name }) => name);
	const threeViews = [
		[COMPANION_VIEW_TYPE, 'column'], [INVENTORY_ADVISOR_VIEW_TYPE, 'dialog'], [SALE_VIEW_TYPE, 'dialog'],
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
		expect(registered.views.map(({ type, placement }) => [type, placement])).toEqual(threeViews);
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
		// Saving the choice is all it does: the three views stay registered where they were.
		expect(registered.views.map(({ type, placement }) => [type, placement])).toEqual(threeViews);

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
