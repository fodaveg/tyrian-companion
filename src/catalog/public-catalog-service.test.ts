import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type StorageSnapshot } from '../account/storage-snapshot-model';
import { HttpTransportError, type HttpResponse } from '../core/http';
import {
	currencyPayload,
	itemPayload,
	materialPayload,
	storageSnapshotFixture,
} from './__fixtures__/public-catalog';
import { MemoryCatalogCache, type CatalogCacheKey } from './public-catalog-cache';
import type { PublicCatalogGateway } from './public-catalog-client';
import {
	parseCatalogCurrencies,
	parseCatalogItems,
	parseCatalogMaterials,
} from './public-catalog-parsers';
import { PublicCatalogService } from './public-catalog-service';
import { CATALOG_NORMALIZER_VERSION } from './public-catalog-model';

const NOW = Date.parse('2026-08-13T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

function http(status: number, body: unknown): HttpResponse {
	return { status, headers: {}, body };
}

function gateway(
	handler: (path: string) => Promise<HttpResponse> | HttpResponse,
): PublicCatalogGateway & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		requestDetailed: async (path) => {
			calls.push(path);
			return handler(path);
		},
	};
}

function idsFrom(path: string): number[] {
	return (new URL(path, 'https://example.invalid').searchParams.get('ids') ?? '')
		.split(',')
		.filter(Boolean)
		.map(Number);
}

function snapshotWithItems(ids: number[]): StorageSnapshot {
	const snapshot = storageSnapshotFixture();
	snapshot.holdings = ids.map((itemId, slot) => ({
		kind: 'item',
		itemId,
		quantity: 1,
		state: 'loose',
		location: { source: 'bank', slot },
		metadata: {},
	}));
	snapshot.currencies = [];
	snapshot.availableByItem = Object.fromEntries(ids.map((id) => [String(id), 1]));
	snapshot.ownedByItem = { ...snapshot.availableByItem };
	snapshot.currencyById = {};
	return snapshot;
}

