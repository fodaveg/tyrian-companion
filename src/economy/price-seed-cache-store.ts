import { openIndexedDb } from '../core/indexed-db-open';
import { isPriceSeed, type PriceSeedV1 } from './price-seed-model';

/**
 * Where the panel's datawars2 download lands once it has been trimmed.
 *
 * A dedicated database, not a new store bolted onto `price-history-store.ts`:
 * the local capture engine's schema is heavily exercised already, and the seed
 * cache has a completely different shape (one record per item, not per vault
 * day) and a completely different writer (the panel, on demand, never the
 * capture scheduler). Keeping it apart means this file can be reasoned about,
 * and reviewed for the observability census, on its own.
 */
export const PRICE_SEED_CACHE_DB_NAME = 'tyrian-companion-price-seed-cache';
export const PRICE_SEED_CACHE_DB_VERSION = 1;
export const PRICE_SEED_CACHE_STORE = 'seed-v1';

export type PriceSeedCacheStoreFailure = 'unavailable' | 'blocked' | 'future_schema' | 'corrupt' | 'quota';

export class PriceSeedCacheStoreError extends Error {
	constructor(readonly failure: PriceSeedCacheStoreFailure) {
		super(`Price-seed cache storage is ${failure}.`);
		this.name = 'PriceSeedCacheStoreError';
	}
}

export interface PriceSeedCacheRecordV1 {
	version: 1;
	vaultId: string;
	itemId: number;
	seed: PriceSeedV1;
	/** When this record was written, so the caller can decide it is stale and worth a refresh. */
	cachedAtMs: number;
}

/** One IndexedDB record per `(vaultId, itemId)`. Fail-closed: never substitutes an in-memory copy. */
export class IndexedDbPriceSeedCacheStore {
	constructor(private readonly database: IDBDatabase) {}

	static async open(
		factory: IDBFactory,
		databaseName = PRICE_SEED_CACHE_DB_NAME,
		databaseVersion = PRICE_SEED_CACHE_DB_VERSION,
	): Promise<IndexedDbPriceSeedCacheStore> {
		const database = await openIndexedDb({
			factory,
			databaseName,
			databaseVersion,
			schema: [{ name: PRICE_SEED_CACHE_STORE, keyPath: ['vaultId', 'itemId'] }],
			onVersionChange: 'close',
			toError: (reason, error) => new PriceSeedCacheStoreError(reason === 'blocked'
				? 'blocked'
				: error?.name === 'VersionError' ? 'future_schema' : 'unavailable'),
		});
		return new IndexedDbPriceSeedCacheStore(database);
	}

	get(vaultId: string, itemId: number): Promise<PriceSeedCacheRecordV1 | null> {
		return this.transaction<PriceSeedCacheRecordV1 | null>('readonly', (store, resolve, reject) => {
			const request = store.get([vaultId, itemId]);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				try { resolve(request.result === undefined ? null : parseRecord(request.result)); }
				catch (error) { reject(error); }
			};
		});
	}

	put(vaultId: string, itemId: number, seed: PriceSeedV1, cachedAtMs: number): Promise<void> {
		const record: PriceSeedCacheRecordV1 = { version: 1, vaultId, itemId, seed, cachedAtMs };
		parseRecord(record);
		return this.transaction<void>('readwrite', (store, resolve, reject) => {
			const request = store.put(record);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => resolve(undefined);
		});
	}

	close(): void { this.database.close(); }

	private transaction<T>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try { transaction = this.database.transaction([PRICE_SEED_CACHE_STORE], mode); }
			catch { reject(new PriceSeedCacheStoreError('unavailable')); return; }
			transaction.onerror = () => reject(storeFailure(transaction.error));
			transaction.onabort = () => reject(storeFailure(transaction.error));
			try { operation(transaction.objectStore(PRICE_SEED_CACHE_STORE), resolve, reject); }
			catch (error) { reject(error instanceof Error ? error : new PriceSeedCacheStoreError('unavailable')); }
		});
	}
}

function storeFailure(error: DOMException | null): PriceSeedCacheStoreError {
	return new PriceSeedCacheStoreError(error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable');
}

function parseRecord(value: unknown): PriceSeedCacheRecordV1 {
	if (!record(value) || value.version !== 1 || !text(value.vaultId) || !positiveInteger(value.itemId)
		|| !nonNegativeInteger(value.cachedAtMs) || !isPriceSeed(value.seed)
		|| value.seed.itemId !== value.itemId) {
		throw new PriceSeedCacheStoreError('corrupt');
	}
	return structuredClone(value) as unknown as PriceSeedCacheRecordV1;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
