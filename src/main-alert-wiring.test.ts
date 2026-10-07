// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads,
// and without it the durable queue silently reports every write as failed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { obsidianPluginCore } from './test/obsidian-host-harness';
import type { TyrianHost } from './host/tyrian-host';
import type { SettingsUpdateResult } from './runtime/tyrian-companion-core';
import { ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS, type AlertV1 } from './alerts/alert-contract';
import type { AlertDeliveryReport } from './alerts/alert-emitter';
import type { AlertIngameServerHandle } from './alerts/alert-ingame-server';
import type { EmittedAlertRecordV1 } from './alerts/alert-queue-record';
import type { AlertDeliveryRecordV1 } from './alerts/alert-delivery-record';
import { alertReceiptView } from './ui/alert-delivery-steps';
import { createTranslator } from './core/i18n';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import type { ActiveSessionState, SessionSnapshotReference, SessionState } from './sessions/session';
import { DEFAULT_FARMING_PREPARATION, type FarmingPreparationSettingsV1 } from './sessions/farming-goal-preparation';
import type { FarmingPreparationContext } from './sessions/farming-goal-preparation';
import { ingamePresenceSnapshot, initialIngamePresenceState, type IngamePresenceSnapshot } from './alerts/alert-ingame-presence';
import type { FarmingGoalV1, FarmingGoalProgress } from './sessions/farming-goal';
import type { FarmingGroupContext } from './runtime/farming-session-context';
import type { LiveSessionLootState } from './sessions/live-session-loot';
import { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import type { LiveSessionViewV1 } from './sessions/live-session-model';

/**
 * Cabling, not shape.
 *
 * Every assertion here runs the real `initializeRuntime` composition and observes
 * what it DOES: which cadence the poll is armed with, which host APIs the alert
 * reaches, what the durable queue ends up holding. Nothing reads the text of
 * `main.ts`, which is the failure mode this repo already pays for 34 times over:
 * such a test stays green with the function dead.
 */
interface AlertWiringHarness {
	readonly host: TyrianHost;
	settings: TyrianSettings;
	runtimeReady: boolean;
	initializeRuntime(): Promise<void>;
	startManualSession(input: unknown): Promise<void>;
	emitAlert(alert: AlertV1): Promise<AlertDeliveryReport>;
	getEmittedAlerts(): readonly EmittedAlertRecordV1[];
	getAlertDeliveries(): ReadonlyMap<string, AlertDeliveryRecordV1>;
	getLiveSessionLoot(): LiveSessionLootState;
	getLiveSessionView(): LiveSessionViewV1;
	getFarmingGoalProgress(): FarmingGoalProgress | null;
	getFarmingPreparationContext(): FarmingPreparationContext;
	getIngamePresence(): IngamePresenceSnapshot;
	setFarmingGroupContext(context: FarmingGroupContext): void;
	saveFarmingGoal(goal: FarmingGoalV1): Promise<void>;
	saveFarmingPreparationSettings(settings: FarmingPreparationSettingsV1): Promise<void>;
	getAssistedDetectionState(): { status: string };
	updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
}

const VALUABLE: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Saco de Halloween', quantity: 3,
	totalCopper: 120_000, priceStatus: 'known', reason: 'valuable',
};

