import { describe, expect, it } from 'vitest';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { HttpTransportError, type HttpResponse } from '../core/http';
import { MemoryCatalogCache } from './public-catalog-cache';
import { publicCatalogLogicalEndpoint, type PublicCatalogGateway } from './public-catalog-client';
import { PublicCatalogService } from './public-catalog-service';

const NOW = Date.parse('2026-10-08T10:00:00.000Z');

function gateway(handler: (path: string) => HttpResponse): PublicCatalogGateway & { calls: string[] } {
	const calls: string[] = [];
	return { calls, requestDetailed: async (path) => { calls.push(path); return handler(path); } };
}
const ok = (ids: number[]): HttpResponse => ({ status: 200, headers: {}, body: ids.map((id) => ({ id, name: `Mapa ${id}`, min_level: 0, future: true })) });

describe('PublicCatalogService map names', () => {
	it('asks /v2/maps once for the given ids and answers the next call from the cache', async () => {
		const api = gateway(() => ok([873, 866]));
		const service = new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW);
		const found = await service.resolveMaps([873, 866, 866], 'es');
		expect(api.calls).toEqual([`maps?ids=866,873&lang=es&v=${encodeURIComponent(PINNED_SCHEMA)}`]);
		expect(found['866']).toEqual({ kind: 'map', id: 866, name: 'Mapa 866' });
		await service.resolveMaps([866], 'es');
		expect(api.calls).toHaveLength(1);
		expect(await service.readCachedMaps([866, 1], 'es')).toEqual({ '866': { kind: 'map', id: 866, name: 'Mapa 866' } });
	});
	it('does not throw when the API is unreachable: the map is simply absent', async () => {
		const service = new PublicCatalogService(gateway(() => { throw new HttpTransportError('network', null, null, 'offline'); }), new MemoryCatalogCache(), () => NOW);
		await expect(service.resolveMaps([5], 'en')).resolves.toEqual({});
	});
	it('rejects a nameless entry instead of caching it', async () => {
		const service = new PublicCatalogService(gateway(() => ({ status: 200, headers: {}, body: [{ id: 7, name: '' }] })), new MemoryCatalogCache(), () => NOW);
		await expect(service.resolveMaps([7], 'en')).resolves.toEqual({});
	});
	it('maps the route to its own closed endpoint name', () => {
		expect(publicCatalogLogicalEndpoint('maps?ids=866&lang=en')).toBe('maps');
	});
});