describe('PublicCatalogService', () => {
	it('resolves all public namespaces without mutating the snapshot', async () => {
		const snapshot = storageSnapshotFixture();
		const before = structuredClone(snapshot);
		deepFreeze(snapshot);
		const api = gateway((path) => {
			const ids = idsFrom(path);
			if (path.startsWith('items?')) return http(200, ids.map(itemPayload).reverse());
			if (path.startsWith('currencies?')) return http(200, ids.map(currencyPayload));
			return http(200, ids.map(materialPayload));
		});

		const resolution = await new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolve(
			snapshot,
			'es',
		);

		expect(snapshot).toEqual(before);
		expect(resolution).toMatchObject({
			snapshotId: 'snapshot-anonymous',
			locale: 'es',
			schemaVersion: '2024-07-20T01:00:00.000Z',
			resolvedAt: '2026-08-13T10:00:00.000Z',
			items: { '10': { id: 10 }, '11': { id: 11 } },
			currencies: { 'delivery:1': { id: 1 }, 'wallet:1': { id: 1 } },
			materials: { '7': { id: 7 } },
		});
		expect(Object.keys(resolution.items)).toEqual(['10', '11']);
		expect(api.calls).toHaveLength(3);
		expect(
			api.calls.every(
				(path) => path.includes('lang=es') && path.includes('v=2024-07-20T01%3A00%3A00.000Z'),
			),
		).toBe(true);
	});

	it('deduplicates, sorts, chunks at 200, and limits public requests to three at once', async () => {
		const ids = [...Array.from({ length: 450 }, (_value, index) => 450 - index), 10, 10];
		let active = 0;
		let maxActive = 0;
		const api = gateway(async (path) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active -= 1;
			return http(200, idsFrom(path).map(itemPayload));
		});

		const resolution = await new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolve(
			snapshotWithItems(ids),
			'en',
		);
		const requested = api.calls.map(idsFrom);

		expect(requested.map((batch) => batch.length)).toEqual([200, 200, 50]);
		expect(requested.flat()).toEqual(Array.from({ length: 450 }, (_value, index) => index + 1));
		expect(maxActive).toBe(3);
		expect(Object.keys(resolution.items)).toHaveLength(450);
	});

	it('coalesces identical resolutions into one flight', async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const api = gateway(async (path) => {
			await pending;
			return http(200, idsFrom(path).map(itemPayload));
		});
		const service = new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW);
		const snapshot = snapshotWithItems([10]);
		const first = service.resolve(snapshot, 'es');
		const second = service.resolve(snapshot, 'es');

		expect(first).toBe(second);
		release?.();
		await first;
		expect(api.calls).toHaveLength(1);
	});

	it('honors fresh positive and negative cache TTLs without network', async () => {
		const cache = new MemoryCatalogCache();
		const item = parseCatalogItems([itemPayload(10)])[0];
		if (!item) throw new Error('Missing item fixture.');
		await cache.set(cacheKey('items', 'es', 10), cacheRecord(item, NOW - 7 * DAY_MS));
		await cache.set(
			cacheKey('items', 'es', 11),
			cacheRecord(null, NOW - 60 * 60 * 1_000, 'not_found'),
		);
		const api = gateway(() => {
			throw new Error('Fresh cache must avoid network.');
		});

		const resolution = await new PublicCatalogService(api, cache, () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);

		expect(api.calls).toHaveLength(0);
		expect(resolution.coverage.items).toEqual({
			'10': { status: 'resolved', source: 'cache_fresh' },
			'11': { status: 'missing', source: 'cache_negative', reason: 'not_found' },
		});
	});

	it('isolates cache keys and records by schema and normalizer versions', async () => {
		const cache = new MemoryCatalogCache();
		const item10 = parseCatalogItems([itemPayload(10)])[0];
		const item11 = parseCatalogItems([itemPayload(11)])[0];
		if (!item10 || !item11) throw new Error('Missing item fixture.');
		await cache.set(
			{ ...cacheKey('items', 'es', 10), schemaVersion: 'previous-schema' },
			{ ...cacheRecord(item10, NOW), schemaVersion: 'previous-schema' },
		);
		await cache.set(cacheKey('items', 'es', 11), {
			...cacheRecord(item11, NOW),
			normalizerVersion: CATALOG_NORMALIZER_VERSION - 1,
		});
		const api = gateway((path) => http(200, idsFrom(path).map(itemPayload)));

		await new PublicCatalogService(api, cache, () => NOW).resolve(snapshotWithItems([10, 11]), 'es');

		expect(idsFrom(api.calls[0] ?? '')).toEqual([10, 11]);
		await expect(cache.get(cacheKey('items', 'es', 10))).resolves.toMatchObject({
			schemaVersion: PINNED_SCHEMA,
			normalizerVersion: CATALOG_NORMALIZER_VERSION,
		});
		await expect(cache.get(cacheKey('items', 'es', 11))).resolves.toMatchObject({
			schemaVersion: PINNED_SCHEMA,
			normalizerVersion: CATALOG_NORMALIZER_VERSION,
		});
	});

	it('keeps cache hits intact after a caller mutates a prior resolution deeply', async () => {
		const api = gateway((path) => {
			const ids = idsFrom(path);
			if (path.startsWith('items?')) {
				return http(
					200,
					ids.map((id) => ({
						...itemPayload(id),
						details: {
							type: 'Bag',
							stat_choices: [5, 4],
							future_list: [1, 2],
						},
					})),
				);
			}
			if (path.startsWith('currencies?')) return http(200, ids.map(currencyPayload));
			return http(200, ids.map(materialPayload));
		});
		const service = new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW);
		const first = await service.resolve(storageSnapshotFixture(), 'es');
		const firstItem = first.items['10'];
		const firstMaterial = first.materials['7'];
		if (!firstItem?.details || !firstMaterial) throw new Error('Missing resolved fixture.');

		firstItem.flags.push('CallerMutation');
		firstItem.details.statChoices?.push(999);
		const futureList = firstItem.details.unknownDetails?.future_list;
		if (Array.isArray(futureList)) futureList.push(999);
		firstMaterial.items.push(999);
		const secondSnapshot = storageSnapshotFixture();
		secondSnapshot.snapshotId = 'snapshot-anonymous-2';
		const second = await service.resolve(secondSnapshot, 'es');

		expect(api.calls).toHaveLength(3);
		expect(second.items['10']?.flags).toEqual(['FutureFlag']);
		expect(second.items['10']?.details?.statChoices).toEqual([4, 5]);
		expect(second.items['10']?.details?.unknownDetails?.future_list).toEqual([1, 2]);
		expect(second.materials['7']?.items).toEqual([10, 11]);
		expect(second.coverage.items['10']?.source).toBe('cache_fresh');
	});

	it('refreshes expired negatives and ignores mismatched cached membership', async () => {
		const cache = new MemoryCatalogCache();
		const wrongItem = parseCatalogItems([itemPayload(12)])[0];
		if (!wrongItem) throw new Error('Missing item fixture.');
		await cache.set(cacheKey('items', 'es', 10), cacheRecord(wrongItem, NOW));
		await cache.set(
			cacheKey('items', 'es', 11),
			cacheRecord(null, NOW - 60 * 60 * 1_000 - 1, 'not_found'),
		);
		const api = gateway((path) => http(200, idsFrom(path).map(itemPayload)));

		const resolution = await new PublicCatalogService(api, cache, () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);

		expect(api.calls).toHaveLength(1);
		expect(idsFrom(api.calls[0] ?? '')).toEqual([10, 11]);
		expect(resolution.items).toMatchObject({ '10': { id: 10 }, '11': { id: 11 } });
	});

	it('refreshes material categories after 24 hours and keeps currencies fresh for seven days', async () => {
		const cache = new MemoryCatalogCache();
		const material = parseCatalogMaterials([materialPayload(7)])[0];
		const currency = parseCatalogCurrencies([currencyPayload(1)])[0];
		if (!material || !currency) throw new Error('Missing catalog fixture.');
		await cache.set(
			cacheKey('materials', 'en', 7),
			cacheRecord(material, NOW - 25 * 60 * 60 * 1_000),
		);
		await cache.set(
			cacheKey('currencies', 'en', 1),
			cacheRecord(currency, NOW - 7 * DAY_MS),
		);
		const snapshot = storageSnapshotFixture();
		snapshot.holdings = snapshot.holdings.filter((holding) => holding.location.source === 'materials');
		const api = gateway((path) => http(200, idsFrom(path).map(materialPayload)));

		const resolution = await new PublicCatalogService(api, cache, () => NOW).resolve(snapshot, 'en');

		expect(api.calls).toHaveLength(2);
		expect(api.calls.some((path) => path.startsWith('materials?'))).toBe(true);
		expect(api.calls.some((path) => path.startsWith('items?'))).toBe(true);
		expect(api.calls.some((path) => path.startsWith('currencies?'))).toBe(false);
		expect(resolution.coverage.currencies['wallet:1']).toEqual({
			status: 'resolved',
			source: 'cache_fresh',
		});
		expect(resolution.coverage.materials['7']).toEqual({ status: 'resolved', source: 'network' });
	});

	it('uses positive stale cache up to 30 days only for transient errors', async () => {
		const item = parseCatalogItems([itemPayload(10)])[0];
		if (!item) throw new Error('Missing item fixture.');
		const staleCache = new MemoryCatalogCache();
		await staleCache.set(
			cacheKey('items', 'es', 10),
			cacheRecord(item, NOW - 10 * DAY_MS),
		);
		const transient = gateway(() => {
			throw new HttpTransportError('http', 503, null, 'Request failed with status 503.');
		});

		await expect(
			new PublicCatalogService(transient, staleCache, () => NOW).resolve(snapshotWithItems([10]), 'es'),
		).resolves.toMatchObject({
			items: { '10': { id: 10 } },
			coverage: { items: { '10': { status: 'resolved', source: 'cache_stale' } } },
		});

		const expiredCache = new MemoryCatalogCache();
		await expiredCache.set(
			cacheKey('items', 'es', 10),
			cacheRecord(item, NOW - 31 * DAY_MS),
		);
		await expect(
			new PublicCatalogService(transient, expiredCache, () => NOW).resolve(snapshotWithItems([10]), 'es'),
		).resolves.toMatchObject({
			items: {},
			coverage: { items: { '10': { status: 'unavailable', source: 'network' } } },
		});
	});

	it('treats 206 omissions and 404 batches as negative cache entries', async () => {
		const cache = new MemoryCatalogCache();
		const partialApi = gateway(() => http(206, [itemPayload(10)]));
		const partial = await new PublicCatalogService(partialApi, cache, () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);
		expect(partial.coverage.items).toEqual({
			'10': { status: 'resolved', source: 'network' },
			'11': { status: 'missing', source: 'network', reason: 'partial_response' },
		});

		const cachedApi = gateway(() => {
			throw new Error('Negative cache must avoid network.');
		});
		const cached = await new PublicCatalogService(cachedApi, cache, () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);
		expect(cachedApi.calls).toHaveLength(0);
		expect(cached.coverage.items['11']).toEqual({
			status: 'missing',
			source: 'cache_negative',
			reason: 'partial_response',
		});

		const missingApi = gateway(() => http(404, { text: 'not exposed' }));
		const missing = await new PublicCatalogService(missingApi, new MemoryCatalogCache(), () => NOW).resolve(
			snapshotWithItems([20, 21]),
			'es',
		);
		expect(missing.coverage.items).toEqual({
			'20': { status: 'missing', source: 'network', reason: 'not_found' },
			'21': { status: 'missing', source: 'network', reason: 'not_found' },
		});
	});

	it('keeps valid entries when another requested entry is malformed', async () => {
		const api = gateway(() => http(200, [itemPayload(10), { ...itemPayload(11), name: 42 }]));
		const resolution = await new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);
		expect(resolution.items).toMatchObject({ '10': { id: 10 } });
		expect(resolution.coverage.items).toEqual({
			'10': { status: 'resolved', source: 'network' },
			'11': { status: 'malformed', source: 'network', reason: 'malformed_entry' },
		});
		expect(resolution.warnings).toContainEqual({ code: 'malformed_entry', kind: 'items', id: 11 });
	});

	it('marks a 200 omission without discarding valid entries', async () => {
		const api = gateway(() => http(200, [itemPayload(10)]));
		const resolution = await new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);
		expect(resolution.items).toMatchObject({ '10': { id: 10 } });
		expect(resolution.coverage.items['11']).toEqual({
			status: 'missing',
			source: 'network',
			reason: 'missing_response',
		});
		expect(resolution.warnings).toContainEqual({ code: 'missing_response', kind: 'items', id: 11 });
	});

	it('ignores extras, tolerates identical duplicates, and isolates conflicting duplicates', async () => {
		const conflicting = { ...itemPayload(10), name: 'Otro objeto' };
		const api = gateway(() =>
			http(200, [itemPayload(10), itemPayload(10), conflicting, itemPayload(11), itemPayload(12)]),
		);
		const resolution = await new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);
		expect(resolution.items).toMatchObject({ '11': { id: 11 } });
		expect(resolution.items['10']).toBeUndefined();
		expect(resolution.coverage.items).toEqual({
			'10': { status: 'invalid', source: 'network', reason: 'duplicate_conflict' },
			'11': { status: 'resolved', source: 'network' },
		});
		expect(resolution.warnings).toEqual(
			expect.arrayContaining([
				{ code: 'duplicate_identical', kind: 'items', id: 10 },
				{ code: 'duplicate_conflict', kind: 'items', id: 10 },
				{ code: 'unexpected_id', kind: 'items', id: 12 },
			]),
		);
	});

	it('keeps an ID resolved when its duplicate is identical', async () => {
		const api = gateway(() => http(200, [itemPayload(10), itemPayload(10), itemPayload(11)]));
		const resolution = await new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolve(
			snapshotWithItems([10, 11]),
			'es',
		);
		expect(resolution.items).toMatchObject({ '10': { id: 10 }, '11': { id: 11 } });
		expect(resolution.coverage.items['10']).toEqual({ status: 'resolved', source: 'network' });
		expect(resolution.warnings).toContainEqual({
			code: 'duplicate_identical',
			kind: 'items',
			id: 10,
		});
	});

	it('deduplicates category members and warns about snapshot membership mismatches', async () => {
		const snapshot = storageSnapshotFixture();
		const before = structuredClone(snapshot);
		const api = gateway((path) => {
			const ids = idsFrom(path);
			if (path.startsWith('items?')) return http(200, ids.map(itemPayload));
			if (path.startsWith('currencies?')) return http(200, ids.map(currencyPayload));
			return http(200, [{ ...materialPayload(7), items: [11, 11] }]);
		});

		const resolution = await new PublicCatalogService(api, new MemoryCatalogCache(), () => NOW).resolve(
			snapshot,
			'es',
		);

		expect(snapshot).toEqual(before);
		expect(snapshot.quality).toBe('stable');
		expect(resolution.materials['7']?.items).toEqual([11]);
		expect(resolution.warnings).toContainEqual({
			code: 'material_membership_mismatch',
			kind: 'materials',
			id: 7,
			relatedId: 10,
		});
	});
});

function deepFreeze(value: unknown): void {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
}

function cacheKey<K extends CatalogCacheKey['kind']>(
	kind: K,
	locale: 'es' | 'en',
	id: number,
): CatalogCacheKey<K> {
	return {
		kind,
		locale,
		id,
		schemaVersion: PINNED_SCHEMA,
		normalizerVersion: CATALOG_NORMALIZER_VERSION,
	};
}

function cacheRecord<T>(
	value: T | null,
	storedAt: number,
	negativeReason?: 'not_found' | 'partial_response',
): {
	value: T | null;
	storedAt: number;
	schemaVersion: string;
	normalizerVersion: number;
	negativeReason?: 'not_found' | 'partial_response';
} {
	return {
		value,
		storedAt,
		schemaVersion: PINNED_SCHEMA,
		normalizerVersion: CATALOG_NORMALIZER_VERSION,
		negativeReason,
	};
}
