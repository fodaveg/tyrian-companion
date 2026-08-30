import { describe, expect, it } from 'vitest';

import type { LocalDebugActionContext, LocalDebugEventContext } from './local-debug-action-runner';
import { RateLimitCoordinator } from './rate-limit-coordinator';

function clock(startAt: number): { now: () => number; advance: (ms: number) => void } {
	let current = startAt;
	return { now: () => current, advance: (ms) => { current += ms; } };
}

describe('RateLimitCoordinator', () => {
	it('records the effective cooldown with an explicitly propagated action identity', () => {
		const events: LocalDebugEventContext[] = [];
		const coordinator = new RateLimitCoordinator({
			now: () => 1_000,
			diagnostics: {
				createContext: (context: LocalDebugActionContext) => ({
					...context,
					actionId: context.actionId ?? 'generated',
					correlationId: context.correlationId ?? context.actionId ?? 'generated',
				}),
				event: (event) => { events.push(event); },
			},
		});

		coordinator.recordRateLimited(null, {
			component: 'inventory', action: 'inventory_refresh',
			actionId: 'refresh', correlationId: 'command',
		});

		expect(events).toEqual([expect.objectContaining({
			component: 'http', action: 'http_request', phase: 'retry', code: 'rate_limited',
			actionId: 'refresh', correlationId: 'command', state: 'active',
			details: { retryAfterMs: 60_000 },
		})]);
	});

	it('stays fail-open when the optional diagnostic port rejects the event', () => {
		const coordinator = new RateLimitCoordinator({
			now: () => 0,
			diagnostics: {
				createContext: () => { throw new Error('diagnostics unavailable'); },
				event: () => { throw new Error('must not run'); },
			},
		});

		expect(() => coordinator.recordRateLimited(2_000)).not.toThrow();
		expect(coordinator.status()).toEqual({ active: true, retryAt: 2_000, remainingMs: 2_000 });
	});

	it('starts with no cooldown active', () => {
		const coordinator = new RateLimitCoordinator({ now: () => 0 });
		expect(coordinator.status()).toEqual({ active: false });
	});

	it('respects an explicit Retry-After', () => {
		const time = clock(1_000);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		coordinator.recordRateLimited(5_000);
		expect(coordinator.status()).toEqual({ active: true, retryAt: 6_000, remainingMs: 5_000 });
	});

	it('falls back to the configured cooldown when Retry-After is missing', () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now, fallbackCooldownMs: 30_000 });
		coordinator.recordRateLimited(null);
		expect(coordinator.status()).toEqual({ active: true, retryAt: 30_000, remainingMs: 30_000 });
	});

	it('falls back when Retry-After is zero or negative', () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now, fallbackCooldownMs: 10_000 });
		coordinator.recordRateLimited(0);
		expect(coordinator.status()).toEqual({ active: true, retryAt: 10_000, remainingMs: 10_000 });
	});

	it('expires exactly at the recorded retryAt', () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		coordinator.recordRateLimited(1_000);
		time.advance(999);
		expect(coordinator.status()).toEqual({ active: true, retryAt: 1_000, remainingMs: 1 });
		time.advance(1);
		expect(coordinator.status()).toEqual({ active: false });
	});

	it('never shortens a cooldown already in effect', () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		coordinator.recordRateLimited(10_000);
		coordinator.recordRateLimited(1_000);
		expect(coordinator.status()).toEqual({ active: true, retryAt: 10_000, remainingMs: 10_000 });
	});

	it('extends the cooldown when a later 429 reports a longer wait', () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		coordinator.recordRateLimited(1_000);
		coordinator.recordRateLimited(5_000);
		expect(coordinator.status()).toEqual({ active: true, retryAt: 5_000, remainingMs: 5_000 });
	});

	it('starts a fresh cooldown after the previous one expired', () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		coordinator.recordRateLimited(1_000);
		time.advance(2_000);
		expect(coordinator.status()).toEqual({ active: false });
		coordinator.recordRateLimited(3_000);
		expect(coordinator.status()).toEqual({ active: true, retryAt: 5_000, remainingMs: 3_000 });
	});
});
