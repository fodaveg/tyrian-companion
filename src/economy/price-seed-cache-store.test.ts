import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { IndexedDbPriceSeedCacheStore, IndexedDbPriceSeedNoSeedStore } from './price-seed-cache-store';
import type { PriceSeedV1 } from './price-seed-model';

describe('IndexedDbPriceSeedCacheStore', () => {
	it('returns null before any write and the stored seed after one', async () => {
		const factory = new IDBFactory();
		const store = await IndexedDbPriceSeedCacheStore.open(factory, databaseName('empty'));
		expect(await store.get('vault', 36_038)).toBeNull();
		await store.put('vault', 36_038, seed(36_038), 1_000);
		const record = await store.get('vault', 36_038);
		expect(record).toMatchObject({ vaultId: 'vault', itemId: 36_038, cachedAtMs: 1_000 });
		expect(record?.seed.days).toEqual(seed(36_038).days);
		store.close();
	});

	it('keeps two items in the same vault apart and two vaults for the same item apart', async () => {
		const factory = new IDBFactory();
		const store = await IndexedDbPriceSeedCacheStore.open(factory, databaseName('scoped'));
		await store.put('vault-a', 1, seed(1), 10);
		await store.put('vault-a', 2, seed(2), 10);
		await store.put('vault-b', 1, seed(1), 20);
		expect((await store.get('vault-a', 1))?.cachedAtMs).toBe(10);
		expect((await store.get('vault-a', 2))?.seed.itemId).toBe(2);
		expect((await store.get('vault-b', 1))?.cachedAtMs).toBe(20);
		store.close();
	});

	it('overwrites the same key on a second put', async () => {
		const factory = new IDBFactory();
		const store = await IndexedDbPriceSeedCacheStore.open(factory, databaseName('overwrite'));
		await store.put('vault', 1, seed(1), 10);
		await store.put('vault', 1, seed(1, [{ dayUtc: '2026-01-02', bidCopper: 55, askCopper: 60 }]), 20);
		const record = await store.get('vault', 1);
		expect(record?.cachedAtMs).toBe(20);
		expect(record?.seed.days).toEqual([{ dayUtc: '2026-01-02', bidCopper: 55, askCopper: 60 }]);
		store.close();
	});

	it('fails closed on a corrupt record instead of returning a partial one', async () => {
		const factory = new IDBFactory();
		const name = databaseName('corrupt');
		const store = await IndexedDbPriceSeedCacheStore.open(factory, name);
		store.close();
		const database = await openRaw(factory, name);
		const transaction = database.transaction('seed-v1', 'readwrite');
		transaction.objectStore('seed-v1').put({ vaultId: 'vault', itemId: 1, bad: true });
		await transactionDone(transaction);
		database.close();
		const reopened = await IndexedDbPriceSeedCacheStore.open(factory, name);
		await expect(reopened.get('vault', 1)).rejects.toMatchObject({ failure: 'corrupt' });
		reopened.close();
	});

	it('fails closed for a future schema', async () => {
		const factory = new IDBFactory();
		const name = databaseName('future');
		(await openRaw(factory, name, 2)).close();
		await expect(IndexedDbPriceSeedCacheStore.open(factory, name, 1)).rejects.toMatchObject({ failure: 'future_schema' });
	});
});

