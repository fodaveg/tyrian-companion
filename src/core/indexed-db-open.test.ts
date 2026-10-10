import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import {
	IndexedDbConnectionLostError,
	ReopeningIndexedDbConnection,
	indexedDbFailureCode,
	openIndexedDb,
	startIndexedDbTransaction,
	withIndexedDbReopen,
	type IndexedDbOpenFailureReason,
	type IndexedDbVersionChangeKind,
} from './indexed-db-open';
import { closeUnderneath, emitEngineClose, engineIdle, hangStorage, holdNextOpen, trackedIndexedDb, type TrackedIndexedDb } from '../test/indexed-db-connections';

/**
 * The shared open handshake, proved once instead of ten times.
 *
 * The schema half is easy and was never where the bugs were. The half worth
 * testing is the race: a request that has already rejected can still fire
 * `onsuccess`, and the connection it hands over blocks the next version upgrade
 * forever if nobody closes it. Every store used to carry its own `settled` flag
 * for this, so the cases below are the ones that were only ever covered in some
 * of the copies.
 */
let sequence = 0;
function databaseName(label: string): string {
	sequence += 1;
	return `indexed-db-open-${label}-${sequence}`;
}

/** `DOMStringList` is not iterable under this lib target, so it is read by index. */
function names(list: DOMStringList): string[] {
	return Array.from({ length: list.length }, (_unused, index) => list.item(index) ?? '');
}

function openRaw(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onsuccess = () => {
			request.result.onversionchange = () => request.result.close();
			resolve(request.result);
		};
		request.onerror = () => reject(request.error ?? new Error('open failed'));
	});
}

