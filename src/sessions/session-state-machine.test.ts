import { describe, expect, it } from 'vitest';

import {
	initialSessionState,
	isSessionEvent,
	isSessionState,
	sessionAuthorityFromLease,
	transitionSession,
} from './session-state-machine';
import type {
	SessionAuthority,
	SessionEvent,
	SessionSnapshotReference,
	SessionState,
} from './session';
import type { SessionStartContext } from './session-start-capture';

const REQUESTED_AT = '2026-08-13T08:00:00.000Z';
const BASELINE_STARTED_AT = '2026-08-13T08:00:01.000Z';
const BASELINE_COMPLETED_AT = '2026-08-13T08:00:02.000Z';
const STOP_REQUESTED_AT = '2026-08-13T09:00:00.000Z';
const STOPPED_AT = '2026-08-13T09:00:01.000Z';
const FINAL_STARTED_AT = '2026-08-13T09:00:02.000Z';
const FINAL_COMPLETED_AT = '2026-08-13T09:00:03.000Z';
const FINALIZED_AT = '2026-08-13T09:00:04.000Z';

const authority: SessionAuthority = {
	machineId: 'machine-1',
	instanceId: 'instance-1',
	sessionId: 'session-1',
	fence: 7,
	acquiredAt: Date.parse(REQUESTED_AT) - 1,
};

const baseline: SessionSnapshotReference = {
	snapshotId: 'snapshot-before',
	accountId: 'account-1',
	schemaVersion: '2024-07-20T01:00:00.000Z',
	startedAt: BASELINE_STARTED_AT,
	completedAt: BASELINE_COMPLETED_AT,
	quality: 'stable',
};

const finalSnapshot: SessionSnapshotReference = {
	snapshotId: 'snapshot-after',
	accountId: 'account-1',
	schemaVersion: '2024-07-20T01:00:00.000Z',
	startedAt: FINAL_STARTED_AT,
	completedAt: FINAL_COMPLETED_AT,
	quality: 'stable_owned_placement_changed',
};

const startContext: SessionStartContext = {
	characterName: 'Fixture Character',
	magicFind: { value: 321, source: 'manual' },
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
	capturedAt: '2026-08-13T08:00:03.000Z',
};

const events = {
	start: { type: 'request_start', authority, requestedAt: REQUESTED_AT },
	started: { type: 'confirm_start', authority, baseline, startContext },
	stop: { type: 'request_stop', authority, requestedAt: STOP_REQUESTED_AT },
	stopped: { type: 'confirm_stop', authority, stoppedAt: STOPPED_AT, finalSnapshot },
	finalize: { type: 'finalize', authority, finalizedAt: FINALIZED_AT, classification: 'exact' },
} satisfies Record<string, SessionEvent>;

