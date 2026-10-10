import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { DEFAULT_SETTINGS } from './core/settings';
import { LiveSessionRuntime, type LiveSessionRuntimePort } from './runtime/live-session-facade';
import { TyrianCompanionCore } from './runtime/tyrian-companion-core';

/**
 * Was matched over the characters of `tyrian-companion-core.ts`:
 * - `pending-proposal-architecture.test.ts` ('keeps ordinary manual workflows independent from
 *   pending queue receipts'): the start and the stop held
 *   `const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null` and
 *   `if (intent && pendingClaim)`, and never read the queue's state;
 * - `pilot-metrics-architecture.test.ts`: the core contains `sessionStarted`, `sessionCompleted`,
 *   `workflow: 'succeeded'` and `workflow: 'failed'`, and the stop holds
 *   `this.assistedDetection.disarm('session_stopped')` but not
 *   `invalidateAndDisarmAssistedDetection('session_stopped')`.
 * Here the start, the stop and the step after a finalization run, and what they ask of the queue,
 * the pilot journal and the detector is read. The stop's own workflow outcome in the journal is
 * `src/main.test.ts` ('stop workflow outcome in the receipt and the pilot (H18.4)').
 */

const INTENT = { proposalId: 'proposal-1', accountId: 'account-1', phase: 'start' as const, binding: { kind: 'account' as const } };
const STOP_INTENT = { proposalId: 'proposal-2', accountId: 'account-1', phase: 'stop' as const, binding: { kind: 'session' as const, sessionId: 'session-1', baselineSnapshotId: 'before' } };
const INPUT = { characterName: 'Astra Uno', magicFind: 321, consumablesBonus: 0 };

/**
 * DE-01, step 3c: the start, the stop and the finalization are `LiveSessionRuntime`'s. They run here
 * on a runtime built over the harness through the core's own port (`liveSessionRuntimePort`), so the
 * harness's fields and the core's methods it lends are read as the runtime reads them in production.
 */
function liveOver(harness: object): {
	startManualSession(input: unknown, intent?: unknown): Promise<void>;
	performStopManualSession(intent?: unknown): Promise<void>;
	finishFinalizedSession(sessionId: string, delta: unknown, reviewed: unknown): Promise<boolean>;
} {
	const portOf = (TyrianCompanionCore as unknown as {
		liveSessionRuntimePort(this: void, core: object): LiveSessionRuntimePort;
	}).liveSessionRuntimePort;
	return new LiveSessionRuntime(portOf(harness));
}

/** A start or a stop, with the pending queue, the journal and the backend each recording what it is asked. */
function workflowHarness(phase: 'start' | 'stop', backend: 'succeeds' | 'fails' = 'succeeds') {
	const order: string[] = [];
	const acquirePendingIntent = vi.fn(async () => {
		order.push('claim');
		return { proposal: { phase, proposalId: phase === 'start' ? 'proposal-1' : 'proposal-2', proposal: { proposalId: 'detected' } }, operationId: 'operation-1', stopRenewal: vi.fn() };
	});
	const accept = vi.fn(async () => { order.push('accept'); return true; });
	const queueRead = vi.fn(() => { throw new Error('The manual workflow read the pending queue.'); });
	const pilotMetrics = { sessionStarted: vi.fn(async () => true), proposalDecided: vi.fn(async () => true), sessionCompleted: vi.fn(async () => true) };
	const disarm = vi.fn();
	const invalidateAndDisarmAssistedDetection = vi.fn();
	const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
		settings: { ...DEFAULT_SETTINGS, preferredCharacter: 'Astra Uno' },
		farmingGroupContext: null,
		sessionHistoryRuntimeAuthority: { runtimeMutationAllowed: () => true, acquireRuntimeMutation: () => ({ release: vi.fn() }) },
		requireRuntimeMutationLease: () => ({ release: vi.fn() }),
		acquirePendingIntent,
		pendingProposals: { accept, getState: queueRead },
		getPendingProposalState: queueRead,
		assistedDetection: { getState: () => ({ status: 'armed' }), dismissProposal: vi.fn(), disarm },
		invalidateAndDisarmAssistedDetection,
		ensureCompletedSummarySaved: vi.fn(async () => true),
		persistFarmingSessionContext: vi.fn(),
		// The live observation a start begins, and the summary a stop's finalization writes.
		liveSessionLoot: { begin: vi.fn(), reconcile: vi.fn(async () => undefined) },
		persistCompletedSessionSummary: vi.fn(async () => ({ status: 'written' as const, path: 'session.md' })),
		refreshLootPresentation: vi.fn(async () => undefined),
		observeHalloweenDelta: vi.fn(async () => undefined),
		emitNotice: vi.fn(),
		detectionQuality: { recordAccepted: vi.fn(async () => undefined) },
		priceHistory: null,
		pilotMetrics,
		sessions: {
			getBaselineSnapshot: () => null,
			finalizeStoppedSession: vi.fn(async () => ({
				status: 'finalized' as const, state: { status: 'complete' as const, sessionId: 'session-1', finalizedAt: '2026-09-01T08:10:00.000Z' },
				review: { classification: { status: 'exact', reasons: [] } },
			})),
			getCompletedRuntimeRecord: vi.fn(async () => ({ state: { status: 'complete', sessionId: 'session-1' } })),
			start: vi.fn(async () => {
				order.push('backend');
				return backend === 'succeeds'
					? { status: 'started' as const, state: { sessionId: 'session-1', requestedAt: '2026-09-01T08:00:00.000Z', baseline: { completedAt: '2026-09-01T08:00:05.000Z' } } }
					: { status: 'failed' as const, failure: { code: 'snapshot_failed', message: 'failed' } };
			}),
			stop: vi.fn(async () => {
				order.push('backend');
				return { status: 'stopped' as const, resumed: true, state: { sessionId: 'session-1' }, delta: { status: 'comparable', itemChanges: [] } };
			}),
			getPriceSnapshot: () => null,
		},
		updateSettings: vi.fn(async () => ({ status: 'saved' })),
		renderViews: vi.fn(), localDebugActions: null,
	});
	const run = (intent?: unknown) => phase === 'start'
		? liveOver(harness).startManualSession(INPUT, intent)
		: liveOver(harness).performStopManualSession(intent);
	return { run, order, acquirePendingIntent, accept, queueRead, pilotMetrics, disarm, invalidateAndDisarmAssistedDetection };
}