describe('openIndexedDb', () => {
	it('creates every declared store, key path and index exactly once', async () => {
		const factory = new IDBFactory();
		const name = databaseName('schema');
		const database = await openIndexedDb({
			factory,
			databaseName: name,
			databaseVersion: 1,
			schema: [
				{ name: 'plain' },
				{ name: 'keyed', keyPath: ['vaultId', 'itemId'] },
				{
					name: 'indexed',
					keyPath: 'id',
					indexes: [{ name: 'by-observed', keyPath: ['vaultId', 'observedAt'] }],
				},
			],
			toError: () => new Error('unused'),
		});

		expect(names(database.objectStoreNames).sort()).toEqual(['indexed', 'keyed', 'plain']);
		const transaction = database.transaction(['plain', 'keyed', 'indexed'], 'readonly');
		expect(transaction.objectStore('plain').keyPath).toBeNull();
		expect(transaction.objectStore('keyed').keyPath).toEqual(['vaultId', 'itemId']);
		expect(transaction.objectStore('indexed').keyPath).toBe('id');
		expect(names(transaction.objectStore('indexed').indexNames)).toEqual(['by-observed']);
		database.close();
	});

	it('leaves an existing store untouched when reopening at the same version', async () => {
		const factory = new IDBFactory();
		const name = databaseName('idempotent');
		const schema = [{ name: 'records', keyPath: 'id' }];
		const first = await openIndexedDb({
			factory, databaseName: name, databaseVersion: 1, schema, toError: () => new Error('unused'),
		});
		await new Promise<void>((resolve, reject) => {
			const transaction = first.transaction('records', 'readwrite');
			transaction.objectStore('records').put({ id: 'kept' });
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('write failed'));
		});
		first.close();

		const second = await openIndexedDb({
			factory, databaseName: name, databaseVersion: 1, schema, toError: () => new Error('unused'),
		});
		const stored = await new Promise<unknown>((resolve, reject) => {
			const request = second.transaction('records', 'readonly').objectStore('records').get('kept');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('read failed'));
		});
		expect(stored).toEqual({ id: 'kept' });
		second.close();
	});

	it('reports a blocked upgrade as blocked, apart from a plain error', async () => {
		const factory = new IDBFactory();
		const name = databaseName('blocked');
		// A connection that ignores versionchange is exactly what blocks an upgrade.
		const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(name, 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('open failed'));
		});

		const reasons: IndexedDbOpenFailureReason[] = [];
		await expect(openIndexedDb({
			factory,
			databaseName: name,
			databaseVersion: 2,
			schema: [{ name: 'records' }],
			toError: (reason) => { reasons.push(reason); return new Error(reason); },
		})).rejects.toThrow('blocked');
		expect(reasons).toEqual(['blocked']);
		blocker.close();
	});

	it('closes the connection that arrives after the attempt already failed', async () => {
		const factory = new IDBFactory();
		const name = databaseName('late');
		const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(name, 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('open failed'));
		});

		await expect(openIndexedDb({
			factory,
			databaseName: name,
			databaseVersion: 2,
			schema: [{ name: 'records' }],
			toError: (reason) => new Error(reason),
		})).rejects.toThrow('blocked');
		blocker.close();

		// If the rejected v2 request had leaked its connection, this upgrade would hang.
		const third = await openRaw(factory, name, 3);
		expect(third.version).toBe(3);
		third.close();
	});

	it('refuses and closes a database the caller no longer wants', async () => {
		const factory = new IDBFactory();
		const name = databaseName('refused');
		const reasons: IndexedDbOpenFailureReason[] = [];

		await expect(openIndexedDb({
			factory,
			databaseName: name,
			databaseVersion: 1,
			schema: [{ name: 'records' }],
			accept: () => false,
			toError: (reason) => { reasons.push(reason); return new Error(reason); },
		})).rejects.toThrow('refused');
		expect(reasons).toEqual(['refused']);

		// The refused connection was closed, so a later upgrade is not blocked by it.
		const upgraded = await openRaw(factory, name, 2);
		expect(upgraded.version).toBe(2);
		upgraded.close();
	});

	it('hands the accept hook the database so it can inspect the stores it got', async () => {
		const factory = new IDBFactory();
		const seen: string[][] = [];
		const database = await openIndexedDb({
			factory,
			databaseName: databaseName('accept-sees'),
			databaseVersion: 1,
			schema: [{ name: 'records' }],
			accept: (candidate) => { seen.push(names(candidate.objectStoreNames)); return true; },
			toError: () => new Error('unused'),
		});
		expect(seen).toEqual([['records']]);
		database.close();
	});

	it('closes on versionchange and runs the bookkeeping callback after closing', async () => {
		const factory = new IDBFactory();
		const name = databaseName('versionchange');
		const order: string[] = [];
		const database = await openIndexedDb({
			factory,
			databaseName: name,
			databaseVersion: 1,
			schema: [{ name: 'records' }],
			onVersionChange: () => order.push('callback'),
			toError: () => new Error('unused'),
		});

		const upgraded = await openRaw(factory, name, 2);
		expect(upgraded.version).toBe(2);
		expect(order).toEqual(['callback']);
		expect(() => database.transaction('records', 'readonly')).toThrow();
		upgraded.close();
	});

	/**
	 * Omitting the option is a real choice, not an oversight: the Halloween store
	 * keeps using its connection and must not have it closed underneath.
	 */
	it('installs no versionchange handler when the option is omitted', async () => {
		const factory = new IDBFactory();
		const shared = {
			factory,
			databaseVersion: 1,
			schema: [{ name: 'records' }],
			toError: () => new Error('unused'),
		};
		const without = await openIndexedDb({ ...shared, databaseName: databaseName('no-versionchange') });
		const with_ = await openIndexedDb({
			...shared,
			databaseName: databaseName('with-versionchange'),
			onVersionChange: 'close',
		});

		// Asserted as a contrast so the case cannot pass just because the property
		// happens to be absent on this IndexedDB implementation.
		expect([typeof without.onversionchange, typeof with_.onversionchange])
			.toEqual(['undefined', 'function']);
		without.close();
		with_.close();
	});

	/**
	 * The two `versionchange` a store must tell apart: a real upgrade by another context is final,
	 * anything else only costs this connection.
	 */
	it('tells a higher-version upgrade from any other versionchange', async () => {
		const factory = new IDBFactory();
		const kinds: IndexedDbVersionChangeKind[] = [];
		const options = {
			factory,
			databaseVersion: 2,
			schema: [{ name: 'records' }],
			onVersionChange: (_database: IDBDatabase, kind: IndexedDbVersionChangeKind) => { kinds.push(kind); },
			toError: () => new Error('unused'),
		};
		const upgradedName = databaseName('kind-upgrade');
		await openIndexedDb({ ...options, databaseName: upgradedName });
		(await openRaw(factory, upgradedName, 3)).close();

		const deletedName = databaseName('kind-released');
		await openIndexedDb({ ...options, databaseName: deletedName });
		await new Promise<void>((resolve, reject) => {
			const request = factory.deleteDatabase(deletedName);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error ?? new Error('delete failed'));
		});

		expect(kinds).toEqual(['upgrade', 'released']);
	});

	it('reports the engine closing the connection, and stays silent on the owner closing it', async () => {
		const factory = new IDBFactory();
		const closed: IDBDatabase[] = [];
		const database = await openIndexedDb({
			factory,
			databaseName: databaseName('engine-close'),
			databaseVersion: 1,
			schema: [{ name: 'records' }],
			onClose: (lost) => { closed.push(lost); },
			toError: () => new Error('unused'),
		});
		database.close();
		expect(closed).toEqual([]);
		emitEngineClose(database);
		expect(closed).toEqual([database]);
	});
});

