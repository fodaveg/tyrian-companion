import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { ApiPollOutcome, ApiPollSchedulerState } from '../sessions/api-poll-scheduler';
import type { ApiPollScheduler } from '../sessions/api-poll-scheduler';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { PriceHistoryRuntime } from './price-history-runtime';
import { PRICE_HISTORY_DB_NAME, type PriceHistoryDailyV1, type PriceHistorySettings } from './price-history-model';
import { IndexedDbPriceHistoryStore } from './price-history-store';

const ENABLED: PriceHistorySettings = { enabled: true, intervalMinutes: 15, rawRetentionDays: 7, dailyRetentionDays: 180 };

describe('PriceHistoryRuntime', () => {
	it('construction and the disabled state have no DB, timer, or network effects', async () => {
		const factory = new IDBFactory();
		const open = vi.spyOn(factory, 'open');
		const requestDetailed = vi.fn();
		const scheduler = new FakeScheduler();
		const runtime = createRuntime(factory, requestDetailed, scheduler);
		expect(open).not.toHaveBeenCalled();
		expect(scheduler.start).not.toHaveBeenCalled();
		expect(requestDetailed).not.toHaveBeenCalled();
		await runtime.activate({ ...ENABLED, enabled: false });
		expect(open).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it('starts only after opt-in, changes 15 to 5 minutes, and forwards offline/wake/dispose', async () => {
		const scheduler = new FakeScheduler();
		const runtime = createRuntime(new IDBFactory(), vi.fn(async (path: string) => response(path)), scheduler);
		await runtime.activate(ENABLED);
		expect(scheduler.start).toHaveBeenCalledWith(900_000);
		expect(runtime.getState()).toMatchObject({ status: 'collecting', watchItemIds: [36_038, 36_041, 48_715, 73_474, 105_402] });
		await runtime.configure({ ...ENABLED, intervalMinutes: 5 });
		expect(scheduler.updateInterval).toHaveBeenCalledWith(300_000);
		runtime.setOnline(false);
		runtime.notifyWake();
		expect(scheduler.setOnline).toHaveBeenCalledWith(false);
		expect(scheduler.notifyWake).toHaveBeenCalledTimes(1);
		runtime.dispose();
		expect(scheduler.dispose).toHaveBeenCalledTimes(1);
	});

	it('applies configure changes interleaved with a deferred store open without abandoning activation', async () => {
		const factory = new IDBFactory();
		const opened = await IndexedDbPriceHistoryStore.open(factory);
		const openReady = deferred<IndexedDbPriceHistoryStore>();
		const open = vi.spyOn(IndexedDbPriceHistoryStore, 'open').mockImplementation(async () => await openReady.promise);
		const scheduler = new FakeScheduler();
		const runtime = createRuntime(factory, vi.fn(async (path: string) => response(path)), scheduler);
		const activation = runtime.activate(ENABLED);
		const configuration = runtime.configure({ ...ENABLED, intervalMinutes: 5, rawRetentionDays: 2, dailyRetentionDays: 42 });
		expect(runtime.getState().status).toBe('loading');
		expect(scheduler.start).not.toHaveBeenCalled();
		openReady.resolve(opened);
		await Promise.all([activation, configuration]);
		expect(runtime.getState().status).toBe('collecting');
		expect(scheduler.start).toHaveBeenCalledWith(300_000);
		expect(scheduler.updateInterval).toHaveBeenCalledWith(300_000);
		runtime.dispose();
		open.mockRestore();
	});

	it('captures one current slot per poll and does not synthesize missed intervals', async () => {
		const scheduler = new FakeScheduler();
		const requestDetailed = vi.fn(async (path: string) => response(path));
		let now = 1_800_001;
		const runtime = createRuntime(new IDBFactory(), requestDetailed, scheduler, () => now);
		await runtime.activate(ENABLED);
		expect(await scheduler.poll()).toEqual({ kind: 'success' });
		now += 10 * 900_000;
		expect(await scheduler.poll()).toEqual({ kind: 'success' });
		expect(requestDetailed).toHaveBeenCalledTimes(2);
		runtime.dispose();
	});

	it('projects offline and backoff states without opening another store', async () => {
		const scheduler = new FakeScheduler();
		const runtime = createRuntime(new IDBFactory(), vi.fn(async (path: string) => response(path)), scheduler);
		await runtime.activate(ENABLED);
		scheduler.publish('paused_offline');
		expect(runtime.getState().status).toBe('offline');
		scheduler.publish('backoff');
		expect(runtime.getState().status).toBe('backoff');
		runtime.dispose();
	});

	it('stops on an invalid public payload without misreporting an IndexedDB failure', async () => {
		const scheduler = new FakeScheduler();
		const runtime = createRuntime(new IDBFactory(), vi.fn(async () => ({ status: 200, headers: {}, body: [{ id: 999_999 }] })), scheduler);
		await runtime.activate(ENABLED);
		expect(await scheduler.poll()).toEqual({ kind: 'fatal' });
		scheduler.publish('fatal');
		expect(runtime.getState().status).toBe('invalid_payload');
		runtime.dispose();
	});

	it('fails closed and stops scheduling when the local schema is from a future version', async () => {
		const factory = new IDBFactory();
		const request = factory.open(PRICE_HISTORY_DB_NAME, 2);
		const future = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onerror = () => reject(request.error ?? new Error('Future schema setup failed.'));
			request.onsuccess = () => resolve(request.result);
		});
		future.close();
		const scheduler = new FakeScheduler();
		const runtime = createRuntime(factory, vi.fn(), scheduler);
		await runtime.activate(ENABLED);
		expect(runtime.getState().status).toBe('store_future');
		expect(scheduler.stop).toHaveBeenCalledOnce();
		expect(scheduler.start).not.toHaveBeenCalled();
		runtime.dispose();
	});

	it('does not commit or publish a delayed poll after the runtime is disabled', async () => {
		const factory = new IDBFactory();
		const scheduler = new FakeScheduler();
		const changed = vi.fn();
		const responseReady = deferred<void>();
		const requestDetailed = vi.fn(async (path: string) => { await responseReady.promise; return response(path); });
		const runtime = createRuntime(factory, requestDetailed, scheduler, () => 1_800_001, changed, 'vault-delayed');
		await runtime.activate(ENABLED);
		const poll = scheduler.poll();
		await vi.waitFor(() => expect(requestDetailed).toHaveBeenCalledOnce());
		await runtime.configure({ ...ENABLED, enabled: false });
		const changesAfterDisable = changed.mock.calls.length;
		responseReady.resolve();
		await expect(poll).resolves.toEqual({ kind: 'success' });
		expect(runtime.getState().status).toBe('disabled');
		expect(changed).toHaveBeenCalledTimes(changesAfterDisable);
		const store = await IndexedDbPriceHistoryStore.open(factory);
		expect(await store.readSnapshots('vault-delayed')).toEqual([]);
		store.close();
		runtime.dispose();
	});

	it('fences older series reads and suppresses a delayed read after dispose', async () => {
		const scheduler = new FakeScheduler();
		const changed = vi.fn();
		const runtime = createRuntime(new IDBFactory(), vi.fn(async (path: string) => response(path)), scheduler, () => 1_800_001, changed);
		await runtime.activate(ENABLED);
		const first = deferred<PriceHistoryDailyV1[]>();
		const second = deferred<PriceHistoryDailyV1[]>();
		const afterDispose = deferred<PriceHistoryDailyV1[]>();
		const read = vi.spyOn(IndexedDbPriceHistoryStore.prototype, 'readDaily')
			.mockImplementation(async (_vaultId, itemId) => await (itemId === 1 ? first.promise : itemId === 2 ? second.promise : afterDispose.promise));
		const firstLoad = runtime.loadSeries(1, 'bid', 42);
		const secondLoad = runtime.loadSeries(2, 'ask', 90);
		second.resolve([daily(2)]);
		await secondLoad;
		expect(runtime.getState()).toMatchObject({ selectedItemId: 2, selectedSide: 'ask', windowDays: 90 });
		first.resolve([daily(1)]);
		await firstLoad;
		expect(runtime.getState()).toMatchObject({ selectedItemId: 2, selectedSide: 'ask', windowDays: 90 });
		const delayedLoad = runtime.loadSeries(3, 'bid', 42);
		expect(runtime.getState().selectedItemId).toBe(3);
		runtime.dispose();
		const changesAfterDispose = changed.mock.calls.length;
		afterDispose.resolve([daily(3)]);
		await delayedLoad;
		expect(runtime.getState().selectedItemId).toBe(3);
		expect(changed).toHaveBeenCalledTimes(changesAfterDispose);
		read.mockRestore();
	});

	it('does not let a poll refresh of A supersede an explicit B selection during deferred compaction', async () => {
		const scheduler = new FakeScheduler();
		const runtime = createRuntime(new IDBFactory(), vi.fn(async (path: string) => response(path)), scheduler, () => 1_800_001);
		await runtime.activate(ENABLED);
		const compactionReady = deferred<Awaited<ReturnType<IndexedDbPriceHistoryStore['compactAndPrune']>>>();
		const compact = vi.spyOn(IndexedDbPriceHistoryStore.prototype, 'compactAndPrune')
			.mockImplementation(async () => await compactionReady.promise);
		const seriesReady = deferred<PriceHistoryDailyV1[]>();
		const read = vi.spyOn(IndexedDbPriceHistoryStore.prototype, 'readDaily')
			.mockImplementation(async () => await seriesReady.promise);
		const poll = scheduler.poll();
		await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
		const selected = runtime.loadSeries(36_041, 'bid', 90);
		expect(runtime.getState()).toMatchObject({ selectedItemId: 36_041, selectedSide: 'bid', windowDays: 90, status: 'loading' });
		compactionReady.resolve({
			dailyRecords: 0, prunedSnapshots: 0, prunedDaily: 0,
			compactedDays: 1, peakSnapshotsPerDay: 1, peakSnapshotTuplesPerDay: 5,
		});
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
		expect(read.mock.calls.every(([, itemId]) => itemId === 36_041)).toBe(true);
		seriesReady.resolve([daily(36_041)]);
		await Promise.all([selected, poll]);
		expect(runtime.getState()).toMatchObject({ selectedItemId: 36_041, selectedSide: 'bid', windowDays: 90 });
		read.mockRestore();
		compact.mockRestore();
		runtime.dispose();
	});
});

