// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads,
// and without it the durable queue silently reports every write as failed.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Socket } from 'node:net';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import TyrianCompanionPlugin, { type SettingsUpdateResult } from './main';
import { ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS, type AlertV1 } from './alerts/alert-contract';
import type { AlertDeliveryReport } from './alerts/alert-emitter';
import type { AlertIngameServerHandle } from './alerts/alert-ingame-server';
import type { EmittedAlertRecordV1 } from './alerts/alert-queue-record';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import type { ActiveSessionState, SessionSnapshotReference, SessionState } from './sessions/session';
import type { LiveSessionLootState } from './sessions/live-session-loot';

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
	settings: TyrianSettings;
	runtimeReady: boolean;
	initializeRuntime(): Promise<void>;
	startManualSession(input: unknown): Promise<void>;
	emitAlert(alert: AlertV1): Promise<AlertDeliveryReport>;
	getEmittedAlerts(): readonly EmittedAlertRecordV1[];
	getLiveSessionLoot(): LiveSessionLootState;
	getAssistedDetectionState(): { status: string };
	updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
}

const VALUABLE: AlertV1 = {
	kind: 'valuable_loot', itemId: 36_038, name: 'Bolsa de truco o trato', quantity: 3,
	totalCopper: 120_000, reason: 'valuable',
};

describe('H13.3 loot poll cabling', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('arms the loot poll at five minutes on a manual start with assisted detection off', async () => {
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const sessionState = vi.spyOn(ManualSessionStartService.prototype, 'getState')
			.mockReturnValue({ status: 'idle' } as SessionState);
		vi.spyOn(ManualSessionStartService.prototype, 'start')
			.mockResolvedValue({ status: 'started', state: record.state } as never);
		const arm = vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue(armedState());
		const plugin = alertWiringPlugin(new IDBFactory());
		// The user has never armed assisted detection: this is the default install.
		plugin.settings.detectionMode = 'off';

		await plugin.initializeRuntime();
		expect(arm, 'load must not poll: there is no active session').not.toHaveBeenCalled();
		expect(plugin.getLiveSessionLoot()).toMatchObject({ status: 'idle' });

		sessionState.mockReturnValue(record.state);
		await plugin.startManualSession({ characterName: 'Astra Uno', magicFind: { value: 321, source: 'manual' } });

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
		expect(banners[0]?.title).toBe('Hallazgo valioso');
		expect(banners[0]?.options.body).toContain('Bolsa de truco o trato');
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

		expect([...report.failed].sort()).toEqual(['sound', 'system_notification']);
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
		expect(report.failed).toContain('ingame');
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

		try {
			await plugin.updateSettings({ alertIngameEnabled: true, alertIngamePort: 0 });
			// No `emitAlert` call anywhere above: this is the whole point of the fix. The old
			// behaviour only opened the listener from inside `deliver`, so the addon had nothing
			// to connect to until the first alert, and that alert then found `clientCount() === 0`
			// and was reported `failed`.
			await vi.waitFor(() => { expect(server()).not.toBeNull(); });
			const handle = server();
			if (handle === null) throw new Error('unreachable: waited for a non-null handle above');

			// The listener is real and reachable from outside the process, exactly the way the
			// Nexus addon reaches it; this is not just a truthy internal field.
			const client = await connectLoopback(handle.port);
			await vi.waitFor(() => { expect(handle.clientCount()).toBe(1); });
			client.destroy();

			await plugin.updateSettings({ alertIngameEnabled: false });
			await vi.waitFor(() => { expect(server()).toBeNull(); });
		} finally {
			await server()?.close();
		}
	});

	it('refuses to build an alert that is not the signed contract', async () => {
		const plugin = alertWiringPlugin(new IDBFactory());
		await plugin.initializeRuntime();

		await expect(plugin.emitAlert({ ...VALUABLE, quantity: -1 }))
			.resolves.toEqual({ delivered: [], failed: [], rejected: true });
		expect(plugin.getEmittedAlerts()).toHaveLength(0);
	});
});

function alertWiringPlugin(factory: IDBFactory, hostApis: Record<string, unknown> = {}): AlertWiringHarness {
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
	const target = plugin as unknown as AlertWiringHarness & {
		app: App;
		manifest: PluginManifest;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		registerEvent(event: unknown): void;
		saveData(data: unknown): Promise<void>;
	};
	target.app = app;
	target.manifest = manifest;
	target.settings = structuredClone(DEFAULT_SETTINGS);
	target.localDebug = null;
	target.localDebugActions = null;
	target.lootPresentation = new LootPresentationCache();
	target.registerEvent = vi.fn();
	// Only the settings-toggle test below calls `updateSettings`; every other test never
	// touches persistence, so a no-op here is enough to keep the real save-then-publish
	// order in `updateSettings` from throwing on the base `Plugin` class's absent stub.
	target.saveData = vi.fn(async () => undefined);

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

/** A real loopback client, the same way the Nexus addon connects: proves the port actually listens. */
function connectLoopback(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		socket.once('connect', () => { resolve(socket); });
		socket.once('error', reject);
		socket.connect(port, '127.0.0.1');
	});
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