// 9 Oct 2026 (Z3): an engine that takes the open and fires no event. The helper is every store's open, so it carries the bound.
describe('openIndexedDb against an engine that does not answer', () => {
	function timers() {
		const live = new Map<number, () => void>(); let next = 0;
		return {
			schedule: (callback: () => void) => { live.set(++next, callback); return next; },
			cancel: (handle: unknown) => { live.delete(handle as number); },
			get pending() { return live.size; },
			fire() { for (const [handle, callback] of [...live]) { live.delete(handle); callback(); } },
		};
	}

	it('rejects as a timeout, with the store\'s own error, when the open never answers', async () => {
		const tracked = trackedIndexedDb(); const clock = timers(); const reasons: IndexedDbOpenFailureReason[] = [];
		hangStorage(tracked);
		const opening = openIndexedDb({
			factory: tracked.factory, databaseName: databaseName('never'), databaseVersion: 1, schema: [{ name: 'records' }],
			toError: (reason) => { reasons.push(reason); return new Error(`store: ${reason}`); }, ...clock,
		});
		const outcome = opening.then(() => 'opened', (error: Error) => error.message);
		expect(clock.pending).toBe(1); // armed synchronously, in the executor
		clock.fire();
		await expect(outcome).resolves.toBe('store: timeout');
		expect(reasons).toEqual(['timeout']);
	});

	it('lets indexedDbFailureCode name an open that ran out of time `timeout`, whatever error the store built', async () => {
		const tracked = trackedIndexedDb(); const clock = timers();
		hangStorage(tracked);
		const opening = openIndexedDb({
			factory: tracked.factory, databaseName: databaseName('code'), databaseVersion: 1, schema: [{ name: 'records' }],
			toError: () => new Error('Could not open the store.'), ...clock,
		});
		const outcome = opening.then(() => undefined, (error: unknown) => error);
		clock.fire();
		const error = await outcome;
		expect(indexedDbFailureCode(error)).toBe('timeout');
		// Control: the same message from a plain error is still a storage failure.
		expect(indexedDbFailureCode(new Error('Could not open the store.'))).toBe('storage_failure');
	});

	it('closes a database the engine hands over after the wait ran out', async () => {
		const tracked = trackedIndexedDb(); const clock = timers();
		const name = databaseName('late');
		const answer = holdNextOpen(tracked);
		const opening = openIndexedDb({
			factory: tracked.factory, databaseName: name, databaseVersion: 1, schema: [{ name: 'records' }],
			toError: (reason) => new Error(reason), ...clock,
		});
		const outcome = opening.then(() => 'opened', (error: Error) => error.message);
		await engineIdle(tracked);
		clock.fire();
		await expect(outcome).resolves.toBe('timeout');
		answer();
		await engineIdle(tracked);
		expect(() => tracked.connections[0]!.transaction('records', 'readonly')).toThrow();
		// Nothing holds the orphan: another context deletes the database without being blocked.
		await new Promise<void>((resolve, reject) => {
			const request = tracked.factory.deleteDatabase(name);
			request.onsuccess = () => resolve(); request.onblocked = () => reject(new Error('blocked by an orphan'));
			request.onerror = () => reject(request.error ?? new Error('delete failed'));
		});
	});

	it('leaves no timer behind when the open answers in time', async () => {
		const tracked = trackedIndexedDb(); const clock = timers();
		const database = await openIndexedDb({
			factory: tracked.factory, databaseName: databaseName('prompt'), databaseVersion: 1, schema: [{ name: 'records' }],
			toError: () => new Error('unused'), ...clock,
		});
		expect(clock.pending).toBe(0);
		database.close();
	});
});

