import { describe, expect, it, vi } from 'vitest';

import { startAlertIngameServer } from '../alerts/alert-ingame-server';
import type { TyrianTcpConnection } from '../host/tyrian-host';
import { killStorage, killStorageAfterNextCommit, reviveStorage, trackedIndexedDb } from '../test/indexed-db-connections';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { NEXUS_LIVE_BUILD, NEXUS_LIVE_PROFILE, type LiveInventoryRowV1, type LiveInventorySampleV1, type LiveJournalEntryV1 } from './live-session-model';
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

function outage(label: string) {
	const tracked = trackedIndexedDb();
	let now = AT; let beat: (() => void) | null = null;
	const store = new IndexedDbSessionRuntimeStore(tracked.factory, `live-outage-${label}`);
	const lease = (instanceId: string): ActiveSessionLeaseCoordinator => new ActiveSessionLeaseCoordinator({
		indexedDb: tracked.factory, databaseName: `live-outage-${label}-lease`, instanceId, machineId: () => 'machine',
		clock: () => now, sleep: async () => undefined, leaseTtlMs: LEASE_TTL_MS, expiryConfirmDelayMs: 1,
	});
	const onError = vi.fn(); const onCommitted = vi.fn(); const onComplete = vi.fn(async () => 'Sessions/live.md');
	const options = { coordinator: lease('host'), persistence: store, enabled: () => true, now: () => now, sessionId: () => 'session',
		thresholdCopper: () => 1, setInterval: (callback: () => void) => { beat = callback; return 1; }, clearInterval: () => { beat = null; },
		onStateChange: vi.fn(), onError, onCommitted, onComplete };
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
		/** The engine applies the next write of the session store and dies before saying so. */
		dieAfterNextCommit: () => { killStorageAfterNextCommit(tracked, `live-outage-${label}`); },
		/** Another host starting on what is on disk now, as the next launch of the plugin would. */
		restarted: () => {
			const persistence = new IndexedDbSessionRuntimeStore(tracked.factory, `live-outage-${label}`); const failed = vi.fn();
			const next = new LiveSessionLifecycle({ ...options, coordinator: lease('next-host'), persistence, onError: failed,
				setInterval: () => 1, clearInterval: () => undefined });
			return { service: next, onError: failed, dispose: async () => { await next.dispose(); persistence.close(); } };
		},
		/** One heartbeat, awaited through the lifecycle's own queue. */
		beat: async () => { beat?.(); await service.capture(); },
		/** What a host starting now would find on disk, read through a connection of its own. */
		durable: async () => {
			const reader = new IndexedDbSessionRuntimeStore(tracked.factory, `live-outage-${label}`);
			const loaded = await reader.loadLive(); const journal = await reader.readLiveJournal('session'); reader.close();
			if (loaded.status !== 'loaded') throw new Error(`Expected a stored live session, found ${loaded.status}.`);
			return { record: loaded.record, journal };
		} };
}
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
