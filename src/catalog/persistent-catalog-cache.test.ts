import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { currencyPayload, itemPayload, materialPayload } from './__fixtures__/public-catalog';
import { MemoryCatalogCache, type CatalogCacheKey } from './public-catalog-cache';
import { CATALOG_NORMALIZER_VERSION } from './public-catalog-model';
import {
	parseCatalogCurrencies,
	parseCatalogItems,
	parseCatalogMaterials,
} from './public-catalog-parsers';
import {
	PersistentCatalogCache,
	catalogCacheStorageKey,
	createCatalogCacheAdapter,
	type CatalogRecordStore,
} from './persistent-catalog-cache';

const NOW = Date.parse('2026-08-13T10:00:00.000Z');

class SharedRecordStore implements CatalogRecordStore {
	closed = false;

	constructor(readonly records = new Map<string, unknown>()) {}

	async get(key: string): Promise<unknown> {
		return this.records.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.records.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}

	close(): void {
		this.closed = true;
	}
}

describe('PersistentCatalogCache', () => {
	it('persists JSON records between adapter instances and disposes each store', async () => {
		const records = new Map<string, unknown>();
		const firstStore = new SharedRecordStore(records);
		const first = new PersistentCatalogCache(firstStore);
		const key = itemKey('es', 10);
		const item = parseCatalogItems([itemPayload(10)])[0];
		if (!item) throw new Error('Missing item fixture.');
		await first.set(key, record(item));
		first.dispose();

		const secondStore = new SharedRecordStore(records);
		const second = new PersistentCatalogCache(secondStore);
		await expect(second.get(key)).resolves.toEqual(record(item));
		const raw = records.get(catalogCacheStorageKey(key));
		expect(typeof raw).toBe('string');
		expect(JSON.parse(raw as string)).toEqual({ key, record: record(item) });
		expect(firstStore.closed).toBe(true);
		second.dispose();
		expect(secondStore.closed).toBe(true);
	});

	it('isolates locale, schema, normalizer, kind, and id namespaces', async () => {
		const store = new SharedRecordStore();
		const cache = new PersistentCatalogCache(store);
		const item = parseCatalogItems([itemPayload(10)])[0];
		if (!item) throw new Error('Missing item fixture.');
		const canonical = itemKey('es', 10);
		await cache.set(canonical, record(item));

		await expect(cache.get(canonical)).resolves.toBeDefined();
		await expect(cache.get({ ...canonical, locale: 'en' })).resolves.toBeUndefined();
		await expect(cache.get({ ...canonical, schemaVersion: 'other-schema' })).resolves.toBeUndefined();
		await expect(
			cache.get({ ...canonical, normalizerVersion: CATALOG_NORMALIZER_VERSION + 1 }),
		).resolves.toBeUndefined();
		await expect(cache.get({ ...canonical, id: 11 })).resolves.toBeUndefined();
		expect(
			catalogCacheStorageKey({ ...canonical, kind: 'currencies' }),
		).not.toBe(catalogCacheStorageKey(canonical));
	});

	it('round-trips null negative records with their reason', async () => {
		const cache = new PersistentCatalogCache(new SharedRecordStore());
		const key = itemKey('en', 404);
		const negative = {
			value: null,
			storedAt: NOW,
			schemaVersion: PINNED_SCHEMA,
			normalizerVersion: CATALOG_NORMALIZER_VERSION,
			negativeReason: 'not_found' as const,
		};

		await cache.set(key, negative);
		await expect(cache.get(key)).resolves.toEqual(negative);
	});

	it.each([
		['invalid JSON', '{not-json'],
		['non-string record', { unexpected: true }],
		[
			'incompatible envelope',
			JSON.stringify({
				key: { ...itemKey('es', 10), schemaVersion: 'other-schema' },
				record: { value: null, storedAt: NOW, schemaVersion: 'other-schema', normalizerVersion: 1 },
			}),
		],
	])('treats %s as a miss and removes it', async (_label, raw) => {
		const store = new SharedRecordStore();
		const cache = new PersistentCatalogCache(store);
		const key = itemKey('es', 10);
		store.records.set(catalogCacheStorageKey(key), raw);

		await expect(cache.get(key)).resolves.toBeUndefined();
		expect(store.records.has(catalogCacheStorageKey(key))).toBe(false);
	});

	it.each([
		['truncated item', itemKey('es', 10), { kind: 'item', id: 10 }],
		[
			'item array type',
			itemKey('es', 10),
			{ ...normalizedItem(10), flags: 'NoSell' },
		],
		[
			'item details type',
			itemKey('es', 10),
			{ ...normalizedItem(10), details: { statChoices: [1, 'bad'] } },
		],
		[
			'item subtype mismatch',
			itemKey('es', 10),
			{ ...normalizedItem(10), subtype: 'Weapon', details: { subtype: 'Armor' } },
		],
		[
			'item unknownDetails JSON',
			itemKey('es', 10),
			{ ...normalizedItem(10), details: { unknownDetails: ['not-an-object'] } },
		],
		[
			'truncated currency',
			currencyKey('es', 1),
			{ kind: 'currency', id: 1, name: 'Coin' },
		],
		[
			'currency field type',
			currencyKey('es', 1),
			{ ...normalizedCurrency(1), order: 'first' },
		],
		[
			'truncated material category',
			materialKey('es', 7),
			{ kind: 'material_category', id: 7, name: 'Category' },
		],
		[
			'material member type',
			materialKey('es', 7),
			{ ...normalizedMaterial(7), items: [10, '11'] },
		],
		[
			'material normalized duplicate',
			materialKey('es', 7),
			{ ...normalizedMaterial(7), items: [10, 10] },
		],
	])('removes persisted normalized corruption: %s', async (_label, key, value) => {
		const store = new SharedRecordStore();
		const cache = new PersistentCatalogCache(store);
		store.records.set(
			catalogCacheStorageKey(key),
			JSON.stringify({ key, record: record(value) }),
		);

		await expect(cache.get(key)).resolves.toBeUndefined();
		expect(store.records.has(catalogCacheStorageKey(key))).toBe(false);
	});

	it('removes cached items whose names are not report-safe', async () => {
		for (const name of ['', ' Objeto 10', 'Objeto 10 ', 'x'.repeat(257)]) {
			const store = new SharedRecordStore();
			const cache = new PersistentCatalogCache(store);
			const key = itemKey('es', 10);
			store.records.set(
				catalogCacheStorageKey(key),
				JSON.stringify({ key, record: record({ ...normalizedItem(10), name }) }),
			);

			await expect(cache.get(key)).resolves.toBeUndefined();
			expect(store.records.has(catalogCacheStorageKey(key))).toBe(false);
		}
	});

	it.each([
		['timestamp', { storedAt: 'now' }],
		['schema record', { schemaVersion: 'other-schema' }],
		['normalizer record', { normalizerVersion: 99 }],
		['positive negativeReason', { negativeReason: 'not_found' }],
		['unknown record field', { future: true }],
	])('removes an incompatible cache record: %s', async (_label, override) => {
		const store = new SharedRecordStore();
		const cache = new PersistentCatalogCache(store);
		const key = itemKey('es', 10);
		const item = normalizedItem(10);
		store.records.set(
			catalogCacheStorageKey(key),
			JSON.stringify({ key, record: { ...record(item), ...override } }),
		);

		await expect(cache.get(key)).resolves.toBeUndefined();
		expect(store.records.has(catalogCacheStorageKey(key))).toBe(false);
	});
});