describe('H13.3 loot poll cabling', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('captures next-session intent before an asynchronous start and restores it without adopting changed defaults', async () => {
		const record = activeSessionRecord();
		const local = new Map<string, unknown>();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(record.state);
		const plugin = alertWiringPlugin(new IDBFactory(), {}, local);
		await plugin.initializeRuntime();
		plugin.settings.farmingGoal = { version: 1, kind: 'bags', targetBags: 123 };
		plugin.setFarmingGroupContext('without_bosses');
		vi.spyOn(ManualSessionStartService.prototype, 'start').mockImplementation(async () => {
			plugin.settings.farmingGoal = { version: 1, kind: 'bags', targetBags: 999 };
			plugin.setFarmingGroupContext('with_bosses');
			return { status: 'started', state: record.state } as never;
		});
		await plugin.startManualSession({ characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 });
		expect(local.get('tyrian-farming-session')).toMatchObject({ sessionId: record.state.sessionId,
			goal: { version: 1, kind: 'bags', targetBags: 123 }, groupContext: 'without_bosses', sampleCount: 1 });
		expect(plugin.getFarmingGoalProgress()?.goal).toEqual({ version: 1, kind: 'bags', targetBags: 123 });
		const reloaded = alertWiringPlugin(new IDBFactory(), {}, local);
		await reloaded.initializeRuntime();
		reloaded.settings.farmingGoal = { version: 1, kind: 'none' };
		expect(reloaded.getFarmingGoalProgress()?.goal).toEqual({ version: 1, kind: 'bags', targetBags: 123 });
	});

	it('keeps the captured session character separate from current character bag capacity', async () => {
		const record = activeSessionRecord();
		const snapshot = storageDeltaSnapshot({
			completedAt: record.baselineSnapshot.completedAt,
			freeSlots: { bank: null, sharedInventory: null, characterBags: [{ character: 'Astra Uno', bagIndex: 0, bagItemId: 1, free: 7, total: 20 }] },
		});
		const session = { ...record.state, startContext: { ...record.state.startContext, characterName: 'Captured A' } };
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(session);
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(snapshot);
		const plugin = alertWiringPlugin(new IDBFactory());
		await plugin.initializeRuntime();
		vi.spyOn(plugin, 'getIngamePresence').mockReturnValue({ ...ingamePresenceSnapshot(initialIngamePresenceState()),
			status: 'present', context: { source: 'nexus', state: 'gameplay', character: 'Astra Uno', mapId: 866, labyrinth: true } });
		expect(plugin.getFarmingPreparationContext()).toMatchObject({
			characterName: 'Captured A', buildName: 'Farm', freeBagSlots: 7, freeBagSlotsCharacter: 'Astra Uno',
			freeBagSlotsObservedAt: snapshot.completedAt,
		});
	});

	it('serializes goal and preparation preference writes and reports a blocked save as failure', async () => {
		const plugin = alertWiringPlugin(new IDBFactory());
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		const update = vi.spyOn(plugin, 'updateSettings').mockImplementationOnce(async () => {
			await pending;
			return { status: 'saved', inventoryAdvisor: 'unchanged' };
		}).mockResolvedValue({ status: 'saved', inventoryAdvisor: 'unchanged' });
		const goal = plugin.saveFarmingGoal({ version: 1, kind: 'bags', targetBags: 1_000 });
		const prep = plugin.saveFarmingPreparationSettings({ ...DEFAULT_FARMING_PREPARATION, enabled: true });
		await Promise.resolve();
		expect(update).toHaveBeenCalledTimes(1);
		finish();
		await Promise.all([goal, prep]);
		expect(update).toHaveBeenCalledTimes(2);
		update.mockResolvedValueOnce({ status: 'blocked', reason: 'runtime_starting' });
		await expect(plugin.saveFarmingGoal({ version: 1, kind: 'none' })).rejects.toThrow('unavailable');
	});

	it('arms the loot poll at five minutes on a manual start before assisted detection has armed', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const sessionState = vi.spyOn(ManualSessionStartService.prototype, 'getState')
			.mockReturnValue({ status: 'idle' } as SessionState);
		vi.spyOn(ManualSessionStartService.prototype, 'start')
			.mockResolvedValue({ status: 'started', state: record.state } as never);
		const arm = vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue(armedState());
		const plugin = alertWiringPlugin(new IDBFactory());

		await plugin.initializeRuntime();
		expect(arm, 'load must not poll: there is no active session').not.toHaveBeenCalled();
		expect(plugin.getLiveSessionLoot()).toMatchObject({ status: 'idle' });

		sessionState.mockReturnValue(record.state);
		await plugin.startManualSession({ characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null } });

		expect(arm).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: record.baselineSnapshot.snapshotId }),
			ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS,
		);
		expect(ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS)
			.toBeLessThan(DEFAULT_SETTINGS.pollingIntervalMinutes * 60_000);
		expect(plugin.getLiveSessionLoot()).toMatchObject({ status: 'observing', sessionId: 'session-1' });
	});
});

