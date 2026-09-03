import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { openIndexedDb, type IndexedDbOpenFailureReason } from './indexed-db-open';

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
});
