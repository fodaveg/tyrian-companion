import {
	MemoryCatalogCache,
	type CatalogCacheAdapter,
	type CatalogCacheEntry,
	type CatalogCacheKey,
	type CatalogCacheRecord,
} from './public-catalog-cache';
import type {
	CatalogEntity,
	CatalogEntityByKind,
	CatalogKind,
} from './public-catalog-model';
import { isCatalogJsonValue, isNormalizedCatalogEntity } from './public-catalog-validators';
import {
	IndexedDbConnectionLostError,
	ReopeningIndexedDbConnection,
	indexedDbFailureCode,
	openIndexedDb,
	startIndexedDbTransaction,
} from '../core/indexed-db-open';
import { LocalDebugPersistenceProbe, localDebugStorageFailureCode } from '../core/local-debug-persistence';

export const CATALOG_CACHE_DB_NAME = 'tyrian-companion-public-catalog';
export const CATALOG_CACHE_DB_VERSION = 1;
export const CATALOG_CACHE_STORE_NAME = 'catalog-records-v1';

export interface CatalogRecordStore {
	get(key: string): Promise<unknown>;
	/** Optional: a single-transaction batched read. `PersistentCatalogCache.getMany` falls back
	 * to parallel `get` calls when a store (such as a test double) does not implement it. */
	getMany?(keys: readonly string[]): Promise<Map<string, unknown>>;
	set(key: string, value: string): Promise<void>;
	/** Optional: all-or-nothing batched write in one transaction. `PersistentCatalogCache.setMany`
	 * falls back to sequential `set` calls when a store (such as a test double) does not implement it. */
	setMany?(entries: readonly (readonly [key: string, value: string])[]): Promise<void>;
	delete(key: string): Promise<void>;
	close(): void;
}

interface PersistedCatalogEnvelope {
	key: CatalogCacheKey;
	record: CatalogCacheRecord<CatalogEntity>;
}

