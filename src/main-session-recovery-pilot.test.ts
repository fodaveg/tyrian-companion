import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';

/**
 * Was part of `pilot-metrics-architecture.test.ts` (H0.6), two matches over the core's characters:
 * the core contains `recoveryFinished`, and it never contains
 * `if (recoveryId) await this.ensurePilotRecoveryPresented(recoveryId)`. Here the recovery and the
 * discard of a saved session run, and what they hand the pilot journal is read: every way out of a
 * recovery closes it once (`succeeded`, `discarded` or `failed`), and recording that the recovery was
 * presented never holds the player's action back (the journal is fail-open, H0.6).
 */

type RecoveryKind = 'recover' | 'discard';

interface RecoveryHarness {
	readonly run: () => Promise<void>;
	readonly backend: ReturnType<typeof vi.fn>;
	readonly recoveryFinished: ReturnType<typeof vi.fn>;
	readonly recoveryPresented: ReturnType<typeof vi.fn>;
}

function recoveryHarness(kind: RecoveryKind, outcome: 'confirms' | 'refuses' | 'throws', presented: Promise<boolean> = Promise.resolve(true)): RecoveryHarness {
	const confirmed = kind === 'recover' ? { status: 'recovered' as const } : { status: 'discarded' as const };
	const backend = vi.fn(async () => {
		if (outcome === 'throws') throw new Error('Storage unavailable.');
		return outcome === 'confirms' ? confirmed : { status: 'failed' as const };
	});
	const recoveryFinished = vi.fn(async () => true);
	const recoveryPresented = vi.fn(() => presented);
	const proto = TyrianCompanionCore.prototype as unknown as {
		performRecoverSession(this: unknown): Promise<void>;
		performDiscardRecoveredSession(this: unknown): Promise<void>;
	};
	const core = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
		sessions: {
			getRecoveryState: () => ({ status: 'available', state: { status: 'active', sessionId: 'session-a', authority: { fence: 7 } } }),
			getState: () => ({ version: 1, status: 'idle' }),
			recover: kind === 'recover' ? backend : vi.fn(),
			discardRecovery: kind === 'discard' ? backend : vi.fn(),
		},
		pilotMetrics: { recoveryPresented, recoveryKind: vi.fn(async () => null), recoveryFinished },
		measuredPilotRecoveries: new Set<string>(),
		pilotRecoveryKinds: new Map<string, string>(),
		requireRuntimeMutationLease: () => ({ release: vi.fn() }),
		startLiveObservation: vi.fn(),
		renderViews: vi.fn(),
	});
	const run = kind === 'recover'
		? () => proto.performRecoverSession.call(core)
		: () => proto.performDiscardRecoveredSession.call(core);
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
