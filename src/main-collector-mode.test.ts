import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

/** Every outbound request the composition makes, whoever makes it. */
const outbound = vi.hoisted(() => ({
	urls: [] as string[],
	/** What answers a request instead of the default 503, for the tests that need a real account. */
	respond: null as null | ((url: string) => { status: number; json: unknown }),
}));

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	// What `ObsidianHost.environment` reads for the collector's footprint.
	apiVersion: '1.9.12',
	Platform: { isLinux: true, isMacOS: false, isWin: false },
	requestUrl: async ({ url }: { url: string }) => {
		outbound.urls.push(url);
		const answer = outbound.respond?.(url) ?? { status: 503, json: {} };
		return { status: answer.status, headers: {}, json: answer.json, text: JSON.stringify(answer.json) };
	},
}));

import { obsidianPluginCore } from './test/obsidian-host-harness';
import type { SettingsUpdateResult } from './runtime/tyrian-companion-core';
import { DEFAULT_SETTINGS, type CollectorMode, type TyrianSettings } from './core/settings';
import type { TyrianHost, TyrianPriceHistoryStore } from './host/tyrian-host';
import { HalloweenRuntime } from './halloween/halloween-runtime';
import type { PriceHistoryRuntimeState } from './economy/price-history-runtime';
import { loadCollectorMode } from './runtime/collector-instance';
import { COLLECTOR_HEARTBEAT_INTERVAL_MS, parseCollectorStatusNote } from './runtime/collector-status';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import type { ActiveSessionState } from './sessions/session';
import type { InventoryAdvisorViewModel } from './ui/inventory-advisor-view-model';

/**
 * R1b (SPEC-TYRIAN-EN-HEBRA.md section 4) against the real `initializeRuntime`: a consult DEVICE
 * reads, and nothing else. No Guild Wars 2 request, no note or Base written, no bridge port, no
 * poll armed, no `compactAndPrune`. The collector boots exactly as before and adds one thing: its
 * footprint in the status note. The mode is per device: it lives in local IndexedDB, never in
 * `data.json`, so a synced `data.json` cannot flip it.
 */
interface CollectorModeHarness {
	settings: TyrianSettings;
	collectorMode: CollectorMode | undefined;
	vaultId: string | null;
	runtimeReady: boolean;
	initializeRuntime(): Promise<void>;
	shutdownRuntime(): Promise<void>;
	updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
	updateCollectorMode(mode: CollectorMode): Promise<SettingsUpdateResult>;
	previewWalletVaultSync(): Promise<void>;
	applyWalletVaultSync(): Promise<void>;
	refreshInventoryAdvisor(): Promise<void>;
	armAssistedDetection(): Promise<string>;
	openManualSessionStart(): void;
	checkConnection(): Promise<{ status: string }>;
	notifyConsultMode(): void;
	getPriceHistoryState(): PriceHistoryRuntimeState;
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
	readonly host: TyrianHost;
}

const STATUS_NOTE = 'Tyrian Companion/Collector status.md';

