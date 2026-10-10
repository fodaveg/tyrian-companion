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
import { loadCollectorMode, readStoredCollectorMode, saveCollectorMode } from './runtime/collector-instance';
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
	isApplyingVaultRelocation(): boolean;
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

	it('a folder moved outside Obsidian (new app id, empty local storage, same mark) warns and starts in consult', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.shutdownRuntime();
		expect(world.data?.vaultMark).toMatch(/^[A-Za-z0-9-]{16,64}$/u);
		world.local.clear();
		const second = await boot(world, '/vaults/elsewhere', { apiKeySecret: 'gw2-main' });

		expect(second.getVaultRelocation()).toEqual({ pending: true });
		expect(second.getCollectorMode()).toBe('consult');
		expect(world.notices).toHaveLength(1);
		expect(await second.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted', mode: 'collector' });
		expect(second.getCollectorMode()).toBe('collector');
		await second.shutdownRuntime();
	});

	it('a vault with no mark gets one and does not warn', async () => {
		const world = device();
		const plugin = await boot(world, '/vaults/brand-new', { apiKeySecret: 'gw2-main' });

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(world.data?.vaultMark).toMatch(/^[A-Za-z0-9-]{16,64}$/u);
		expect(world.notices).toEqual([]);
		await plugin.shutdownRuntime();
	});

	it('another device of the same synced vault (same mark, nothing recorded on it) does not warn', async () => {
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

	it('a host whose identity is not a path creates no mark and detects nothing', async () => {
		const world = device();
		const plugin = await boot(world, '/vaults/hebra-like', { apiKeySecret: 'gw2-main' }, true, { pathBoundIdentity: false });

		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(world.data?.vaultMark ?? '').toBe('');
		expect(world.local.get(IDENTITY_KEY)).toBeUndefined();
		await plugin.shutdownRuntime();
	});

	it('a vault copied whole (same mark, own local storage) opened alternately never asks again once the copy is answered', async () => {
		const original = device();
		const first = await boot(original, '/vaults/v1', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('collector');
		await first.shutdownRuntime();
		const copy: Device = { factory: original.factory, local: new Map(), notices: [], data: structuredClone(original.data) };
		const opened: string[] = [];
		const open = async (world: Device, path: string, answer?: 'adopt' | 'fresh'): Promise<void> => {
			const plugin = await boot(world, path, { apiKeySecret: 'gw2-main' });
			opened.push(`${path} pending=${String(plugin.getVaultRelocation().pending)} mode=${plugin.getCollectorMode()}`);
			if (answer !== undefined) await plugin.resolveVaultRelocation(answer);
			await plugin.shutdownRuntime();
		};

		await open(copy, '/vaults/v2', 'fresh');
		await open(original, '/vaults/v1');
		await open(copy, '/vaults/v2');
		await open(original, '/vaults/v1');
		await open(original, '/vaults/v1');
		await open(copy, '/vaults/v2');

		// Only the first opening of the copy asks; the original keeps its collector mode in every opening.
		expect(opened).toEqual([
			'/vaults/v2 pending=true mode=consult',
			'/vaults/v1 pending=false mode=collector',
			'/vaults/v2 pending=false mode=consult',
			'/vaults/v1 pending=false mode=collector',
			'/vaults/v1 pending=false mode=collector',
			'/vaults/v2 pending=false mode=consult',
		]);
	});

	it('a copy that is not answered keeps asking on its own side and never makes the original ask', async () => {
		const original = device();
		const first = await boot(original, '/vaults/v1', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('collector');
		await first.shutdownRuntime();
		const copy: Device = { factory: original.factory, local: new Map(), notices: [], data: structuredClone(original.data) };
		const opened: string[] = [];
		for (const [world, path] of [[copy, '/vaults/v2'], [original, '/vaults/v1'], [copy, '/vaults/v2'], [original, '/vaults/v1']] as const) {
			const plugin = await boot(world, path, { apiKeySecret: 'gw2-main' });
			opened.push(`${path} pending=${String(plugin.getVaultRelocation().pending)} mode=${plugin.getCollectorMode()}`);
			await plugin.shutdownRuntime();
		}

		expect(opened).toEqual([
			'/vaults/v2 pending=true mode=consult',
			'/vaults/v1 pending=false mode=collector',
			'/vaults/v2 pending=true mode=consult',
			'/vaults/v1 pending=false mode=collector',
		]);
	});

	it('a mark that changes under an intact local storage reaches the registry, so a later move outside Obsidian is detected', async () => {
		const world = device();
		const first = await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('consult');
		await first.shutdownRuntime();
		// What Sync leaves after two devices created their mark at once, or an older build stripped it and this one made another.
		const crossed = crypto.randomUUID();
		world.data = { ...world.data, vaultMark: crossed };
		const second = await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' });
		expect(second.getVaultRelocation()).toEqual({ pending: false });
		await second.shutdownRuntime();
		expect(await registryEntry(world, crossed)).toEqual({ vaultId: await sha256Text('/vaults/a') });

		world.local.clear();
		const moved = await boot(world, '/vaults/elsewhere', { apiKeySecret: 'gw2-main' });

		expect(moved.getVaultRelocation()).toEqual({ pending: true });
		expect(moved.getCollectorMode()).toBe('consult');
		await moved.shutdownRuntime();
	});

	it('the notice after "start fresh" says the mode in force, collector when the user chose it while the question was open', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('consult');
		await first.shutdownRuntime();
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		await second.updateCollectorMode('collector');

		expect(await second.resolveVaultRelocation('fresh')).toEqual({ status: 'fresh' });

		expect(second.getCollectorMode()).toBe('collector');
		expect(world.notices.at(-1)).toMatch(/collector mode/u);
		expect(world.notices.at(-1)).not.toMatch(/consult/u);
		await second.shutdownRuntime();
	});

	it('the notice after "adopt" does not claim the old mode when the one chosen for the new path won', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('consult');
		await first.shutdownRuntime();
		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		await second.updateCollectorMode('collector');

		expect(await second.resolveVaultRelocation('adopt')).toEqual({ status: 'adopted', preferences: 0, mode: null });

		expect(second.getCollectorMode()).toBe('collector');
		expect(world.notices.at(-1)).not.toMatch(/mode|modo/iu);
		await second.shutdownRuntime();
	});

	it('the answer runs as a diagnosed settings action', async () => {
		const world = device();
		await (await boot(world, '/vaults/old', {})).shutdownRuntime();
		const plugin = await boot(world, '/vaults/new', {});
		const run = vi.fn(async (_context: unknown, action: () => Promise<unknown>) => await action());
		(plugin as unknown as { localDebugActions: unknown }).localDebugActions = {
			run, runSync: (_context: unknown, action: () => void) => { action(); }, event: vi.fn(),
			fireAndForget: vi.fn(),
		};

		await plugin.resolveVaultRelocation('fresh');

		expect(run).toHaveBeenCalledWith(expect.objectContaining({ component: 'settings', state: 'vault_relocation' }), expect.any(Function));
		(plugin as unknown as { localDebugActions: unknown }).localDebugActions = null;
		await plugin.shutdownRuntime();
	});

	it('after adopting preferences the in-memory inventory preferences are loaded again', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', {});
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const plugin = await boot(world, '/vaults/new', {});
		const reload = vi.spyOn((plugin as unknown as { inventoryPreferences: { loadCached(): Promise<unknown> } }).inventoryPreferences, 'loadCached');

		await plugin.resolveVaultRelocation('adopt');

		expect(reload).toHaveBeenCalledTimes(1);
		await plugin.shutdownRuntime();
	});

	it('a question left open stays open on the next start even when the registry cannot be read, and stores no mode for the new path', async () => {
		const world = device();
		await (await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' })).shutdownRuntime();
		const asked = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const newId = asked.vaultId ?? '';
		await asked.shutdownRuntime();
		const open = world.factory.open.bind(world.factory);
		const broken = vi.spyOn(world.factory, 'open').mockImplementation((name: string, version?: number) => {
			if (name !== VAULT_REGISTRY_DB) return open(name, version);
			const request = { result: undefined, error: null } as unknown as IDBOpenDBRequest;
			globalThis.setTimeout(() => { (request.onerror as (() => void) | null)?.(); }, 0);
			return request;
		});

		const second = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		broken.mockRestore();

		expect(second.getVaultRelocation()).toEqual({ pending: true });
		expect(second.getCollectorMode()).toBe('consult');
		expect(await readStoredCollectorMode(world.factory, newId)).toBeNull();
		await second.shutdownRuntime();
	});

	it('a failed reload of the in-memory preferences is retried by the next click, which reloads them again', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', {});
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const plugin = await boot(world, '/vaults/new', {});
		const reload = vi.spyOn(preferencesRuntime(plugin), 'loadCached').mockRejectedValueOnce(new Error('storage hiccup'));

		await expect(plugin.resolveVaultRelocation('adopt')).rejects.toThrow('storage hiccup');
		expect(plugin.getVaultRelocation()).toEqual({ pending: true });
		expect(await plugin.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted' });

		expect(reload).toHaveBeenCalledTimes(2);
		await plugin.shutdownRuntime();
	});

	it('a registry write that fails after the start gave up waiting for the detection is still observed', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
		process.on('unhandledRejection', onUnhandled);
		try {
			const world = device();
			await (await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' })).shutdownRuntime();
			// The local storage still remembers /vaults/a; the mark is gone from data.json (an older build stripped it).
			world.data = { ...world.data, vaultMark: undefined };
			const open = world.factory.open.bind(world.factory);
			vi.spyOn(world.factory, 'open').mockImplementation((name: string, version?: number) => {
				if (name !== VAULT_REGISTRY_DB) return open(name, version);
				const request = { result: undefined, error: null } as unknown as IDBOpenDBRequest;
				globalThis.setTimeout(() => { (request.onerror as (() => void) | null)?.(); }, 0);
				return request;
			});

			const plugin = await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' }, true, undefined, async () => { await sleep(80); });
			await sleep(300);

			expect(unhandled).toEqual([]);
			await plugin.shutdownRuntime();
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('while an answer is applied Settings can see it, and a call that names the other option gets the same answer', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', {});
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const plugin = await boot(world, '/vaults/new', {});
		const prefs = preferencesRuntime(plugin);
		const real = prefs.loadCached.bind(prefs);
		vi.spyOn(prefs, 'loadCached').mockImplementationOnce(async () => { await sleep(80); return await real(); });
		const before = world.notices.length;

		const adopting = plugin.resolveVaultRelocation('adopt');
		expect(plugin.isApplyingVaultRelocation()).toBe(true);
		expect(plugin.getVaultRelocation()).toEqual({ pending: true });
		const switching = plugin.resolveVaultRelocation('fresh');

		const [one, two] = await Promise.all([adopting, switching]);
		expect(one).toMatchObject({ status: 'adopted', preferences: 1 });
		expect(two).toEqual(one);
		expect(plugin.isApplyingVaultRelocation()).toBe(false);
		expect(plugin.getVaultRelocation()).toEqual({ pending: false });
		expect(world.notices).toHaveLength(before + 1);
		await plugin.shutdownRuntime();
	});

	it('an answer that fails at the registry leaves the question open and no mode that a later answer could take for the user\'s', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const newId = plugin.vaultId ?? '';
		await sleep(20);
		const open = world.factory.open.bind(world.factory);
		const broken = vi.spyOn(world.factory, 'open').mockImplementation((name: string, version?: number) => {
			if (name !== VAULT_REGISTRY_DB) return open(name, version);
			const request = { result: undefined, error: null } as unknown as IDBOpenDBRequest;
			globalThis.setTimeout(() => { (request.onerror as (() => void) | null)?.(); }, 0);
			return request;
		});

		await expect(plugin.resolveVaultRelocation('fresh')).rejects.toThrow();

		expect(world.local.get(IDENTITY_KEY)).toEqual({ vaultId: newId, pendingFrom: oldId });
		expect(await readStoredCollectorMode(world.factory, newId)).toBeNull();
		expect(plugin.isApplyingVaultRelocation()).toBe(false);
		broken.mockRestore();
		expect(await plugin.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted', mode: 'collector' });
		expect(plugin.getCollectorMode()).toBe('collector');
		await plugin.shutdownRuntime();
	});

	it('an answer still applying when the plugin unloads ends without touching state, views or notices', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const prefs = preferencesRuntime(plugin);
		const real = prefs.loadCached.bind(prefs);
		vi.spyOn(prefs, 'loadCached').mockImplementationOnce(async () => { await sleep(120); return await real(); });
		const apply = vi.spyOn(plugin as unknown as { applyCollectorModeChange(): Promise<void> }, 'applyCollectorModeChange');
		const answer = plugin.resolveVaultRelocation('adopt');

		await plugin.shutdownRuntime();
		const noticesAtUnload = world.notices.length;

		expect(await answer).toEqual({ status: 'none' });
		expect(apply).not.toHaveBeenCalled();
		expect(world.notices).toHaveLength(noticesAtUnload);
		expect(plugin.getCollectorMode()).toBe('consult');
		expect(world.local.get(IDENTITY_KEY)).toMatchObject({ pendingFrom: oldId });
	});

	it('back at the original path, with the registry failing, the open question is dropped instead of asked about itself', async () => {
		const world = device();
		await (await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' })).shutdownRuntime();
		const away = await boot(world, '/vaults/b', { apiKeySecret: 'gw2-main' });
		expect(away.getVaultRelocation()).toEqual({ pending: true });
		await away.shutdownRuntime();
		const open = world.factory.open.bind(world.factory);
		const broken = vi.spyOn(world.factory, 'open').mockImplementation((name: string, version?: number) => {
			if (name !== VAULT_REGISTRY_DB) return open(name, version);
			const request = { result: undefined, error: null } as unknown as IDBOpenDBRequest;
			globalThis.setTimeout(() => { (request.onerror as (() => void) | null)?.(); }, 0);
			return request;
		});

		const back = await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' });
		broken.mockRestore();

		expect(back.getVaultRelocation()).toEqual({ pending: false });
		expect(back.getCollectorMode()).toBe('collector');
		await back.shutdownRuntime();
	});

	it('an answer that finds the plugin unloaded when it starts does nothing', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		await savePreferences(world, oldId);
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const newId = plugin.vaultId ?? '';
		await plugin.shutdownRuntime();
		const noticesAtUnload = world.notices.length;

		expect(await plugin.resolveVaultRelocation('adopt')).toEqual({ status: 'none' });

		const store = new IndexedDbInventoryPreferencesStore(world.factory);
		expect(await store.read({ vaultId: newId, accountId: ACCOUNT_ID })).toEqual({ status: 'ok', record: null });
		store.dispose();
		expect(world.notices).toHaveLength(noticesAtUnload);
		expect(world.local.get(IDENTITY_KEY)).toMatchObject({ pendingFrom: oldId });
	});

	it('an answer whose plugin unloads while the mode change is applied renders nothing and announces nothing', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		await first.updateCollectorMode('collector');
		await first.shutdownRuntime();
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const internals = plugin as unknown as { applyCollectorModeChange(): Promise<void>; renderInventoryAdvisorViews(): void };
		vi.spyOn(internals, 'applyCollectorModeChange').mockImplementation(async () => { await plugin.shutdownRuntime(); });
		const render = vi.spyOn(internals, 'renderInventoryAdvisorViews');
		const noticesBefore = world.notices.length;

		expect(await plugin.resolveVaultRelocation('adopt')).toEqual({ status: 'none' });

		expect(render).not.toHaveBeenCalled();
		expect(world.notices).toHaveLength(noticesBefore);
	});

	it('going back to the original path with data under the other one, the registry healthy, asks nothing', async () => {
		const world = device();
		await (await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' })).shutdownRuntime();
		const away = await boot(world, '/vaults/b', { apiKeySecret: 'gw2-main' });
		expect(away.getVaultRelocation()).toEqual({ pending: true });
		const idB = away.vaultId ?? '';
		await away.shutdownRuntime();
		// With the question open the user changed inventory preferences under B.
		await savePreferences(world, idB);

		const back = await boot(world, '/vaults/a', { apiKeySecret: 'gw2-main' });

		expect(back.getVaultRelocation()).toEqual({ pending: false });
		expect(back.getCollectorMode()).toBe('collector');
		await back.shutdownRuntime();
	});

	it('a local storage that refuses the final write leaves no mode behind for the retry to take as chosen', async () => {
		const world = device();
		const first = await boot(world, '/vaults/old', { apiKeySecret: 'gw2-main' });
		const oldId = first.vaultId ?? '';
		await first.shutdownRuntime();
		const plugin = await boot(world, '/vaults/new', { apiKeySecret: 'gw2-main' });
		const newId = plugin.vaultId ?? '';
		await sleep(20);
		world.failLocalSave = true;

		await expect(plugin.resolveVaultRelocation('fresh')).rejects.toThrow('local storage is full');

		expect(await readStoredCollectorMode(world.factory, newId)).toBeNull();
		expect(world.local.get(IDENTITY_KEY)).toEqual({ vaultId: newId, pendingFrom: oldId });
		expect(plugin.getVaultRelocation()).toEqual({ pending: true });
		world.failLocalSave = false;
		expect(await plugin.resolveVaultRelocation('adopt')).toMatchObject({ status: 'adopted', mode: 'collector' });
		expect(plugin.getCollectorMode()).toBe('collector');
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
	/** Makes the local storage refuse writes, as a full or locked one does. */
	failLocalSave?: boolean;
}

/** One computer: the IndexedDB and the per-vault local storage that survive a restart or a rename. */
function device(): Device {
	return { factory: new IDBFactory(), local: new Map(), notices: [], data: null };
}

/** Ten-second storage deadlines fire after 30 ms; everything that answers does so well before. */
function fastDeadlines(world: Device): void {
	vi.stubGlobal('window', {
		indexedDB: world.factory, setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
		setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay >= 10_000 ? 30 : delay),
		clearTimeout: (handle: number) => { globalThis.clearTimeout(handle); },
	});
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { globalThis.setTimeout(resolve, ms); });

/** The inventory preferences runtime of a booted plugin, to slow or break its reload. */
function preferencesRuntime(plugin: RelocationHarness): { loadCached(): Promise<unknown> } {
	return (plugin as unknown as { inventoryPreferences: { loadCached(): Promise<unknown> } }).inventoryPreferences;
}

/** What the per-device registry holds for a mark. */
async function registryEntry(world: Device, mark: string): Promise<unknown> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = world.factory.open(VAULT_REGISTRY_DB, 1);
		request.onupgradeneeded = () => { request.result.createObjectStore('marks-v1'); };
		request.onsuccess = () => { resolve(request.result); };
		request.onerror = () => { reject(new Error('registry could not be opened')); };
	});
	try {
		return await new Promise<unknown>((resolve, reject) => {
			const request = database.transaction('marks-v1', 'readonly').objectStore('marks-v1').get(mark);
			request.onsuccess = () => { resolve(request.result as unknown); };
			request.onerror = () => { reject(new Error('registry could not be read')); };
		});
	} finally {
		database.close();
	}
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
	slowSave?: () => Promise<void>,
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
			saveLocalStorage: (key: string, value: unknown) => { if (world.failLocalSave === true) throw new Error('local storage is full'); if (value === null) world.local.delete(key); else world.local.set(key, structuredClone(value)); },
		} : {}),
	} as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const { core } = obsidianPluginCore(app, manifest, {
		saveData: vi.fn(async (data: unknown) => { if (slowSave !== undefined) await slowSave(); world.data = structuredClone(data) as Record<string, unknown>; }),
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
	if (slowSave !== undefined) fastDeadlines(world);
	vi.stubGlobal('navigator', { onLine: true });
	const notice = vi.spyOn(target.host.ui, 'notice').mockImplementation((message: string) => { world.notices.push(message); });
	void notice;
	if (capabilities !== undefined) (target.host as { capabilities?: unknown }).capabilities = capabilities;
	await target.initializeRuntime();
	for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	return target;
}