/** JSON-only persistent adapter. Incompatible or corrupt entries degrade to cache misses. */
export class PersistentCatalogCache implements CatalogCacheAdapter {
	constructor(
		private readonly store: CatalogRecordStore,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {}

	async get<K extends CatalogKind>(
		cacheKey: CatalogCacheKey<K>,
	): Promise<CatalogCacheRecord<CatalogEntityByKind[K]> | undefined> {
		const attempt = this.diagnostics.begin('catalog', 'read');
		const storageKey = catalogCacheStorageKey(cacheKey);
		let raw: unknown;
		try {
			raw = await this.store.get(storageKey);
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			return undefined;
		}
		if (raw === undefined) { attempt.skip(); return undefined; }

		const envelope = parseEnvelope(raw, cacheKey);
		if (!envelope) {
			attempt.failure('validation_failed');
			await this.deleteQuietly(storageKey);
			return undefined;
		}
		attempt.success();
		return structuredClone(envelope.record) as CatalogCacheRecord<CatalogEntityByKind[K]>;
	}

	/**
	 * H14.15: `PublicCatalogService.resolveKind` used to open one `get` (one IndexedDB
	 * transaction) per requested id, unbounded — 4,840 concurrent transactions for a large
	 * won-items bench. This opens exactly one transaction for the whole batch (via the store's
	 * own `getMany`) and records a single diagnostic for it instead of one per id.
	 */
	async getMany<K extends CatalogKind>(
		cacheKeys: readonly CatalogCacheKey<K>[],
	): Promise<Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>> {
		const results = new Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>();
		if (cacheKeys.length === 0) return results;
		const attempt = this.diagnostics.begin('catalog', 'read');
		const storageKeys = cacheKeys.map((cacheKey) => catalogCacheStorageKey(cacheKey));
		let raws: Map<string, unknown>;
		try {
			raws = this.store.getMany
				? await this.store.getMany(storageKeys)
				: await this.getManyByGet(storageKeys);
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			return results;
		}
		const corrupt: string[] = [];
		for (const cacheKey of cacheKeys) {
			const storageKey = catalogCacheStorageKey(cacheKey);
			const raw = raws.get(storageKey);
			if (raw === undefined) continue;
			const envelope = parseEnvelope(raw, cacheKey);
			if (!envelope) { corrupt.push(storageKey); continue; }
			results.set(cacheKey.id, structuredClone(envelope.record) as CatalogCacheRecord<CatalogEntityByKind[K]>);
		}
		attempt.success();
		for (const storageKey of corrupt) await this.deleteQuietly(storageKey);
		return results;
	}

	private async getManyByGet(keys: readonly string[]): Promise<Map<string, unknown>> {
		const results = new Map<string, unknown>();
		await Promise.all(keys.map(async (key) => {
			const raw = await this.store.get(key);
			if (raw !== undefined) results.set(key, raw);
		}));
		return results;
	}

	async set<K extends CatalogKind>(
		cacheKey: CatalogCacheKey<K>,
		record: CatalogCacheRecord<CatalogEntityByKind[K]>,
	): Promise<void> {
		const attempt = this.diagnostics.begin('catalog', 'write');
		const envelope: PersistedCatalogEnvelope = { key: cacheKey, record };
		try {
			const serialized = JSON.stringify(envelope);
			const jsonValue: unknown = JSON.parse(serialized);
			if (!isCompatibleEnvelope(jsonValue, cacheKey)) { attempt.failure('validation_failed'); return; }
			await this.store.set(catalogCacheStorageKey(cacheKey), serialized);
			attempt.success();
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			// A cache write must never fail the catalog resolution.
		}
	}

	/**
	 * Z30: stores a whole resolved batch through one store write (one IndexedDB transaction)
	 * instead of one per entity. Each entry is serialized and validated exactly as in `set`; an
	 * entry that fails validation is skipped and the rest are still written. As in `set`, a storage
	 * failure is recorded and never rejects. With a single transaction a failure is all-or-nothing
	 * for the batch (before: entities written up to the failure stayed); the cache refills.
	 */
	async setMany(entries: readonly CatalogCacheEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const attempt = this.diagnostics.begin('catalog', 'write');
		const serialized: [string, string][] = [];
		let rejected = 0;
		for (const { key: cacheKey, record } of entries) {
			const text = JSON.stringify({ key: cacheKey, record } satisfies PersistedCatalogEnvelope);
			const jsonValue: unknown = JSON.parse(text);
			if (!isCompatibleEnvelope(jsonValue, cacheKey)) { rejected += 1; continue; }
			serialized.push([catalogCacheStorageKey(cacheKey), text]);
		}
		if (serialized.length === 0) { attempt.failure('validation_failed'); return; }
		try {
			if (this.store.setMany) {
				await this.store.setMany(serialized);
			} else {
				for (const [storageKey, text] of serialized) await this.store.set(storageKey, text);
			}
			if (rejected > 0) attempt.failure('validation_failed');
			else attempt.success();
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			// A cache write must never fail the catalog resolution.
		}
	}

	dispose(): void {
		this.store.close();
	}

	private async deleteQuietly(storageKey: string): Promise<void> {
		const attempt = this.diagnostics.begin('catalog', 'recover');
		try {
			await this.store.delete(storageKey);
			attempt.recover();
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			// Corruption still behaves as a miss when cleanup is unavailable.
		}
	}
}

export interface CatalogCacheFactoryOptions {
	indexedDb?: IDBFactory | null;
	databaseName?: string;
	/** Test seam and alternate local backends; production defaults to IndexedDB. */
	openStore?: () => Promise<CatalogRecordStore>;
	diagnostics?: LocalDebugPersistenceProbe;
}

/** Opens local persistence on demand and explicitly falls back to process memory. */
export async function createCatalogCacheAdapter(
	options: CatalogCacheFactoryOptions = {},
): Promise<CatalogCacheAdapter> {
	const diagnostics = options.diagnostics ?? new LocalDebugPersistenceProbe();
	const attempt = diagnostics.begin('catalog', 'open');
	try {
		if (options.openStore) {
			const cache = new PersistentCatalogCache(await options.openStore(), diagnostics);
			attempt.success();
			return cache;
		}
		const indexedDb =
			options.indexedDb === undefined
				? typeof window === 'undefined' || typeof window.indexedDB === 'undefined'
					? null
					: window.indexedDB
				: options.indexedDb;
		if (!indexedDb) { attempt.skip('unavailable'); return new MemoryCatalogCache(); }
		const cache = new PersistentCatalogCache(
			await IndexedDbCatalogRecordStore.open(
				indexedDb,
				options.databaseName ?? CATALOG_CACHE_DB_NAME,
				CATALOG_CACHE_DB_VERSION,
				diagnostics,
			),
			diagnostics,
		);
		attempt.success();
		return cache;
	} catch (error) {
		attempt.failure(indexedDbFailureCode(error), error);
		const fallback = diagnostics.begin('catalog', 'fallback');
		fallback.success('unavailable');
		return new MemoryCatalogCache();
	}
}

/**
 * IndexedDB-backed string store. Each method owns one transaction (`setMany` and `getMany`: one for the whole batch).
 *
 * Opened through `open`, a connection the engine dropped is replaced on the next operation (DU-05); a store built around
 * a fixed database has nothing to open again.
 */
export class IndexedDbCatalogRecordStore implements CatalogRecordStore {
	private readonly connection: ReopeningIndexedDbConnection;

