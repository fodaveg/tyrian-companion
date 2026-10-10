import { IDBDatabase as FakeIDBDatabase } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startAlertIngameServer } from '../alerts/alert-ingame-server';
import type { TyrianTcpConnection } from '../host/tyrian-host';
import { fakeLocks, type FakeLockContext, type FakeLocks } from '../test/fake-lock-manager';
import { engineIdle, hangStorage, holdNextCommitAnswer, killStorage, killStorageAfterNextCommit, resumeStorage, reviveStorage, settlement, trackedIndexedDb } from '../test/indexed-db-connections';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveAlertOutboxV1, type LiveInventoryRowV1, type LiveInventorySampleV1, type LiveJournalEntryV1 } from './live-session-model';
import { decideLiveAlert } from './live-session-outbox';
import { liveObservationTotals } from './live-session-reducer';
import { IndexedDbSessionRuntimeStore } from './session-runtime-store';

/**
 * 7 Oct 2026, Fedora, plugin 0.6.5 in Hebra: the web engine stopped answering IndexedDB with the
 * plugin's JavaScript alive. The live session went to `error` and stayed there after the engine
 * came back, and nothing it could not write was ever written.
 *
 * Everything here runs on the production stores (session record, journal and lease) over a fake
 * IndexedDB whose connections are killed and brought back, because the hole this covers is in the
 * seam between the lifecycle and the stores, not inside either.
 */
const INSTANCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const EPOCH = 'AgICAgICAgICAgICAgICAg';
const NEXT_EPOCH = 'AwMDAwMDAwMDAwMDAwMDAw';
const AT = Date.parse('2026-10-07T14:54:00.000Z');
const LEASE_TTL_MS = 300_000;
const iso = (offsetMs: number): string => new Date(AT + offsetMs).toISOString();

/**
 * `locks`: the lock manager every host of this fixture shares, each through a context of its own (absent: none has
 * one, as on a host without the API). `leaseTtlMs`: the lease the first host's lifecycle asks for instead of its own.
 */
function outage(label: string, setup: { locks?: FakeLocks; leaseTtlMs?: number } = {}) {
	const tracked = trackedIndexedDb();
	let now = AT; let beat: (() => void) | null = null;
	const contexts = new Map<string, FakeLockContext>();
	// Every wait on storage in course, of the lifecycle and of the lease coordinator alike. None runs out by
	// itself: a test that never calls `timeout()` waits without bound, as before there was a bound.
	const waits = new Map<number, () => void>(); let lastWait = 0;
	const arm = (callback: () => void): number => { waits.set(++lastWait, callback); return lastWait; };
	const disarm = (handle: unknown): void => { waits.delete(handle as number); };
	const store = new IndexedDbSessionRuntimeStore(tracked.factory, `live-outage-${label}`);
	const lease = (instanceId: string, registry: FakeLocks | undefined = setup.locks): ActiveSessionLeaseCoordinator => {
		const context = registry?.context();
		if (context) contexts.set(instanceId, context);
		return new ActiveSessionLeaseCoordinator({
			indexedDb: tracked.factory, databaseName: `live-outage-${label}-lease`, instanceId, machineId: () => 'machine',
			clock: () => now, sleep: async () => undefined, leaseTtlMs: LEASE_TTL_MS, expiryConfirmDelayMs: 1, schedule: arm, cancel: disarm,
			...(context ? { locks: context } : {}),
		});
	};
	const onError = vi.fn(); const onCommitted = vi.fn(); const onComplete = vi.fn(async () => 'Sessions/live.md');
	const options = { coordinator: lease('host'), persistence: store, enabled: () => true, now: () => now, sessionId: () => 'session',
		thresholdCopper: () => 1, setInterval: (callback: () => void) => { beat = callback; return 1; }, clearInterval: () => { beat = null; },
		setTimeout: arm, clearTimeout: disarm, onStateChange: vi.fn(), onError, onCommitted, onComplete,
		...(setup.leaseTtlMs === undefined ? {} : { leaseTtlMs: setup.leaseTtlMs }) };
	const service = new LiveSessionLifecycle(options);
	const source = { sourceInstance: INSTANCE, epoch: EPOCH, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE,
		context: { state: 'gameplay' as const, mapId: 866, character: 'Test' } };
	/** A complete sample received now; `elapsedMs` is the producer's own clock for it. */
	const sample = (cursor: number, elapsedMs: number, rows: LiveInventoryRowV1[], epoch = EPOCH): LiveInventorySampleV1 => ({ ...source, epoch,
		cursor, contextSeq: 0, sourceElapsedMs: elapsedMs, mode: cursor === 0 ? 'baseline' : 'sample', itemCoverage: 'complete',
		currencyCoverage: rows.some((row) => row.kind === 'currency') ? 'listed' : 'none', unknownPositions: 0, freeSlots: null, rows,
		observedAt: new Date(now).toISOString() });
	return { tracked, store, lease, options, service, source, sample, onError,
		at: (offsetMs: number) => { now = AT + offsetMs; },
		/** The first host's process is gone, with nothing released and nothing disposed of: the engine frees the lock it held. */
		hostDies: () => { contexts.get('host')?.die(); },
		/**
		 * Counts the transactions that write started on the lease's database from here on (call it before the first
		 * one). It spies on the fake engine itself, so whoever calls it restores the spies when its test ends.
		 */
		countLeaseWrites: (): (() => number) => {
			const started = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');
			return () => started.mock.calls.filter(([, mode], call) => mode === 'readwrite'
				&& (started.mock.contexts[call] as IDBDatabase).name === `live-outage-${label}-lease`).length;
		},
		/** The engine applies the next write of the session store and dies before saying so. */
		dieAfterNextCommit: () => { killStorageAfterNextCommit(tracked, `live-outage-${label}`); },
		/**
		 * Another host starting on what is on disk now, as the next launch of the plugin would. `registry` gives it a lock
		 * manager that shares nothing with the first host's: two processes of an engine that keeps its locks per process.
		 */
		restarted: (registry?: FakeLocks) => {
			const persistence = new IndexedDbSessionRuntimeStore(tracked.factory, `live-outage-${label}`); const failed = vi.fn();
			let nextBeat: (() => void) | null = null;
			// A session this host starts itself gets an id of its own, as every real one does.
			const next = new LiveSessionLifecycle({ ...options, coordinator: lease('next-host', registry ?? setup.locks), persistence, onError: failed, sessionId: () => 'next-session',
				setInterval: (callback: () => void) => { nextBeat = callback; return 1; }, clearInterval: () => { nextBeat = null; } });
			return { service: next, store: persistence, onError: failed, dispose: async () => { await next.dispose(); persistence.close(); },
				/** Whether this host armed a heartbeat at all. */
				beats: () => nextBeat !== null,
				beat: async () => { nextBeat?.(); await next.capture(); } };
		},
		/** One heartbeat, awaited through the lifecycle's own queue. */
		beat: async () => { beat?.(); await service.capture(); },
		/** The interval fires and nobody waits for what it queued. */
		tick: () => { beat?.(); },
		/** Every call to storage still unanswered runs out of time, and whoever waited for it goes on. */
		timeout: async () => {
			const pending = [...waits.values()]; waits.clear();
			for (const expire of pending) expire();
			await turns();
		},
		/** How many calls to storage are being waited for right now. */
		waiting: () => waits.size,
		/** The engine applies the next write of the session store and answers it only when the returned function is called. */
		answerNextCommitLate: () => holdNextCommitAnswer(tracked, `live-outage-${label}`),
		/** What a host starting now would find on disk, read through a connection of its own. */
		durable: async () => {
			const reader = new IndexedDbSessionRuntimeStore(tracked.factory, `live-outage-${label}`);
			const loaded = await reader.loadLive(); const journal = await reader.readLiveJournal('session'); reader.close();
			if (loaded.status !== 'loaded') throw new Error(`Expected a stored live session, found ${loaded.status}.`);
			return { record: loaded.record, journal };
		} };
}
/** Lets everything that can go on without a timer or the engine go on: what is still pending after this is waiting for one of them. */
async function turns(): Promise<void> {
	for (let turn = 0; turn < 64; turn += 1) await Promise.resolve();
}
/** The epoch a producer opens after `index - 1` others: a distinct 16-byte id for each. */
const epochOf = (index: number): string => {
	const bytes = new Uint8Array(16).fill(index & 255); bytes[0] = index >> 8;
	return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};
const bags = (quantity: number): LiveInventoryRowV1[] => [{ kind: 'item', idNumber: 12147, quantity }];
const bagsAndGold = (quantity: number, copper: number): LiveInventoryRowV1[] => [...bags(quantity), { kind: 'currency', idNumber: 1, quantity: copper }];
const storageGaps = (service: LiveSessionLifecycle) => service.getView().gaps.filter((gap) => gap.reason === 'storage_unavailable');

