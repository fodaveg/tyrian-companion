import { describe, expect, it, vi } from 'vitest';

import { LiveSessionRuntime, type LiveSessionRuntimePort } from './live-session-facade';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { DEFAULT_SETTINGS } from '../core/settings';
import { SESSION_STATE_VERSION } from '../sessions/session';
import type { StoredSessionLootSummary } from '../sessions/session-note-renderer';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import { SessionCommandController, type SessionCommandPorts } from '../ui/session-command-controller';
import type { SessionCommandContext } from '../ui/session-command-model';

/**
 * DE-01, step 3c: `LiveSessionRuntime` on its own, over ports checked with
 * `satisfies LiveSessionRuntimePort`. The recovery's pilot journal cases moved here from
 * `src/main-session-recovery-pilot.test.ts`, and from `src/main.test.ts` the recovery's backend
 * failure ('recovery backend failure observability (H15.6)') and the session state's half of the
 * 'deferred runtime boot guard'; they drove the same code as methods of `TyrianCompanionCore` on a
 * plain object, and their titles and assertions are theirs.
 * The core's side (that the real core builds this runtime and reads its fields live) is
 * `src/main-live-session-runtime-wiring.test.ts`.
 */

/** Every member a case does not use throws, so a case reaching one by mistake says so. */
function unused(name: string): () => never {
	return () => { throw new Error(`${name} is not part of this case`); };
}

/** A ready collector with an idle session, no recovery and every service stubbed out. */
function port(overrides: Partial<LiveSessionRuntimePort> = {}): LiveSessionRuntimePort {
	return {
		settings: { language: 'en', outputFolder: 'Tyrian Companion', farmingGoal: DEFAULT_SETTINGS.farmingGoal, preferredCharacter: 'Astra Uno' },
		runtimeReady: true,
		collectorMode: 'collector',
		localDebugActions: null,
		sessionHistoryRuntimeAuthority: { runtimeMutationAllowed: () => true, acquireRuntimeMutation: () => ({ release: () => undefined }) },
		sessions: {
			getState: () => ({ version: SESSION_STATE_VERSION, status: 'idle' }),
			getLastFailure: () => null,
			getLastStopFailure: () => null,
			getAutoRetryAt: () => null,
			getSettlementWait: () => null,
			getRecoveryState: () => ({ status: 'none' }),
			recover: unused('sessions.recover'),
			discardRecovery: unused('sessions.discardRecovery'),
			canAbandon: () => false,
			abandon: unused('sessions.abandon'),
			getCompletedRuntimeRecord: unused('sessions.getCompletedRuntimeRecord'),
			resetCompletedSession: unused('sessions.resetCompletedSession'),
			start: unused('sessions.start'),
			stop: unused('sessions.stop'),
			stopAt: unused('sessions.stopAt'),
			captureFinalNow: unused('sessions.captureFinalNow'),
			getPriceSnapshot: () => null,
			finalizeStoppedSession: unused('sessions.finalizeStoppedSession'),
			getBaselineSnapshot: unused('sessions.getBaselineSnapshot'),
		},
		liveSessions: null,
		liveSessionLoot: { getState: () => ({ status: 'idle' }), begin: unused('liveSessionLoot.begin'), reconcile: unused('liveSessionLoot.reconcile') },
		ingameSessionMarker: null,
		sessionNotes: { write: unused('sessionNotes.write'), writeAbandoned: unused('sessionNotes.writeAbandoned') },
		sessionCommands: { run: unused('sessionCommands.run') },
		sessionDispatch: { recover: unused('sessionDispatch.recover'), discard: unused('sessionDispatch.discard'), finish: unused('sessionDispatch.finish') },
		pilotMetrics: {
			recoveryFinished: unused('pilotMetrics.recoveryFinished'),
			sessionStarted: unused('pilotMetrics.sessionStarted'),
			sessionCompleted: unused('pilotMetrics.sessionCompleted'),
			proposalDecided: unused('pilotMetrics.proposalDecided'),
		},
		assistedDetection: {
			getState: unused('assistedDetection.getState'),
			disarm: unused('assistedDetection.disarm'),
			dismissProposal: unused('assistedDetection.dismissProposal'),
			armFromSnapshot: unused('assistedDetection.armFromSnapshot'),
		},
		detectionQuality: { recordAccepted: unused('detectionQuality.recordAccepted') },
		pendingProposals: { accept: unused('pendingProposals.accept') },
		priceHistory: null,
		farmingGroupContext: null,
		sessionSummarySaveState: 'unknown',
		storedSessionLootSummary: null,
		savedSessionNotePath: null,
		farmingReminders: [],
		notifyConsultMode: unused('notifyConsultMode'),
		notifyRuntimeStarting: unused('notifyRuntimeStarting'),
		requireRuntimeMutationLease: () => ({ release: () => undefined }),
		renderViews: () => undefined,
		emitNotice: unused('emitNotice'),
		armAssistedDetection: unused('armAssistedDetection'),
		pilotRecoveryIdentity: () => null,
		ensurePilotRecoveryPresented: unused('ensurePilotRecoveryPresented'),
		sessionNoteInput: unused('sessionNoteInput'),
		acquirePendingIntent: unused('acquirePendingIntent'),
		ensureCompletedSummarySaved: unused('ensureCompletedSummarySaved'),
		persistFarmingSessionContext: unused('persistFarmingSessionContext'),
		updateSettings: unused('updateSettings'),
		getIngamePresence: unused('getIngamePresence'),
		persistCompletedSessionSummary: unused('persistCompletedSessionSummary'),
		refreshLootPresentation: unused('refreshLootPresentation'),
		observeHalloweenDelta: unused('observeHalloweenDelta'),
		...overrides,
	} satisfies LiveSessionRuntimePort;
}

