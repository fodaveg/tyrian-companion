import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { LocalDebugPersistenceProbe, type LocalDebugPersistenceEvent } from '../core/local-debug-persistence';
import { fakeLocks, type FakeLocks } from '../test/fake-lock-manager';
import { closeUnderneath, emitEngineClose, killStorage, reviveStorage, settlement, trackedIndexedDb } from '../test/indexed-db-connections';
import { ActiveSessionLeaseCoordinator, LIFE_LOCK_ANSWER_TIMEOUT_MS, type SessionLifeLocks } from './coordination-coordinator';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import {
	COORDINATION_STORE_NAME,
	IndexedDbCoordinationStore,
	type CoordinationStore,
	type CoordinationTransactionResult,
} from './coordination-store';

describe('ActiveSessionLeaseCoordinator', () => {
	it('acquires lazily and coalesces a concurrent double click', async () => {
		const factory = new IDBFactory();
		let opens = 0;
		const coordinator = createCoordinator(factory, 'double', {
			openStore: async () => {
				opens += 1;
				return IndexedDbCoordinationStore.open(factory, databaseName('double'));
			},
		});
		expect(opens).toBe(0);

		const first = coordinator.acquire('session-1');
		const second = coordinator.acquire('session-1');
		expect(second).toBe(first);
		const [left, right] = await Promise.all([first, second]);

		expect(left).toEqual(right);
		expect(left).toMatchObject({ status: 'acquired', handle: { fence: 1 } });
		expect(opens).toBe(1);
		coordinator.dispose();
	});

	it.each([
		['empty', ''],
		['overlong', 'x'.repeat(257)],
	])('rejects an %s instance id before opening or writing storage', async (_label, instanceId) => {
		let opens = 0;
		const coordinator = new ActiveSessionLeaseCoordinator({
			instanceId,
			machineId: () => 'machine-never-used',
			clock: () => 1_000,
			sleep: async () => undefined,
			openStore: async () => {
				opens += 1;
				throw new Error('Must not open.');
			},
		});

		await expect(coordinator.acquire('session-1')).resolves.toEqual({
			status: 'error',
			code: 'corrupt',
		});
		expect(opens).toBe(0);
		coordinator.dispose();
	});

	it('lets exactly one of two coordinators acquire the machine lease', async () => {
		const factory = new IDBFactory();
		const left = createCoordinator(factory, 'race', { instanceId: 'left' });
		const right = createCoordinator(factory, 'race', { instanceId: 'right' });
		const results = await Promise.all([left.acquire('session-left'), right.acquire('session-right')]);

		expect(results.map((result) => result.status).sort()).toEqual(['acquired', 'busy']);
		left.dispose();
		right.dispose();
	});

	it('keeps one effective session when the same coordinator receives concurrent intents', async () => {
		const factory = new IDBFactory();
		const coordinator = createCoordinator(factory, 'different-intents');
		const [first, second] = await Promise.all([
			coordinator.acquire('session-a'),
			coordinator.acquire('session-b'),
		]);

		expect(first.status).toBe('acquired');
		expect(second.status).toBe('already_owned');
		expect(requireHandle(second)).toEqual(requireHandle(first));
		expect(requireHandle(second)).toMatchObject({ sessionId: 'session-a', fence: 1 });
		coordinator.dispose();
	});

	it('is idempotent across connections sharing instance id even when session intent differs', async () => {
		const factory = new IDBFactory();
		const left = createCoordinator(factory, 'same-instance', { instanceId: 'shared-instance' });
		const right = createCoordinator(factory, 'same-instance', { instanceId: 'shared-instance' });
		const acquired = await left.acquire('session-1');
		const repeated = await right.acquire('session-2');

		expect(acquired.status).toBe('acquired');
		expect(repeated).toMatchObject({
			status: 'already_owned',
			handle: { fence: 1, sessionId: 'session-1' },
		});
		expect(requireHandle(repeated)).toEqual(requireHandle(acquired));
		left.dispose();
		right.dispose();
	});

	it('renews, asserts, releases, and preserves fencing against an old handle', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		const first = createCoordinator(factory, 'lifecycle', { clock: () => now, instanceId: 'first' });
		const acquired = await first.acquire('session-1');
		const handle = requireHandle(acquired);
		now = 1_010;
		const renewed = await first.renew(handle);
		const renewedHandle = requireHandle(renewed);
		await expect(first.assertOwned(renewedHandle)).resolves.toEqual({ status: 'owned' });
		await expect(first.release(renewedHandle)).resolves.toEqual({ status: 'released' });

		const second = createCoordinator(factory, 'lifecycle', { clock: () => now, instanceId: 'second' });
		const replacement = requireHandle(await second.acquire('session-2'));
		expect(replacement.fence).toBe(2);
		await expect(first.renew(handle)).resolves.toEqual({ status: 'lost' });
		await expect(first.release(handle)).resolves.toEqual({ status: 'lost' });
		await expect(second.assertOwned(replacement)).resolves.toEqual({ status: 'owned' });
		first.dispose();
		second.dispose();
	});

	it('recovers a crashed expired lease only after confirmation and increments fence', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		const crashed = createCoordinator(factory, 'recovery', { clock: () => now, instanceId: 'crashed', leaseTtlMs: 10 });
		expect(requireHandle(await crashed.acquire('session-old')).fence).toBe(1);
		crashed.dispose();
		now = 1_011;
		let sleeps = 0;
		const recovery = createCoordinator(factory, 'recovery', {
			clock: () => now,
			instanceId: 'recovery',
			leaseTtlMs: 10,
			sleep: async () => { sleeps += 1; },
		});

		const handle = requireHandle(await recovery.acquire('session-new'));
		expect(handle.fence).toBe(2);
		expect(sleeps).toBe(1);
		recovery.dispose();
	});

	it('does not steal when the old owner heartbeats during expiry confirmation', async () => {
		const factory = new IDBFactory();
		let ownerNow = 1_000;
		let contenderNow = 1_011;
		const owner = createCoordinator(factory, 'heartbeat-race', { clock: () => ownerNow, instanceId: 'owner', leaseTtlMs: 10 });
		const original = requireHandle(await owner.acquire('session-owner'));
		const contender = createCoordinator(factory, 'heartbeat-race', {
			clock: () => contenderNow,
			instanceId: 'contender',
			leaseTtlMs: 10,
			sleep: async () => {
				ownerNow = 1_009;
				await owner.renew(original);
				contenderNow = 1_012;
			},
		});

		expect(await contender.acquire('session-new')).toMatchObject({ status: 'busy' });
		owner.dispose();
		contender.dispose();
	});

	it('persists machine identity and fence counter across close and reopen', async () => {
		const factory = new IDBFactory();
		const first = createCoordinator(factory, 'reopen', { machineId: () => 'durable-machine' });
		const firstHandle = requireHandle(await first.acquire('session-1'));
		await first.release(firstHandle);
		first.dispose();
		const second = createCoordinator(factory, 'reopen', { machineId: () => 'must-not-replace' });
		const secondHandle = requireHandle(await second.acquire('session-2'));

		expect(secondHandle).toMatchObject({ machineId: 'durable-machine', fence: 2 });
		second.dispose();
	});

	// Since DU-09 a backwards wall clock is only an anomaly against what ANOTHER writer stored: this
	// instance's own lease is ordered by the monotonic clock (next test).
	it('fails closed on a lease another owner renewed ahead of this clock', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		const owner = createCoordinator(factory, 'clock', { clock: () => now, instanceId: 'owner' });
		const handle = requireHandle(await owner.acquire('session-1'));
		now = 999;
		const contender = createCoordinator(factory, 'clock', { clock: () => now, instanceId: 'contender' });
		const sameIdElsewhere = createCoordinator(factory, 'clock', { clock: () => now, instanceId: 'owner' });

		await expect(contender.acquire('session-2')).resolves.toEqual({ status: 'error', code: 'clock_anomaly' });
		// Another coordinator under the same id did not write that lease either: the wall clock judges it.
		await expect(sameIdElsewhere.assertOwned(handle)).resolves.toEqual({ status: 'error', code: 'clock_anomaly' });
		await expect(owner.assertOwned(handle)).resolves.toEqual({ status: 'owned' });
		owner.dispose();
		contender.dispose();
		sameIdElsewhere.dispose();
	});

	// DU-09 (10 Oct 2026): a wall clock set back 30 s under a live session left it in error until the
	// clock passed the stored `renewedAt` again, plus whichever retry came next.
	it('keeps its own lease through a wall clock that steps back 30 s mid-session', async () => {
		const factory = new IDBFactory();
		let wall = 1_000_000;
		let monotonic = 0;
		const owner = createCoordinator(factory, 'wall steps back', {
			clock: () => wall, monotonicClock: () => monotonic, instanceId: 'owner', leaseTtlMs: 300_000,
		});
		const acquired = requireHandle(await owner.acquire('session-1'));
		wall += 100_000; monotonic += 100_000;
		const beforeStep = requireHandle(await owner.renew(acquired));
		wall -= 30_000; monotonic += 1_000;

		const afterStep = await owner.renew(beforeStep);
		expect(afterStep).toMatchObject({ status: 'renewed' });
		const renewed = requireHandle(afterStep);
		// What is stored for one lease never goes back, so it stays a valid lease for whoever reads it.
		expect(renewed.renewedAt).toBeGreaterThanOrEqual(beforeStep.renewedAt);
		expect(renewed.expiresAt).toBeGreaterThan(renewed.renewedAt);
		await expect(owner.assertOwned(renewed)).resolves.toEqual({ status: 'owned' });
		wall += 5_000; monotonic += 5_000;
		await expect(owner.acquire('session-1')).resolves.toEqual({ status: 'already_owned', handle: renewed });
		await expect(owner.release(renewed)).resolves.toEqual({ status: 'released' });
		await expect(owner.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		owner.dispose();
	});

	it('still shows another owner a lease its owner renewed across the step as renewed ahead of it', async () => {
		const factory = new IDBFactory();
		let wall = 1_000_000;
		let monotonic = 0;
		const owner = createCoordinator(factory, 'step seen by another', {
			clock: () => wall, monotonicClock: () => monotonic, instanceId: 'owner', leaseTtlMs: 300_000,
		});
		const acquired = requireHandle(await owner.acquire('session-1'));
		wall -= 30_000; monotonic += 10_000;
		const renewed = requireHandle(await owner.renew(acquired));
		const contender = createCoordinator(factory, 'step seen by another', { clock: () => wall, instanceId: 'contender' });

		expect(renewed.renewedAt).toBe(acquired.renewedAt);
		await expect(contender.acquire('session-2')).resolves.toEqual({ status: 'error', code: 'clock_anomaly' });
		owner.dispose();
		contender.dispose();
	});

	it('runs its own lease out on the monotonic clock when the wall clock was set back, and takes it again through the fence', async () => {
		const factory = new IDBFactory();
		let wall = 1_000_000;
		let monotonic = 0;
		const owner = createCoordinator(factory, 'monotonic deadline', {
			clock: () => wall, monotonicClock: () => monotonic, instanceId: 'owner', leaseTtlMs: 300_000,
		});
		const acquired = requireHandle(await owner.acquire('session-1'));
		// Five minutes without a beat, during which the wall clock was set back 30 s.
		wall += 300_000 - 30_000; monotonic += 300_000;

		await expect(owner.assertOwned(acquired)).resolves.toEqual({ status: 'lost' });
		await expect(owner.renew(acquired)).resolves.toEqual({ status: 'lost' });
		// Not `already_owned` with the handle it has just been told it lost.
		const retaken = await owner.acquire('session-1');
		expect(retaken).toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		// The lease taken back through the second transaction is this instance's own too: another step back is no anomaly for it.
		wall -= 30_000; monotonic += 1_000;
		await expect(owner.assertOwned(requireHandle(retaken))).resolves.toEqual({ status: 'owned' });
		owner.dispose();
	});

	// H18.7: a host that slept past its lease finds it lost, although the monotonic clock may not have moved.
	it('finds its own lease lost when the wall clock passed it while the monotonic clock stood still', async () => {
		const factory = new IDBFactory();
		let wall = 1_000_000;
		const owner = createCoordinator(factory, 'slept', {
			clock: () => wall, monotonicClock: () => 0, instanceId: 'owner', leaseTtlMs: 300_000,
		});
		const acquired = requireHandle(await owner.acquire('session-1'));
		wall += 300_000;

		await expect(owner.assertOwned(acquired)).resolves.toEqual({ status: 'lost' });
		await expect(owner.renew(acquired)).resolves.toEqual({ status: 'lost' });
		owner.dispose();
	});

	// The lease remembered as this instance's is the one a transaction COMMITTED: a renewal or a release whose
	// mutator ran but whose transaction aborted leaves it as it was.
	it.each([
		['renewal', (owner: ActiveSessionLeaseCoordinator, handle: ActiveSessionLeaseHandle) => owner.renew(handle)],
		['release', (owner: ActiveSessionLeaseCoordinator, handle: ActiveSessionLeaseHandle) => owner.release(handle)],
	])('keeps the committed lease as its own when a %s aborts after its mutator ran', async (_label, operation) => {
		const factory = new IDBFactory();
		const inner = await IndexedDbCoordinationStore.open(factory, databaseName(`aborted ${_label}`));
		let abortNext = false;
		const store: CoordinationStore = {
			read: (context) => inner.read(context),
			transaction: async (mutator, context) => {
				if (!abortNext) return await inner.transaction(mutator, context);
				abortNext = false;
				mutator(await inner.read(context));
				throw new Error('aborted');
			},
			close: () => { inner.close(); },
		};
		let wall = 1_000_000;
		let monotonic = 0;
		const owner = createCoordinator(factory, `aborted ${_label}`, {
			store, clock: () => wall, monotonicClock: () => monotonic, instanceId: 'owner', leaseTtlMs: 300_000,
		});
		const acquired = requireHandle(await owner.acquire('session-1'));
		wall += 10_000; monotonic += 10_000;
		abortNext = true;
		await expect(operation(owner, acquired)).resolves.toEqual({ status: 'error', code: 'unavailable' });
		wall -= 30_000; monotonic += 1_000;

		// Still this instance's own lease, so the wall clock set back is no anomaly for it.
		await expect(owner.assertOwned(acquired)).resolves.toEqual({ status: 'owned' });
		owner.dispose();
	});

	it('answers clock_anomaly when the monotonic clock goes back or is not a number', async () => {
		const factory = new IDBFactory();
		let monotonic = 10;
		const owner = createCoordinator(factory, 'monotonic back', { monotonicClock: () => monotonic, instanceId: 'owner' });
		const acquired = requireHandle(await owner.acquire('session-1'));
		monotonic = 9;
		await expect(owner.renew(acquired)).resolves.toEqual({ status: 'error', code: 'clock_anomaly' });
		monotonic = Number.NaN;
		await expect(owner.assertOwned(acquired)).resolves.toEqual({ status: 'error', code: 'clock_anomaly' });
		owner.dispose();
	});

	it.each([
		['corrupt record', { version: 1, machineId: '', fenceCounter: 1, lease: null }],
		['unknown schema', { version: 2, machineId: 'machine', fenceCounter: 1, lease: null }],
		['fence overflow', { version: 1, machineId: 'machine', fenceCounter: Number.MAX_SAFE_INTEGER, lease: null }],
	])('fails closed on %s', async (_label, state) => {
		const factory = new IDBFactory();
		const name = databaseName(`invalid-${_label}`);
		await writeRaw(factory, name, state);
		const coordinator = createCoordinator(factory, `invalid-${_label}`);
		const result = await coordinator.acquire('session-1');

		expect(result.status).toBe('error');
		if (_label === 'fence overflow') expect(result).toEqual({ status: 'error', code: 'fence_overflow' });
		coordinator.dispose();
	});

	it('never throws when opening or transactions fail and has no memory fallback', async () => {
		const coordinator = new ActiveSessionLeaseCoordinator({
			instanceId: 'instance',
			machineId: () => 'machine',
			clock: () => 1_000,
			sleep: async () => undefined,
			openStore: async () => { throw new Error('open failed'); },
		});

		await expect(coordinator.acquire('session-1')).resolves.toEqual({ status: 'error', code: 'unavailable' });
		coordinator.dispose();
	});

	// 7 Oct 2026: with the engine no longer answering, the lease could not be renewed, and it stayed
	// that way after the engine came back because nothing opened a second connection.
	it('renews the lease on a new connection after the cached one was closed underneath it', async () => {
		const tracked = trackedIndexedDb();
		const coordinator = createCoordinator(tracked.factory, 'closed underneath');
		const handle = requireHandle(await coordinator.acquire('session-1'));
		closeUnderneath(tracked.connections[0]!);

		await expect(coordinator.renew(handle)).resolves.toMatchObject({ status: 'renewed' });
		await expect(coordinator.assertOwned(handle)).resolves.toEqual({ status: 'owned' });
		expect(tracked.connections).toHaveLength(2);
		coordinator.dispose();
	});

	it('forgets the connection on the engine close event and after a versionchange that is not an upgrade', async () => {
		const tracked = trackedIndexedDb();
		const name = databaseName('engine close');
		const store = await IndexedDbCoordinationStore.open(tracked.factory, name);
		const dead = vi.spyOn(tracked.connections[0]!, 'transaction');
		emitEngineClose(tracked.connections[0]!);
		await expect(store.read()).resolves.toBeUndefined();
		expect(dead).not.toHaveBeenCalled();
		expect(tracked.connections).toHaveLength(2);

		await new Promise<void>((resolve, reject) => {
			const request = tracked.factory.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error ?? new Error('delete failed'));
		});
		await expect(store.read()).resolves.toBeUndefined();
		expect(tracked.connections).toHaveLength(3);
		store.close();
	});

	it('never opens again after a real upgrade by another context', async () => {
		const tracked = trackedIndexedDb();
		const name = databaseName('upgrade is final');
		const store = await IndexedDbCoordinationStore.open(tracked.factory, name);
		const upgraded = await openRaw(tracked.factory, name, 2);
		const opened = tracked.connections.length;

		await expect(store.read()).rejects.toThrow('Coordination storage is unavailable.');
		await expect(store.transaction(() => ({ result: null }))).rejects.toThrow('Coordination storage is unavailable.');
		expect(tracked.connections).toHaveLength(opened);
		upgraded.close();
	});

	it('gives each lease operation one reopen while storage is down, and recovers when it is back', async () => {
		const tracked = trackedIndexedDb();
		const coordinator = createCoordinator(tracked.factory, 'down');
		const handle = requireHandle(await coordinator.acquire('session-1'));
		killStorage(tracked);
		const open = vi.spyOn(tracked.factory, 'open');

		await expect(coordinator.renew(handle)).resolves.toEqual({ status: 'error', code: 'unavailable' });
		expect(open).toHaveBeenCalledTimes(1);
		reviveStorage(tracked);
		await expect(coordinator.renew(handle)).resolves.toMatchObject({ status: 'renewed' });
		coordinator.dispose();
	});

	it('does not keep a failed first open: the next operation opens again', async () => {
		const factory = new IDBFactory();
		let opens = 0;
		const coordinator = new ActiveSessionLeaseCoordinator({
			instanceId: 'instance', machineId: () => 'machine', clock: () => 1_000, sleep: async () => undefined,
			openStore: async () => {
				opens += 1;
				if (opens === 1) throw new Error('open failed');
				return await IndexedDbCoordinationStore.open(factory, databaseName('failed first open'));
			},
		});

		await expect(coordinator.acquire('session-1')).resolves.toEqual({ status: 'error', code: 'unavailable' });
		await expect(coordinator.acquire('session-1')).resolves.toMatchObject({ status: 'acquired' });
		expect(opens).toBe(2);
		coordinator.dispose();
	});

	it('fails closed after dispose', async () => {
		const factory = new IDBFactory();
		const coordinator = createCoordinator(factory, 'dispose');
		coordinator.dispose();
		await expect(coordinator.acquire('session-1')).resolves.toEqual({ status: 'error', code: 'disposed' });
	});

	it('samples acquisition time after a delayed store open', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		let openStore: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => { openStore = resolve; });
		const coordinator = new ActiveSessionLeaseCoordinator({
			instanceId: 'delayed-instance',
			machineId: () => 'delayed-machine',
			clock: () => now,
			leaseTtlMs: 100,
			expiryConfirmDelayMs: 1,
			sleep: async () => undefined,
			openStore: async () => {
				await gate;
				return IndexedDbCoordinationStore.open(factory, databaseName('delayed-open'));
			},
		});
		const acquiring = coordinator.acquire('session-1');
		now = 5_000;
		openStore?.();
		const handle = requireHandle(await acquiring);

		expect(handle).toMatchObject({ acquiredAt: 5_000, renewedAt: 5_000, expiresAt: 5_100 });
		coordinator.dispose();
	});

	it('never renews or asserts an expired handle after delayed storage work', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		const rawStore = await IndexedDbCoordinationStore.open(factory, databaseName('delayed-operations'));
		const controlled = new ControlledCoordinationStore(rawStore);
		const coordinator = new ActiveSessionLeaseCoordinator({
			store: controlled,
			instanceId: 'delayed-operations-instance',
			machineId: () => 'delayed-operations-machine',
			clock: () => now,
			leaseTtlMs: 100,
			expiryConfirmDelayMs: 1,
			sleep: async () => undefined,
		});
		const handle = requireHandle(await coordinator.acquire('session-1'));
		controlled.beforeTransaction = async () => { now = 1_101; };
		await expect(coordinator.renew(handle)).resolves.toEqual({ status: 'lost' });
		controlled.beforeTransaction = undefined;
		controlled.beforeRead = async () => { now = 1_102; };
		await expect(coordinator.assertOwned(handle)).resolves.toEqual({ status: 'lost' });
		coordinator.dispose();
	});

	// H14.22: the default is five minutes and the manual session's heartbeat derives from it. A caller
	// may ask for another length; nobody asks for a shorter one today (see `LIVE_SESSION_LEASE_TTL_MS`).
	it('grants and renews a lease for as long as the caller asks, and for five minutes when it does not ask', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		const coordinator = new ActiveSessionLeaseCoordinator({
			indexedDb: factory, databaseName: databaseName('lease length'), instanceId: 'instance', machineId: () => 'machine',
			clock: () => now, sleep: async () => undefined,
		});
		const short = requireHandle(await coordinator.acquire('session-live', 30_000));
		expect(short).toMatchObject({ acquiredAt: 1_000, expiresAt: 31_000 });
		now = 6_000;
		const renewed = await coordinator.renew(short, 30_000);
		expect(renewed).toMatchObject({ status: 'renewed', handle: { renewedAt: 6_000, expiresAt: 36_000 } });
		await coordinator.release(requireHandle(renewed));

		const standard = requireHandle(await coordinator.acquire('session-manual'));
		expect(standard.expiresAt - standard.renewedAt).toBe(300_000);
		now = 7_000;
		expect(await coordinator.renew(standard)).toMatchObject({ status: 'renewed', handle: { renewedAt: 7_000, expiresAt: 307_000 } });
		await expect(coordinator.acquire('session-other', 0)).resolves.toEqual({ status: 'error', code: 'corrupt' });
		await expect(coordinator.renew(standard, -1)).resolves.toEqual({ status: 'error', code: 'corrupt' });
		coordinator.dispose();
	});

	it('keeps one lease for both lengths: a short lease excludes another owner exactly as a long one, only for less time', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		const options = { indexedDb: factory, databaseName: databaseName('one lease'), machineId: () => 'machine', clock: () => now, sleep: async () => undefined };
		const live = new ActiveSessionLeaseCoordinator({ ...options, instanceId: 'live-host' });
		const other = new ActiveSessionLeaseCoordinator({ ...options, instanceId: 'other-host' });
		requireHandle(await live.acquire('session-live', 30_000));
		now = 30_999;
		await expect(other.acquire('session-manual')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'live-host', ownerExpiresAt: 31_000 });
		now = 31_000;
		const taken = requireHandle(await other.acquire('session-manual'));
		expect(taken).toMatchObject({ instanceId: 'other-host', fence: 2, expiresAt: 331_000 });
		// And the other way round: the long lease is not shortened by somebody asking for a short one.
		now = 200_000;
		await expect(live.acquire('session-live', 30_000)).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'other-host' });
		live.dispose(); other.dispose();
	});

	// 9 Oct 2026: one transaction the engine never answered held this queue for the rest of the
	// plugin's life, and behind it every lease operation of the manual and of the live session.
	it('answers unavailable when the store does not answer in time, and serves the next operation', async () => {
		const factory = new IDBFactory();
		const controlled = new ControlledCoordinationStore(await IndexedDbCoordinationStore.open(factory, databaseName('unanswered')));
		const waits = manualWaits();
		const coordinator = new ActiveSessionLeaseCoordinator({
			store: controlled, instanceId: 'instance', machineId: () => 'machine', clock: () => 1_000, sleep: async () => undefined,
			schedule: waits.arm, cancel: waits.disarm,
		});
		const handle = requireHandle(await coordinator.acquire('session-1'));
		controlled.beforeTransaction = () => new Promise<void>(() => undefined);
		const renewing = coordinator.renew(handle);
		const asserting = coordinator.assertOwned(handle);
		expect(await settlement(renewing)).toBe('pending');
		expect(await settlement(asserting)).toBe('pending');

		waits.expire();
		await expect(renewing).resolves.toEqual({ status: 'error', code: 'unavailable' });
		// The read queued behind it was only waiting for its turn.
		await expect(asserting).resolves.toEqual({ status: 'owned' });
		controlled.beforeTransaction = undefined;
		await expect(coordinator.renew(handle)).resolves.toMatchObject({ status: 'renewed' });
		expect(waits.pending()).toBe(0);
		coordinator.dispose();
	});

	it('does nothing more with an acquisition whose store answers after its wait ran out', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		// Another instance left a lease that has expired: taking it is two transactions with a pause between them.
		const other = createCoordinator(factory, 'late answer', { instanceId: 'other', clock: () => now });
		requireHandle(await other.acquire('session-other'));
		now = 5_000;
		const raw = await IndexedDbCoordinationStore.open(factory, databaseName('late answer'));
		const controlled = new ControlledCoordinationStore(raw);
		const waits = manualWaits();
		const sleep = vi.fn(async () => undefined);
		const coordinator = new ActiveSessionLeaseCoordinator({
			store: controlled, instanceId: 'instance', machineId: () => 'machine', clock: () => now, sleep,
			leaseTtlMs: 100, expiryConfirmDelayMs: 1, schedule: waits.arm, cancel: waits.disarm,
		});
		let answer: () => void = () => undefined;
		controlled.beforeTransaction = () => new Promise<void>((resolve) => { answer = resolve; });
		const acquiring = coordinator.acquire('session-1');
		expect(await settlement(acquiring)).toBe('pending');
		waits.expire();
		await expect(acquiring).resolves.toEqual({ status: 'error', code: 'unavailable' });

		// The first transaction is let through only now, and reports the lease it found expired.
		controlled.beforeTransaction = undefined;
		answer();
		await vi.waitFor(() => { expect(controlled.transactions).toBe(1); });
		await raw.read(); await raw.read();
		// Nobody was waiting for that answer: no pause, no second transaction, and the lease is not taken.
		expect(sleep).not.toHaveBeenCalled();
		expect(controlled.transactions).toBe(1);
		expect(await raw.read()).toMatchObject({ fenceCounter: 1, lease: { instanceId: 'other', sessionId: 'session-other' } });
		// The next acquisition is a whole one of its own.
		await expect(coordinator.acquire('session-1')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		coordinator.dispose(); other.dispose();
	});

	it('does not keep an open that never answers: the next operation opens again and the store that arrives late is closed', async () => {
		const factory = new IDBFactory();
		let opens = 0;
		let arrive: (store: CoordinationStore) => void = () => undefined;
		const never = new Promise<CoordinationStore>((resolve) => { arrive = resolve; });
		const waits = manualWaits();
		const coordinator = new ActiveSessionLeaseCoordinator({
			instanceId: 'instance', machineId: () => 'machine', clock: () => 1_000, sleep: async () => undefined,
			schedule: waits.arm, cancel: waits.disarm,
			openStore: async () => {
				opens += 1;
				return opens === 1 ? await never : await IndexedDbCoordinationStore.open(factory, databaseName('unanswered open'));
			},
		});
		const first = coordinator.acquire('session-1');
		expect(await settlement(first)).toBe('pending');
		waits.expire();
		await expect(first).resolves.toEqual({ status: 'error', code: 'unavailable' });
		await expect(coordinator.acquire('session-1')).resolves.toMatchObject({ status: 'acquired' });
		expect(opens).toBe(2);

		const late = await IndexedDbCoordinationStore.open(factory, databaseName('unanswered open'));
		const close = vi.spyOn(late, 'close');
		arrive(late);
		await vi.waitFor(() => { expect(close).toHaveBeenCalledTimes(1); });
		coordinator.dispose();
	});
});

