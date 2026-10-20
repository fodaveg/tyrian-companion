import { afterEach, describe, expect, it, vi } from 'vitest';

import { engineIdle, hangTransactions, holdNextCommit, resumeStorage, settlement, trackedIndexedDb } from '../test/indexed-db-connections';
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
		return { fire() { for (const [handle, callback] of [...live]) { live.delete(handle); callback(); } }, get pending() { return live.size; } };
	}

	it('rejects when the transaction never answers, and reads normally once the engine answers again', async () => {
		const tracked = trackedIndexedDb(); const timers = stubTimers();
		hangTransactions(tracked);
		const read = loadCollectorMode(tracked.factory, VAULT, () => 'collector').then(() => 'read', (error: Error) => error.message);
		await engineIdle(tracked);
		expect(timers.pending).toBe(1);
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
		await engineIdle(tracked);
		expect(timers.pending).toBe(1);
		timers.fire();
		await expect(read).resolves.toBe('Collector instance store did not answer.');
		expect(late).not.toHaveBeenCalled();
		answer();
		await engineIdle(tracked);
		expect(late).toHaveBeenCalledWith('consult');
	});

	it('gives the user\'s own write no deadline: it waits for the engine and lands, instead of failing while it can still land', async () => {
		const tracked = trackedIndexedDb(); const timers = stubTimers();
		const answer = holdNextCommit(tracked, () => true);
		const write = saveCollectorMode(tracked.factory, VAULT, 'consult');
		await engineIdle(tracked);
		// A write the user asked for arms no deadline at all.
		expect(timers.pending).toBe(0);
		timers.fire();
		expect(await settlement(write)).toBe('pending');
		answer();
		await expect(write).resolves.toBeUndefined();
		await expect(loadCollectorMode(tracked.factory, VAULT, () => 'collector')).resolves.toBe('consult');
	});

	it('does not run asynchronous discovery when the device already has a mode', async () => {
		const tracked = trackedIndexedDb(); stubTimers();
		await saveCollectorMode(tracked.factory, VAULT, 'collector');
		const seed = vi.fn(async () => 'consult' as const);
		await expect(loadCollectorMode(tracked.factory, VAULT, seed)).resolves.toBe('collector');
		expect(seed).not.toHaveBeenCalled();
	});

	it('a mode explicitly saved during discovery wins over the discovered seed', async () => {
		const tracked = trackedIndexedDb(); stubTimers();
		let finish!: (mode: 'collector') => void;
		const seed = new Promise<'collector'>((resolve) => { finish = resolve; });
		const read = loadCollectorMode(tracked.factory, VAULT, () => seed);
		await engineIdle(tracked);
		await saveCollectorMode(tracked.factory, VAULT, 'consult');
		finish('collector');
		await expect(read).resolves.toBe('consult');
	});

	it('bounds a silent discovery and delivers its eventual decision to the late handler', async () => {
		const tracked = trackedIndexedDb(); const timers = stubTimers();
		let finish!: (mode: 'consult') => void;
		const seed = new Promise<'consult'>((resolve) => { finish = resolve; });
		const late = vi.fn();
		const read = loadCollectorMode(tracked.factory, VAULT, () => seed, late).catch((error: Error) => error.message);
		await engineIdle(tracked);
		timers.fire();
		await expect(read).resolves.toBe('Collector instance store did not answer.');
		expect(late).not.toHaveBeenCalled();
		finish('consult');
		await engineIdle(tracked);
		expect(late).toHaveBeenCalledWith('consult');
	});

	it('keeps the late answer when the transaction that stores discovery itself answers late', async () => {
		const tracked = trackedIndexedDb(); const timers = stubTimers();
		let finish!: (mode: 'consult') => void;
		const seed = new Promise<'consult'>((resolve) => { finish = resolve; });
		const late = vi.fn();
		const read = loadCollectorMode(tracked.factory, VAULT, () => seed, late).catch((error: Error) => error.message);
		await engineIdle(tracked);
		const commit = holdNextCommit(tracked, () => true);
		finish('consult');
		await engineIdle(tracked);
		expect(timers.pending).toBe(1);
		timers.fire();
		await expect(read).resolves.toBe('Collector instance store did not answer.');
		expect(late).not.toHaveBeenCalled();
		commit();
		await engineIdle(tracked);
		expect(late).toHaveBeenCalledWith('consult');
	});
});
