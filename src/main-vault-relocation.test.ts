import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { sha256Text } from './assets/managed-asset-hash';
import { DEFAULT_SETTINGS, type CollectorMode, type TyrianSettings } from './core/settings';
import { IndexedDbInventoryPreferencesStore } from './advisor/inventory-preferences-store';
import { createInventoryPreferences } from './advisor/inventory-preferences-contract';
import {
	INVENTORY_PREFERENCES_DB_NAME, INVENTORY_PREFERENCES_DB_VERSION, INVENTORY_PREFERENCES_STORE_NAME,
} from './advisor/inventory-preferences-model';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { obsidianPluginCore } from './test/obsidian-host-harness';
import { loadCollectorMode, saveCollectorMode } from './runtime/collector-instance';
import { VAULT_REGISTRY_DB } from './runtime/vault-relocation';
import type { SettingsUpdateResult } from './runtime/tyrian-companion-core';
import type { TyrianHost } from './host/tyrian-host';

/**
 * DU-02 (docs/audit/2026-10-10-durabilidad-almacen.md): a vault's identity is the hash of its
 * absolute path, so renaming or moving the folder orphans everything this device keeps locally and
 * makes the seed (a synced API key) read as collector again. The real `initializeRuntime` runs over
 * one fake-indexeddb factory and one per-device local storage, with the vault path as the only thing
 * that changes between boots.
 */
interface RelocationHarness {
	settings: TyrianSettings;
	vaultId: string | null;
	collectorMode: CollectorMode | undefined;
	initializeRuntime(): Promise<void>;
	shutdownRuntime(): Promise<void>;
	updateCollectorMode(mode: CollectorMode): Promise<SettingsUpdateResult>;
	getCollectorMode(): CollectorMode;
	getVaultRelocation(): { pending: boolean };
	resolveVaultRelocation(choice: 'adopt' | 'fresh'): Promise<{ status: string; preferences?: number; mode?: CollectorMode | null }>;
	readonly host: TyrianHost;
}

const ACCOUNT_ID = 'account-1';
const IDENTITY_KEY = 'tyrian-companion:vault-identity';

