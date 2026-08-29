import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
	HALLOWEEN_EPISODE_STORE, HALLOWEEN_NOTICE_STORE, HALLOWEEN_OBSERVATION_STORE, HALLOWEEN_SEEN_STORE,
	HALLOWEEN_DB_VERSION, HALLOWEEN_EPISODE_META_STORE, HALLOWEEN_META_STORE,
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
		expect(await store.recordObservation(observation('two', [2, 3]))).toEqual({ status: 'recorded', firstSeenItemIds: [2, 3] });
		store.close();
		const db = await openRaw(factory, name, HALLOWEEN_DB_VERSION);
		for (const child of [HALLOWEEN_OBSERVATION_STORE, HALLOWEEN_SEEN_STORE, HALLOWEEN_NOTICE_STORE,
			HALLOWEEN_EPISODE_STORE, HALLOWEEN_EPISODE_META_STORE, HALLOWEEN_META_STORE]) {
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

	it('replaces provisional episode evidence atomically at session final without a second notice', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), dbName('replace'));
		await store.enqueueNotice(notice('poll-1', [1, 2]));
		const final = { ...notice('final', [2]), source: 'session_final' as const,
			items: [{ itemId: 2, quantity: 9, name: null, reasons: [{ code: 'first_seen' as const }] }] };
		await expect(store.replaceEpisodeNotice('vault', 'account', 'episode', finalObservation('episode', [2]), final)).resolves.toMatchObject({
			notice: { items: [{ itemId: 2, quantity: 9 }] }, changed: true, shouldNotify: false,
		});
		expect(await store.readNotices('vault', 'account')).toEqual([final]);
		await expect(store.replaceEpisodeNotice('vault', 'account', 'episode', finalObservation('episode', [2]), final)).resolves.toEqual({
			notice: null, changed: false, shouldNotify: false,
		});
		expect(await store.readNotices('vault', 'account')).toHaveLength(1);
		store.close();
	});

	it('persists first-seen membership across assisted and final observations in one episode', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), dbName('episode-first-seen'));
		const assisted = await store.recordObservation(observation('assisted', [7]));
		expect(assisted.firstSeenItemIds).toEqual([7]);
		const final = await store.recordObservation({
			...observation('final-observation', [7]), source: 'session_final',
		});
		expect(final.firstSeenItemIds).toEqual([7]);
		store.close();
	});

	it('preserves acknowledgement, notifies only final-only episodes and seals final idempotently', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), dbName('final-ux'));
		await store.recordObservation(observation('poll', [1]));
		await store.enqueueNotice(notice('poll-notice', [1]));
		await store.acknowledge('vault', 'account', 'poll-notice', '2026-08-29T12:02:00.000Z');
		const final = { ...notice('final-notice', [1]), source: 'session_final' as const };
		await expect(store.replaceEpisodeNotice('vault', 'account', 'episode', finalObservation('episode', [1]), final)).resolves.toMatchObject({
			notice: { acknowledgedAt: '2026-08-29T12:02:00.000Z' }, shouldNotify: false, changed: true,
		});
		await expect(store.recordObservation({ ...observation('late', [2]), source: 'assisted_poll' }))
			.resolves.toEqual({ status: 'terminal', firstSeenItemIds: [] });
		await expect(store.replaceEpisodeNotice('vault', 'account', 'episode', finalObservation('episode', [1]), final)).resolves.toEqual({
			notice: null, changed: false, shouldNotify: false,
		});

		const finalOnly = { ...notice('other-final', [9]), episodeId: 'other', source: 'session_final' as const };
		await store.recordObservation({ ...observation('other-observation', [9]), episodeId: 'other', source: 'session_final' });
		await expect(store.replaceEpisodeNotice('vault', 'account', 'other', finalObservation('other', [9]), finalOnly)).resolves.toMatchObject({
			notice: { noticeId: 'other-final' }, shouldNotify: true, changed: true,
		});
		store.close();
	});

	it('marks final content unread and requests one foreground notice when it adds a new reason', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), dbName('ack-novel-reason'));
		await store.recordObservation(observation('poll-reason', [1]));
		await store.enqueueNotice(notice('poll-reason-notice', [1]));
		await store.acknowledge('vault', 'account', 'poll-reason-notice', '2026-08-29T12:02:00.000Z');
		const final = { ...notice('final-reason', [1]), source: 'session_final' as const,
			items: [{ itemId: 1, quantity: 2, name: null, reasons: [
				{ code: 'first_seen' as const }, { code: 'rare_unpriced_or_bound' as const, rarity: 'Rare' },
			] }] };
		await expect(store.replaceEpisodeNotice('vault', 'account', 'episode', finalObservation('episode', [1]), final))
			.resolves.toMatchObject({ notice: { acknowledgedAt: null }, changed: true, shouldNotify: true });
		expect((await store.readNotices('vault', 'account'))[0]?.acknowledgedAt).toBeNull();
		await expect(store.replaceEpisodeNotice('vault', 'account', 'episode', finalObservation('episode', [1]), {
			...final, items: [{ ...final.items[0]!, reasons: [{ code: 'valuable', netUnitCopper: 10_000,
				thresholdCopper: 10_000 }] }],
		})).resolves.toEqual({ notice: null, changed: false, shouldNotify: false });
		store.close();
	});

	it('persists backfill completion and rebuilds the durable seen union idempotently', async () => {
		const factory = new IDBFactory(); const name = dbName('backfill');
		const store = await IndexedDbHalloweenStore.open(factory, name);
		expect(await store.readLearningCoverage('vault', 'account')).toBeNull();
		const candidates = [{ observationId: 'note:a', episodeId: 'note-session:a', observedAt: '2026-08-29T12:00:00.000Z',
			coverage: 'complete' as const, gains: [{ itemId: 2, quantity: 3 }, { itemId: 4, quantity: 1 }] }];
		expect(await store.applyBackfill('vault', 'account', candidates, '2026-08-29T12:01:00.000Z')).toEqual([2, 4]);
		expect(await store.applyBackfill('vault', 'account', candidates, '2026-08-29T12:02:00.000Z')).toEqual([2, 4]);
		expect(await store.readLearningCoverage('vault', 'account')).toBe('complete');
		expect(await store.readRecentItemIds('vault', 'account')).toEqual([2, 4]);
		store.close();
		const reopened = await IndexedDbHalloweenStore.open(factory, name);
		expect(await reopened.readLearningCoverage('vault', 'account')).toBe('complete');
		reopened.close();
	});

	it('keeps lastObservedAt monotonic when an older historical backfill arrives later', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), dbName('seen-monotonic'));
		await store.recordObservation({ ...observation('recent-one', [1]), episodeId: 'recent-one',
			observedAt: '2026-08-29T13:00:00.000Z' });
		await store.recordObservation({ ...observation('recent-two', [2]), episodeId: 'recent-two',
			observedAt: '2026-08-29T12:00:00.000Z' });
		await store.applyBackfill('vault', 'account', [{ observationId: 'historical-one', episodeId: 'historical-one',
			observedAt: '2026-08-29T10:00:00.000Z', coverage: 'complete', gains: [{ itemId: 1, quantity: 1 }] }],
		'2026-08-29T13:01:00.000Z');
		expect(await store.readRecentItemIds('vault', 'account')).toEqual([1, 2]);
		store.close();
	});

	it('fails closed for a future database, corruption and a closed/versionchanged adapter', async () => {
		const factory = new IDBFactory();
		const future = dbName('future');
		(await openRaw(factory, future, HALLOWEEN_DB_VERSION + 1)).close();
		await expect(IndexedDbHalloweenStore.open(factory, future)).rejects.toMatchObject({ failure: 'future_schema' });

		const corruptName = dbName('corrupt');
		const store = await IndexedDbHalloweenStore.open(factory, corruptName);
		store.close();
		const raw = await openRaw(factory, corruptName, HALLOWEEN_DB_VERSION);
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
		const current = await IndexedDbHalloweenStore.open(factory, changedName);
		const upgraded = await IndexedDbHalloweenStore.open(factory, changedName, HALLOWEEN_DB_VERSION + 1);
		await expect(current.readNotices('vault', 'account')).rejects.toMatchObject({ failure: 'unavailable' });
		upgraded.close();

		const blockedName = dbName('blocked');
		const initialized = await IndexedDbHalloweenStore.open(factory, blockedName); initialized.close();
		const blocker = await openRaw(factory, blockedName, HALLOWEEN_DB_VERSION);
		await expect(IndexedDbHalloweenStore.open(factory, blockedName, HALLOWEEN_DB_VERSION + 1)).rejects.toMatchObject({ failure: 'blocked' });
		blocker.close();
		expect(halloweenStoreFailureFrom(new DOMException('quota', 'QuotaExceededError'))).toBe('quota');
	});

	it('fails closed on sabotaged episode and seen records instead of treating them as dedupe hits', async () => {
		const factory = new IDBFactory(); const name = dbName('sabotage');
		const store = await IndexedDbHalloweenStore.open(factory, name);
		await store.enqueueNotice(notice('n1', [1])); store.close();
		const raw = await openRaw(factory, name, HALLOWEEN_DB_VERSION);
		let tx = raw.transaction(HALLOWEEN_EPISODE_STORE, 'readwrite');
		tx.objectStore(HALLOWEEN_EPISODE_STORE).put({ version: 99, vaultId: 'vault', accountRef: 'account', episodeId: 'episode', itemId: 1, noticeId: 'n1' });
		await transactionDone(tx);
		tx = raw.transaction(HALLOWEEN_SEEN_STORE, 'readwrite');
		tx.objectStore(HALLOWEEN_SEEN_STORE).put({ version: 1, vaultId: 'other', accountRef: 'account', itemId: 7, lastObservedAt: '2026-08-29T12:00:00.000Z' });
		await transactionDone(tx); raw.close();
		const reopened = await IndexedDbHalloweenStore.open(factory, name);
		await expect(reopened.enqueueNotice(notice('n2', [1]))).rejects.toMatchObject({ failure: 'corrupt' });
		// A key-scoped record with an extra field is also corruption.
		const rawAgain = await openRaw(factory, name, HALLOWEEN_DB_VERSION);
		const seenTx = rawAgain.transaction(HALLOWEEN_SEEN_STORE, 'readwrite');
		seenTx.objectStore(HALLOWEEN_SEEN_STORE).put({ version: 1, vaultId: 'vault', accountRef: 'account', itemId: 7,
			lastObservedAt: '2026-08-29T12:00:00.000Z', extra: true });
		await transactionDone(seenTx); rawAgain.close();
		await expect(reopened.readRecentItemIds('vault', 'account')).rejects.toMatchObject({ failure: 'corrupt' });
		reopened.close();
	});

	it('fails closed on a terminal episode record with an invalid final payload', async () => {
		const factory = new IDBFactory(); const name = dbName('terminal-sabotage');
		const store = await IndexedDbHalloweenStore.open(factory, name); store.close();
		const raw = await openRaw(factory, name, HALLOWEEN_DB_VERSION);
		const tx = raw.transaction(HALLOWEEN_EPISODE_META_STORE, 'readwrite');
		tx.objectStore(HALLOWEEN_EPISODE_META_STORE).put({ version: 1, vaultId: 'vault', accountRef: 'account',
			episodeId: 'episode', finalFingerprint: '{"fake":true}' });
		await transactionDone(tx); raw.close();
		const reopened = await IndexedDbHalloweenStore.open(factory, name);
		await expect(reopened.recordObservation(observation('after-corruption', [1])))
			.rejects.toMatchObject({ failure: 'corrupt' });
		reopened.close();
	});
});

function observation(id: string, ids: number[]): HalloweenObservationV1 {
	return { version: 1, vaultId: 'vault', accountRef: 'account', observationId: id, episodeId: 'episode',
		observedAt: '2026-08-29T12:00:00.000Z', source: 'assisted_poll', coverage: 'complete',
		gains: ids.map((itemId) => ({ itemId, quantity: 1 })) };
}
function finalObservation(episodeId: string, ids: number[]): HalloweenObservationV1 {
	return { ...observation(`final:${episodeId}`, ids), episodeId, source: 'session_final' };
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