describe('createCatalogCacheAdapter', () => {
	it('falls back explicitly to memory when IndexedDB is unavailable', async () => {
		await expect(createCatalogCacheAdapter({ indexedDb: null })).resolves.toBeInstanceOf(
			MemoryCatalogCache,
		);
	});

	it('falls back explicitly to memory when opening local persistence fails', async () => {
		await expect(
			createCatalogCacheAdapter({
				openStore: async () => Promise.reject(new Error('open failed')),
			}),
		).resolves.toBeInstanceOf(MemoryCatalogCache);
	});

	it('uses an injected persistent store without opening IndexedDB', async () => {
		const store = new SharedRecordStore();
		await expect(
			createCatalogCacheAdapter({ openStore: async () => Promise.resolve(store) }),
		).resolves.toBeInstanceOf(PersistentCatalogCache);
	});
});

function itemKey(locale: 'es' | 'en', id: number): CatalogCacheKey<'items'> {
	return key('items', locale, id);
}

function currencyKey(locale: 'es' | 'en', id: number): CatalogCacheKey<'currencies'> {
	return key('currencies', locale, id);
}

function materialKey(locale: 'es' | 'en', id: number): CatalogCacheKey<'materials'> {
	return key('materials', locale, id);
}

function key<K extends CatalogCacheKey['kind']>(
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

function normalizedItem(id: number) {
	const item = parseCatalogItems([itemPayload(id)])[0];
	if (!item) throw new Error('Missing item fixture.');
	return item;
}

function normalizedCurrency(id: number) {
	const currency = parseCatalogCurrencies([currencyPayload(id)])[0];
	if (!currency) throw new Error('Missing currency fixture.');
	return currency;
}

function normalizedMaterial(id: number) {
	const material = parseCatalogMaterials([materialPayload(id)])[0];
	if (!material) throw new Error('Missing material fixture.');
	return material;
}

function record<T>(value: T): {
	value: T;
	storedAt: number;
	schemaVersion: string;
	normalizerVersion: number;
} {
	return {
		value,
		storedAt: NOW,
		schemaVersion: PINNED_SCHEMA,
		normalizerVersion: CATALOG_NORMALIZER_VERSION,
	};
}