	constructor(
		database: IDBDatabase | ReopeningIndexedDbConnection,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {
		this.connection = database instanceof ReopeningIndexedDbConnection
			? database
			: new ReopeningIndexedDbConnection(null, () => new Error('The public catalog cache is closed.'), database);
	}

	static async open(
		factory: IDBFactory,
		databaseName: string,
		databaseVersion = CATALOG_CACHE_DB_VERSION,
		diagnostics = new LocalDebugPersistenceProbe(),
	): Promise<IndexedDbCatalogRecordStore> {
		const attempt = diagnostics.begin('catalog', 'open');
		const connection = new ReopeningIndexedDbConnection(async (hooks) => await openIndexedDb({
			factory,
			databaseName,
			databaseVersion,
			schema: [{ name: CATALOG_CACHE_STORE_NAME }],
			...hooks,
			toError: (reason) => new Error(reason === 'blocked'
				? 'Public catalog cache upgrade was blocked.'
				: 'Could not open the public catalog cache.'),
		}), () => new Error('The public catalog cache is closed.'));
		try {
			await connection.open();
		} catch (error) {
			attempt.failure(indexedDbFailureCode(error), error);
			throw error;
		}
		attempt.success();
		return new IndexedDbCatalogRecordStore(connection, diagnostics);
	}

	get(key: string): Promise<unknown> {
		const attempt = this.diagnostics.begin('catalog', 'read');
		return this.observed(attempt, (database) => new Promise((resolve, reject) => {
			// A throw here rejects this promise: the executor runs synchronously inside it.
			const transaction = startIndexedDbTransaction(database, CATALOG_CACHE_STORE_NAME, 'readonly');
			const request = transaction.objectStore(CATALOG_CACHE_STORE_NAME).get(key);
			let result: unknown;
			request.onsuccess = () => {
				result = request.result as unknown;
			};
			transaction.oncomplete = () => { resolve(result); };
			transaction.onerror = () => { reject(new CatalogTransactionFailure('Could not read the public catalog cache.')); };
			transaction.onabort = () => { reject(new CatalogTransactionFailure('Public catalog cache read was aborted.')); };
		}));
	}

	/** Opens exactly one readonly transaction for the whole batch, regardless of key count. */
	getMany(keys: readonly string[]): Promise<Map<string, unknown>> {
		const attempt = this.diagnostics.begin('catalog', 'read');
		if (keys.length === 0) { attempt.skip(); return Promise.resolve(new Map<string, unknown>()); }
		return this.observed(attempt, (database) => new Promise<Map<string, unknown>>((resolve, reject) => {
			const transaction = startIndexedDbTransaction(database, CATALOG_CACHE_STORE_NAME, 'readonly');
			const store = transaction.objectStore(CATALOG_CACHE_STORE_NAME);
			const results = new Map<string, unknown>();
			for (const key of keys) {
				const request = store.get(key);
				request.onsuccess = () => {
					if (request.result !== undefined) results.set(key, request.result as unknown);
				};
			}
			transaction.oncomplete = () => { resolve(results); };
			transaction.onerror = () => { reject(new CatalogTransactionFailure('Could not read the public catalog cache.')); };
			transaction.onabort = () => { reject(new CatalogTransactionFailure('Public catalog cache read was aborted.')); };
		}));
	}

	set(key: string, value: string): Promise<void> {
		return this.write((store) => { store.put(value, key); });
	}

	/** Opens exactly one readwrite transaction for the whole batch; it commits or aborts as a whole. */
	setMany(entries: readonly (readonly [key: string, value: string])[]): Promise<void> {
		if (entries.length === 0) return Promise.resolve();
		return this.write((store) => { for (const [key, value] of entries) store.put(value, key); });
	}

	delete(key: string): Promise<void> {
		return this.write((store) => { store.delete(key); });
	}

	close(): void {
		const attempt = this.diagnostics.begin('catalog', 'close');
		this.connection.close();
		attempt.success();
	}

	private write(action: (store: IDBObjectStore) => void): Promise<void> {
		const attempt = this.diagnostics.begin('catalog', 'write');
		return this.observed(attempt, (database) => new Promise((resolve, reject) => {
			const transaction = startIndexedDbTransaction(database, CATALOG_CACHE_STORE_NAME, 'readwrite');
			try {
				action(transaction.objectStore(CATALOG_CACHE_STORE_NAME));
			} catch (error) {
				// A request that throws mid-batch must not leave the earlier puts to auto-commit.
				transaction.abort();
				reject(error instanceof Error ? error : new Error('Could not write the public catalog cache.'));
				return;
			}
			transaction.oncomplete = () => { resolve(); };
			transaction.onerror = () => { reject(new CatalogTransactionFailure('Could not write the public catalog cache.')); };
			transaction.onabort = () => { reject(new CatalogTransactionFailure('Public catalog cache write was aborted.')); };
		}));
	}

	/**
	 * Runs one transaction on the cached connection, replacing a dead one once (DU-05), and records its one outcome. A
	 * transaction that started and failed is recorded without a code, as it always was; anything else is the engine's
	 * own error, recorded with its code and handed to the caller.
	 */
	private async observed<T>(
		attempt: ReturnType<LocalDebugPersistenceProbe['begin']>,
		operation: (database: IDBDatabase) => Promise<T>,
	): Promise<T> {
		try {
			const value = await this.connection.run(operation);
			attempt.success();
			return value;
		} catch (error) {
			if (error instanceof CatalogTransactionFailure) {
				attempt.failure();
				throw error;
			}
			const reason = error instanceof IndexedDbConnectionLostError ? error.reason : error;
			// Coded from what really happened: an engine that did not answer in time stays a `timeout`.
			attempt.failure(indexedDbFailureCode(error), reason);
			throw reason instanceof Error ? reason : new Error('The public catalog cache is unavailable.');
		}
	}
}

/** A catalog transaction that started and then failed or aborted. */
class CatalogTransactionFailure extends Error {}

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
		(value.kind === 'items' || value.kind === 'currencies' || value.kind === 'materials' || value.kind === 'maps') &&
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
