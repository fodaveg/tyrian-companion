import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
	HALLOWEEN_EPISODE_STORE, HALLOWEEN_NOTICE_STORE, HALLOWEEN_OBSERVATION_STORE, HALLOWEEN_SEEN_STORE,
	IndexedDbHalloweenStore,
	halloweenStoreFailureFrom,
} from './halloween-store';
import type { HalloweenNoticeV1, HalloweenObservationV1 } from './halloween-model';

describe('IndexedDbHalloweenStore', () => {
	it('creates closed stores and makes observation plus first-seen atomic and idempotent', async () => {
		const factory = new IDBFactory();
		const name = dbName('atomic');
		const store = await IndexedDbHalloweenStore.open(factory, name);
		const first = await store.recordObservation(observation('one', [1, 2]));
		expect(first).toEqual({ status: 'recorded', firstSeenItemIds: [1, 2] });
		expect(await store.recordObservation(observation('one', [1, 2]))).toEqual({ status: 'duplicate', firstSeenItemIds: [1, 2] });
		expect(await store.recordObservation(observation('two', [2, 3]))).toEqual({ status: 'recorded', firstSeenItemIds: [3] });
		store.close();
		const db = await openRaw(factory, name, 1);
		for (const child of [HALLOWEEN_OBSERVATION_STORE, HALLOWEEN_SEEN_STORE, HALLOWEEN_NOTICE_STORE, HALLOWEEN_EPISODE_STORE]) {
			expect(db.objectStoreNames.contains(child)).toBe(true);
		}
		db.close();
	});

	it('isolates vault/account scopes across windows and rejects conflicting observation reuse', async () => {
		const factory = new IDBFactory();
		const name = dbName('windows');
		const first = await IndexedDbHalloweenStore.open(factory, name);
		const second = await IndexedDbHalloweenStore.open(factory, name);
		await first.recordObservation(observation('shared', [1]));
		expect(await second.recordObservation({ ...observation('shared', [1]), accountRef: 'other' }))
			.toMatchObject({ firstSeenItemIds: [1] });
		await expect(second.recordObservation(observation('shared', [2]))).rejects.toMatchObject({ failure: 'corrupt' });
		first.close(); second.close();
	});

	it('deduplicates an episode per item, persists unread notices and acknowledges explicitly', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), dbName('notice'));
		await expect(store.enqueueNotice({
			...notice('malformed', [9]),
			items: [{ itemId: 9, quantity: 1, name: null, reasons: [{ code: 'valuable', netUnitCopper: 10_000 } as never] }],
		})).rejects.toMatchObject({ failure: 'corrupt' });
		const created = await store.enqueueNotice(notice('n1', [1, 2]));
		expect(created?.items.map(({ itemId }) => itemId)).toEqual([1, 2]);
		const second = await store.enqueueNotice(notice('n2', [2, 3]));
		expect(second?.items.map(({ itemId }) => itemId)).toEqual([3]);
		expect(await store.readNotices('vault', 'account')).toHaveLength(2);
		expect(await store.acknowledge('vault', 'account', 'n1', '2026-08-29T12:01:00.000Z')).toBe(true);
		expect((await store.readNotices('vault', 'account')).find(({ noticeId }) => noticeId === 'n1')?.acknowledgedAt).not.toBeNull();
		store.close();
	});

	it('fails closed for a future database, corruption and a closed/versionchanged adapter', async () => {
		const factory = new IDBFactory();
		const future = dbName('future');
		(await openRaw(factory, future, 2)).close();
		await expect(IndexedDbHalloweenStore.open(factory, future, 1)).rejects.toMatchObject({ failure: 'future_schema' });

		const corruptName = dbName('corrupt');
		const store = await IndexedDbHalloweenStore.open(factory, corruptName);
		store.close();
		const raw = await openRaw(factory, corruptName, 1);
		const tx = raw.transaction(HALLOWEEN_SEEN_STORE, 'readwrite');
		tx.objectStore(HALLOWEEN_SEEN_STORE).put({ vaultId: 'vault', accountRef: 'account', itemId: 8, bad: true });
		await transactionDone(tx); raw.close();
		const reopened = await IndexedDbHalloweenStore.open(factory, corruptName);
		await expect(reopened.readRecentItemIds('vault', 'account')).rejects.toMatchObject({ failure: 'corrupt' });
		reopened.close();
		await expect(reopened.readNotices('vault', 'account')).rejects.toMatchObject({ failure: 'unavailable' });
	});

	it('closes on versionchange, rejects blocked upgrades and classifies quota without fallback', async () => {
		const factory = new IDBFactory();
		const changedName = dbName('versionchange');
		const current = await IndexedDbHalloweenStore.open(factory, changedName, 1);
		const upgraded = await IndexedDbHalloweenStore.open(factory, changedName, 2);
		await expect(current.readNotices('vault', 'account')).rejects.toMatchObject({ failure: 'unavailable' });
		upgraded.close();

		const blockedName = dbName('blocked');
		const initialized = await IndexedDbHalloweenStore.open(factory, blockedName, 1); initialized.close();
		const blocker = await openRaw(factory, blockedName, 1);
		await expect(IndexedDbHalloweenStore.open(factory, blockedName, 2)).rejects.toMatchObject({ failure: 'blocked' });
		blocker.close();
		expect(halloweenStoreFailureFrom(new DOMException('quota', 'QuotaExceededError'))).toBe('quota');
	});
});

function observation(id: string, ids: number[]): HalloweenObservationV1 {
	return { version: 1, vaultId: 'vault', accountRef: 'account', observationId: id, episodeId: 'episode',
		observedAt: '2026-08-29T12:00:00.000Z', source: 'assisted_poll', coverage: 'complete',
		gains: ids.map((itemId) => ({ itemId, quantity: 1 })) };
}
function notice(noticeId: string, ids: number[]): HalloweenNoticeV1 {
	return { version: 1, vaultId: 'vault', accountRef: 'account', noticeId, episodeId: 'episode',
		observedAt: noticeId === 'n1' ? '2026-08-29T12:00:00.000Z' : '2026-08-29T12:00:01.000Z',
		source: 'assisted_poll', wording: 'observed_change', coverage: 'complete', acknowledgedAt: null,
		items: ids.map((itemId) => ({ itemId, quantity: 1, name: null, reasons: [{ code: 'first_seen' }] })) };
}
let sequence = 0;
function dbName(label: string): string { sequence += 1; return `halloween-${label}-${String(sequence)}`; }
function openRaw(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => { const request = factory.open(name, version); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('open failed')); });
}
function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed')); transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted')); });
}
