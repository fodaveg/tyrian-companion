// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads,
// and without it the durable queue silently reports every write as failed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

/**
 * The live loot tracker resolves names and quotes through the public catalog at
 * observation time. Answering that here is what lets the test drive the real
 * composition instead of a hand-built alert.
 */
const publicApi = vi.hoisted(() => ({
	items: new Map<number, Record<string, unknown>>(),
	prices: new Map<number, Record<string, unknown>>(),
}));

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	requestUrl: async ({ url }: { url: string }) => {
		const ids = itemIdsFromUrl(url);
		if (ids === null) return { status: 404, headers: {}, json: [] };
		const source = url.includes('commerce/prices') ? publicApi.prices : publicApi.items;
		return { status: 200, headers: {}, json: ids.flatMap((id) => source.get(id) ?? []) };
	},
}));

import { compareStorageSnapshots } from './account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import TyrianCompanionPlugin from './main';
import { DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER } from './alerts/alert-contract';
import type { EmittedAlertRecordV1 } from './alerts/alert-queue-record';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { HALLOWEEN_PRICE_ALERT_ITEM_ID } from './halloween/halloween-price-alert';
import type { HalloweenPriceAlertRuntime } from './halloween/halloween-price-alert-runtime';
import type { PriceHistoryDailyV1 } from './economy/price-history-model';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import type { LiveSessionLootTracker } from './sessions/live-session-loot';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import type { ActiveSessionState, SessionSnapshotReference } from './sessions/session';

/**
 * Cabling of the four H13.10 assemblers, not their shape.
 *
 * Each test runs the real `initializeRuntime`, then makes the world do the thing
 * the feature exists for and looks at what the plugin ACTUALLY emitted. Nothing
 * reads the text of a module, so deleting the callback that connects a runtime
 * to `emitAlert` turns these red, which is the property a `readFileSync`
 * assertion over the same wiring cannot have.
 */
interface AssembledRuntimeHarness {
	settings: TyrianSettings;
	runtimeReady: boolean;
	initializeRuntime(): Promise<void>;
	getEmittedAlerts(): readonly EmittedAlertRecordV1[];
	halloweenAccountRef: string | null;
	halloweenPriceAlert: HalloweenPriceAlertRuntime | null;
	liveSessionLoot: LiveSessionLootTracker;
}

/** A quote whose net value clears the shipped threshold on three copies, and not on one. */
const BID_COPPER = 30_000;
const GAINED = 3;
const NET_TOTAL_COPPER = Math.floor(BID_COPPER * 0.85) * GAINED;

describe('H13.10 valuable loot cabling', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		publicApi.items.clear();
		publicApi.prices.clear();
	});

	it('turns an observed live gain into a valuable_loot alert in the durable queue', async () => {
		seedCatalog();
		const plugin = await bootedPlugin();

		await plugin.liveSessionLoot.observe('session-1', valuableGain());

		await vi.waitFor(() => {
			expect(plugin.getEmittedAlerts()).toHaveLength(1);
		});
		expect(plugin.getEmittedAlerts()[0]).toMatchObject({
			kind: 'valuable_loot',
			itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID,
			quantity: GAINED,
			totalCopper: NET_TOTAL_COPPER,
			reason: 'valuable',
		});
		expect(NET_TOTAL_COPPER).toBeGreaterThanOrEqual(DEFAULT_VALUABLE_LOOT_THRESHOLD_COPPER);
	});

	it('emits nothing for a gain under the threshold, so the cabling is not a pass-through', async () => {
		seedCatalog();
		const plugin = await bootedPlugin();
		plugin.settings.valuableLootThresholdCopper = NET_TOTAL_COPPER + 1;

		await plugin.liveSessionLoot.observe('session-1', valuableGain());

		expect(plugin.getEmittedAlerts()).toHaveLength(0);
	});
});

describe('H13.10 Halloween price alert cabling', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		publicApi.items.clear();
		publicApi.prices.clear();
	});

	it('turns a below-to-high p90 crossing into a sell_signal alert in the durable queue', async () => {
		const plugin = await bootedPlugin();
		plugin.settings.language = 'es';
		plugin.halloweenAccountRef = 'account';
		const priceAlert = plugin.halloweenPriceAlert;
		if (priceAlert === null) throw new Error('The composition must build the price alert runtime.');
		await priceAlert.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);

		// A crossing needs a durable "below" first: one reading under the p90, then one over it.
		await priceAlert.evaluate(readDaily(20), CROSSING_NOW);
		await priceAlert.evaluate(readDaily(40, CROSSING_NOW + 1), CROSSING_NOW + 1);

		expect(priceAlert.getState().status).toBe('unread');
		await vi.waitFor(() => {
			expect(plugin.getEmittedAlerts()).toHaveLength(1);
		});
		expect(plugin.getEmittedAlerts()[0]).toMatchObject({
			kind: 'sell_signal',
			itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID,
			quantity: 1,
			name: 'Bolsa de truco o trato',
			reason: 'bid_above_reference',
		});
	});

	it('emits nothing while the price stays below its p90, so the cabling is not a pass-through', async () => {
		const plugin = await bootedPlugin();
		plugin.halloweenAccountRef = 'account';
		const priceAlert = plugin.halloweenPriceAlert;
		if (priceAlert === null) throw new Error('The composition must build the price alert runtime.');
		await priceAlert.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);

		await priceAlert.evaluate(readDaily(20), CROSSING_NOW);
		await priceAlert.evaluate(readDaily(21, CROSSING_NOW + 1), CROSSING_NOW + 1);

		expect(plugin.getEmittedAlerts()).toHaveLength(0);
	});
});