describe('H13.4 alert channel cabling', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('reaches the toast, the desktop banner, the speakers and the durable queue', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const banners: { title: string; options: Record<string, unknown> }[] = [];
		const audioContexts: number[] = [];
		const plugin = alertWiringPlugin(new IDBFactory(), {
			Notification: function Notification(title: string, options: Record<string, unknown>) {
				banners.push({ title, options });
			},
			AudioContext: function AudioContext() { audioContexts.push(1); return fakeAudioContext(); },
		});
		plugin.settings.language = 'es';

		await plugin.initializeRuntime();
		const report = await plugin.emitAlert(VALUABLE);

		expect(report.rejected).toBe(false);
		// `ingame` ships disabled: like the empty-URL webhook, an off channel is a
		// silent success rather than a failure the player has to explain to themselves.
		expect([...report.delivered].sort())
			.toEqual(['ingame', 'queue', 'sound', 'system_notification', 'toast', 'webhook']);
		expect(banners).toHaveLength(1);
		expect(banners[0]?.title).toBe('Objeto valioso observado');
		expect(banners[0]?.options.body).toContain('Saco de Halloween');
		expect(audioContexts).toHaveLength(1);
		await vi.waitFor(() => {
			expect(plugin.getEmittedAlerts()).toHaveLength(1);
		});
		expect(plugin.getEmittedAlerts()[0]).toMatchObject({
			kind: 'valuable_loot', itemId: 36_038, quantity: 3, totalCopper: 120_000, reason: 'valuable',
		});
	});

	it('still delivers the toast and the queue when the desktop and the speakers are gone', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const plugin = alertWiringPlugin(new IDBFactory(), {
			Notification: Object.assign(function Notification() { /* denied below */ }, { permission: 'denied' }),
		});

		const report = await (async () => {
			await plugin.initializeRuntime();
			return await plugin.emitAlert(VALUABLE);
		})();

		expect([...report.failed].map((entry) => entry.id).sort()).toEqual(['sound', 'system_notification']);
		expect([...report.delivered].sort()).toEqual(['ingame', 'queue', 'toast', 'webhook']);
		await vi.waitFor(() => {
			expect(plugin.getEmittedAlerts()).toHaveLength(1);
		});
	});

	it('fails the in-game channel when it is enabled but no addon is connected', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const plugin = alertWiringPlugin(new IDBFactory());
		plugin.settings.alertIngameEnabled = true;
		plugin.settings.alertIngamePort = 0;

		await plugin.initializeRuntime();
		const report = await plugin.emitAlert(VALUABLE);

		// Enabled but unreachable must NOT read as success: the whole point of this
		// channel is a banner inside the game, and a swallowed failure here is a
		// banner the player never gets shown with nothing in the report to say why.
		expect(report.failed.map((entry) => entry.id)).toContain('ingame');
		expect(report.delivered).not.toContain('ingame');

		// Port 0 really opens a loopback listener; close it so the suite does not
		// leak a socket per run.
		await (plugin as unknown as { alertIngameServer: { close(): Promise<void> } | null }).alertIngameServer?.close();
	});

	it('opens the in-game server the moment the setting turns on, with no alert in between', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const plugin = alertWiringPlugin(new IDBFactory());
		const server = () => (plugin as unknown as { alertIngameServer: AlertIngameServerHandle | null }).alertIngameServer;

		// Ships off by default: loading the plugin with the channel disabled must not
		// open a socket at all.
		await plugin.initializeRuntime();
		expect(server()).toBeNull();

		// `updateSettings` sends the port through the same sanitizer the plugin loads settings
		// with (`alertIngamePortValue`), and that sanitizer discards `0` back to the default
		// port, 47823, rather than treating it as "let the OS pick one" the way `net.createServer`
		// does. Asking for a real free port here, and passing that concrete number through,
		// is what a caller outside this test suite (the settings tab) would have to do too:
		// there is no "ephemeral" spelling this setting accepts.
		const port = await freeLoopbackPort();
		try {
			await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: port });
			// No `emitAlert` call anywhere above: this is the whole point of the fix. The old
			// behaviour only opened the listener from inside `deliver`, so the addon had nothing
			// to connect to until the first alert, and that alert then found `clientCount() === 0`
			// and was reported `failed`.
			await vi.waitFor(() => { expect(server()).not.toBeNull(); });
			const handle = server();
			if (handle === null) throw new Error('unreachable: waited for a non-null handle above');

			// The listener is real and reachable from outside the process, exactly the way the
			// Nexus addon reaches it; this is not just a truthy internal field. Since H18.23 the
			// addon counts only once it presents the secret the plugin stored in SecretStorage.
			const client = await connectLoopback(handle.port);
			client.write(ingameHello(await pluginBridgeSecret(plugin)));
			await vi.waitFor(() => { expect(handle.clientCount()).toBe(1); });
			client.destroy();

			await plugin.updateSettings({ alertIngameEnabled: false });
			await vi.waitFor(() => { expect(server()).toBeNull(); });
		} finally {
			await server()?.close();
		}
	});

	it('H18.22: a connected addon that never said hello does not make the in-game channel delivered', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const plugin = alertWiringPlugin(new IDBFactory());
		const server = () => (plugin as unknown as { alertIngameServer: AlertIngameServerHandle | null }).alertIngameServer;
		await plugin.initializeRuntime();
		const port = await freeLoopbackPort();
		try {
			await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: port });
			await vi.waitFor(() => { expect(server()).not.toBeNull(); });
			const mute = await connectLoopback(port);
			// A token that is not the configured one is just another connection that never
			// authenticated: it must not count either.
			const intruder = await connectLoopback(port);
			const refused = new Promise((resolve) => { intruder.once('close', resolve); });
			// Flowing mode: a paused socket never reads the server's FIN, so it would never close.
			intruder.resume();
			intruder.write(ingameHello('y'.repeat(43)));
			// The plugin closes it for the wrong secret; waiting for that makes the report below
			// observe a settled handshake instead of racing the hello.
			await refused;

			const report = await plugin.emitAlert(VALUABLE);

			expect(report.failed.map((entry) => entry.id)).toContain('ingame');
			expect(report.delivered).not.toContain('ingame');
			mute.destroy();
			intruder.destroy();
		} finally {
			await server()?.close();
		}
	});

	it('H18.23: an authenticated addon context reaches the plugin presence store', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const plugin = alertWiringPlugin(new IDBFactory()) as AlertWiringHarness & {
			getIngamePresence(): { status: string; context: unknown };
			onIngamePresence(listener: (event: { kind: string }) => void): () => void;
		};
		const server = () => (plugin as unknown as { alertIngameServer: AlertIngameServerHandle | null }).alertIngameServer;
		const heard: string[] = [];
		plugin.onIngamePresence((event) => { heard.push(event.kind); });
		await plugin.initializeRuntime();
		const port = await freeLoopbackPort();
		try {
			await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: port });
			await vi.waitFor(() => { expect(server()).not.toBeNull(); });
			const addon = await connectLoopback(port);
			addon.setEncoding('utf8');
			const welcome = new Promise<string>((resolve) => { addon.once('data', (chunk: string) => { resolve(chunk); }); });
			addon.write(ingameHello(await pluginBridgeSecret(plugin)));
			const { nonce } = JSON.parse(await welcome) as { nonce: string };
			addon.write(`${JSON.stringify({ v: 2, type: 'context', nonce, seq: 0, state: 'gameplay', mapId: 866, character: 'Astra Uno' })}\n`);

			await vi.waitFor(() => { expect(plugin.getIngamePresence().status).toBe('present'); });
			expect(plugin.getIngamePresence().context).toMatchObject({ mapId: 866, labyrinth: true, source: 'nexus' });
			expect(heard).toEqual(['started']);
			addon.destroy();
		} finally {
			await server()?.close();
		}
	});

	it('an addon entering gameplay starts one passive connection session without invoking account capture', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const sessionState = vi.spyOn(ManualSessionStartService.prototype, 'getState')
			.mockReturnValue({ status: 'idle' } as SessionState);
		const start = vi.spyOn(ManualSessionStartService.prototype, 'start').mockImplementation(async () => {
			sessionState.mockReturnValue(record.state);
			return { status: 'started', state: record.state } as never;
		});
		const liveStart = vi.spyOn(LiveSessionLifecycle.prototype,'start');
		vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue(armedState());
		const plugin = alertWiringPlugin(new IDBFactory());
		plugin.host.secrets.set('gw2-key', 'synthetic-gw2-key');
		plugin.settings.apiKeySecret = 'gw2-key';
		const server = () => (plugin as unknown as { alertIngameServer: AlertIngameServerHandle | null }).alertIngameServer;
		await plugin.initializeRuntime();
		const port = await freeLoopbackPort();
		try {
			await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: port });
			await vi.waitFor(() => { expect(server()).not.toBeNull(); });
			const addon = await connectLoopback(port);
			addon.setEncoding('utf8');
			const welcome = new Promise<string>((resolve) => { addon.once('data', (chunk: string) => { resolve(chunk); }); });
			addon.write(ingameHello(await pluginBridgeSecret(plugin)));
			const { nonce } = JSON.parse(await welcome) as { nonce: string };
			addon.write(`${JSON.stringify({ v: 2, type: 'context', nonce, seq: 0, state: 'gameplay', mapId: 866, character: 'Astra Uno' })}\n`);
			addon.write(`${JSON.stringify({ v: 2, type: 'context', nonce, seq: 1, state: 'gameplay', mapId: 50, character: 'Astra Dos' })}\n`);

			await vi.waitFor(() => { expect(plugin.getLiveSessionView().phase).toBe('active'); });
			expect(liveStart).toHaveBeenCalledOnce(); expect(liveStart).toHaveBeenCalledWith('Astra Uno');
			expect(start).not.toHaveBeenCalled(); expect(plugin.getLiveSessionView()).toMatchObject({observationCount:0,sourceState:'missing'});
			addon.destroy();
		} finally {
			await server()?.close();
		}
	});

	it('without an API key addon gameplay starts a passive session while missing inventory remains unmeasured', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue({ status: 'idle' } as SessionState);
		const start = vi.spyOn(ManualSessionStartService.prototype, 'start');
		const plugin = alertWiringPlugin(new IDBFactory()) as AlertWiringHarness & {
			getIngamePresence(): { status: string };
		};
		const server = () => (plugin as unknown as { alertIngameServer: AlertIngameServerHandle | null }).alertIngameServer;
		await plugin.initializeRuntime();
		const port = await freeLoopbackPort();
		try {
			await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: port });
			await vi.waitFor(() => { expect(server()).not.toBeNull(); });
			const addon = await connectLoopback(port);
			addon.setEncoding('utf8');
			const welcome = new Promise<string>((resolve) => { addon.once('data', (chunk: string) => { resolve(chunk); }); });
			addon.write(ingameHello(await pluginBridgeSecret(plugin)));
			const { nonce } = JSON.parse(await welcome) as { nonce: string };
			addon.write(`${JSON.stringify({ v: 2, type: 'context', nonce, seq: 0, state: 'gameplay', mapId: 50, character: 'Astra Uno' })}\n`);

			await vi.waitFor(() => { expect(plugin.getIngamePresence().status).toBe('present'); });
			await vi.waitFor(() => { expect(plugin.getLiveSessionView().phase).toBe('active'); });
			expect(start).not.toHaveBeenCalled();
			expect(plugin.getLiveSessionView()).toMatchObject({observationCount:0,sourceState:'missing',totals:[]});
			addon.destroy();
		} finally {
			await server()?.close();
		}
	});

	describe('H18.38 recorrido of an aviso: real bridge, ack, persisted record, view model', () => {
		async function withBridge(
			body: (plugin: AlertWiringHarness, port: number) => Promise<void>,
		): Promise<void> {
			const record = activeSessionRecord();
			vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
			vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
			const plugin = alertWiringPlugin(new IDBFactory());
			const server = () => (plugin as unknown as { alertIngameServer: AlertIngameServerHandle | null }).alertIngameServer;
			await plugin.initializeRuntime();
			const port = await freeLoopbackPort();
			try {
				await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: port });
				await vi.waitFor(() => { expect(server()).not.toBeNull(); });
				await body(plugin, port);
			} finally {
				await server()?.close();
			}
		}

		async function connectAddon(plugin: AlertWiringHarness, port: number, version: 2 | 3) {
			const socket = await connectLoopback(port);
			socket.setEncoding('utf8');
			const lines: string[] = [];
			let buffer = '';
			socket.on('data', (chunk: string) => {
				buffer += chunk;
				for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
					lines.push(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
				}
			});
			socket.write(ingameHello(await pluginBridgeSecret(plugin), version));
			await vi.waitFor(() => { expect(lines).toHaveLength(version === 3 ? 3 : 1); });
			if (version === 3) {
				expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ type: 'farming_cap', tag: 'farm1' });
				expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ type: 'live_cap', tag: 'live1' });
			}
			const { nonce } = JSON.parse(lines[0] ?? '{}') as { nonce: string };
			return { socket, lines, nonce };
		}

		const t = createTranslator('es');
		const tr = (key: string, params?: Record<string, string | number>) => t.t(key as never, params);

		it('a v3 addon that acks makes the record received by Nexus, and the view says so', async () => {
			await withBridge(async (plugin, port) => {
				const addon = await connectAddon(plugin, port, 3);
				await plugin.emitAlert(VALUABLE);
				await vi.waitFor(() => { expect(addon.lines).toHaveLength(4); });
				const alert = JSON.parse(addon.lines[3] ?? '{}') as { v: number; seq: number };
				expect(alert.v).toBe(3);
				await vi.waitFor(() => {
					expect([...plugin.getAlertDeliveries().values()]).toMatchObject([{ state: 'pending', sentTo: ['nexus'] }]);
				});

				addon.socket.write(`${JSON.stringify({ v: 3, type: 'alert_ack', nonce: addon.nonce, seq: 0, alertSeq: alert.seq })}\n`);
				await vi.waitFor(() => {
					expect([...plugin.getAlertDeliveries().values()]).toMatchObject([{ state: 'received', receivedBy: 'nexus' }]);
				});
				const stored = plugin.getEmittedAlerts()[0]!;
				const view = alertReceiptView(stored, plugin.getAlertDeliveries().get(stored.alertId), tr, 'es');
				expect(view.steps.map((step) => step.label)).toEqual(['Visto', 'Enviado', 'Recibido en el juego (Nexus)']);
				expect(view.steps.map((step) => step.status)).toEqual(['done', 'done', 'done']);
				addon.socket.destroy();
			});
		});

		it('a v2 addon gets a v2 alert and the record says the addon does not confirm', async () => {
			await withBridge(async (plugin, port) => {
				const addon = await connectAddon(plugin, port, 2);
				await plugin.emitAlert(VALUABLE);
				await vi.waitFor(() => { expect(addon.lines).toHaveLength(2); });
				expect(JSON.parse(addon.lines[1] ?? '{}')).toMatchObject({ v: 2, type: 'alert' });
				await vi.waitFor(() => {
					expect([...plugin.getAlertDeliveries().values()])
						.toMatchObject([{ state: 'unconfirmed', cause: 'old_addon', sentTo: ['nexus'] }]);
				});
				const stored = plugin.getEmittedAlerts()[0]!;
				const view = alertReceiptView(stored, plugin.getAlertDeliveries().get(stored.alertId), tr, 'es');
				expect(view.steps[2]).toMatchObject({ label: 'Sin confirmar', detail: { text: 'el addon no confirma: actualízalo' } });
				addon.socket.destroy();
			});
		});

		it('with the bridge on and no addon connected, the record says nobody was there', async () => {
			await withBridge(async (plugin) => {
				const report = await plugin.emitAlert(VALUABLE);
				expect(report.failed.map((entry) => entry.id)).toContain('ingame');
				await vi.waitFor(() => {
					expect([...plugin.getAlertDeliveries().values()])
						.toMatchObject([{ state: 'unconfirmed', cause: 'no_addon', sentTo: [] }]);
				});
				const stored = plugin.getEmittedAlerts()[0]!;
				const view = alertReceiptView(stored, plugin.getAlertDeliveries().get(stored.alertId), tr, 'es');
				expect(view.steps[1]).toMatchObject({ status: 'skip', detail: { text: 'sin addon conectado' } });
			});
		});
	});

	/**
	 * Addon/plugin seam for wallet currencies. The frames of the shared Nexus fixture travel over a real loopback
	 * socket, through the real server, assembler and `liveIngamePort` of the plugin core (`kind 0 -> item`,
	 * `kind 1 -> currency`), into the real lifecycle and reducer; the assertions read the public session view.
	 * Left out: the addon itself, and the note/panel rendering (covered by their own tests).
	 */
	describe('live1 currency seam: shared Nexus fixture, real bridge, reducer and view', () => {
		const wireFixture = JSON.parse(readFileSync(new URL('./alerts/__fixtures__/live1.json', import.meta.url), 'utf8')) as { frames: Record<string, unknown>[] };
		const fixtureFrames = wireFixture.frames.filter((frame) => ['live_open', 'live_begin', 'live_rows', 'live_end'].includes(frame.type as string));
		const EPOCH = 'AgICAgICAgICAgICAgICAg';
		type Row = [0 | 1, number, number];
		const ITEMS: Row[] = [[0, 12147, 2], [0, 36038, 200]];

		async function withLiveAddon(body: (view: () => LiveSessionViewV1, sample: (cursor: number, currencies: 'none' | 'listed', rows: Row[]) => Promise<void>, fixtureSamples: () => Promise<void>) => Promise<void>): Promise<void> {
			const record = activeSessionRecord();
			vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
			vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
			vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue({ status: 'idle' } as SessionState);
			const plugin = alertWiringPlugin(new IDBFactory());
			const server = () => (plugin as unknown as { alertIngameServer: AlertIngameServerHandle | null }).alertIngameServer;
			await plugin.initializeRuntime();
			const port = await freeLoopbackPort();
			try {
				await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: port });
				await vi.waitFor(() => { expect(server()).not.toBeNull(); });
				const socket = await connectLoopback(port);
				socket.setEncoding('utf8');
				const lines: Record<string, unknown>[] = [];
				let buffer = '';
				socket.on('data', (chunk: string) => {
					buffer += chunk;
					for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
						lines.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
						buffer = buffer.slice(newline + 1);
					}
				});
				socket.write(ingameHello(await pluginBridgeSecret(plugin), 3));
				await vi.waitFor(() => { expect(lines).toHaveLength(3); });
				const nonce = lines[0]!.nonce as string;
				const write = (record: Record<string, unknown>) => { socket.write(`${JSON.stringify({ ...record, nonce })}\n`); };
				const acks = () => lines.filter((line) => line.type === 'live_ack').length;
				const stored = async (count: number) => { await vi.waitFor(() => { expect(acks()).toBe(count); }); };
				let seq = 0;
				write({ v: 3, type: 'context', seq: seq++, state: 'gameplay', mapId: 866, character: 'Astra Uno' });
				const fixtureSamples = async () => {
					for (const frame of fixtureFrames) {
						// Guard: the fixture sequence must be contiguous with ours, or the wire would not be the shared one.
						expect(frame.seq).toBe(seq++);
						write(frame);
						if (frame.type === 'live_open') await vi.waitFor(() => { expect(lines.some((line) => line.type === 'live_ready')).toBe(true); });
						if (frame.type === 'live_end') await stored(acks() + 1);
					}
				};
				const sample = async (cursor: number, currencies: 'none' | 'listed', rows: Row[]) => {
					const head = { v: 3, tag: 'live1', epoch: EPOCH, cursor };
					write({ ...head, type: 'live_begin', seq: seq++, ctx: 0, ms: cursor * 1000, mode: 'sample', items: 'complete', currencies, unknown: 0, slots: null, rows: rows.length });
					write({ ...head, type: 'live_rows', seq: seq++, part: 0, rows });
					write({ ...head, type: 'live_end', seq: seq++ });
					await stored(acks() + 1);
				};
				await body(() => plugin.getLiveSessionView(), sample, fixtureSamples);
				socket.destroy();
			} finally {
				await server()?.close();
			}
		}

		it('accepts the listed fixture sample: coverage listed with the wallet rows of the wire', async () => {
			await withLiveAddon(async (view, _sample, fixtureSamples) => {
				await fixtureSamples();
				await vi.waitFor(() => { expect(view().currencyCoverage).toBe('listed'); });
				expect(view()).toMatchObject({ currencyCoverage: 'listed', currencyIds: [1, 45], itemCoverage: 'complete' });
			});
		});

		it('the first sample with coins is a baseline: no coin observation, ids 1 and 45 tracked', async () => {
			await withLiveAddon(async (view, _sample, fixtureSamples) => {
				await fixtureSamples();
				await vi.waitFor(() => { expect(view().currencyIds).toEqual([1, 45]); });
				expect(view().observations.filter((observation) => observation.kind === 'currency')).toEqual([]);
			});
		});

		it('keeps the fixture object delta while the first wallet sample adds none', async () => {
			await withLiveAddon(async (view, _sample, fixtureSamples) => {
				await fixtureSamples();
				await vi.waitFor(() => { expect(view().observationCount).toBe(1); });
				expect(view().observations).toMatchObject([{ kind: 'item', idNumber: 12147, delta: 2 }]);
			});
		});

		it('a following listed sample turns gold +250 and currency 45 +6 into two coin observations', async () => {
			await withLiveAddon(async (view, sample, fixtureSamples) => {
				await fixtureSamples();
				await sample(2, 'listed', [...ITEMS, [1, 1, 250], [1, 45, 10_231]]);
				await vi.waitFor(() => { expect(view().observations.filter((observation) => observation.kind === 'currency')).toHaveLength(2); });
				expect(view().observations.filter((observation) => observation.kind === 'currency'))
					.toMatchObject([{ idNumber: 1, before: 0, after: 250, delta: 250 }, { idNumber: 45, before: 10_225, after: 10_231, delta: 6 }]);
			});
		});

		it('the coin totals carry currency:1 and currency:45 with their nets', async () => {
			await withLiveAddon(async (view, sample, fixtureSamples) => {
				await fixtureSamples();
				await sample(2, 'listed', [...ITEMS, [1, 1, 250], [1, 45, 10_231]]);
				await vi.waitFor(() => { expect(view().totals.filter((total) => total.kind === 'currency')).toHaveLength(2); });
				expect(view().totals.filter((total) => total.kind === 'currency'))
					.toEqual([{ kind: 'currency', idNumber: 1, positive: 250, negative: 0, net: 250 }, { kind: 'currency', idNumber: 45, positive: 6, negative: 0, net: 6 }]);
			});
		});

		it('values the observed gold: coinNetCopper 250 and the known net is the item net plus 250', async () => {
			await withLiveAddon(async (view, sample, fixtureSamples) => {
				await fixtureSamples();
				await sample(2, 'listed', [...ITEMS, [1, 1, 250], [1, 45, 10_231]]);
				await vi.waitFor(() => { expect(view().valuation.coinNetCopper).toBe(250); });
				expect(view().valuation.knownNetValueCopper).toBe(view().valuation.netItemValueKnownCopper + 250);
			});
		});

		it('a sample with currencies none after the baseline makes no coin delta and opens a coin gap', async () => {
			await withLiveAddon(async (view, sample, fixtureSamples) => {
				await fixtureSamples();
				await sample(2, 'none', [[0, 12147, 3], [0, 36038, 200]]);
				await vi.waitFor(() => { expect(view().observationCount).toBe(2); });
				expect({ coins: view().observations.filter((observation) => observation.kind === 'currency'), gaps: view().gaps.filter((gap) => gap.toAt === null).map((gap) => gap.channels) })
					.toEqual({ coins: [], gaps: [['currencies']] });
			});
		});

		it('a sample with currencies none leaves the object ledger running: no open item gap, the item delta is kept', async () => {
			await withLiveAddon(async (view, sample, fixtureSamples) => {
				await fixtureSamples();
				await sample(2, 'none', [[0, 12147, 3], [0, 36038, 200]]);
				await vi.waitFor(() => { expect(view().observationCount).toBe(2); });
				expect({ items: view().observations.filter((observation) => observation.kind === 'item').map((observation) => observation.delta), itemGaps: view().gaps.filter((gap) => gap.channels.includes('items') && gap.toAt === null) })
					.toEqual({ items: [2, 1], itemGaps: [] });
			});
		});

		it('the listed sample after a gap is a baseline again: nothing is counted for what happened inside the gap', async () => {
			await withLiveAddon(async (view, sample, fixtureSamples) => {
				await fixtureSamples();
				await sample(2, 'none', [[0, 12147, 3], [0, 36038, 200]]);
				await sample(3, 'listed', [[0, 12147, 3], [0, 36038, 200], [1, 1, 9_999], [1, 45, 10_300]]);
				await vi.waitFor(() => { expect(view().gaps.filter((gap) => gap.toAt === null)).toEqual([]); });
				expect({ coins: view().observations.filter((observation) => observation.kind === 'currency'), totals: view().totals.filter((total) => total.kind === 'currency') })
					.toEqual({ coins: [], totals: [] });
			});
		});

		it('a currency that first appears mid-session is a baseline: no delta for it while a known one still counts', async () => {
			await withLiveAddon(async (view, sample, fixtureSamples) => {
				await fixtureSamples();
				await sample(2, 'listed', [...ITEMS, [1, 1, 10], [1, 3, 500], [1, 45, 10_225]]);
				await vi.waitFor(() => { expect(view().currencyIds).toEqual([1, 3, 45]); });
				expect(view().observations.filter((observation) => observation.kind === 'currency')).toMatchObject([{ idNumber: 1, delta: 10 }]);
			});
		});
	});

	it('refuses to build an alert that is not the signed contract', async () => {
		const plugin = alertWiringPlugin(new IDBFactory());
		await plugin.initializeRuntime();

		await expect(plugin.emitAlert({ ...VALUABLE, quantity: -1 }))
			.resolves.toEqual({ delivered: [], failed: [], rejected: true });
		expect(plugin.getEmittedAlerts()).toHaveLength(0);
	});
});