type RecoveryKind = 'recover' | 'discard';

interface RecoveryHarness {
	readonly run: () => Promise<void>;
	readonly backend: ReturnType<typeof vi.fn>;
	readonly recoveryFinished: ReturnType<typeof vi.fn>;
	readonly recoveryPresented: ReturnType<typeof vi.fn>;
}

/**
 * The recovery on screen is `session-a:7`; `presented` is what recording it as presented answers
 * (the core's `ensurePilotRecoveryPresented`, through the port).
 */
function recoveryHarness(kind: RecoveryKind, outcome: 'confirms' | 'refuses' | 'throws', presented: Promise<boolean> = Promise.resolve(true)): RecoveryHarness {
	type RecoveryResult = Awaited<ReturnType<LiveSessionRuntimePort['sessions']['recover']>>;
	const confirmed: RecoveryResult = kind === 'recover'
		? { status: 'recovered', state: { version: SESSION_STATE_VERSION, status: 'idle' } }
		: { status: 'discarded' };
	const backend = vi.fn(async (): Promise<RecoveryResult> => {
		if (outcome === 'throws') throw new Error('Storage unavailable.');
		return outcome === 'confirms' ? confirmed : { status: 'failed', message: 'refused' };
	});
	const recoveryFinished = vi.fn(async () => true);
	const recoveryPresented = vi.fn(() => presented);
	const base = port();
	const runtime = new LiveSessionRuntime(port({
		sessions: {
			...base.sessions,
			recover: kind === 'recover' ? backend : unused('sessions.recover'),
			discardRecovery: kind === 'discard' ? backend : unused('sessions.discardRecovery'),
		},
		pilotMetrics: { ...base.pilotMetrics, recoveryFinished },
		pilotRecoveryIdentity: () => 'session-a:7',
		ensurePilotRecoveryPresented: recoveryPresented,
	}));
	const run = kind === 'recover' ? () => runtime.performRecoverSession() : () => runtime.performDiscardRecoveredSession();
	return { run, backend, recoveryFinished, recoveryPresented };
}

const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