/**
 * 9 Oct 2026 (F7): a host that died holding the lease left the one that came back refused its own
 * session for up to five minutes. With the host's lock manager the owner holds one Web Lock for as
 * long as it lives and says so in its `instanceId` (`wl1:`); a lease that has not run out is taken
 * when its owner carries that mark, its lock is free and it has gone 15 s without renewing.
 * Everything else waits for the lease to run out, exactly as before: what matters most here is that
 * an owner that is alive is never taken.
 *
 * `wl1:` and the lock's name are written out on purpose. Both are read by whatever build comes back
 * to a lease, so they are a format, not an implementation detail. So are the 15 s: every test here
 * runs on the real lease of five minutes, the owner takes it at `BORN`, and `SILENT` is the first
 * instant at which its silence is long enough.
 */
describe('ActiveSessionLeaseCoordinator with the host\'s lock manager', () => {
	const TTL = 300_000;
	const BORN = 1_000;
	const SILENT = BORN + 15_000;
	const RUN_OUT = BORN + TTL;
	const fiveMinutes = (factory: IDBFactory, label: string, overrides: Parameters<typeof createCoordinator>[2] = {}): ActiveSessionLeaseCoordinator =>
		createCoordinator(factory, label, { leaseTtlMs: TTL, ...overrides });

	it('takes the lease of a marked owner that died before it ran out: one pause, the next fence, and the old handle is lost', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, 'dead owner', { instanceId: 'owner', locks: ownerContext, clock: () => now });
		const original = requireHandle(await owner.acquire('session-1'));
		expect(original).toMatchObject({ instanceId: 'wl1:owner', fence: 1, expiresAt: RUN_OUT });
		expect(owner.instanceId).toBe('wl1:owner');
		expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:owner']);
		// The process is gone: nothing was released and nothing disposed of.
		ownerContext.die();
		let sleeps = 0;
		const contender = fiveMinutes(factory, 'dead owner', { instanceId: 'contender', locks: locks.context(), clock: () => now, sleep: async () => { sleeps += 1; } });

		// 70 s later the lease has 230 s left, and is taken anyway.
		now = BORN + 70_000;
		const taken = await contender.acquire('session-1');
		expect(taken).toMatchObject({ status: 'acquired', handle: { instanceId: 'wl1:contender', sessionId: 'session-1', fence: 2, acquiredAt: BORN + 70_000, expiresAt: BORN + 70_000 + TTL } });
		expect(sleeps).toBe(1);
		await expect(owner.renew(original)).resolves.toEqual({ status: 'lost' });
		await expect(owner.assertOwned(original)).resolves.toEqual({ status: 'lost' });
		await expect(owner.release(original)).resolves.toEqual({ status: 'lost' });
		await expect(contender.assertOwned(requireHandle(taken))).resolves.toEqual({ status: 'owned' });
		owner.dispose(); contender.dispose();
	});

	// The second condition, by the clock that judges whether the lease ran out and counted from the
	// owner's last renewal, not from when it took the lease.
	it('waits for a dead owner that renewed less than 15 s ago, and takes it at 15 s: one millisecond decides', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, 'silence', { instanceId: 'owner', locks: ownerContext, clock: () => now });
		const original = requireHandle(await owner.acquire('session-1'));
		now = BORN + 60_000;
		const renewed = requireHandle(await owner.renew(original));
		expect(renewed).toMatchObject({ acquiredAt: BORN, renewedAt: BORN + 60_000 });
		ownerContext.die();
		const sleep = vi.fn(async () => undefined);
		const contender = fiveMinutes(factory, 'silence', { instanceId: 'contender', locks: locks.context(), clock: () => now, sleep });

		// A minute after it took the lease, and not a millisecond after it last renewed: its lock is free and it waits.
		await expect(contender.acquire('session-1')).resolves.toEqual({ status: 'busy', ownerExpiresAt: BORN + 60_000 + TTL, ownerInstanceId: 'wl1:owner', ownerMachineId: 'machine-silence' });
		now = BORN + 60_000 + 14_000;
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'wl1:owner' });
		now = BORN + 60_000 + 14_999;
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'wl1:owner' });
		// Refused without the pause or the second transaction: nothing was confirmed.
		expect(sleep).not.toHaveBeenCalled();
		await expect(owner.assertOwned(renewed)).resolves.toEqual({ status: 'owned' });
		now = BORN + 60_000 + 15_000;
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'acquired', handle: { instanceId: 'wl1:contender', fence: 2 } });
		expect(sleep).toHaveBeenCalledTimes(1);
		owner.dispose(); contender.dispose();
	});

	// 10 Oct 2026: the plugin reloaded with the wall clock set back found its dead predecessor's lease renewed «in the future»
	// and answered clock_anomaly to every acquisition, so the addon was turned away although nobody held the session.
	it('takes at once the lease of a marked owner that died, even when its stamp is ahead of this clock', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN + 60_000;
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, 'ahead dead', { instanceId: 'owner', locks: ownerContext, clock: () => now });
		const original = requireHandle(await owner.acquire('session-1'));
		ownerContext.die();
		now = BORN + 30_000;
		const contender = fiveMinutes(factory, 'ahead dead', { instanceId: 'contender', locks: locks.context(), clock: () => now, sleep: async () => undefined });
		const taken = await contender.acquire('session-2');
		expect(taken).toMatchObject({ status: 'acquired', handle: { instanceId: 'wl1:contender', sessionId: 'session-2', fence: 2 } });
		await expect(owner.assertOwned(original)).resolves.toEqual({ status: 'lost' });
		await expect(contender.assertOwned(requireHandle(taken))).resolves.toEqual({ status: 'owned' });
		owner.dispose(); contender.dispose();
	});

	it('keeps answering clock_anomaly to a lease renewed ahead whose owner is alive', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN + 60_000;
		const owner = fiveMinutes(factory, 'ahead alive', { instanceId: 'owner', locks: locks.context(), clock: () => now });
		await owner.acquire('session-1');
		now = BORN + 30_000;
		const contender = fiveMinutes(factory, 'ahead alive', { instanceId: 'contender', locks: locks.context(), clock: () => now, sleep: async () => undefined });
		await expect(contender.acquire('session-2')).resolves.toEqual({ status: 'error', code: 'clock_anomaly' });
		owner.dispose(); contender.dispose();
	});

	it('does not take a marked owner that is alive until its lease runs out', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const owner = fiveMinutes(factory, 'live owner', { instanceId: 'owner', locks: locks.context(), clock: () => now });
		const original = requireHandle(await owner.acquire('session-1'));
		const sleep = vi.fn(async () => undefined);
		const contender = fiveMinutes(factory, 'live owner', { instanceId: 'contender', locks: locks.context(), clock: () => now, sleep });

		now = SILENT;
		await expect(contender.acquire('session-2')).resolves.toEqual({ status: 'busy', ownerExpiresAt: RUN_OUT, ownerInstanceId: 'wl1:owner', ownerMachineId: 'machine-live owner' });
		now = RUN_OUT - 1;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'wl1:owner' });
		// No pause, no second transaction: nothing was shown, so nothing was confirmed.
		expect(sleep).not.toHaveBeenCalled();
		await expect(owner.assertOwned(original)).resolves.toEqual({ status: 'owned' });
		// Run out, it is taken as any lease that ran out: its owner is still alive and still holds its lock.
		now = RUN_OUT;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { instanceId: 'wl1:contender', fence: 2 } });
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:contender', 'tyrian-companion-lease:wl1:owner']);
		owner.dispose(); contender.dispose();
	});

	it('never takes an owner without the mark before its lease runs out, whoever asks', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		// A build before this one, or a host without the API: no lock, no mark, and no way to tell it from a dead one.
		const owner = fiveMinutes(factory, 'unmarked owner', { instanceId: 'owner', clock: () => now });
		expect(requireHandle(await owner.acquire('session-1')).instanceId).toBe('owner');
		expect(locks.held()).toEqual([]);
		const contender = fiveMinutes(factory, 'unmarked owner', { instanceId: 'contender', locks: locks.context(), clock: () => now });

		now = RUN_OUT - 1;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'owner', ownerExpiresAt: RUN_OUT });
		now = RUN_OUT;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		owner.dispose(); contender.dispose();
	});

	it('a contender without a lock manager waits for a marked owner\'s lease to run out, even when that owner is dead', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, 'contender without locks', { instanceId: 'owner', locks: ownerContext, clock: () => now });
		requireHandle(await owner.acquire('session-1'));
		ownerContext.die();
		const contender = fiveMinutes(factory, 'contender without locks', { instanceId: 'contender', clock: () => now });

		now = RUN_OUT - 1;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'wl1:owner' });
		now = RUN_OUT;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { instanceId: 'contender', fence: 2 } });
		owner.dispose(); contender.dispose();
	});

	// The deliberate negative: the lock manager says «free» of an owner that is alive and has been silent
	// for long enough (its timers held back). The exact lease is still compared after the pause, and an
	// owner that renewed meanwhile keeps it.
	it('does not take an owner that renews during the confirmation, even when the lock manager calls its lock free', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const owner = fiveMinutes(factory, 'lying manager', { instanceId: 'owner', locks: locks.context(), clock: () => now });
		let current = requireHandle(await owner.acquire('session-1'));
		let renewDuringPause = true;
		const sleep = vi.fn(async () => {
			if (!renewDuringPause) return;
			now += 5;
			current = requireHandle(await owner.renew(current));
		});
		const recorded = recordedDecisions();
		const contender = fiveMinutes(factory, 'lying manager', { instanceId: 'contender', locks: locks.context(), clock: () => now, sleep, diagnostics: recorded.probe });
		// Its own lock is shown to be held while the manager is still honest; from here on it lies.
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy' });
		locks.ifAvailable = 'always free';

		now = SILENT;
		const refused = await contender.acquire('session-2');
		// Refused under the lease as its owner left it in the pause, not as it was first read.
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(current).toMatchObject({ renewedAt: SILENT + 5, expiresAt: SILENT + 5 + TTL });
		expect(refused).toEqual({ status: 'busy', ownerExpiresAt: SILENT + 5 + TTL, ownerInstanceId: 'wl1:owner', ownerMachineId: 'machine-lying manager' });
		await expect(owner.assertOwned(current)).resolves.toEqual({ status: 'owned' });
		expect(current.fence).toBe(1);
		// And having just renewed, the same lie does not even get as far as the pause.
		renewDuringPause = false;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy' });
		expect(sleep).toHaveBeenCalledTimes(1);

		// What neither condition covers, pinned so nobody reads more into them: the same lie about an
		// owner that is alive, silent for 15 s again and does not renew in the pause takes its lease.
		// That is why the host only hands over a lock manager every context of its storage shares.
		now = SILENT + 5 + 15_000;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		await expect(owner.assertOwned(current)).resolves.toEqual({ status: 'lost' });
		// And the log of that host reads as what happened: an owner shown to be gone that wrote in the pause.
		expect(recorded.decisions().filter((decision) => decision.operation === 'recover').map((decision) => decision.detail)).toEqual([
			{ result: 'refused', reason: 'lease_changed_in_confirmation' },
			{ result: 'refused', reason: 'owner_renewed_recently', retryAfterMs: '15000' },
			{ result: 'taken', reason: 'owner_lock_free' },
		]);
		owner.dispose(); contender.dispose();
	});

	it.each(['unanswered', 'rejects', 'throws'] as const)('answers busy when asking about the dead owner\'s lock %s, and takes the lease only once it ran out', async (failure) => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const waits = manualWaits();
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, `probe ${failure}`, { instanceId: 'owner', locks: ownerContext, clock: () => now });
		requireHandle(await owner.acquire('session-1'));
		const sleep = vi.fn(async () => undefined);
		const contender = fiveMinutes(factory, `probe ${failure}`, {
			instanceId: 'contender', locks: locks.context(), clock: () => now, sleep, schedule: waits.arm, cancel: waits.disarm,
		});
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy' });
		ownerContext.die();
		locks.ifAvailable = failure;

		// Dead, marked and silent for long enough: only the answer about its lock is missing.
		now = SILENT;
		const acquiring = contender.acquire('session-2');
		if (failure === 'unanswered') {
			await vi.waitFor(() => { expect(waits.lockWaits()).toBe(1); });
			expect(await settlement(acquiring)).toBe('pending');
			waits.expire();
		}
		await expect(acquiring).resolves.toEqual({ status: 'busy', ownerExpiresAt: RUN_OUT, ownerInstanceId: 'wl1:owner', ownerMachineId: `machine-probe ${failure}` });
		expect(sleep).not.toHaveBeenCalled();
		expect(waits.pending()).toBe(0);
		// The way it always was: the lease runs out and is taken, without anybody asking about a lock.
		now = RUN_OUT;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		owner.dispose(); contender.dispose();
	});

	it('writes no mark when its own lock is not granted in time, and lets the lock go when it is granted late', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const waits = manualWaits();
		// Somebody else holds the name this instance asks for, so its request waits.
		const blocker = locks.context();
		void blocker.request('tyrian-companion-lease:wl1:late', () => new Promise<void>(() => undefined));
		const late = fiveMinutes(factory, 'late lock', { instanceId: 'late', locks: locks.context(), clock: () => now, schedule: waits.arm, cancel: waits.disarm });
		expect(late.instanceId).toBe('wl1:late');

		const acquiring = late.acquire('session-1');
		await vi.waitFor(() => { expect(waits.lockWaits()).toBe(1); });
		expect(await settlement(acquiring)).toBe('pending');
		waits.expire();
		const handle = requireHandle(await acquiring);
		expect(handle).toMatchObject({ instanceId: 'late', fence: 1 });
		expect(late.instanceId).toBe('late');
		// The lock arrives after all: it is let go at once, and the instance stays unmarked for good.
		blocker.die();
		await vi.waitFor(() => { expect(locks.held()).toEqual([]); });
		now = BORN + 10;
		await expect(late.renew(handle)).resolves.toMatchObject({ status: 'renewed', handle: { instanceId: 'late' } });

		// And an instance that can ask finds an owner without the mark, holding no lock and silent for
		// minutes: it is not taken before it runs out.
		const contender = fiveMinutes(factory, 'late lock', { instanceId: 'contender', locks: locks.context(), clock: () => now });
		now = RUN_OUT + 9;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'late', ownerExpiresAt: RUN_OUT + 10 });
		now = RUN_OUT + 10;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { instanceId: 'wl1:contender', fence: 2 } });
		late.dispose(); contender.dispose();
	});

	it('writes no mark when the lock manager never grants a lock at all', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		locks.grants = false;
		const waits = manualWaits();
		const coordinator = createCoordinator(factory, 'no grants', { instanceId: 'alone', locks: locks.context(), schedule: waits.arm, cancel: waits.disarm });

		const acquiring = coordinator.acquire('session-1');
		await vi.waitFor(() => { expect(waits.lockWaits()).toBe(1); });
		expect(await settlement(acquiring)).toBe('pending');
		waits.expire();
		expect(requireHandle(await acquiring).instanceId).toBe('alone');
		expect(waits.pending()).toBe(0);
		// Decided once: the next acquisition does not wait for the lock again.
		await expect(coordinator.acquire('session-1')).resolves.toMatchObject({ status: 'already_owned', handle: { instanceId: 'alone' } });
		coordinator.dispose();
	});

	// What lets any of this be checked on a real client: the local diagnostic log says what the instance
	// is and what it did with each owner whose lock it did not find held. Outcomes and reasons, no ids.
	it.each([
		['its lock was granted and seen held', (_locks: FakeLocks): void => undefined, { phase: 'success', code: 'ok', detail: { state: 'life_lock_proven' } }, 'wl1:alone'],
		['its lock is never granted', (locks: FakeLocks): void => { locks.grants = false; }, { phase: 'skip', code: 'unavailable', detail: { state: 'life_lock_unmarked', reason: 'lock_not_granted' } }, 'alone'],
		['the manager calls its own held lock free', (locks: FakeLocks): void => { locks.ifAvailable = 'always free'; }, { phase: 'skip', code: 'unavailable', detail: { state: 'life_lock_unmarked', reason: 'lock_not_seen_held' } }, 'alone'],
	] as const)('records once what the instance is when %s', async (_case, arrange, outcome, instanceId) => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		arrange(locks);
		const waits = manualWaits(); const recorded = recordedDecisions();
		const coordinator = fiveMinutes(factory, `recorded ${outcome.detail.state} ${outcome.code}`, {
			instanceId: 'alone', locks: locks.context(), schedule: waits.arm, cancel: waits.disarm, diagnostics: recorded.probe,
		});
		expect(recorded.decisions()).toEqual([]);

		const acquiring = coordinator.acquire('session-1');
		if (!locks.grants) { await vi.waitFor(() => { expect(waits.lockWaits()).toBe(1); }); waits.expire(); }
		expect(requireHandle(await acquiring).instanceId).toBe(instanceId);
		await expect(coordinator.acquire('session-1')).resolves.toMatchObject({ status: 'already_owned' });
		expect(recorded.decisions()).toEqual([{ operation: 'open', ...outcome }]);
		coordinator.dispose();
	});

	it('records once that an instance without a lock manager has no life lock', async () => {
		const factory = new IDBFactory(); const recorded = recordedDecisions();
		const coordinator = fiveMinutes(factory, 'recorded absent', { instanceId: 'alone', diagnostics: recorded.probe });

		requireHandle(await coordinator.acquire('session-1'));
		await expect(coordinator.acquire('session-1')).resolves.toMatchObject({ status: 'already_owned' });
		expect(recorded.decisions()).toEqual([{ operation: 'open', phase: 'skip', code: 'skipped', detail: { state: 'life_lock_absent' } }]);
		coordinator.dispose();
	});

	it('records each lease it takes from a dead owner and each one it leaves to an owner whose lock it did not find held, once per lease and reason', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, 'recorded takeover', { instanceId: 'owner', locks: ownerContext, clock: () => now });
		requireHandle(await owner.acquire('session-1'));
		const recorded = recordedDecisions();
		const contender = fiveMinutes(factory, 'recorded takeover', { instanceId: 'contender', locks: locks.context(), clock: () => now, diagnostics: recorded.probe });
		const proven = { operation: 'open', phase: 'success', code: 'ok', detail: { state: 'life_lock_proven' } };

		// Alive and holding its lock: an ordinary busy, which whoever asked records for itself.
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy' });
		expect(recorded.decisions()).toEqual([proven]);
		ownerContext.die();
		now = BORN + 1;
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy' });
		now = BORN + 5_000;
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy' });
		const recently = { operation: 'recover', phase: 'skip', code: 'precondition_failed', detail: { result: 'refused', reason: 'owner_renewed_recently', retryAfterMs: '14999' } };
		expect(recorded.decisions()).toEqual([proven, recently]);
		locks.ifAvailable = 'rejects';
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy' });
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy' });
		const unanswered = { operation: 'recover', phase: 'skip', code: 'unavailable', detail: { result: 'refused', reason: 'owner_lock_unanswered' } };
		expect(recorded.decisions()).toEqual([proven, recently, unanswered]);
		locks.ifAvailable = 'honest';
		now = SILENT;
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		expect(recorded.decisions()).toEqual([proven, recently, unanswered, { operation: 'recover', phase: 'success', code: 'ok', detail: { result: 'taken', reason: 'owner_lock_free' } }]);
		// Nothing of what was recorded names an instance, a session or a machine, the store's own attempts included.
		expect(JSON.stringify(recorded.events)).not.toMatch(/wl1:|contender|session-1|machine-/u);
		owner.dispose(); contender.dispose();
	});

	// A manager that cannot even take the request must not stop the plugin loading: the coordinator is
	// built in the runtime's own start, and an exception there is a plugin that does not start.
	it.each(['throws', 'rejects'] as const)('is built all the same when asking for its own lock %s, and works without the mark', async (failure) => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		locks.waiting = failure;
		const waits = manualWaits();
		const coordinator = fiveMinutes(factory, `own lock ${failure}`, { instanceId: 'alone', locks: locks.context(), schedule: waits.arm, cancel: waits.disarm });
		expect(coordinator.instanceId).toBe('wl1:alone');

		const acquiring = coordinator.acquire('session-1');
		// Known as soon as the request said so, with no wait left to run out.
		await vi.waitFor(() => { expect(coordinator.instanceId).toBe('alone'); });
		expect(waits.lockWaits()).toBe(0);
		expect(requireHandle(await acquiring)).toMatchObject({ instanceId: 'alone', fence: 1 });
		expect(locks.held()).toEqual([]);
		coordinator.dispose();
	});

	// The invariant at its barest: no lease under a marked id without that instance's lock granted. A
	// manager that answers every callback with `null` grants nothing, and asked afterwards says «held» of
	// a lock nobody has: only the callback itself can tell.
	it('writes no mark under a manager that answers everything with null, although it then calls the lock held', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		locks.waiting = 'null'; locks.ifAvailable = 'always held';
		const waits = manualWaits(); const recorded = recordedDecisions();
		const coordinator = fiveMinutes(factory, 'null manager', {
			instanceId: 'alone', locks: locks.context(), schedule: waits.arm, cancel: waits.disarm, diagnostics: recorded.probe,
		});

		const handle = requireHandle(await coordinator.acquire('session-1'));
		expect(handle).toMatchObject({ instanceId: 'alone', fence: 1 });
		expect(coordinator.instanceId).toBe('alone');
		expect(locks.held()).toEqual([]);
		expect(recorded.decisions()).toEqual([{ operation: 'open', phase: 'skip', code: 'unavailable', detail: { state: 'life_lock_unmarked', reason: 'lock_not_granted' } }]);
		coordinator.dispose();
	});

	// The owner's silence is judged at the instant that judged its lease, not at whatever the clock says
	// once the lock manager has answered: the two can be a second apart, and that second can be the fifteenth.
	it('measures the owner\'s silence with the clock of the first transaction, not with the clock after asking about its lock', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, 'silence clock', { instanceId: 'owner', locks: ownerContext, clock: () => now });
		requireHandle(await owner.acquire('session-1'));
		// A lock manager that takes a second of this host's clock to answer whether a lock is free.
		const context = locks.context();
		const slow = { request: (...parameters: unknown[]): unknown => {
			if (typeof parameters[1] !== 'function') now += 1_000;
			return (context.request as (...all: unknown[]) => unknown)(...parameters);
		} } as SessionLifeLocks;
		const sleep = vi.fn(async () => undefined);
		const contender = fiveMinutes(factory, 'silence clock', { instanceId: 'contender', locks: slow, clock: () => now, sleep });
		// Its own lock is shown held first (that question costs its second too), with the owner still alive.
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy' });
		ownerContext.die();

		now = BORN + 14_999;
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'wl1:owner' });
		// The answer came at 15 999 ms of silence and was judged by the 14 999 the lease was read at.
		expect(now).toBe(BORN + 15_999);
		expect(sleep).not.toHaveBeenCalled();
		await expect(contender.acquire('session-1')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		owner.dispose(); contender.dispose();
	});

	it('answers disposed, not unavailable, to an acquisition it was disposed of while waiting for its lock', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		locks.grants = false;
		const waits = manualWaits();
		let opens = 0;
		const coordinator = new ActiveSessionLeaseCoordinator({
			instanceId: 'alone', machineId: () => 'machine', clock: () => 1_000, sleep: async () => undefined, locks: locks.context(),
			schedule: waits.arm, cancel: waits.disarm,
			openStore: async () => { opens += 1; return await IndexedDbCoordinationStore.open(factory, databaseName('disposed waiting')); },
		});

		const acquiring = coordinator.acquire('session-1');
		await vi.waitFor(() => { expect(waits.lockWaits()).toBe(1); });
		coordinator.dispose();
		waits.expire();
		await expect(acquiring).resolves.toEqual({ status: 'error', code: 'disposed' });
		expect(opens).toBe(0);
	});

	// The check at run time: a manager that offers this instance's own lock while it is held cannot be
	// believed about anybody else's. `always free` is what contexts that do not share their locks look like.
	it.each(['always free', 'unanswered', 'rejects', 'throws'] as const)('writes no mark, lets its lock go and asks about nobody when the manager, asked about its own lock, answers «%s»', async (answer) => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const waits = manualWaits();
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, `self check ${answer}`, { instanceId: 'owner', locks: ownerContext, clock: () => now });
		requireHandle(await owner.acquire('session-1'));
		ownerContext.die();
		locks.ifAvailable = answer;
		const sleep = vi.fn(async () => undefined);
		const unsure = fiveMinutes(factory, `self check ${answer}`, {
			instanceId: 'unsure', locks: locks.context(), clock: () => now, sleep, schedule: waits.arm, cancel: waits.disarm,
		});
		expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:unsure']);

		now = SILENT;
		const acquiring = unsure.acquire('session-2');
		if (answer === 'unanswered') {
			await vi.waitFor(() => { expect(waits.lockWaits()).toBe(1); });
			expect(await settlement(acquiring)).toBe('pending');
			waits.expire();
		}
		// The owner is dead, marked and silent for long enough, and this instance still waits for its lease to run out.
		await expect(acquiring).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'wl1:owner' });
		expect(unsure.instanceId).toBe('unsure');
		expect(locks.held()).toEqual([]);
		expect(sleep).not.toHaveBeenCalled();
		// Not even once the manager behaves: what an instance is was decided before its first lease.
		locks.ifAvailable = 'honest';
		now = RUN_OUT - 1;
		await expect(unsure.acquire('session-2')).resolves.toMatchObject({ status: 'busy' });
		now = RUN_OUT;
		await expect(unsure.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { instanceId: 'unsure', fence: 2 } });
		owner.dispose(); unsure.dispose();
	});

	it('lets its lock go on dispose, so a lease it left behind without releasing it is taken once it has been silent for 15 s', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const owner = fiveMinutes(factory, 'disposed owner', { instanceId: 'owner', locks: locks.context(), clock: () => now });
		requireHandle(await owner.acquire('session-1'));
		const contender = fiveMinutes(factory, 'disposed owner', { instanceId: 'contender', locks: locks.context(), clock: () => now });
		now = SILENT;
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'busy' });

		owner.dispose();
		await vi.waitFor(() => { expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:contender']); });
		await expect(contender.acquire('session-2')).resolves.toMatchObject({ status: 'acquired', handle: { fence: 2 } });
		contender.dispose();
		await vi.waitFor(() => { expect(locks.held()).toEqual([]); });
	});

	it('keeps its lock until an operation that was in course when it was disposed of has ended', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		const controlled = new ControlledCoordinationStore(await IndexedDbCoordinationStore.open(factory, databaseName('dispose in course')));
		const owner = new ActiveSessionLeaseCoordinator({
			store: controlled, instanceId: 'owner', machineId: () => 'machine', clock: () => 1_000, sleep: async () => undefined, leaseTtlMs: 100, locks: locks.context(),
		});
		const handle = requireHandle(await owner.acquire('session-1'));
		let answer: (() => void) | null = null;
		controlled.beforeTransaction = () => new Promise<void>((resolve) => { answer = resolve; });
		const renewing = owner.renew(handle);
		await vi.waitFor(() => { expect(answer).not.toBeNull(); });

		owner.dispose();
		expect(await settlement(renewing)).toBe('pending');
		expect(locks.held()).toEqual(['tyrian-companion-lease:wl1:owner']);
		(answer as (() => void) | null)?.();
		await expect(renewing).resolves.toMatchObject({ status: 'error' });
		await vi.waitFor(() => { expect(locks.held()).toEqual([]); });
	});

	it('lets at most one of two contenders take a dead owner\'s lease', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		let now = BORN;
		const ownerContext = locks.context();
		const owner = fiveMinutes(factory, 'two contenders', { instanceId: 'owner', locks: ownerContext, clock: () => now });
		requireHandle(await owner.acquire('session-1'));
		ownerContext.die();
		now = SILENT;
		const left = fiveMinutes(factory, 'two contenders', { instanceId: 'left', locks: locks.context(), clock: () => now });
		const right = fiveMinutes(factory, 'two contenders', { instanceId: 'right', locks: locks.context(), clock: () => now });

		const results = await Promise.all([left.acquire('session-left'), right.acquire('session-right')]);
		expect(results.map((result) => result.status).sort()).toEqual(['acquired', 'busy']);
		expect(results.find((result) => result.status === 'acquired')).toMatchObject({ handle: { fence: 2 } });
		owner.dispose(); left.dispose(); right.dispose();
	});

	it('refuses an id that carries the mark without a lock behind it, before opening or writing storage', async () => {
		let opens = 0;
		const forged = new ActiveSessionLeaseCoordinator({
			instanceId: 'wl1:forged', machineId: () => 'machine', clock: () => 1_000, sleep: async () => undefined,
			openStore: async () => { opens += 1; throw new Error('Must not open.'); },
		});

		await expect(forged.acquire('session-1')).resolves.toEqual({ status: 'error', code: 'corrupt' });
		expect(opens).toBe(0);
		forged.dispose();
	});

	it('asks for no lock when the id would not fit with the mark in front, and works unmarked', async () => {
		const factory = new IDBFactory(); const locks = fakeLocks();
		const instanceId = 'x'.repeat(254);
		const coordinator = createCoordinator(factory, 'long id', { instanceId, locks: locks.context() });

		expect(locks.held()).toEqual([]);
		expect(requireHandle(await coordinator.acquire('session-1')).instanceId).toBe(instanceId);
		coordinator.dispose();
	});
});

