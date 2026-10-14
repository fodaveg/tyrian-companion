import { describe, expect, it, vi } from 'vitest';

import type { ActiveSessionLeaseHandle, RenewLeaseResult } from './coordination-model';
import type { SessionLeaseCoordinator } from './manual-session-start-model';
import { ManualSessionHeartbeat, type ManualSessionHeartbeatPort } from './manual-session-runtime-heartbeat';
import type { SessionRuntimeStore } from './session-runtime-store';

function lease(sessionId: string, fence: number): ActiveSessionLeaseHandle {
	return { machineId: 'machine-1', instanceId: 'instance-1', sessionId, fence, acquiredAt: 1_000, renewedAt: 1_000, expiresAt: 301_000 };
}

/** A heartbeat whose renewal answers only when the test settles it, over a handle the test can swap meanwhile. */
function harness(first: ActiveSessionLeaseHandle) {
	let current: ActiveSessionLeaseHandle | null = first;
	let settle!: (outcome: { value: RenewLeaseResult } | { error: Error }) => void;
	const renew = vi.fn(() => new Promise<RenewLeaseResult>((resolve, reject) => {
		settle = (outcome) => { if ('error' in outcome) reject(outcome.error); else resolve(outcome.value); };
	}));
	const failFromAuthority = vi.fn();
	const logAuthorityFailure = vi.fn();
	const port: ManualSessionHeartbeatPort = {
		disposed: () => false,
		state: () => ({ version: 1, status: 'idle' }),
		baselineSnapshot: () => null,
		stopFlight: () => null,
		currentHandle: () => current,
		setCurrentHandle: (handle) => { current = handle; },
		coordinator: () => ({ renew } as unknown as SessionLeaseCoordinator),
		runtimeStore: () => ({} as SessionRuntimeStore),
		diagnostics: () => null,
		scheduleInterval: () => null,
		cancelInterval: () => undefined,
		safeNowOr: (fallback) => fallback,
		logAuthorityFailure,
		failFromAuthority,
	};
	return {
		heartbeat: new ManualSessionHeartbeat(port),
		swap: (handle: ActiveSessionLeaseHandle | null) => { current = handle; },
		settle: (outcome: { value: RenewLeaseResult } | { error: Error }) => settle(outcome),
		failFromAuthority,
		logAuthorityFailure,
	};
}

describe('ManualSessionHeartbeat: a renewal answered after its handle was replaced', () => {
	const outcomes = [
		['lost', { value: { status: 'lost' } }],
		['unavailable', { value: { status: 'error', code: 'unavailable' } }],
		['a rejection', { error: new Error('Coordination store unavailable.') }],
	] as const;

	it.each(outcomes)('does not fail the session that holds the new handle when it answers %s', async (_name, outcome) => {
		const test = harness(lease('session-a', 1));
		const flight = test.heartbeat.runHeartbeat();
		test.swap(lease('session-b', 2));
		test.settle(outcome);
		await flight;

		expect(test.failFromAuthority).not.toHaveBeenCalled();
	});

	it.each(outcomes)('does not fail anything once the handle was released, when it answers %s', async (_name, outcome) => {
		const test = harness(lease('session-a', 1));
		const flight = test.heartbeat.runHeartbeat();
		test.swap(null);
		test.settle(outcome);
		await flight;

		expect(test.failFromAuthority).not.toHaveBeenCalled();
	});

	it.each(outcomes)('still fails the session whose own handle answers %s', async (_name, outcome) => {
		const test = harness(lease('session-a', 1));
		const flight = test.heartbeat.runHeartbeat();
		test.settle(outcome);
		await flight;

		expect(test.failFromAuthority).toHaveBeenCalledOnce();
		expect(test.logAuthorityFailure).toHaveBeenCalledOnce();
	});
});