describe('saved-session recovery in the pilot journal (H0.6)', () => {
	it.each([
		['recover', 'confirms', 'succeeded'],
		['recover', 'refuses', 'failed'],
		['recover', 'throws', 'failed'],
		['discard', 'confirms', 'discarded'],
		['discard', 'refuses', 'failed'],
		['discard', 'throws', 'failed'],
	] as const)('closes a %s the backend %s as %s, once', async (kind, outcome, finished) => {
		const harness = recoveryHarness(kind, outcome);

		if (outcome === 'confirms') await expect(harness.run()).resolves.toBeUndefined();
		else await expect(harness.run()).rejects.toThrow();

		expect(harness.recoveryPresented).toHaveBeenCalledWith('session-a:7');
		expect(harness.recoveryFinished.mock.calls).toEqual([['session-a:7', finished]]);
	});

	it.each(['recover', 'discard'] as const)('runs the %s without waiting for the journal to record it as presented', async (kind) => {
		const harness = recoveryHarness(kind, 'confirms', new Promise<boolean>(() => undefined));

		const run = harness.run();
		await flush();

		expect(harness.backend).toHaveBeenCalledOnce();
		await expect(run).resolves.toBeUndefined();
		expect(harness.recoveryFinished).toHaveBeenCalledOnce();
	});
});

