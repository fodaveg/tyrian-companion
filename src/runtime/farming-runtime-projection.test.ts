import { describe, expect, it } from 'vitest';
import { storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { ingamePresenceSnapshot, initialIngamePresenceState } from '../alerts/alert-ingame-presence';
import type { ActiveSessionState, SessionState } from '../sessions/session';
import type { LiveSessionLootState } from '../sessions/live-session-loot';
import { farmingBagCapacity, farmingGoalForSession, farmingSessionElapsed, projectFarmingIngameState } from './farming-runtime-projection';
import { observeFarmingSessionContext, readFarmingSessionContext, type FarmingSessionContext } from './farming-session-context';

const from = '2026-10-06T10:00:00Z';
const at = '2026-10-06T10:20:00Z';
const state: ActiveSessionState = {
	version: 1, status: 'active', sessionId: 'session', requestedAt: from,
	authority: { sessionId: 'session', machineId: 'device', instanceId: 'instance', fence: 1, acquiredAt: Date.parse(from) },
	baseline: { snapshotId: 'baseline', accountId: 'account', schemaVersion: '2024-07-20T01:00:00.000Z', startedAt: from, completedAt: from, quality: 'stable' },
	startContext: { characterName: 'Astra Uno', magicFind: { value: 320, source: 'manual', breakdown: null, consumablesBonus: 0 },
		build: { tab: 1, name: 'Private build', profession: 'Guardian', specializations: [], skills: { heal: null, utilities: [], elite: null }, aquaticSkills: { heal: null, utilities: [], elite: null } }, capturedAt: from },
};
const loot: LiveSessionLootState = { status: 'observing', sessionId: 'session', restored: false, rows: [],
	knownTotalCopper: 0, sackQuantity: 200, observedSackGains: 200, netSackQuantity: null, totalSacksObtained: null,
	hasUnknownValue: false, updatedAt: at, error: null };
const context: FarmingSessionContext = { version: 1, sessionId: 'session', goal: { version: 1, kind: 'bags', targetBags: 1_000 },
	groupContext: null, observedFrom: from, observedAt: at, sampleCount: 3 };
const presence = ingamePresenceSnapshot(initialIngamePresenceState());

describe('farming runtime evidence projection', () => {
	it('restores only valid captured intent and counts distinct observations, never display ticks', () => {
		expect(readFarmingSessionContext(structuredClone(context))).toEqual(context);
		expect(readFarmingSessionContext({ ...context, sampleCount: 0 })).toBeNull();
		expect(readFarmingSessionContext({ ...context, command: 'start' })).toBeNull();
		expect(observeFarmingSessionContext(context, at)).toBe(context);
		expect(observeFarmingSessionContext(context, from)).toBe(context);
		expect(observeFarmingSessionContext(context, '2026-10-06T10:25:00Z').sampleCount).toBe(4);
	});

	it('separates observed increments, final net and cache ages across error and stopping states', () => {
		const stopping = { ...state, status: 'stopping', stopRequestedAt: at } as const;
		const result = projectFarmingIngameState({ state: stopping, loot: { ...loot, status: 'complete', netSackQuantity: -20 },
			snapshot: null, presence, goal: null, now: Date.parse('2026-10-06T10:25:00Z'), saveFailed: false, preparationEnabled: false });
		expect(result).toMatchObject({ phase: 'stopping', elapsed: 1_200, observed: 200, net: -20, age: 300, lo: 400, hi: 1_200 });
		for (const [failed, err] of [[{ ...state, status: 'starting' }, 'start'], [state, 'observe'], [stopping, 'stop']] as const) {
			const errored = { version: 1, status: 'error', failedAt: at, code: 'snapshot_failed', failedState: failed } as SessionState;
			expect(projectFarmingIngameState({ state: errored, loot, snapshot: null, presence, goal: null, now: Date.parse(at), saveFailed: false, preparationEnabled: false }).err).toBe(err);
		}
	});

	it('keeps stale bags visible, removes stale ETA and never uses net bags as goal progress', () => {
		const fresh = farmingGoalForSession(state, loot, context, Date.parse(at));
		expect(fresh).toMatchObject({ observedBags: 200, remainingMs: 4_800_000 });
		const stale = farmingGoalForSession(state, { ...loot, netSackQuantity: 50 }, context, Date.parse('2026-10-06T11:00:00Z'));
		expect(stale).toMatchObject({ observedBags: 200, finalNetBags: 50, remainingMs: null, etaUnavailableReason: 'stale_observation' });
		const restored = farmingGoalForSession(state, { ...loot, observedSackGains: null, restored: true }, context, Date.parse(at));
		expect(restored).toMatchObject({ observedBags: null, remainingMs: null, etaUnavailableReason: 'no_observation' });
	});

	it('subtracts recorded suspension and freezes duration at the declared end', () => {
		const suspended = { ...state, unobservedGaps: [{ from: '2026-10-06T10:05:00Z', to: '2026-10-06T10:10:00Z' }] };
		expect(farmingSessionElapsed(suspended, Date.parse(at))).toBe(900_000);
		expect(farmingGoalForSession(suspended, loot, context, Date.parse(at))).toMatchObject({
			elapsedMs: 900_000, remainingMs: 4_800_000, etaUnavailableReason: null,
		});
		expect(farmingGoalForSession(suspended, loot, { ...context, goal: { version: 1, kind: 'duration', targetDurationMs: 3_600_000 } }, Date.parse(at)))
			.toMatchObject({ elapsedMs: 900_000, remainingMs: 2_700_000, remainingKind: 'countdown' });
		const stopped = { ...suspended, status: 'stopping', stopRequestedAt: at } as const;
		expect(farmingSessionElapsed(stopped, Date.parse('2026-10-06T12:00:00Z'))).toBe(900_000);
	});

	it('uses captured gameplay bags, falls back to recent character, and ages capacity independently', () => {
		const snapshot = storageDeltaSnapshot({ completedAt: from, lastPlayedCharacter: { character: 'Astra Uno', source: 'last_modified' },
			freeSlots: { bank: { free: 200, total: 200 }, sharedInventory: null, characterBags: [{ character: 'Astra Uno', bagIndex: 0, bagItemId: 1, free: 0, total: 20 }] } });
		expect(farmingBagCapacity(snapshot, presence, Date.parse(at))).toMatchObject({ slots: 0, source: 'recent', age: 1_200 });
		const connected = { ...presence, status: 'present' as const, context: { source: 'nexus' as const, state: 'gameplay' as const, mapId: 866, character: 'Astra Uno', labyrinth: true } };
		expect(farmingBagCapacity(snapshot, connected, Date.parse(at))).toMatchObject({ slots: 0, source: 'ingame' });
		expect(farmingBagCapacity({ ...snapshot, lastPlayedCharacter: null }, { ...connected, status: 'lost' }, Date.parse(at))).toMatchObject({ slots: null, source: 'unknown' });
	});
});
