import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS } from './alerts/alert-contract';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import TyrianCompanionPlugin from './main';
import { obsidianPluginCore } from './test/obsidian-host-harness';
import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import { DEFAULT_SETTINGS } from './core/settings';
import { LootPresentationCache } from './sessions/loot-presentation-cache';
import { DetectionQualityRecorder } from './sessions/session-detection-quality-recorder';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import type { ActiveSessionState, CompleteSessionState, SessionSnapshotReference } from './sessions/session';
import type { LiveSessionLootState } from './sessions/live-session-loot';
import type { LootPresentationV1 } from './sessions/loot-presentation';
import { prepareSessionNote } from './sessions/session-note-model';
import { renderSessionNote, type StoredSessionLootSummary } from './sessions/session-note-renderer';
import { createSessionContaminationReview } from './sessions/session-contamination-review';
import {
	createSessionRuntimeRecord,
	IndexedDbSessionRuntimeStore,
} from './sessions/session-runtime-store';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import { hangStorage, hangTransactions, macrotasks, resumeStorage, trackedIndexedDb } from './test/indexed-db-connections';

interface RuntimeBootHarness {
	runtimeReady: boolean;
	localDebugActions: LocalDebugActionRunner | null;
	initializeRuntime(): Promise<void>;
	getLiveSessionLoot(): LiveSessionLootState;
	getLootPresentation(): LootPresentationV1 | null;
	getSessionSummarySaveState(): 'unknown' | 'saving' | 'saved' | 'failed';
	getStoredSessionLootSummary(): StoredSessionLootSummary | null;
}

