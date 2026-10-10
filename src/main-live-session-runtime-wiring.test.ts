// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { LiveSessionRuntime } from './runtime/live-session-runtime';
import type { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import { ManualSessionStartService } from './sessions/manual-session-start-service';
import { SESSION_STATE_VERSION, type SessionState } from './sessions/session';
import { SessionNoteWriter } from './sessions/session-note-writer';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3c: the core's side of `LiveSessionRuntime`, over the real core and its real
 * `initializeRuntime`. The runtime's own behaviour is tested on its own
 * (`src/runtime/live-session-runtime.test.ts`); this file proves that each of the core's 14 facade
 * methods (`FACADE`) reaches it with the view's arguments and answers what it answers, and that the
 * port reads the core as it stands (before and after the boot builds the services) and writes the
 * summary's fields back to the core's own.
 */

/** The methods both expose; `collectorMode` is a field of the core, read by the port. */
type FacadeMethod = Exclude<keyof LiveSessionRuntime & keyof TyrianCompanionCore, 'collectorMode' | 'notifyConsultMode'>;

const BOUNDARY = '2026-10-11T00:00:00.000Z';

/**
 * Each facade method of the core, how the views call it and the arguments LiveSessionRuntime must get.
 * A record over `FacadeMethod`, so a public method added to `LiveSessionRuntime` and the core does
 * not compile until it has its row here.
 */
const FACADE: Readonly<Record<FacadeMethod, readonly [call: (core: TyrianCompanionCore) => unknown, args: readonly unknown[]]>> = {
	getSessionState: [(core) => core.getSessionState(), []],
	getSessionStartFailure: [(core) => core.getSessionStartFailure(), []],
	getSessionStopFailure: [(core) => core.getSessionStopFailure(), []],
	getSessionAutoRetryAt: [(core) => core.getSessionAutoRetryAt(), []],
	getSessionSettlementWait: [(core) => core.getSessionSettlementWait(), []],
	getSessionRecoveryState: [(core) => core.getSessionRecoveryState(), []],
	recoverSession: [(core) => core.recoverSession(), []],
	discardRecoveredSession: [(core) => core.discardRecoveredSession(), []],
	confirmDiscardRecoveredSession: [(core) => { core.confirmDiscardRecoveredSession(); }, []],
	confirmClearCompletedSession: [(core) => { core.confirmClearCompletedSession(); }, []],
	resetCompletedSession: [(core) => core.resetCompletedSession(), []],
	isLiveSessionStuck: [(core) => core.isLiveSessionStuck(), []],
	canAbandonSession: [(core) => core.canAbandonSession(), []],
	confirmAbandonSession: [(core) => { core.confirmAbandonSession(); }, []],
	openManualSessionStart: [(core) => { core.openManualSessionStart(BOUNDARY); }, [BOUNDARY]],
	stopManualSession: [(core) => core.stopManualSession(BOUNDARY), [BOUNDARY]],
	captureSessionFinalNow: [(core) => core.captureSessionFinalNow(), []],
};

/** What the delegates of a void method hand back: nothing. */
const VOID_METHODS = new Set<FacadeMethod>([
	'confirmDiscardRecoveredSession', 'confirmClearCompletedSession', 'confirmAbandonSession', 'openManualSessionStart',
]);

describe('the core hands the session state and the ways out of a session to LiveSessionRuntime', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
		vi.restoreAllMocks();
	});

	/** The real core, not booted: a collector device. */
	function core(): RuntimeHarness {
		const runtime = createRuntimeHarness();
		harness = runtime;
		const setup = runtime.core as unknown as {
			localDebugActions: null;
			settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void };
		};
		// The harness's recording port predates `fireAndForget`; without a port the boot runs those
		// actions directly, as the other tests over the real runtime do.
		setup.localDebugActions = null;
		setup.settingTab = { refreshConnectionRow: () => undefined, refreshForSettingsChange: () => undefined };
		// A configured key is what makes this device a collector.
		runtime.core.settings = { ...runtime.core.settings, apiKeySecret: 'tyrian-test-key', language: 'es' };
		return runtime;
	}

	// The runtime's answer is replaced by a token of its own, so the commands these reach (built in
	// `onload`, which this harness does not run) are never driven: what is read is the delegation.
	it.each(Object.keys(FACADE) as FacadeMethod[])('%s reaches LiveSessionRuntime once, with the view\'s arguments, and answers what it answers', async (name) => {
		const runtime = core();
		await runtime.initializeRuntime();
		const token = { answeredBy: name };
		const reached = vi.spyOn(LiveSessionRuntime.prototype, name).mockImplementation((() => token) as never);
		const [call, args] = FACADE[name];

		const answer = call(runtime.core);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(answer).toBe(VOID_METHODS.has(name) ? undefined : token);
	});

	describe('the port reads the core as it stands and writes the summary back to it', () => {
		it('collectorMode: a device turned to consult after the boot is refused a start, through the core\'s own notice', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			runtime.core.collectorMode = 'consult';
			const notified = vi.spyOn(runtime.core, 'notifyConsultMode').mockImplementation(() => undefined);

			runtime.core.openManualSessionStart();

			expect(notified).toHaveBeenCalledOnce();
		});

		it('farmingReminders: a start clears the reminders the core keeps for the next session', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			runtime.core.startFarmingReminder('food', 30);
			vi.spyOn(ManualSessionStartService.prototype, 'start').mockResolvedValue({
				status: 'started',
				state: { sessionId: 'started-session', requestedAt: '2026-10-11T00:00:00.000Z', baseline: { completedAt: '2026-10-11T00:00:05.000Z' } },
			} as unknown as Awaited<ReturnType<ManualSessionStartService['start']>>);
			// The start is run by the start modal `onload` sets up; here, straight on the core's own runtime.
			const { live } = runtime.core as unknown as { live: Pick<LiveSessionRuntime, 'startManualSession'> };
			const before = runtime.core.getFarmingReminders().length;

			await live.startManualSession({ characterName: 'Astra Uno' } as Parameters<LiveSessionRuntime['startManualSession']>[0]);

			expect({ before, after: runtime.core.getFarmingReminders().length }).toEqual({ before: 1, after: 0 });
		});

		it('runtimeReady and sessions: before the boot the state is neutral; after it the boot\'s session service answers', async () => {
			const runtime = core();
			const before = runtime.core.getSessionState();
			await runtime.initializeRuntime();
			const active = { version: SESSION_STATE_VERSION, status: 'active', sessionId: 'after-boot' } as SessionState;
			vi.spyOn(ManualSessionStartService.prototype, 'getState').mockReturnValue(active);

			expect({ before, after: runtime.core.getSessionState() })
				.toEqual({ before: { version: SESSION_STATE_VERSION, status: 'idle' }, after: active });
		});

		it('liveSessions: before the boot nothing is stuck; after it the lifecycle the boot built answers', async () => {
			const runtime = core();
			const before = runtime.core.isLiveSessionStuck();
			await runtime.initializeRuntime();
			vi.spyOn(LiveSessionLifecycle.prototype, 'isStuck').mockReturnValue(true);

			expect({ before, after: runtime.core.isLiveSessionStuck() }).toEqual({ before: false, after: true });
		});

		it('savedSessionNotePath and sessionSummarySaveState: an abandon leaves its note in the core\'s own fields', async () => {
			const runtime = core();
			await runtime.initializeRuntime();
			vi.spyOn(ManualSessionStartService.prototype, 'abandon').mockResolvedValue(
				{ status: 'abandoned', state: { sessionId: 'abandoned-session' } } as Awaited<ReturnType<ManualSessionStartService['abandon']>>,
			);
			vi.spyOn(SessionNoteWriter.prototype, 'writeAbandoned').mockResolvedValue({ status: 'written', path: 'Tyrian Companion/abandoned.md' });
			// The abandon is run by the session commands `onload` sets up; here, straight on the core's own runtime.
			const { live } = runtime.core as unknown as { live: Pick<LiveSessionRuntime, 'performAbandonSession'> };

			await live.performAbandonSession();

			expect({ state: runtime.core.getSessionSummarySaveState(), path: runtime.core.getSavedSessionNotePath() })
				.toEqual({ state: 'unknown', path: 'Tyrian Companion/abandoned.md' });
		});
	});
});
