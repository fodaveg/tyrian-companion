import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
	ACHIEVEMENTS_DB_NAME,
	ACHIEVEMENTS_DB_VERSION,
	ACHIEVEMENTS_PROGRESS_STORE,
	ACHIEVEMENTS_PUBLIC_STORE,
	IndexedDbAchievementStore,
	achievementPublicKey,
	type StoredTrackedProgress,
} from './achievement-store';

const VAULT = 'vault-a';
const ACCOUNT_A = 'a'.repeat(24);
const ACCOUNT_B = 'b'.repeat(24);

function progress(overrides: Partial<StoredTrackedProgress> = {}): StoredTrackedProgress {
	return {
		accountRef: ACCOUNT_A,
		capturedAt: '2026-10-10T08:40:12.000Z',
		trackedIds: [10, 11, 12],
		entries: [
			{ id: 10, done: false, current: 2, max: 4, repeated: null, bits: [0, 3] },
			{ id: 11, done: true, current: null, max: null, repeated: 3, bits: null },
		],
		...overrides,
	};
}

function openRaw(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('open failed'));
	});
}

function putRaw(database: IDBDatabase, storeName: string, key: string, value: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(storeName, 'readwrite');
		transaction.objectStore(storeName).put(value, key);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('put failed'));
	});
}

