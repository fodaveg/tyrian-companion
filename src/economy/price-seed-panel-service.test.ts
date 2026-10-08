import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { HttpRequest, HttpResponse, HttpTransport } from '../core/http';
import { SerialTaskQueue, runSerialTaskUnqueued, type SerialTaskRunner } from '../core/serial-task-queue';
import { indexedDbPriceHistoryPort } from '../host/indexed-db-price-history';
import { PriceHistoryPanelSeedService } from './price-seed-panel-service';

const RECORDS = [
	{ date: '2026-08-01', buy_price_avg: 100, sell_price_avg: 110 },
	{ date: '2026-08-02', buy_price_avg: 105, sell_price_avg: 115 },
];

function harness(
	response?: () => Promise<HttpResponse>,
): { service: PriceHistoryPanelSeedService; requests: HttpRequest[]; factory: IDBFactory } {
	const requests: HttpRequest[] = [];
	const factory = new IDBFactory();
	const transport: HttpTransport = {
		send: async (request) => {
			requests.push(request);
			return await (response?.() ?? Promise.resolve({ status: 200, headers: {}, body: RECORDS }));
		},
	};
	const service = new PriceHistoryPanelSeedService({
		priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }),
		vaultId: 'vault',
		transport,
		now: () => Date.parse('2026-09-03T00:00:00.000Z'),
		serialize: runSerialTaskUnqueued,
	});
	return { service, requests, factory };
}

describe('PriceHistoryPanelSeedService', () => {
	it('never touches the network until ensure is called', () => {
		const { requests } = harness();
		expect(requests).toHaveLength(0);
	});

	it('downloads once, then serves the second ensure from cache without a request', async () => {
		const { service, requests } = harness();
		const first = await service.ensure(36_038);
		expect(first.status).toBe('seeded');
		expect(first.days).toHaveLength(2);
		expect(requests).toHaveLength(1);
		const second = await service.ensure(36_038);
		expect(second.status).toBe('seeded');
		expect(second.days).toHaveLength(2);
		expect(requests).toHaveLength(1);
	});

	/**
	 * H9.1/H9.2 chart: this service feeds the panel's and the note's chart, which
	 * want the whole published history, not H13.2's 400-day sell-rule window.
	 * `sell-signal-runtime.test.ts` ('asks datawars2 once...') is the regression
	 * proof that the sell rule's own fetch is untouched by this: it still trims
	 * the same fixture to 399 days because it never overrides `maxDays`.
	 */
	it('keeps more than 400 days for the chart, unlike the H13.2 sell-rule default', async () => {
		const longRecords = Array.from({ length: 500 }, (_unused, index) => ({
			date: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 86_400_000).toISOString().slice(0, 10),
			buy_price_avg: 100 + index,
		}));
		const { service } = harness(async () => ({ status: 200, headers: {}, body: longRecords }));
		const state = await service.ensure(36_038);
		expect(state.status).toBe('seeded');
		expect(state.days).toHaveLength(500);
	});

	/**
	 * Z12 (rule H18.17, one request per item per 24 h): a copy under 24 h old is served from the
	 * cache whatever its length, and opening the panel again never asks the network.
	 */
	it('serves a copy under 24 h old without any request, trimmed to 400 days or not, on every open', async () => {
		const { service, requests, factory } = harness();
		const cache = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		const days = Array.from({ length: 400 }, (_unused, index) => ({
			dayUtc: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 86_400_000).toISOString().slice(0, 10),
			bidCopper: 100, askCopper: null,
		}));
		await cache.put('vault', 36_038, {
			version: 1, itemId: 36_038, source: 'datawars2', retrievedAt: '2026-09-02T23:00:00.000Z', days,
		}, Date.parse('2026-09-02T23:00:00.000Z'));
		cache.close();

		expect((await service.ensure(36_038)).days).toHaveLength(400);
		expect((await service.ensure(36_038)).days).toHaveLength(400);
		expect(requests).toHaveLength(0);
	});

	it('shares one in-flight download between concurrent callers of the same item', async () => {
		const { service, requests } = harness();
		const [first, second] = await Promise.all([service.ensure(36_038), service.ensure(36_038)]);
		expect(first).toEqual(second);
		expect(requests).toHaveLength(1);
	});

	it('declares no_seed on a first failure and keeps a clean idle state for an unrelated item', async () => {
		const { service, requests } = harness(async () => ({ status: 503, headers: {}, body: null }));
		const state = await service.ensure(36_038);
		expect(state).toMatchObject({ status: 'no_seed', itemId: 36_038, days: [] });
		expect(requests).toHaveLength(1);
		expect(service.getState(99).status).toBe('idle');
	});

	it('keeps serving a stale cached seed when a refresh fails, rather than blanking it', async () => {
		const { service, requests, factory } = harness();
		const first = await service.ensure(36_038);
		expect(first.status).toBe('seeded');
		expect(requests).toHaveLength(1);
		// A fresh service instance sharing the same database, but with a zero TTL so the cached
		// entry above is immediately treated as due for a refresh; that refresh then fails.
		const stale = new PriceHistoryPanelSeedService({
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }),
			vaultId: 'vault',
			transport: { send: async (request) => { requests.push(request); return { status: 503, headers: {}, body: null }; } },
			now: () => Date.parse('2026-09-04T00:00:00.000Z'),
			serialize: runSerialTaskUnqueued,
			cacheTtlMs: 0,
		});
		const refreshed = await stale.ensure(36_038);
		expect(refreshed.status).toBe('seeded');
		expect(refreshed.days).toHaveLength(2);
		expect(refreshed.failureReason).not.toBeNull();
	});
});

