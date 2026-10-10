import { IDBFactory } from 'fake-indexeddb';
import { TFile, type App, type PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { compareStorageSnapshots } from './account/storage-delta';
import { ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS } from './alerts/alert-contract';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from './account/__fixtures__/storage-delta';
import { sha256Text } from './assets/managed-asset-hash';
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
import { loadCollectorMode } from './runtime/collector-instance';
import { engineIdle, hangStorage, hangTransactions, holdNextCommit, resumeStorage, trackedIndexedDb, type TrackedIndexedDb } from './test/indexed-db-connections';

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
			// A virtual clock, shared with the stores through `performance.now`. `step` runs ONE timer, the earliest (the first armed
			// among equals), as a browser runs timers: tasks one at a time, with the microtasks and the engine's own events between.
			// Running every due timer in one loop would let the caller's deadline always beat the open's own, which a browser never does.
			const live = new Map<number, { at: number; callback: () => void }>(); let next = 0; let now = 0;
			const host = window as unknown as { setTimeout: unknown; clearTimeout: unknown };
			host.setTimeout = (callback: () => void, milliseconds = 0) => { live.set(++next, { at: now + milliseconds, callback }); return next; };
			host.clearTimeout = (handle: number) => { live.delete(handle); };
			vi.spyOn(performance, 'now').mockImplementation(() => now);
			return {
				step() {
					let first: [number, { at: number; callback: () => void }] | null = null;
					for (const entry of live) if (first === null || entry[1].at < first[1].at) first = entry;
					if (first === null) return;
					live.delete(first[0]);
					now = Math.max(now, first[1].at);
					first[1].callback();
				},
				/** Time passes with no timer due (the heartbeat's turn). */
				advance(milliseconds: number) { now += milliseconds; },
				get elapsedMs() { return now; },
				get pending() { return live.size; },
			};
		}

		// Only the session databases go silent: boot reads a dozen other stores first, and this fix is about the session part.
		function sessionEngineThatDoesNotAnswer() {
			const tracked = trackedIndexedDb();
			tracked.hangOnly = (name) => /session-runtime|coordination/.test(name);
			hangStorage(tracked);
			return tracked;
		}

		const bootTiming: { readyAtMs: number | null; settledAtMs: number | null } = { readyAtMs: null, settledAtMs: null };
		/** Real milliseconds without any progress (no timer to run, nothing in flight) after which a boot counts as stuck. */
		const STALL_MS = 4_000;

		/**
		 * Boots until `initializeRuntime` settles, and then until what it left running has finished. `readyAtMs` is the virtual
		 * time at which `runtimeReady` first read true.
		 *
		 * Nothing here counts turns. Virtual time only advances when the fake engine has nothing in flight (`engineIdle`): ten
		 * seconds pass in a browser while a healthy open answers in milliseconds, and a clock that jumped first would time out
		 * answers that were on their way, on a slow machine more often than on a fast one. A boot that waits for something that
		 * will never come (no timer to run, nothing in flight) is stuck, and says so after `STALL_MS` of real time.
		 */
		async function bootUntilSettled(plugin: RuntimeBootHarness, timers: { step(): void; elapsedMs: number; pending: number }, tracked: TrackedIndexedDb): Promise<boolean> {
			let settled = false;
			bootTiming.readyAtMs = null; bootTiming.settledAtMs = null;
			void plugin.initializeRuntime().then(() => { settled = true; bootTiming.settledAtMs = timers.elapsedMs; }, () => { settled = true; });
			let progressAt = Date.now();
			while (!settled) {
				await engineIdle(tracked);
				if (bootTiming.readyAtMs === null && plugin.runtimeReady) bootTiming.readyAtMs = timers.elapsedMs;
				if (timers.pending > 0) { timers.step(); progressAt = Date.now(); }
				else if (Date.now() - progressAt > STALL_MS) throw new Error('The boot is stuck: no timer to run, nothing in flight in the engine, and initializeRuntime has not settled.');
			}
			// What the boot left running in the background (the waits of the stores nobody awaits) is finished here, so it cannot
			// arm timers in the NEXT test's clock and move its time.
			for (let quiet = 0; quiet < 3;) {
				await engineIdle(tracked);
				if (timers.pending === 0) quiet += 1; else { quiet = 0; timers.step(); }
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
			expect(await bootUntilSettled(plugin, timers, tracked)).toBe(true);
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
			const settled = await bootUntilSettled(plugin, timers, tracked);
			expect(settled).toBe(true);
			expect(plugin.runtimeReady).toBe(true);
			expect(phase(plugin)).toBe('error');
			// Every start-gating wait is one ten-second deadline: the vault registry (DU-02), the collector mode, then the saved session (the reads after the
			// first answer at once, the store having just stayed silent).
			expect(opened.length).toBeGreaterThan(1);
			expect([bootTiming.readyAtMs, bootTiming.settledAtMs]).toEqual([30_000, 30_000]);
		});

		// DU-02: a device that already remembers this vault's id does not wait for the registry, so the common start is back to two waits.
		it('a device that remembers this vault does not wait for the vault registry: ready after the two usual waits', async () => {
			const tracked = trackedIndexedDb(); hangStorage(tracked);
			const local = new Map<string, unknown>([['tyrian-companion:vault-identity', { vaultId: await sha256Text('/test/vault') }]]);
			const plugin = runtimeBootPlugin(tracked.factory, new Map(), local);
			const timers = manualWindowTimers();
			expect(await bootUntilSettled(plugin, timers, tracked)).toBe(true);
			expect(plugin.runtimeReady).toBe(true);
			expect([bootTiming.readyAtMs, bootTiming.settledAtMs]).toEqual([20_000, 20_000]);
		});

		// A slow engine, not a silent one: the device saved `consult`, the read of it answers after the start gave up waiting.
		describe('a saved collector mode whose read answers after the start gave up', () => {
			type ModeCore = { getCollectorMode(): string; updateCollectorMode(mode: string): Promise<unknown> };
			/** A plugin whose Settings tab exists: applying a mode refreshes it, and this harness builds none. */
			function withSettingsTab(factory: IDBFactory): RuntimeBootHarness {
				return Object.assign(runtimeBootPlugin(factory), { settingTab: { refreshForSettingsChange: vi.fn() } });
			}

			async function deviceThatSavedConsult() {
				const tracked = trackedIndexedDb();
				const first = withSettingsTab(tracked.factory);
				await first.initializeRuntime();
				await (first as unknown as ModeCore).updateCollectorMode('consult');
				expect((first as unknown as ModeCore).getCollectorMode()).toBe('consult');
				return tracked;
			}

			it('starts as the seed says after ten seconds, then applies the saved mode when the read finally answers', async () => {
				const tracked = await deviceThatSavedConsult();
				const plugin = withSettingsTab(tracked.factory);
				const timers = manualWindowTimers();
				const answer = holdNextCommit(tracked, (name) => name === 'tyrian-companion-collector');
				expect(await bootUntilSettled(plugin, timers, tracked)).toBe(true);
				expect(plugin.runtimeReady).toBe(true);
				expect((plugin as unknown as ModeCore).getCollectorMode()).toBe('collector');
				expect(bootTiming.readyAtMs).toBe(10_000);

				answer();
				await engineIdle(tracked);
				expect((plugin as unknown as ModeCore).getCollectorMode()).toBe('consult');
			});

			/** The core as these tests drive it: the mode changes it applied, in order, and a way to say a session is running. */
			function instrument(plugin: RuntimeBootHarness) {
				const core = plugin as unknown as {
					applyCollectorModeChange(): Promise<void>; emitNotice(text: string, id: string): void;
					liveSessions: { getRuntime(): unknown; options: { onStateChange(): void } };
					vaultId: string;
				};
				const applied: string[] = [];
				const apply = core.applyCollectorModeChange.bind(core);
				core.applyCollectorModeChange = async () => { applied.push((plugin as unknown as ModeCore).getCollectorMode()); await apply(); };
				const notices = vi.spyOn(core, 'emitNotice').mockImplementation(() => undefined);
				let running = false;
				vi.spyOn(core.liveSessions, 'getRuntime').mockImplementation(() => (running ? { phase: 'active' } : null));
				return {
					applied, notices, core,
					setSessionRunning(value: boolean) { running = value; },
					/** What the live lifecycle does when its state changes, e.g. when the session ends. */
					sessionStateChanged() { core.liveSessions.options.onStateChange(); },
				};
			}

			async function bootWithReadHeld() {
				const tracked = await deviceThatSavedConsult();
				const plugin = withSettingsTab(tracked.factory);
				const timers = manualWindowTimers();
				const answer = holdNextCommit(tracked, (name) => name === 'tyrian-companion-collector');
				expect(await bootUntilSettled(plugin, timers, tracked)).toBe(true);
				return { tracked, plugin, answer, probe: instrument(plugin) };
			}

			it('does not undo a mode chosen in Settings while the read was still out, even when the read answers first', async () => {
				const { tracked, plugin, answer, probe } = await bootWithReadHeld();
				// A real engine answers the read before the write queued behind it: the choice must already be marked when it does.
				const choosing = (plugin as unknown as ModeCore).updateCollectorMode('collector');
				answer();
				await choosing;
				await engineIdle(tracked);
				expect(probe.applied).toEqual(['collector']);
				expect((plugin as unknown as ModeCore).getCollectorMode()).toBe('collector');
			});

			it('keeps a saved consult pending while a session is running, and applies it when the session ends', async () => {
				const { tracked, plugin, answer, probe } = await bootWithReadHeld();
				probe.setSessionRunning(true);

				answer();
				await engineIdle(tracked);
				expect((plugin as unknown as ModeCore).getCollectorMode()).toBe('collector');
				expect(probe.notices).toHaveBeenCalledTimes(1);
				probe.sessionStateChanged();
				expect(probe.notices).toHaveBeenCalledTimes(1);

				probe.setSessionRunning(false);
				probe.sessionStateChanged();
				await engineIdle(tracked);
				expect((plugin as unknown as ModeCore).getCollectorMode()).toBe('consult');
				expect(probe.applied).toEqual(['consult']);
			});

			it('lets a mode chosen by hand win over a saved one still pending behind a running session', async () => {
				const { tracked, plugin, answer, probe } = await bootWithReadHeld();
				probe.setSessionRunning(true);
				answer();
				await engineIdle(tracked);

				// Choosing the mode in use is written (the saved one differs) and drops the pending one.
				await expect((plugin as unknown as ModeCore).updateCollectorMode('collector')).resolves.toMatchObject({ status: 'saved' });
				probe.setSessionRunning(false);
				probe.sessionStateChanged();
				await engineIdle(tracked);
				expect((plugin as unknown as ModeCore).getCollectorMode()).toBe('collector');
				await expect(loadCollectorMode(tracked.factory, probe.core.vaultId, () => 'consult')).resolves.toBe('collector');
			});

			it('does not wait for a read that failed outright: choosing the mode in use answers saved without touching storage', async () => {
				const tracked = trackedIndexedDb();
				tracked.down = true;
				const plugin = withSettingsTab(tracked.factory);
				const timers = manualWindowTimers();
				expect(await bootUntilSettled(plugin, timers, tracked)).toBe(true);
				expect(plugin.runtimeReady).toBe(true);
				tracked.down = false;
				const attempts = vi.spyOn(tracked.factory, 'open');
				await expect((plugin as unknown as ModeCore).updateCollectorMode('collector')).resolves.toEqual({ status: 'saved', inventoryAdvisor: 'unchanged' });
				expect(attempts).not.toHaveBeenCalled();
			});
		});

		// The other way of staying silent: every open succeeds, and the first read of each database never comes back.
		it('becomes ready when every open succeeds and no transaction answers', async () => {
			const tracked = trackedIndexedDb(); hangTransactions(tracked);
			const plugin = runtimeBootPlugin(tracked.factory);
			const timers = manualWindowTimers();
			expect(await bootUntilSettled(plugin, timers, tracked)).toBe(true);
			expect(plugin.runtimeReady).toBe(true);
			expect(phase(plugin)).toBe('error');
			// Ten seconds per read that gates the start, and no more than three of them in a row.
			expect([bootTiming.readyAtMs, bootTiming.settledAtMs]).toEqual([30_000, 30_000]);
		});

		it('recovers by itself, on the heartbeat, once the engine answers again, without flipping ready or opening twice', async () => {
			const tracked = sessionEngineThatDoesNotAnswer();
			const plugin = runtimeBootPlugin(tracked.factory);
			const timers = manualWindowTimers();
			expect(await bootUntilSettled(plugin, timers, tracked)).toBe(true);
			expect(phase(plugin)).toBe('error');
			// Any write to `runtimeReady` from here on is a flip.
			const readyFlips = vi.fn(); let ready = plugin.runtimeReady;
			Object.defineProperty(plugin, 'runtimeReady', { get: () => ready, set: (value: boolean) => { ready = value; readyFlips(); } });

			resumeStorage(tracked);
			// The heartbeat comes seconds after the silence, later than the moment the store refuses to ask again.
			timers.advance(5_000);
			heartbeat()();
			// The engine answers now: the timers are not fired, or a wait would run out before the fake engine got its turn.
			await vi.waitFor(() => { expect(phase(plugin)).not.toBe('error'); }, { timeout: 4_000 });
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

function runtimeBootPlugin(
	factory: IDBFactory, notes = new Map<string, string>(), local?: Map<string, unknown>,
): RuntimeBootHarness {
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
	const app = {
		vault, workspace, fileManager: vault.fileManager,
		...(local === undefined ? {} : {
			loadLocalStorage: (key: string) => local.get(key) ?? null,
			saveLocalStorage: (key: string, value: unknown) => { local.set(key, value); },
		}),
	} as unknown as App;
	const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
	const { core } = obsidianPluginCore(app, manifest, { saveData: vi.fn(async () => undefined) });
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