describe('collector and consult mode in the assembled runtime (R1b)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		outbound.urls.length = 0;
		outbound.respond = null;
	});

	it('consult: boots with no request, no vault write, no bridge port, no poll and no compactAndPrune', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(activeSession());
		const armLive = vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot');
		const halloweenActivate = vi.spyOn(HalloweenRuntime.prototype, 'activate');
		// Everything that would do something for a collector is switched on, the key included.
		const world = collectorModePlugin({
			apiKeySecret: 'gw2-main', alertIngameEnabled: true, priceHistoryEnabled: true, halloweenEnabled: true,
		}, { mode: 'consult' });

		await world.plugin.initializeRuntime();
		await settle();

		expect(world.plugin.runtimeReady).toBe(true);
		expect(world.plugin.collectorMode).toBe('consult');
		expect(outbound.urls).toEqual([]);
		expect(world.writes).toEqual([]);
		expect(world.listen).not.toHaveBeenCalled();
		expect(world.compactAndPrune).not.toHaveBeenCalled();
		// The local series is still open for reading.
		expect(world.openedStores).toBe(1);
		expect(world.plugin.getPriceHistoryState().status).toBe('ready');
		expect(armLive).not.toHaveBeenCalled();
		expect(halloweenActivate).not.toHaveBeenCalled();
		expect(world.intervals()).not.toContain(COLLECTOR_HEARTBEAT_INTERVAL_MS);
		expect(world.notes.has(STATUS_NOTE)).toBe(false);
		await world.plugin.shutdownRuntime();
	});

	/**
	 * 4 oct 2026 (David, option A): the manual inventory actions work in consult, because refreshing
	 * the inventory must be possible on any installation. They run the collector's own path for that
	 * one execution; nothing automatic starts with them.
	 */
	it('consult: the manual wallet sync reaches the API and writes its notes, and starts no poll, no bridge and no heartbeat', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		outbound.respond = (url) => {
			if (url.includes('account/wallet')) return { status: 200, json: [{ id: 1, value: 12_345 }] };
			if (url.includes('/currencies')) return { status: 200, json: [{ id: 1, name: 'Coin', description: 'd', order: 1, icon: '' }] };
			return { status: 503, json: {} };
		};
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main', alertIngameEnabled: true }, { mode: 'consult' });
		await world.plugin.initializeRuntime();
		await settle();
		expect(outbound.urls).toEqual([]);
		const timersAtBoot = world.intervals().length;

		await world.plugin.previewWalletVaultSync();
		await world.plugin.applyWalletVaultSync();
		await settle();

		expect(outbound.urls.some((url) => url.includes('account/wallet'))).toBe(true);
		expect(world.writes.some((path) => path.startsWith('Tyrian Companion/') && path !== STATUS_NOTE)).toBe(true);
		// Only the two requests of that one execution: nothing polled, nothing refreshed afterwards.
		expect(outbound.urls.every((url) => url.includes('account/wallet') || url.includes('/currencies'))).toBe(true);
		expect(world.writes).not.toContain(STATUS_NOTE);
		expect(world.notes.has(STATUS_NOTE)).toBe(false);
		expect(world.listen).not.toHaveBeenCalled();
		expect(world.intervals().length).toBe(timersAtBoot);
		expect(world.intervals()).not.toContain(COLLECTOR_HEARTBEAT_INTERVAL_MS);
		expect(world.plugin.collectorMode).toBe('consult');
		await world.plugin.shutdownRuntime();
	});

	it('consult: "Analizar" reaches the API instead of refusing', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		// A rejected key ends the capture at once (a 503 would wait on a retry timer this harness never fires).
		outbound.respond = () => ({ status: 401, json: { text: 'invalid access token' } });
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main' }, { mode: 'consult' });
		await world.plugin.initializeRuntime();
		await settle();
		expect(outbound.urls).toEqual([]);

		await world.plugin.refreshInventoryAdvisor();

		// The capture ends in an error here; what matters is that the API was asked.
		expect(outbound.urls.some((url) => url.includes('api.guildwars2.com/v2/'))).toBe(true);
		expect(world.listen).not.toHaveBeenCalled();
		expect(world.intervals()).not.toContain(COLLECTOR_HEARTBEAT_INTERVAL_MS);
		await world.plugin.shutdownRuntime();
	});

	it('consult: the collector-only actions still refuse, with the consult notice and no request', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main' }, { mode: 'consult' });
		await world.plugin.initializeRuntime();
		await settle();
		const notify = vi.spyOn(world.plugin, 'notifyConsultMode');

		await expect(world.plugin.armAssistedDetection()).resolves.toBe('unavailable');
		world.plugin.openManualSessionStart();
		await settle();

		// "Comprobar conexión" is no longer here: under rule A it is a manual action (see below).
		expect(notify).toHaveBeenCalledTimes(2);
		expect(outbound.urls).toEqual([]);
		expect(world.writes).toEqual([]);
		await world.plugin.shutdownRuntime();
	});

	it('collector: boots as before and writes its footprint in the status note, beating every fifteen minutes', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const world = collectorModePlugin({ priceHistoryEnabled: true }, { mode: 'collector' });

		await world.plugin.initializeRuntime();
		await settle();

		expect(world.compactAndPrune).toHaveBeenCalled();
		expect(world.plugin.getPriceHistoryState().status).toBe('collecting');
		const footprint = parseCollectorStatusNote(world.notes.get(STATUS_NOTE) ?? '');
		expect(footprint).toMatchObject({ platform: 'linux', hostVersion: '1.9.12', pluginVersion: 'test' });
		expect(footprint?.instanceId).toMatch(/^[0-9a-f-]{36}$/u);
		expect(world.intervals()).toContain(COLLECTOR_HEARTBEAT_INTERVAL_MS);
		// Only the status note: nothing else is written by a quiet boot.
		expect(world.writes).toEqual([STATUS_NOTE]);
		await world.plugin.shutdownRuntime();
	});

	/**
	 * Hebra's report (4 oct 2026), the iPhone case: a consult device that never analyzed its
	 * inventory sat on "Preparando la revisión local del inventario…". The assembled runtime hands the
	 * Asesor a model that says it was never analyzed, in either mode, instead of one that looks busy.
	 */
	it('the Asesor of a fresh boot says it was never analyzed, in consult and in collector', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		for (const mode of ['consult', 'collector'] as const) {
			const world = collectorModePlugin({ apiKeySecret: 'gw2-main' }, { mode });
			await world.plugin.initializeRuntime();
			await settle();

			expect(world.plugin.getInventoryAdvisorViewModel()).toMatchObject({ status: 'loading', notAnalyzed: true });
			await world.plugin.shutdownRuntime();
			vi.unstubAllGlobals();
		}
	});

	it('seeds the local mode once from the spec rule: a key means collector, none means consult', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		for (const [apiKeySecret, expected] of [['gw2-main', 'collector'], ['', 'consult']] as const) {
			const world = collectorModePlugin({ apiKeySecret });
			await world.plugin.initializeRuntime();
			await settle();

			expect(world.plugin.collectorMode).toBe(expected);
			// Stored locally: a later read ignores whatever seed it is offered.
			const stored = await loadCollectorMode(world.factory, world.plugin.vaultId!, () => 'consult');
			expect(stored).toBe(expected);
			// Seeding wrote nothing to data.json.
			expect(world.saved).toEqual([]);
			await world.plugin.shutdownRuntime();
			vi.unstubAllGlobals();
		}
	});

	it('changing the mode on one device writes the local store only, never data.json', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main', priceHistoryEnabled: true }, { mode: 'collector' });
		await world.plugin.initializeRuntime();
		await settle();
		const heartbeatHandle = world.intervalHandle(COLLECTOR_HEARTBEAT_INTERVAL_MS);
		const compactions = world.compactAndPrune.mock.calls.length;
		const settingsBefore = structuredClone(world.plugin.settings);

		await expect(world.plugin.updateCollectorMode('consult')).resolves.toMatchObject({ status: 'saved' });
		await settle();

		expect(world.plugin.collectorMode).toBe('consult');
		await expect(loadCollectorMode(world.factory, world.plugin.vaultId!, () => 'collector')).resolves.toBe('consult');
		expect(world.saved).toEqual([]);
		expect(world.plugin.settings).toEqual(settingsBefore);
		// And it applies without a reload: no heartbeat, no capture.
		expect(world.cleared()).toContain(heartbeatHandle);
		expect(world.plugin.getPriceHistoryState().status).toBe('ready');
		expect(world.compactAndPrune.mock.calls.length).toBe(compactions);
		await world.plugin.shutdownRuntime();
	});

	it('a synced data.json with a key never changes a local mode already set', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const factory = new IDBFactory();
		// This device was set to consult earlier (its data.json then had no key).
		const first = collectorModePlugin({}, { factory });
		await first.plugin.initializeRuntime();
		await settle();
		expect(first.plugin.collectorMode).toBe('consult');
		await first.plugin.shutdownRuntime();
		vi.unstubAllGlobals();

		// Sync then delivers the collector's data.json, key included, and the plugin reloads.
		const reloaded = collectorModePlugin({ apiKeySecret: 'gw2-main', alertIngameEnabled: true }, { factory });
		await reloaded.plugin.initializeRuntime();
		await settle();
		expect(reloaded.plugin.collectorMode).toBe('consult');
		expect(reloaded.listen).not.toHaveBeenCalled();
		// A later synced settings change does not touch it either.
		await reloaded.plugin.updateSettings({ apiKeySecret: 'gw2-other' });
		expect(reloaded.plugin.collectorMode).toBe('consult');
		await expect(loadCollectorMode(factory, reloaded.plugin.vaultId!, () => 'collector')).resolves.toBe('consult');
		await reloaded.plugin.shutdownRuntime();
	});

	it('refuses consult while a farming session is still open, and keeps collecting', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(activeSession());
		vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue({ status: 'error' } as never);
		const world = collectorModePlugin({}, { mode: 'collector' });
		await world.plugin.initializeRuntime();
		await settle();

		await expect(world.plugin.updateCollectorMode('consult'))
			.resolves.toEqual({ status: 'blocked', reason: 'session_in_progress' });
		expect(world.plugin.collectorMode).toBe('collector');
		await expect(loadCollectorMode(world.factory, world.plugin.vaultId!, () => 'consult')).resolves.toBe('collector');
		await world.plugin.shutdownRuntime();
	});
});

