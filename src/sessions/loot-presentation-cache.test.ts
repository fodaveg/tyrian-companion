import { describe, expect, it, vi } from 'vitest';

import type { PreparedSessionNote } from './session-note-model';
import { LocalDebugPersistenceProbe, type LocalDebugPersistenceEvent } from '../core/local-debug-persistence';
import { LootPresentationCache } from './loot-presentation-cache';

describe('LootPresentationCache', () => {
	it('invalidates a pending complete session before clear/active can expose stale loot', async () => {
		const changed = vi.fn();
		const cache = new LootPresentationCache(changed);
		const pending = deferred<PreparedSessionNote | null>();
		const refresh = cache.refresh(() => pending.promise, (value) => value);
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
		const a = cache.refresh(() => first.promise, (value) => value);
		const b = cache.refresh(() => second.promise, (value) => value);
		second.resolve(note('en'));
		await b;
		first.resolve(note('es'));
		await a;
		expect(cache.get()?.locale).toBe('en');
	});

	it('treats an empty read and idempotent invalidation as successful cache operations', () => {
		const events: LocalDebugPersistenceEvent[] = [];
		const cache = new LootPresentationCache(
			undefined,
			new LocalDebugPersistenceProbe({
				sink: (event) => events.push(event),
				createId: () => crypto.randomUUID(),
			}),
		);

		expect(cache.get()).toBeNull();
		cache.invalidate();

		expect(events.filter(({ phase }) => phase !== 'start').map(({ operation, phase, code }) => ({
			operation,
			phase,
			code,
		}))).toEqual([
			{ operation: 'read', phase: 'success', code: 'ok' },
			{ operation: 'delete', phase: 'success', code: 'ok' },
		]);
	});

	it('attributes a projection TypeError to its precondition without inventing a cache storage failure', async () => {
		const events: LocalDebugPersistenceEvent[] = [];
		const cache = new LootPresentationCache(
			undefined,
			new LocalDebugPersistenceProbe({
				sink: (event) => events.push(event),
				createId: () => crypto.randomUUID(),
			}),
		);
		const cause = new TypeError('this.detectionQuality.getSessionSummary is not a function');

		const result = await cache.refresh(async () => note('es'), () => { throw cause; });

		expect(result).toEqual({
			status: 'failed', stage: 'projection', code: 'precondition_failed', cause,
		});
		expect(events).toEqual([]);
		expect(cache.get()).toBeNull();
		expect(events.at(-1)).toMatchObject({ operation: 'read', phase: 'success', code: 'ok' });
	});

	it('keeps source-store failures distinct from internal projection failures', async () => {
		const cache = new LootPresentationCache();
		const storageCause = new DOMException('IndexedDB unavailable', 'UnknownError');
		const internalCause = new Error('projection contract bug');

		await expect(cache.refresh(async () => { throw storageCause; }, (value) => value))
			.resolves.toEqual({ status: 'failed', stage: 'source_read', code: 'storage_failure', cause: storageCause });
		await expect(cache.refresh(async () => note('es'), () => { throw internalCause; }))
			.resolves.toEqual({ status: 'failed', stage: 'projection', code: 'internal_failure', cause: internalCause });
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