describe('deferred runtime startup with persisted terminal state', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('keeps an existing event-and-name note byte-identical while restoring its durable summary', async () => {
		const factory = new IDBFactory();
		const record = completedSessionRecord();
		const store = new IndexedDbSessionRuntimeStore(factory);
		await expect(store.save(record)).resolves.toEqual({ status: 'saved' });
		store.close();
		const durable = await completedSessionNote(record);
		const notes = new Map([[durable.path, durable.content]]);

		const plugin = runtimeBootPlugin(factory, notes);
		await expect(plugin.initializeRuntime()).resolves.toBeUndefined();
		expect(plugin.runtimeReady).toBe(true);
		expect(plugin.getLootPresentation()).not.toBeNull();
		expect(plugin.getSessionSummarySaveState()).toBe('saved');
		expect(plugin.getStoredSessionLootSummary()?.rows).toContainEqual(expect.objectContaining({ name: 'Pimpollo de flor de cerezo' }));
		expect(notes.get(durable.path)).toBe(durable.content);
	});

	it('restores and arms an active session only after assisted detection exists', async () => {
		const factory = new IDBFactory();
		const record = activeSessionRecord();
		vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockResolvedValue();
		vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(record.state);
		vi.spyOn(ManualSessionStartService.prototype, 'getBaselineSnapshot').mockReturnValue(record.baselineSnapshot);
		const arm = vi.spyOn(AssistedDetectionService.prototype, 'armFromSnapshot').mockReturnValue({
			status: 'armed', armedAt: '2026-09-01T08:00:00.000Z', lastSnapshotAt: record.baselineSnapshot.completedAt,
			scheduler: { status: 'scheduled', intervalMs: 120_000, nextRunAt: Date.now() + 120_000,
				lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
		});
		const plugin = runtimeBootPlugin(factory);

		await expect(plugin.initializeRuntime()).resolves.toBeUndefined();

		// H13.3: an active session polls at five minutes, not at the idle detection cadence.
		expect(arm).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: record.baselineSnapshot.snapshotId }),
			ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS,
		);
		expect(plugin.getLiveSessionLoot()).toMatchObject({ status: 'observing', sessionId: 'session-1', restored: true });
	});

	// Hebra checkpoint 16: the Acompañante view can mount as the restored tab before
	// `initializeRuntime()` resolves, and it reads this getter on every render.
	it('answers an idle live-loot state to a view that reads before initializeRuntime finishes', () => {
		const plugin = runtimeBootPlugin(new IDBFactory());
		expect(plugin.getLiveSessionLoot()).toEqual({ status: 'idle' });
	});

	it('reaches runtimeReady when no terminal session is persisted', async () => {
		const plugin = runtimeBootPlugin(new IDBFactory());
		await expect(plugin.initializeRuntime()).resolves.toBeUndefined();
		expect(plugin.runtimeReady).toBe(true);
	});

	// 9 Oct 2026 (Z3): an engine that accepts every open and transaction and answers none. `await sessions.initialize()` had no
	// bound, so the plugin never became ready and no command, setting or view came up.
	describe('with a storage engine that takes everything and answers nothing', () => {
		function manualWindowTimers() {
			// A virtual clock: `fire` jumps to the earliest pending timer and runs every timer due then, so the time the boot would
			// take on a clock is `elapsedMs`, without waiting for it.
			const live = new Map<number, { at: number; callback: () => void }>(); let next = 0; let now = 0;
			const host = window as unknown as { setTimeout: unknown; clearTimeout: unknown };
			host.setTimeout = (callback: () => void, milliseconds = 0) => { live.set(++next, { at: now + milliseconds, callback }); return next; };
			host.clearTimeout = (handle: number) => { live.delete(handle); };
			return {
				fire() {
					if (live.size === 0) return;
					now = Math.min(...[...live.values()].map((timer) => timer.at));
					for (const [handle, timer] of [...live]) if (timer.at <= now) { live.delete(handle); timer.callback(); }
				},
				get elapsedMs() { return now; },
			};
		}

		// Only the session databases go silent: boot reads a dozen other stores first, and this fix is about the session part.
		function sessionEngineThatDoesNotAnswer() {
			const tracked = trackedIndexedDb();
			tracked.hangOnly = (name) => /session-runtime|coordination/.test(name);
			hangStorage(tracked);
			return tracked;
		}

		const bootTiming: { readyAtMs: number | null } = { readyAtMs: null };

		/** Boots until `initializeRuntime` settles. `readyAtMs` is the virtual time at which `runtimeReady` first read true. */
		async function bootUntilSettled(plugin: RuntimeBootHarness, timers: { fire(): void; elapsedMs: number }): Promise<boolean> {
			let settled = false;
			bootTiming.readyAtMs = null;
			void plugin.initializeRuntime().then(() => { settled = true; }, () => { settled = true; });
			// Real macrotask turns let fake-indexeddb answer what it can; each turn also lets every 10 s wait run out.
			for (let turn = 0; turn < 2000 && !settled; turn += 1) {
				await macrotasks(1);
				if (bootTiming.readyAtMs === null && plugin.runtimeReady) bootTiming.readyAtMs = timers.elapsedMs;
				timers.fire();
			}
			return settled;
		}

		type LiveView = { liveSessions: { getView(): { phase: string } } };
		const phase = (plugin: RuntimeBootHarness): string => (plugin as unknown as LiveView).liveSessions.getView().phase;
		/** The lifecycle's heartbeat, as the host would fire it: the callback armed with the 5 s interval. */
		function heartbeat(): () => void {
			const armed = (window as unknown as { setInterval: (callback: () => void, ms: number) => number }).setInterval;
			const beat = vi.mocked(armed).mock.calls.filter(([, ms]) => ms === 5_000).at(-1)?.[0];
			if (beat === undefined) throw new Error('The lifecycle armed no heartbeat.');
			return beat;
		}
		const sessionConnections = (tracked: ReturnType<typeof trackedIndexedDb>) =>
			tracked.connections.filter((database) => /session-runtime|coordination/.test(database.name));

		it('becomes ready within the bounded waits instead of never starting', async () => {
			const tracked = sessionEngineThatDoesNotAnswer();
			const plugin = runtimeBootPlugin(tracked.factory);
			const timers = manualWindowTimers();
			expect(await bootUntilSettled(plugin, timers)).toBe(true);
			expect(plugin.runtimeReady).toBe(true);
			// The session part reads as the store failing (the state a store that refuses already has), not as a session that is fine.
			expect(phase(plugin)).toBe('error');
		});

		// The realistic case: the engine goes silent for EVERY database, not only the session's.
		it('becomes ready when no database at all answers', async () => {
			const tracked = trackedIndexedDb(); hangStorage(tracked);
			const opened: string[] = []; const open = tracked.factory.open.bind(tracked.factory);
			let clock = (): number => 0;
			tracked.factory.open = (name: string, version?: number) => { opened.push(`${String(clock())} ${name}`); return open(name, version); };
			const plugin = runtimeBootPlugin(tracked.factory);
			const timers = manualWindowTimers();
			clock = () => timers.elapsedMs;
			const settled = await bootUntilSettled(plugin, timers);
			expect(settled).toBe(true);
			expect(plugin.runtimeReady).toBe(true);
			expect(phase(plugin)).toBe('error');
			// Every start-gating wait is one ten-second deadline: the collector mode, then the saved session (the reads after the
			// first answer at once, the store having just stayed silent).
			expect(bootTiming.readyAtMs).toBeLessThanOrEqual(20_000);
			expect(opened.length).toBeGreaterThan(1);
			void timers.elapsedMs;
		});

		// The other way of staying silent: every open succeeds, and the first read of each database never comes back.
		it('becomes ready when every open succeeds and no transaction answers', async () => {
			const tracked = trackedIndexedDb(); hangTransactions(tracked);
			const plugin = runtimeBootPlugin(tracked.factory);
			const timers = manualWindowTimers();
			expect(await bootUntilSettled(plugin, timers)).toBe(true);
			expect(plugin.runtimeReady).toBe(true);
			expect(phase(plugin)).toBe('error');
			// Ten seconds per read that gates the start, and no more than three of them in a row.
			expect(bootTiming.readyAtMs).toBeLessThanOrEqual(20_000);
		});

		it('recovers by itself, on the heartbeat, once the engine answers again, without flipping ready or opening twice', async () => {
			const tracked = sessionEngineThatDoesNotAnswer();
			const plugin = runtimeBootPlugin(tracked.factory);
			const timers = manualWindowTimers();
			expect(await bootUntilSettled(plugin, timers)).toBe(true);
			expect(phase(plugin)).toBe('error');
			// Any write to `runtimeReady` from here on is a flip.
			const readyFlips = vi.fn(); let ready = plugin.runtimeReady;
			Object.defineProperty(plugin, 'runtimeReady', { get: () => ready, set: (value: boolean) => { ready = value; readyFlips(); } });

			resumeStorage(tracked);
			// The heartbeat comes seconds after the silence, later than the moment the store refuses to ask again.
			let clock = Date.now() + 10_000; vi.spyOn(Date, 'now').mockImplementation(() => (clock += 100));
			heartbeat()();
			// The engine answers now: the timers are not fired, or a wait would run out before the fake engine got its turn.
			for (let turn = 0; turn < 500 && phase(plugin) === 'error'; turn += 1) await macrotasks(1);
			expect(phase(plugin)).toBe('idle');
			expect(plugin.runtimeReady).toBe(true);
			expect(readyFlips).not.toHaveBeenCalled();
			// At most one connection per session database: the silence did not leave an extra one open.
			expect(sessionConnections(tracked).length).toBeLessThanOrEqual(2);
		});
	});

	it('keeps runtime initialization alive and attributes the historical projection TypeError once', async () => {
		const factory = new IDBFactory();
		const store = new IndexedDbSessionRuntimeStore(factory);
		await expect(store.save(completedSessionRecord())).resolves.toEqual({ status: 'saved' });
		store.close();
		const records: LocalDebugRecordInput[] = [];
		const plugin = runtimeBootPlugin(factory);
		const actions = new LocalDebugActionRunner({
			diagnostics: { record: (record: LocalDebugRecordInput) => { records.push(record); } } as never,
			createId: (() => { let id = 0; return () => `diagnostic-${String(++id)}`; })(),
		});
		plugin.localDebugActions = actions;
		vi.spyOn(DetectionQualityRecorder.prototype, 'getSessionSummary').mockImplementation(() => {
			throw new TypeError('this.detectionQuality.getSessionSummary is not a function');
		});

		await expect(actions.run(
			{ component: 'plugin', action: 'plugin_load', state: 'runtime_initialize' },
			async () => await plugin.initializeRuntime(),
		)).resolves.toBeUndefined();

		expect(plugin.runtimeReady).toBe(true);
		const failures = records.filter(({ phase }) => phase === 'failure');
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			component: 'session', action: 'session_projection', code: 'precondition_failed',
			state: 'projection',
		});
		expect(failures[0]?.message).toBeInstanceOf(TypeError);
		expect(records).toContainEqual(expect.objectContaining({
			component: 'plugin', action: 'plugin_load', phase: 'success', code: 'ok', state: 'runtime_initialize',
		}));
		expect(records).not.toContainEqual(expect.objectContaining({ code: 'storage_failure' }));
	});
});

