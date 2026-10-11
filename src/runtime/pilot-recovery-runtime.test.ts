import { describe, expect, it, vi } from 'vitest';

import { PilotRecoveryRuntime, type PilotRecoveryRuntimePort } from './pilot-recovery-runtime';
import type { SessionRecoveryState } from '../sessions/manual-session-start-model';
import type { PilotRecoveryKind } from '../sessions/pilot-metrics-model';

/**
 * DE-01, group F: `PilotRecoveryRuntime` on its own, over ports checked with
 * `satisfies PilotRecoveryRuntimePort`. The core's side (that the real core builds it, hands it to
 * `SessionRuntime` and `LiveSessionRuntime`, and presents the recovery at boot) is
 * `src/main-pilot-recovery-runtime-wiring.test.ts`.
 */

/** A saved session's recovery as the session service reports it; only the fields the identity reads. */
function recovery(state: Record<string, unknown>): SessionRecoveryState {
	return { status: 'available', state } as unknown as SessionRecoveryState;
}

function port(
	recoveryState: SessionRecoveryState,
	journal: { presented?: boolean; kind?: PilotRecoveryKind | null } = {},
): PilotRecoveryRuntimePort & { pilotMetrics: { recoveryPresented: ReturnType<typeof vi.fn>; recoveryKind: ReturnType<typeof vi.fn> } } {
	return {
		sessions: { getRecoveryState: () => recoveryState },
		pilotMetrics: {
			recoveryPresented: vi.fn(async () => journal.presented ?? true),
			recoveryKind: vi.fn(async () => journal.kind ?? null),
		},
	} satisfies PilotRecoveryRuntimePort;
}

const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

describe('the recovery on screen, as the pilot journal names it', () => {
	it.each([
		['no saved session', { status: 'none' }, null],
		['an unreadable record', { status: 'error', code: 'corrupt', message: 'corrupt' }, null],
		['a saved session', recovery({ status: 'active', sessionId: 'session-a', authority: { fence: 7 } }), 'session-a:7'],
		['a saved session whose close failed', recovery({ status: 'error', failedState: { status: 'stopping', sessionId: 'session-b', authority: { fence: 3 } } }), 'session-b:3'],
		['a saved state with no session', recovery({ status: 'idle' }), null],
	] as const)('%s is %s', (_case, state, identity) => {
		expect(new PilotRecoveryRuntime(port(state)).pilotRecoveryIdentity()).toBe(identity);
	});
});

describe('recording the recovery as presented', () => {
	it('fills both collections once the journal records it, with the kind it had saved', async () => {
		const own = port({ status: 'none' }, { presented: true, kind: 'organic' });
		const runtime = new PilotRecoveryRuntime(own);

		await expect(runtime.ensurePilotRecoveryPresented('session-a:7')).resolves.toBe(true);

		expect(own.pilotMetrics.recoveryPresented).toHaveBeenCalledExactlyOnceWith('session-a:7');
		expect(own.pilotMetrics.recoveryKind).toHaveBeenCalledExactlyOnceWith('session-a:7');
		expect({ measured: [...runtime.measuredPilotRecoveries], kinds: [...runtime.pilotRecoveryKinds] })
			.toEqual({ measured: ['session-a:7'], kinds: [['session-a:7', 'organic']] });
	});

	it('leaves both collections alone, and never asks for the kind, when the journal does not record it', async () => {
		const own = port({ status: 'none' }, { presented: false, kind: 'organic' });
		const runtime = new PilotRecoveryRuntime(own);

		await expect(runtime.ensurePilotRecoveryPresented('session-a:7')).resolves.toBe(false);

		expect(own.pilotMetrics.recoveryKind).not.toHaveBeenCalled();
		expect({ measured: runtime.measuredPilotRecoveries.size, kinds: runtime.pilotRecoveryKinds.size }).toEqual({ measured: 0, kinds: 0 });
	});

	it('measures a recovery with no saved kind without inventing one', async () => {
		const runtime = new PilotRecoveryRuntime(port({ status: 'none' }, { presented: true, kind: null }));

		await runtime.ensurePilotRecoveryPresented('session-a:7');

		expect({ measured: [...runtime.measuredPilotRecoveries], kinds: runtime.pilotRecoveryKinds.size }).toEqual({ measured: ['session-a:7'], kinds: 0 });
	});
});

describe('the boot\'s and each state change\'s presentation', () => {
	it('records the recovery on screen without waiting for it, and repaints once the journal answered', async () => {
		let answer: (recorded: boolean) => void = () => undefined;
		const own = port(recovery({ status: 'active', sessionId: 'session-a', authority: { fence: 7 } }));
		own.pilotMetrics.recoveryPresented.mockImplementation(() => new Promise<boolean>((resolve) => { answer = resolve; }));
		const repaint = vi.fn();
		const runtime = new PilotRecoveryRuntime(own);

		expect(runtime.presentPilotRecovery(repaint)).toBeUndefined();
		await flush();
		expect({ asked: own.pilotMetrics.recoveryPresented.mock.calls, repaints: repaint.mock.calls.length })
			.toEqual({ asked: [['session-a:7']], repaints: 0 });

		answer(false);
		await flush();
		expect(repaint).toHaveBeenCalledOnce();
	});

	it('neither asks the journal nor repaints when no recovery is on screen', async () => {
		const own = port({ status: 'none' });
		const repaint = vi.fn();

		new PilotRecoveryRuntime(own).presentPilotRecovery(repaint);
		await flush();

		expect({ asked: own.pilotMetrics.recoveryPresented.mock.calls.length, repaints: repaint.mock.calls.length }).toEqual({ asked: 0, repaints: 0 });
	});
});