describe('withIndexedDbReopen against a transaction that does not answer', () => {
	it('refuses the operation at its deadline and drops the connection it ran on', async () => {
		const tracked = trackedIndexedDb(); const discarded: IDBDatabase[] = [];
		let cached: IDBDatabase | null = null;
		const live = new Map<number, () => void>(); let next = 0;
		const connection = {
			open: async () => cached ??= await openIndexedDb({
				factory: tracked.factory, databaseName: databaseName('silent-tx'), databaseVersion: 1, schema: [{ name: 'records' }],
				toError: () => new Error('open failed'),
			}),
			discard: (database: IDBDatabase) => { discarded.push(database); if (cached === database) cached = null; },
		};
		const clock = { schedule: (callback: () => void) => { live.set(++next, callback); return next; }, cancel: (handle: unknown) => { live.delete(handle as number); } };
		await connection.open();
		const never = async (): Promise<number> => await new Promise<number>(() => undefined);
		const outcome = withIndexedDbReopen(connection, never, clock).then(() => 'done', (error: Error) => error.name);
		await vi.waitFor(() => { expect(live.size).toBeGreaterThan(0); });
		for (const [handle, callback] of [...live]) { live.delete(handle); callback(); }
		await expect(outcome).resolves.toBe('TimeoutError');
		expect(discarded).toEqual([tracked.connections[0]]);
	});
});

describe('withIndexedDbReopen', () => {
	const schema = [{ name: 'records' }];
	function connection(tracked: TrackedIndexedDb, name: string) {
		let cached: IDBDatabase | null = null;
		const discarded: IDBDatabase[] = [];
		return {
			discarded,
			open: async () => cached ??= await openIndexedDb({
				factory: tracked.factory, databaseName: name, databaseVersion: 1, schema, toError: () => new Error('open failed'),
			}),
			discard: (database: IDBDatabase) => { discarded.push(database); if (cached === database) cached = null; },
		};
	}
	const count = async (database: IDBDatabase): Promise<number> => await new Promise((resolve, reject) => {
		const request = startIndexedDbTransaction(database, 'records', 'readonly').objectStore('records').count();
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('count failed'));
	});

	it('drops a connection that died underneath and runs the operation once more on a new one', async () => {
		const tracked = trackedIndexedDb();
		const store = connection(tracked, databaseName('reopen'));
		await expect(withIndexedDbReopen(store, count)).resolves.toBe(0);
		closeUnderneath(tracked.connections[0]!);

		await expect(withIndexedDbReopen(store, count)).resolves.toBe(0);
		expect(tracked.connections).toHaveLength(2);
		expect(store.discarded).toEqual([tracked.connections[0]]);
	});

	it('reopens exactly once per operation: a second dead connection is that operation\'s failure', async () => {
		const tracked = trackedIndexedDb();
		const store = connection(tracked, databaseName('reopen-once'));
		let runs = 0;
		const alwaysDead = async (database: IDBDatabase): Promise<number> => {
			runs += 1;
			closeUnderneath(database);
			return await count(database);
		};

		await expect(withIndexedDbReopen(store, alwaysDead)).rejects.toBeInstanceOf(IndexedDbConnectionLostError);
		expect(runs).toBe(2);
		expect(tracked.connections).toHaveLength(2);
		expect(store.discarded).toHaveLength(2);
	});

	it('never repeats an operation that failed after its transaction started', async () => {
		const tracked = trackedIndexedDb();
		const store = connection(tracked, databaseName('no-repeat'));
		let runs = 0;
		const aborted = async (database: IDBDatabase): Promise<void> => {
			runs += 1;
			startIndexedDbTransaction(database, 'records', 'readwrite').objectStore('records').put('written', 'key');
			throw new Error('aborted after writing');
		};

		await expect(withIndexedDbReopen(store, aborted)).rejects.toThrow('aborted after writing');
		expect(runs).toBe(1);
		expect(tracked.connections).toHaveLength(1);
		expect(store.discarded).toEqual([]);
	});
});