const CROSSING_NOW = Date.parse('2026-10-31T12:00:00.000Z');

/** Thirty rising days plus today's close, exactly like the runtime's own suite builds it. */
function readDaily(today: number, capturedAtMs = CROSSING_NOW): { readDaily: () => Promise<PriceHistoryDailyV1[]> } {
	const daily = (timestamp: number, closeCopper: number): PriceHistoryDailyV1 => ({
		version: 1, vaultId: 'vault', itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID,
		dayUtc: new Date(timestamp).toISOString().slice(0, 10),
		snapshotCount: 1, partialSnapshotCount: 0,
		bid: {
			count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2,
			closeCopper, closeCapturedAtMs: timestamp,
		},
		ask: null,
	});
	return {
		readDaily: async () => [
			...Array.from({ length: 30 }, (_, index) => daily(CROSSING_NOW - (30 - index) * 86_400_000, index + 1)),
			daily(capturedAtMs, today),
		],
	};
}

function seedCatalog(): void {
	publicApi.items.set(HALLOWEEN_PRICE_ALERT_ITEM_ID, {
		id: HALLOWEEN_PRICE_ALERT_ITEM_ID, name: 'Bolsa de truco o trato',
	});
	publicApi.prices.set(HALLOWEEN_PRICE_ALERT_ITEM_ID, {
		id: HALLOWEEN_PRICE_ALERT_ITEM_ID,
		whitelisted: true,
		buys: { quantity: 10_000, unit_price: BID_COPPER },
		sells: { quantity: 10_000, unit_price: BID_COPPER * 2 },
	});
}

/** One positive delta of the bag, as the assisted poll would hand it to the tracker. */
function valuableGain(): ReturnType<typeof compareStorageSnapshots> {
	const baseline = storageDeltaSnapshot();
	const final = afterSnapshot({
		holdings: [
			...baseline.holdings,
			looseHolding(HALLOWEEN_PRICE_ALERT_ITEM_ID, GAINED, { source: 'bank', slot: 1 }),
		],
	});
	const delta = compareStorageSnapshots(baseline, final);
	if (delta.status === 'invalid') throw new Error('Valuable-gain fixture is invalid.');
	return delta;
}

/** Boots the real composition against a restored active session, so live observation is armed. */
async function bootedPlugin(): Promise<AssembledRuntimeHarness> {
	const record = activeSessionRecord();
	vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
	vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(record.state);
	vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
	vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue({
		status: 'armed', armedAt: '2026-09-01T08:00:00.000Z', lastSnapshotAt: record.baselineSnapshot.completedAt,
		scheduler: {
			status: 'scheduled', intervalMs: 300_000, nextRunAt: Date.now() + 300_000,
			lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0,
		},
	});
	const plugin = assembledRuntimePlugin(new IDBFactory());
	await plugin.initializeRuntime();
	expect(plugin.runtimeReady).toBe(true);
	return plugin;
}

function assembledRuntimePlugin(factory: IDBFactory): AssembledRuntimeHarness {
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
	const target = plugin as unknown as AssembledRuntimeHarness & {
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

function activeSessionRecord(): { state: ActiveSessionState; baselineSnapshot: ReturnType<typeof storageDeltaSnapshot> } {
	const baselineSnapshot = storageDeltaSnapshot();
	const reference = (snapshot: typeof baselineSnapshot): SessionSnapshotReference => ({
		snapshotId: snapshot.snapshotId,
		accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt,
		completedAt: snapshot.completedAt,
		quality: snapshot.quality as SessionSnapshotReference['quality'],
	});
	const state: ActiveSessionState = {
		version: 1,
		status: 'active',
		sessionId: 'session-1',
		authority: {
			machineId: 'machine-1', instanceId: 'instance-1', sessionId: 'session-1', fence: 1,
			acquiredAt: Date.parse('2026-08-13T07:59:59.000Z'),
		},
		requestedAt: '2026-08-13T07:59:59.500Z',
		baseline: reference(baselineSnapshot),
		startContext: {
			characterName: 'Astra Uno',
			magicFind: { value: 321, source: 'manual' },
			build: {
				tab: 1, name: 'Farm', profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] }, { id: 52, traits: [4, 5, 6] }, { id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
	};
	return { state, baselineSnapshot };
}

function itemIdsFromUrl(url: string): number[] | null {
	const ids = new URL(url, 'https://api.guildwars2.com').searchParams.get('ids');
	return ids === null ? null : ids.split(',').map(Number);
}
