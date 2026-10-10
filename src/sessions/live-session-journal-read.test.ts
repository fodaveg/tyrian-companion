import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import {
	NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, livePriceBasisOf,
	type LiveInventorySampleV1, type LiveJournalEntryV1,
} from './live-session-model';
import type { LiveSessionPayloadVersion } from './live-session-note-model';
import type { SessionLeaseCoordinator } from './manual-session-start-service';
import { IndexedDbSessionRuntimeStore, LIVE_SESSION_JOURNAL_STORE_NAME } from './session-runtime-store';
import { isLiveJournalEntry } from './live-session-validation';

/**
 * How the journal of a live session is read back from IndexedDB (`readLiveJournal`): every entry of that session and nothing
 * else, refused whole when one entry does not validate, and in the order of the session whatever order the keys sort in.
 */
const START = Date.parse('2026-10-11T09:00:00.000Z');
const SESSION = 'journal-read-session';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
/** Sorts after `EPOCH` by primary key; used for the entries that were observed FIRST. */
const LATER_KEY_EPOCH = '_____________________w';

let databases = 0;
/** A real session played through the lifecycle and kept in the production store: `samples` seconds, a change every `every`. */
async function playedSession(version: LiveSessionPayloadVersion, samples: number, every: number): Promise<{ factory: IDBFactory; name: string }> {
	const factory = new IDBFactory(); const name = `tyrian-companion-journal-read-${String(++databases)}`;
	const store = new IndexedDbSessionRuntimeStore(factory, name);
	let now = START;
	const handle = (sessionId: string): ActiveSessionLeaseHandle => ({ machineId: 'machine', instanceId: 'host', sessionId, fence: 1,
		acquiredAt: now, renewedAt: now, expiresAt: now + 120_000 });
	const coordinator: SessionLeaseCoordinator = {
		instanceId: 'host',
		acquire: async (sessionId: string) => ({ status: 'acquired' as const, handle: handle(sessionId) }),
		renew: async (prior: ActiveSessionLeaseHandle) => ({ status: 'renewed' as const, handle: { ...prior, renewedAt: now, expiresAt: now + 120_000 } }),
		assertOwned: async () => ({ status: 'owned' as const }),
		release: async () => ({ status: 'released' as const }),
		dispose: () => undefined,
	};
	const lifecycle = new LiveSessionLifecycle({
		coordinator, persistence: store, enabled: () => true, now: () => now, sessionId: () => SESSION, thresholdCopper: () => 50_000,
		sessionFormat: { noteVersion: version, priceBasis: livePriceBasisOf(version) },
		setInterval: () => 1, clearInterval: () => undefined, onStateChange: () => undefined,
		onError: (error) => { throw error instanceof Error ? error : new Error(String(error)); },
	});
	const source = { sourceInstance: 'AQEBAQEBAQEBAQEBAQEBAQ', epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay' as const, mapId: 866, character: 'Reader' } };
	const quantities = [50, 50, 50];
	const sampleAt = (cursor: number): LiveInventorySampleV1 => ({
		...source, cursor, contextSeq: 0, sourceElapsedMs: cursor * 1000, mode: cursor === 0 ? 'baseline' : 'sample',
		itemCoverage: 'complete', currencyCoverage: 'none', unknownPositions: 0, freeSlots: null,
		rows: quantities.map((quantity, index) => ({ kind: 'item' as const, idNumber: 12_000 + index, quantity })),
		observedAt: new Date(now).toISOString(),
	});
	expect(await lifecycle.start('Reader')).not.toBeNull();
	expect(await lifecycle.open(source)).toBe('ready');
	expect(await lifecycle.commit(sampleAt(0))).toBe('stored');
	for (let cursor = 1; cursor <= samples; cursor += 1) {
		now = START + cursor * 1000;
		if (cursor % every === 0) quantities[cursor % quantities.length]! += 1 + (cursor % 3);
		expect(await lifecycle.commit(sampleAt(cursor))).toBe('stored');
	}
	await lifecycle.dispose(); store.close();
	return { factory, name };
}

function openRaw(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name);
		request.onsuccess = () => { resolve(request.result); };
		request.onerror = () => { reject(request.error ?? new Error('open failed')); };
	});
}
async function rawEntries(database: IDBDatabase): Promise<LiveJournalEntryV1[]> {
	return await new Promise((resolve, reject) => {
		const request = database.transaction(LIVE_SESSION_JOURNAL_STORE_NAME, 'readonly').objectStore(LIVE_SESSION_JOURNAL_STORE_NAME).getAll();
		request.onsuccess = () => { resolve(request.result as LiveJournalEntryV1[]); };
		request.onerror = () => { reject(request.error ?? new Error('read failed')); };
	});
}
async function rewrite(database: IDBDatabase, change: (store: IDBObjectStore) => void): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction(LIVE_SESSION_JOURNAL_STORE_NAME, 'readwrite');
		change(transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME));
		transaction.oncomplete = () => { resolve(); };
		transaction.onerror = transaction.onabort = () => { reject(transaction.error ?? new Error('write failed')); };
	});
}
/** The read as it was done up to 0.6.37: the session index walked with a cursor, one clone per entry, then sorted. */
async function readWithCursor(database: IDBDatabase, sessionId: string): Promise<LiveJournalEntryV1[]> {
	return await new Promise((resolve, reject) => {
		const transaction = database.transaction(LIVE_SESSION_JOURNAL_STORE_NAME, 'readonly');
		const request = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME).index('session').openCursor(sessionId);
		const result: LiveJournalEntryV1[] = [];
		request.onsuccess = () => {
			const cursor = request.result; if (!cursor) return;
			result.push(structuredClone(cursor.value as LiveJournalEntryV1)); cursor.continue();
		};
		transaction.oncomplete = () => { resolve(result.sort((left, right) => left.observedAt.localeCompare(right.observedAt)
			|| left.epoch.localeCompare(right.epoch) || left.cursor - right.cursor)); };
		transaction.onerror = transaction.onabort = () => { reject(transaction.error ?? new Error('read failed')); };
	});
}

