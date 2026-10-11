import { describe, expect, it, vi } from 'vitest';

import type { SessionRecoveryState } from '../sessions/manual-session-start-service';
import { SESSION_STORE_RETRY_MAX_MS, SessionStoreRetry } from './session-store-retry';

/**
 * RT-17: the retry over fakes of the two session services. The timers are a list the test runs by hand, so every delay asked
 * for is read as a number and nothing runs unless the test says so.
 */
function fixture(options: { consult?: boolean; recovery?: SessionRecoveryState; livePhase?: string; stuck?: boolean } = {}) {
	const state: { consult: boolean; recovery: SessionRecoveryState; livePhase: string; stuck: boolean; answers: boolean } = {
		consult: options.consult ?? true,
		recovery: options.recovery ?? { status: 'error', code: 'unavailable', message: 'Session recovery storage is unavailable.' },
		livePhase: options.livePhase ?? 'error',
		stuck: options.stuck ?? false,
		/** What the next read of each store finds: `true` once the store answers again. */
		answers: false,
	};
	const timers: { callback: () => void; ms: number; cancelled: boolean }[] = [];
	const sessions = {
		getRecoveryState: vi.fn(() => structuredClone(state.recovery)),
		initialize: vi.fn(async () => { if (state.answers) state.recovery = { status: 'none' }; }),
	};
	const liveSessions = {
		getView: vi.fn(() => ({ phase: state.livePhase }) as ReturnType<NonNullable<ConstructorParameters<typeof SessionStoreRetry>[0]['liveSessions']>['getView']>),
		isStuck: vi.fn(() => state.stuck),
		initialize: vi.fn(async () => { if (state.answers) state.livePhase = 'idle'; }),
	};
	const onDiagnostic = vi.fn();
	const retry = new SessionStoreRetry({
		consulting: () => state.consult, sessions, liveSessions, onDiagnostic,
		scheduleTimeout: (callback, ms) => { const timer = { callback, ms, cancelled: false }; timers.push(timer); return timer; },
		cancelTimeout: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
	});
	const live = () => timers.filter((timer) => !timer.cancelled);
	/** Runs the one timer still armed, as the host would when its wait is over. */
	const runArmed = (): void => {
		const armed = live();
		expect(armed).toHaveLength(1);
		const [timer] = armed;
		if (timer === undefined) return;
		timer.cancelled = true;
		timer.callback();
	};
	return {
		state, timers, sessions, liveSessions, retry, runArmed, onDiagnostic,
		/** Fires the one timer still armed and lets its attempt end. */
		async fire() {
			runArmed();
			await vi.waitFor(() => { expect(sessions.initialize.mock.results.every((result) => result.type === 'return')).toBe(true); });
			await new Promise<void>((resolve) => { setImmediate(resolve); });
		},
		pending: () => live().length,
	};
}

describe('SessionStoreRetry (RT-17)', () => {
	it('asks again with waits that double from five seconds and stop growing at five minutes, then stops once both stores answer', async () => {
		const f = fixture();
		f.retry.arm();
		for (let attempt = 0; attempt < 9; attempt += 1) await f.fire();
		expect(f.timers.map((timer) => timer.ms)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000]);
		expect(f.timers.at(-1)?.ms).toBe(SESSION_STORE_RETRY_MAX_MS);
		expect(f.sessions.initialize).toHaveBeenCalledTimes(9);
		expect(f.liveSessions.initialize).toHaveBeenCalledTimes(9);

		f.state.answers = true;
		await f.fire();
		expect(f.state.recovery).toEqual({ status: 'none' });
		expect(f.state.livePhase).toBe('idle');
		expect(f.pending()).toBe(0);
		// A later silence starts again from five seconds.
		f.state.livePhase = 'error'; f.state.answers = false;
		f.retry.arm();
		expect(f.timers.at(-1)?.ms).toBe(5_000);
	});

	it('reads again only the store that did not answer', async () => {
		const f = fixture({ recovery: { status: 'none' } });
		f.retry.arm();
		await f.fire();
		expect(f.sessions.initialize).not.toHaveBeenCalled();
		expect(f.liveSessions.initialize).toHaveBeenCalledTimes(1);
	});

	it('reports a read that rejects instead of answering, and asks again later', async () => {
		const f = fixture();
		const failure = new Error('Summary receipt read failed.');
		f.sessions.initialize.mockRejectedValueOnce(failure);
		f.retry.arm();
		f.runArmed();
		await vi.waitFor(() => { expect(f.pending()).toBe(1); });
		expect(f.onDiagnostic).toHaveBeenCalledWith(failure);
		expect(f.timers.at(-1)?.ms).toBe(10_000);
	});

	it('does not ask again for a saved record that is corrupt, nor for a live session that is stuck', () => {
		const corrupt = fixture({ recovery: { status: 'error', code: 'corrupt', message: 'The saved farming session is corrupt and was left untouched.' }, livePhase: 'idle' });
		corrupt.retry.arm();
		expect(corrupt.pending()).toBe(0);
		const stuck = fixture({ recovery: { status: 'none' }, stuck: true });
		stuck.retry.arm();
		expect(stuck.pending()).toBe(0);
	});

	it('leaves a collector to the lifecycle\'s heartbeat and to the start (Z2-2): nothing is armed there', () => {
		const f = fixture({ consult: false });
		f.retry.arm();
		expect(f.pending()).toBe(0);
	});

	it('keeps one attempt at a time: a state change while it reads arms nothing more', async () => {
		const f = fixture();
		let release: () => void = () => undefined;
		f.sessions.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
		f.retry.arm();
		f.runArmed();
		f.retry.arm(); f.retry.arm();
		expect(f.pending()).toBe(0);
		release();
		await vi.waitFor(() => { expect(f.pending()).toBe(1); });
		expect(f.timers.at(-1)?.ms).toBe(10_000);
	});

	it('stops at unload: the armed wait is cancelled, and an attempt in course neither reads the live session nor arms another', async () => {
		const armed = fixture();
		armed.retry.arm();
		armed.retry.dispose();
		expect(armed.pending()).toBe(0);
		armed.retry.arm();
		expect(armed.pending()).toBe(0);

		const reading = fixture();
		let release: () => void = () => undefined;
		reading.sessions.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
		reading.retry.arm();
		reading.runArmed();
		reading.retry.dispose();
		release();
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		expect(reading.liveSessions.initialize).not.toHaveBeenCalled();
		expect(reading.pending()).toBe(0);
	});
});
