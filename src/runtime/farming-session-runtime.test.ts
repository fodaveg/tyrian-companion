import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { FarmingManualReminder } from '../sessions/farming-goal-preparation';
import { DEFAULT_FARMING_PREPARATION } from '../sessions/farming-goal-preparation';
import type { ActiveSessionState } from '../sessions/session';
import { ingamePresenceSnapshot, initialIngamePresenceState } from '../alerts/alert-ingame-presence';
import { FarmingSessionRuntime, type FarmingSessionRuntimePort } from './farming-session-runtime';
import type { FarmingGroupContext, FarmingSessionContext } from './farming-session-context';

/**
 * DE-01, step 3f: `FarmingSessionRuntime` on its own, over a port checked with
 * `satisfies FarmingSessionRuntimePort`. The core's side (that the real core builds it and reads its
 * fields live) is `src/main-farming-session-runtime-wiring.test.ts`.
 */

const START = '2026-10-06T10:00:00Z';
const CONTEXT: FarmingSessionContext = {
	version: 1, sessionId: 'session-a', goal: { version: 1, kind: 'bags', targetBags: 1_000 },
	groupContext: null, observedFrom: START, observedAt: START, sampleCount: 1,
};

/** Every member a case does not use throws, so a case reaching one by mistake says so. */
function unused(name: string): () => never {
	return () => { throw new Error(`${name} is not part of this case`); };
}

function snapshot(accountId: string, completedAt: string): StorageSnapshot {
	return { accountId, completedAt } as unknown as StorageSnapshot;
}

/** A ready device with no live session and every service stubbed out; the settable fields hold in `held`. */
function port(overrides: Partial<FarmingSessionRuntimePort> = {}) {
	const held: { group: FarmingGroupContext; reminders: FarmingManualReminder[] } = { group: null, reminders: [] };
	const built = {
		settings: { farmingPreparation: { ...DEFAULT_FARMING_PREPARATION, enabled: true } },
		runtimeReady: true,
		host: {},
		sessions: { getBaselineSnapshot: () => null, getState: (): never => unused('sessions.getState')() },
		inventoryAdvisor: { analysis: () => null },
		assistedDetection: { getLastSnapshot: () => null, getState: () => ({ scheduler: { consecutiveFailures: 0 } }) },
		liveSessions: null,
		sessionSummarySaveState: 'unknown',
		get farmingGroupContext() { return held.group; },
		set farmingGroupContext(value: FarmingGroupContext) { held.group = value; },
		get farmingReminders() { return held.reminders; },
		set farmingReminders(value: FarmingManualReminder[]) { held.reminders = value; },
		getCollectorMode: () => 'collector' as const,
		getSessionState: unused('getSessionState'),
		getIngamePresence: () => ingamePresenceSnapshot(initialIngamePresenceState()),
		getLiveSessionLoot: unused('getLiveSessionLoot'),
		recordIngameSessionFailure: unused('recordIngameSessionFailure'),
		...overrides,
	} satisfies FarmingSessionRuntimePort;
	return { built, held };
}

afterEach(() => { vi.useRealTimers(); });

describe('the farming reminders', () => {
	it('start one per kind, refuse a duration outside 1 to 1440 whole minutes, and clear by kind', () => {
		vi.useFakeTimers({ now: new Date('2026-10-06T10:00:00Z') });
		const { built, held } = port();
		const farming = new FarmingSessionRuntime(built);

		farming.startFarmingReminder('food', 30);
		farming.startFarmingReminder('food', 45);
		farming.startFarmingReminder('utility', 10);
		for (const invalid of [0, 1_441, 1.5, Number.NaN]) farming.startFarmingReminder('utility', invalid);

		expect(held.reminders).toEqual([
			{ kind: 'food', durationMinutes: 45, startedAt: '2026-10-06T10:00:00.000Z' },
			{ kind: 'utility', durationMinutes: 10, startedAt: '2026-10-06T10:00:00.000Z' },
		]);

		farming.clearFarmingReminder('food');
		expect(held.reminders.map(({ kind }) => kind)).toEqual(['utility']);
	});

	it('are handed out as copies, so a caller cannot edit the held ones', () => {
		const { built, held } = port();
		held.reminders = [{ kind: 'food', durationMinutes: 5, startedAt: START }];
		const farming = new FarmingSessionRuntime(built);

		(farming.getFarmingReminders()[0] as { durationMinutes: number }).durationMinutes = 99;

		expect(held.reminders[0]!.durationMinutes).toBe(5);
	});
});