/** The real action controller and the Settings loader, which the harness type above does not list. */
interface ConsultManualActions {
	productActions: {
		describe(id: string): { available: boolean; state: string; disabledReason: string | null };
		run(id: string): Promise<string>;
	};
	loadLegendaryArmoryOptions(): Promise<{ status: string }>;
}

describe('consult: the manual actions through the real action controller', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		outbound.urls.length = 0;
		outbound.respond = null;
	});

	it('a consult device that never analysed can press refresh: not busy, and executing it reaches the API', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		outbound.respond = () => ({ status: 401, json: { text: 'invalid access token' } });
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main' }, { mode: 'consult' });
		await world.plugin.initializeRuntime();
		await settle();
		const actions = world.plugin as unknown as ConsultManualActions & { setupSessionCommands(): void; setupProductActions(): void };
		// `onload` builds the controller; the harness boots only the runtime, so build it as production does.
		vi.spyOn(world.plugin.host.ui, 'registerCommand').mockImplementation(() => () => undefined);
		vi.spyOn(world.plugin.host.ui, 'ribbon').mockImplementation(() => ({ remove: () => undefined, setIcon: () => undefined, setTitle: () => undefined, setPending: () => undefined, setActive: () => undefined, update: () => undefined }) as never);
		actions.setupSessionCommands();
		actions.setupProductActions();

		// Nothing ever analysed: the advisor model reads `loading`, and nothing is in flight.
		const before = actions.productActions.describe('refresh-inventory-advisor');
		expect(before).toMatchObject({ available: true, state: 'idle' });
		for (const id of ['preview-inventory-vault-sync', 'preview-wallet-vault-sync']) {
			expect(actions.productActions.describe(id), id).toMatchObject({ available: true, state: 'idle' });
		}

		// The rejected key makes the action end as `failed` (it throws); that it was attempted is the point.
		await actions.productActions.run('refresh-inventory-advisor').catch(() => undefined);

		expect(outbound.urls.some((url) => url.includes('api.guildwars2.com/v2/'))).toBe(true);
		await world.plugin.shutdownRuntime();
	});

	it('the collector keeps reading a never-analysed advisor as busy, as before', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main' }, { mode: 'collector' });
		await world.plugin.initializeRuntime();
		await settle();
		const actions = world.plugin as unknown as ConsultManualActions & { setupSessionCommands(): void; setupProductActions(): void };
		vi.spyOn(world.plugin.host.ui, 'registerCommand').mockImplementation(() => () => undefined);
		vi.spyOn(world.plugin.host.ui, 'ribbon').mockImplementation(() => ({ remove: () => undefined, setIcon: () => undefined, setTitle: () => undefined, setPending: () => undefined, setActive: () => undefined, update: () => undefined }) as never);
		actions.setupSessionCommands();
		actions.setupProductActions();

		expect(actions.productActions.describe('refresh-inventory-advisor')).toMatchObject({ available: false, state: 'running' });
		await world.plugin.shutdownRuntime();
	});

	it('consult: "Cargar lista" of Settings asks the public legendaryarmory route instead of refusing', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		// A 404 ends the request at once (a 503 would wait on a retry timer this harness never fires).
		outbound.respond = () => ({ status: 404, json: {} });
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main' }, { mode: 'consult' });
		await world.plugin.initializeRuntime();
		await settle();
		const notify = vi.spyOn(world.plugin, 'notifyConsultMode');

		await expect((world.plugin as unknown as ConsultManualActions).loadLegendaryArmoryOptions())
			.resolves.toEqual({ status: 'error' });

		expect(outbound.urls.some((url) => url.includes('/legendaryarmory'))).toBe(true);
		expect(notify).not.toHaveBeenCalled();
		await world.plugin.shutdownRuntime();
	});
});