describe('live session across a storage outage', () => {
	it('active, storage dies, three samples are not stored, storage returns: the next sample is a baseline behind one gap', async () => {
		const f = outage('end-to-end');
		await f.service.start('Test'); await expect(f.service.open(f.source)).resolves.toBe('ready');
		await expect(f.service.commit(f.sample(0, 0, bags(5)))).resolves.toBe('stored');
		f.at(1000); await expect(f.service.commit(f.sample(1, 1000, bags(7)))).resolves.toBe('stored');
		expect(f.service.getView()).toMatchObject({ phase: 'active', observationCount: 1, observedItemsMs: 1000 });

		killStorage(f.tracked);
		const opens = vi.spyOn(f.tracked.factory, 'open');
		// The producer never got `stored` for cursor 2, so it is cursor 2 it sends again, each time
		// with what the bags hold by then.
		f.at(2000); await expect(f.service.commit(f.sample(2, 2000, bags(20)))).resolves.toBe('storage_unavailable');
		f.at(3000); await expect(f.service.commit(f.sample(2, 3000, bags(30)))).resolves.toBe('storage_unavailable');
		f.at(4000); await expect(f.service.commit(f.sample(2, 4000, bags(40)))).resolves.toBe('storage_unavailable');
		// One reopen per operation, no loop: three refused samples, three opens.
		expect(opens).toHaveBeenCalledTimes(3);
		// Nothing that was not stored is shown as stored.
		expect(f.service.getView()).toMatchObject({ phase: 'error', observationCount: 1, observedItemsMs: 1000 });
		expect(f.service.getRuntime()?.lastSample).toMatchObject({ cursor: 1 });
		expect(f.service.getJournal().map((entry) => entry.cursor)).toEqual([0, 1]);

		reviveStorage(f.tracked);
		f.at(5000); await expect(f.service.commit(f.sample(2, 5000, bags(50)))).resolves.toBe('stored');
		const view = f.service.getView();
		expect(view.phase).toBe('active');
		// ONE gap, from the last capture that was stored to the first one stored afterwards.
		expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(1000), toAt: iso(5000), channels: ['items'] }]);
		// The 43 bags that arrived inside the gap are not an acquisition: 7 -> 50 crosses it.
		expect(view.observations.map((row) => [row.cursor, row.delta])).toEqual([[1, 2]]);
		expect(view.totals).toEqual([{ kind: 'item', idNumber: 12147, positive: 2, negative: 0, net: 2 }]);
		// And the four seconds of the gap are not observed time.
		expect(view.observedItemsMs).toBe(1000);

		// The sample after the baseline is measured against the baseline, and its second counts.
		f.at(6000); await expect(f.service.commit(f.sample(3, 6000, bags(53)))).resolves.toBe('stored');
		expect(f.service.getView().observations.map((row) => [row.cursor, row.before, row.after, row.delta])).toEqual([[1, 5, 7, 2], [3, 50, 53, 3]]);
		expect(f.service.getView().observedItemsMs).toBe(2000);

		// The journal on disk agrees with the counter on disk, so a restart can load it.
		const durable = await f.durable();
		const stored = durable.journal.flatMap((entry) => entry.observations);
		expect(durable.journal.map((entry) => entry.cursor)).toEqual([0, 1, 2, 3]);
		expect(stored).toHaveLength(durable.record.observationCount);
		expect(liveObservationTotals([], stored)).toEqual(durable.record.totals);
		expect(durable.record.gaps.filter((gap) => gap.reason === 'storage_unavailable')).toEqual(storageGaps(f.service));
		// The outage is reported to diagnostics once, not once per refused sample, and nothing else failed.
		expect(f.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session storage is unavailable.']);
		await f.service.dispose();
	});

	it('opens the gap on every channel that had a baseline, and no currency delta crosses it either', async () => {
		const f = outage('currencies');
		await f.service.start('Test'); await f.service.open(f.source);
		await f.service.commit(f.sample(0, 0, bagsAndGold(5, 100)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bagsAndGold(5, 150)));
		killStorage(f.tracked);
		f.at(2000); await expect(f.service.commit(f.sample(2, 2000, bagsAndGold(9, 900)))).resolves.toBe('storage_unavailable');
		reviveStorage(f.tracked);
		f.at(3000); await expect(f.service.commit(f.sample(2, 3000, bagsAndGold(9, 900)))).resolves.toBe('stored');

		expect(storageGaps(f.service)).toEqual([
			{ version: 1, reason: 'storage_unavailable', fromAt: iso(1000), toAt: iso(3000), channels: ['items'] },
			{ version: 1, reason: 'storage_unavailable', fromAt: iso(1000), toAt: iso(3000), channels: ['currencies'] },
		]);
		expect(f.service.getView()).toMatchObject({ phase: 'active', observedItemsMs: 1000, observedCurrenciesMs: 1000 });
		expect(f.service.getView().observations.map((row) => [row.kind, row.delta])).toEqual([['currency', 50]]);
		await f.service.dispose();
	});

	it('the heartbeat alone brings a quiet session back, and keeps the lease it could not renew', async () => {
		const f = outage('heartbeat');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		killStorage(f.tracked);
		f.at(5000); await f.beat();
		expect(f.service.getView().phase).toBe('error');
		f.at(6000); await expect(f.service.commit(f.sample(1, 6000, bags(9)))).resolves.toBe('storage_unavailable');
		f.at(10_000); await f.beat();
		expect(f.service.getView().phase).toBe('error');

		reviveStorage(f.tracked);
		f.at(15_000); await f.beat();
		// Back to active with no sample: the gap is recorded open, and the lease is the same one.
		expect(f.service.getView().phase).toBe('active');
		expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(0), toAt: null, channels: ['items'] }]);
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 1 }, connection: 'connected', lastSourceDisconnectedAt: null });
		expect((await f.durable()).record.gaps).toEqual(f.service.getView().gaps);

		f.at(16_000); await expect(f.service.commit(f.sample(1, 16_000, bags(9)))).resolves.toBe('stored');
		expect(storageGaps(f.service)).toMatchObject([{ fromAt: iso(0), toAt: iso(16_000) }]);
		expect(f.service.getView()).toMatchObject({ observationCount: 0, observedItemsMs: 0 });
		await f.service.dispose();
	});

	it('what the bridge reported during the outage is written when storage returns: the ended epoch, the disconnection and the presence', async () => {
		const f = outage('deferred');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		killStorage(f.tracked);
		f.at(2000);
		// None of these may throw: the bridge holds the producer's slot until its gap is taken.
		await expect(f.service.gap({ sourceInstance: INSTANCE, epoch: EPOCH, reason: 'disconnect', observedAt: iso(2000) })).resolves.toBeUndefined();
		await expect(f.service.presence(false, AT + 2000)).resolves.toBeUndefined();
		expect(f.service.getRuntime()).toMatchObject({ epoch: EPOCH, connection: 'connected', lastSourceDisconnectedAt: null });
		expect(f.service.getView().phase).toBe('error');

		reviveStorage(f.tracked);
		f.at(20_000); await f.beat();
		expect(f.service.getView().phase).toBe('active');
		expect(f.service.getRuntime()).toMatchObject({ epoch: null, lastSample: null, connection: 'disconnected',
			lastPresenceAt: AT + 2000, lastSourceDisconnectedAt: iso(2000) });
		// The first cause is kept: the producer left before any sample was refused.
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason: 'disconnect', fromAt: iso(0), toAt: null, channels: ['items'] }]);
		expect((await f.durable()).record).toEqual(f.service.getRuntime());

		// The ended epoch does not come back: its next sample is refused, a new epoch starts over.
		f.at(21_000); await expect(f.service.commit(f.sample(1, 21_000, bags(9)))).resolves.toBe('not_owner');
		await expect(f.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		await expect(f.service.commit(f.sample(0, 0, bags(9), NEXT_EPOCH))).resolves.toBe('stored');
		expect(f.service.getView()).toMatchObject({ observationCount: 0, observedItemsMs: 0 });
		await f.service.dispose();
	});

	it('a lease that expired during the outage and nobody took is reclaimed, as an outage and not as a restart', async () => {
		const f = outage('expired');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		killStorage(f.tracked);
		f.at(1000); await expect(f.service.commit(f.sample(1, 1000, bags(8)))).resolves.toBe('storage_unavailable');
		reviveStorage(f.tracked);
		f.at(LEASE_TTL_MS + 5000); await f.beat();
		expect(f.service.getView().phase).toBe('error');
		f.at(LEASE_TTL_MS + 10_000); await f.beat();

		expect(f.service.getView().phase).toBe('active');
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 2 }, epoch: null, connection: 'connected', lastSourceDisconnectedAt: null });
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(0), toAt: null, channels: ['items'] }]);
		await expect(f.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		f.at(LEASE_TTL_MS + 11_000); await expect(f.service.commit(f.sample(0, 0, bags(30), NEXT_EPOCH))).resolves.toBe('stored');
		expect(f.service.getView()).toMatchObject({ phase: 'active', observationCount: 0, observedItemsMs: 0 });
		expect(f.onError).toHaveBeenCalledTimes(1);
		await f.service.dispose();
	});

	it.each([
		['the save', (f: ReturnType<typeof outage>) => vi.spyOn(f.store, 'saveLive').mockResolvedValueOnce({ status: 'error', code: 'unavailable' })],
		['the re-read', (f: ReturnType<typeof outage>) => vi.spyOn(f.store, 'loadLive').mockResolvedValueOnce({ status: 'error', code: 'unavailable' })],
	] as const)('a reclaim that fails at %s is still the same outage on the next beat, not a restart', async (_step, failOnce) => {
		const f = outage(`reclaim-twice-${_step.replace(/\W/gu, '-')}`);
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		killStorage(f.tracked);
		f.at(1000); await expect(f.service.commit(f.sample(1, 1000, bags(8)))).resolves.toBe('storage_unavailable');
		// The producer is still there, and says so while nothing can be written.
		f.at(2000); await f.service.presence(true, AT + 2000);
		reviveStorage(f.tracked);
		f.at(LEASE_TTL_MS + 5000); await f.beat();
		// The lease is taken again under a new fence, and storage refuses once more before the session is saved under it.
		const refused = failOnce(f);
		f.at(LEASE_TTL_MS + 10_000); await f.beat();
		expect(refused).toHaveBeenCalledTimes(1);
		expect(f.service.getView().phase).toBe('error');
		expect((await f.durable()).record).toMatchObject({ authority: { fence: 1 }, epoch: EPOCH });

		f.at(LEASE_TTL_MS + 15_000); await f.beat();
		expect(f.service.getView().phase).toBe('active');
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(0), toAt: null, channels: ['items'] }]);
		// No disconnection is made up, and the presence that could not be written is.
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 2 }, epoch: null, connection: 'connected',
			lastSourceDisconnectedAt: null, lastPresenceAt: AT + 2000 });
		expect((await f.durable()).record).toEqual(f.service.getRuntime());
		await f.service.dispose();
	});

	it('a lease found under a new fence is read again even when the attempt that took it failed before saving', async () => {
		const f = outage('fence-after-failed-attempt');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		killStorage(f.tracked);
		f.at(2000); await expect(f.service.commit(f.sample(2, 2000, bags(9)))).resolves.toBe('storage_unavailable');
		reviveStorage(f.tracked);
		// Another host takes the expired lease, stores an observation of its own and lets the lease go.
		f.at(LEASE_TTL_MS + 5000);
		const other = f.restarted(); await other.service.initialize();
		await expect(other.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		await expect(other.service.commit(f.sample(0, 0, bags(20), NEXT_EPOCH))).resolves.toBe('stored');
		f.at(LEASE_TTL_MS + 6000); await expect(other.service.commit(f.sample(1, 1000, bags(24), NEXT_EPOCH))).resolves.toBe('stored');
		await other.dispose();

		f.at(LEASE_TTL_MS + 10_000); await f.beat();
		// This host takes the lease back under a third fence and cannot confirm it: the attempt ends there.
		const asserted = vi.spyOn(f.options.coordinator, 'assertOwned').mockResolvedValueOnce({ status: 'error', code: 'unavailable' });
		f.at(LEASE_TTL_MS + 15_000); await f.beat();
		expect(asserted).toHaveBeenCalledTimes(1);
		// The next attempt is told `already_owned`. What the other host wrote is still read before anything is saved.
		f.at(LEASE_TTL_MS + 20_000); await f.beat();
		expect(f.service.getView().phase).toBe('active');
		expect(f.service.getView().observations.map((row) => [row.epoch, row.before, row.after, row.delta])).toEqual([[EPOCH, 5, 7, 2], [NEXT_EPOCH, 20, 24, 4]]);
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 3 }, epoch: null, observationCount: 2 });
		const durable = await f.durable();
		expect(durable.record).toEqual(f.service.getRuntime());
		expect(durable.journal.flatMap((entry) => entry.observations)).toHaveLength(durable.record.observationCount);
		await f.service.dispose();
	});

	it('a lease another owner took during the outage is not stepped on', async () => {
		const f = outage('taken');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		const before = await f.durable();
		killStorage(f.tracked);
		f.at(1000); await expect(f.service.commit(f.sample(1, 1000, bags(8)))).resolves.toBe('storage_unavailable');
		reviveStorage(f.tracked);
		f.at(LEASE_TTL_MS + 5000);
		const other = f.lease('other-host');
		await expect(other.acquire('session')).resolves.toMatchObject({ status: 'acquired', handle: { instanceId: 'other-host', fence: 2 } });

		await f.beat(); await f.beat();
		f.at(LEASE_TTL_MS + 6000);
		await expect(f.service.commit(f.sample(1, LEASE_TTL_MS + 6000, bags(8)))).resolves.toBe('not_owner');
		expect(f.service.getView().phase).toBe('error');
		expect(await f.durable()).toEqual(before);
		other.dispose(); await f.service.dispose();
	});
});

/**
 * The other way storage fails: the engine applies the commit and dies before answering. The host is
 * told the sample was not stored and keeps the state from before it, while disk holds the record and
 * the journal entry of that sample.
 */
describe('live session across a storage outage that hid a commit already on disk', () => {
	/** Cursor 2 (three bags more) lands on disk at 2 s and is answered as not stored. */
	async function landed(label: string) {
		const f = outage(label);
		await f.service.start('Test'); await expect(f.service.open(f.source)).resolves.toBe('ready');
		await expect(f.service.commit(f.sample(0, 0, bags(5)))).resolves.toBe('stored');
		f.at(1000); await expect(f.service.commit(f.sample(1, 1000, bags(7)))).resolves.toBe('stored');
		f.dieAfterNextCommit();
		f.at(2000); await expect(f.service.commit(f.sample(2, 2000, bags(10)))).resolves.toBe('storage_unavailable');
		// What the host knows is still the state before that sample.
		expect(f.service.getView()).toMatchObject({ phase: 'error', observationCount: 1, observedItemsMs: 1000 });
		expect(f.service.getRuntime()?.lastSample).toMatchObject({ cursor: 1 });
		return f;
	}
	/** Disk is one sample ahead of the host: this is the state the recovery starts from. */
	async function expectDiskAhead(f: Awaited<ReturnType<typeof landed>>): Promise<void> {
		const durable = await f.durable();
		expect(durable.journal.map((entry) => entry.cursor)).toEqual([0, 1, 2]);
		expect(durable.record).toMatchObject({ observationCount: 2, lastSample: { cursor: 2 } });
	}
	async function expectDiskConsistent(f: Awaited<ReturnType<typeof landed>>): Promise<void> {
		const durable = await f.durable();
		const stored = durable.journal.flatMap((entry) => entry.observations);
		expect(stored).toHaveLength(durable.record.observationCount);
		expect(liveObservationTotals([], stored)).toEqual(durable.record.totals);
	}

	it('the recovery does not write the older state over it: journal and counter agree, and the next start loads the session', async () => {
		const f = await landed('landed-restart');
		// The bridge ends the epoch of a sample that was not stored; storage is still down for that.
		await expect(f.service.gap({ sourceInstance: INSTANCE, epoch: EPOCH, reason: 'storage_unavailable', observedAt: iso(2000) })).resolves.toBeUndefined();
		reviveStorage(f.tracked);
		await expectDiskAhead(f);

		f.at(10_000); await f.beat();
		expect(f.service.getView().phase).toBe('active');

		// A journal entry the stored counters leave out is what no later start can load.
		const next = f.restarted();
		await expect(next.service.initialize()).resolves.toBeUndefined();
		expect(next.onError).not.toHaveBeenCalled();
		expect(next.service.getView()).toMatchObject({ observationCount: 2, observedItemsMs: 2000 });
		await expectDiskConsistent(f);
		expect((await f.durable()).record).toEqual(f.service.getRuntime());
		await next.dispose(); await f.service.dispose();
	});

	it('the observation that landed is counted once, its alert is published, and no delta crosses the gap that follows it', async () => {
		const f = await landed('landed-observation');
		await f.service.gap({ sourceInstance: INSTANCE, epoch: EPOCH, reason: 'storage_unavailable', observedAt: iso(2000) });
		reviveStorage(f.tracked);
		await expectDiskAhead(f);
		f.at(10_000); await f.beat();

		const view = f.service.getView();
		expect(view.observations.map((row) => [row.cursor, row.before, row.after, row.delta])).toEqual([[1, 5, 7, 2], [2, 7, 10, 3]]);
		expect(view.totals).toEqual([{ kind: 'item', idNumber: 12147, positive: 5, negative: 0, net: 5 }]);
		expect(view.observedItemsMs).toBe(2000);
		// The entry the host never saw stored reaches the consumers of committed entries, once.
		expect(f.options.onCommitted.mock.calls.map(([entry]) => (entry as LiveJournalEntryV1).cursor)).toEqual([0, 1, 2]);
		// The gap starts at the last capture that IS on disk, which is the one answered as not stored.
		expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(2000), toAt: null, channels: ['items'] }]);

		// Thirty bags arrive while nobody observes; the new epoch starts over from its own baseline.
		await expect(f.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		f.at(11_000); await expect(f.service.commit(f.sample(0, 0, bags(40), NEXT_EPOCH))).resolves.toBe('stored');
		f.at(12_000); await expect(f.service.commit(f.sample(1, 1000, bags(43), NEXT_EPOCH))).resolves.toBe('stored');
		expect(f.service.getView().observations.map((row) => [row.before, row.after, row.delta])).toEqual([[5, 7, 2], [7, 10, 3], [40, 43, 3]]);
		expect(f.service.getView().observedItemsMs).toBe(3000);
		expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(2000), toAt: iso(11_000), channels: ['items'] }]);
		await expectDiskConsistent(f);
		await f.service.dispose();
	});

	it('the same sample sent again is answered as stored, without being counted twice', async () => {
		const f = await landed('landed-resent');
		reviveStorage(f.tracked);
		await expectDiskAhead(f);

		// No heartbeat in between: it is this commit that finds storage back.
		f.at(3000); await expect(f.service.commit(f.sample(2, 2000, bags(10)))).resolves.toBe('stored');
		expect(f.service.getView()).toMatchObject({ phase: 'active', observationCount: 2, observedItemsMs: 2000 });
		expect(f.service.getView().observations.map((row) => [row.cursor, row.delta])).toEqual([[1, 2], [2, 3]]);
		expect(f.service.getJournal().map((entry) => entry.cursor)).toEqual([0, 1, 2]);
		// The host cannot tell what it missed while storage was refusing, so the next sample is a baseline.
		f.at(4000); await expect(f.service.commit(f.sample(3, 3000, bags(25)))).resolves.toBe('stored');
		expect(f.service.getView()).toMatchObject({ observationCount: 2, observedItemsMs: 2000 });
		expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(2000), toAt: iso(4000), channels: ['items'] }]);
		await expectDiskConsistent(f);
		await f.service.dispose();
	});

	it('a reclaim under the same lease does not write the older state over it either', async () => {
		const f = await landed('landed-reclaim');
		reviveStorage(f.tracked);
		await expectDiskAhead(f);
		// The lease is still this host's, but one renewal fails for a reason that is not storage, so
		// it is the reclaim and not a queued operation that writes first.
		vi.spyOn(f.options.coordinator, 'renew').mockResolvedValueOnce({ status: 'error', code: 'clock_anomaly' });
		f.at(5000); await f.beat();
		expect(f.service.getView().phase).toBe('error');
		f.at(10_000); await f.beat();

		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 1 }, epoch: null, observationCount: 2 });
		expect(f.service.getView().observations.map((row) => [row.cursor, row.delta])).toEqual([[1, 2], [2, 3]]);
		await expectDiskConsistent(f);
		expect((await f.durable()).record).toEqual(f.service.getRuntime());
		await f.service.dispose();
	});

	it('a finish that landed unseen is not reopened: the session stays closed and its note is saved', async () => {
		const f = outage('landed-finish');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.dieAfterNextCommit();
		f.at(2000); await expect(f.service.stop(AT + 2000)).resolves.toBe(false);
		expect(f.service.getView().phase).toBe('error');
		expect(f.service.getRuntime()?.phase).toBe('active');
		reviveStorage(f.tracked);
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', endedAt: iso(2000), summaryReceipt: null });

		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'complete', endedAt: iso(2000) });
		// And the beat after it finishes what a closed session still owes: its note.
		f.at(10_000); await f.beat();
		expect(f.options.onComplete).toHaveBeenCalledTimes(1);
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', summaryReceipt: { path: 'Sessions/live.md' } });
		await f.service.dispose();
	});
});

