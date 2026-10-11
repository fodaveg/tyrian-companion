// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import type { PilotRecoveryRuntime } from './runtime/pilot-recovery-runtime';
import type { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { PilotMetricsRecorder } from './sessions/pilot-metrics-recorder';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, group F: the core's side of `PilotRecoveryRuntime`, over the real core and its real
 * `initializeRuntime`. The runtime's own behaviour is `src/runtime/pilot-recovery-runtime.test.ts`.
 * The core keeps no delegate of its own to it: each row is a core method the views call whose
 * runtime (`SessionRuntime`) reaches the core's one `PilotRecoveryRuntime` through its port, once,
 * with the recovery's arguments, and answers what it answers.
 */
type Reached = 'pilotRecoveryIdentity' | 'ensurePilotRecoveryPresented';

const RECOVERY = 'session-a:7';
const ROWS: ReadonlyArray<readonly [
	core: string, reached: Reached, call: (core: TyrianCompanionCore) => unknown, args: readonly unknown[], answer: unknown,
]> = [
	['getPilotRecoveryKind', 'pilotRecoveryIdentity', (core) => core.getPilotRecoveryKind(), [], 'organic'],
	['isPilotRecoveryClassificationRequired', 'pilotRecoveryIdentity', (core) => core.isPilotRecoveryClassificationRequired(), [], true],
	// The saved kind is `organic`: a different one is refused, and the answer says so.
	['classifyPilotRecovery', 'ensurePilotRecoveryPresented', async (core) => await core.classifyPilotRecovery('forced_restart'), [RECOVERY], false],
];

/** The core's own `PilotRecoveryRuntime`: a private of the core. */
function pilotOf(core: TyrianCompanionCore): PilotRecoveryRuntime {
	return (core as unknown as { pilotRecovery: PilotRecoveryRuntime }).pilotRecovery;
}

const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

describe('the core hands the pilot side of a recovery to PilotRecoveryRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	/** The real core, not booted, with the action runner off as the other tests over the real runtime do. */
	function core(): RuntimeHarness {
		harness = createRuntimeHarness();
		(harness.core as unknown as { localDebugActions: null }).localDebugActions = null;
		return harness;
	}

	it.each(ROWS)('%s reaches the core\'s PilotRecoveryRuntime.%s once, with its arguments, and answers what it answers', async (_name, reached, call, args, answer) => {
		const runtime = core();
		await runtime.initializeRuntime();
		const own = pilotOf(runtime.core);
		own.measuredPilotRecoveries.add(RECOVERY);
		own.pilotRecoveryKinds.set(RECOVERY, 'organic');
		const identity = vi.spyOn(own, 'pilotRecoveryIdentity').mockReturnValue(RECOVERY);
		const presented = vi.spyOn(own, 'ensurePilotRecoveryPresented').mockResolvedValue(true);

		const answered = await call(runtime.core);

		expect((reached === 'pilotRecoveryIdentity' ? identity : presented).mock.calls).toEqual([args]);
		expect(answered).toBe(answer);
	});

	// It replaces the frozen source-text check that the core's text named `recoveryPresented`
	// (`src/sessions/pilot-metrics-architecture.test.ts`): the hook is now run, not read.
	it('the boot records the recovery on screen as presented through the recorder it built', async () => {
		const runtime = core();
		const own = pilotOf(runtime.core);
		vi.spyOn(own, 'pilotRecoveryIdentity').mockReturnValue(RECOVERY);
		const recoveryPresented = vi.spyOn(PilotMetricsRecorder.prototype, 'recoveryPresented').mockResolvedValue(true);
		vi.spyOn(PilotMetricsRecorder.prototype, 'recoveryKind').mockResolvedValue('forced_restart');

		await runtime.initializeRuntime();
		await flush();

		expect(recoveryPresented).toHaveBeenCalledWith(RECOVERY);
		expect({ measured: [...own.measuredPilotRecoveries], kinds: [...own.pilotRecoveryKinds] })
			.toEqual({ measured: [RECOVERY], kinds: [[RECOVERY, 'forced_restart']] });
	});

	it('the port reads the session service and the recorder the boot built, not what the core had when the runtime was built', async () => {
		const runtime = core();
		// Before the boot the core has neither: a port that copied them at construction would hold undefined.
		await runtime.initializeRuntime();
		const sessions = (runtime.core as unknown as { sessions: { getRecoveryState(): unknown } }).sessions;
		vi.spyOn(sessions, 'getRecoveryState').mockReturnValue({ status: 'available', state: { status: 'active', sessionId: 'session-a', authority: { fence: 7 } } });

		expect(pilotOf(runtime.core).pilotRecoveryIdentity()).toBe(RECOVERY);
	});
});