describe('the group context', () => {
	it('is the core\'s own: set through here, it lands in the port', () => {
		const { built, held } = port();
		const farming = new FarmingSessionRuntime(built);

		farming.setFarmingGroupContext('without_bosses');

		expect({ held: held.group, read: farming.getFarmingGroupContext() }).toEqual({ held: 'without_bosses', read: 'without_bosses' });
	});
});

describe('the captured session context', () => {
	it('is saved on this device, read back by id and failed quietly into the core\'s record', () => {
		const saved = new Map<string, unknown>();
		const recordIngameSessionFailure = vi.fn();
		const { built } = port({
			host: { localStorage: { load: (key: string) => saved.get(key), save: (key: string, value: unknown) => { saved.set(key, value); } } },
			recordIngameSessionFailure,
		});

		new FarmingSessionRuntime(built).persistFarmingSessionContext(CONTEXT);
		// A second runtime has no memory of it: only the device's copy answers.
		const reloaded = new FarmingSessionRuntime(built);

		expect(saved.get('tyrian-farming-session')).toEqual(CONTEXT);
		expect(reloaded.currentFarmingSessionContext('session-a')).toEqual(CONTEXT);
		expect(reloaded.currentFarmingSessionContext('session-b')).toBeNull();
		expect(recordIngameSessionFailure).not.toHaveBeenCalled();

		const failure = new Error('storage gone');
		const broken = port({
			host: { localStorage: { load: () => { throw failure; }, save: () => { throw failure; } } },
			recordIngameSessionFailure,
		}).built;
		const runtime = new FarmingSessionRuntime(broken);
		runtime.persistFarmingSessionContext(CONTEXT);
		expect(runtime.currentFarmingSessionContext('session-a')).toEqual(CONTEXT);
		expect(new FarmingSessionRuntime(broken).currentFarmingSessionContext('session-a')).toBeNull();
		expect(recordIngameSessionFailure).toHaveBeenCalledTimes(2);
	});
});

describe('the projections', () => {
	it('answer no goal progress before the boot, with nothing read', () => {
		const { built } = port({ runtimeReady: false });

		expect(new FarmingSessionRuntime(built).getFarmingGoalProgress()).toBeNull();
	});

	it('read the capacity evidence of the baseline\'s account only, newest first', () => {
		const baseline = snapshot('account-a', '2026-10-06T10:00:00Z');
		const active: ActiveSessionState = {
			version: 1, status: 'active', sessionId: 'session-a', requestedAt: START,
			baseline: { snapshotId: 'b', accountId: 'account-a', schemaVersion: 'x', startedAt: START, completedAt: START, quality: 'stable' },
			startContext: { characterName: 'Astra Uno', magicFind: { value: 320, source: 'manual', breakdown: null, consumablesBonus: 0 }, build: { name: 'Build' }, capturedAt: START },
		} as unknown as ActiveSessionState;
		const { built } = port({
			sessions: { getBaselineSnapshot: () => baseline, getState: () => active },
			inventoryAdvisor: { analysis: () => ({ source: { input: { snapshot: snapshot('account-b', '2026-10-06T12:00:00Z') } } }) },
			assistedDetection: { getLastSnapshot: () => snapshot('account-a', '2026-10-06T11:00:00Z'), getState: () => ({ scheduler: { consecutiveFailures: 0 } }) },
			getSessionState: () => active,
		});

		const context = new FarmingSessionRuntime(built).getFarmingPreparationContext();

		expect(context).toMatchObject({
			characterName: 'Astra Uno', buildName: 'Build', collectorMode: 'collector', addonConnection: 'disconnected',
			freeBagSlotsObservedAt: '2026-10-06T11:00:00Z',
		});
	});
});