/**
 * Task 0812d53e. The panel and every `tyrian-price-history` note block call `ensure`, each for its
 * own item: the per-item flight map alone let N different items be N requests in flight.
 */
describe('PriceHistoryPanelSeedService downloads through the queue it was handed', () => {
	/** A transport whose requests are held until the test answers them, one by one. */
	function heldHarness(serialize: SerialTaskRunner) {
		const requested: number[] = [];
		const held: Array<() => void> = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const factory = new IDBFactory();
		const service = new PriceHistoryPanelSeedService({
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }),
			vaultId: 'vault',
			transport: {
				send: async (request) => {
					requested.push(Number(new URL(request.url).searchParams.get('itemID')));
					inFlight += 1;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise<void>((resolve) => { held.push(resolve); });
					inFlight -= 1;
					return { status: 200, headers: {}, body: RECORDS };
				},
			},
			now: () => Date.parse('2026-09-03T00:00:00.000Z'),
			serialize,
		});
		return {
			service, requested, factory,
			maxInFlight: () => maxInFlight,
			/** Every item has read its cache and reached its download, queued or sent. */
			allLoading: async (itemIds: readonly number[]) => {
				await vi.waitFor(() => {
					expect(itemIds.map((itemId) => service.getState(itemId).status)).toEqual(itemIds.map(() => 'loading'));
				});
			},
			/** Answers the request in flight and waits for the next one to start, if one is expected. */
			answerOldest: async (expectedRequests: number) => {
				const release = held.shift();
				if (release === undefined) throw new Error('No request is held.');
				release();
				await vi.waitFor(() => { expect(requested).toHaveLength(expectedRequests); });
			},
		};
	}

	it('several items asked for at once, as several note blocks do, are requested one at a time, in arrival order', async () => {
		const queue = new SerialTaskQueue();
		const { service, requested, maxInFlight, allLoading, answerOldest } = heldHarness(queue.runner('interactive'));

		const loads = [service.ensure(101), service.ensure(102), service.ensure(103)];
		await allLoading([101, 102, 103]);
		expect(requested).toEqual([101]);

		await answerOldest(2);
		expect(requested).toEqual([101, 102]);
		await answerOldest(3);
		expect(requested).toEqual([101, 102, 103]);
		await answerOldest(3);

		expect((await Promise.all(loads)).map((state) => state.status)).toEqual(['seeded', 'seeded', 'seeded']);
		expect(maxInFlight()).toBe(1);
	});

	it('a turn the queue dropped requests nothing, writes no cache, and leaves the item as it was before the load', async () => {
		const queue = new SerialTaskQueue();
		const { service, requested, factory, allLoading } = heldHarness(queue.runner('interactive'));
		// Something else has the queue, so the two loads below wait for a turn that never comes.
		let endOther!: () => void;
		const other = queue.run('interactive', () => new Promise<void>((resolve) => { endOther = resolve; }));

		const loads = [service.ensure(101), service.ensure(102)];
		await allLoading([101, 102]);
		expect(requested).toEqual([]);
		queue.dispose();
		const states = await Promise.all(loads);
		endOther();
		await other;

		expect(requested).toEqual([]);
		expect(states.map((state) => state.status)).toEqual(['idle', 'idle']);
		const reader = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		expect(await reader.get('vault', 101)).toBeNull();
		expect(await reader.get('vault', 102)).toBeNull();
		reader.close();
	});
});