/** What the key and account checks, and the one-click sync, read on top of the harness. */
interface ConsultConnectionActions {
	settingTab: { refreshConnectionRow: ReturnType<typeof vi.fn> };
	getConnectionState(): { status: string };
	runInventoryVaultSync(): Promise<void>;
	getInventoryVaultSyncRunState(): { status: string; lastRun: { status: string; error: string | null } | null };
	reconcilePendingProposals(): Promise<void>;
}

/**
 * Hebra's report (4 oct 2026, the Mac in consult): "Comprobar conexión" did nothing and the key
 * row kept "Sin comprobar. No se ha realizado ninguna petición de red.". Under rule A (David, 4 oct
 * 2026) checking the key is a manual action like the inventory ones, so consult runs it; what a
 * connected account sets off in the collector (detection, its proposals, Halloween) stays there.
 */
describe('consult: the key check and the inventory sync are manual actions (rule A)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		outbound.urls.length = 0;
		outbound.respond = null;
	});

	it('"Comprobar conexión" asks the key and the account and the row gets the real result, with no notice', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		outbound.respond = validAccount;
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main' }, { mode: 'consult' });
		await world.plugin.initializeRuntime();
		await settle();
		const actions = world.plugin as unknown as ConsultConnectionActions;
		expect(actions.getConnectionState()).toEqual({ status: 'idle' });
		const notify = vi.spyOn(world.plugin, 'notifyConsultMode');

		await expect(world.plugin.checkConnection()).resolves.toMatchObject({ status: 'connected' });

		expect(outbound.urls.map(endpoint)).toEqual(['tokeninfo', 'account']);
		expect(actions.getConnectionState()).toMatchObject({ status: 'connected', details: { keyName: 'main' } });
		// The Settings row is repainted from that state, not left on "Sin comprobar".
		expect(actions.settingTab.refreshConnectionRow).toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		await world.plugin.shutdownRuntime();
	});

	it('a connected check in consult starts nothing of the collector: no detection, no proposals, no Halloween, no poll, no heartbeat', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const armLive = vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot');
		const halloweenActivate = vi.spyOn(HalloweenRuntime.prototype, 'activate');
		outbound.respond = validAccount;
		// Everything a collector would start is switched on.
		const world = collectorModePlugin({
			apiKeySecret: 'gw2-main', alertIngameEnabled: true, priceHistoryEnabled: true, halloweenEnabled: true,
		}, { mode: 'consult' });
		const arm = vi.spyOn(world.plugin, 'armAssistedDetection');
		const reconcile = vi.spyOn(world.plugin as unknown as ConsultConnectionActions, 'reconcilePendingProposals');
		await world.plugin.initializeRuntime();
		// The boot reconciles the proposal queue once it is open (in either mode): only what comes
		// after is the check's.
		await bootReconciled(reconcile);
		reconcile.mockClear();

		await world.plugin.checkConnection();
		await settle();

		expect(arm).not.toHaveBeenCalled();
		expect(reconcile).not.toHaveBeenCalled();
		expect(armLive).not.toHaveBeenCalled();
		expect(halloweenActivate).not.toHaveBeenCalled();
		// A consult boot arms no interval at all, so any here would be the check's.
		expect(world.intervals()).toEqual([]);
		expect(world.listen).not.toHaveBeenCalled();
		expect(world.writes).toEqual([]);
		expect(outbound.urls.map(endpoint)).toEqual(['tokeninfo', 'account']);
		await world.plugin.shutdownRuntime();
	});

	it('the collector\'s check still arms detection and reconciles its proposals, as before', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		outbound.respond = validAccount;
		// Booted without a key, so the collector's boot warm-up check (which arms detection and
		// reconciles too, and under load could land after `settle`) never runs; the key comes after.
		const world = collectorModePlugin({ apiKeySecret: '' }, { mode: 'collector' });
		const arm = vi.spyOn(world.plugin, 'armAssistedDetection').mockResolvedValue('unavailable');
		const reconcile = vi.spyOn(world.plugin as unknown as ConsultConnectionActions, 'reconcilePendingProposals');
		await world.plugin.initializeRuntime();
		await bootReconciled(reconcile);
		expect(arm).not.toHaveBeenCalled();
		world.plugin.settings.apiKeySecret = 'gw2-main';
		reconcile.mockClear();

		await expect(world.plugin.checkConnection()).resolves.toMatchObject({ status: 'connected' });

		// Both are started from inside the check, before it resolves.
		expect(arm).toHaveBeenCalledTimes(1);
		expect(reconcile).toHaveBeenCalledTimes(1);
		await world.plugin.shutdownRuntime();
	});

	it('the one-click inventory sync runs with a key nobody checked, and ends in success with no poll and no heartbeat', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		outbound.respond = validAccount;
		const world = collectorModePlugin({ apiKeySecret: 'gw2-main', alertIngameEnabled: true }, { mode: 'consult' });
		await world.plugin.initializeRuntime();
		await settle();
		// The advisor yields to the event loop between its passes (`yieldToEventLoop`), on a timer
		// this harness never fires: they resume on the next macrotask instead (a microtask would also
		// fire every request's timeout before its answer).
		(window as unknown as { setTimeout: unknown }).setTimeout = (callback: () => void) => setImmediate(callback);
		const actions = world.plugin as unknown as ConsultConnectionActions;
		const notify = vi.spyOn(world.plugin, 'notifyConsultMode');

		await actions.runInventoryVaultSync();
		await settle();

		expect(actions.getInventoryVaultSyncRunState()).toMatchObject({ status: 'idle', lastRun: { status: 'success', error: null } });
		// The capture verifies the key itself; it never needed "Comprobar conexión" first.
		expect(outbound.urls.map(endpoint)).toEqual(expect.arrayContaining(['tokeninfo', 'account', 'characters', 'account/inventory']));
		expect(actions.getConnectionState()).toEqual({ status: 'idle' });
		expect(notify).not.toHaveBeenCalled();
		// A consult boot arms no interval at all, so any here would be the sync's.
		expect(world.intervals()).toEqual([]);
		expect(world.notes.has(STATUS_NOTE)).toBe(false);
		expect(world.listen).not.toHaveBeenCalled();
		await world.plugin.shutdownRuntime();
	});
});