describe('reading a live session journal back from IndexedDB', () => {
	it('refuses the whole journal when one stored entry does not validate', async () => {
		const { factory, name } = await playedSession(1, 20, 4);
		const database = await openRaw(factory, name);
		const entries = await rawEntries(database);
		const broken = entries[7]!;
		await rewrite(database, (store) => { store.put({ ...broken, observations: 'broken' }, [broken.sessionId, broken.epoch, broken.cursor]); });
		database.close();

		const store = new IndexedDbSessionRuntimeStore(factory, name);
		await expect(store.readLiveJournal(SESSION)).rejects.toThrow('Live session journal is unavailable.');
		store.close();
	});

	it('returns the entries in the order they were observed, not in the order their keys sort, and only this session', async () => {
		const { factory, name } = await playedSession(1, 20, 4);
		const database = await openRaw(factory, name);
		const entries = await rawEntries(database);
		const firstHalf = entries.filter((entry) => entry.cursor < 10);
		// The first half moves under an epoch whose key sorts after every other: by key it now comes LAST.
		// The epoch is in the entry, in each observation and in the ids built from them: all of it moves. The alert outbox, whose
		// ids are digests of the old ones, is left empty (an entry may owe no alert).
		const moved = firstHalf.map((entry) => ({ ...JSON.parse(JSON.stringify(entry).replaceAll(EPOCH, LATER_KEY_EPOCH)) as LiveJournalEntryV1, outbox: [] }));
		const stranger = { ...entries[3]!, sessionId: 'another-session', outbox: [] };
		expect(moved.flatMap((entry) => isLiveJournalEntry(entry as unknown) ? [] : [entry.cursor])).toEqual([]);
		await rewrite(database, (store) => {
			for (const entry of firstHalf) store.delete([entry.sessionId, entry.epoch, entry.cursor]);
			for (const entry of moved) store.put(entry, [entry.sessionId, entry.epoch, entry.cursor]);
			store.put(stranger, [stranger.sessionId, stranger.epoch, stranger.cursor]);
		});
		const byKey = (await rawEntries(database)).filter((entry) => entry.sessionId === SESSION);
		database.close();
		// The premise: by primary key the store hands the moved entries back after the others.
		expect(byKey.map((entry) => entry.cursor)).toEqual([...Array.from({ length: 11 }, (_, index) => index + 10), ...Array.from({ length: 10 }, (_, index) => index)]);

		const store = new IndexedDbSessionRuntimeStore(factory, name);
		const read = await store.readLiveJournal(SESSION);
		store.close();
		expect(read.map((entry) => entry.cursor)).toEqual(Array.from({ length: 21 }, (_, index) => index));
		expect(read.map((entry) => entry.observedAt)).toEqual([...read.map((entry) => entry.observedAt)].sort());
		expect(read.every((entry) => entry.sessionId === SESSION)).toBe(true);
	});

	it.each([
		{ version: 1 as const, samples: 240, every: 7 },
		{ version: 2 as const, samples: 240, every: 7 },
	])('reads exactly what the cursor read did, note format $version', async ({ version, samples, every }) => {
		const { factory, name } = await playedSession(version, samples, every);
		const database = await openRaw(factory, name);
		const reference = await readWithCursor(database, SESSION);
		database.close();
		// Format 1 keeps every sample; format 2 only the baseline and the samples that changed something.
		expect(reference).toHaveLength(version === 1 ? samples + 1 : 1 + Math.floor(samples / every));

		const store = new IndexedDbSessionRuntimeStore(factory, name);
		const read = await store.readLiveJournal(SESSION);
		store.close();
		expect(read).toEqual(reference);
	});
});
