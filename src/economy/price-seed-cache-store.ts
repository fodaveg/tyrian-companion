import {
	ReopeningIndexedDbConnection,
	isIndexedDbUnavailable,
	openIndexedDb,
	startIndexedDbTransaction,
} from '../core/indexed-db-open';
import { isPriceSeed, type PriceSeedFailureReason, type PriceSeedV1 } from './price-seed-model';

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

/**
 * One IndexedDB record per `(vaultId, itemId)`. Fail-closed: never substitutes an in-memory copy. A connection the
 * engine dropped is replaced on the next operation (DU-05).
 */
export class IndexedDbPriceSeedCacheStore {
	constructor(private readonly connection: ReopeningIndexedDbConnection) {}

	static async open(
		factory: IDBFactory,
		databaseName = PRICE_SEED_CACHE_DB_NAME,
		databaseVersion = PRICE_SEED_CACHE_DB_VERSION,
	): Promise<IndexedDbPriceSeedCacheStore> {
		return new IndexedDbPriceSeedCacheStore(
			await openSeedConnection(factory, databaseName, databaseVersion, PRICE_SEED_CACHE_STORE),
		);
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

	close(): void { this.connection.close(); }

	private transaction<T>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
	): Promise<T> {
		return seedTransaction(this.connection, PRICE_SEED_CACHE_STORE, mode, operation);
	}
}

/** Opens the first connection of a seed database, so a failure to open still rejects `open()` as it always did. */
async function openSeedConnection(
	factory: IDBFactory,
	databaseName: string,
	databaseVersion: number,
	storeName: string,
): Promise<ReopeningIndexedDbConnection> {
	const connection = new ReopeningIndexedDbConnection(async (hooks) => await openIndexedDb({
		factory,
		databaseName,
		databaseVersion,
		schema: [{ name: storeName, keyPath: ['vaultId', 'itemId'] }],
		...hooks,
		toError: (reason, error) => new PriceSeedCacheStoreError(reason === 'blocked'
			? 'blocked'
			: error?.name === 'VersionError' ? 'future_schema' : 'unavailable'),
	}), () => new PriceSeedCacheStoreError('unavailable'));
	await connection.open();
	return connection;
}

/**
 * One transaction on `storeName`; a connection that died before it could start is replaced once (DU-05). A dead
 * connection throws before `operation` runs, so running it again on a new one is safe.
 */
async function seedTransaction<T>(
	connection: ReopeningIndexedDbConnection,
	storeName: string,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
): Promise<T> {
	try {
		return await connection.run((database) => new Promise<T>((resolve, reject) => {
			// A throw here rejects this promise: the executor runs synchronously inside it.
			const transaction = startIndexedDbTransaction(database, [storeName], mode);
			transaction.onerror = () => reject(storeFailure(transaction.error));
			transaction.onabort = () => reject(storeFailure(transaction.error));
			try { operation(transaction.objectStore(storeName), resolve, reject); }
			catch (error) { reject(error instanceof Error ? error : new PriceSeedCacheStoreError('unavailable')); }
		}));
	} catch (error) {
		throw isIndexedDbUnavailable(error) ? new PriceSeedCacheStoreError('unavailable') : error;
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

const PRICE_SEED_FAILURE_REASONS: readonly PriceSeedFailureReason[] = ['unreachable', 'unavailable', 'malformed', 'empty'];

/**
 * H18.17: a SEPARATE database from `PRICE_SEED_CACHE_DB_NAME`, not a second store bolted onto it.
 *
 * `PriceSeedBulkRefreshService` (`price-seed-bulk-refresh.ts`) was spending one of its 25
 * per-run slots on every item that answered `no_seed`, on every single sync, because nothing
 * remembered the answer: with more than 25 watch-listed items and a failure early in the list,
 * the rest could never be reached. This store lets a `no_seed` answer be remembered with a
 * spaced retry (not an infinite one — `PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS` in
 * `price-seed-bulk-refresh.ts` governs when it is worth asking again).
 *
 * Kept apart from `IndexedDbPriceSeedCacheStore` on purpose: a negative answer is not a
 * `PriceSeedV1` and forcing it through `isPriceSeed`'s validator would either fail closed on
 * every negative record or weaken that validator for the one real seed shape it exists to guard.
 */
export const PRICE_SEED_NO_SEED_DB_NAME = 'tyrian-companion-price-seed-no-seed-cache';
export const PRICE_SEED_NO_SEED_DB_VERSION = 1;
export const PRICE_SEED_NO_SEED_STORE = 'no-seed-v1';

export interface PriceSeedNoSeedRecordV1 {
	version: 1;
	vaultId: string;
	itemId: number;
	reason: PriceSeedFailureReason;
	/** When this negative answer was recorded, so the caller can decide it is worth asking again. */
	failedAtMs: number;
}

/**
 * One IndexedDB record per `(vaultId, itemId)`, remembering datawars2's LAST `no_seed` answer only. A connection the
 * engine dropped is replaced on the next operation (DU-05).
 */
export class IndexedDbPriceSeedNoSeedStore {
	constructor(private readonly connection: ReopeningIndexedDbConnection) {}

	static async open(
		factory: IDBFactory,
		databaseName = PRICE_SEED_NO_SEED_DB_NAME,
		databaseVersion = PRICE_SEED_NO_SEED_DB_VERSION,
	): Promise<IndexedDbPriceSeedNoSeedStore> {
		return new IndexedDbPriceSeedNoSeedStore(
			await openSeedConnection(factory, databaseName, databaseVersion, PRICE_SEED_NO_SEED_STORE),
		);
	}

	get(vaultId: string, itemId: number): Promise<PriceSeedNoSeedRecordV1 | null> {
		return this.transaction<PriceSeedNoSeedRecordV1 | null>('readonly', (store, resolve, reject) => {
			const request = store.get([vaultId, itemId]);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				try { resolve(request.result === undefined ? null : parseNoSeedRecord(request.result)); }
				catch (error) { reject(error); }
			};
		});
	}

	put(vaultId: string, itemId: number, reason: PriceSeedFailureReason, failedAtMs: number): Promise<void> {
		const record: PriceSeedNoSeedRecordV1 = { version: 1, vaultId, itemId, reason, failedAtMs };
		parseNoSeedRecord(record);
		return this.transaction<void>('readwrite', (store, resolve, reject) => {
			const request = store.put(record);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => resolve(undefined);
		});
	}

	/** Clears a stale negative answer once a later attempt actually seeds the item. */
	delete(vaultId: string, itemId: number): Promise<void> {
		return this.transaction<void>('readwrite', (store, resolve, reject) => {
			const request = store.delete([vaultId, itemId]);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => resolve(undefined);
		});
	}

	close(): void { this.connection.close(); }

	private transaction<T>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
	): Promise<T> {
		return seedTransaction(this.connection, PRICE_SEED_NO_SEED_STORE, mode, operation);
	}
}

function parseNoSeedRecord(value: unknown): PriceSeedNoSeedRecordV1 {
	if (!record(value) || value.version !== 1 || !text(value.vaultId) || !positiveInteger(value.itemId)
		|| !nonNegativeInteger(value.failedAtMs)
		|| typeof value.reason !== 'string' || !PRICE_SEED_FAILURE_REASONS.includes(value.reason as PriceSeedFailureReason)) {
		throw new PriceSeedCacheStoreError('corrupt');
	}
	return structuredClone(value) as unknown as PriceSeedNoSeedRecordV1;
}
