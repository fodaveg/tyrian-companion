import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
	PRICE_HISTORY_DAILY_STORE,
	PRICE_HISTORY_META_STORE,
	PRICE_HISTORY_SEED_ITEM_IDS,
	PRICE_HISTORY_SNAPSHOT_STORE,
	PRICE_HISTORY_WATCH_STORE,
	type PriceHistorySnapshotV1,
} from './price-history-model';
import { IndexedDbPriceHistoryStore } from './price-history-store';

describe('IndexedDbPriceHistoryStore', () => {
	it('creates the four v1 stores and keeps seeds non-evictable', async () => {
		const factory = new IDBFactory();
		const name = databaseName('schema');
		const store = await IndexedDbPriceHistoryStore.open(factory, name);
		await store.ensureSeedWatchList('vault', 1);
		await store.observeItems('vault', Array.from({ length: 500 }, (_, index) => index + 1), 2);
		const watch = await store.readWatchList('vault');
		expect(watch).toHaveLength(400);
		expect(PRICE_HISTORY_SEED_ITEM_IDS.every((id) => watch.some((entry) => entry.itemId === id && entry.seed))).toBe(true);
		store.close();
		const database = await openRaw(factory, name, 1);
		for (const storeName of [PRICE_HISTORY_SNAPSHOT_STORE, PRICE_HISTORY_DAILY_STORE, PRICE_HISTORY_WATCH_STORE, PRICE_HISTORY_META_STORE]) {
			expect(database.objectStoreNames.contains(storeName)).toBe(true);
		}
		database.close();
	});

	it('allows one writer per vault and slot, then returns the committed snapshot idempotently', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('lease'));
		const first = await store.claimSlot('vault-a', 900_000, 'window-a', 1_000);
		expect(first.status).toBe('acquired');
		expect((await store.claimSlot('vault-a', 900_000, 'window-b', 1_001)).status).toBe('busy');
		expect((await store.claimSlot('vault-b', 900_000, 'window-b', 1_001)).status).toBe('acquired');
		if (first.status !== 'acquired') throw new Error('lease missing');
		const committed = await store.commitSlot(first.lease, snapshot('vault-a', 900_000, 1_100));
		expect(committed.status).toBe('committed');
		const duplicate = await store.claimSlot('vault-a', 900_000, 'window-b', 1_200);
		expect(duplicate.status).toBe('captured');
		store.close();
	});

	it('rejects a stale fence after an expired lease is replaced', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('stale'));
		const stale = await store.claimSlot('vault', 0, 'old', 0, 10);
		const current = await store.claimSlot('vault', 0, 'new', 11, 10);
		if (stale.status !== 'acquired' || current.status !== 'acquired') throw new Error('leases missing');
		expect((await store.commitSlot(stale.lease, snapshot('vault', 0, 12))).status).toBe('stale_fence');
		expect((await store.commitSlot(current.lease, snapshot('vault', 0, 13))).status).toBe('committed');
		store.close();
	});

	it('compacts before pruning and applies raw/daily retention idempotently', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('retention'));
		const now = Date.parse('2026-08-29T12:00:00.000Z');
		for (const ageDays of [10, 1]) {
			const capturedAt = now - ageDays * 86_400_000;
			const lease = await store.claimSlot('vault', capturedAt, `owner-${String(ageDays)}`, capturedAt);
			if (lease.status !== 'acquired') throw new Error('lease missing');
			await store.commitSlot(lease.lease, snapshot('vault', capturedAt, capturedAt));
		}
		const first = await store.compactAndPrune('vault', now, 7, 180);
		expect(first).toMatchObject({ dailyRecords: 2, prunedSnapshots: 1 });
		expect(await store.readSnapshots('vault')).toHaveLength(1);
		expect(await store.readDaily('vault', 36_038, '2026-01-01')).toHaveLength(2);
		expect((await store.compactAndPrune('vault', now, 7, 180)).dailyRecords).toBe(0);
		const second = await store.compactAndPrune('vault', now, 7, 5);
		expect(second.prunedDaily).toBe(1);
		expect((await store.compactAndPrune('vault', now, 7, 5)).prunedDaily).toBe(0);
		store.close();
	});

	it('preserves the complete UTC boundary day across repeated compaction and pruning cycles', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('boundary-day'));
		const early = Date.parse('2026-08-22T01:00:00.000Z');
		const late = Date.parse('2026-08-22T20:00:00.000Z');
		for (const [capturedAt, bid] of [[early, 100], [late, 300]] as const) {
			const claim = await store.claimSlot('vault', capturedAt, `owner-${String(bid)}`, capturedAt);
			if (claim.status !== 'acquired') throw new Error('lease missing');
			await store.commitSlot(claim.lease, { ...snapshot('vault', capturedAt, capturedAt), items: [[36_038, bid, bid + 10]] });
		}
		await store.compactAndPrune('vault', Date.parse('2026-08-29T12:00:00.000Z'), 7, 180);
		expect(await store.readSnapshots('vault')).toHaveLength(2);
		await store.compactAndPrune('vault', Date.parse('2026-08-30T12:00:00.000Z'), 7, 180);
		expect(await store.readSnapshots('vault')).toHaveLength(0);
		expect((await store.readDaily('vault', 36_038, '2026-08-22'))[0]).toMatchObject({
			snapshotCount: 2, partialSnapshotCount: 0,
			bid: { count: 2, minCopper: 100, maxCopper: 300, medianCopperX2: 400, closeCopper: 300 },
		});
		expect((await store.compactAndPrune('vault', Date.parse('2026-08-31T12:00:00.000Z'), 7, 180)).dailyRecords).toBe(0);
		expect((await store.readDaily('vault', 36_038, '2026-08-22'))[0]?.snapshotCount).toBe(2);
		store.close();
	});

	it('persists per-item partiality for missing ids without tainting present items', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('per-item-partial'));
		const capturedAt = Date.parse('2026-08-29T12:00:00.000Z');
		const claim = await store.claimSlot('vault', capturedAt, 'owner', capturedAt);
		if (claim.status !== 'acquired') throw new Error('lease missing');
		await store.commitSlot(claim.lease, {
			...snapshot('vault', capturedAt, capturedAt), status: 'partial',
			items: [[36_038, 100, 110]], missingItemIds: [36_041],
		});
		await store.compactAndPrune('vault', capturedAt, 7, 180);
		expect((await store.readDaily('vault', 36_038, '2026-08-29'))[0]?.partialSnapshotCount).toBe(0);
		expect((await store.readDaily('vault', 36_041, '2026-08-29'))[0]).toMatchObject({
			snapshotCount: 1, partialSnapshotCount: 1, bid: null, ask: null,
		});
		store.close();
	});

	it('fails closed for a future schema and corrupt rows', async () => {
		const factory = new IDBFactory();
		const futureName = databaseName('future');
		(await openRaw(factory, futureName, 2)).close();
		await expect(IndexedDbPriceHistoryStore.open(factory, futureName, 1)).rejects.toMatchObject({ failure: 'future_schema' });

		const corruptName = databaseName('corrupt');
		const store = await IndexedDbPriceHistoryStore.open(factory, corruptName);
		store.close();
		const database = await openRaw(factory, corruptName, 1);
		const transaction = database.transaction(PRICE_HISTORY_SNAPSHOT_STORE, 'readwrite');
		transaction.objectStore(PRICE_HISTORY_SNAPSHOT_STORE).put({ vaultId: 'vault', slotStartMs: 1, bad: true });
		await transactionDone(transaction);
		database.close();
		const reopened = await IndexedDbPriceHistoryStore.open(factory, corruptName);
		await expect(reopened.readSnapshots('vault')).rejects.toMatchObject({ failure: 'corrupt' });
		reopened.close();
	});

	it('rejects a blocked upgrade and closes the late connection', async () => {
		const factory = new IDBFactory();
		const name = databaseName('blocked');
		const initialized = await IndexedDbPriceHistoryStore.open(factory, name, 1);
		initialized.close();
		const blocker = await openRaw(factory, name, 1);
		await expect(IndexedDbPriceHistoryStore.open(factory, name, 2)).rejects.toMatchObject({ failure: 'blocked' });
		blocker.close();
		const versionThree = await openRaw(factory, name, 3);
		expect(versionThree.version).toBe(3);
		versionThree.close();
	});

	it('surfaces a quota transaction failure without a memory fallback', async () => {
		const request = {} as IDBRequest;
		const transaction = {
			error: new DOMException('full', 'QuotaExceededError'),
			objectStore: () => ({
				getAll: () => request,
				put: () => ({}), delete: () => ({}),
			}),
		} as unknown as IDBTransaction;
		const database = { transaction: () => transaction, close: () => undefined } as unknown as IDBDatabase;
		const store = new IndexedDbPriceHistoryStore(database);
		const write = store.observeItems('vault', [1], 1);
		Object.defineProperty(request, 'result', { value: [] });
		request.onsuccess?.call(request, new Event('success'));
		transaction.onerror?.call(transaction, new Event('error'));
		await expect(write).rejects.toMatchObject({ failure: 'quota' });
	});
});

function snapshot(vaultId: string, slotStartMs: number, capturedAtMs: number): PriceHistorySnapshotV1 {
	return {
		version: 1, vaultId, slotStartMs, capturedAtMs, intervalMs: 900_000, status: 'complete',
		items: [[36_038, 100, 110]], missingItemIds: [],
	};
}

function databaseName(label: string): string { return `tyrian-companion-price-history-${label}`; }
function openRaw(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			if (version > 1 && !request.result.objectStoreNames.contains('future')) request.result.createObjectStore('future');
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
