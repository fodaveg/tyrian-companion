import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { ApiPollOutcome, ApiPollSchedulerState } from '../sessions/api-poll-scheduler';
import type { ApiPollScheduler } from '../sessions/api-poll-scheduler';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { PriceHistoryRuntime } from './price-history-runtime';
import { PRICE_HISTORY_DB_NAME, type PriceHistorySettings } from './price-history-model';

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
): PriceHistoryRuntime {
	return new PriceHistoryRuntime({
		factory, vaultId: `vault-${crypto.randomUUID()}`,
		gateway: { requestDetailed }, rateLimit: new RateLimitCoordinator({ now }), now,
		scheduler: (poll, onStateChange) => {
			scheduler.poll = poll; scheduler.onStateChange = onStateChange;
			return scheduler as unknown as ApiPollScheduler;
		},
	});
}

function response(path: string) {
	const ids = path.split('ids=')[1]!.split(',').map(Number);
	return { status: 200, headers: {}, body: ids.map((id) => ({
		id, whitelisted: true, buys: { quantity: 1, unit_price: id + 10 }, sells: { quantity: 1, unit_price: id + 20 },
	})) };
}