describe('a vault that changes path is not silently orphaned (DU-02)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('a device with data that boots on a new path starts in consult, warns, and a synced key does not make it a collector', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('collector');
		await first.shutdownRuntime();
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });

		expect(second.getCollectorMode()).toBe('consult');
		expect(second.getVaultRelocation()).toEqual({ pending: true });
		expect(world.notices).toHaveLength(1);
		await second.shutdownRuntime();
	});

	it('keeps warning, still in consult, while the user has not answered', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('collector');
		await first.shutdownRuntime();
		await (await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' })).shutdownRuntime();
		const third = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });

		expect(third.getCollectorMode()).toBe('consult');
		expect(third.getVaultRelocation()).toEqual({ pending: true });
		await third.shutdownRuntime();
	});

	it('adopt: the inventory preferences are seen under the new id and the mode comes back', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('collector');
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const newId = second.vaultId ?? '';

		const result = await second.resolveVaultRelocation('adopt');

		expect(result).toMatchObject({ status: 'adopted', preferences: 1, mode: 'collector' });
		expect(second.getCollectorMode()).toBe('collector');
		expect(second.getVaultRelocation()).toEqual({ pending: false });
		const store = new IndexedDbInventoryPreferencesStore(world.factory);
		const read = await store.read({ vaultId: newId, accountId: ACCOUNT_ID });
		expect(read).toMatchObject({ status: 'ok', record: { vaultId: newId, generation: 3 } });
		// Nothing is deleted: the old record is still there.
		expect(await store.read({ vaultId: oldId, accountId: ACCOUNT_ID })).toMatchObject({ status: 'ok', record: { vaultId: oldId } });
		store.dispose();
		await second.shutdownRuntime();
		const answered = world.notices.length;
		const third = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		expect(third.getCollectorMode()).toBe('collector');
		expect(world.notices).toHaveLength(answered);
		await third.shutdownRuntime();
	});

	it('adopt: a consult device stays in consult', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('consult');
		await first.shutdownRuntime();
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });

		expect(await second.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted', mode: 'consult' });
		expect(second.getCollectorMode()).toBe('consult');
		await second.shutdownRuntime();
	});

	it('adopt never overwrites what the new id already holds', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', {});
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const newId = await sha256Text('/vaults/new');
		await savePreferences(world, newId, 7);
		const second = await boot(world, '/vaults/new', {});

		expect(await second.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted', preferences: 0 });
		const store = new IndexedDbInventoryPreferencesStore(world.factory);
		expect(await store.read({ vaultId: newId, accountId: ACCOUNT_ID })).toMatchObject({ record: { generation: 7 } });
		store.dispose();
		await second.shutdownRuntime();
	});

	it('fresh start: adopts nothing, keeps the old data, stays in consult and never warns again', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('collector');
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const newId = second.vaultId ?? '';

		expect(await second.resolveVaultRelocation('fresh')).toEqual({ status: 'fresh' });
		expect(second.getVaultRelocation()).toEqual({ pending: false });
		expect(second.getCollectorMode()).toBe('consult');
		const store = new IndexedDbInventoryPreferencesStore(world.factory);
		expect(await store.read({ vaultId: newId, accountId: ACCOUNT_ID })).toEqual({ status: 'ok', record: null });
		expect(await store.read({ vaultId: oldId, accountId: ACCOUNT_ID })).toMatchObject({ record: { vaultId: oldId } });
		store.dispose();
		await second.shutdownRuntime();
		const answered = world.notices.length;
		const third = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		expect(third.getVaultRelocation()).toEqual({ pending: false });
		expect(world.notices).toHaveLength(answered);
		await third.shutdownRuntime();
	});

	it('first start of a device with no saved identity records the current one and does not warn', async () => {
		const world = device();
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(plugin.getCollectorMode()).toBe('collector');
		expect(world.notices).toEqual([]);
		expect(world.local.get(IDENTITY_KEY)).toMatchObject({ vaultId: plugin.vaultId });
		await plugin.shutdownRuntime();
	});

	it('the same path again does not warn', async () => {
		const world = device();
		await (await boot(world, '/vaults/same', { apiKeySecret: 'gw2-main' })).shutdownRuntime();
		const again = await boot(world, '/vaults/same', { apiKeySecret: 'gw2-main' });

		expect(again.getVaultRelocation()).toEqual({ pending: false });
		expect(world.notices).toEqual([]);
		await again.shutdownRuntime();
	});

	it('a new path with nothing local under the old id does not warn', async () => {
		const world = device();
		world.local.set(IDENTITY_KEY, { vaultId: await sha256Text('/vaults/ghost') });
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(plugin.getCollectorMode()).toBe('collector');
		expect(world.notices).toEqual([]);
		await plugin.shutdownRuntime();
	});

	it('a consult device with a key in data.json and a new path does NOT become a collector', async () => {
		const world = device();
		const old = await loadCollectorMode(world.factory, await sha256Text('/vaults/old'), () => 'consult');
		expect(old).toBe('consult');
		world.local.set(IDENTITY_KEY, { vaultId: await sha256Text('/vaults/old') });
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });

		expect(plugin.getCollectorMode()).toBe('consult');
		expect(plugin.getVaultRelocation()).toEqual({ pending: true });
		await plugin.resolveVaultRelocation('adopt');
		expect(plugin.getCollectorMode()).toBe('consult');
		await plugin.shutdownRuntime();
	});

	it('going back to the original path without answering does not warn about a move from itself', async () => {
		const world = device();
		const first = await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' });
		await first.shutdownRuntime();
		const away = await boot(world, '/vaults/b', { apiKeySecret: 'gw2-main' });
		expect(away.getVaultRelocation()).toEqual({ pending: true });
		await away.shutdownRuntime();
		const warned = world.notices.length;
		const back = await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' });

		expect(back.getVaultRelocation()).toEqual({ pending: false });
		expect(back.getCollectorMode()).toBe('collector');
		expect(world.notices).toHaveLength(warned);
		await back.shutdownRuntime();
	});

	it('a detection that cannot be made, with another id saved, starts in consult and says so', async () => {
		const world = device();
		world.local.set(IDENTITY_KEY, { vaultId: await sha256Text('/vaults/old') });
		const open = world.factory.open.bind(world.factory);
		vi.spyOn(world.factory, 'open').mockImplementation((name: string, version?: number) => {
			if (name === VAULT_REGISTRY_DB) throw new Error('storage unavailable');
			return open(name, version);
		});
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });

		expect(plugin.getCollectorMode()).toBe('consult');
		expect(plugin.getVaultRelocation()).toEqual({ pending: true });
		expect(world.notices).toHaveLength(1);
		expect(world.notices[0]).toMatch(/check|comprob/iu);
		await plugin.shutdownRuntime();
	});

	it('adopt does not overwrite the mode the user chose for the new path while the question was open', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('consult');
		await first.shutdownRuntime();
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		await second.updateCollectorMode('collector');

		expect(await second.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted' });
		expect(second.getCollectorMode()).toBe('collector');
		await second.shutdownRuntime();
		const third = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		expect(third.getCollectorMode()).toBe('collector');
		await third.shutdownRuntime();
	});

	it('a double click adopts once and warns once', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.shutdownRuntime();
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const before = world.notices.length;

		const [one, two] = await Promise.all([second.resolveVaultRelocation('adopt'), second.resolveVaultRelocation('adopt')]);

		expect(one).toEqual(two);
		expect(one.status).toBe('adopted');
		expect(world.notices).toHaveLength(before + 1);
		await second.shutdownRuntime();
	});

	it('the adopted notice does not mention a mode when the previous path stored none', async () => {
		const world = device();
		const ghost = await sha256Text('/vaults/ghost');
		world.local.set(IDENTITY_KEY, { vaultId: ghost });
		await savePreferences(world, ghost);
		const plugin = await boot(world, '/vaults/new', {});
		expect(plugin.getVaultRelocation()).toEqual({ pending: true });

		expect(await plugin.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted', preferences: 1, mode: null });
		expect(world.notices.at(-1)).not.toMatch(/mode|modo/iu);
		await plugin.shutdownRuntime();
	});

	it('a folder moved outside Obsidian (new app id, empty local storage, same token) warns and starts in consult', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.shutdownRuntime();
		expect(world.data?.vaultToken).toMatch(/^[A-Za-z0-9-]{16,64}$/u);
		world.local.clear();
		const second = await boot(world, '/vaults/elsewhere', { apiKeySecret: 'gw2-main' });

		expect(second.getVaultRelocation()).toEqual({ pending: true });
		expect(second.getCollectorMode()).toBe('consult');
		expect(world.notices).toHaveLength(1);
		expect(await second.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted', mode: 'collector' });
		expect(second.getCollectorMode()).toBe('collector');
		await second.shutdownRuntime();
	});

	it('a vault with no token gets one and does not warn', async () => {
		const world = device();
		const plugin = await boot(world, '/vaults/brand-new', { apiKeySecret: 'gw2-main' });

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(world.data?.vaultToken).toMatch(/^[A-Za-z0-9-]{16,64}$/u);
		expect(world.notices).toEqual([]);
		await plugin.shutdownRuntime();
	});

	it('another device of the same synced vault (same token, nothing recorded on it) does not warn', async () => {
		const first = device();
		await (await boot(first, '/vaults/shared', { apiKeySecret: 'gw2-main' })).shutdownRuntime();
		const other = device();
		other.data = structuredClone(first.data);
		const plugin = await boot(other, '/home/other/shared', { apiKeySecret: 'gw2-main' });

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(plugin.getCollectorMode()).toBe('collector');
		expect(other.notices).toEqual([]);
		await plugin.shutdownRuntime();
	});

	it('a host whose identity is not a path creates no token and detects nothing', async () => {
		const world = device();
		const plugin = await boot(world, '/vaults/hebra-like', { apiKeySecret: 'gw2-main' }, true, { pathBoundIdentity: false });

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(world.data?.vaultToken ?? '').toBe('');
		expect(world.local.get(IDENTITY_KEY)).toBeUndefined();
		await plugin.shutdownRuntime();
	});

	it('a host without per-device local storage behaves as before', async () => {
		const world = device();
		world.local.clear();
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' }, false);

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(plugin.getCollectorMode()).toBe('collector');
		await plugin.shutdownRuntime();
	});

	it('keeps the old mode reachable for the saved id (guard for the fixture itself)', async () => {
		const factory = new IDBFactory();
		await saveCollectorMode(factory, await sha256Text('/x'), 'collector');
		expect(await loadCollectorMode(factory, await sha256Text('/x'), () => 'consult')).toBe('collector');
	});
});

