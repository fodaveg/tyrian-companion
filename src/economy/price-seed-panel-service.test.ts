import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type { HttpRequest, HttpResponse, HttpTransport } from '../core/http';
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
		factory,
		vaultId: 'vault',
		transport,
		now: () => Date.parse('2026-09-03T00:00:00.000Z'),
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
			factory,
			vaultId: 'vault',
			transport: { send: async (request) => { requests.push(request); return { status: 503, headers: {}, body: null }; } },
			now: () => Date.parse('2026-09-04T00:00:00.000Z'),
			cacheTtlMs: 0,
		});
		const refreshed = await stale.ensure(36_038);
		expect(refreshed.status).toBe('seeded');
		expect(refreshed.days).toHaveLength(2);
		expect(refreshed.failureReason).not.toBeNull();
	});
});
