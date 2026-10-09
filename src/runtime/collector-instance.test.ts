import { afterEach, describe, expect, it, vi } from 'vitest';

import { hangTransactions, holdNextCommit, macrotasks, resumeStorage, settlement, trackedIndexedDb } from '../test/indexed-db-connections';
import { loadCollectorMode, saveCollectorMode } from './collector-instance';

const VAULT = 'a'.repeat(64);

// 9 Oct 2026 (Z3): the plugin does not start until the collector mode is read, and a transaction the engine takes and never
// answers settled nothing. The wait ends as a failed read does, and the caller falls back to its seed.
describe('the collector mode read against an engine that does not answer', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	function stubTimers() {
		const live = new Map<number, () => void>(); let next = 0;
		vi.stubGlobal('window', {
			setTimeout: (callback: () => void) => { live.set(++next, callback); return next; },
			clearTimeout: (handle: number) => { live.delete(handle); },
		});
		return { fire() { for (const [handle, callback] of [...live]) { live.delete(handle); callback(); } } };
	}

	it('rejects when the transaction never answers, and reads normally once the engine answers again', async () => {
		const tracked = trackedIndexedDb(); const timers = stubTimers();
		hangTransactions(tracked);
		const read = loadCollectorMode(tracked.factory, VAULT, () => 'collector').then(() => 'read', (error: Error) => error.message);
		await macrotasks();
		timers.fire();
		await expect(read).resolves.toBe('Collector instance store did not answer.');

		resumeStorage(tracked);
		await expect(loadCollectorMode(tracked.factory, VAULT, () => 'collector')).resolves.toBe('collector');
	});

	it('hands a read that answers after the deadline to its late handler, with the value the device saved', async () => {
		const tracked = trackedIndexedDb(); const timers = stubTimers();
		await saveCollectorMode(tracked.factory, VAULT, 'consult');
		const answer = holdNextCommit(tracked, () => true);
		const late = vi.fn();
		const read = loadCollectorMode(tracked.factory, VAULT, () => 'collector', late).then(() => 'read', (error: Error) => error.message);
		await macrotasks();
		timers.fire();
		await expect(read).resolves.toBe('Collector instance store did not answer.');
		expect(late).not.toHaveBeenCalled();
		answer();
		await macrotasks();
		expect(late).toHaveBeenCalledWith('consult');
	});

	it('gives the user\'s own write no deadline: it waits for the engine and lands, instead of failing while it can still land', async () => {
		const tracked = trackedIndexedDb(); const timers = stubTimers();
		const answer = holdNextCommit(tracked, () => true);
		const write = saveCollectorMode(tracked.factory, VAULT, 'consult');
		await macrotasks();
		timers.fire();
		expect(await settlement(write)).toBe('pending');
		answer();
		await expect(write).resolves.toBeUndefined();
		await expect(loadCollectorMode(tracked.factory, VAULT, () => 'collector')).resolves.toBe('consult');
	});
});