function alertWiringPlugin(factory: IDBFactory, hostApis: Record<string, unknown> = {}, local = new Map<string, unknown>()): AlertWiringHarness {
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
	const secrets = new Map<string, string>();
	const app = {
		vault, workspace: { getLeavesOfType: vi.fn(() => []) }, fileManager: vault.fileManager,
		loadLocalStorage: (key: string) => structuredClone(local.get(key) ?? null),
		saveLocalStorage: (key: string, value: unknown) => { local.set(key, structuredClone(value)); },
		secretStorage: {
			listSecrets: () => [...secrets.keys()],
			getSecret: (id: string) => secrets.get(id) ?? null,
			setSecret: (id: string, value: string) => { secrets.set(id, value); },
		},
	} as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	// Only the settings-toggle test below calls `updateSettings`; every other test never
	// touches persistence, so a no-op `saveData` is enough to keep the real save-then-publish
	// order in `updateSettings` from throwing on the base `Plugin` class's absent stub.
	const { core } = obsidianPluginCore(app, manifest, { saveData: vi.fn(async () => undefined) });
	const target = core as unknown as AlertWiringHarness & {
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
	};
	target.settings = structuredClone(DEFAULT_SETTINGS);
	// R1b: this device collects, as every install did before the collector/consult split.
	core.collectorMode = 'collector';
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();

	vi.stubGlobal('window', {
		indexedDB: factory,
		setInterval: vi.fn(() => 1),
		clearInterval: vi.fn(),
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
		...hostApis,
	});
	vi.stubGlobal('navigator', { onLine: true });

	return target;
}

