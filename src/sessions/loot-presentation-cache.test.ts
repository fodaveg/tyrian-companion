import { describe, expect, it, vi } from 'vitest';

import type { PreparedSessionNote } from './session-note-model';
import { LootPresentationCache } from './loot-presentation-cache';

describe('LootPresentationCache', () => {
	it('invalidates a pending complete session before clear/active can expose stale loot', async () => {
		const changed = vi.fn();
		const cache = new LootPresentationCache(changed);
		const pending = deferred<PreparedSessionNote | null>();
		const refresh = cache.refresh(() => pending.promise);
		cache.invalidate(); // clear
		cache.invalidate(); // active
		pending.resolve(note('es'));
		await refresh;
		expect(cache.get()).toBeNull();
		expect(changed).not.toHaveBeenCalled();
	});

	it('publishes only the latest rebuild when language/input changes race', async () => {
		const cache = new LootPresentationCache();
		const first = deferred<PreparedSessionNote | null>();
		const second = deferred<PreparedSessionNote | null>();
		const a = cache.refresh(() => first.promise);
		const b = cache.refresh(() => second.promise);
		second.resolve(note('en'));
		await b;
		first.resolve(note('es'));
		await a;
		expect(cache.get()?.locale).toBe('en');
	});
});

function note(locale: 'es' | 'en'): PreparedSessionNote {
	return {
		locale, runtime: { review: { classification: {
			status: 'exact', permissions: { showNet: false, valueNet: false, grossPerHour: false, recommend: false },
		} }, delta: { availabilityChanges: [], compositionChanges: [] } },
		valuation: { status: 'not_evaluated' }, reservation: { status: 'not_evaluated' },
		hold: { status: 'not_evaluated' }, recommendation: { status: 'not_evaluated' },
	} as unknown as PreparedSessionNote;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
