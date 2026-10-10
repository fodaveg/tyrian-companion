import { describe, expect, it, vi } from 'vitest';

import { LocalDebugPersistenceProbe, type LocalDebugPersistenceEvent } from './local-debug-persistence';
import { requestPersistentStorage, type PersistentStorageManager } from './persistent-storage';

/** The probe the core hands over, with a sink that keeps every event it is given. */
function recorded() {
	const events: LocalDebugPersistenceEvent[] = [];
	const probe = new LocalDebugPersistenceProbe({ sink: (event) => { events.push(event); }, now: () => 0, createId: () => 'id' });
	/** The event that settled the request: the one after `start`. */
	const settled = () => {
		expect(events.map((event) => event.phase)).toHaveLength(2);
		const [start, end] = events;
		expect(start).toMatchObject({ store: 'origin_storage', operation: 'open', phase: 'start' });
		return end!;
	};
	return { probe, settled };
}

// DU-13 (10 Oct 2026): IndexedDB is «best effort» until the engine agrees to keep the origin.
describe('requestPersistentStorage', () => {
	it('answers granted when the engine agrees, and records it', async () => {
		const { probe, settled } = recorded();
		const storage = { persist: vi.fn(async () => true) };

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
		expect(storage.persist).toHaveBeenCalledTimes(1);
		expect(settled()).toMatchObject({ phase: 'success', code: 'ok', detail: { result: 'granted' } });
	});

	it('answers denied when the engine refuses, and records it as a warning', async () => {
		const { probe, settled } = recorded();

		await expect(requestPersistentStorage(() => ({ persist: async () => false }), probe)).resolves.toBe('denied');
		expect(settled()).toMatchObject({ phase: 'skip', code: 'permission_denied', detail: { result: 'denied' } });
	});

	it.each([
		['no storage manager', () => null],
		['no storage manager at all', () => undefined],
		['a storage manager without persist', () => ({}) as PersistentStorageManager],
	])('answers unavailable with %s, without asking anything', async (_label, readStorage) => {
		const { probe, settled } = recorded();

		await expect(requestPersistentStorage(readStorage, probe)).resolves.toBe('unavailable');
		expect(settled()).toMatchObject({ phase: 'skip', code: 'skipped', detail: { result: 'unavailable', reason: 'no_api' } });
	});

	it.each([
		['throws', { persist: () => { throw new DOMException('no', 'SecurityError'); } }],
		['rejects', { persist: async () => { throw new TypeError('no'); } }],
	])('answers unavailable when persist %s, and never throws itself', async (_label, storage) => {
		const { probe, settled } = recorded();

		await expect(requestPersistentStorage(() => storage as PersistentStorageManager, probe)).resolves.toBe('unavailable');
		expect(settled()).toMatchObject({ phase: 'skip', code: 'unavailable', detail: { result: 'unavailable', reason: 'request_failed' } });
	});

	it('answers unavailable when the host cannot even hand the manager over', async () => {
		const { probe, settled } = recorded();

		await expect(requestPersistentStorage(() => { throw new ReferenceError('window is not defined'); }, probe)).resolves.toBe('unavailable');
		expect(settled()).toMatchObject({ phase: 'skip', code: 'unavailable', detail: { result: 'unavailable', reason: 'request_failed' } });
	});

	it('answers unavailable for an answer that is neither true nor false', async () => {
		const { probe, settled } = recorded();
		const storage = { persist: async () => 'yes' } as unknown as PersistentStorageManager;

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('unavailable');
		expect(settled()).toMatchObject({ phase: 'skip', code: 'unavailable', detail: { result: 'unavailable', reason: 'unexpected_answer' } });
	});

	// A browser method called without its receiver throws `Illegal invocation`, which a plain function never does.
	it('calls persist on the manager itself', async () => {
		const { probe } = recorded();
		const storage = {
			persist(this: unknown): Promise<boolean> {
				if (this !== storage) throw new TypeError('Illegal invocation');
				return Promise.resolve(true);
			},
		};

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
	});
});