/**
 * Binds an OS-assigned loopback port, reads it back, and closes the probe immediately: the
 * concrete number is then free to reopen under the plugin's own server. A narrow race (something
 * else grabs the port between the close and the plugin's `.listen()`) is possible in principle,
 * the same way it would be for any caller of this setting; it has not been observed in practice.
 */
function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => {
				if (address === null || typeof address === 'string') {
					reject(new Error('unreachable: the loopback probe did not bind to an address.'));
					return;
				}
				resolve(address.port);
			});
		});
	});
}

/** A real loopback client, the same way the Nexus addon connects: proves the port actually listens. */
function connectLoopback(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		socket.once('connect', () => { resolve(socket); });
		socket.once('error', reject);
		socket.connect(port, '127.0.0.1');
	});
}

/** A v2 hello as a Nexus addon sends it, carrying whatever secret the test hands in. */
function ingameHello(secret: string, version: 2 | 3 = 2): string {
	return `${JSON.stringify({
		v: version, type: 'hello', client: 'nexus', clientVersion: '0.2.0', instance: 'AAAAAAAAAAAAAAAAAAAAAA', token: secret,
	})}\n`;
}

/**
 * Goes through the plugin's own "Copy token" action, the one the settings button calls: it
 * generates the secret into the harness `SecretStorage`, selects it, and hands it to the clipboard,
 * which is where the user would take it from to paste into the addon.
 */