/** The path of a Guild Wars 2 request without `/v2/` or its query: `account/inventory`. */
function endpoint(url: string): string {
	return new URL(url).pathname.replace(/^\/v2\//u, '');
}

/** A valid key on an account with one empty character: what a real check and an empty sync read. */
function validAccount(url: string): { status: number; json: unknown } {
	const path = endpoint(url);
	if (path === 'tokeninfo') {
		return { status: 200, json: { id: 'key-1', name: 'main', permissions: ['account', 'inventories', 'characters', 'wallet', 'tradingpost', 'progression', 'unlocks', 'builds'] } };
	}
	if (path === 'account') {
		return { status: 200, json: { id: 'account-1', name: 'Hero.1234', world: 1001, created: '2020-01-01T00:00:00Z', access: ['GuildWars2'], commander: false } };
	}
	if (path === 'characters') return { status: 200, json: ['Hero'] };
	if (path.startsWith('characters/')) return { status: 200, json: { bags: [] } };
	if (path === 'commerce/delivery') return { status: 200, json: { coins: 0, items: [] } };
	return { status: 200, json: [] };
}

/**
 * Waits until the boot's own `reconcilePendingProposals` (after the proposal queue opens, a
 * fire-and-forget job of `initializeRuntime`) has run, then drains the rest. A fixed number of
 * `settle` rounds is not enough under load: the job can land after them, inside a count.
 */
async function bootReconciled(reconcile: { mock: { calls: unknown[] } }): Promise<void> {
	await vi.waitFor(() => { expect(reconcile.mock.calls.length).toBeGreaterThan(0); }, { timeout: 10_000 });
	await settle();
}

/** Drains the fire-and-forget work the boot leaves behind (IndexedDB and the first heartbeat). */
async function settle(): Promise<void> {
	for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function collectorModePlugin(
	overrides: Partial<TyrianSettings>,
	options: { readonly mode?: CollectorMode; readonly factory?: IDBFactory } = {},
) {
	const notes = new Map<string, string>();
	const writes: string[] = [];
	const saved: unknown[] = [];
	const files = (): TFile[] => [...notes.keys()].map((path) => Object.assign(new TFile(), { path }));
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()),
		getFiles: vi.fn(() => files()),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async (file: TFile) => notes.get(file.path) ?? ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => {
			notes.set(path, content);
			writes.push(path);
			return Object.assign(new TFile(), { path });
		}),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => {
			const updated = update(notes.get(file.path) ?? '');
			notes.set(file.path, updated);
			writes.push(file.path);
			return updated;
		}),
		fileManager: { trashFile: vi.fn(async () => { writes.push('trash'); }) },
	};
	const app = {
		vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager,
		secretStorage: { listSecrets: () => ['gw2-main'], getSecret: () => 'secret-value', setSecret: vi.fn() },
	} as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const { core } = obsidianPluginCore(app, manifest, { saveData: vi.fn(async (data: unknown) => { saved.push(data); }) });
	const target = core as unknown as CollectorModeHarness & {
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		settingTab: Record<string, () => void>;
	};
	target.settings = { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
	// The seed `onload` leaves; absent, `initializeRuntime` derives it from the settings.
	if (options.mode !== undefined) target.collectorMode = options.mode;
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	target.settingTab = {
		refreshForSettingsChange: vi.fn(), refreshConnectionRow: vi.fn(), refreshManagedAssetsRow: vi.fn(),
		refreshAlertIngameServerRow: vi.fn(), refreshSessionHistoryRow: vi.fn(), refreshForLocaleChange: vi.fn(),
	};

	const factory = options.factory ?? new IDBFactory();
	const intervals = new Map<number, number>();
	const cleared: number[] = [];
	let nextTimer = 1;
	vi.stubGlobal('window', {
		indexedDB: factory,
		setInterval: vi.fn((_callback: () => void, delayMs: number) => { intervals.set(nextTimer, delayMs); return nextTimer++; }),
		clearInterval: vi.fn((handle: number) => { cleared.push(handle); }),
		setTimeout: vi.fn(() => nextTimer++),
		clearTimeout: vi.fn(),
	});
	vi.stubGlobal('navigator', { onLine: true });

	const host = target.host;
	const listen = vi.spyOn(host.tcpServer, 'listen');
	const compactAndPrune = vi.fn();
	let openedStores = 0;
	const open = host.priceHistory.open.bind(host.priceHistory);
	vi.spyOn(host.priceHistory, 'open').mockImplementation(async (diagnostics) => {
		const store = await open(diagnostics);
		openedStores += 1;
		const compact = store.compactAndPrune.bind(store);
		return Object.assign(Object.create(store) as TyrianPriceHistoryStore, {
			compactAndPrune: async (...args: Parameters<TyrianPriceHistoryStore['compactAndPrune']>) => {
				compactAndPrune(...args);
				return await compact(...args);
			},
		});
	});

	return {
		plugin: target,
		factory,
		notes,
		writes,
		saved,
		listen,
		compactAndPrune,
		get openedStores() { return openedStores; },
		intervals: () => [...intervals.values()],
		intervalHandle: (delayMs: number) => [...intervals.entries()].find(([, delay]) => delay === delayMs)?.[0],
		cleared: () => cleared,
	};
}

function activeSession(): ActiveSessionState {
	const reference = {
		snapshotId: 'baseline-1', accountId: 'account-1', schemaVersion: 1,
		startedAt: '2026-09-28T08:00:00.000Z', completedAt: '2026-09-28T08:00:01.000Z', quality: 'complete',
	};
	return {
		version: 1, status: 'active', sessionId: 'session-1', authority: 'manual',
		requestedAt: '2026-09-28T08:00:00.000Z', baseline: reference,
	} as unknown as ActiveSessionState;
}