/**
 * Hebra or Obsidian closed abruptly: the process dies holding the lease and never releases it. The
 * lease lasts five minutes (H14.22), and the plugin that came back 70 s later was refused its own
 * session for the rest of them: `source_conflict` on every `live_open`, and nothing measured meanwhile.
 *
 * It is not healed by shortening the lease. A lease of 30 s was tried on 9 Oct 2026 and does heal
 * this, but the heartbeat is a timer and the usual way to use the plugin is with the notes application
 * hidden behind the game, where Chromium-based hosts hold timers back to as little as one a minute: a
 * lease shorter than the real beat is lost on every beat with the host alive (see «a heartbeat that
 * fires once a minute» below: 150 of 600 samples stored).
 *
 * It is healed by knowing the owner died (9 Oct 2026, F7): where the host hands over its lock manager,
 * the owner holds a Web Lock for as long as it lives, and the host that comes back finds that lock free
 * and, 15 s after the last renewal, takes the lease under the next fence and the rules of a restart. Where there is no lock
 * manager (a host without the API, or an owner from a build before this one) nothing is known about the
 * owner, and the five minutes are still waited: that is the first test below, as it always was.
 */
describe('live session whose host died without releasing the lease', () => {
	/** A session one host is measuring, beating every five seconds up to `untilMs`. */
	async function measured(label: string, untilMs: number, locks?: FakeLocks) {
		const f = outage(label, locks ? { locks } : {});
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		for (let at = 5000; at <= untilMs; at += 5000) { f.at(at); await f.beat(); }
		return f;
	}

	it('the host that starts 70 s later takes its session back on its first live_open when the dead one held a life lock', async () => {
		const f = await measured('abrupt-close-locks', 5000, fakeLocks());
		expect(f.service.getRuntime()).toMatchObject({ authority: { instanceId: 'wl1:host', fence: 1 } });
		// The process is gone here: nothing was released and nothing disposed. Its last renewal was at 5 s,
		// so its lease has 235 s left when the next host starts.
		f.hostDies();
		f.at(75_000);
		const next = f.restarted(); await next.service.initialize();
		// Taken during `initialize`, before anything was asked: the session is this host's again.
		expect(next.service.getRuntime()).toMatchObject({ sessionId: 'session', authority: { instanceId: 'wl1:next-host', fence: 2 } });
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		expect(next.service.getView().gaps.map((gap) => gap.reason)).toEqual(['host_restart']);
		f.at(76_000); await expect(next.service.commit(f.sample(0, 0, bags(20), NEXT_EPOCH))).resolves.toBe('stored');
		f.at(77_000); await expect(next.service.commit(f.sample(1, 1000, bags(23), NEXT_EPOCH))).resolves.toBe('stored');
		expect(next.service.getView().observations.map((row) => [row.epoch, row.before, row.after, row.delta])).toEqual([[EPOCH, 5, 7, 2], [NEXT_EPOCH, 20, 23, 3]]);
		expect(next.onError).not.toHaveBeenCalled();
		// And were the dead host somehow still running, the store itself refuses what it writes under the old fence.
		f.at(78_000); await expect(f.service.commit(f.sample(2, 78_000, bags(9)))).resolves.toBe('not_owner');
		expect((await f.durable()).record).toMatchObject({ authority: { instanceId: 'wl1:next-host', fence: 2 }, observationCount: 2 });
		await next.dispose();
	});

	it('without a lock manager (a host without the API) the host that starts 70 s later is refused its session until the dead one\'s lease runs out', async () => {
		const f = await measured('abrupt-close', 5000);
		// The process is gone here: nothing was released and nothing disposed. Its last renewal was at 5 s.
		f.at(75_000);
		const next = f.restarted(); await next.service.initialize();
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		// It keeps asking on every beat and is refused for as long as the lease lasts.
		for (let at = 80_000; at <= LEASE_TTL_MS; at += 5000) { f.at(at); await next.beat(); }
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		expect(next.service.getRuntime()).toMatchObject({ authority: { instanceId: 'host', fence: 1 } });

		// Five minutes after the last renewal the lease is nobody's, and the first beat takes the session back.
		f.at(LEASE_TTL_MS + 5000); await next.beat();
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		expect(next.service.getRuntime()).toMatchObject({ sessionId: 'session', authority: { instanceId: 'next-host', fence: 2 } });
		expect(next.service.getView().gaps.map((gap) => gap.reason)).toEqual(['host_restart']);
		f.at(LEASE_TTL_MS + 6000); await expect(next.service.commit(f.sample(0, 0, bags(20), NEXT_EPOCH))).resolves.toBe('stored');
		f.at(LEASE_TTL_MS + 7000); await expect(next.service.commit(f.sample(1, 1000, bags(23), NEXT_EPOCH))).resolves.toBe('stored');
		expect(next.service.getView().observations.map((row) => [row.epoch, row.before, row.after, row.delta])).toEqual([[EPOCH, 5, 7, 2], [NEXT_EPOCH, 20, 23, 3]]);
		await next.dispose();
	});

	it('a host that is alive is still the only one: a second host cannot take the session while the first one beats', async () => {
		const f = await measured('two-hosts', 120_000);
		f.at(121_000);
		const second = f.restarted(); await second.service.initialize();
		await expect(second.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		f.at(125_000); await second.beat();
		await expect(second.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		// And the first one goes on measuring under the lease it never lost.
		await expect(f.service.commit(f.sample(2, 125_000, bags(9)))).resolves.toBe('stored');
		expect(f.service.getRuntime()).toMatchObject({ authority: { instanceId: 'host', fence: 1 } });
		await second.dispose(); await f.service.dispose();
	});

	it('nor with a lock manager: the first host holds its lock, so the second one is refused exactly as before', async () => {
		const locks = fakeLocks();
		const f = await measured('two-hosts-locks', 120_000, locks);
		f.at(121_000);
		const second = f.restarted(); await second.service.initialize();
		await expect(second.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		f.at(125_000); await second.beat();
		await expect(second.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		expect(second.service.getRuntime()).toMatchObject({ authority: { instanceId: 'wl1:host', fence: 1 } });
		expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:host', 'tyrian-companion-lease:wl1:next-host']);
		await expect(f.service.commit(f.sample(2, 125_000, bags(9)))).resolves.toBe('stored');
		expect(f.service.getRuntime()).toMatchObject({ authority: { instanceId: 'wl1:host', fence: 1 } });
		// Once the first host is really gone the second one takes the session on the first beat that finds
		// it silent for 15 s (its last renewal was at 120 s): no five minutes.
		f.hostDies();
		f.at(130_000); await second.beat();
		await expect(second.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		f.at(135_000); await second.beat();
		await expect(second.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		expect(second.service.getRuntime()).toMatchObject({ authority: { instanceId: 'wl1:next-host', fence: 2 } });
		await second.dispose();
	});

	it('a plugin reloaded in the same document takes its session back 15 s after the old one last renewed, once that one is disposed of, released or not', async () => {
		const locks = fakeLocks();
		const f = await measured('reload-locks', 5000, locks);
		f.at(6000);
		const next = f.restarted(); await next.service.initialize();
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		// The old coordinator is disposed of without its lease having been released (an unload cut short).
		f.options.coordinator.dispose();
		// Its lock is free at once, and its last renewal was at 5 s: the beats before 20 s leave it alone.
		f.at(10_000); await next.beat();
		f.at(15_000); await next.beat();
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:next-host']);
		f.at(20_000); await next.beat();
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		expect(next.service.getRuntime()).toMatchObject({ authority: { instanceId: 'wl1:next-host', fence: 2 } });
		await next.dispose();
	});

	/**
	 * The premise the life lock rests on, failing: two processes alive over the same IndexedDB whose lock
	 * managers share nothing, so each sees the other's lock free (an engine that keeps its locks per process,
	 * with nothing stopping a second process from opening the same data). Measured by the review of 9 Oct 2026
	 * before the second condition existed: each host took the other's session on every beat, and the one being
	 * fed stored 45 of 120 samples under a fence that reached 17. This test, with that condition taken out of the
	 * coordinator, gives 40 of 120 stored, 72 `live_open` refused and a fence of 18, in the other host's name.
	 *
	 * An owner that is alive and beating has renewed within the last 15 s, so it is left alone whatever the
	 * lock manager says: the figures are those of two hosts with no lock manager at all.
	 */
	it.each([
		['neither has a lock manager', false],
		['each has a lock registry of its own and sees the other\'s lock free', true],
	])('two hosts alive over one store, when %s: the one being fed stores every sample under the fence it started with', async (_case, registries) => {
		const f = outage(`two-alive-${registries ? 'registries' : 'plain'}`, registries ? { locks: fakeLocks() } : {});
		await f.service.start('Test');
		f.at(500);
		const other = f.restarted(registries ? fakeLocks() : undefined); await other.service.initialize();
		const counts = { sent: 0, stored: 0, refused: 0, opened: 0, conflicts: 0 };
		let epochs = 0; let epoch: string | null = null; let cursor = 0; let quantity = 5;
		// Two minutes of the producer feeding the first host, a sample a second, both hosts beating every five.
		for (let second = 1; second <= 120; second += 1) {
			f.at(second * 1000);
			if (second % 5 === 0) { await f.beat(); await other.beat(); }
			if (epoch === null) {
				const next = epochOf(++epochs);
				if (await f.service.open({ ...f.source, epoch: next }) === 'ready') { epoch = next; cursor = 0; counts.opened += 1; } else counts.conflicts += 1;
			}
			if (epoch === null) continue;
			quantity += 1; counts.sent += 1;
			if (await f.service.commit(f.sample(cursor, cursor * 1000, bags(quantity), epoch)) === 'stored') { counts.stored += 1; cursor += 1; } else { counts.refused += 1; epoch = null; }
		}
		expect(counts).toEqual({ sent: 120, stored: 120, refused: 0, opened: 1, conflicts: 0 });
		const owner = registries ? 'wl1:host' : 'host';
		expect(f.service.getRuntime()).toMatchObject({ authority: { instanceId: owner, fence: 1 }, observationCount: 119 });
		expect((await f.durable()).record).toMatchObject({ authority: { instanceId: owner, fence: 1 }, observationCount: 119 });
		// The other host never had the session, and never stopped asking for it.
		expect(other.service.getRuntime()).toMatchObject({ authority: { instanceId: owner, fence: 1 } });
		await expect(other.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		expect(f.onError).not.toHaveBeenCalled();
		await other.dispose(); await f.service.dispose();
	});

	/**
	 * What is left when the premise fails for an owner the 15 s do not cover: alive, unseen, and silent for
	 * that long (its beat held back). The new owner takes the lease, and the store only refuses the old
	 * one's writes from the new owner's FIRST save on. Found by the review of 9 Oct 2026, forcing the order:
	 * a write of the old owner that had passed its ownership check landed between the new owner reading the
	 * session and saving it, and that save wrote the older count over it. Record with one observation,
	 * journal with two, and the next start refused the session («journal does not match its committed cursor»).
	 *
	 * The first save of a takeover now says what it read, and is refused unless that is still what is stored.
	 */
	it('a write of the old owner that lands between the new owner reading the session and saving it is not written over: record and journal still agree', async () => {
		const f = await measured('late-old-write', 5000, fakeLocks());
		// Sixteen seconds without a beat, and a sample reaches the old host: it still owns its lease, and its
		// write is on its way to the store when the other process starts.
		f.at(21_000);
		const oldSave = f.store.saveLive.bind(f.store);
		let land: () => void = () => undefined; const held = new Promise<void>((resolve) => { land = resolve; });
		let onItsWay = false;
		vi.spyOn(f.store, 'saveLive').mockImplementationOnce(async (...parameters) => { onItsWay = true; await held; return await oldSave(...parameters); });
		const committing = f.service.commit(f.sample(2, 21_000, bags(9)));
		await vi.waitFor(() => { expect(onItsWay).toBe(true); });

		// A lock registry of its own: it sees the old host's lock free, and takes the lease.
		const next = f.restarted(fakeLocks());
		const newSave = next.store.saveLive.bind(next.store);
		// The old write lands after the new owner has read the session and before its first save reaches the store.
		vi.spyOn(next.store, 'saveLive').mockImplementationOnce(async (...parameters) => { land(); await committing; return await newSave(...parameters); });
		await next.service.initialize();
		await expect(committing).resolves.toBe('stored');
		// The takeover was not saved over what it had not read, and says so; the next beat reads again and takes the session.
		expect(next.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session recovery could not be persisted.']);
		// The producer does not wait for the beat: it opens as soon as it connects. Until the session has been read
		// again this host has nothing it may write from, so it holds no lease to answer with. Answering `ready` here
		// saved the older count under the LAST owner's authority, which the store still accepted.
		f.at(21_500);
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('source_conflict');
		await expect(next.service.commit(f.sample(0, 0, bags(20), NEXT_EPOCH))).resolves.not.toBe('stored');
		expect((await f.durable()).record).toMatchObject({ authority: { instanceId: 'wl1:host', fence: 1 }, observationCount: 2 });
		f.at(26_000); await next.beat();
		const durable = await f.durable();
		expect(durable.record).toMatchObject({ authority: { instanceId: 'wl1:next-host', fence: 2 }, observationCount: 2 });
		const observations = durable.journal.flatMap((entry) => entry.observations);
		expect(observations).toHaveLength(durable.record.observationCount);
		expect(liveObservationTotals([], observations)).toEqual(durable.record.totals);
		expect(next.service.getRuntime()).toEqual(durable.record);
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		await next.dispose();
	});

	it('a machine suspended for longer than the lease lasts does not close the session: it comes back as after an outage', async () => {
		const f = await measured('suspended', 10_000);
		await f.service.presence(true, AT + 10_000);
		// Thirty minutes without a sample or a beat: the lease ran out long ago and nobody took it.
		const woke = 10_000 + 30 * 60_000;
		f.at(woke); await f.beat();
		expect(f.service.getView().phase).toBe('error');
		f.at(woke + 5000); await f.beat();
		f.at(woke + 10_000); await f.beat();
		f.at(woke + 15_000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', endedAt: null, connection: 'connected' });
		expect(f.service.getRuntime()).toMatchObject({ phase: 'active', authority: { instanceId: 'host', fence: 2 }, epoch: null });
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(1000), toAt: null, channels: ['items'] }]);
		expect(f.options.onComplete).not.toHaveBeenCalled();
		// The producer opens a new epoch and the session measures again.
		await expect(f.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		f.at(woke + 16_000); await expect(f.service.commit(f.sample(0, 0, bags(30), NEXT_EPOCH))).resolves.toBe('stored');
		f.at(woke + 17_000); await expect(f.service.commit(f.sample(1, 1000, bags(31), NEXT_EPOCH))).resolves.toBe('stored');
		expect(f.service.getView().observations.map((row) => [row.epoch, row.delta])).toEqual([[EPOCH, 2], [NEXT_EPOCH, 1]]);
		await f.service.dispose();
	});

	it('a pause shorter than the lease is ridden out: the same lease, no gap, the epoch still open', async () => {
		const f = await measured('short-suspension', 10_000);
		await f.service.presence(true, AT + 10_000);
		f.at(70_000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', endedAt: null, connection: 'connected', gaps: [] });
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 1 }, epoch: EPOCH });
		f.at(71_000); await expect(f.service.commit(f.sample(2, 71_000, bags(9)))).resolves.toBe('stored');
		expect(f.options.onComplete).not.toHaveBeenCalled();
		await f.service.dispose();
	});
});

/**
 * The heartbeat is a timer, and a host may fire it far less often than every five seconds while it
 * stays alive: a hidden window whose timers are held back to one a minute, which is how this plugin
 * is mostly used (the notes application behind the game). Samples do not depend on any timer: they
 * arrive on the addon's socket, one a second. The lease has to outlast the beat the host really
 * gives, or the session loses it on every beat while it is being fed.
 */
describe('live session on a host whose heartbeat fires once a minute', () => {
	/**
	 * Ten minutes of a producer as the addon behaves: a sample every second, each one waited for, and
	 * a new epoch opened whenever one is refused. The heartbeat fires every `beatEveryS` seconds and at
	 * no other time. `renewalAt120` makes the beat of the second minute wait for a renewal that is not
	 * answered within the storage deadline (ten seconds, during which the producer waits for its ACK),
	 * and either never reaches storage or reaches it after the wait ran out.
	 */
	async function tenMinutes(f: ReturnType<typeof outage>, beatEveryS: number, renewalAt120?: 'never lands' | 'lands late') {
		const counts = { sent: 0, stored: 0, refused: 0, opened: 0, conflicts: 0, secondsInError: 0 };
		let epochs = 0; let epoch: string | null = null; let cursor = 0; let quantity = 5;
		const feed = async (pending?: () => Promise<void>): Promise<void> => {
			if (epoch === null) {
				const next = epochOf(++epochs);
				if (await f.service.open({ ...f.source, epoch: next }) === 'ready') { epoch = next; cursor = 0; counts.opened += 1; } else counts.conflicts += 1;
			}
			if (epoch === null) return;
			quantity += 1; counts.sent += 1;
			const answer = f.service.commit(f.sample(cursor, cursor * 1000, bags(quantity), epoch));
			await pending?.();
			if (await answer === 'stored') { counts.stored += 1; cursor += 1; } else { counts.refused += 1; epoch = null; }
		};
		await f.service.start('Test');
		for (let second = 1; second <= 600; second += 1) {
			f.at(second * 1000);
			if (second === 120 && renewalAt120 !== undefined) {
				const renew = f.options.coordinator.renew.bind(f.options.coordinator);
				let land: () => void = () => undefined; const held = new Promise<void>((resolve) => { land = resolve; });
				let landed = false;
				vi.spyOn(f.options.coordinator, 'renew').mockImplementationOnce(async (handle, leaseTtlMs) => {
					await held; const answer = await renew(handle, leaseTtlMs); landed = true; return answer;
				});
				f.tick(); await turns();
				// The sample of this second is queued behind the beat; its ACK comes when the wait runs out.
				await feed(async () => { await turns(); second += 10; f.at(second * 1000); await f.timeout(); });
				if (renewalAt120 === 'lands late') { land(); await vi.waitFor(() => { expect(landed).toBe(true); }); }
			} else {
				if (second % beatEveryS === 0) await f.beat();
				await feed();
			}
			if (f.service.getView().phase === 'error') counts.secondsInError += 1;
		}
		return counts;
	}

	afterEach(() => { vi.restoreAllMocks(); });

	it('stores every sample of ten minutes under the lease it has: no epoch is lost and no live_open refused', async () => {
		const f = outage('slow-beat');
		const leaseWrites = f.countLeaseWrites();
		const counts = await tenMinutes(f, 60);
		expect(counts).toEqual({ sent: 600, stored: 600, refused: 0, opened: 1, conflicts: 0, secondsInError: 0 });
		// One baseline and 599 seconds measured after it, all under the lease the session started with.
		expect(f.service.getView()).toMatchObject({ phase: 'active', observationCount: 599, observedItemsMs: 599_000 });
		expect(f.service.getView().totals).toEqual([{ kind: 'item', idNumber: 12147, positive: 599, negative: 0, net: 599 }]);
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 1 } });
		expect(storageGaps(f.service)).toEqual([]);
		expect(f.onError).not.toHaveBeenCalled();
		// What the lease cost the store: the acquisition and one renewal per beat.
		expect(leaseWrites()).toBe(11);
		await f.service.dispose();
	});

	// The life lock is memory of the engine: it costs the hidden window nothing, neither a sample nor a write.
	it('stores the same 600 of 600 with the same writes to the lease when the host holds its life lock', async () => {
		const locks = fakeLocks();
		const f = outage('slow-beat-locks', { locks });
		const leaseWrites = f.countLeaseWrites();
		const counts = await tenMinutes(f, 60);
		expect(counts).toEqual({ sent: 600, stored: 600, refused: 0, opened: 1, conflicts: 0, secondsInError: 0 });
		expect(f.service.getView()).toMatchObject({ phase: 'active', observationCount: 599, observedItemsMs: 599_000 });
		expect(f.service.getRuntime()).toMatchObject({ authority: { instanceId: 'wl1:host', fence: 1 } });
		expect(storageGaps(f.service)).toEqual([]);
		expect(f.onError).not.toHaveBeenCalled();
		expect(leaseWrites()).toBe(11);
		expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:host']);
		await f.service.dispose();
	});

	// The negative of the table in SPEC-live-loot §4, with the lock held: what heals the abrupt close is
	// not a shorter lease, and a shorter lease still loses three samples in four behind a slow beat.
	it('a 30 s lease is still lost on every beat of a minute with the host alive and its lock held', async () => {
		const f = outage('slow-beat-short-lease', { locks: fakeLocks(), leaseTtlMs: 30_000 });
		const counts = await tenMinutes(f, 60);
		// 150 of the 600 seconds stored, `live_open` refused 445 times and half the time in error: the row of the table.
		expect(counts).toEqual({ sent: 155, stored: 150, refused: 5, opened: 6, conflicts: 445, secondsInError: 300 });
		await f.service.dispose();
	});

	it('a renewal that is not answered in time leaves the lease with room for the next beat: the handle is kept and nothing is refused', async () => {
		const f = outage('slow-beat-unanswered-renewal');
		const counts = await tenMinutes(f, 60, 'never lands');
		// The producer waited ten seconds for one ACK, so it sent ten samples fewer; none was refused.
		expect(counts).toEqual({ sent: 590, stored: 590, refused: 0, opened: 1, conflicts: 0, secondsInError: 0 });
		// The lease renewed at 60 s ran to 360 s, 240 s past the beat that was not answered: the beat at 180 s renewed
		// it as usual and so did every one after, none skipped. The last renewal is the one of the tenth minute.
		const other = f.lease('other-host');
		await expect(other.acquire('other-session')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'host', ownerExpiresAt: AT + 600_000 + LEASE_TTL_MS });
		other.dispose();
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 1 } });
		// The outage is reported, but no sample was refused, so no interval went unobserved: no gap, and the sample
		// that waited is measured against the one before it.
		expect(storageGaps(f.service)).toEqual([]);
		expect(f.service.getView()).toMatchObject({ phase: 'active', observationCount: 589 });
		expect(f.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session storage is unavailable.']);
		await f.service.dispose();
	});

	/**
	 * KNOWN COST, pinned as it is today. The renewal that was given up reaches storage after all and
	 * changes the lease, so the handle this host kept no longer matches: the next sample is refused, the
	 * next beat finds the lease lost and the one after it reclaims it (it is still this host's). At
	 * the usual beat that is ten seconds; at one beat a minute it is the 108 seconds counted here. No
	 * loot is miscounted (a gap, a new epoch, a baseline), but nothing is measured meanwhile. Taking the
	 * lease back in the same beat that finds it lost is nobody's plan today: it was filed under renewing a
	 * lease that ran out, which the detection of a dead owner replaced (F7) without touching this case.
	 */
	it('known cost: a renewal that lands after its wait ran out costs the time of two beats, then the session measures again', async () => {
		const f = outage('slow-beat-late-renewal');
		const counts = await tenMinutes(f, 60, 'lands late');
		// Refused at 131 s; `live_open` refused from 132 s until the beat of 240 s takes the lease back.
		expect(counts).toEqual({ sent: 482, stored: 481, refused: 1, opened: 2, conflicts: 108, secondsInError: 60 });
		expect(f.service.getView().phase).toBe('active');
		// The lease was never anybody else's: same fence, and nothing on disk went back.
		expect(f.service.getRuntime()).toMatchObject({ authority: { instanceId: 'host', fence: 1 } });
		const durable = await f.durable();
		expect(durable.record).toEqual(f.service.getRuntime());
		expect(durable.journal.flatMap((entry) => entry.observations)).toHaveLength(durable.record.observationCount);
		await f.service.dispose();
	});
});

