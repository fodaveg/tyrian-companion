import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
	CATALOG_CACHE_STORE_NAME,
	IndexedDbCatalogRecordStore,
} from './persistent-catalog-cache';

describe('IndexedDbCatalogRecordStore', () => {
	it('creates the versioned store and commits set/get/delete operations', async () => {
		const factory = new IDBFactory();
		const name = databaseName('operations');
		const store = await IndexedDbCatalogRecordStore.open(factory, name);

		await store.set('alpha', '{"value":1}');
		await expect(store.get('alpha')).resolves.toBe('{"value":1}');
		await store.delete('alpha');
		await expect(store.get('alpha')).resolves.toBeUndefined();
		store.close();

		const database = await openRaw(factory, name, 1);
		expect(database.objectStoreNames.contains(CATALOG_CACHE_STORE_NAME)).toBe(true);
		database.close();
	});

	it('persists committed data across close and reopen', async () => {
		const factory = new IDBFactory();
		const name = databaseName('reopen');
		const first = await IndexedDbCatalogRecordStore.open(factory, name);
		await first.set('persisted', '{"ok":true}');
		first.close();

		const second = await IndexedDbCatalogRecordStore.open(factory, name);
		await expect(second.get('persisted')).resolves.toBe('{"ok":true}');
		second.close();
	});

	it('closes on versionchange so a real upgrade can complete', async () => {
		const factory = new IDBFactory();
		const name = databaseName('versionchange');
		const store = await IndexedDbCatalogRecordStore.open(factory, name, 1);

		const upgraded = await openRaw(factory, name, 2);
		expect(upgraded.version).toBe(2);
		await expect(store.get('closed')).rejects.toBeDefined();
		upgraded.close();
	});

	it('rejects blocked upgrades and closes a late successful connection', async () => {
		const factory = new IDBFactory();
		const name = databaseName('blocked');
		const blocker = await openRaw(factory, name, 1);

		const blocked = IndexedDbCatalogRecordStore.open(factory, name, 2);
		await expect(blocked).rejects.toThrow('blocked');
		blocker.close();

		// The rejected v2 request can still succeed later; its success handler must close that DB.
		const third = await openRaw(factory, name, 3);
		expect(third.version).toBe(3);
		third.close();
	});

	it('rejects a real IndexedDB open error', async () => {
		const factory = new IDBFactory();
		const name = databaseName('open-error');
		const database = await openRaw(factory, name, 2);
		database.close();

		await expect(IndexedDbCatalogRecordStore.open(factory, name, 1)).rejects.toThrow(
			'Could not open',
		);
	});

	it('rejects an aborted write transaction through an event-faithful harness', async () => {
		let transaction: Partial<IDBTransaction> | undefined;
		const database = {
			transaction: () => {
				transaction = {
					objectStore: () => ({ put: () => ({}) }) as unknown as IDBObjectStore,
				};
				return transaction as IDBTransaction;
			},
			close: () => undefined,
		} as unknown as IDBDatabase;
		const store = new IndexedDbCatalogRecordStore(database);

		const write = store.set('key', 'value');
		const onabort = transaction?.onabort;
		if (onabort) onabort.call(transaction as IDBTransaction, new Event('abort'));

		await expect(write).rejects.toThrow('aborted');
	});

	it('rejects a write transaction error through an event-faithful harness', async () => {
		let transaction: Partial<IDBTransaction> | undefined;
		const database = {
			transaction: () => {
				transaction = {
					objectStore: () => ({ put: () => ({}) }) as unknown as IDBObjectStore,
				};
				return transaction as IDBTransaction;
			},
			close: () => undefined,
		} as unknown as IDBDatabase;
		const store = new IndexedDbCatalogRecordStore(database);

		const write = store.set('key', 'value');
		const onerror = transaction?.onerror;
		if (onerror) onerror.call(transaction as IDBTransaction, new Event('error'));

		await expect(write).rejects.toThrow('Could not write');
	});
});

function databaseName(label: string): string {
	return `tyrian-companion-test-${label}`;
}

function openRaw(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
		request.onsuccess = () => resolve(request.result);
	});
}