// The answer alone does not say whether eviction is near: the same line carries how full the origin is, where the engine says.
describe('requestPersistentStorage with an estimate', () => {
	const MIB = 1024 * 1024;

	it('records the origin\'s usage in whole MiB and the band of the quota it takes next to the answer, asking estimate once on the manager itself', async () => {
		const { probe, settled } = recorded();
		const storage = {
			persist: vi.fn(async () => true),
			estimate: vi.fn(function (this: unknown): Promise<StorageEstimate> {
				if (this !== storage) throw new TypeError('Illegal invocation');
				return Promise.resolve({ usage: 5.4 * MIB, quota: 2048 * MIB });
			}),
		};

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
		expect(storage.estimate).toHaveBeenCalledTimes(1);
		expect(settled().detail).toEqual({ result: 'granted', usageMiB: '5', quotaUsedBand: '<50' });
	});

	it('records them with a refusal too', async () => {
		const { probe, settled } = recorded();
		const storage = { persist: async () => false, estimate: async () => ({ usage: 0, quota: 512 * MIB }) };

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('denied');
		expect(settled()).toMatchObject({ phase: 'skip', code: 'permission_denied' });
		expect(settled().detail).toEqual({ result: 'denied', usageMiB: '0', quotaUsedBand: '<50' });
	});

	it.each([
		['rejects', { estimate: async () => { throw new DOMException('no', 'SecurityError'); } }],
		['throws', { estimate: () => { throw new TypeError('no'); } }],
	])('keeps the answer and leaves the figures out when estimate %s', async (_label, estimating) => {
		const { probe, settled } = recorded();
		const storage = { persist: async () => true, ...estimating } as PersistentStorageManager;

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
		expect(settled()).toMatchObject({ phase: 'success', code: 'ok' });
		expect(settled().detail).toEqual({ result: 'granted' });
	});

	it.each([
		['below half', 0, 200, '<50'],
		['just below half', 99.9, 200, '<50'],
		['at half', 100, 200, '50-80'],
		['just below 80 %', 159.9, 200, '50-80'],
		['at 80 %', 160, 200, '80-95'],
		['just below 95 %', 189.9, 200, '80-95'],
		['at 95 %', 190, 200, '>=95'],
		['at the quota', 200, 200, '>=95'],
		['above the quota, as an engine may report', 300, 200, '>=95'],
	])('records the band %s', async (_label, usage, quota, band) => {
		const { probe, settled } = recorded();
		const storage = { persist: async () => true, estimate: async () => ({ usage: usage * MIB, quota: quota * MIB }) };

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
		expect(settled().detail).toMatchObject({ quotaUsedBand: band });
	});

	// The quota gives the size of the disk away, and an exact share would give it back from the usage beside it: neither
	// reaches the line, in bytes, in MiB, as a percentage or under any other key.
	it('never records the quota itself nor an exact share of it', async () => {
		const { probe, settled } = recorded();
		const quota = 238_475 * MIB;
		const storage = { persist: async () => true, estimate: async () => ({ usage: 200_000 * MIB, quota }) };

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
		const detail = settled().detail ?? {};
		expect(Object.keys(detail).sort()).toEqual(['quotaUsedBand', 'result', 'usageMiB']);
		expect(detail).toEqual({ result: 'granted', usageMiB: '200000', quotaUsedBand: '80-95' });
		expect(Object.values(detail).some((value) => /^\d+(?:\.\d+)?%?$/u.test(value) && value !== '200000')).toBe(false);
		expect(Object.values(detail)).not.toContain(String(quota));
		expect(Object.values(detail)).not.toContain('238475');
	});

	it.each([
		['a zero quota', 0],
		['a quota that is not a number', Number.NaN],
		['no quota', undefined],
	])('records only the usage with %s', async (_label, quota) => {
		const { probe, settled } = recorded();
		const storage = { persist: async () => true, estimate: async () => ({ usage: 2 * MIB, quota }) };

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
		expect(settled().detail).toEqual({ result: 'granted', usageMiB: '2' });
	});

	it('leaves out a figure that is not a finite, non-negative number', async () => {
		const { probe, settled } = recorded();
		const storage = { persist: async () => true, estimate: async () => ({ usage: Number.NaN, quota: -1 }) };

		await expect(requestPersistentStorage(() => storage, probe)).resolves.toBe('granted');
		expect(settled().detail).toEqual({ result: 'granted' });
	});

	it('never asks for an estimate when there was nothing to ask persist of', async () => {
		const { probe } = recorded();
		const estimate = vi.fn(async () => ({ usage: 1, quota: 1 }));

		await expect(requestPersistentStorage(() => ({ estimate }) as unknown as PersistentStorageManager, probe)).resolves.toBe('unavailable');
		expect(estimate).not.toHaveBeenCalled();
	});
});