describe('session state machine', () => {
	it('runs the complete idle to complete lifecycle', () => {
		let state: SessionState = initialSessionState();
		const statuses: string[] = [state.status];
		for (const event of [events.start, events.started, events.stop, events.stopped, events.finalize]) {
			state = apply(state, event);
			statuses.push(state.status);
		}

		expect(statuses).toEqual(['idle', 'starting', 'active', 'stopping', 'provisional', 'complete']);
		expect(state).toMatchObject({
			status: 'complete',
			classification: 'exact',
			baseline: { snapshotId: 'snapshot-before' },
			startContext: { characterName: 'Fixture Character', magicFind: { value: 321 } },
			finalSnapshot: { snapshotId: 'snapshot-after' },
		});
		expect(isSessionState(state)).toBe(true);
	});

	it.each(['exact', 'estimated', 'contaminated'] as const)('accepts the %s terminal classification', (classification) => {
		const provisional = stateAt('provisional');
		const completed = apply(provisional, { ...events.finalize, classification });
		expect(completed).toMatchObject({ status: 'complete', classification });
	});

	it.each(['starting', 'active', 'stopping', 'provisional'] as const)('can fail safely from %s', (status) => {
		const state = stateAt(status);
		const failedAt = status === 'provisional' ? FINALIZED_AT : FINAL_COMPLETED_AT;
		const result = transitionSession(state, {
			type: 'fail',
			authority,
			failedAt,
			code: 'snapshot_failed',
		});

		expect(result).toMatchObject({
			status: 'applied',
			state: { status: 'error', code: 'snapshot_failed', failedState: { status } },
		});
		if (result.status === 'applied') expect(isSessionState(result.state)).toBe(true);
	});

	it('preserves the complete failed state for recovery and resets only terminal states', () => {
		const provisional = stateAt('provisional');
		const failed = apply(provisional, {
			type: 'fail',
			authority,
			failedAt: FINALIZED_AT,
			code: 'classification_invalid',
		});
		expect(failed).toMatchObject({
			status: 'error',
			failedState: {
				status: 'provisional',
				baseline: { snapshotId: baseline.snapshotId },
				finalSnapshot: { snapshotId: finalSnapshot.snapshotId },
			},
		});
		expect(apply(failed, { type: 'reset' })).toEqual(initialSessionState());
		expect(apply(stateAt('complete'), { type: 'reset' })).toEqual(initialSessionState());
		expect(transitionSession(stateAt('active'), { type: 'reset' })).toMatchObject({
			status: 'rejected',
			reason: 'illegal_transition',
		});
	});

	it('makes redelivered transition events idempotent', () => {
		const cases: Array<[SessionState, SessionEvent]> = [
			[stateAt('starting'), events.start],
			[stateAt('active'), events.started],
			[stateAt('stopping'), events.stop],
			[stateAt('provisional'), events.stopped],
			[stateAt('complete'), events.finalize],
		];
		for (const [state, event] of cases) {
			expect(transitionSession(state, event)).toEqual({ status: 'unchanged', state });
		}

		const error = apply(stateAt('active'), {
			type: 'fail', authority, failedAt: FINAL_COMPLETED_AT, code: 'unexpected',
		});
		expect(transitionSession(error, {
			type: 'fail', authority, failedAt: FINAL_COMPLETED_AT, code: 'unexpected',
		})).toEqual({ status: 'unchanged', state: error });
		expect(transitionSession(initialSessionState(), { type: 'reset' })).toEqual({
			status: 'unchanged', state: initialSessionState(),
		});
	});

	it('keeps causally completed events idempotent after later phases', () => {
		const complete = stateAt('complete');
		for (const event of [events.start, events.started, events.stop, events.stopped]) {
			expect(transitionSession(complete, event)).toEqual({ status: 'unchanged', state: complete });
		}

		const failed = apply(stateAt('provisional'), {
			type: 'fail', authority, failedAt: FINALIZED_AT, code: 'unexpected',
		});
		for (const event of [events.start, events.started, events.stop, events.stopped]) {
			expect(transitionSession(failed, event)).toEqual({ status: 'unchanged', state: failed });
		}
	});

	it('rejects stale or foreign fencing authority', () => {
		const active = stateAt('active');
		for (const changed of [
			{ ...authority, fence: authority.fence - 1 },
			{ ...authority, instanceId: 'another-instance' },
			{ ...authority, sessionId: 'another-session' },
		]) {
			expect(transitionSession(active, {
				type: 'request_stop', authority: changed, requestedAt: STOP_REQUESTED_AT,
			})).toMatchObject({ status: 'rejected', reason: 'authority_mismatch' });
		}
	});

	it('rejects invalid transition order without changing the prior state', () => {
		const idle = initialSessionState();
		const result = transitionSession(idle, events.started);
		expect(result).toEqual({ status: 'rejected', state: idle, reason: 'illegal_transition' });

		const active = stateAt('active');
		expect(transitionSession(active, events.finalize)).toEqual({
			status: 'rejected', state: active, reason: 'illegal_transition',
		});
	});

	it.each([
		['partial baseline', { ...baseline, quality: 'partial' }],
		['unstable baseline', { ...baseline, quality: 'unstable' }],
		['unpinned schema', { ...baseline, schemaVersion: '2026-08-13T00:00:00.000Z' }],
		['reversed baseline window', { ...baseline, startedAt: BASELINE_COMPLETED_AT, completedAt: BASELINE_STARTED_AT }],
	])('rejects an invalid %s', (_label, invalidBaseline) => {
		expect(transitionSession(stateAt('starting'), {
			type: 'confirm_start', authority, baseline: invalidBaseline, startContext,
		})).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
	});

	it.each([
		['missing character', { ...startContext, characterName: '' }],
		['invalid magic find', { ...startContext, magicFind: { value: -1, source: 'manual' } }],
		['future source', { ...startContext, magicFind: { value: 321, source: 'api' } }],
		['invalid build', { ...startContext, build: { ...startContext.build, specializations: [] } }],
		['capture before baseline', { ...startContext, capturedAt: BASELINE_STARTED_AT }],
	])('rejects start context with %s', (_label, invalidContext) => {
		expect(transitionSession(stateAt('starting'), {
			type: 'confirm_start', authority, baseline, startContext: invalidContext,
		})).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
	});

	it.each([
		['same snapshot', { ...finalSnapshot, snapshotId: baseline.snapshotId }, 'invariant_violation'],
		['different account', { ...finalSnapshot, accountId: 'account-2' }, 'invariant_violation'],
		['different schema', { ...finalSnapshot, schemaVersion: 'another-schema' }, 'invalid_event'],
		['overlapping snapshots', { ...finalSnapshot, startedAt: BASELINE_STARTED_AT }, 'invariant_violation'],
	])('rejects %s at the final boundary', (_label, invalidFinal, reason) => {
		expect(transitionSession(stateAt('stopping'), {
			type: 'confirm_stop', authority, stoppedAt: STOPPED_AT, finalSnapshot: invalidFinal,
		})).toMatchObject({ status: 'rejected', reason });
	});

	it('rejects timestamps that move backwards', () => {
		expect(transitionSession(stateAt('active'), {
			type: 'request_stop', authority, requestedAt: REQUESTED_AT,
		})).toMatchObject({ status: 'rejected', reason: 'invariant_violation' });
		expect(transitionSession(stateAt('provisional'), {
			...events.finalize, finalizedAt: BASELINE_COMPLETED_AT,
		})).toMatchObject({ status: 'rejected', reason: 'invariant_violation' });
	});

	it.each([
		[null, events.start, 'invalid_state'],
		[{}, events.start, 'invalid_state'],
		[initialSessionState(), null, 'invalid_event'],
		[initialSessionState(), { type: 'request_start' }, 'invalid_event'],
		[initialSessionState(), { ...events.start, extra: true }, 'invalid_event'],
	])('never throws for malformed runtime input', (state, event, reason) => {
		expect(() => transitionSession(state, event)).not.toThrow();
		expect(transitionSession(state, event)).toMatchObject({ status: 'rejected', reason });
	});

	it('copies event evidence into the next state and never mutates either input', () => {
		const starting = stateAt('starting');
		const event = structuredClone(events.started);
		const beforeState = structuredClone(starting);
		const active = apply(starting, event);
		event.baseline.snapshotId = 'mutated-after-transition';

		expect(starting).toEqual(beforeState);
		expect(active).toMatchObject({ baseline: { snapshotId: baseline.snapshotId } });
	});

	it('projects only stable fencing identity from a renewable lease', () => {
		expect(sessionAuthorityFromLease({
			...authority,
			renewedAt: authority.acquiredAt + 100,
			expiresAt: authority.acquiredAt + 1_000,
		})).toEqual(authority);
	});

	it('validates state and event boundaries independently', () => {
		expect(isSessionState(stateAt('complete'))).toBe(true);
		expect(isSessionEvent(events.finalize)).toBe(true);
		expect(isSessionState({ ...stateAt('complete'), unknown: true })).toBe(false);
		expect(isSessionEvent({ ...events.finalize, classification: 'invalid' })).toBe(false);
	});
});

function stateAt(target: SessionState['status']): SessionState {
	let state: SessionState = initialSessionState();
	if (target === 'idle') return state;
	for (const event of [events.start, events.started, events.stop, events.stopped, events.finalize]) {
		state = apply(state, event);
		if (state.status === target) return state;
	}
	throw new Error(`Unsupported fixture target: ${target}`);
}

function apply(state: SessionState, event: SessionEvent): SessionState {
	const result = transitionSession(state, event);
	expect(result).toMatchObject({ status: 'applied' });
	if (result.status !== 'applied') throw new Error(`Transition was not applied: ${result.status}`);
	return result.state;
}
