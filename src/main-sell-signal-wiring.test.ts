// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads,
// and without it the durable queue silently reports every write as failed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import TyrianCompanionPlugin from './main';
import { ObsidianRequestTransport } from './core/obsidian-http';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import { storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import type { EmittedAlertRecordV1 } from './alerts/alert-queue-record';
import type { PriceHistoryDailyV1 } from './economy/price-history-model';
import { PRICE_SEED_MAX_RESPONSE_BYTES } from './economy/price-seed-source';
import type { SellSignalRuntimeState } from './economy/sell-signal-runtime';
import { trickOrTreatBagHistoryRecords } from './economy/__fixtures__/trick-or-treat-bag-history';

/**
 * Cabling, not shape.
 *
 * Every assertion here runs the real `initializeRuntime` composition and then
 * observes what the plugin DOES: whether a sell decision reaches the one exit
 * point and lands in the durable queue, which host call the seed goes out on,
 * and what happens when that call fails. Nothing reads the text of `main.ts`.
 *
 * That distinction is the whole reason this file exists. This repository
 * already carries 34 tests that `readFileSync` another module and assert over
 * its characters; every one of them stays green with the function underneath
 * deleted, which is exactly the failure H13.2 must not ship with, because a
 * price alert that is never called looks identical to one that never fires.
 */
interface SellSignalWiringHarness {
	settings: TyrianSettings;
	initializeRuntime(): Promise<void>;
	getEmittedAlerts(): readonly EmittedAlertRecordV1[];
	sellSignal: { getState(): SellSignalRuntimeState } | null;
	evaluateSellSignal(port: { nowMs: number; readDaily: () => Promise<PriceHistoryDailyV1[]> }): Promise<void>;
}

/** Puts the plugin in the only state that is allowed to reach the network. */
function activate(): void {
	vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue({ status: 'active' } as never);
}

/** A day on which the published series clears 90 % of its annual maximum. */
const SELL_DAY_MS = Date.parse('2026-05-31T12:00:00.000Z');
/** A day on which it clears neither bound. */
const QUIET_DAY_MS = Date.parse('2026-09-03T12:00:00.000Z');

describe('H13.2 sell signal cabling', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('builds the detector from the curated pack when the runtime composes', async () => {
		const plugin = sellSignalPlugin(new IDBFactory());

		await plugin.initializeRuntime();

		expect(plugin.sellSignal, 'the pack is valid today, so the detector must exist').not.toBeNull();
		expect(plugin.sellSignal?.getState().seedStatus).toBe('unseeded');
	});

	it('seeds from datawars2 through the reviewed transport, with no key and no account id', async () => {
		const send = vi.spyOn(ObsidianRequestTransport.prototype, 'send')
			.mockResolvedValue({ status: 200, headers: {}, body: trickOrTreatBagHistoryRecords() });
		const plugin = sellSignalPlugin(new IDBFactory());
		await plugin.initializeRuntime();
		activate();

		await plugin.evaluateSellSignal({ nowMs: QUIET_DAY_MS, readDaily: async () => [] });

		const seedCalls = send.mock.calls.filter(([request]) => request.endpoint === 'price_history_seed');
		expect(seedCalls).toHaveLength(1);
		expect(seedCalls[0]?.[0]).toEqual({
			url: 'https://api.datawars2.ie/gw2/v1/history?itemID=36038',
			method: 'GET',
			endpoint: 'price_history_seed',
			maxResponseBytes: PRICE_SEED_MAX_RESPONSE_BYTES,
		});
		expect(plugin.sellSignal?.getState()).toMatchObject({ seedStatus: 'seeded', seedDayCount: 399 });
	});

	it('a sell decision reaches emitAlert and lands in the durable queue', async () => {
		vi.spyOn(ObsidianRequestTransport.prototype, 'send')
			.mockResolvedValue({ status: 200, headers: {}, body: trickOrTreatBagHistoryRecords() });
		const plugin = sellSignalPlugin(new IDBFactory());
		await plugin.initializeRuntime();
		activate();
		// The gain is measured on the stack the session has observed, and this
		// harness has observed none, so the quantity is supplied here.
		vi.spyOn(plugin as unknown as { observedBagQuantity(): number }, 'observedBagQuantity').mockReturnValue(500);

		await plugin.evaluateSellSignal({ nowMs: SELL_DAY_MS, readDaily: async () => [] });

		await vi.waitFor(() => {
			expect(plugin.getEmittedAlerts()).toHaveLength(1);
		});
		expect(plugin.getEmittedAlerts()[0]).toMatchObject({
			kind: 'sell_signal',
			itemId: 36_038,
			quantity: 500,
			// The ABSOLUTE gain, not the quote and not a ratio: 105 copper a bag
			// over the annual floor, on 500 bags.
			totalCopper: 52_500,
			reason: 'bid_above_reference',
		});
	});

	it('emits nothing on a day the rule does not fire, so the cabling is not a pass-through', async () => {
		vi.spyOn(ObsidianRequestTransport.prototype, 'send')
			.mockResolvedValue({ status: 200, headers: {}, body: trickOrTreatBagHistoryRecords() });
		const plugin = sellSignalPlugin(new IDBFactory());
		await plugin.initializeRuntime();
		activate();
		vi.spyOn(plugin as unknown as { observedBagQuantity(): number }, 'observedBagQuantity').mockReturnValue(500);

		await plugin.evaluateSellSignal({ nowMs: QUIET_DAY_MS, readDaily: async () => [] });

		expect(plugin.getEmittedAlerts()).toHaveLength(0);
	});

	it('declares "no seed" and stays up when datawars2 is unreachable', async () => {
		vi.spyOn(ObsidianRequestTransport.prototype, 'send')
			.mockRejectedValue(new Error('network down'));
		const plugin = sellSignalPlugin(new IDBFactory());
		await plugin.initializeRuntime();
		activate();

		await expect(plugin.evaluateSellSignal({ nowMs: SELL_DAY_MS, readDaily: async () => [] }))
			.resolves.toBeUndefined();
		expect(plugin.sellSignal?.getState()).toMatchObject({ seedStatus: 'no_seed', seedFailure: 'unreachable' });
		expect(plugin.getEmittedAlerts()).toHaveLength(0);
	});

	it('does not seed while no session is active', async () => {
		const send = vi.spyOn(ObsidianRequestTransport.prototype, 'send')
			.mockResolvedValue({ status: 200, headers: {}, body: trickOrTreatBagHistoryRecords() });
		const plugin = sellSignalPlugin(new IDBFactory());
		await plugin.initializeRuntime();

		await plugin.evaluateSellSignal({ nowMs: SELL_DAY_MS, readDaily: async () => [] });

		expect(send.mock.calls.filter(([request]) => request.endpoint === 'price_history_seed')).toHaveLength(0);
		expect(plugin.sellSignal?.getState().seedStatus).toBe('unseeded');
	});
});