interface Device {
	readonly factory: IDBFactory;
	readonly local: Map<string, unknown>;
	readonly notices: string[];
	/** The plugin's `data.json`: it travels with the folder, so a second device of the same vault starts from a copy. */
	data: Record<string, unknown> | null;
}

/** One computer: the IndexedDB and the per-vault local storage that survive a restart or a rename. */
function device(): Device {
	return { factory: new IDBFactory(), local: new Map(), notices: [], data: null };
}

async function savePreferences(world: Device, vaultId: string, generation = 3): Promise<void> {
	// Straight into the database: the CAS only allows generation 1 from nothing.
	const record = createInventoryPreferences({ vaultId, accountId: ACCOUNT_ID }, generation, '2026-10-10T08:00:00.000Z', [], []);
	if (record === null) throw new Error('fixture preferences are invalid');
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = world.factory.open(INVENTORY_PREFERENCES_DB_NAME, INVENTORY_PREFERENCES_DB_VERSION);
		request.onupgradeneeded = () => { request.result.createObjectStore(INVENTORY_PREFERENCES_STORE_NAME); };
		request.onsuccess = () => { resolve(request.result); };
		request.onerror = () => { reject(new Error('fixture database could not be opened')); };
	});
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction(INVENTORY_PREFERENCES_STORE_NAME, 'readwrite');
		transaction.objectStore(INVENTORY_PREFERENCES_STORE_NAME).put(record, `${vaultId}\u0000${ACCOUNT_ID}`);
		transaction.oncomplete = () => { resolve(); };
		transaction.onerror = () => { reject(new Error('fixture record could not be written')); };
	});
	database.close();
}