describe('IndexedDbCoordinationStore', () => {
	it('rejects an open error without creating a fallback store', async () => {
		const factory = new IDBFactory();
		const name = databaseName('open-error');
		const newer = await openRaw(factory, name, 2);
		newer.close();

		await expect(IndexedDbCoordinationStore.open(factory, name, 1)).rejects.toThrow('Could not open');
	});

	it('rejects a blocked upgrade and closes its late successful connection', async () => {
		const factory = new IDBFactory();
		const name = databaseName('blocked');
		const blocker = await openRaw(factory, name, 1);
		const blocked = IndexedDbCoordinationStore.open(factory, name, 2);
		await expect(blocked).rejects.toThrow('blocked');
		blocker.close();

		const upgraded = await openRaw(factory, name, 3);
		expect(upgraded.version).toBe(3);
		upgraded.close();
	});

	it('closes on versionchange and rejects later transactions', async () => {
		const factory = new IDBFactory();
		const name = databaseName('versionchange');
		const store = await IndexedDbCoordinationStore.open(factory, name);
		const upgraded = await openRaw(factory, name, 2);
		await expect(store.read()).rejects.toBeDefined();
		upgraded.close();
	});

	it('reports an aborted readwrite transaction through an event-faithful harness', async () => {
		let transaction: Partial<IDBTransaction> | undefined;
		const database = {
			transaction: () => {
				const request = { result: undefined } as Partial<IDBRequest>;
				transaction = {
					objectStore: () => ({
						get: () => request,
						put: () => ({}),
					}) as unknown as IDBObjectStore,
					abort: () => undefined,
				};
				queueMicrotask(() => {
					request.onsuccess?.call(request as IDBRequest, new Event('success'));
					transaction?.onabort?.call(transaction as IDBTransaction, new Event('abort'));
				});
				return transaction as IDBTransaction;
			},
			close: () => undefined,
		} as unknown as IDBDatabase;
		const store = new IndexedDbCoordinationStore(database);

		await expect(store.transaction(() => ({
			result: 'never',
			nextState: { version: 1, machineId: 'machine', fenceCounter: 0, lease: null },
		}))).rejects.toThrow('aborted');
	});
});