/** DU-05: the cached connection the secondary stores share, on its own. */
describe('ReopeningIndexedDbConnection', () => {
	const schema = [{ name: 'records' }];
	function reopening(tracked: TrackedIndexedDb, name: string): ReopeningIndexedDbConnection {
		return new ReopeningIndexedDbConnection(async (hooks) => await openIndexedDb({
			factory: tracked.factory, databaseName: name, databaseVersion: 1, schema, ...hooks,
			toError: (reason) => new Error(`open: ${reason}`),
		}), () => new Error('store unavailable'));
	}
	const count = async (database: IDBDatabase): Promise<number> => await new Promise((resolve, reject) => {
		const request = startIndexedDbTransaction(database, 'records', 'readonly').objectStore('records').count();
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('count failed'));
	});
	const remove = async (factory: IDBFactory, name: string): Promise<void> => await new Promise((resolve, reject) => {
		const request = factory.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error('delete failed'));
	});

	it('closes the database an open still in course hands over after close(), and never opens again', async () => {
		const tracked = trackedIndexedDb();
		const release = holdNextOpen(tracked);
		const connection = reopening(tracked, databaseName('close-while-opening'));
		const opening = connection.open();
		await engineIdle(tracked);
		connection.close();
		release();

		await expect(opening).rejects.toThrow('open: refused');
		expect(tracked.connections).toHaveLength(1);
		expect(() => tracked.connections[0]!.transaction('records', 'readonly')).toThrow();
		await expect(connection.open()).rejects.toThrow('store unavailable');
		await expect(connection.run(count)).rejects.toThrow('store unavailable');
		expect(tracked.connections).toHaveLength(1);
		expect(connection.isRetired).toBe(true);
	});

	it('lets two operations that start together share one open', async () => {
		const tracked = trackedIndexedDb();
		const opened = vi.spyOn(tracked.factory, 'open');
		const connection = reopening(tracked, databaseName('shared-open'));

		await expect(Promise.all([connection.run(count), connection.run(count)])).resolves.toEqual([0, 0]);
		expect(opened).toHaveBeenCalledOnce();
		expect(tracked.connections).toHaveLength(1);
		connection.close();
	});

	it('opens again after a versionchange that is not an upgrade, and never after a real one', async () => {
		const tracked = trackedIndexedDb();
		const name = databaseName('released');
		const connection = reopening(tracked, name);
		await expect(connection.run(count)).resolves.toBe(0);

		await remove(tracked.factory, name);
		expect(connection.isRetired).toBe(false);
		await expect(connection.run(count)).resolves.toBe(0);
		expect(tracked.connections).toHaveLength(2);

		const upgraded = await openRaw(tracked.factory, name, 2);
		expect(connection.isRetired).toBe(true);
		const before = tracked.connections.length; // the two of the store and the upgrading one
		await expect(connection.run(count)).rejects.toThrow('store unavailable');
		expect(tracked.connections).toHaveLength(before);
		upgraded.close();
	});
});