describe('deferred runtime startup failure', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// H15.2: `runtimeReady` stays `false` whether the boot is still running or broke outright, and
	// every guarded action (`checkConnection` included) used to say "still starting" for both.
	// `initializeRuntime`'s own rejection now flags the second case, and `notifyRuntimeStarting`
	// tells them apart instead of leaving the user stuck on a message that will never change.
	it('presents a broken boot as a failed start, not as still starting', async () => {
		const captured: { onLayoutReady: (() => void) | null } = { onLayoutReady: null };
		const fakeRibbon = { setAttr: () => undefined, toggleClass: () => undefined } as unknown as HTMLElement;
		const fakeApp = {
			vault: { configDir: 'test-config-dir' },
			workspace: { onLayoutReady: (callback: () => void) => { captured.onLayoutReady = callback; } },
		} as unknown as App;
		const fakeManifest = { id: 'tyrian-companion' } as unknown as PluginManifest;

		const plugin = new TyrianCompanionPlugin(fakeApp, fakeManifest);
		plugin.app = fakeApp;
		plugin.manifest = fakeManifest;
		plugin.loadData = async () => undefined;
		plugin.saveData = async () => undefined;
		plugin.registerView = vi.fn();
		plugin.addSettingTab = vi.fn();
		plugin.addCommand = vi.fn((command: unknown) => command) as unknown as typeof plugin.addCommand;
		plugin.registerDomEvent = vi.fn();
		plugin.addRibbonIcon = vi.fn(() => fakeRibbon);
		plugin.registerMarkdownCodeBlockProcessor = vi.fn();
		vi.stubGlobal('window', {});
		vi.stubGlobal('document', {});
		vi.spyOn(
			TyrianCompanionCore.prototype as unknown as { initializeRuntime(): Promise<void> },
			'initializeRuntime',
		).mockRejectedValue(new Error('boot broke'));

		await plugin.onload();
		expect(captured.onLayoutReady).not.toBeNull();
		const runSync = vi.spyOn(LocalDebugActionRunner.prototype, 'runSync');
		captured.onLayoutReady?.();
		// The rejection reaches `this.runtimeFailure` through a chain of `.catch`es (its own,
		// then `run()`'s, then `fireAndForget`'s); a macrotask boundary is enough to drain them.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect((plugin.core as unknown as { runtimeReady: boolean }).runtimeReady).toBe(false);
		await expect(plugin.core.checkConnection()).resolves.toEqual({ status: 'idle' });

		const notice = runSync.mock.calls.find(([context]) => context.action === 'notification_emit');
		expect(notice?.[0]).toMatchObject({ state: 'plugin_start_failed' });
	});
});