function createCoordinator(
	factory: IDBFactory,
	label: string,
	overrides: Partial<ConstructorParameters<typeof ActiveSessionLeaseCoordinator>[0]> = {},
): ActiveSessionLeaseCoordinator {
	return new ActiveSessionLeaseCoordinator({
		indexedDb: factory,
		databaseName: databaseName(label),
		instanceId: `instance-${label}`,
		machineId: () => `machine-${label}`,
		clock: () => 1_000,
		// Still unless a test moves it: leases of 10 ms judged by the real `performance.now()` would run out
		// on a slow machine between two awaits, and these tests are about the wall clock.
		monotonicClock: () => 0,
		sleep: async () => undefined,
		leaseTtlMs: 100,
		expiryConfirmDelayMs: 1,
		...overrides,
	});
}

function requireHandle(result: { status: string; handle?: ActiveSessionLeaseHandle }): ActiveSessionLeaseHandle {
	if (!result.handle) throw new Error(`Expected a lease handle, received ${result.status}.`);
	return result.handle;
}

function databaseName(label: string): string {
	return `tyrian-companion-coordination-test-${label.replaceAll(' ', '-')}`;
}

async function writeRaw(factory: IDBFactory, name: string, value: unknown): Promise<void> {
	const database = await openRaw(factory, name, 1);
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction(COORDINATION_STORE_NAME, 'readwrite');
		transaction.objectStore(COORDINATION_STORE_NAME).put(value, 'active-session-state');
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
	});
	database.close();
}

