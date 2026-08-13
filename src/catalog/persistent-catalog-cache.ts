import {
	MemoryCatalogCache,
	type CatalogCacheAdapter,
	type CatalogCacheKey,
	type CatalogCacheRecord,
} from './public-catalog-cache';
import type {
	CatalogEntity,
	CatalogEntityByKind,
	CatalogKind,
} from './public-catalog-model';
import { isCatalogJsonValue, isNormalizedCatalogEntity } from './public-catalog-validators';

export const CATALOG_CACHE_DB_NAME = 'tyrian-companion-public-catalog';
export const CATALOG_CACHE_DB_VERSION = 1;
export const CATALOG_CACHE_STORE_NAME = 'catalog-records-v1';

export interface CatalogRecordStore {
	get(key: string): Promise<unknown>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	close(): void;
}

interface PersistedCatalogEnvelope {
	key: CatalogCacheKey;
	record: CatalogCacheRecord<CatalogEntity>;
}

/** JSON-only persistent adapter. Incompatible or corrupt entries degrade to cache misses. */
export class PersistentCatalogCache implements CatalogCacheAdapter {
	constructor(private readonly store: CatalogRecordStore) {}

	async get<K extends CatalogKind>(
		cacheKey: CatalogCacheKey<K>,
	): Promise<CatalogCacheRecord<CatalogEntityByKind[K]> | undefined> {
		const storageKey = catalogCacheStorageKey(cacheKey);
		let raw: unknown;
		try {
			raw = await this.store.get(storageKey);
		} catch {
			return undefined;
		}
		if (raw === undefined) return undefined;

		const envelope = parseEnvelope(raw, cacheKey);
		if (!envelope) {
			await this.deleteQuietly(storageKey);
			return undefined;
		}
		return structuredClone(envelope.record) as CatalogCacheRecord<CatalogEntityByKind[K]>;
	}

	async set<K extends CatalogKind>(
		cacheKey: CatalogCacheKey<K>,
		record: CatalogCacheRecord<CatalogEntityByKind[K]>,
	): Promise<void> {
		const envelope: PersistedCatalogEnvelope = { key: cacheKey, record };
		try {
			const serialized = JSON.stringify(envelope);
			const jsonValue: unknown = JSON.parse(serialized);
			if (!isCompatibleEnvelope(jsonValue, cacheKey)) return;
			await this.store.set(catalogCacheStorageKey(cacheKey), serialized);
		} catch {
			// A cache write must never fail the catalog resolution.
		}
	}

	dispose(): void {
		this.store.close();
	}

	private async deleteQuietly(storageKey: string): Promise<void> {
		try {
			await this.store.delete(storageKey);
		} catch {
			// Corruption still behaves as a miss when cleanup is unavailable.
		}
	}
}

export interface CatalogCacheFactoryOptions {
	indexedDb?: IDBFactory | null;
	databaseName?: string;
	/** Test seam and alternate local backends; production defaults to IndexedDB. */
	openStore?: () => Promise<CatalogRecordStore>;
}

/** Opens local persistence on demand and explicitly falls back to process memory. */
export async function createCatalogCacheAdapter(
	options: CatalogCacheFactoryOptions = {},
): Promise<CatalogCacheAdapter> {
	try {
		if (options.openStore) return new PersistentCatalogCache(await options.openStore());
		const indexedDb =
			options.indexedDb === undefined
				? typeof window === 'undefined' || typeof window.indexedDB === 'undefined'
					? null
					: window.indexedDB
				: options.indexedDb;
		if (!indexedDb) return new MemoryCatalogCache();
		return new PersistentCatalogCache(
			await IndexedDbCatalogRecordStore.open(
				indexedDb,
				options.databaseName ?? CATALOG_CACHE_DB_NAME,
			),
		);
	} catch {
		return new MemoryCatalogCache();
	}
}

/** IndexedDB-backed string store. Each method owns one transaction. */
export class IndexedDbCatalogRecordStore implements CatalogRecordStore {
	constructor(private readonly database: IDBDatabase) {}