describe('IndexedDbAchievementStore', () => {
	it('opens nothing until it is used, then creates its own database with the two stores', async () => {
		const factory = new IDBFactory();
		const store = new IndexedDbAchievementStore(factory);
		expect((await factory.databases()).map((database) => database.name)).toEqual([]);

		await store.readPublic([achievementPublicKey('es', 'groups')]);
		store.dispose();
		const raw = await openRaw(factory, ACHIEVEMENTS_DB_NAME);
		expect(raw.version).toBe(ACHIEVEMENTS_DB_VERSION);
		expect(Array.from({ length: raw.objectStoreNames.length }, (_, index) => raw.objectStoreNames.item(index)).sort()).toEqual([ACHIEVEMENTS_PROGRESS_STORE, ACHIEVEMENTS_PUBLIC_STORE].sort());
		raw.close();
	});

	it('keeps public records by language and without vault, with the time they were saved', async () => {
		const store = new IndexedDbAchievementStore(new IDBFactory());
		const es = achievementPublicKey('es', 'index-page', 3);
		const en = achievementPublicKey('en', 'index-page', 3);
		expect(es).toBe('es:index-page:3');
		expect(es).not.toContain(VAULT);

		await expect(store.writePublic([
			{ key: es, savedAt: 1_000, value: { ids: [1], entries: [] } },
			{ key: en, savedAt: 2_000, value: ['raw'] },
		])).resolves.toBe(true);
		const read = await store.readPublic([es, en, achievementPublicKey('es', 'groups')]);
		expect(read.get(es)).toEqual({ key: es, savedAt: 1_000, value: { ids: [1], entries: [] } });
		expect(read.get(en)?.savedAt).toBe(2_000);
		expect(read.has(achievementPublicKey('es', 'groups'))).toBe(false);
		store.dispose();
	});

	it('treats a public record of a foreign shape as missing', async () => {
		const factory = new IDBFactory();
		const store = new IndexedDbAchievementStore(factory);
		const key = achievementPublicKey('es', 'categories');
		await store.writePublic([{ key, savedAt: 1, value: [] }]);
		store.dispose();
		const raw = await openRaw(factory, ACHIEVEMENTS_DB_NAME);
		await putRaw(raw, ACHIEVEMENTS_PUBLIC_STORE, key, { version: 1, key: 'en:categories', savedAt: 1, value: [] });
		raw.close();

		const reopened = new IndexedDbAchievementStore(factory);
		expect((await reopened.readPublic([key])).has(key)).toBe(false);
		reopened.dispose();
	});

	it('keeps the progress of each vault apart, keyed by vault and with its account reference', async () => {
		const store = new IndexedDbAchievementStore(new IDBFactory());
		await expect(store.writeProgress(VAULT, progress())).resolves.toBe(true);
		await expect(store.writeProgress('vault-b', progress({ accountRef: ACCOUNT_B, entries: [] }))).resolves.toBe(true);

		expect(await store.readProgress(VAULT, ACCOUNT_A)).toEqual(progress());
		expect(await store.readProgress('vault-b', ACCOUNT_B)).toEqual(progress({ accountRef: ACCOUNT_B, entries: [] }));
		expect(await store.readProgress('vault-c', ACCOUNT_A)).toBeNull();
		store.dispose();
	});

	it('discards the progress read for another account', async () => {
		const store = new IndexedDbAchievementStore(new IDBFactory());
		await store.writeProgress(VAULT, progress());
		expect(await store.readProgress(VAULT, ACCOUNT_B)).toBeNull();
		expect(await store.readProgress(VAULT, null)).toEqual(progress());
		store.dispose();
	});

	it('refuses to write progress that is not valid and reads a corrupt record as missing', async () => {
		const factory = new IDBFactory();
		const store = new IndexedDbAchievementStore(factory);
		await expect(store.writeProgress('vault-z', progress())).resolves.toBe(true);
		await expect(store.writeProgress(VAULT, progress({ entries: [{ id: -1, done: true, current: null, max: null, repeated: null, bits: null }] })))
			.resolves.toBe(false);
		await expect(store.writeProgress(VAULT, progress({ capturedAt: 'ayer' }))).resolves.toBe(false);
		await expect(store.writeProgress(VAULT, progress({ trackedIds: [10, 10] }))).resolves.toBe(false);
		await expect(store.writeProgress(VAULT, progress({ trackedIds: [0] }))).resolves.toBe(false);
		store.dispose();

		const raw = await openRaw(factory, ACHIEVEMENTS_DB_NAME);
		await putRaw(raw, ACHIEVEMENTS_PROGRESS_STORE, VAULT, { version: 1, vaultId: VAULT, accountRef: ACCOUNT_A, capturedAt: 'x', entries: 'no' });
		raw.close();
		const reopened = new IndexedDbAchievementStore(factory);
		expect(await reopened.readProgress(VAULT, ACCOUNT_A)).toBeNull();
		reopened.dispose();
	});

	it('clears the reading of one vault and leaves the others', async () => {
		const store = new IndexedDbAchievementStore(new IDBFactory());
		await store.writeProgress(VAULT, progress());
		await store.writeProgress('vault-b', progress({ accountRef: ACCOUNT_B }));
		await expect(store.clearProgress(VAULT)).resolves.toBe(true);
		expect(await store.readProgress(VAULT, null)).toBeNull();
		expect(await store.readProgress('vault-b', null)).toEqual(progress({ accountRef: ACCOUNT_B }));
		store.dispose();
		await expect(store.clearProgress('vault-b')).resolves.toBe(false);
	});

	it('opens a new connection once when the engine dropped the one it held, and goes on', async () => {
		const factory = new IDBFactory();
		const opened: IDBDatabase[] = [];
		const watching = {
			open: (name: string, version?: number) => {
				const request = factory.open(name, version);
				request.addEventListener('success', () => { opened.push(request.result); });
				return request;
			},
		} as unknown as IDBFactory;
		const store = new IndexedDbAchievementStore(watching);
		await store.writePublic([{ key: 'es:groups', savedAt: 1, value: ['kept'] }]);
		expect(opened).toHaveLength(1);

		// The engine closes it under the store (no `close` event reaches it), so the next
		// `transaction()` throws and `withIndexedDbReopen` must open once more.
		opened[0]!.close();
		expect((await store.readPublic(['es:groups'])).get('es:groups')?.value).toEqual(['kept']);
		await expect(store.writeProgress(VAULT, progress())).resolves.toBe(true);
		expect(opened).toHaveLength(2);
		store.dispose();
	});

	it('answers empty and refuses writes once disposed, without throwing', async () => {
		const store = new IndexedDbAchievementStore(new IDBFactory());
		await store.writePublic([{ key: 'es:groups', savedAt: 1, value: [] }]);
		store.dispose();
		await expect(store.readPublic(['es:groups'])).resolves.toEqual(new Map());
		await expect(store.writePublic([{ key: 'es:groups', savedAt: 1, value: [] }])).resolves.toBe(false);
		await expect(store.readProgress(VAULT, ACCOUNT_A)).resolves.toBeNull();
		await expect(store.writeProgress(VAULT, progress())).resolves.toBe(false);
	});
});