/** H18.17: the negative-answer store `PriceSeedBulkRefreshService` reads/writes for its spaced retry. */
describe('IndexedDbPriceSeedNoSeedStore', () => {
	it('returns null before any write and the stored answer after one', async () => {
		const factory = new IDBFactory();
		const store = await IndexedDbPriceSeedNoSeedStore.open(factory, noSeedDatabaseName('empty'));
		expect(await store.get('vault', 36_038)).toBeNull();
		await store.put('vault', 36_038, 'unreachable', 1_000);
		expect(await store.get('vault', 36_038)).toMatchObject({
			vaultId: 'vault', itemId: 36_038, reason: 'unreachable', failedAtMs: 1_000,
		});
		store.close();
	});

	it('keeps two items in the same vault apart and two vaults for the same item apart', async () => {
		const factory = new IDBFactory();
		const store = await IndexedDbPriceSeedNoSeedStore.open(factory, noSeedDatabaseName('scoped'));
		await store.put('vault-a', 1, 'empty', 10);
		await store.put('vault-a', 2, 'malformed', 10);
		await store.put('vault-b', 1, 'unreachable', 20);
		expect((await store.get('vault-a', 1))?.reason).toBe('empty');
		expect((await store.get('vault-a', 2))?.reason).toBe('malformed');
		expect((await store.get('vault-b', 1))?.reason).toBe('unreachable');
		store.close();
	});

	it('overwrites the same key on a second put', async () => {
		const factory = new IDBFactory();
		const store = await IndexedDbPriceSeedNoSeedStore.open(factory, noSeedDatabaseName('overwrite'));
		await store.put('vault', 1, 'unreachable', 10);
		await store.put('vault', 1, 'empty', 20);
		expect(await store.get('vault', 1)).toMatchObject({ reason: 'empty', failedAtMs: 20 });
		store.close();
	});

	it('clears a stored answer on delete, and a second delete on an already-clear key is a no-op', async () => {
		const factory = new IDBFactory();
		const store = await IndexedDbPriceSeedNoSeedStore.open(factory, noSeedDatabaseName('delete'));
		await store.put('vault', 1, 'unreachable', 10);
		await store.delete('vault', 1);
		expect(await store.get('vault', 1)).toBeNull();
		await store.delete('vault', 1);
		expect(await store.get('vault', 1)).toBeNull();
		store.close();
	});

	it('fails closed on a corrupt record instead of returning a partial one', async () => {
		const factory = new IDBFactory();
		const name = noSeedDatabaseName('corrupt');
		const store = await IndexedDbPriceSeedNoSeedStore.open(factory, name);
		store.close();
		const database = await openRawNoSeed(factory, name);
		const transaction = database.transaction('no-seed-v1', 'readwrite');
		transaction.objectStore('no-seed-v1').put({ vaultId: 'vault', itemId: 1, bad: true });
		await transactionDone(transaction);
		database.close();
		const reopened = await IndexedDbPriceSeedNoSeedStore.open(factory, name);
		await expect(reopened.get('vault', 1)).rejects.toMatchObject({ failure: 'corrupt' });
		reopened.close();
	});

	it('rejects a reason outside the closed enum as corrupt', async () => {
		const factory = new IDBFactory();
		const name = noSeedDatabaseName('bad-reason');
		const store = await IndexedDbPriceSeedNoSeedStore.open(factory, name);
		store.close();
		const database = await openRawNoSeed(factory, name);
		const transaction = database.transaction('no-seed-v1', 'readwrite');
		transaction.objectStore('no-seed-v1').put({ version: 1, vaultId: 'vault', itemId: 1, reason: 'nope', failedAtMs: 1 });
		await transactionDone(transaction);
		database.close();
		const reopened = await IndexedDbPriceSeedNoSeedStore.open(factory, name);
		await expect(reopened.get('vault', 1)).rejects.toMatchObject({ failure: 'corrupt' });
		reopened.close();
	});

	it('fails closed for a future schema', async () => {
		const factory = new IDBFactory();
		const name = noSeedDatabaseName('future');
		(await openRawNoSeed(factory, name, 2)).close();
		await expect(IndexedDbPriceSeedNoSeedStore.open(factory, name, 1)).rejects.toMatchObject({ failure: 'future_schema' });
	});
});

function seed(itemId: number, days = [{ dayUtc: '2026-01-01', bidCopper: 50, askCopper: 55 }]): PriceSeedV1 {
	return { version: 1, itemId, source: 'datawars2', retrievedAt: '2026-09-03T00:00:00.000Z', days };
}

function databaseName(label: string): string { return `tyrian-companion-price-seed-cache-${label}`; }
function openRaw(factory: IDBFactory, name: string, version = 1): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains('seed-v1')) {
				request.result.createObjectStore('seed-v1', { keyPath: ['vaultId', 'itemId'] });
			}
		};
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
		request.onsuccess = () => resolve(request.result);
	});
}
function noSeedDatabaseName(label: string): string { return `tyrian-companion-price-seed-no-seed-cache-${label}`; }
function openRawNoSeed(factory: IDBFactory, name: string, version = 1): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains('no-seed-v1')) {
				request.result.createObjectStore('no-seed-v1', { keyPath: ['vaultId', 'itemId'] });
			}
		};
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
		request.onsuccess = () => resolve(request.result);
	});
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
		transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
	});
}
