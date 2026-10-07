import { describe, expect, it } from 'vitest';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { HttpTransportError, type HttpResponse } from '../core/http';
import { currencyPayload } from './__fixtures__/public-catalog';
import { MemoryCatalogCache } from './public-catalog-cache';
import type { PublicCatalogGateway } from './public-catalog-client';
import { PublicCatalogService } from './public-catalog-service';

const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

function gateway(handler: (path: string) => HttpResponse): PublicCatalogGateway & { calls: string[] } {
	const calls: string[] = [];
	return { calls, requestDetailed: async (path) => { calls.push(path); return handler(path); } };
}
const ok = (ids: number[]): HttpResponse => ({ status: 200, headers: {}, body: ids.map(currencyPayload) });

describe('PublicCatalogService currencies for a session', () => {
	it('requests only the given ids once, resolves name and icon, and answers the next read from the cache', async () => {
		const api = gateway(() => ok([1, 23]));
		const service = new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW);
		const found = await service.resolveCurrencies([23, 1, 1], 'en');
		expect(api.calls).toEqual([`currencies?ids=1,23&lang=en&v=${encodeURIComponent(PINNED_SCHEMA)}`]);
		expect(Object.keys(found.currencies)).toEqual(['1', '23']);
		expect(found.currencies['23']).toMatchObject({ name: 'Divisa 23', icon: 'https://example.invalid/currencies/23.png' });
		expect(found.coverage['1']).toEqual({ status: 'resolved', source: 'network' });
		await service.resolveCurrencies([1, 23], 'en');
		expect(api.calls).toHaveLength(1);
	});

	it('asks nothing for an empty list', async () => {
		const api = gateway(() => ok([]));
		await expect(new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolveCurrencies([], 'es')).resolves.toEqual({ currencies: {}, coverage: {} });
		expect(api.calls).toEqual([]);
	});

	it('reports a 404 as missing and a network failure as unavailable, without throwing', async () => {
		const missing = new PublicCatalogService(gateway(() => { throw new HttpTransportError('http', 404, null, 'not found'); }), new MemoryCatalogCache(), () => NOW);
		const gone = await missing.resolveCurrencies([99], 'en');
		expect(gone.currencies).toEqual({});
		expect(gone.coverage['99']).toMatchObject({ status: 'missing', reason: 'not_found' });
		const offline = new PublicCatalogService(gateway(() => { throw new HttpTransportError('network', null, null, 'offline'); }), new MemoryCatalogCache(), () => NOW);
		const down = await offline.resolveCurrencies([2], 'en');
		expect(down.currencies).toEqual({});
		expect(down.coverage['2']).toMatchObject({ status: 'unavailable', reason: 'request_failed' });
	});

	it('readCachedCurrencies answers from the cache at any age, never requests, and ignores absent ids', async () => {
		const cache = new MemoryCatalogCache();
		let now = NOW - 900 * DAY_MS;
		await new PublicCatalogService(gateway(() => ok([1])), cache, () => now).resolveCurrencies([1], 'en');
		now = NOW;
		const api = gateway(() => { throw new Error('A cache-only read must not request.'); });
		const service = new PublicCatalogService(api, cache, () => NOW);
		const found = await service.readCachedCurrencies([1, 2], 'en');
		expect(Object.keys(found)).toEqual(['1']);
		expect(await service.readCachedCurrencies([1], 'es')).toEqual({});
		expect(api.calls).toEqual([]);
	});
});