function runtimeBootPlugin(factory: IDBFactory, notes = new Map<string, string>()): RuntimeBootHarness {
	const workspace = {
		getLeavesOfType: vi.fn(() => []),
	};
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
	const app = { vault, workspace, fileManager: vault.fileManager } as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const { core } = obsidianPluginCore(app, manifest);
	const target = core as unknown as {
		settings: typeof DEFAULT_SETTINGS;
		localDebug: null;
		localDebugActions: null;
		lootPresentation: LootPresentationCache;
		runtimeReady: boolean;
		initializeRuntime(): Promise<void>;
		getLiveSessionLoot(): LiveSessionLootState;
		getLootPresentation(): LootPresentationV1 | null;
		getSessionSummarySaveState(): 'unknown' | 'saving' | 'saved' | 'failed';
		getStoredSessionLootSummary(): StoredSessionLootSummary | null;
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
	});
	vi.stubGlobal('navigator', { onLine: true });

	return target;
}

async function completedSessionNote(runtime: ReturnType<typeof completedSessionRecord>): Promise<{ path: string; content: string }> {
	if (runtime.state.status !== 'complete' || runtime.delta === null) throw new Error('Expected completed runtime.');
	const item = runtime.delta.itemChanges.find(({ delta }) => delta > 0);
	if (item === undefined) throw new Error('Expected a positive item delta.');
	// This fixture is a restore test, not an economy test, and its record was captured without a
	// close-time price snapshot. `valuation: null` is the outcome the runtime owes such a record;
	// asserting that here keeps this from silently becoming the "no note is ever valued" fixture
	// it used to be. Sessions that do carry prices are covered by main-session-note-economy.test.ts.
	if (runtime.priceSnapshot !== null) throw new Error('Expected a runtime record without prices.');
	const prepared = prepareSessionNote({
		runtime, valuation: null, reservation: null, hold: null, recommendation: null, envelope: null,
		eventDeclaration: {
			event: 'halloween', source: 'manual_explicit', declaredAt: runtime.state.baseline.completedAt,
		},
		displayNames: { [`item:${String(item.id)}`]: 'Pimpollo de flor de cerezo' },
		firstSeenItemIds: [], rareUnpricedOrBoundItemIds: [],
		locale: 'es', outputFolder: DEFAULT_SETTINGS.outputFolder,
	});
	if (prepared.status !== 'ok') throw new Error(`Invalid durable note fixture: ${prepared.reason}`);
	const rendered = await renderSessionNote(prepared.note);
	if (rendered.status !== 'ok') throw new Error(`Invalid durable note rendering: ${rendered.reason}`);
	return { path: rendered.note.preferredPath, content: rendered.note.content };
}

