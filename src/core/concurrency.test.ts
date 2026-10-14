import { describe, expect, it } from 'vitest';

import { createLimiter } from './concurrency';

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

describe('createLimiter', () => {
	it('runs queued tasks in order and never more than the limit at once', async () => {
		const limit = createLimiter(2);
		let running = 0; let peak = 0; const order: number[] = [];
		await Promise.all(Array.from({ length: 6 }, (_, index) => limit(async () => {
			order.push(index); running += 1; peak = Math.max(peak, running);
			await Promise.resolve(); await Promise.resolve();
			running -= 1;
		})));
		expect(peak).toBe(2);
		expect(order).toEqual([0, 1, 2, 3, 4, 5]);
	});

	// The extra caller is delayed by 0..11 microtask hops, so one of them lands exactly between the slot being freed and its waiter resuming.
	it.each(Array.from({ length: 12 }, (_, hops) => hops))('never runs limit+1 tasks when a new call lands %i microtask hops after the slot is released', async (hops) => {
		const limit = createLimiter(1);
		let running = 0; let peak = 0;
		const track = async (hold: Promise<void>): Promise<void> => {
			running += 1; peak = Math.max(peak, running);
			await hold;
			running -= 1;
		};
		const first = deferred(); const second = deferred(); const third = deferred(); const gate = deferred();
		const a = limit(async () => { await track(first.promise); });
		const b = limit(async () => { await track(second.promise); });
		// A microtask queued before the freed slot's waiter resumes: it calls the limiter in that window.
		const c = gate.promise.then(async () => {
			for (let hop = 0; hop < hops; hop += 1) await Promise.resolve();
		}).then(async () => await limit(async () => { await track(third.promise); }));
		gate.release(); first.release();
		await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
		expect(peak).toBe(1);
		second.release(); third.release();
		await Promise.all([a, b, c]);
		expect(peak).toBe(1);
	});
});
