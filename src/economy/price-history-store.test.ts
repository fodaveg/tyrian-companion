import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import {
	PRICE_HISTORY_DAILY_STORE,
	PRICE_HISTORY_META_STORE,
	PRICE_HISTORY_SEED_ITEM_IDS,
	PRICE_HISTORY_SNAPSHOT_STORE,
	PRICE_HISTORY_WATCH_STORE,
	type PriceHistorySnapshotV1,
} from './price-history-model';
import { IndexedDbPriceHistoryStore } from './price-history-store';
import { LocalDebugPersistenceProbe, type LocalDebugPersistenceEvent } from '../core/local-debug-persistence';

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

	it('replaces the derived slice on every call, keeps seeds, and preserves a plain session-observed row', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('derived'));
		await store.ensureSeedWatchList('vault', 1);
		// A plain session-observed id (not derived): must survive every later derived-list call.
		await store.observeItems('vault', [999], 2);
		await store.applyDerivedWatchList('vault', [10, 20, 30], 3);
		let watch = await store.readWatchList('vault');
		expect(watch.filter((entry) => entry.derived).map((entry) => entry.itemId)).toEqual([10, 20, 30]);
		expect(watch.some((entry) => entry.itemId === 999 && !entry.derived)).toBe(true);
		expect(PRICE_HISTORY_SEED_ITEM_IDS.every((id) => watch.some((entry) => entry.itemId === id && entry.seed))).toBe(true);

		// Item 20 drops out of the derived set on the next sync: it must leave the watch list.
		await store.applyDerivedWatchList('vault', [10, 30], 4);
		watch = await store.readWatchList('vault');
		expect(watch.some((entry) => entry.itemId === 20)).toBe(false);
		expect(watch.filter((entry) => entry.derived).map((entry) => entry.itemId)).toEqual([10, 30]);
		// The seeds and the session-observed id are untouched by the drop.
		expect(watch.some((entry) => entry.itemId === 999)).toBe(true);
		expect(PRICE_HISTORY_SEED_ITEM_IDS.every((id) => watch.some((entry) => entry.itemId === id && entry.seed))).toBe(true);
		store.close();
	});

	// The store defensively re-enforces the 400 total cap even if a caller passed more; which
	// 400 win by capital is `selectDerivedWatchListItemIds`'s own responsibility and is covered
	// by price-history-model.test.ts, not here.
	it('never exceeds 400 total watch entries even when handed more derived ids than that', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('derived-cap'));
		await store.applyDerivedWatchList('vault', Array.from({ length: 450 }, (_, index) => index + 1), 1);
		const watch = await store.readWatchList('vault');
		expect(watch).toHaveLength(400);
		store.close();
	});

	describe('watch list reasons (seed, observed, derived)', () => {
		const ids = async (store: IndexedDbPriceHistoryStore): Promise<number[]> =>
			(await store.readWatchList('vault')).map((entry) => entry.itemId);

		it('keeps an item observed in session when it enters and then leaves the derived selection', async () => {
			const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('reasons-observed-first'));
			await store.observeItems('vault', [777], 1);
			await store.applyDerivedWatchList('vault', [777], 2);
			await store.applyDerivedWatchList('vault', [], 3);
			expect(await ids(store)).toContain(777);
			store.close();
		});

		it('keeps an item derived first and observed in session afterwards when it leaves the derived selection', async () => {
			const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('reasons-derived-first'));
			await store.applyDerivedWatchList('vault', [777], 1);
			await store.observeItems('vault', [777], 2);
			await store.applyDerivedWatchList('vault', [], 3);
			expect(await ids(store)).toContain(777);
			store.close();
		});

		it('control: deletes an item that was only derived once it leaves the derived selection', async () => {
			const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('reasons-derived-only'));
			await store.applyDerivedWatchList('vault', [777, 778], 1);
			await store.applyDerivedWatchList('vault', [778], 2);
			expect(await ids(store)).not.toContain(777);
			expect(await ids(store)).toContain(778);
			store.close();
		});

		it('never deletes a seed, neither by a capital drop nor by the 400 cap', async () => {
			const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('reasons-seed'));
			await store.ensureSeedWatchList('vault', 1);
			await store.applyDerivedWatchList('vault', [PRICE_HISTORY_SEED_ITEM_IDS[0]!, 5], 2);
			await store.applyDerivedWatchList('vault', [], 3);
			let watch = await store.readWatchList('vault');
			expect(PRICE_HISTORY_SEED_ITEM_IDS.every((id) => watch.some((entry) => entry.itemId === id && entry.seed))).toBe(true);
			await store.observeItems('vault', Array.from({ length: 600 }, (_, index) => index + 1), 4);
			watch = await store.readWatchList('vault');
			expect(watch).toHaveLength(400);
			expect(PRICE_HISTORY_SEED_ITEM_IDS.every((id) => watch.some((entry) => entry.itemId === id && entry.seed))).toBe(true);
			store.close();
		});

		it('evicts the oldest non-seed rows beyond 400 and keeps the newer ones', async () => {
			const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('reasons-cap'));
			await store.ensureSeedWatchList('vault', 1);
			await store.observeItems('vault', [1, 2, 3], 10);
			await store.observeItems('vault', Array.from({ length: 400 }, (_, index) => 1_000 + index), 20);
			const watch = await ids(store);
			expect(watch).toHaveLength(400);
			for (const old of [1, 2, 3]) expect(watch).not.toContain(old);
			expect(watch).toContain(1_000);
			store.close();
		});

		const rows = async (store: IndexedDbPriceHistoryStore): Promise<unknown[]> => await store.readWatchList('vault');

		it('leaves every row byte-identical when the same derived set is applied again', async () => {
			const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('reasons-repeat'));
			await store.observeItems('vault', [11, 12, 13], 1);
			await store.applyDerivedWatchList('vault', [12, 13, 14], 2);
			const before = await rows(store);
			await store.applyDerivedWatchList('vault', [12, 13, 14], 3);
			expect(await rows(store)).toEqual(before);
			store.close();
		});

		it('observing an item refreshes only its own date', async () => {
			const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('reasons-observe-date'));
			await store.observeItems('vault', [11, 12, 13], 1);
			const before = await store.readWatchList('vault');
			await store.observeItems('vault', [12], 9);
			const after = await store.readWatchList('vault');
			for (const entry of after) {
				const was = before.find(({ itemId }) => itemId === entry.itemId)!;
				const refreshed = entry.itemId === 12 || entry.seed;
				expect(entry.lastObservedAtMs, `item ${String(entry.itemId)}`).toBe(refreshed ? 9 : was.lastObservedAtMs);
			}
			store.close();
		});

		it('reads a pre-reasons row with derived true as also observed, so it survives leaving the derived selection', async () => {
			const factory = new IDBFactory();
			const name = databaseName('reasons-migration');
			(await IndexedDbPriceHistoryStore.open(factory, name)).close();
			const raw = await openRaw(factory, name, 1);
			const writing = raw.transaction([PRICE_HISTORY_WATCH_STORE], 'readwrite');
			writing.objectStore(PRICE_HISTORY_WATCH_STORE).put({
				version: 1, vaultId: 'vault', itemId: 4_242, seed: false, derived: true, lastObservedAtMs: 5,
			});
			await transactionDone(writing);
			raw.close();
			const store = await IndexedDbPriceHistoryStore.open(factory, name);
			expect(await ids(store)).toContain(4_242);
			await store.applyDerivedWatchList('vault', [], 6);
			expect(await ids(store)).toContain(4_242);
			store.close();
		});
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

	it('retires an unreadable row in the middle of the prune range, keeps going and reports it (DU-07)', async () => {
		const factory = new IDBFactory();
		const name = databaseName('prune-unreadable');
		const events: LocalDebugPersistenceEvent[] = [];
		const store = await IndexedDbPriceHistoryStore.open(factory, name, undefined, new LocalDebugPersistenceProbe({ sink: (event) => events.push(event) }));
		const now = Date.parse('2026-08-29T12:00:00.000Z');
		for (const ageDays of [20, 15, 10, 1]) {
			const capturedAt = now - ageDays * 86_400_000;
			const lease = await store.claimSlot('vault', capturedAt, `owner-${String(ageDays)}`, capturedAt);
			if (lease.status !== 'acquired') throw new Error('lease missing');
			await store.commitSlot(lease.lease, snapshot('vault', capturedAt, capturedAt));
		}
		// Compacts everything once (and marks the store ready) so the corrupt rows below are met only by the prune.
		await store.compactAndPrune('vault', now - 25 * 86_400_000, 7, 365);
		store.close();
		const database = await openRaw(factory, name, 1);
		const corruptAt = now - 12 * 86_400_000;
		const writes = database.transaction([PRICE_HISTORY_SNAPSHOT_STORE, PRICE_HISTORY_DAILY_STORE], 'readwrite');
		writes.objectStore(PRICE_HISTORY_SNAPSHOT_STORE).put({ vaultId: 'vault', slotStartMs: corruptAt, capturedAtMs: corruptAt, bad: true });
		writes.objectStore(PRICE_HISTORY_DAILY_STORE).put({ vaultId: 'vault', itemId: 1, dayUtc: '2026-08-10', bad: true });
		await transactionDone(writes);
		database.close();

		const reopened = await IndexedDbPriceHistoryStore.open(factory, name, undefined, new LocalDebugPersistenceProbe({ sink: (event) => events.push(event) }));
		const result = await reopened.compactAndPrune('vault', now, 7, 5);
		expect(result.prunedSnapshots).toBe(3);
		expect(result.prunedDaily).toBeGreaterThan(0);
		// Only the readable snapshot inside the retention window is left; the corrupt rows are gone, not stuck.
		expect(await reopened.readSnapshots('vault')).toHaveLength(1);
		const retired = events.filter(({ code, phase }) => code === 'corrupt_tail_recovered' && phase === 'skip');
		expect(retired.map(({ detail }) => detail?.objectStore).sort()).toEqual([PRICE_HISTORY_DAILY_STORE, PRICE_HISTORY_SNAPSHOT_STORE].sort());
		expect(retired.every(({ detail }) => detail?.rows === '1' && detail.reason === 'unreadable_row_retired')).toBe(true);
		// A second pass finds nothing left to retire.
		expect((await reopened.compactAndPrune('vault', now, 7, 5)).prunedSnapshots).toBe(0);
		reopened.close();
	});

	it('reports nothing about unreadable rows when the prune range holds none', async () => {
		const events: LocalDebugPersistenceEvent[] = [];
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('prune-clean'), undefined, new LocalDebugPersistenceProbe({ sink: (event) => events.push(event) }));
		const now = Date.parse('2026-08-29T12:00:00.000Z');
		for (const ageDays of [10, 1]) {
			const capturedAt = now - ageDays * 86_400_000;
			const lease = await store.claimSlot('vault', capturedAt, `owner-${String(ageDays)}`, capturedAt);
			if (lease.status !== 'acquired') throw new Error('lease missing');
			await store.commitSlot(lease.lease, snapshot('vault', capturedAt, capturedAt));
		}
		expect(await store.compactAndPrune('vault', now, 7, 180)).toMatchObject({ dailyRecords: 2, prunedSnapshots: 1, prunedDaily: 0 });
		expect(events.some(({ code }) => code === 'corrupt_tail_recovered')).toBe(false);
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

	it('bounds peak compaction memory to one UTC day across the maximum raw window and watch size', async () => {
		const store = await IndexedDbPriceHistoryStore.open(new IDBFactory(), databaseName('bounded-compaction'));
		const firstDay = Date.parse('2026-07-30T12:00:00.000Z');
		for (let day = 0; day <= 30; day += 1) {
			const capturedAt = firstDay + day * 86_400_000;
			const claim = await store.claimSlot('vault', capturedAt, `owner-${String(day)}`, capturedAt);
			if (claim.status !== 'acquired') throw new Error('lease missing');
			const itemCount = day === 15 ? 400 : 1;
			await store.commitSlot(claim.lease, {
				...snapshot('vault', capturedAt, capturedAt),
				items: Array.from({ length: itemCount }, (_, index) => [index + 1, index, index + 1]),
			});
		}
		const result = await store.compactAndPrune('vault', firstDay + 30 * 86_400_000, 30, 365);
		expect(result).toMatchObject({ compactedDays: 31, peakSnapshotsPerDay: 1, peakSnapshotTuplesPerDay: 400 });
		expect(await store.readDaily('vault', 400, '2026-01-01')).toHaveLength(1);
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
		// DU-05: the transaction starts once the store has its connection, a microtask later.
		await vi.waitFor(() => { expect(request.onsuccess).toBeTypeOf('function'); });
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