function openRaw(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(COORDINATION_STORE_NAME)) {
				request.result.createObjectStore(COORDINATION_STORE_NAME);
			}
		};
		request.onerror = () => reject(request.error ?? new Error('open failed'));
		request.onsuccess = () => resolve(request.result);
	});
}

/**
 * A diagnostics probe that keeps everything it is told, and what the coordinator itself decided out of
 * it: what the instance is, and each takeover it made or declined. The store's own reads and writes go
 * through the same probe and are left out of `decisions`.
 */
function recordedDecisions() {
	const events: LocalDebugPersistenceEvent[] = [];
	return {
		events,
		probe: new LocalDebugPersistenceProbe({ sink: (event) => { events.push(event); } }),
		decisions: () => events
			.filter((event) => event.phase !== 'start' && (event.operation === 'recover' || event.detail?.state !== undefined))
			.map(({ operation, phase, code, detail }) => ({ operation, phase, code, detail })),
	};
}

/**
 * The waits a coordinator armed, on storage and on the lock manager alike, run out only when the test
 * says so. `lockWaits` is how many of them are for an answer of the lock manager, told apart by how long they were armed for.
 */
function manualWaits() {
	const waits = new Map<number, { expire: () => void; milliseconds: number }>();
	let last = 0;
	return {
		arm: (callback: () => void, milliseconds: number): number => { waits.set(++last, { expire: callback, milliseconds }); return last; },
		disarm: (handle: unknown): void => { waits.delete(handle as number); },
		pending: (): number => waits.size,
		lockWaits: (): number => [...waits.values()].filter((wait) => wait.milliseconds === LIFE_LOCK_ANSWER_TIMEOUT_MS).length,
		expire: (): void => {
			const pending = [...waits.values()];
			waits.clear();
			for (const wait of pending) wait.expire();
		},
	};
}

class ControlledCoordinationStore implements CoordinationStore {
	beforeTransaction?: () => Promise<void>;
	beforeRead?: () => Promise<void>;
	/** Transactions that reached the store behind this one, held ones included once let through. */
	transactions = 0;

	constructor(private readonly delegate: CoordinationStore) {}

	async read(): Promise<unknown> {
		await this.beforeRead?.();
		return this.delegate.read();
	}

	async transaction<T>(
		mutator: (current: unknown) => CoordinationTransactionResult<T>,
	): Promise<T> {
		await this.beforeTransaction?.();
		this.transactions += 1;
		return this.delegate.transaction(mutator);
	}

	close(): void {
		this.delegate.close();
	}
}
