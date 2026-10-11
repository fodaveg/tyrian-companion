// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { FarmingSessionRuntime } from './runtime/farming-session-runtime';
import { LiveSessionLifecycle } from './sessions/live-session-lifecycle';
import type { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3f: the core's side of `FarmingSessionRuntime`, over the real core and its real
 * `initializeRuntime`. The runtime's own behaviour is tested on its own
 * (`src/runtime/farming-session-runtime.test.ts`); this file proves that each of the core's eight
 * facade methods (`FACADE`) reaches it with the view's arguments and answers what it answers, and that
 * the port reads and writes the core's own fields (the group context and the reminders) as they stand.
 */

/** The methods both expose. */
type FacadeMethod = keyof FarmingSessionRuntime & keyof TyrianCompanionCore;

/**
 * Each facade method of the core, how the views call it and the arguments FarmingSessionRuntime must
 * get. A record over `FacadeMethod`, so a public method added to `FarmingSessionRuntime` and the core
 * does not compile until it has its row here.
 */
const FACADE: Readonly<Record<FacadeMethod, readonly [call: (core: TyrianCompanionCore) => unknown, args: readonly unknown[]]>> = {
	getFarmingGroupContext: [(core) => core.getFarmingGroupContext(), []],
	setFarmingGroupContext: [(core) => { core.setFarmingGroupContext('without_bosses'); }, ['without_bosses']],
	getFarmingReminders: [(core) => core.getFarmingReminders(), []],
	startFarmingReminder: [(core) => { core.startFarmingReminder('food', 20); }, ['food', 20]],
	clearFarmingReminder: [(core) => { core.clearFarmingReminder('food'); }, ['food']],
	getFarmingGoalProgress: [(core) => core.getFarmingGoalProgress(), []],
	getFarmingPreparationContext: [(core) => core.getFarmingPreparationContext(), []],
	getFarmingIngameState: [(core) => core.getFarmingIngameState(), []],
};

const FACADE_CASES = (Object.keys(FACADE) as FacadeMethod[]).map((name) => [name, ...FACADE[name]] as const);

describe('the core hands the farming session to FarmingSessionRuntime', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
		vi.restoreAllMocks();
	});

	function core(): RuntimeHarness {
		const runtime = createRuntimeHarness();
		harness = runtime;
		(runtime.core as unknown as { localDebugActions: null }).localDebugActions = null;
		runtime.core.settings = { ...runtime.core.settings, apiKeySecret: 'tyrian-test-key' };
		return runtime;
	}

	it.each(FACADE_CASES)('%s reaches FarmingSessionRuntime with the view\'s arguments and answers what it answers', async (name, call, args) => {
		const runtime = core();
		await runtime.initializeRuntime();
		const reached = vi.spyOn(FarmingSessionRuntime.prototype, name);

		const answer = call(runtime.core);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(answer).toEqual(reached.mock.results[0]?.value);
	});

	it('farmingGroupContext and farmingReminders: what the runtime writes is what the core\'s own fields hold, which the live session reads', async () => {
		const runtime = core();
		await runtime.initializeRuntime();
		const own = runtime.core as unknown as { farmingGroupContext: unknown; farmingReminders: { kind: string; durationMinutes: number }[] };

		runtime.core.setFarmingGroupContext('without_bosses');
		runtime.core.startFarmingReminder('utility', 15);

		expect({ group: own.farmingGroupContext, reminders: own.farmingReminders.map(({ kind, durationMinutes }) => ({ kind, durationMinutes })) })
			.toEqual({ group: 'without_bosses', reminders: [{ kind: 'utility', durationMinutes: 15 }] });
	});

	it('liveSessions: the lifecycle the boot built answers the preparation context', async () => {
		const runtime = core();
		await runtime.initializeRuntime();
		vi.spyOn(LiveSessionLifecycle.prototype, 'getRuntime').mockReturnValue(
			{ context: { character: 'Astra Uno' }, lastSample: null, lastObservationAt: null, connection: 'connected' } as unknown as ReturnType<LiveSessionLifecycle['getRuntime']>,
		);

		expect(runtime.core.getFarmingPreparationContext()).toMatchObject({ characterName: 'Astra Uno', addonConnection: 'connected' });
	});
});