class FakeScheduler {
	poll: () => Promise<ApiPollOutcome> = async () => ({ kind: 'fatal' });
	onStateChange: (state: Readonly<ApiPollSchedulerState>) => void = () => undefined;
	start = vi.fn();
	updateInterval = vi.fn();
	setOnline = vi.fn();
	notifyWake = vi.fn();
	stop = vi.fn();
	dispose = vi.fn();
	publish(status: ApiPollSchedulerState['status']): void {
		this.onStateChange({ status, intervalMs: 900_000, nextRunAt: status === 'backoff' ? 2_000 : null,
			lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0 });
	}
}

function createRuntime(
	factory: IDBFactory,
	requestDetailed: ReturnType<typeof vi.fn>,
	scheduler: FakeScheduler,
	now: () => number = () => 1_000,
	onStateChange: () => void = () => undefined,
	vaultId = `vault-${crypto.randomUUID()}`,
): PriceHistoryRuntime {
	return new PriceHistoryRuntime({
		factory, vaultId,
		gateway: { requestDetailed }, rateLimit: new RateLimitCoordinator({ now }), now, onStateChange,
		scheduler: (poll, onStateChange) => {
			scheduler.poll = poll; scheduler.onStateChange = onStateChange;
			return scheduler as unknown as ApiPollScheduler;
		},
	});
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function daily(itemId: number): PriceHistoryDailyV1 {
	return {
		version: 1, vaultId: 'vault', itemId, dayUtc: '1970-01-01', snapshotCount: 1, partialSnapshotCount: 0,
		bid: { count: 1, minCopper: itemId, maxCopper: itemId, medianCopperX2: itemId * 2, closeCopper: itemId, closeCapturedAtMs: 1 },
		ask: { count: 1, minCopper: itemId, maxCopper: itemId, medianCopperX2: itemId * 2, closeCopper: itemId, closeCapturedAtMs: 1 },
	};
}

function response(path: string) {
	const ids = path.split('ids=')[1]!.split(',').map(Number);
	return { status: 200, headers: {}, body: ids.map((id) => ({
		id, whitelisted: true, buys: { quantity: 1, unit_price: id + 10 }, sells: { quantity: 1, unit_price: id + 20 },
	})) };
}
