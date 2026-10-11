// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import type { PilotRecoveryRuntime } from './runtime/pilot-recovery-runtime';
import { SessionRuntime } from './runtime/session-facade';
import { SessionNoteRuntime } from './runtime/session-note-runtime';
import type { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { AssistedDetectionService } from './sessions/assisted-detection-service';
import { DEFAULT_FARMING_PREPARATION } from './sessions/farming-goal-preparation';
import { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import type { PilotMetricsRecorder } from './sessions/pilot-metrics-recorder';
import type { SessionHistoryRuntimeAuthority } from './sessions/session-history';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3a: the core's side of `SessionRuntime`, over the real core and its real
 * `initializeRuntime`. The runtime's own behaviour is tested on its own
 * (`src/runtime/session-facade.test.ts`); this file proves that each of the core's 34 facade methods (`FACADE`)
 * reaches it, and that the port reads the core as it stands rather than as it was when the runtime
 * was built (with the core, before the boot builds the services, before the settings panel exists
 * and before the device can turn to consult).
 */

/** The methods both expose; `collectorMode` is a field of the core, read by the port. */
type FacadeMethod = Exclude<keyof SessionRuntime & keyof TyrianCompanionCore, 'collectorMode' | 'notifyConsultMode'>;

/**
 * Each facade method of the core, how the views call it and the arguments SessionRuntime must get.
 * A record over `FacadeMethod`, so a public method added to `SessionRuntime` and the core does not
 * compile until it has its row here.
 */
const FACADE: Readonly<Record<FacadeMethod, readonly [call: (core: TyrianCompanionCore) => unknown, args: readonly unknown[]]>> = {
	getPilotMetricsState: [(core) => core.getPilotMetricsState(), []],
	getPilotProfile: [async (core) => await core.getPilotProfile(), []],
	getPilotSilentLossReview: [async (core) => await core.getPilotSilentLossReview(), []],
	configurePilotProfile: [async (core) => await core.configurePilotProfile('linux_steam_proton', '6.10'), ['linux_steam_proton', '6.10']],
	previewPilotMetricsExport: [async (core) => await core.previewPilotMetricsExport(), []],
	exportPilotMetrics: [async (core) => await core.exportPilotMetrics(), []],
	clearPilotMetrics: [async (core) => await core.clearPilotMetrics(), []],
	reviewPilotSilentLosses: [async (core) => await core.reviewPilotSilentLosses('none_observed'), ['none_observed']],
	disablePilotMetrics: [async (core) => await core.disablePilotMetrics(), []],
	getPilotRecoveryKind: [(core) => core.getPilotRecoveryKind(), []],
	isPilotRecoveryClassificationRequired: [(core) => core.isPilotRecoveryClassificationRequired(), []],
	classifyPilotRecovery: [async (core) => await core.classifyPilotRecovery('organic'), ['organic']],
	openSessionHistoryNote: [(core) => { core.openSessionHistoryNote('Sessions/gone.md'); }, ['Sessions/gone.md']],
	getSessionHistoryView: [(core) => core.getSessionHistoryView(), []],
	loadSessionHistory: [async (core) => await core.loadSessionHistory('rebuild'), ['rebuild']],
	exportSessionHistory: [async (core) => { await core.exportSessionHistory(); }, []],
	previewSessionHistoryScrub: [async (core) => await core.previewSessionHistoryScrub(), []],
	cancelSessionHistoryScrubPreview: [(core) => { core.cancelSessionHistoryScrubPreview('scrub-token'); }, ['scrub-token']],
	scrubSessionHistory: [async (core) => await core.scrubSessionHistory('scrub-token'), ['scrub-token']],
	getFarmingGoal: [(core) => core.getFarmingGoal(), []],
	saveFarmingGoal: [async (core) => { await core.saveFarmingGoal({ version: 1, kind: 'bags', targetBags: 40 }); }, [{ version: 1, kind: 'bags', targetBags: 40 }]],
	getFarmingPreparationSettings: [(core) => core.getFarmingPreparationSettings(), []],
	saveFarmingPreparationSettings: [async (core) => { await core.saveFarmingPreparationSettings({ ...DEFAULT_FARMING_PREPARATION, enabled: true }); }, [{ ...DEFAULT_FARMING_PREPARATION, enabled: true }]],
	getFarmingDeclaredBuildPreference: [(core) => core.getFarmingDeclaredBuildPreference(), []],
	saveFarmingDeclaredBuildPreference: [async (core) => { await core.saveFarmingDeclaredBuildPreference(null); }, [null]],
	getLiveSessionAlerts: [(core) => core.getLiveSessionAlerts(), []],
	getLiveSessionView: [(core) => core.getLiveSessionView(20, 50), [20, 50]],
	getLiveSessionComparison: [(core) => core.getLiveSessionComparison(), []],
	loadLiveSessionComparison: [async (core) => { await core.loadLiveSessionComparison(); }, []],
	getSelectedLiveSessionHistory: [(core) => core.getSelectedLiveSessionHistory(), []],
	listLiveSessionHistory: [async (core) => await core.listLiveSessionHistory(), []],
	getLiveSessionSetAside: [(core) => core.getLiveSessionSetAside(), []],
	selectLiveSessionHistory: [async (core) => { await core.selectLiveSessionHistory(null); }, [null]],
	exportLiveSession: [async (core) => { await core.exportLiveSession('summary', 'json'); }, ['summary', 'json']],
	exportPreservedLegacySession: [async (core) => { await core.exportPreservedLegacySession(); }, []],
};

/** The rows of `FACADE` for `it.each`; `Object.keys` types its keys as plain strings. */
const FACADE_CASES = (Object.keys(FACADE) as FacadeMethod[]).map((name) => [name, ...FACADE[name]] as const);

/** What a call came to: its value, or the message it was refused with (the export refuses without a session). */
async function settled(outcome: unknown): Promise<{ value: unknown } | { error: string }> {
	try { return { value: await outcome }; } catch (error) { return { error: String(error) }; }
}

describe('the core hands the pilot metrics and the session history to SessionRuntime', () => {
	let harness: RuntimeHarness | null = null;
	let refreshSessionHistoryRow = vi.fn();

	afterEach(() => {
		harness?.dispose();
		harness = null;
		vi.restoreAllMocks();
	});

	/** The real core, not booted: a collector device with the settings panel's history row in place. */
	function core(): RuntimeHarness {
		const runtime = createRuntimeHarness();
		harness = runtime;
		refreshSessionHistoryRow = vi.fn();
		const setup = runtime.core as unknown as {
			localDebugActions: null;
			settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void; refreshSessionHistoryRow(): void };
		};
		// The harness's recording port predates `fireAndForget`; without a port the boot runs those
		// actions directly, as the other tests over the real runtime do.
		setup.localDebugActions = null;
		// `onload` builds the settings tab; the history's export and scrub repaint its row.
		setup.settingTab = { refreshConnectionRow: () => undefined, refreshForSettingsChange: () => undefined, refreshSessionHistoryRow };
		// A configured key is what makes this device a collector.
		runtime.core.settings = { ...runtime.core.settings, apiKeySecret: 'tyrian-test-key', language: 'es' };
		return runtime;
	}

	it.each(FACADE_CASES)('%s reaches SessionRuntime with the view\'s arguments and answers what it answers', async (name, call, args) => {
		const runtime = core();
		await runtime.initializeRuntime();
		const reached = vi.spyOn(SessionRuntime.prototype, name);

		const answer = await settled(call(runtime.core));

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(answer).toEqual(await settled(reached.mock.results[0]?.value));
	});

	/**
	 * The port is read live: `SessionRuntime` is built with the core, before `initializeRuntime` sets
	 * `runtimeReady` and builds the history and the pilot recorder, before the settings panel exists
	 * and before the device can turn to consult. A port that copied those values at construction
	 * would answer every case below with what the core had then.
	 */
	describe('the port reads the core as it stands, not as it was when SessionRuntime was built', () => {
		it('runtimeReady, sessionHistory and settingTab: before the boot the export waits; after it the boot\'s history writes it and the row follows', async () => {
			const runtime = core();
			await runtime.core.exportSessionHistory();
			const before = { view: runtime.core.getSessionHistoryView().status, row: refreshSessionHistoryRow.mock.calls.length };

			await runtime.initializeRuntime();
			await runtime.core.exportSessionHistory();

			expect({
				before,
				after: runtime.core.getSessionHistoryView().status,
				json: [...runtime.vaultNotes.keys()].some((path) => path.endsWith('.json')),
				row: refreshSessionHistoryRow.mock.calls.length,
			}).toEqual({ before: { view: 'idle', row: 0 }, after: 'written', json: true, row: 2 });
		});

		it('settings and updateSettings: a goal saved through the facade goes through the core\'s write and is read back from the settings it replaced', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const write = vi.spyOn(runtime.core, 'updateSettings');

			await runtime.core.saveFarmingGoal({ version: 1, kind: 'bags', targetBags: 77 });

			expect({
				write: write.mock.calls.length,
				saved: runtime.core.settings.farmingGoal,
				read: runtime.core.getFarmingGoal(),
			}).toEqual({
				write: 1,
				saved: { version: 1, kind: 'bags', targetBags: 77 },
				read: { version: 1, kind: 'bags', targetBags: 77 },
			});
		});

		it('liveHistory: before the boot the comparison has nothing to read; after it the boot\'s saved-session service answers', async () => {
			const runtime = core();
			await runtime.core.loadLiveSessionComparison();
			const before = runtime.core.getLiveSessionComparison().history.status;

			await runtime.initializeRuntime();
			await runtime.core.loadLiveSessionComparison();

			expect({ before, after: runtime.core.getLiveSessionComparison().history.status }).toEqual({ before: 'unavailable', after: 'ready' });
		});

		it('liveSessions: the lifecycle the boot built answers the live view', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const view = { ...runtime.core.getLiveSessionView(), sessionId: 'live-after-boot' };
			vi.spyOn(LiveSessionLifecycle.prototype, 'getView').mockReturnValue(view);

			expect(runtime.core.getLiveSessionView().sessionId).toBe('live-after-boot');
		});

		it('collectorMode: a device turned to consult after the boot is refused the scrub', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			runtime.core.collectorMode = 'consult';

			await expect(runtime.core.previewSessionHistoryScrub()).resolves.toEqual({
				status: 'unavailable', message: 'This installation is in consult mode.',
			});
		});

		it('pilotMetrics: the recorder the boot built answers the pilot state', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			// The core's own `pilotMetrics`: a private of the core, never of `SessionRuntime`.
			const recorder = (runtime.core as unknown as { pilotMetrics: PilotMetricsRecorder }).pilotMetrics;
			vi.spyOn(recorder, 'getState').mockReturnValue({ status: 'ready', observations: 3, limit: 10_000 });

			expect(runtime.core.getPilotMetricsState()).toEqual({ status: 'ready', observations: 3, limit: 10_000 });
		});

		it('pilotRecovery: what the core\'s `PilotRecoveryRuntime` fills is what the runtime reads', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			// The core's own `PilotRecoveryRuntime`: a private of the core, never of `SessionRuntime`.
			const own = pilotOf(runtime.core);
			vi.spyOn(own, 'pilotRecoveryIdentity').mockReturnValue('session-a:7');
			own.measuredPilotRecoveries.add('session-a:7');
			own.pilotRecoveryKinds.set('session-a:7', 'organic');

			expect({
				required: runtime.core.isPilotRecoveryClassificationRequired(),
				kind: runtime.core.getPilotRecoveryKind(),
			}).toEqual({ required: true, kind: 'organic' });
		});

		/** The core's own `PilotRecoveryRuntime` (DE-01, group F): a private of the core, never of `SessionRuntime`. */
		function pilotOf(core: TyrianCompanionCore): PilotRecoveryRuntime {
			return (core as unknown as { pilotRecovery: PilotRecoveryRuntime }).pilotRecovery;
		}
		/** The core's own recorder: a private of the core, never of `SessionRuntime`. */
		function recorderOf(core: TyrianCompanionCore): PilotMetricsRecorder {
			return (core as unknown as { pilotMetrics: PilotMetricsRecorder }).pilotMetrics;
		}

		it('pilotRecovery: clearing the journal through the core empties the core\'s own collections', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const own = pilotOf(runtime.core);
			own.measuredPilotRecoveries.add('session-a:7');
			own.pilotRecoveryKinds.set('session-a:7', 'organic');
			vi.spyOn(recorderOf(runtime.core), 'clear').mockResolvedValue(0);

			await runtime.core.clearPilotMetrics();

			expect({ measured: [...own.measuredPilotRecoveries], kinds: [...own.pilotRecoveryKinds] }).toEqual({ measured: [], kinds: [] });
		});

		it('pilotRecovery: a recovery classified through the core keeps its kind in the core\'s own map', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const own = pilotOf(runtime.core);
			vi.spyOn(own, 'pilotRecoveryIdentity').mockReturnValue('session-a:7');
			vi.spyOn(own, 'ensurePilotRecoveryPresented').mockResolvedValue(true);
			vi.spyOn(recorderOf(runtime.core), 'recoveryClassified').mockResolvedValue(true);

			await expect(runtime.core.classifyPilotRecovery('forced_restart')).resolves.toBe(true);

			expect(own.pilotRecoveryKinds.get('session-a:7')).toBe('forced_restart');
		});
	});

	/**
	 * DE-01, tenth wave: the history's gate, the Z2-2 preview and the export commands moved here. The core's
	 * preview is a delegate under another name, and the history's runtime authority reads its gate here and
	 * lets a finished live session go in `SessionNoteRuntime`. The commands' registration from `onload` is
	 * run in `src/runtime/tyrian-companion-core.test.ts`, over a neutral host.
	 */
	describe('the history\'s gate, the Z2-2 preview and the export (DE-01, tenth wave)', () => {
		/** The core's own authority: a private of the core, built with it. */
		const authorityOf = (core: TyrianCompanionCore): SessionHistoryRuntimeAuthority =>
			(core as unknown as { sessionHistoryRuntimeAuthority: SessionHistoryRuntimeAuthority }).sessionHistoryRuntimeAuthority;

		it('previewSessionHistoryScrub reaches SessionRuntime.previewSessionHistoryScrubAfterRecovery once and answers what it answers', async () => {
			const runtime = core();
			const answer = { status: 'unavailable', message: 'from the runtime' } as const;
			const reached = vi.spyOn(SessionRuntime.prototype, 'previewSessionHistoryScrubAfterRecovery').mockResolvedValue(answer);

			await expect(runtime.core.previewSessionHistoryScrub()).resolves.toBe(answer);
			expect(reached).toHaveBeenCalledExactlyOnceWith();
		});

		it('the history\'s runtime authority reads its gate from SessionRuntime.sessionHistoryScrubGate', () => {
			const runtime = core();
			const gate = { sessionStatus: 'idle', recoveryStatus: 'none', detectorStatus: 'disarmed', sealedRetirable: false } as const;
			const reached = vi.spyOn(SessionRuntime.prototype, 'sessionHistoryScrubGate').mockReturnValue(gate);

			expect(authorityOf(runtime.core).readGate()).toBe(gate);
			expect(reached).toHaveBeenCalledExactlyOnceWith();
		});

		it('the history\'s runtime authority lets a finished live session go through SessionNoteRuntime.retireSealedLiveSession', async () => {
			const runtime = core();
			const reached = vi.spyOn(SessionNoteRuntime.prototype, 'retireSealedLiveSession').mockResolvedValue(false);

			await expect(authorityOf(runtime.core).retireSealedRuntime()).resolves.toBe(false);
			expect(reached).toHaveBeenCalledExactlyOnceWith();
		});

		it('sessions and assistedDetection: the gate reads the session, its recovery and the detector the boot built', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			vi.spyOn(ManualSessionStartService.prototype, 'getRecoveryState').mockReturnValue({ status: 'none' });
			vi.spyOn(AssistedDetectionService.prototype, 'getState').mockReturnValue({ status: 'armed' } as ReturnType<AssistedDetectionService['getState']>);

			expect(authorityOf(runtime.core).readGate()).toEqual({
				sessionStatus: runtime.core.getLiveSessionView().phase, sealedRetirable: false, recoveryStatus: 'none', detectorStatus: 'armed',
			});
		});

		it('sessions: a preview over saved sessions that did not answer at boot asks the boot\'s service again first (Z2-2)', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			const order: string[] = [];
			vi.spyOn(ManualSessionStartService.prototype, 'getRecoveryState')
				.mockReturnValue({ status: 'error', code: 'unavailable' } as ReturnType<ManualSessionStartService['getRecoveryState']>);
			vi.spyOn(ManualSessionStartService.prototype, 'initialize').mockImplementation(async () => { order.push('initialize'); });
			vi.spyOn(SessionRuntime.prototype, 'previewSessionHistoryScrub').mockImplementation(async () => {
				order.push('preview'); return { status: 'blocked', message: 'not idle' } as never;
			});

			await runtime.core.previewSessionHistoryScrub();

			expect(order).toEqual(['initialize', 'preview']);
		});
	});
});