describe('manual workflows and the pending confirmation queue (H5.3)', () => {
	it.each(['start', 'stop'] as const)('a manual %s claims, accepts and reads nothing of the pending queue', async (phase) => {
		const harness = workflowHarness(phase);

		await harness.run();

		expect(harness.order).toEqual(['backend']);
		expect(harness.acquirePendingIntent).not.toHaveBeenCalled();
		expect(harness.accept).not.toHaveBeenCalled();
		expect(harness.queueRead).not.toHaveBeenCalled();
	});

	it.each(['start', 'stop'] as const)('the %s of a confirmed proposal claims it before the backend and accepts it with that claim', async (phase) => {
		const harness = workflowHarness(phase);
		const intent = phase === 'start' ? INTENT : STOP_INTENT;

		await harness.run(intent);

		expect(harness.order).toEqual(['claim', 'backend', 'accept']);
		expect(harness.acquirePendingIntent).toHaveBeenCalledWith(intent);
		expect(harness.accept).toHaveBeenCalledWith(intent, 'operation-1', 'session-1', ...(phase === 'stop' ? ['succeeded'] : []));
		expect(harness.queueRead).not.toHaveBeenCalled();
	});
});

describe('a session\'s own lifecycle in the pilot journal (H0.6)', () => {
	it('journals a started session with its baseline time, and its confirmed proposal as succeeded', async () => {
		const harness = workflowHarness('start');

		await harness.run(INTENT);

		expect(harness.pilotMetrics.sessionStarted).toHaveBeenCalledExactlyOnceWith('session-1', '2026-09-01T08:00:05.000Z');
		expect(harness.pilotMetrics.proposalDecided).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			proposalId: 'proposal-1', decision: 'accepted', workflow: 'succeeded',
		}));
	});

	it('journals a confirmed proposal whose start failed as failed, and no started session', async () => {
		const harness = workflowHarness('start', 'fails');

		await expect(harness.run(INTENT)).rejects.toThrow('Start failed.');

		expect(harness.pilotMetrics.sessionStarted).not.toHaveBeenCalled();
		expect(harness.pilotMetrics.proposalDecided).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			proposalId: 'proposal-1', decision: 'accepted', workflow: 'failed',
		}));
	});

	it('journals a finalized session as completed, at its finalization time', async () => {
		const sessionCompleted = vi.fn(async () => true);
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			pilotMetrics: { sessionCompleted },
			sessions: { getCompletedRuntimeRecord: vi.fn(async () => null) },
			emitNotice: vi.fn(), settings: { language: 'en' as const },
		});

		await liveOver(harness).finishFinalizedSession('session-1', { status: 'comparable' }, {
			state: { sessionId: 'session-1', finalizedAt: '2026-09-01T08:10:00.000Z' }, review: { classification: { status: 'exact', reasons: [] } },
		});

		expect(sessionCompleted).toHaveBeenCalledExactlyOnceWith('session-1', '2026-09-01T08:10:00.000Z');
	});
});

describe('a stop and the assisted detector', () => {
	it('disarms the detector as session_stopped and never invalidates the proposal it accepted', async () => {
		const harness = workflowHarness('stop');

		await harness.run(STOP_INTENT);

		expect(harness.disarm).toHaveBeenCalledExactlyOnceWith('session_stopped');
		expect(harness.invalidateAndDisarmAssistedDetection).not.toHaveBeenCalled();
	});
});
