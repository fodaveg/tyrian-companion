import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { HalloweenPriceAlertRuntime } from './halloween-price-alert-runtime';
import {
	HALLOWEEN_DB_NAME,
	HALLOWEEN_DB_VERSION,
	HALLOWEEN_PRICE_ALERT_STORE,
	IndexedDbHalloweenStore,
} from './halloween-store';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

describe('Halloween price alert runtime', () => {
	it('does nothing while disabled and never opens the H11 database by construction', async () => {
		const factory = new IDBFactory();
		const open = vi.spyOn(factory, 'open');
		const runtime = new HalloweenPriceAlertRuntime({ factory, vaultId: 'vault', accountRef: () => 'account' });
		const port = { readDaily: vi.fn(async () => history(40)) };
		await runtime.evaluate(port, NOW);
		expect(port.readDaily).not.toHaveBeenCalled();
		expect(runtime.getState().status).toBe('disabled');
		await runtime.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, false);
		expect(open).not.toHaveBeenCalled();
	});

	it('emits only a durable below-to-high crossing, at most once per day, and requires a valid below to rearm', async () => {
		const factory = new IDBFactory();
		const onNotice = vi.fn();
		const runtime = new HalloweenPriceAlertRuntime({ factory, vaultId: 'vault', accountRef: () => 'account', onNotice });
		await runtime.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);
		await runtime.evaluate(port(40), NOW);
		expect(onNotice).not.toHaveBeenCalled();
		await runtime.evaluate(port(20, NOW + 1), NOW + 1);
		await runtime.evaluate(port(40, NOW + 2), NOW + 2);
		expect(onNotice).toHaveBeenCalledOnce();
		const noticeId = runtime.getState().notices[0]!.noticeId;
		expect(await runtime.acknowledge(noticeId)).toBe(true);
		expect(runtime.getState().unreadCount).toBe(0);
		await runtime.evaluate(port(40, NOW + 3), NOW + 3);
		await runtime.evaluate({ readDaily: async () => [] }, NOW + 4);
		await runtime.evaluate(port(40, NOW + 5), NOW + 5);
		expect(onNotice).toHaveBeenCalledOnce();
		runtime.dispose();
	});

	it('keeps daily suppression across settings changes and competing windows', async () => {
		const factory = new IDBFactory();
		const firstNotice = vi.fn(); const secondNotice = vi.fn();
		const first = new HalloweenPriceAlertRuntime({ factory, vaultId: 'vault', accountRef: () => 'account', onNotice: firstNotice });
		const second = new HalloweenPriceAlertRuntime({ factory, vaultId: 'vault', accountRef: () => 'account', onNotice: secondNotice });
		const settings = { enabled: true, minimumAboveP90Bps: 0, cooldownHours: 6 as const };
		await Promise.all([first.configure(settings, true), second.configure(settings, true)]);
		await first.evaluate(port(20), NOW);
		await first.configure({ ...settings, minimumAboveP90Bps: 100 }, true);
		await Promise.all([first.evaluate(port(40, NOW + 1), NOW + 1), second.evaluate(port(40, NOW + 1), NOW + 1)]);
		expect(firstNotice.mock.calls.length + secondNotice.mock.calls.length).toBe(1);
		first.dispose(); second.dispose();
	});

	it('projects the durable accepted result instead of a stale candidate returned by its local read', async () => {
		const factory = new IDBFactory();
		const runtime = new HalloweenPriceAlertRuntime({ factory, vaultId: 'vault', accountRef: () => 'account' });
		await runtime.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);
		const accepted = validProjection('high', NOW);
		const commit = vi.spyOn(IndexedDbHalloweenStore.prototype, 'commitPriceProjection').mockResolvedValue({
			notice: null, shouldNotify: false, accepted: false, projection: accepted,
		});
		await runtime.evaluate(port(20, NOW + 1), NOW + 1);
		expect(runtime.getState()).toMatchObject({ status: 'high', projection: accepted });
		commit.mockRestore(); runtime.dispose();
	});

	it('drops a stale local read after dispose and fails closed for future or corrupt H11 state', async () => {
		const delayedFactory = new IDBFactory();
		const onNotice = vi.fn();
		const delayed = new HalloweenPriceAlertRuntime({
			factory: delayedFactory, vaultId: 'vault', accountRef: () => 'account', onNotice,
		});
		await delayed.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);
		let release!: (value: PriceHistoryDailyV1[]) => void;
		const evaluation = delayed.evaluate({ readDaily: async () => await new Promise((resolve) => { release = resolve; }) }, NOW);
		await Promise.resolve();
		delayed.dispose();
		release(history(40));
		await evaluation;
		expect(delayed.getState().status).toBe('disabled');
		expect(onNotice).not.toHaveBeenCalled();

		const futureFactory = new IDBFactory();
		(await openRaw(futureFactory, HALLOWEEN_DB_NAME, HALLOWEEN_DB_VERSION + 1)).close();
		const future = new HalloweenPriceAlertRuntime({ factory: futureFactory, vaultId: 'vault', accountRef: () => 'account' });
		await future.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);
		expect(future.getState().status).toBe('store_future');

		const corruptFactory = new IDBFactory();
		(await IndexedDbHalloweenStore.open(corruptFactory)).close();
		const raw = await openRaw(corruptFactory, HALLOWEEN_DB_NAME, HALLOWEEN_DB_VERSION);
		const tx = raw.transaction(HALLOWEEN_PRICE_ALERT_STORE, 'readwrite');
		const contradictory = { ...validProjection('high', NOW), bidCopper: 90 };
		tx.objectStore(HALLOWEEN_PRICE_ALERT_STORE).put({
			version: 2, vaultId: 'vault', accountRef: 'account', itemId: 36_038, armed: false,
			lastValidDayUtc: contradictory.dayUtc, lastValidCapturedAtMs: contradictory.capturedAtMs,
			lastValidProjection: contradictory, lastNotifiedDayUtc: null, cooldownUntilMs: 0,
		});
		await transactionDone(tx); raw.close();
		const corrupt = new HalloweenPriceAlertRuntime({ factory: corruptFactory, vaultId: 'vault', accountRef: () => 'account' });
		await corrupt.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);
		await corrupt.evaluate(port(20), NOW);
		expect(corrupt.getState().status).toBe('store_corrupt');
		future.dispose(); corrupt.dispose();
	});

	it('clears the prior account immediately and projects only the account that finishes activation', async () => {
		const factory = new IDBFactory();
		const seed = await IndexedDbHalloweenStore.open(factory);
		await seed.commitPriceProjection('vault', 'account-a', validProjection('below', NOW - 2), 24);
		await seed.commitPriceProjection('vault', 'account-a', validProjection('high', NOW - 1), 24);
		seed.close();
		let accountRef = 'account-a';
		const runtime = new HalloweenPriceAlertRuntime({ factory, vaultId: 'vault', accountRef: () => accountRef });
		const settings = { enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 as const };
		await runtime.configure(settings, true);
		expect(runtime.getState().notices).toHaveLength(1);
		const delayed = deferred<ReturnType<typeof runtime.getState>['notices']>();
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the active store by the spy below.
		const original = IndexedDbHalloweenStore.prototype.readPriceNotices;
		const read = vi.spyOn(IndexedDbHalloweenStore.prototype, 'readPriceNotices')
			.mockImplementation(async function (this: IndexedDbHalloweenStore, vaultId, targetAccountRef) {
				return targetAccountRef === 'account-b' ? await delayed.promise : await original.call(this, vaultId, targetAccountRef);
			});
		accountRef = 'account-b';
		const switching = runtime.configure(settings, true);
		expect(runtime.getState()).toMatchObject({ status: 'loading', notices: [], projection: null, unreadCount: 0 });
		delayed.resolve([]);
		await switching;
		expect(runtime.getState()).toMatchObject({ status: 'ready', notices: [], projection: null, unreadCount: 0 });
		read.mockRestore(); runtime.dispose();
	});

	it('restarts a deferred activation when its captured account changes, even if the old read fails', async () => {
		const factory = new IDBFactory();
		let accountRef = 'account-a';
		const delayed = deferred<never>();
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the active store by the spy below.
		const original = IndexedDbHalloweenStore.prototype.readPriceNotices;
		const reads: string[] = [];
		const read = vi.spyOn(IndexedDbHalloweenStore.prototype, 'readPriceNotices')
			.mockImplementation(async function (this: IndexedDbHalloweenStore, vaultId, targetAccountRef) {
				reads.push(targetAccountRef);
				return targetAccountRef === 'account-a' ? await delayed.promise : await original.call(this, vaultId, targetAccountRef);
			});
		const runtime = new HalloweenPriceAlertRuntime({ factory, vaultId: 'vault', accountRef: () => accountRef });
		const activation = runtime.configure({ enabled: true, minimumAboveP90Bps: 0, cooldownHours: 24 }, true);
		await vi.waitFor(() => expect(reads).toEqual(['account-a']));
		accountRef = 'account-b';
		delayed.reject(new Error('stale account read failed'));
		await activation;
		expect(reads).toEqual(['account-a', 'account-b']);
		expect(runtime.getState()).toMatchObject({ status: 'ready', notices: [], unreadCount: 0 });
		read.mockRestore(); runtime.dispose();
	});
});

function port(today: number, capturedAtMs = NOW) { return { readDaily: async () => history(today, capturedAtMs) }; }

function history(today: number, capturedAtMs = NOW): PriceHistoryDailyV1[] {
	return [...Array.from({ length: 30 }, (_, index) => daily(NOW - (30 - index) * 86_400_000, index + 1)), daily(capturedAtMs, today)];
}

function daily(timestamp: number, closeCopper: number): PriceHistoryDailyV1 {
	return { version: 1, vaultId: 'vault', itemId: 36_038, dayUtc: new Date(timestamp).toISOString().slice(0, 10),
		snapshotCount: 1, partialSnapshotCount: 0,
		bid: { count: 1, minCopper: closeCopper, maxCopper: closeCopper, medianCopperX2: closeCopper * 2,
			closeCopper, closeCapturedAtMs: timestamp }, ask: null };
}

function validProjection(status: 'below' | 'high', capturedAtMs: number) {
	return { status, dayUtc: new Date(capturedAtMs).toISOString().slice(0, 10),
		bidCopper: status === 'high' ? 120 : 90, p90Copper: 100, capturedAtMs,
		referenceDays: 30 as const, minimumAboveP90Bps: 0 };
}

function openRaw(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('open failed'));
	});
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
	});
}
