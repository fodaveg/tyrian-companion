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