/**
 * A gap the producer reports while the lease is lost cannot be written by anybody. It used to be
 * dropped: no loot slipped through, because the reclaim opens a gap of its own and asks for a new
 * baseline, but that gap said `storage_unavailable` for what had been, say, the game closing, and
 * the disconnection the producer reported was never on record.
 */
describe('live session whose producer reported a gap while the lease was lost', () => {
	/** When the machine wakes: long after any lease this session can hold has run out, whatever its length. */
	const WOKE = 2 * LEASE_TTL_MS;
	/** A session measured up to one second, then a suspension that outlives the lease, and the beat that finds it lost. */
	async function lost(label: string) {
		const f = outage(label);
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7))); await f.service.presence(true, AT + 1000);
		f.at(WOKE); await f.beat();
		expect(f.service.getView().phase).toBe('error');
		return f;
	}

	it('the gap the reclaim opens carries the cause the producer gave, and the disconnection it reported is written', async () => {
		const f = await lost('lost-gap');
		const before = await f.durable();
		f.at(WOKE + 1000);
		await expect(f.service.gap({ sourceInstance: INSTANCE, epoch: EPOCH, reason: 'disconnect', observedAt: iso(WOKE + 1000) })).resolves.toBeUndefined();
		// Nobody holds the lease, so nothing is written yet.
		expect(await f.durable()).toEqual(before);
		expect(f.service.getRuntime()).toMatchObject({ epoch: EPOCH, lastSourceDisconnectedAt: null });

		f.at(WOKE + 5000); await f.beat();
		expect(f.service.getView().phase).toBe('active');
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason: 'disconnect', fromAt: iso(1000), toAt: null, channels: ['items'] }]);
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 2 }, epoch: null, lastSample: null, lastSourceDisconnectedAt: iso(WOKE + 1000) });
		expect((await f.durable()).record).toEqual(f.service.getRuntime());
		// The cause is spent with that gap: the next loss of the lease is an outage of its own.
		f.at(WOKE + 6000); await expect(f.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		await expect(f.service.commit(f.sample(0, 0, bags(9), NEXT_EPOCH))).resolves.toBe('stored');
		f.at(2 * WOKE); await f.beat(); f.at(2 * WOKE + 5000); await f.beat();
		expect(f.service.getView().gaps.map((gap) => [gap.reason, gap.toAt])).toEqual([['disconnect', iso(WOKE + 6000)], ['storage_unavailable', null]]);
		await f.service.dispose();
	});

	it.each(['read_failed', 'partial_inventory', 'context_changed'] as const)('a %s gap is kept under its own cause too', async (reason) => {
		const f = await lost(`lost-gap-${reason}`);
		f.at(WOKE + 1000); await f.service.gap({ sourceInstance: INSTANCE, epoch: EPOCH, reason, observedAt: iso(WOKE + 1000) });
		f.at(WOKE + 5000); await f.beat();
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason, fromAt: iso(1000), toAt: null, channels: ['items'] }]);
		expect(f.service.getRuntime()).toMatchObject({ epoch: null, lastSourceDisconnectedAt: null });
		await f.service.dispose();
	});

	it('the first cause still comes first: a sample storage refused before the lease was lost names the gap', async () => {
		const f = outage('lost-gap-after-refusal');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		killStorage(f.tracked);
		f.at(1000); await expect(f.service.commit(f.sample(1, 1000, bags(8)))).resolves.toBe('storage_unavailable');
		reviveStorage(f.tracked);
		f.at(WOKE); await f.beat();
		f.at(WOKE + 1000); await f.service.gap({ sourceInstance: INSTANCE, epoch: EPOCH, reason: 'disconnect', observedAt: iso(WOKE + 1000) });
		f.at(WOKE + 5000); await f.beat();
		expect(f.service.getView().phase).toBe('active');
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(0), toAt: null, channels: ['items'] }]);
		// The disconnection is a fact of its own, whatever the gap is called.
		expect(f.service.getRuntime()).toMatchObject({ epoch: null, lastSourceDisconnectedAt: iso(WOKE + 1000) });
		await f.service.dispose();
	});

	it('after a host restart the gap stays the restart\'s: the restart came first', async () => {
		const f = outage('lost-gap-restart');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		// A second host starts while the first still holds the lease, and is told of a gap it cannot write.
		const next = f.restarted(); await next.service.initialize();
		f.at(2000); await next.service.gap({ sourceInstance: INSTANCE, epoch: EPOCH, reason: 'disconnect', observedAt: iso(2000) });
		await f.service.dispose();
		f.at(5000); await next.beat();
		expect(next.service.getView().phase).toBe('active');
		expect(next.service.getView().gaps.map((gap) => gap.reason)).toEqual(['host_restart']);
		await next.dispose();
	});
});