async function pluginBridgeSecret(plugin: object): Promise<string> {
	let copied = '';
	vi.stubGlobal('navigator', { onLine: true, clipboard: { writeText: async (text: string) => { copied = text; } } });
	await (plugin as { copyAlertIngameSecret(): Promise<string> }).copyAlertIngameSecret();
	return copied;
}

function fakeAudioContext() {
	const param = { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined };
	return {
		currentTime: 0,
		destination: {},
		createOscillator: () => ({
			type: '', frequency: param, connect: () => undefined, start: () => undefined, stop: () => undefined,
		}),
		createGain: () => ({ gain: param, connect: () => undefined }),
		close: () => undefined,
	};
}

function activeSessionRecord() {
	const baselineSnapshot = storageDeltaSnapshot();
	const final = afterSnapshot({
		holdings: [...baselineSnapshot.holdings, looseHolding(999, 1, { source: 'bank', slot: 1 })],
	});
	if (compareStorageSnapshots(baselineSnapshot, final).status === 'invalid') {
		throw new Error('Alert-wiring fixture is invalid.');
	}
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
			magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
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

function armedState() {
	return {
		status: 'armed' as const,
		armedAt: '2026-09-01T08:00:00.000Z',
		lastSnapshotAt: '2026-08-13T08:00:01.000Z',
		scheduler: {
			status: 'scheduled' as const, intervalMs: ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS,
			nextRunAt: Date.now() + ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS,
			lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0,
		},
	};
}