	static open(
		factory: IDBFactory,
		databaseName: string,
		databaseVersion = CATALOG_CACHE_DB_VERSION,
	): Promise<IndexedDbCatalogRecordStore> {
		return new Promise((resolve, reject) => {
			const request = factory.open(databaseName, databaseVersion);
			let settled = false;
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(CATALOG_CACHE_STORE_NAME)) {
					database.createObjectStore(CATALOG_CACHE_STORE_NAME);
				}
			};
			request.onerror = () => {
				if (!settled) reject(new Error('Could not open the public catalog cache.'));
				settled = true;
			};
			request.onblocked = () => {
				if (!settled) reject(new Error('Public catalog cache upgrade was blocked.'));
				settled = true;
			};
			request.onsuccess = () => {
				if (settled) {
					request.result.close();
					return;
				}
				settled = true;
				request.result.onversionchange = () => request.result.close();
				resolve(new IndexedDbCatalogRecordStore(request.result));
			};
		});
	}

	get(key: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const transaction = this.database.transaction(CATALOG_CACHE_STORE_NAME, 'readonly');
			const request = transaction.objectStore(CATALOG_CACHE_STORE_NAME).get(key);
			let result: unknown;
			request.onsuccess = () => {
				result = request.result as unknown;
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(new Error('Could not read the public catalog cache.'));
			transaction.onabort = () => reject(new Error('Public catalog cache read was aborted.'));
		});
	}

	set(key: string, value: string): Promise<void> {
		return this.write((store) => store.put(value, key));
	}

	delete(key: string): Promise<void> {
		return this.write((store) => store.delete(key));
	}

	close(): void {
		this.database.close();
	}

	private write(action: (store: IDBObjectStore) => IDBRequest): Promise<void> {
		return new Promise((resolve, reject) => {
			const transaction = this.database.transaction(CATALOG_CACHE_STORE_NAME, 'readwrite');
			action(transaction.objectStore(CATALOG_CACHE_STORE_NAME));
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(new Error('Could not write the public catalog cache.'));
			transaction.onabort = () => reject(new Error('Public catalog cache write was aborted.'));
		});
	}
}

export function catalogCacheStorageKey(cacheKey: CatalogCacheKey): string {
	return JSON.stringify([
		cacheKey.kind,
		cacheKey.locale,
		cacheKey.id,
		cacheKey.schemaVersion,
		cacheKey.normalizerVersion,
	]);
}

function parseEnvelope(raw: unknown, expectedKey: CatalogCacheKey): PersistedCatalogEnvelope | null {
	if (typeof raw !== 'string') return null;
	try {
		const value: unknown = JSON.parse(raw);
		return isCompatibleEnvelope(value, expectedKey) ? value : null;
	} catch {
		return null;
	}
}

function isCompatibleEnvelope(
	value: unknown,
	expectedKey: CatalogCacheKey,
): value is PersistedCatalogEnvelope {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(['key', 'record'])) ||
		!isCacheKey(value.key) ||
		!sameKey(value.key, expectedKey)
	) {
		return false;
	}
	if (!isRecord(value.record) || !hasOnlyKeys(value.record, new Set([
		'value',
		'storedAt',
		'schemaVersion',
		'normalizerVersion',
		'negativeReason',
	]))) return false;
	const record = value.record;
	if (
		!Number.isSafeInteger(record.storedAt) ||
		(record.storedAt as number) < 0 ||
		(record.schemaVersion !== expectedKey.schemaVersion) ||
		(record.normalizerVersion !== expectedKey.normalizerVersion) ||
		(record.negativeReason !== undefined &&
			record.negativeReason !== 'not_found' &&
			record.negativeReason !== 'partial_response')
	) {
		return false;
	}
	if (record.value === null) {
		return record.negativeReason !== undefined && isCatalogJsonValue(value);
	}
	return (
		record.negativeReason === undefined &&
		isNormalizedCatalogEntity(expectedKey.kind, record.value) &&
		record.value.id === expectedKey.id &&
		isCatalogJsonValue(value)
	);
}

function isCacheKey(value: unknown): value is CatalogCacheKey {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, new Set([
			'kind',
			'locale',
			'id',
			'schemaVersion',
			'normalizerVersion',
		])) &&
		(value.kind === 'items' || value.kind === 'currencies' || value.kind === 'materials') &&
		(value.locale === 'es' || value.locale === 'en') &&
		Number.isSafeInteger(value.id) &&
		(value.id as number) > 0 &&
		typeof value.schemaVersion === 'string' &&
		value.schemaVersion.length > 0 &&
		Number.isSafeInteger(value.normalizerVersion) &&
		(value.normalizerVersion as number) > 0
	);
}

function sameKey(left: CatalogCacheKey, right: CatalogCacheKey): boolean {
	return (
		left.kind === right.kind &&
		left.locale === right.locale &&
		left.id === right.id &&
		left.schemaVersion === right.schemaVersion &&
		left.normalizerVersion === right.normalizerVersion
	);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