describe('recovery backend failure observability (H15.6)', () => {
	it('logs session_recover failure with the backend status as its code, never the free-text message', async () => {
		const diagnosticsEvent: LocalDebugActionPort['event'] = vi.fn();
		const base = port();
		const runtime = new LiveSessionRuntime(port({
			sessions: {
				...base.sessions,
				recover: vi.fn(async () => ({
					status: 'failed' as const,
					message: 'The recovered authority could not be persisted safely.',
				})),
			},
		}));
		const notify = vi.fn();
		const controller = new SessionCommandController({
			getContext: () => ({
				state: { version: 1, status: 'idle' },
				recovery: { status: 'available', state: { sessionId: 'session-a', authority: { fence: 1 } } } as SessionCommandContext['recovery'],
				connection: 'connected',
				stopFailure: null,
			}),
			prepare: () => Promise.resolve(() => runtime.performRecoverSession()),
			notify,
			diagnostics: {
				createContext: (ctx) => ({ ...ctx, actionId: 'a', correlationId: 'a' }),
				event: diagnosticsEvent,
			} satisfies LocalDebugActionPort,
		} satisfies SessionCommandPorts);

		await expect(controller.runWithOutcome('recover-saved-session')).resolves.toBe('failed');

		expect(notify).toHaveBeenCalledTimes(1);
		expect(diagnosticsEvent).toHaveBeenCalledWith(expect.objectContaining({
			component: 'session', action: 'session_recover', phase: 'failure',
		}));
		const [loggedEvent] = (diagnosticsEvent as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
		expect((loggedEvent.details as Record<string, unknown> | undefined)?.code).toBe('failed');
		expect(JSON.stringify(loggedEvent)).not.toContain('persisted safely');
	});
});

describe('deferred runtime boot guard', () => {
	// The session state's half of the case in `src/main.test.ts`.
	it('answers connection and session state neutrally instead of touching an unassigned service', () => {
		const base = port();
		const unassigned = Object.fromEntries(Object.keys(base.sessions).map((name) => [name, unused(`sessions.${name}`)]));
		const runtime = new LiveSessionRuntime(port({
			runtimeReady: false, sessions: unassigned as unknown as LiveSessionRuntimePort['sessions'],
		}));

		// A port whose `sessions` throws on any touch; reaching a neutral value instead proves the guard.
		expect(runtime.getSessionState()).toEqual({ version: SESSION_STATE_VERSION, status: 'idle' });
	});
});

describe('the ways out of a session reset the summary through the port', () => {
	it('an abandon writes its note, resets the summary to it and arms the detection again', async () => {
		type AbandonResult = Awaited<ReturnType<LiveSessionRuntimePort['sessions']['abandon']>>;
		// Only the note writer reads the abandoned state, and it is a stub here.
		const abandoned = { status: 'abandoned', state: { sessionId: 'session-b' } } as unknown as AbandonResult;
		const base = port();
		const armAssistedDetection = vi.fn(async () => undefined);
		const writeAbandoned = vi.fn(async () => ({ status: 'written' as const, path: 'Tyrian Companion/abandoned.md' }));
		// The previous session's loot summary; only its identity matters here.
		const previousLoot = { items: [] } as unknown as StoredSessionLootSummary;
		const live = port({
			sessionSummarySaveState: 'saved', savedSessionNotePath: 'Tyrian Companion/old.md', storedSessionLootSummary: previousLoot,
			sessions: { ...base.sessions, abandon: vi.fn(async () => abandoned) },
			sessionNotes: { ...base.sessionNotes, writeAbandoned },
			armAssistedDetection,
		});

		await new LiveSessionRuntime(live).performAbandonSession();
		await flush();

		expect(writeAbandoned).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', outputFolder: 'Tyrian Companion' }));
		expect({ state: live.sessionSummarySaveState, path: live.savedSessionNotePath, loot: live.storedSessionLootSummary })
			.toEqual({ state: 'unknown', path: 'Tyrian Companion/abandoned.md', loot: null });
		expect(armAssistedDetection).toHaveBeenCalledOnce();
	});

	it('a session the service took back on its own gets its loot poll back only when the poll no longer follows it', () => {
		// The loot poll's start (`startLiveObservation`): the loot tracker begins the session, restored.
		const begin = vi.fn();
		const base = port();
		const active = {
			...base.sessions,
			getState: () => ({ status: 'active', sessionId: 'session-c' }) as ReturnType<LiveSessionRuntimePort['sessions']['getState']>,
			getBaselineSnapshot: () => ({ snapshotId: 'baseline' }) as ReturnType<LiveSessionRuntimePort['sessions']['getBaselineSnapshot']>,
		};
		const assistedDetection = {
			...base.assistedDetection,
			armFromSnapshot: () => ({ status: 'armed' }) as ReturnType<LiveSessionRuntimePort['assistedDetection']['armFromSnapshot']>,
		};
		new LiveSessionRuntime(port({
			sessions: active, assistedDetection, liveSessionLoot: { ...base.liveSessionLoot, getState: () => ({ status: 'idle' }), begin },
		})).resumeAutoRecoveredSession();
		new LiveSessionRuntime(port({
			sessions: active, assistedDetection,
			liveSessionLoot: {
				...base.liveSessionLoot, begin,
				getState: () => ({ status: 'observing', sessionId: 'session-c' }) as ReturnType<LiveSessionRuntimePort['liveSessionLoot']['getState']>,
			},
		})).resumeAutoRecoveredSession();

		expect(begin.mock.calls).toEqual([['session-c', true]]);
	});

	it('a clear writes the finished session\'s note before it resets the session, and releases its lease when it is refused', async () => {
		const order: string[] = [];
		const release = vi.fn();
		const base = port();
		const runtime = new LiveSessionRuntime(port({
			requireRuntimeMutationLease: () => ({ release }),
			sessions: {
				...base.sessions,
				getCompletedRuntimeRecord: vi.fn(async () => ({ state: { status: 'complete', sessionId: 'session-d' } }) as unknown as SessionRuntimeRecord),
				resetCompletedSession: vi.fn(async () => { order.push('reset'); return false; }),
			},
			sessionNoteInput: () => ({ prepared: true }) as never,
			sessionNotes: { ...base.sessionNotes, write: vi.fn(async () => { order.push('write'); return { status: 'written' as const, path: 'session.md' }; }) },
		}));

		await expect(runtime.performClearCompletedSession()).rejects.toThrow('Clear failed.');

		expect(order).toEqual(['write', 'reset']);
		expect(release).toHaveBeenCalledOnce();
	});
});
