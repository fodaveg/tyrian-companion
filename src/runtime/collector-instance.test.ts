import { afterEach, describe, expect, it, vi } from 'vitest';

import { hangTransactions, macrotasks, resumeStorage, trackedIndexedDb } from '../test/indexed-db-connections';
import { loadCollectorMode } from './collector-instance';

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
});