function completedSessionRecord() {
	const baseline = storageDeltaSnapshot();
	const final = afterSnapshot({
		holdings: [
			...baseline.holdings,
			looseHolding(999, 1, { source: 'bank', slot: 1 }),
		],
	});
	const delta = compareStorageSnapshots(baseline, final);
	const reviewedAt = '2026-08-13T09:00:03.000Z';
	const review = createSessionContaminationReview(baseline, final, delta, reviewedAt);
	if (delta.status === 'invalid' || review === null || review.classification.status === 'invalid') {
		throw new Error('Completed-session startup fixture is invalid.');
	}
	const reference = (snapshot: typeof baseline): SessionSnapshotReference => ({
		snapshotId: snapshot.snapshotId,
		accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt,
		completedAt: snapshot.completedAt,
		quality: snapshot.quality as SessionSnapshotReference['quality'],
	});
	const authority = {
		machineId: 'machine-1',
		instanceId: 'instance-1',
		sessionId: 'session-1',
		fence: 1,
		acquiredAt: Date.parse('2026-08-13T07:59:59.000Z'),
	};
	const state: CompleteSessionState = {
		version: 1,
		status: 'complete',
		sessionId: authority.sessionId,
		authority,
		requestedAt: '2026-08-13T07:59:59.500Z',
		baseline: reference(baseline),
		startContext: {
			characterName: 'Astra Uno',
			magicFind: { value: 321, source: 'manual', consumablesBonus: 0, breakdown: null },
			build: {
				tab: 1,
				name: 'Farm',
				profession: 'Revenant',
				specializations: [
					{ id: 3, traits: [1, 2, 3] },
					{ id: 52, traits: [4, 5, 6] },
					{ id: 63, traits: [7, 8, 9] },
				],
				skills: { heal: 1, utilities: [2, 3, 4], elite: 5 },
				aquaticSkills: { heal: 6, utilities: [7, 8, 9], elite: 10 },
			},
			capturedAt: '2026-08-13T08:00:02.000Z',
		},
		stopRequestedAt: '2026-08-13T08:59:59.000Z',
		stoppedAt: '2026-08-13T08:59:59.000Z',
		finalSnapshot: reference(final),
		finalizedAt: reviewedAt,
		classification: review.classification.status,
	};
	const record = createSessionRuntimeRecord(
		state,
		baseline,
		final,
		delta,
		Date.parse(reviewedAt),
		review,
	);
	if (record === null) throw new Error('Completed-session startup fixture is invalid.');
	return record;
}

function activeSessionRecord() {
	const complete = completedSessionRecord();
	if (complete.state.status !== 'complete') throw new Error('Expected a completed-session fixture.');
	const { version, sessionId, authority, requestedAt, baseline, startContext } = complete.state;
	const state: ActiveSessionState = {
		version, status: 'active', sessionId, authority, requestedAt, baseline, startContext,
	};
	const record = createSessionRuntimeRecord(
		state, complete.baselineSnapshot, null, null, Date.parse(complete.baselineSnapshot.completedAt),
	);
	if (record === null) throw new Error('Active-session startup fixture is invalid.');
	return record;
}