/**
 * Storage that is down at the moment the host starts. The load of the saved session failed, the view
 * went to `error` and that was all: no heartbeat, nobody asked again, and once storage was back the
 * session on disk stayed where it was, unread, with every start refused until the next restart.
 */
describe('live session that could not be read when the host started', () => {
	/** A session with one observation on disk, and its host gone without releasing the lease. */
	async function orphaned(label: string) {
		const f = outage(label);
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		return { f, before: await f.durable() };
	}

	it('storage that was down at the start is asked again by the heartbeat, and the saved session goes on as after any restart', async () => {
		const { f, before } = await orphaned('load-unavailable');
		killStorage(f.tracked);
		f.at(LEASE_TTL_MS + 60_000);
		const next = f.restarted();
		await expect(next.service.initialize()).resolves.toBeUndefined();
		expect(next.service.getView()).toMatchObject({ phase: 'error', sessionId: null });
		expect(next.onError.mock.calls.map(([error]) => (error as Error).message)).toContain('Live session storage is unavailable.');
		// Nothing is started while nobody knows what is saved, and a beat that finds storage still down changes nothing.
		await expect(next.service.start('Test')).resolves.toBeNull();
		f.at(LEASE_TTL_MS + 65_000); await next.beat();
		expect(next.service.getView()).toMatchObject({ phase: 'error', sessionId: null });
		const reported = next.onError.mock.calls.filter(([error]) => (error as Error).message === 'Live session storage is unavailable.');
		expect(reported, 'the outage is reported once, not once per beat').toHaveLength(1);

		reviveStorage(f.tracked);
		expect(await f.durable(), 'the session on disk was never touched').toEqual(before);
		f.at(LEASE_TTL_MS + 70_000); await next.beat();
		expect(next.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', observationCount: 1, observedItemsMs: 1000 });
		expect(next.service.getRuntime()).toMatchObject({ authority: { instanceId: 'next-host', fence: 2 }, epoch: null });
		expect(next.service.getView().gaps.map((gap) => gap.reason)).toEqual(['host_restart']);
		// It is the saved session that goes on, not a new one over it.
		await expect(next.service.start('Test')).resolves.toBe('session');
		await expect(next.service.open({ ...f.source, epoch: NEXT_EPOCH })).resolves.toBe('ready');
		f.at(LEASE_TTL_MS + 71_000); await expect(next.service.commit(f.sample(0, 0, bags(20), NEXT_EPOCH))).resolves.toBe('stored');
		f.at(LEASE_TTL_MS + 72_000); await expect(next.service.commit(f.sample(1, 1000, bags(23), NEXT_EPOCH))).resolves.toBe('stored');
		expect(next.service.getView().observations.map((row) => [row.epoch, row.before, row.after, row.delta])).toEqual([[EPOCH, 5, 7, 2], [NEXT_EPOCH, 20, 23, 3]]);
		await next.dispose();
	});

	it('a start that finds storage back reads the saved session first, instead of waiting for the next beat', async () => {
		const { f } = await orphaned('load-unavailable-start');
		killStorage(f.tracked);
		f.at(LEASE_TTL_MS + 60_000);
		const next = f.restarted(); await next.service.initialize();
		reviveStorage(f.tracked);
		await expect(next.service.start('Test')).resolves.toBe('session');
		expect(next.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', observationCount: 1 });
		expect((await f.durable()).record).toEqual(next.service.getRuntime());
		await next.dispose();
	});

	it('with nothing saved, a start works as soon as storage is back', async () => {
		const f = outage('load-unavailable-empty');
		killStorage(f.tracked);
		const next = f.restarted(); await next.service.initialize();
		expect(next.service.getView().phase).toBe('error');
		await expect(next.service.start('Test')).resolves.toBeNull();
		reviveStorage(f.tracked);
		f.at(5000); await next.beat();
		expect(next.service.getView().phase).toBe('idle');
		await expect(next.service.start('Test')).resolves.toBe('next-session');
		expect(next.service.getView()).toMatchObject({ phase: 'active', sessionId: 'next-session' });
		await next.dispose();
	});

	/**
	 * The runtime awaits `initialize()` before it declares the plugin ready, so whatever it rejected with
	 * was the whole plugin not starting: sessions, inventory, prices and settings, for a live session that
	 * could not be brought back.
	 */
	describe('and the failure comes after the record was read', () => {
		it('a journal storage cannot read does not stop the start: nothing of the session is kept, and it is asked for again', async () => {
			const { f, before } = await orphaned('journal-unavailable');
			f.at(LEASE_TTL_MS + 60_000);
			const next = f.restarted();
			const read = vi.spyOn(next.store, 'readLiveJournal').mockRejectedValueOnce(new Error('Live session journal is unavailable.'));
			await expect(next.service.initialize()).resolves.toBeUndefined();
			expect(read).toHaveBeenCalledTimes(1);
			// A record without its journal is not a session anybody may write on: none of it is in memory.
			expect(next.service.getView()).toMatchObject({ phase: 'error', sessionId: null, observationCount: 0 });
			expect(next.service.getRuntime()).toBeNull();
			expect(next.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session journal is unavailable.']);
			await expect(next.service.commit(f.sample(2, 2000, bags(9)))).resolves.toBe('not_owner');
			await expect(next.service.stop(AT + LEASE_TTL_MS + 60_000)).resolves.toBe(false);
			expect(await f.durable()).toEqual(before);

			f.at(LEASE_TTL_MS + 65_000); await next.beat();
			expect(next.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', observationCount: 1, observedItemsMs: 1000 });
			expect(next.service.getView().gaps.map((gap) => gap.reason)).toEqual(['host_restart']);
			expect(next.onError).toHaveBeenCalledTimes(1);
			await next.dispose();
		});

		it('a journal that does not match its record does not stop the start either, and is never taken for a session', async () => {
			const { f, before } = await orphaned('journal-mismatch');
			f.at(LEASE_TTL_MS + 60_000);
			const next = f.restarted();
			// The record counts one observation and the journal brings none.
			const read = vi.spyOn(next.store, 'readLiveJournal').mockResolvedValue([]);
			await expect(next.service.initialize()).resolves.toBeUndefined();
			expect(next.service.getView()).toMatchObject({ phase: 'error', sessionId: null, observationCount: 0 });
			expect(next.service.getRuntime()).toBeNull();
			expect(next.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session journal does not match its committed cursor.']);
			// It is evidence that contradicts itself, not an outage: no beat asks again, and no session is started over it.
			expect(next.beats()).toBe(false);
			await expect(next.service.start('Test')).resolves.toBeNull();
			await expect(next.service.stop(AT + LEASE_TTL_MS + 60_000)).resolves.toBe(false);
			expect(read).toHaveBeenCalledTimes(1);
			// No note is written for a session whose journal was not the one its record counts.
			expect(f.options.onComplete).not.toHaveBeenCalled();
			expect(await f.durable()).toEqual(before);
			await next.dispose();
		});

		it('a reclaim that cannot be saved does not stop the start: the next beat tries again', async () => {
			const { f } = await orphaned('reclaim-refused-at-start');
			f.at(LEASE_TTL_MS + 60_000);
			const next = f.restarted();
			vi.spyOn(next.store, 'saveLive').mockResolvedValueOnce({ status: 'stale' });
			await expect(next.service.initialize()).resolves.toBeUndefined();
			expect(next.service.getView()).toMatchObject({ phase: 'error', sessionId: 'session', observationCount: 1 });
			expect(next.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session recovery could not be persisted.']);
			f.at(LEASE_TTL_MS + 65_000); await next.beat();
			expect(next.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', observationCount: 1 });
			expect((await f.durable()).record).toEqual(next.service.getRuntime());
			await next.dispose();
		});
	});

	it('a saved record that does not validate is not a passing outage: nobody asks again and nothing is started over it', async () => {
		const { f, before } = await orphaned('load-corrupt');
		f.at(LEASE_TTL_MS + 60_000);
		const next = f.restarted();
		const load = vi.spyOn(next.store, 'loadLive').mockResolvedValue({ status: 'error', code: 'corrupt' });
		await next.service.initialize();
		expect(next.service.getView()).toMatchObject({ phase: 'error', sessionId: null });
		expect(next.beats()).toBe(false);
		await expect(next.service.start('Test')).resolves.toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
		expect(await f.durable()).toEqual(before);
		await next.dispose();
	});
});

/**
 * The third way storage fails, and the one that was never answered at all (9 Oct 2026, probe of the
 * audit): the engine takes the transaction and fires no event. Nothing was refused, so nothing took
 * the path of a refusal: the operation waited for ever inside the lifecycle's queue, every later one
 * behind it, with the session shown as active and no error reported.
 */
describe('live session while storage does not answer', () => {
	/** Two samples stored, then the engine stops answering. */
	async function hung(label: string) {
		const f = outage(label);
		await f.service.start('Test'); await expect(f.service.open(f.source)).resolves.toBe('ready');
		await expect(f.service.commit(f.sample(0, 0, bags(5)))).resolves.toBe('stored');
		f.at(1000); await expect(f.service.commit(f.sample(1, 1000, bags(7)))).resolves.toBe('stored');
		hangStorage(f.tracked);
		return f;
	}

	it('a sample storage never answers is told so once its wait runs out: the session shows the outage and reports it', async () => {
		const f = await hung('unanswered-sample');
		f.at(2000); const stuck = f.service.commit(f.sample(2, 2000, bags(20)));
		await engineIdle(f.tracked);
		expect(await settlement(stuck)).toBe('pending');
		// Until the wait runs out this is still a slow answer, not an outage.
		expect(f.service.getView().phase).toBe('active');
		expect(f.onError).not.toHaveBeenCalled();

		await f.timeout();
		await expect(stuck).resolves.toBe('storage_unavailable');
		expect(f.service.getView()).toMatchObject({ phase: 'error', observationCount: 1, observedItemsMs: 1000 });
		expect(f.service.getRuntime()?.lastSample).toMatchObject({ cursor: 1 });
		expect(f.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session storage is unavailable.']);
		// Nobody is left waiting, and the queue serves what does not need storage.
		expect(f.waiting()).toBe(0);
		expect(await settlement(f.service.capture())).toBe('resolved');
		resumeStorage(f.tracked); await f.service.dispose();
	});

	it('when storage answers again the session comes back behind one gap and records what is looted from then on', async () => {
		const f = await hung('unanswered-then-back');
		f.at(2000); const stuck = f.service.commit(f.sample(2, 2000, bags(20)));
		await turns(); await f.timeout();
		await expect(stuck).resolves.toBe('storage_unavailable');
		// The heartbeat finds the same silence, and keeps the lease it could not renew.
		f.at(5000); f.tick(); await turns(); await f.timeout();
		expect(f.service.getView().phase).toBe('error');

		resumeStorage(f.tracked);
		f.at(15_000); await expect(f.service.commit(f.sample(2, 15_000, bags(50)))).resolves.toBe('stored');
		expect(f.service.getView().phase).toBe('active');
		// The 43 bags that arrived while nobody could store them are not an acquisition.
		expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(1000), toAt: iso(15_000), channels: ['items'] }]);
		f.at(16_000); await expect(f.service.commit(f.sample(3, 16_000, bags(53)))).resolves.toBe('stored');
		expect(f.service.getView().observations.map((row) => [row.cursor, row.before, row.after, row.delta])).toEqual([[1, 5, 7, 2], [3, 50, 53, 3]]);
		expect(f.service.getView()).toMatchObject({ phase: 'active', observedItemsMs: 2000 });
		expect(f.service.getRuntime()).toMatchObject({ authority: { fence: 1 } });

		const durable = await f.durable();
		expect(durable.record).toEqual(f.service.getRuntime());
		expect(durable.journal.map((entry) => entry.cursor)).toEqual([0, 1, 2, 3]);
		expect(durable.journal.flatMap((entry) => entry.observations)).toHaveLength(durable.record.observationCount);
		// One outage, reported once.
		expect(f.onError).toHaveBeenCalledTimes(1);
		await f.service.dispose();
	});

	it('the plugin can be shut down while an operation is still waiting for storage', async () => {
		const f = await hung('unanswered-dispose');
		f.at(2000); const stuck = f.service.commit(f.sample(2, 2000, bags(20)));
		const disposing = f.service.dispose();
		await engineIdle(f.tracked);
		expect(await settlement(disposing)).toBe('pending');
		// One wait for the sample in course, one for the release of the lease: neither holds the unload for ever.
		await f.timeout();
		await expect(stuck).resolves.toBe('storage_unavailable');
		await f.timeout();
		expect(await settlement(disposing)).toBe('resolved');
		expect(f.waiting()).toBe(0);
	});

	it('a heartbeat that finds the last one still waiting adds no wait of its own', async () => {
		const f = await hung('unanswered-beats');
		const renew = vi.spyOn(f.options.coordinator, 'renew');
		f.at(5000); f.tick(); await turns();
		f.at(10_000); f.tick(); f.at(15_000); f.tick(); await turns();
		expect(renew).toHaveBeenCalledTimes(1);
		await f.timeout();
		// The beats that fired meanwhile are not queued behind it, each with a wait of its own to run out.
		expect(renew).toHaveBeenCalledTimes(1);
		expect(f.waiting()).toBe(0);
		expect(await settlement(f.service.capture())).toBe('resolved');
		// The next one asks again.
		f.at(20_000); f.tick(); await turns();
		expect(renew).toHaveBeenCalledTimes(2);
		await f.timeout();
		resumeStorage(f.tracked); await f.service.dispose();
	});

	/**
	 * A wait that runs out cancels nothing: the engine may still answer, or still write, long after the
	 * lifecycle moved on. Whatever comes that late must find nobody to take it.
	 */
	describe('and the call that was given up answers after all', () => {
		it('a commit applied at once and answered late is counted once: nothing of the abandoned wait runs when the answer comes', async () => {
			const f = outage('late-answer');
			await f.service.start('Test'); await f.service.open(f.source);
			await f.service.commit(f.sample(0, 0, bags(5)));
			f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
			const answer = f.answerNextCommitLate();
			f.at(2000); const stuck = f.service.commit(f.sample(2, 2000, bags(10)));
			await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
			await f.timeout();
			await expect(stuck).resolves.toBe('storage_unavailable');
			expect(f.service.getView()).toMatchObject({ phase: 'error', observationCount: 1 });

			// The producer sends the sample again; what is on disk is adopted before anything is written.
			f.at(3000); await expect(f.service.commit(f.sample(2, 2000, bags(10)))).resolves.toBe('stored');
			f.at(4000); await expect(f.service.commit(f.sample(3, 3000, bags(25)))).resolves.toBe('stored');
			const before = { view: f.service.getView(), runtime: f.service.getRuntime(), journal: f.service.getJournal(), durable: await f.durable() };
			expect(before.view).toMatchObject({ phase: 'active', observationCount: 2, observedItemsMs: 2000 });

			// Only now does the engine say the first attempt was stored.
			answer(); await turns();
			expect(f.service.getView()).toEqual(before.view);
			expect(f.service.getRuntime()).toEqual(before.runtime);
			expect(f.service.getJournal()).toEqual(before.journal);
			expect(f.service.getJournal().map((entry) => entry.cursor)).toEqual([0, 1, 2, 3]);
			expect(f.service.getView().observations.map((row) => [row.cursor, row.delta])).toEqual([[1, 2], [2, 3]]);
			// One alert per acquisition: the entry of cursor 2 was published when it was adopted, and not again.
			expect(f.options.onCommitted.mock.calls.map(([entry]) => (entry as LiveJournalEntryV1).cursor)).toEqual([0, 1, 2, 3]);
			expect(await f.durable()).toEqual(before.durable);
			expect(f.onError).toHaveBeenCalledTimes(1);
			await f.service.dispose();
		});

		it('a write that reaches storage after newer work is refused by it: neither disk nor memory go back', async () => {
			const f = outage('late-write');
			await f.service.start('Test'); await f.service.open(f.source);
			await f.service.commit(f.sample(0, 0, bags(5)));
			f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
			// The write of cursor 2 is held before the engine sees it, and let through only at the end.
			const write = f.store.saveLive.bind(f.store);
			let land: () => void = () => undefined; const held = new Promise<void>((resolve) => { land = resolve; });
			let landed: unknown = null;
			vi.spyOn(f.store, 'saveLive').mockImplementationOnce(async (record, journal) => {
				await held; landed = await write(record, journal); return landed as Awaited<ReturnType<typeof write>>;
			});
			f.at(2000); const stuck = f.service.commit(f.sample(2, 2000, bags(10)));
			await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
			await f.timeout();
			await expect(stuck).resolves.toBe('storage_unavailable');

			// The session goes on meanwhile: a baseline behind the gap, then three bags more.
			f.at(3000); await expect(f.service.commit(f.sample(2, 3000, bags(25)))).resolves.toBe('stored');
			f.at(4000); await expect(f.service.commit(f.sample(3, 4000, bags(28)))).resolves.toBe('stored');
			const before = { view: f.service.getView(), runtime: f.service.getRuntime(), journal: f.service.getJournal(), durable: await f.durable() };
			expect(before.view.observations.map((row) => [row.cursor, row.before, row.after, row.delta])).toEqual([[1, 5, 7, 2], [3, 25, 28, 3]]);

			land(); await vi.waitFor(() => { expect(landed).not.toBeNull(); });
			await turns();
			// The store itself turned the older record down, and with it the journal entry it carried.
			expect(landed).toEqual({ status: 'stale' });
			expect(await f.durable()).toEqual(before.durable);
			expect(f.service.getView()).toEqual(before.view);
			expect(f.service.getRuntime()).toEqual(before.runtime);
			expect(f.service.getJournal()).toEqual(before.journal);
			expect(f.options.onCommitted.mock.calls.map(([entry]) => (entry as LiveJournalEntryV1).cursor)).toEqual([0, 1, 2, 3]);
			expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(1000), toAt: iso(3000), channels: ['items'] }]);
			await f.service.dispose();
		});
	});
});

/**
 * A start is the one write whose loss leaves nothing in memory to recover from: the session does not
 * exist yet for this host. When storage did not say whether it stored it, the start answered null,
 * the view stayed idle with no error, and if the write had landed the disk held an active session
 * nobody knew of: later starts were refused by it, and after a restart the user found a session
 * running that they never saw begin.
 */
describe('live session whose start storage did not answer', () => {
	it('a start that landed unseen is reported, read back by the next beat, and goes on as the session it is: no restart is made up', async () => {
		const f = outage('late-start');
		await f.service.initialize();
		const answer = f.answerNextCommitLate();
		const starting = f.service.start('Test');
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout();
		await expect(starting).resolves.toBeNull();
		// The user is told, and the view does not say «idle» over a session that may be on disk.
		expect(f.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['Live session storage is unavailable.']);
		expect(f.service.getView()).toMatchObject({ phase: 'error', sessionId: null });
		expect((await f.durable()).record).toMatchObject({ sessionId: 'session', phase: 'active', authority: { fence: 1 } });

		answer(); await turns();
		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', startedAt: iso(0), connection: 'connected' });
		// It is this host's own start, found late: the session as it was started, not one taken over after a restart.
		expect(f.service.getView().gaps).toEqual([{ version: 1, reason: 'source_missing', fromAt: iso(0), toAt: null, channels: ['items'] }]);
		expect(f.service.getRuntime()).toMatchObject({ authority: { instanceId: 'host', fence: 2 }, lastPresenceAt: AT, lastSourceDisconnectedAt: null });
		expect((await f.durable()).record).toEqual(f.service.getRuntime());
		await expect(f.service.start('Test')).resolves.toBe('session');

		// With no producer linked and no report of presence it stays open: nobody was written as gone.
		for (let minute = 1; minute <= 12; minute += 1) { f.at(minute * 60_000); await f.beat(); }
		expect(f.service.getView()).toMatchObject({ phase: 'active', endedAt: null });
		expect(f.options.onComplete).not.toHaveBeenCalled();
		// And it measures: an epoch opens, a baseline, three bags.
		await expect(f.service.open(f.source)).resolves.toBe('ready');
		await expect(f.service.commit(f.sample(0, 0, bags(5)))).resolves.toBe('stored');
		f.at(12 * 60_000 + 1000); await expect(f.service.commit(f.sample(1, 1000, bags(8)))).resolves.toBe('stored');
		expect(f.service.getView().observations.map((row) => [row.before, row.after, row.delta])).toEqual([[5, 8, 3]]);
		expect(f.onError).toHaveBeenCalledTimes(1);
		await f.service.dispose();
	});

	it('a start that reaches storage after a load already answered «nothing saved» is found by the start it gets in the way of', async () => {
		const f = outage('later-start');
		const write = f.store.saveLive.bind(f.store);
		let land: () => void = () => undefined; const held = new Promise<void>((resolve) => { land = resolve; });
		let landed: unknown = null;
		vi.spyOn(f.store, 'saveLive').mockImplementationOnce(async (record, journal) => {
			await held; landed = await write(record, journal); return landed as Awaited<ReturnType<typeof write>>;
		});
		const starting = f.service.start('Test');
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout();
		await expect(starting).resolves.toBeNull();
		// The beat asks, and storage answers that nothing is saved: true for now.
		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'idle', sessionId: null });
		land(); await vi.waitFor(() => { expect(landed).toEqual({ status: 'saved' }); });

		// The next start is a new session, and the one that landed is in its way. It is not started over it.
		Object.assign(f.options, { sessionId: () => 'second-session' });
		f.at(6000); await expect(f.service.start('Test')).resolves.toBeNull();
		expect((await f.durable()).record).toMatchObject({ sessionId: 'session', phase: 'active' });
		// It is read back instead, and it is the session the start after that returns.
		f.at(7000); await expect(f.service.start('Test')).resolves.toBe('session');
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', startedAt: iso(0), connection: 'connected' });
		expect((await f.durable()).record).toEqual(f.service.getRuntime());
		expect(f.onError).toHaveBeenCalledTimes(1);
		await f.service.dispose();
	});

	it('a start storage refused outright changes nothing: nothing may have landed, so nothing is read again', async () => {
		const f = outage('refused-start');
		const load = vi.spyOn(f.store, 'loadLive');
		vi.spyOn(f.store, 'saveLive').mockResolvedValueOnce({ status: 'stale' });
		await expect(f.service.start('Test')).resolves.toBeNull();
		expect(f.service.getView().phase).toBe('idle');
		expect(f.onError).not.toHaveBeenCalled();
		await expect(f.service.start('Test')).resolves.toBe('session');
		expect(load).not.toHaveBeenCalled();
		await f.service.dispose();
	});

	/** A start whose save the store is asked for and never answers; `land()` lets it reach storage, when the test says so. */
	function heldStart(f: ReturnType<typeof outage>) {
		const write = f.store.saveLive.bind(f.store);
		let land: () => void = () => undefined; const held = new Promise<void>((resolve) => { land = resolve; });
		const landed: { answer: unknown } = { answer: null };
		vi.spyOn(f.store, 'saveLive').mockImplementationOnce(async (record, journal) => {
			await held; const answer = await write(record, journal); landed.answer = answer; return answer;
		});
		return { land: async (expected: string) => { land(); await vi.waitFor(() => { expect(landed.answer).toEqual({ status: expected }); }); } };
	}
	/** One start that waits for storage and gives the wait up. */
	async function unansweredStart(f: ReturnType<typeof outage>): Promise<void> {
		const starting = f.service.start('Test');
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout();
		await expect(starting).resolves.toBeNull();
	}

	// The tracker reports a transition once. With the session not in memory the report had nowhere to go, and the
	// session found afterwards was `connected` with nobody behind it, for ever: the beat only closes from `disconnected`.
	it('a report of presence that arrives while the start is unaccounted for is kept: the session is found as the player left it, and closes ten minutes later', async () => {
		const f = outage('late-start-presence');
		await f.service.initialize();
		const answer = f.answerNextCommitLate();
		await unansweredStart(f);
		// The game exits three seconds in. The tracker says so once, a second later: the instant kept is the one it gives, not the clock's.
		f.at(4000); await f.service.presence(false, AT + 3000);
		answer(); await turns();
		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', connection: 'disconnected' });
		expect(f.service.getRuntime()).toMatchObject({ lastPresenceAt: AT + 3000 });
		// Still its own start, not a restart: the gap it was born with, and no disconnection of a producer it never had.
		expect(f.service.getView().gaps.map((gap) => gap.reason)).toEqual(['source_missing']);
		for (let minute = 1; minute <= 10; minute += 1) { f.at(minute * 60_000); await f.beat(); }
		expect(f.service.getView().phase, 'ten minutes of grace from the report, not from the start').toBe('active');
		f.at(11 * 60_000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'complete', endedAt: iso(3000) });
		expect(f.options.onComplete).toHaveBeenCalledTimes(1);
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', endedAt: iso(3000), summaryReceipt: { path: 'Sessions/live.md' } });
		await f.service.dispose();
	});

	it('the last report kept wins, and the evidence of presence it carries never goes backwards', async () => {
		const f = outage('late-start-presence-order');
		await f.service.initialize();
		const answer = f.answerNextCommitLate();
		await unansweredStart(f);
		// Seen at 3.5 s, then reported gone with an older instant: gone is what holds, since the later evidence.
		f.at(4000); await f.service.presence(true, AT + 3500); await f.service.presence(false, AT + 3000);
		answer(); await turns();
		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', connection: 'disconnected' });
		expect(f.service.getRuntime()).toMatchObject({ lastPresenceAt: AT + 3500 });
		await f.service.dispose();
	});

	it('a report that arrives between two unanswered starts is still kept when the second goes unanswered', async () => {
		const f = outage('two-late-starts-presence');
		const first = heldStart(f);
		await unansweredStart(f);
		f.at(3000); await f.service.presence(false, AT + 3000);
		f.at(5000); await f.beat();
		Object.assign(f.options, { sessionId: () => 'second-session' });
		const second = heldStart(f);
		f.at(6000); await unansweredStart(f);
		await first.land('saved'); await second.land('stale');
		f.at(10_000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', connection: 'disconnected' });
		expect(f.service.getRuntime()).toMatchObject({ lastPresenceAt: AT + 3000 });
		await f.service.dispose();
	});

	it('finding the start spends what was remembered: a start the store refuses after that session is over is not a reason to read again', async () => {
		const f = outage('late-start-found-forgotten');
		const start = heldStart(f);
		await unansweredStart(f);
		await start.land('saved');
		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session' });
		f.at(7000); await expect(f.service.stop(AT + 7000)).resolves.toBe(true);
		const load = vi.spyOn(f.store, 'loadLive');
		Object.assign(f.options, { sessionId: () => 'second-session' });
		vi.spyOn(f.store, 'saveLive').mockResolvedValueOnce({ status: 'stale' });
		f.at(8000); await expect(f.service.start('Test')).resolves.toBeNull();
		f.at(10_000); await f.beat();
		expect(load).not.toHaveBeenCalled();
		await f.service.dispose();
	});

	it('a report from before the start is not about it: only what arrives while the start is unaccounted for is kept', async () => {
		const f = outage('late-start-earlier-presence');
		await f.service.initialize();
		// Nothing is saved and no start is in course: this report is about no session at all.
		await f.service.presence(false, AT);
		const answer = f.answerNextCommitLate();
		f.at(1000); await unansweredStart(f);
		answer(); await turns();
		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', connection: 'connected' });
		await f.service.dispose();
	});

	it('two starts in a row that storage did not answer are both this host\'s: whichever lands is found as its own', async () => {
		const f = outage('two-late-starts');
		const first = heldStart(f);
		await unansweredStart(f);
		// The beat is told nothing is saved, so the next start is a new session, and its save is not answered either.
		f.at(5000); await f.beat();
		Object.assign(f.options, { sessionId: () => 'second-session' });
		const second = heldStart(f);
		f.at(6000); await unansweredStart(f);
		// The first one lands, and the second is refused by it.
		await first.land('saved'); await second.land('stale');
		f.at(10_000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'session', startedAt: iso(0), connection: 'connected' });
		for (let minute = 1; minute <= 12; minute += 1) { f.at(minute * 60_000); await f.beat(); }
		expect(f.service.getView()).toMatchObject({ phase: 'active', endedAt: null });
		expect(f.options.onComplete).not.toHaveBeenCalled();
		await f.service.dispose();
	});

	it('a session of another host found while a start is unaccounted for is not this host\'s start: it is taken over as after a restart', async () => {
		const f = outage('late-start-other-session');
		heldStart(f);
		await unansweredStart(f);
		// Another host starts a session of its own and goes away. This host's start never reaches storage.
		const other = f.restarted();
		f.at(2000); await expect(other.service.start('Test')).resolves.toBe('next-session');
		await other.dispose();
		f.at(5000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'next-session', connection: 'disconnected' });
		expect(f.service.getRuntime()).toMatchObject({ lastSourceDisconnectedAt: iso(2000), authority: { instanceId: 'host' } });
		await f.service.dispose();
	});

	it('a report held back from an earlier session is dropped when a start goes unanswered: it was never about that start', async () => {
		const f = outage('late-start-stale-presence');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		// The finish of the first session lands unseen, and the report that follows finds the session already closed:
		// nobody can write it, so it is held back, and no reclaim ever comes to spend it.
		f.dieAfterNextCommit();
		f.at(2000); await expect(f.service.stop(AT + 2000)).resolves.toBe(false);
		reviveStorage(f.tracked);
		f.at(3000); await f.service.presence(false, AT + 3000);
		f.at(5000); await f.beat();
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', summaryReceipt: { path: 'Sessions/live.md' } });

		Object.assign(f.options, { sessionId: () => 'second-session' });
		const second = heldStart(f);
		f.at(6000); await unansweredStart(f);
		await second.land('saved');
		f.at(10_000); await f.beat();
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'second-session', connection: 'connected' });
		expect(f.service.getRuntime()).toMatchObject({ lastPresenceAt: AT + 6000 });
		await f.service.dispose();
	});

	it('once something else is known to hold the place the unanswered start is forgotten: a later refusal is explained, and nothing is read again', async () => {
		const f = outage('late-start-forgotten-held');
		heldStart(f);
		await unansweredStart(f);
		const load = vi.spyOn(f.store, 'loadLive').mockResolvedValueOnce({ status: 'error', code: 'corrupt' });
		f.at(5000); await f.beat();
		expect(load).toHaveBeenCalledTimes(1);
		Object.assign(f.options, { sessionId: () => 'second-session' });
		vi.spyOn(f.store, 'saveLive').mockResolvedValueOnce({ status: 'stale' });
		f.at(6000); await expect(f.service.start('Test')).resolves.toBeNull();
		f.at(10_000); await f.beat();
		expect(load).toHaveBeenCalledTimes(1);
		await f.service.dispose();
	});

	it('and it is forgotten once a later start is saved: a refusal long after is not a reason to read again', async () => {
		const f = outage('late-start-forgotten-saved');
		heldStart(f);
		await unansweredStart(f);
		f.at(5000); await f.beat();
		Object.assign(f.options, { sessionId: () => 'second-session' });
		f.at(6000); await expect(f.service.start('Test')).resolves.toBe('second-session');
		f.at(7000); await expect(f.service.stop(AT + 7000)).resolves.toBe(true);
		const load = vi.spyOn(f.store, 'loadLive');
		Object.assign(f.options, { sessionId: () => 'third-session' });
		vi.spyOn(f.store, 'saveLive').mockResolvedValueOnce({ status: 'stale' });
		f.at(8000); await expect(f.service.start('Test')).resolves.toBeNull();
		f.at(10_000); await f.beat();
		expect(load).not.toHaveBeenCalled();
		await f.service.dispose();
	});
});