async function boot(
	world: Device, basePath: string, overrides: Partial<TyrianSettings>, withLocalStorage = true,
	capabilities?: { pathBoundIdentity: boolean },
): Promise<RelocationHarness> {
	vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => basePath },
		getName: () => basePath.split('/').pop() ?? 'vault',
		getAbstractFileByPath: vi.fn(() => null),
		getMarkdownFiles: vi.fn(() => []),
		getFiles: vi.fn(() => []),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async () => ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string) => Object.assign(new TFile(), { path })),
		process: vi.fn(async (_file: TFile, update: (content: string) => string) => update('')),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = {
		vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager,
		secretStorage: { listSecrets: () => ['gw2-main'], getSecret: () => 'secret-value', setSecret: vi.fn() },
		...(withLocalStorage ? {
			loadLocalStorage: (key: string) => structuredClone(world.local.get(key) ?? null),
			saveLocalStorage: (key: string, value: unknown) => { if (value === null) world.local.delete(key); else world.local.set(key, structuredClone(value)); },
		} : {}),
	} as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const { core } = obsidianPluginCore(app, manifest, {
		saveData: vi.fn(async (data: unknown) => { world.data = structuredClone(data) as Record<string, unknown>; }),
		loadData: async () => structuredClone(world.data),
	});
	const target = core as unknown as RelocationHarness & {
		localDebug: null; localDebugActions: null; lootPresentation: LootPresentationCache;
		settingTab: Record<string, () => void>;
	};
	target.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(world.data ?? {}), ...overrides };
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	target.settingTab = {
		refreshForSettingsChange: vi.fn(), refreshConnectionRow: vi.fn(), refreshManagedAssetsRow: vi.fn(),
		refreshAlertIngameServerRow: vi.fn(), refreshSessionHistoryRow: vi.fn(), refreshForLocaleChange: vi.fn(),
	};
	vi.stubGlobal('window', {
		indexedDB: world.factory,
		setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
	});
	vi.stubGlobal('navigator', { onLine: true });
	const notice = vi.spyOn(target.host.ui, 'notice').mockImplementation((message: string) => { world.notices.push(message); });
	void notice;
	if (capabilities !== undefined) (target.host as { capabilities?: unknown }).capabilities = capabilities;
	await target.initializeRuntime();
	for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	return target;
}