function sellSignalPlugin(factory: IDBFactory): SellSignalWiringHarness {
	// The durable queue derives its account scope from the baseline. The session
	// starts idle so `initializeRuntime` composes the way a real load does; the
	// tests that need a live session call `activate` afterwards.
	vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
	vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue({ status: 'idle' } as never);
	vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(storageDeltaSnapshot());

	const notes = new Map<string, string>();
	const files = (): TFile[] => [...notes.keys()].map((path) => Object.assign(new TFile(), { path }));
	const vault = {
		configDir: 'test-config-dir',
		adapter: { getBasePath: () => '/test/vault' },
		getName: () => 'test-vault',
		getAbstractFileByPath: vi.fn((path: string) => files().find((file) => file.path === path) ?? null),
		getMarkdownFiles: vi.fn(() => files()),
		on: vi.fn(() => ({ off: () => undefined })),
		read: vi.fn(async (file: TFile) => notes.get(file.path) ?? ''),
		createFolder: vi.fn(async () => undefined),
		create: vi.fn(async (path: string, content: string) => {
			notes.set(path, content);
			return Object.assign(new TFile(), { path });
		}),
		process: vi.fn(async (file: TFile, update: (content: string) => string) => {
			const updated = update(notes.get(file.path) ?? '');
			notes.set(file.path, updated);
			return updated;
		}),
		fileManager: { trashFile: vi.fn(async () => undefined) },
	};
	const app = {
		vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager,
	} as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const plugin = new TyrianCompanionPlugin(app, manifest);
	const target = plugin as unknown as SellSignalWiringHarness & {
		app: App;
		manifest: PluginManifest;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		registerEvent(event: unknown): void;
	};
	target.app = app;
	target.manifest = manifest;
	target.settings = structuredClone(DEFAULT_SETTINGS);
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	target.registerEvent = vi.fn();

	vi.stubGlobal('window', {
		indexedDB: factory,
		setInterval: vi.fn(() => 1),
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
	});
	vi.stubGlobal('navigator', { onLine: true });

	return target;
}