/**
 * The note writer has the same wait as storage, and a note can take longer than that to write. Each
 * attempt used to be a new call to the writer: `stop()` answered false, the session stayed closed
 * without its receipt, every beat started the writer again and gave it up ten seconds later, and no
 * new session could start, for as long as the writer kept taking that long.
 */
describe('live session whose note takes longer to write than the wait for it', () => {
	/** A session with one observation, and a writer that answers only when the returned `finish` is called. */
	async function closing(label: string) {
		const f = outage(label);
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		let finish: (path: string | null) => void = () => undefined; let fail: (error: Error) => void = () => undefined;
		f.options.onComplete.mockImplementationOnce(async () => await new Promise<string>((resolve, reject) => { finish = resolve as (path: string | null) => void; fail = reject; }));
		f.at(2000); const stopping = f.service.stop(AT + 2000);
		await vi.waitFor(() => { expect(f.options.onComplete).toHaveBeenCalledTimes(1); });
		return { f, stopping, finish: (path: string | null) => { finish(path); }, fail: (error: Error) => { fail(error); } };
	}
	/** One beat that has to wait for the writer and gives the wait up. */
	async function beatThatWaits(f: ReturnType<typeof outage>): Promise<void> {
		f.tick(); await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout(); await f.service.capture();
	}

	it('the writer is called once: later beats wait for that same attempt, the receipt is saved once it ends, and the next start works', async () => {
		const { f, stopping, finish } = await closing('slow-note');
		// The stop does not wait for ever: the note is not written yet, and it says so.
		expect(await settlement(stopping)).toBe('pending');
		await f.timeout();
		expect(await settlement(stopping), 'the wait for the note writer has a deadline').toBe('resolved');
		await expect(stopping).resolves.toBe(false);
		expect(f.service.getView()).toMatchObject({ phase: 'complete', endedAt: iso(2000) });
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', summaryReceipt: null });

		// Two beats go by while the writer is still at it, and a start is asked for: none of them calls it again.
		f.at(7000); await beatThatWaits(f);
		f.at(12_000); await beatThatWaits(f);
		const refused = f.service.start('Test');
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout();
		await expect(refused).resolves.toBeNull();
		expect(f.options.onComplete).toHaveBeenCalledTimes(1);
		expect((await f.durable()).record).toMatchObject({ summaryReceipt: null });

		// The writer ends between two beats, with nobody waiting. The next beat takes its answer and seals the session.
		finish('Sessions/slow.md'); await turns();
		f.at(17_000); await f.beat();
		expect(f.options.onComplete).toHaveBeenCalledTimes(1);
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', summaryReceipt: { path: 'Sessions/slow.md', savedAt: AT + 17_000 } });
		expect(f.service.getView().phase).toBe('complete');

		Object.assign(f.options, { sessionId: () => 'second-session' });
		f.at(18_000); await expect(f.service.start('Test')).resolves.toBe('second-session');
		expect(f.service.getView()).toMatchObject({ phase: 'active', sessionId: 'second-session' });
		await f.service.dispose();
	});

	it('the lease taken again while the writer is at it does not make it another note: the same attempt is waited for, and its answer is the receipt', async () => {
		const { f, stopping, finish } = await closing('slow-note-lease');
		await f.timeout();
		await expect(stopping).resolves.toBe(false);
		// Nobody renews the lease of a closed session: by the time the writer ends it has run out, and the beat takes it again.
		finish('Sessions/slow.md'); await turns();
		f.at(LEASE_TTL_MS + 10_000); await f.beat();
		expect(f.options.onComplete).toHaveBeenCalledTimes(1);
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', authority: { fence: 2 }, summaryReceipt: { path: 'Sessions/slow.md' } });
		await f.service.dispose();
	});

	it('a later revision of the note waits for the one being written and is then written itself: one note never gets the answer of another', async () => {
		const f = outage('slow-note-revisions');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		const entry = f.service.getJournal()[1]!; const id = entry.outbox[0]!.outboxId;
		await f.service.updateAlert(id, (prior) => decideLiveAlert(prior, entry.observations[0]!, 85, 'Item', iso(1000), false));
		await f.service.updateAlert(id, (prior) => ({ ...prior, state: 'dispatching', claimedAt: iso(1000), receipt: { state: 'pending' } }));
		f.at(2000); await expect(f.service.stop(AT + 2000)).resolves.toBe(true);
		expect(f.options.onComplete).toHaveBeenCalledTimes(1);

		// The alert is settled after the close, which rewrites the note; that rewrite takes longer than its wait.
		let finish: (path: string) => void = () => undefined;
		f.options.onComplete.mockImplementationOnce(async () => await new Promise<string>((resolve) => { finish = resolve; }));
		const settling = f.service.updateAlert(id, (prior) => ({ ...prior, state: 'processed' }), true);
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout(); await settling;
		expect(f.options.onComplete).toHaveBeenCalledTimes(2);
		// Its receipt arrives while that rewrite is still in course: a newer note, which waits its turn instead of starting a second writer.
		const receiving = f.service.updateAlert(id, (prior) => ({ ...prior, receipt: { state: 'received', client: 'nexus', atMs: AT + 3000 } }), true);
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout(); await receiving;
		expect(f.options.onComplete).toHaveBeenCalledTimes(2);
		// The rewrite ends. The next revision is written with what the session holds now, not answered with the old one's result.
		finish('Sessions/live.md'); await turns();
		await f.service.updateAlert(id, (prior) => ({ ...prior, deliveryReport: { delivered: ['queue'], failed: [], rejected: false } }), true);
		expect(f.options.onComplete).toHaveBeenCalledTimes(3);
		const written = (f.options.onComplete.mock.calls as unknown as [unknown, LiveJournalEntryV1[]][])[2]![1];
		expect(written[1]?.outbox[0]).toMatchObject({ state: 'processed', receipt: { state: 'received' }, deliveryReport: { delivered: ['queue'] } });
		await f.service.dispose();
	});

	it('a writer that fails after its wait ran out is reported by the beat that finds out, and asked again by the next', async () => {
		const { f, stopping, fail } = await closing('slow-note-fails');
		await f.timeout();
		await expect(stopping).resolves.toBe(false);
		fail(new Error('vault refused the note')); await turns();
		f.at(7000); await f.beat();
		expect(f.onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(['vault refused the note']);
		expect(f.options.onComplete).toHaveBeenCalledTimes(1);
		// That attempt is over, so this one is a new call, which the fixture's writer answers at once.
		f.at(12_000); await f.beat();
		expect(f.options.onComplete).toHaveBeenCalledTimes(2);
		expect((await f.durable()).record).toMatchObject({ phase: 'complete', summaryReceipt: { path: 'Sessions/live.md' } });
		expect(f.service.getView().phase).toBe('complete');
		await f.service.dispose();
	});
});

/**
 * The claim of an alert is a write of its own (`replaceLiveJournal`), with the same wait. When that
 * wait ran out the claim was answered as refused; if it had been written, memory said `ready`, disk
 * said `dispatching`, and every retry tried the same step against an entry that no longer matched.
 */
describe('live session whose alert claim storage did not answer', () => {
	it('a claim written while its wait ran out is read back from disk and is the claim: answered once, and a second claim finds nothing to take', async () => {
		const f = outage('late-claim');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		const entry = f.service.getJournal()[1]!; const intent = entry.outbox[0]!;
		await f.service.updateAlert(intent.outboxId, (prior) => decideLiveAlert(prior, entry.observations[0]!, 85, 'Item', iso(1000), false));
		expect(f.service.getAlerts()[0]?.state).toBe('ready');

		const answer = f.answerNextCommitLate();
		const claim = (at: number) => (prior: LiveAlertOutboxV1): LiveAlertOutboxV1 => prior.state === 'ready' ? { ...prior, state: 'dispatching', claimedAt: iso(at) } : prior;
		const claiming = f.service.updateAlert(intent.outboxId, claim(1000));
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		await f.timeout();
		await expect(claiming).resolves.toMatchObject({ outboxId: intent.outboxId, state: 'dispatching', claimedAt: iso(1000) });
		expect(f.service.getAlerts()[0]?.state).toBe('dispatching');
		expect(await f.store.readLiveJournalEntry('session', EPOCH, 1)).toEqual(f.service.getJournal()[1]);
		// The engine's own answer arrives now, to nobody; and the alert cannot be claimed a second time.
		answer(); await turns();
		f.at(2000); await expect(f.service.updateAlert(intent.outboxId, claim(2000))).resolves.toBeNull();
		expect((await f.durable()).journal[1]?.outbox[0]).toMatchObject({ state: 'dispatching', claimedAt: iso(1000) });

		await expect(f.store.readLiveJournalEntry('session', EPOCH, 99)).resolves.toBeNull();
		killStorage(f.tracked);
		await expect(f.store.readLiveJournalEntry('session', EPOCH, 1)).rejects.toThrow();
		reviveStorage(f.tracked); await f.service.dispose();
	});

	it('the read back has the same wait as every other call: unanswered, the claim stays refused and the queue goes on', async () => {
		const f = outage('late-claim-unread');
		await f.service.start('Test'); await f.service.open(f.source); await f.service.commit(f.sample(0, 0, bags(5)));
		f.at(1000); await f.service.commit(f.sample(1, 1000, bags(7)));
		const entry = f.service.getJournal()[1]!; const id = entry.outbox[0]!.outboxId;
		await f.service.updateAlert(id, (prior) => decideLiveAlert(prior, entry.observations[0]!, 85, 'Item', iso(1000), false));
		vi.spyOn(f.store, 'replaceLiveJournal').mockResolvedValueOnce(false);
		vi.spyOn(f.store, 'readLiveJournalEntry').mockImplementationOnce(async () => await new Promise<LiveJournalEntryV1 | null>(() => undefined));
		const claiming = f.service.updateAlert(id, (prior) => ({ ...prior, state: 'dispatching', claimedAt: iso(1000) }));
		await vi.waitFor(() => { expect(f.waiting()).toBe(1); });
		expect(await settlement(claiming)).toBe('pending');
		await f.timeout();
		expect(await settlement(claiming), 'the read back has a deadline').toBe('resolved');
		await expect(claiming).resolves.toBeNull();
		expect(f.service.getAlerts()[0]?.state).toBe('ready');
		expect(await settlement(f.service.capture())).toBe('resolved');
		await f.service.dispose();
	});
});

/** The addon's side of the bridge, one line per frame. */
class NexusSocket implements TyrianTcpConnection {
	readonly lines: Record<string, unknown>[] = [];
	private read: (chunk: Uint8Array) => void = () => {};
	private closed: () => void = () => {};
	private seq = 0;
	onData(listener: (chunk: Uint8Array) => void): void { this.read = listener; }
	onClose(listener: () => void): void { this.closed = listener; }
	onError(): void {}
	write(line: string): void { this.lines.push(JSON.parse(line) as Record<string, unknown>); }
	end(line?: string): void { if (line) this.write(line); this.closed(); }
	destroySoon(): void { this.closed(); }
	destroy(): void { this.closed(); }
	/** The game closed or the addon restarted its channel: the socket goes away. */
	drop(): void { this.closed(); }
	raw(frame: Record<string, unknown>): void { this.read(new TextEncoder().encode(`${JSON.stringify(frame)}\n`)); }
	send(type: string, fields: Record<string, unknown> = {}): void {
		this.raw({ v: 3, type, nonce: this.lines[0]?.nonce, seq: this.seq++, ...fields });
	}
	last(type: string): Record<string, unknown> | undefined { return this.lines.filter((line) => line.type === type).at(-1); }
}

describe('live session across a storage outage, through the real bridge', () => {
	it('the refused sample is acknowledged as not stored, the slot is not kept, and a reopened epoch brings the session back', async () => {
		const f = outage('bridge');
		let accept: (socket: TyrianTcpConnection) => void = () => {}; let random = 0;
		const server = await startAlertIngameServer({ listen: async (_port, _host, listener) => {
			accept = listener; return { address: '127.0.0.1', port: 47823, close: async () => {} };
		} }, 47823, { schedule: () => null, cancel: () => undefined }, {
			authenticate: () => true, fillRandom: (bytes) => { bytes.fill(++random); }, now: () => f.options.now(), onConnectionEvent: () => undefined,
			// The same three calls the core wires, on the production lifecycle and stores.
			live: {
				open: async (source) => await f.service.open(source),
				commit: async (sample) => await f.service.commit({ ...sample,
					rows: sample.rows.map(([kind, idNumber, quantity]) => ({ kind: kind === 0 ? 'item' as const : 'currency' as const, idNumber, quantity })) }),
				gap: async (event) => { await f.service.gap(event); },
				onError: f.onError,
			},
		});
		const connect = (): NexusSocket => {
			const socket = new NexusSocket(); accept(socket);
			socket.raw({ v: 3, type: 'hello', client: 'nexus', instance: INSTANCE, clientVersion: '1.0', token: 'x'.repeat(43) });
			socket.send('context', { state: 'gameplay', mapId: 866, character: 'Test' });
			return socket;
		};
		const open = async (socket: NexusSocket, epoch: string): Promise<unknown> => {
			socket.send('live_open', { tag: 'live1', epoch, build: NEXUS_LIVE_BUILD, profile: NEXUS_LIVE_PROFILE });
			await vi.waitFor(() => { expect(socket.last('live_ready')?.epoch).toBe(epoch); });
			return socket.last('live_ready')?.status;
		};
		const send = async (socket: NexusSocket, epoch: string, cursor: number, elapsedMs: number, quantity: number): Promise<unknown> => {
			socket.send('live_begin', { tag: 'live1', epoch, cursor, ctx: 0, ms: elapsedMs, mode: cursor === 0 ? 'baseline' : 'sample',
				items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 1 });
			socket.send('live_rows', { tag: 'live1', epoch, cursor, part: 0, rows: [[0, 12147, quantity]] });
			socket.send('live_end', { tag: 'live1', epoch, cursor });
			await vi.waitFor(() => { expect(socket.last('live_ack')).toMatchObject({ epoch, cursor }); });
			return socket.last('live_ack')?.status;
		};

		await f.service.start('Test');
		const first = connect();
		await expect(open(first, EPOCH)).resolves.toBe('ready');
		await expect(send(first, EPOCH, 0, 0, 5)).resolves.toBe('stored');
		f.at(1000); await expect(send(first, EPOCH, 1, 1000, 7)).resolves.toBe('stored');

		killStorage(f.tracked);
		f.at(2000); await expect(send(first, EPOCH, 2, 2000, 20)).resolves.toBe('storage_unavailable');
		expect(f.service.getView()).toMatchObject({ phase: 'error', observationCount: 1 });
		// The addon restarts its live channel, as the contract asks after a sample that was not stored.
		first.drop();
		f.at(3000); const second = connect();
		await expect(open(second, NEXT_EPOCH)).resolves.toBe('source_conflict');

		reviveStorage(f.tracked);
		// Had the bridge kept the first connection's slot for a gap it could never write, this open
		// would be refused for as long as the plugin lived.
		const third = 'BAQEBAQEBAQEBAQEBAQEBA';
		f.at(4000); await expect(open(second, third)).resolves.toBe('ready');
		f.at(5000); await expect(send(second, third, 0, 0, 50)).resolves.toBe('stored');
		f.at(6000); await expect(send(second, third, 1, 1000, 53)).resolves.toBe('stored');

		expect(f.service.getView()).toMatchObject({ phase: 'active', observedItemsMs: 2000 });
		expect(storageGaps(f.service)).toEqual([{ version: 1, reason: 'storage_unavailable', fromAt: iso(1000), toAt: iso(5000), channels: ['items'] }]);
		expect(f.service.getView().observations.map((row) => [row.before, row.after, row.delta])).toEqual([[5, 7, 2], [50, 53, 3]]);
		const durable = await f.durable();
		expect(durable.journal.flatMap((entry) => entry.observations)).toHaveLength(durable.record.observationCount);
		expect(f.onError).toHaveBeenCalledTimes(1);
		await server.close(); await f.service.dispose();
	});
});
