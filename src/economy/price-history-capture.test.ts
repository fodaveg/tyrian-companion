import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { PriceHistoryCaptureService } from './price-history-capture';
import { PRICE_HISTORY_SEED_ITEM_IDS } from './price-history-model';
import { IndexedDbPriceHistoryStore } from './price-history-store';

describe('PriceHistoryCaptureService', () => {
	it('uses sequential batches of at most 200 ids and stores no listing quantities', async () => {
		const store = await opened('batches');
		await store.observeItems('vault', [
			...Array.from({ length: 196 }, (_, index) => index + 1),
			...PRICE_HISTORY_SEED_ITEM_IDS,
		], 1);
		let concurrent = 0;
		let maximumConcurrent = 0;
		const requestDetailed = vi.fn(async (path: string) => {
			concurrent += 1; maximumConcurrent = Math.max(maximumConcurrent, concurrent);
			const ids = idsFromPath(path);
			await Promise.resolve();
			concurrent -= 1;
			return response(ids);
		});
		const service = new PriceHistoryCaptureService({ requestDetailed }, new RateLimitCoordinator(), 'owner', () => 100);
		const result = await service.capture(store, 'vault', 0, 15);
		expect(result.status).toBe('complete');
		expect(requestDetailed).toHaveBeenCalledTimes(2);
		expect(requestDetailed.mock.calls.map(([path]) => idsFromPath(path).length)).toEqual([200, 1]);
		expect(maximumConcurrent).toBe(1);
		const persisted = await store.readSnapshots('vault');
		expect(JSON.stringify(persisted)).not.toContain('quantity');
		store.close();
	});

	it('persists an honest partial snapshot for omitted ids and null quote sides', async () => {
		const store = await opened('partial');
		const gateway: PublicCatalogGateway = { requestDetailed: async (path) => {
			const ids = idsFromPath(path);
			return response(ids.slice(0, -1), ids[0]);
		} };
		const result = await new PriceHistoryCaptureService(gateway, new RateLimitCoordinator(), 'owner', () => 100)
			.capture(store, 'vault', 0, 15);
		expect(result.status).toBe('partial');
		if (result.status !== 'partial') throw new Error('partial missing');
		expect(result.snapshot.missingItemIds).toHaveLength(1);
		expect(result.snapshot.items[0]).toEqual([36_038, null, 36_238]);
		store.close();
	});

	it.each([
		['extra', (ids: number[]) => [...priceRows(ids), row(999_999)]],
		['duplicate', (ids: number[]) => [...priceRows(ids), row(ids[0]!) ]],
		['malformed', (ids: number[]) => priceRows(ids).map((entry, index) => index === 0 ? { ...entry, buys: { quantity: 1 } } : entry)],
	])('rejects %s payloads without persisting a snapshot', async (_label, body) => {
		const store = await opened(`invalid-${_label}`);
		const gateway: PublicCatalogGateway = { requestDetailed: async (path) => ({ status: 200, headers: {}, body: body(idsFromPath(path)) }) };
		const result = await new PriceHistoryCaptureService(gateway, new RateLimitCoordinator(), 'owner', () => 100)
			.capture(store, 'vault', 0, 15);
		expect(result.status).toBe('invalid_payload');
		expect(await store.readSnapshots('vault')).toEqual([]);
		store.close();
	});

	it('shares 429 cooldown and reports it before another request', async () => {
		const store = await opened('rate-limit');
		let now = 0;
		const coordinator = new RateLimitCoordinator({ now: () => now });
		const requestDetailed = vi.fn(async () => { throw new HttpTransportError('http', 429, 30_000, 'limited'); });
		const service = new PriceHistoryCaptureService({ requestDetailed }, coordinator, 'owner', () => now);
		expect((await service.capture(store, 'vault', 0, 15)).status).toBe('rate_limited');
		now = 1;
		expect((await service.capture(store, 'vault', 900_000, 15)).status).toBe('rate_limited');
		expect(requestDetailed).toHaveBeenCalledTimes(1);
		store.close();
	});

	it('records an honest partial capture when the public endpoint omits a whole batch with 404', async () => {
		const store = await opened('not-found');
		const requestDetailed = vi.fn(async () => { throw new HttpTransportError('http', 404, null, 'missing'); });
		const result = await new PriceHistoryCaptureService({ requestDetailed }, new RateLimitCoordinator(), 'owner', () => 100)
			.capture(store, 'vault', 0, 15);
		expect(result).toMatchObject({ status: 'partial', snapshot: { items: [], missingItemIds: [...PRICE_HISTORY_SEED_ITEM_IDS].sort((left, right) => left - right) } });
		expect(await store.readSnapshots('vault')).toHaveLength(1);
		store.close();
	});

	it('is single-flight for the same vault slot', async () => {
		const store = await opened('single-flight');
		let release!: () => void;
		const wait = new Promise<void>((resolve) => { release = resolve; });
		const requestDetailed = vi.fn(async (path: string) => { await wait; return response(idsFromPath(path)); });
		const service = new PriceHistoryCaptureService({ requestDetailed }, new RateLimitCoordinator(), 'owner', () => 100);
		const first = service.capture(store, 'vault', 0, 15);
		const second = service.capture(store, 'vault', 0, 15);
		expect(second).toBe(first);
		release();
		await expect(first).resolves.toMatchObject({ status: 'complete' });
		expect(requestDetailed).toHaveBeenCalledTimes(1);
		store.close();
	});
});

function response(ids: number[], nullBid?: number) {
	return { status: 200, headers: {}, body: priceRows(ids, nullBid) };
}
function priceRows(ids: number[], nullBid?: number) {
	return ids.map((id) => row(id, id === nullBid));
}
function row(id: number, nullBid = false) {
	return {
		id, whitelisted: true,
		buys: nullBid ? { quantity: 0, unit_price: 0 } : { quantity: 10_000, unit_price: id + 100 },
		sells: { quantity: 20_000, unit_price: id + 200 },
	};
}
function idsFromPath(path: string): number[] {
	return path.split('ids=')[1]!.split('&')[0]!.split(',').map(Number);
}
async function opened(label: string): Promise<IndexedDbPriceHistoryStore> {
	return await IndexedDbPriceHistoryStore.open(new IDBFactory(), `tyrian-price-capture-${label}`);
}
