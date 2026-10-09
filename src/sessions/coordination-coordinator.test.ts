import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { closeUnderneath, emitEngineClose, killStorage, reviveStorage, settlement, trackedIndexedDb } from '../test/indexed-db-connections';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
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

	it('fails closed on a backwards clock and invalid persisted timestamps', async () => {
		const factory = new IDBFactory();
		let now = 1_000;
		const coordinator = createCoordinator(factory, 'clock', { clock: () => now });
		const handle = requireHandle(await coordinator.acquire('session-1'));
		now = 999;
		await expect(coordinator.assertOwned(handle)).resolves.toEqual({ status: 'error', code: 'clock_anomaly' });
		coordinator.dispose();
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
	// that beats on its own cadence (the live session, every five seconds) asks for a shorter lease.
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

/** The waits on storage a coordinator armed, run out only when the test says so. */
function manualWaits() {
	const waits = new Map<number, () => void>();
	let last = 0;
	return {
		arm: (callback: () => void): number => { waits.set(++last, callback); return last; },
		disarm: (handle: unknown): void => { waits.delete(handle as number); },
		pending: (): number => waits.size,
		expire: (): void => {
			const pending = [...waits.values()];
			waits.clear();
			for (const expire of pending) expire();
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
