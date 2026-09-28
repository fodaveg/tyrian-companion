import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

/** Every outbound request the composition makes, whoever makes it. */
const outbound = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	// What `ObsidianHost.environment` reads for the collector's footprint.
	apiVersion: '1.9.12',
	Platform: { isLinux: true, isMacOS: false, isWin: false },
	requestUrl: async ({ url }: { url: string }) => {
		outbound.urls.push(url);
		return { status: 503, headers: {}, json: {}, text: '{}' };
	},
}));

import TyrianCompanionPlugin, { type SettingsUpdateResult } from './main';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import type { TyrianHost, TyrianPriceHistoryStore } from './host/tyrian-host';
import { HalloweenRuntime } from './halloween/halloween-runtime';
import type { PriceHistoryRuntimeState } from './economy/price-history-runtime';
import { COLLECTOR_HEARTBEAT_INTERVAL_MS, parseCollectorStatusNote } from './runtime/collector-status';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import type { ActiveSessionState } from './sessions/session';

/**
 * R1b (SPEC-TYRIAN-EN-HEBRA.md section 4) against the real `initializeRuntime`: a consult
 * installation reads, and nothing else. No Guild Wars 2 request, no note or Base written, no
 * bridge port, no poll armed, no `compactAndPrune`. The collector boots exactly as before and adds
 * one thing: its footprint in the status note.
 */
interface CollectorModeHarness {
	settings: TyrianSettings;
	runtimeReady: boolean;
	initializeRuntime(): Promise<void>;
	shutdownRuntime(): Promise<void>;
	updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
	getPriceHistoryState(): PriceHistoryRuntimeState;
	readonly host: TyrianHost;
}

const STATUS_NOTE = 'Tyrian Companion/Collector status.md';

describe('collector and consult mode in the assembled runtime (R1b)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		outbound.urls.length = 0;
	});

	it('consult: boots with no request, no vault write, no bridge port, no poll and no compactAndPrune', async () => {
		const active = activeSession();
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(active);
		const armLive = vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot');
		const halloweenActivate = vi.spyOn(HalloweenRuntime.prototype, 'activate');
		// Everything that would do something for a collector is switched on.
		const world = collectorModePlugin({
			collectorMode: 'consult', apiKeySecret: 'gw2-main', alertIngameEnabled: true,
			priceHistoryEnabled: true, halloweenEnabled: true,
		});

		await world.plugin.initializeRuntime();
		await settle();

		expect(world.plugin.runtimeReady).toBe(true);
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

	it('collector: boots as before and writes its footprint in the status note, beating every fifteen minutes', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const world = collectorModePlugin({ collectorMode: 'collector', priceHistoryEnabled: true });

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

	it('switching to consult stops the heartbeat and the capture without a reload', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		const world = collectorModePlugin({ collectorMode: 'collector', priceHistoryEnabled: true });
		await world.plugin.initializeRuntime();
		await settle();
		const heartbeatHandle = world.intervalHandle(COLLECTOR_HEARTBEAT_INTERVAL_MS);
		const compactions = world.compactAndPrune.mock.calls.length;

		await expect(world.plugin.updateSettings({ collectorMode: 'consult' }))
			.resolves.toMatchObject({ status: 'saved' });
		await settle();

		expect(world.plugin.settings.collectorMode).toBe('consult');
		expect(world.cleared()).toContain(heartbeatHandle);
		expect(world.plugin.getPriceHistoryState().status).toBe('ready');
		expect(world.compactAndPrune.mock.calls.length).toBe(compactions);
		await world.plugin.shutdownRuntime();
	});

	it('refuses consult while a farming session is still open, and keeps collecting', async () => {
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(activeSession());
		vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue({ status: 'error' } as never);
		const world = collectorModePlugin({ collectorMode: 'collector' });
		await world.plugin.initializeRuntime();
		await settle();

		await expect(world.plugin.updateSettings({ collectorMode: 'consult' }))
			.resolves.toEqual({ status: 'blocked', reason: 'session_in_progress' });
		expect(world.plugin.settings.collectorMode).toBe('collector');
		expect(world.saved).toEqual([]);
		await world.plugin.shutdownRuntime();
	});
});

/** Drains the fire-and-forget work the boot leaves behind (IndexedDB and the first heartbeat). */
async function settle(): Promise<void> {
	// The real clock, not the stubbed `window` one: fake-indexeddb settles on Node's own timers.
	for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function collectorModePlugin(overrides: Partial<TyrianSettings>) {
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
	const plugin = new TyrianCompanionPlugin(app, manifest);
	const target = plugin as unknown as CollectorModeHarness & {
		app: App;
		manifest: PluginManifest;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		settingTab: Record<string, () => void>;
		registerEvent(event: unknown): void;
		saveData(data: unknown): Promise<void>;
	};
	target.app = app;
	target.manifest = manifest;
	target.settings = { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	target.registerEvent = vi.fn();
	target.saveData = vi.fn(async (data: unknown) => { saved.push(data); });
	target.settingTab = {
		refreshForSettingsChange: vi.fn(), refreshConnectionRow: vi.fn(), refreshManagedAssetsRow: vi.fn(),
		refreshAlertIngameServerRow: vi.fn(), refreshSessionHistoryRow: vi.fn(), refreshForLocaleChange: vi.fn(),
	};

	const intervals = new Map<number, number>();
	const cleared: number[] = [];
	let nextTimer = 1;
	vi.stubGlobal('window', {
		indexedDB: new IDBFactory(),
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
