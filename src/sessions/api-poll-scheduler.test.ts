import { describe, expect, it, vi } from 'vitest';

import { HttpTransportError } from '../core/http';
import type { LocalDebugAction, LocalDebugComponent } from '../core/local-debug-contract';
import type {
	LocalDebugActionContext,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import {
	ApiPollScheduler,
	apiPollOutcomeFromError,
	type ApiPollOutcome,
} from './api-poll-scheduler';

describe('ApiPollScheduler', () => {
	it('records start and success with the current outer action identity', async () => {
		const harness = new SchedulerHarness();
		const diagnostics = diagnosticHarness();
		const parent: ResolvedLocalDebugActionContext = {
			component: 'detection', action: 'detection_arm',
			actionId: 'arm-action', correlationId: 'command-action',
		};
		const poll = vi.fn(async (_context?: ResolvedLocalDebugActionContext) => ({ kind: 'success' as const }));
		const scheduler = harness.create(poll, {
			diagnostics,
			resolveActionContext: () => parent,
		});

		scheduler.start(10_000);
		await harness.fireNext();

		expect(diagnostics.events).toEqual([
			expect.objectContaining({
				phase: 'start', actionId: 'poll-1', correlationId: 'command-action', attempt: 1,
				details: { intervalMs: 10_000, status: 'scheduled' },
			}),
			expect.objectContaining({
				phase: 'success', code: 'ok', actionId: 'poll-1', correlationId: 'command-action',
				details: { status: 'scheduled' }, durationMs: 0,
			}),
		]);
		expect(poll).toHaveBeenCalledWith(expect.objectContaining({
			actionId: 'poll-1', correlationId: 'command-action',
		}));
	});

	it('uses the diagnostic identity configured by each scheduler consumer', async () => {
		const harness = new SchedulerHarness();
		const diagnostics = diagnosticHarness();
		const scheduler = harness.create(async () => ({ kind: 'success' }), {
			diagnostics,
			diagnosticContext: {
				component: 'price_history',
				action: 'price_history_poll',
			},
		});

		scheduler.start(10_000);
		await harness.fireNext();

		expect(diagnostics.events).toHaveLength(2);
		expect(diagnostics.events).toEqual([
			expect.objectContaining({ component: 'price_history', action: 'price_history_poll', phase: 'start' }),
			expect.objectContaining({ component: 'price_history', action: 'price_history_poll', phase: 'success' }),
		]);
	});

	it('keeps staggered consumer deadlines and diagnostic identities isolated', async () => {
		const harness = new SchedulerHarness();
		harness.wall = 12_000;
		harness.monotonic = 12_000;
		const diagnostics = diagnosticHarness();
		const priceHistoryPoll = vi.fn(async () => ({ kind: 'success' }) as const);
		const detectionPoll = vi.fn(async () => ({ kind: 'success' }) as const);
		const priceHistoryScheduler = harness.create(priceHistoryPoll, {
			diagnostics,
			diagnosticContext: {
				component: 'price_history',
				action: 'price_history_poll',
			},
		});
		const detectionScheduler = harness.create(detectionPoll, { diagnostics });

		priceHistoryScheduler.start(60_000);
		harness.advanceWithoutTimers(12_000);
		detectionScheduler.start(60_000);
		await harness.fireNext();
		await harness.fireNext();

		const pollStarts = diagnostics.events.filter(({ phase }) => phase === 'start');
		expect(priceHistoryPoll).toHaveBeenCalledTimes(1);
		expect(detectionPoll).toHaveBeenCalledTimes(1);
		expect(pollStarts).toEqual([
			expect.objectContaining({
				component: 'price_history', action: 'price_history_poll', actionId: 'poll-1',
			}),
			expect.objectContaining({
				component: 'detection', action: 'detection_poll', actionId: 'poll-2',
			}),
		]);
		expect(pollStarts.filter(({ action }) => action === 'detection_poll')).toHaveLength(1);
		expect(new Set(pollStarts.map(({ actionId }) => actionId)).size).toBe(2);
		expect(priceHistoryScheduler.getState()).toMatchObject({
			lastAttemptAt: 72_000,
			nextRunAt: 132_000,
		});
		expect(detectionScheduler.getState()).toMatchObject({
			lastAttemptAt: 84_000,
			nextRunAt: 144_000,
		});
		expect(harness.pendingTimers()).toBe(2);
	});

	it('records rate-limit retry metadata and a cancellation as terminal phases', async () => {
		const rateHarness = new SchedulerHarness();
		const rateDiagnostics = diagnosticHarness();
		const rateScheduler = rateHarness.create(async () => ({ kind: 'rate_limited', retryAfterMs: 4_000 }), {
			diagnostics: rateDiagnostics,
		});
		rateScheduler.start(10_000);
		await rateHarness.fireNext();
		expect(rateDiagnostics.events.map(({ phase }) => phase)).toEqual(['start', 'retry']);
		expect(rateDiagnostics.events[1]).toMatchObject({
			code: 'rate_limited', details: { status: 'backoff', retryAfterMs: 4_000 },
		});

		const cancelHarness = new SchedulerHarness();
		const cancelDiagnostics = diagnosticHarness();
		const deferred = deferredOutcome();
		const cancelScheduler = cancelHarness.create(() => deferred.promise, { diagnostics: cancelDiagnostics });
		cancelScheduler.start(10_000);
		await cancelHarness.fireNext();
		cancelScheduler.stop();
		deferred.resolve({ kind: 'success' });
		await flushPromises();
		expect(cancelDiagnostics.events.map(({ phase }) => phase)).toEqual(['start', 'cancel']);
		expect(cancelDiagnostics.events[1]).toMatchObject({ code: 'cancelled', details: { status: 'idle' } });
	});

	it('records a slept-through poll as start plus skip without calling the poller', async () => {
		const harness = new SchedulerHarness();
		const diagnostics = diagnosticHarness();
		const poll = vi.fn(async () => ({ kind: 'success' }) as const);
		const scheduler = harness.create(poll, { diagnostics, sleepToleranceMs: 1_000 });
		scheduler.start(10_000);

		await harness.fireNext(5_000);

		expect(poll).not.toHaveBeenCalled();
		expect(diagnostics.events.map(({ phase }) => phase)).toEqual(['start', 'skip']);
		expect(diagnostics.events[1]).toMatchObject({ code: 'skipped', details: { status: 'paused_sleep' } });
	});

	it('records a failure for central sanitization and remains fail-open when diagnostics throw', async () => {
		const harness = new SchedulerHarness();
		const diagnostics = diagnosticHarness();
		const scheduler = harness.create(async () => {
			throw new Error('Bearer abcdefghijklmnop https://private.invalid/secret');
		}, { diagnostics });
		scheduler.start(10_000);
		await harness.fireNext();
		expect(diagnostics.events.at(-1)).toMatchObject({ phase: 'failure', code: 'unknown_failure' });
		expect(diagnostics.events.at(-1)?.message).toBeInstanceOf(Error);

		const failingDiagnostics = {
			createContext: () => { throw new Error('diagnostics unavailable'); },
			event: () => { throw new Error('must not run'); },
		};
		const failOpenHarness = new SchedulerHarness();
		const failOpenScheduler = failOpenHarness.create(async () => ({ kind: 'success' }), {
			diagnostics: failingDiagnostics,
		});
		failOpenScheduler.start(10_000);
		await failOpenHarness.fireNext();
		expect(failOpenScheduler.getState().status).toBe('scheduled');
	});

	it('has no timer or polling side effect until explicitly started', () => {
		const harness = new SchedulerHarness();
		const poll = vi.fn<() => Promise<ApiPollOutcome>>();
		const scheduler = harness.create(poll);

		expect(scheduler.getState()).toEqual({
			status: 'idle',
			intervalMs: null,
			nextRunAt: null,
			lastAttemptAt: null,
			lastSuccessAt: null,
			consecutiveFailures: 0,
		});
		expect(harness.pendingTimers()).toBe(0);
		expect(poll).not.toHaveBeenCalled();
	});

	it('polls once per deadline and schedules the next interval after success', async () => {
		const harness = new SchedulerHarness();
		const poll = vi.fn(async () => ({ kind: 'success' }) as const);
		const scheduler = harness.create(poll);
		scheduler.start(60_000);

		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', nextRunAt: 61_000 });
		await harness.fireNext();

		expect(poll).toHaveBeenCalledTimes(1);
		expect(scheduler.getState()).toMatchObject({
			status: 'scheduled',
			lastAttemptAt: 61_000,
			lastSuccessAt: 61_000,
			nextRunAt: 121_000,
			consecutiveFailures: 0,
		});
		expect(harness.pendingTimers()).toBe(1);
	});

	it('keeps one poll in flight and applies an interval update without overlap', async () => {
		const harness = new SchedulerHarness();
		const deferred = deferredOutcome();
		const poll = vi.fn(() => deferred.promise);
		const scheduler = harness.create(poll, { resumeDelayMs: 2_000 });
		scheduler.start(60_000);
		await harness.fireNext();
		expect(scheduler.getState().status).toBe('polling');

		scheduler.updateInterval(30_000);
		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', intervalMs: 30_000, nextRunAt: null });
		expect(harness.pendingTimers()).toBe(0);
		deferred.resolve({ kind: 'success' });
		await flushPromises();

		expect(poll).toHaveBeenCalledTimes(1);
		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', nextRunAt: 63_000 });
		expect(harness.pendingTimers()).toBe(1);
	});

	it('pauses offline and resumes with one spaced timer', async () => {
		const harness = new SchedulerHarness();
		const poll = vi.fn(async () => ({ kind: 'success' }) as const);
		const scheduler = harness.create(poll, { resumeDelayMs: 5_000 });
		scheduler.start(60_000);

		scheduler.setOnline(false);
		expect(scheduler.getState()).toMatchObject({ status: 'paused_offline', nextRunAt: null });
		expect(harness.pendingTimers()).toBe(0);
		scheduler.setOnline(true);
		scheduler.setOnline(true);
		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', nextRunAt: 6_000 });
		expect(harness.pendingTimers()).toBe(1);

		await harness.fireNext();
		expect(poll).toHaveBeenCalledTimes(1);
	});

	it('stays paused after the poller reports offline until connectivity returns', async () => {
		const harness = new SchedulerHarness();
		const poll = vi
			.fn<() => Promise<ApiPollOutcome>>()
			.mockResolvedValueOnce({ kind: 'offline' })
			.mockResolvedValue({ kind: 'success' });
		const scheduler = harness.create(poll, { resumeDelayMs: 1_000 });
		scheduler.start(10_000);
		await harness.fireNext();

		expect(scheduler.getState().status).toBe('paused_offline');
		expect(harness.pendingTimers()).toBe(0);
		scheduler.setOnline(true);
		await harness.fireNext();
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it('skips a late sleep deadline instead of replaying missed polls', async () => {
		const harness = new SchedulerHarness();
		const states: string[] = [];
		const poll = vi.fn(async () => ({ kind: 'success' }) as const);
		const scheduler = harness.create(poll, {
			resumeDelayMs: 2_000,
			sleepToleranceMs: 5_000,
			onStateChange: (state) => states.push(state.status),
		});
		scheduler.start(10_000);

		await harness.fireNext(60_000);
		expect(poll).not.toHaveBeenCalled();
		expect(states).toContain('paused_sleep');
		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', nextRunAt: 73_000 });
		expect(harness.pendingTimers()).toBe(1);

		await harness.fireNext();
		expect(poll).toHaveBeenCalledTimes(1);
	});

	it('treats an explicit wake as a fresh spaced deadline', () => {
		const harness = new SchedulerHarness();
		const scheduler = harness.create(async () => ({ kind: 'success' }), { resumeDelayMs: 3_000 });
		scheduler.start(60_000);
		harness.advanceWithoutTimers(10_000);

		scheduler.notifyWake();

		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', nextRunAt: 14_000 });
		expect(harness.pendingTimers()).toBe(1);
	});

	it('honors Retry-After and resets failures after a successful retry', async () => {
		const harness = new SchedulerHarness();
		const poll = vi
			.fn<() => Promise<ApiPollOutcome>>()
			.mockResolvedValueOnce({ kind: 'rate_limited', retryAfterMs: 12_000 })
			.mockResolvedValue({ kind: 'success' });
		const scheduler = harness.create(poll);
		scheduler.start(60_000);
		await harness.fireNext();

		expect(scheduler.getState()).toMatchObject({
			status: 'backoff',
			nextRunAt: 73_000,
			consecutiveFailures: 1,
		});
		await harness.fireNext();
		expect(scheduler.getState()).toMatchObject({
			status: 'scheduled',
			consecutiveFailures: 0,
			nextRunAt: 133_000,
		});
	});

	it('uses bounded exponential backoff with deterministic jitter', async () => {
		const harness = new SchedulerHarness();
		const poll = vi.fn(async () => ({ kind: 'transient_failure' }) as const);
		const scheduler = harness.create(poll, {
			baseBackoffMs: 1_000,
			maxBackoffMs: 2_000,
			random: () => 0.5,
		});
		scheduler.start(10_000);

		await harness.fireNext();
		expect(scheduler.getState()).toMatchObject({ status: 'backoff', nextRunAt: 12_000 });
		await harness.fireNext();
		expect(scheduler.getState()).toMatchObject({ status: 'backoff', nextRunAt: 14_000 });
		await harness.fireNext();
		expect(scheduler.getState()).toMatchObject({ status: 'backoff', nextRunAt: 16_000 });
	});

	it('falls back to backoff for an absent or invalid rate-limit delay', async () => {
		const harness = new SchedulerHarness();
		const poll = vi.fn(async () => ({ kind: 'rate_limited', retryAfterMs: 0 }) as const);
		const scheduler = harness.create(poll, { baseBackoffMs: 1_000, random: () => 0.5 });
		scheduler.start(10_000);

		await harness.fireNext();
		expect(scheduler.getState()).toMatchObject({ status: 'backoff', nextRunAt: 12_000 });
	});

	it('maps a sanitized network rejection to transient backoff without leaking it', async () => {
		const harness = new SchedulerHarness();
		const scheduler = harness.create(async () => {
			throw new HttpTransportError('network', null, null, 'Network request failed.');
		}, {
			baseBackoffMs: 1_000,
			random: () => 0.5,
		});
		scheduler.start(10_000);
		await harness.fireNext();

		expect(scheduler.getState()).toMatchObject({ status: 'backoff', consecutiveFailures: 1 });
		expect(JSON.stringify(scheduler.getState())).not.toContain('secret');
	});

	it('fails closed on an unknown rejection instead of retrying programming errors forever', async () => {
		const harness = new SchedulerHarness();
		const scheduler = harness.create(async () => { throw new Error('unexpected'); });
		scheduler.start(10_000);
		await harness.fireNext();

		expect(scheduler.getState().status).toBe('fatal');
		expect(harness.pendingTimers()).toBe(0);
	});

	it('fails closed on a malformed outcome from an untrusted poll adapter', async () => {
		const harness = new SchedulerHarness();
		const scheduler = harness.create(async () => ({ kind: 'success', extra: true }) as never);
		scheduler.start(10_000);
		await harness.fireNext();

		expect(scheduler.getState().status).toBe('fatal');
		expect(harness.pendingTimers()).toBe(0);
	});

	it('stops scheduling after a fatal result until explicitly started again', async () => {
		const harness = new SchedulerHarness();
		const poll = vi
			.fn<() => Promise<ApiPollOutcome>>()
			.mockResolvedValueOnce({ kind: 'fatal' })
			.mockResolvedValue({ kind: 'success' });
		const scheduler = harness.create(poll);
		scheduler.start(10_000);
		await harness.fireNext();

		expect(scheduler.getState().status).toBe('fatal');
		expect(harness.pendingTimers()).toBe(0);
		scheduler.start(20_000);
		await harness.fireNext();
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it('ignores a stale completion after stop and after a later restart', async () => {
		const harness = new SchedulerHarness();
		const deferred = deferredOutcome();
		const poll = vi.fn(() => deferred.promise);
		const scheduler = harness.create(poll, { resumeDelayMs: 1_000 });
		scheduler.start(10_000);
		await harness.fireNext();
		scheduler.stop();
		expect(scheduler.getState()).toMatchObject({ status: 'idle', intervalMs: null });
		scheduler.start(20_000);

		deferred.resolve({ kind: 'success' });
		await flushPromises();
		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', nextRunAt: 12_000 });
		expect(harness.pendingTimers()).toBe(1);
	});

	it('disposes timers and never reschedules an in-flight completion', async () => {
		const harness = new SchedulerHarness();
		const deferred = deferredOutcome();
		const scheduler = harness.create(() => deferred.promise);
		scheduler.start(10_000);
		await harness.fireNext();
		scheduler.dispose();
		deferred.resolve({ kind: 'success' });
		await flushPromises();

		expect(scheduler.getState()).toMatchObject({ status: 'disposed', intervalMs: null, nextRunAt: null });
		expect(harness.pendingTimers()).toBe(0);
		expect(() => scheduler.start(10_000)).toThrow(/disposed/u);
	});

	it('isolates throwing observers from the scheduler', async () => {
		const harness = new SchedulerHarness();
		const diagnostics = diagnosticHarness();
		const scheduler = harness.create(async () => ({ kind: 'success' }), {
			onStateChange: () => { throw new Error('observer failed'); },
			diagnostics,
		});

		expect(() => scheduler.start(10_000)).not.toThrow();
		expect(diagnostics.events.slice(0, 2)).toEqual([
			expect.objectContaining({ component: 'ui', action: 'view_render', phase: 'start', state: 'observer' }),
			expect.objectContaining({ component: 'ui', action: 'view_render', phase: 'failure', state: 'observer' }),
		]);
		await harness.fireNext();
		expect(scheduler.getState().status).toBe('scheduled');
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		'rejects an invalid interval %s before scheduling',
		(interval) => {
			const harness = new SchedulerHarness();
			const scheduler = harness.create(async () => ({ kind: 'success' }));

			expect(() => scheduler.start(interval)).toThrow(RangeError);
			expect(harness.pendingTimers()).toBe(0);
		},
	);

	it('fails closed if a runtime clock becomes invalid', async () => {
		const harness = new SchedulerHarness();
		const scheduler = harness.create(async () => ({ kind: 'success' }));
		scheduler.start(10_000);
		harness.wall = Number.NaN;

		await harness.fireNext(0, false);
		expect(scheduler.getState().status).toBe('fatal');
		expect(harness.pendingTimers()).toBe(0);
	});

	it('returns detached state snapshots that cannot mutate scheduler state', () => {
		const harness = new SchedulerHarness();
		const scheduler = harness.create(async () => ({ kind: 'success' }));
		scheduler.start(10_000);
		const state = scheduler.getState() as { status: string; nextRunAt: number | null };
		state.status = 'fatal';
		state.nextRunAt = 999;

		expect(scheduler.getState()).toMatchObject({ status: 'scheduled', nextRunAt: 11_000 });
	});
});

describe('apiPollOutcomeFromError', () => {
	it.each([
		[new HttpTransportError('network', null, null, 'Network failed.'), { kind: 'transient_failure' }],
		[new HttpTransportError('timeout', null, null, 'Timed out.'), { kind: 'transient_failure' }],
		[new HttpTransportError('http', 503, 2_000, 'Unavailable.'), { kind: 'transient_failure' }],
		[new HttpTransportError('http', 429, 3_000, 'Limited.'), { kind: 'rate_limited', retryAfterMs: 3_000 }],
		[new HttpTransportError('http', 401, null, 'Rejected.'), { kind: 'fatal' }],
		[new Error('programming error'), { kind: 'fatal' }],
	] as const)('maps transport policy without retaining error text', (error, expected) => {
		expect(apiPollOutcomeFromError(error)).toEqual(expected);
	});
});

interface HarnessOptions {
	baseBackoffMs?: number;
	maxBackoffMs?: number;
	resumeDelayMs?: number;
	sleepToleranceMs?: number;
	random?: () => number;
	onStateChange?: (state: ReturnType<ApiPollScheduler['getState']>) => void;
	diagnostics?: Pick<ReturnType<typeof diagnosticHarness>, 'createContext' | 'event'>;
	diagnosticContext?: Readonly<{ component: LocalDebugComponent; action: LocalDebugAction }>;
	resolveActionContext?: () => ResolvedLocalDebugActionContext | undefined;
}

class SchedulerHarness {
	wall = 1_000;
	monotonic = 100;
	private nextId = 1;
	private readonly timers = new Map<number, { callback: () => void; dueWall: number; dueMonotonic: number }>();

	create(poll: () => Promise<ApiPollOutcome>, options: HarnessOptions = {}): ApiPollScheduler {
		return new ApiPollScheduler({
			poll,
			wallNow: () => this.wall,
			monotonicNow: () => this.monotonic,
			random: options.random ?? (() => 0.5),
			baseBackoffMs: options.baseBackoffMs,
			maxBackoffMs: options.maxBackoffMs,
			resumeDelayMs: options.resumeDelayMs,
			sleepToleranceMs: options.sleepToleranceMs,
			onStateChange: options.onStateChange,
			scheduleTimeout: (callback, delayMs) => {
				const id = this.nextId;
				this.nextId += 1;
				this.timers.set(id, {
					callback,
					dueWall: this.wall + delayMs,
					dueMonotonic: this.monotonic + delayMs,
				});
				return id;
			},
			cancelTimeout: (handle) => { this.timers.delete(handle as number); },
			diagnostics: options.diagnostics,
			diagnosticContext: options.diagnosticContext,
			resolveActionContext: options.resolveActionContext,
		});
	}

	pendingTimers(): number {
		return this.timers.size;
	}

	advanceWithoutTimers(milliseconds: number): void {
		this.wall += milliseconds;
		this.monotonic += milliseconds;
	}

	async fireNext(lateness = 0, advanceWall = true): Promise<void> {
		const next = [...this.timers.entries()].sort((left, right) => left[1].dueMonotonic - right[1].dueMonotonic)[0];
		if (!next) throw new Error('No timer is pending.');
		const [id, timer] = next;
		this.timers.delete(id);
		if (advanceWall) this.wall = timer.dueWall + lateness;
		this.monotonic = timer.dueMonotonic + lateness;
		timer.callback();
		await flushPromises();
	}
}

function deferredOutcome(): {
	promise: Promise<ApiPollOutcome>;
	resolve: (outcome: ApiPollOutcome) => void;
} {
	let resolve!: (outcome: ApiPollOutcome) => void;
	const promise = new Promise<ApiPollOutcome>((next) => { resolve = next; });
	return { promise, resolve };
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function diagnosticHarness(): {
	createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext;
	event(context: LocalDebugEventContext): void;
	events: LocalDebugEventContext[];
} {
	let sequence = 0;
	const events: LocalDebugEventContext[] = [];
	return {
		events,
		createContext: (context) => {
			sequence += 1;
			const actionId = context.actionId ?? `poll-${sequence}`;
			return {
				...context, actionId,
				correlationId: context.correlationId ?? context.parent?.correlationId ?? context.parent?.actionId ?? actionId,
			};
		},
		event: (event) => { events.push(event); },
	};
}
