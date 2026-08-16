import { describe, expect, it } from 'vitest';

import {
	MUMBLE_V2_LIFECYCLE_STATES,
	MUMBLE_V2_SOURCE_STATUSES,
	type MumbleV2LifecycleState,
} from './mumble-v2-contract';
import {
	initialMumbleV2PresencePolicyState,
	reduceMumbleV2PresencePolicy,
	type MumbleV2PresenceContext,
	type MumbleV2PresencePolicyState,
} from './mumble-v2-presence-policy';

const ORIGIN = Date.parse('2026-10-20T18:00:00.000Z');
const IDLE: MumbleV2PresenceContext = {
	enabled: true,
	armed: true,
	recoveryPending: false,
	authority: { kind: 'idle', accountId: 'account-a' },
};
const ACTIVE: MumbleV2PresenceContext = {
	...IDLE,
	authority: {
		kind: 'session', accountId: 'account-a', sessionId: 'session-a', baselineSnapshotId: 'snapshot-a',
	},
};

describe('H8.8 Mumble shadow presence policy', () => {
	it('crosses presence at 5000 ms, not 4999 ms, and emits only once per armed idle epoch', () => {
		let state = ready(IDLE);
		let result = sample(state, 0, 866);
		state = result.state;
		for (let offset = 500; offset <= 4_500; offset += 500) {
			result = sample(state, offset, 866);
			state = result.state;
		}
		result = sample(state, 4_999, 866);
		expect(result.signal).toBeNull();
		result = sample(result.state, 5_000, 866);
		expect(result.signal).toMatchObject({
			phase: 'presence',
			thresholdMs: 5_000,
			window: { fromMs: ORIGIN, toMs: ORIGIN + 5_000 },
			binding: { kind: 'idle', accountId: 'account-a' },
		});
		expect(sample(result.state, 5_500, 866).signal).toBeNull();
	});

	it('crosses absence at 60000 ms, not 59999 ms, only for the bound active session', () => {
		let state = ready(ACTIVE);
		let result = sample(state, 0, 15);
		state = result.state;
		for (let offset = 500; offset <= 59_500; offset += 500) {
			result = sample(state, offset, offset % 1_000 === 0 ? 15 : 42);
			state = result.state;
		}
		result = sample(state, 59_999, 42);
		expect(result.signal).toBeNull();
		result = sample(result.state, 60_000, 15);
		expect(result.signal).toMatchObject({
			phase: 'absence',
			thresholdMs: 60_000,
			binding: {
				kind: 'session', accountId: 'account-a', sessionId: 'session-a', baselineSnapshotId: 'snapshot-a',
			},
		});
	});

	it('clears the latch only after disarm/rearm or authoritative context change', () => {
		let state = crossPresence(ready(IDLE));
		expect(sample(state, 5_500, 866).signal).toBeNull();
		state = context(state, { ...IDLE, armed: false });
		state = context(state, IDLE);
		state = crossPresence(state);
		expect(state.startLatched).toBe(true);

		state = context(state, ACTIVE);
		expect(state.startLatched).toBe(false);
		expect(state.stopLatchedBinding).toBeNull();

		state = context(state, { ...IDLE, authority: { kind: 'idle', accountId: 'account-b' } });
		expect(state.startLatched).toBe(false);
	});

	it('requires idle for presence and exact active binding for absence', () => {
		let active = ready(ACTIVE);
		for (let offset = 0; offset <= 5_000; offset += 500) active = sample(active, offset, 866).state;
		expect(active.startLatched).toBe(false);
		let idle = ready(IDLE);
		for (let offset = 0; offset <= 60_000; offset += 500) idle = sample(idle, offset, 15).state;
		expect(idle.stopLatchedBinding).toBeNull();
	});

	it('resets on the opposite phase and treats all non-target maps as the same absence phase', () => {
		let state = ready(IDLE);
		state = sample(state, 0, 866).state;
		state = sample(state, 500, 866).state;
		state = sample(state, 1_000, 42).state;
		expect(state).toMatchObject({ phase: null, creditedMs: 0 });

		state = ready(ACTIVE);
		state = sample(state, 0, 15).state;
		state = sample(state, 500, 42).state;
		expect(state).toMatchObject({ phase: 'absence', creditedMs: 500 });
	});

	it('caps credit at 500 ms, degrades tolerated jitter and resets a gap over 1000 ms', () => {
		let state = ready(IDLE);
		state = sample(state, 0, 866).state;
		state = sample(state, 1_000, 866).state;
		expect(state).toMatchObject({ creditedMs: 500, continuity: 'degraded' });
		state = sample(state, 2_001, 866).state;
		expect(state).toMatchObject({ creditedMs: 0, startedAtMs: ORIGIN + 2_001 });
	});

	it('pauses and degrades on stalled, then resets after more than 2000 ms stalled', () => {
		let state = ready(IDLE);
		state = sample(state, 0, 866).state;
		state = sample(state, 500, 866).state;
		state = sample(state, 1_000, 866, 'link_stalled').state;
		state = sample(state, 1_500, 866, 'link_stalled').state;
		state = sample(state, 2_000, 866, 'link_advancing').state;
		expect(state).toMatchObject({ creditedMs: 500, continuity: 'degraded', stalledSinceMs: null });

		state = sample(state, 2_500, 866, 'link_stalled').state;
		state = sample(state, 3_000, 866, 'link_stalled').state;
		state = sample(state, 3_500, 866, 'link_stalled').state;
		state = sample(state, 4_000, 866, 'link_stalled').state;
		state = sample(state, 4_501, 866, 'link_stalled').state;
		expect(state).toMatchObject({ phase: null, creditedMs: 0 });
	});

	it('resets on every heartbeat and never treats source unavailability as absence', () => {
		for (const sourceStatus of MUMBLE_V2_SOURCE_STATUSES) {
			let state = ready(ACTIVE);
			state = sample(state, 0, 15).state;
			state = reduceMumbleV2PresencePolicy(state, {
				kind: 'heartbeat', observedAtMs: ORIGIN + 500, sourceStatus,
			}).state;
			expect(state, sourceStatus).toMatchObject({ phase: null, creditedMs: 0, continuity: 'degraded' });
		}
	});

	it('resets on every non-healthy channel state and requires a fresh window after recovery', () => {
		for (const channelState of MUMBLE_V2_LIFECYCLE_STATES.filter((value) => value !== 'healthy')) {
			let state = ready(IDLE);
			state = sample(state, 0, 866).state;
			state = sample(state, 500, 866).state;
			state = channel(state, channelState);
			expect(state, channelState).toMatchObject({ phase: null, creditedMs: 0 });
			state = channel(state, 'healthy');
			expect(sample(state, 1_000, 866).signal).toBeNull();
		}
	});

	it('never accrues evidence while disabled, disarmed, recovering or ineligible', () => {
		for (const contextValue of [
			{ ...IDLE, enabled: false },
			{ ...IDLE, armed: false },
			{ ...IDLE, recoveryPending: true },
			{ ...IDLE, authority: { kind: 'ineligible' } as const },
		]) {
			let state = ready(contextValue);
			for (let offset = 0; offset <= 5_000; offset += 500) state = sample(state, offset, 866).state;
			expect(state, JSON.stringify(contextValue)).toMatchObject({ phase: null, creditedMs: 0 });
		}
	});

	it('fails closed on recovery pending, invalid time and clock regression without mutating inputs', () => {
		const initial = ready(IDLE);
		const frozen = structuredClone(initial);
		let state = sample(initial, 500, 866).state;
		expect(initial).toEqual(frozen);
		state = sample(state, 0, 866).state;
		expect(state.phase).toBeNull();
		state = reduceMumbleV2PresencePolicy(state, {
			kind: 'sample', observedAtMs: Number.MAX_SAFE_INTEGER + 1, mapId: 866, activity: 'link_advancing',
		}).state;
		expect(state.phase).toBeNull();
		state = context(state, { ...IDLE, recoveryPending: true });
		expect(state).toMatchObject({ phase: null, creditedMs: 0 });
	});

	it('fails closed on unknown activity and strips hostile context extensions', () => {
		let state = ready(IDLE);
		state = sample(state, 0, 866).state;
		state = reduceMumbleV2PresencePolicy(state, {
			kind: 'sample', observedAtMs: ORIGIN + 500, mapId: 866, activity: 'link_unknown',
		} as never).state;
		expect(state).toMatchObject({ phase: null, creditedMs: 0, continuity: 'degraded' });

		const invalidResult = reduceMumbleV2PresencePolicy(state, {
			kind: 'context', context: { ...IDLE, raw: 'must-not-survive' },
		} as never);
		state = invalidResult.state;
		expect(state.context).toEqual({
			enabled: false,
			armed: false,
			recoveryPending: false,
			authority: { kind: 'ineligible' },
		});

		const exposedContext = invalidResult.state.context as {
			enabled: boolean;
			armed: boolean;
			authority: MumbleV2PresenceContext['authority'];
		};
		exposedContext.enabled = true;
		exposedContext.armed = true;
		exposedContext.authority = { kind: 'idle', accountId: 'poisoned' };
		const fresh = initialMumbleV2PresencePolicyState();
		expect(fresh.context).not.toBe(invalidResult.state.context);
		expect(fresh.context).toEqual({
			enabled: false,
			armed: false,
			recoveryPending: false,
			authority: { kind: 'ineligible' },
		});
	});
});

function ready(contextValue: MumbleV2PresenceContext): MumbleV2PresencePolicyState {
	let state = context(initialMumbleV2PresencePolicyState(), contextValue);
	state = channel(state, 'healthy');
	return state;
}

function context(state: MumbleV2PresencePolicyState, value: MumbleV2PresenceContext): MumbleV2PresencePolicyState {
	return reduceMumbleV2PresencePolicy(state, { kind: 'context', context: value }).state;
}

function channel(state: MumbleV2PresencePolicyState, value: MumbleV2LifecycleState): MumbleV2PresencePolicyState {
	return reduceMumbleV2PresencePolicy(state, { kind: 'channel', state: value }).state;
}

function sample(
	state: MumbleV2PresencePolicyState,
	offsetMs: number,
	mapId: number,
	activity: 'link_advancing' | 'link_stalled' = 'link_advancing',
) {
	return reduceMumbleV2PresencePolicy(state, {
		kind: 'sample', observedAtMs: ORIGIN + offsetMs, mapId, activity,
	});
}

function crossPresence(initial: MumbleV2PresencePolicyState): MumbleV2PresencePolicyState {
	let state = initial;
	for (let offset = 0; offset <= 5_000; offset += 500) state = sample(state, offset, 866).state;
	return state;
}
