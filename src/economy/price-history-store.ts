import {
	PRICE_HISTORY_DAILY_STORE,
	PRICE_HISTORY_DB_NAME,
	PRICE_HISTORY_DB_VERSION,
	PRICE_HISTORY_MAX_WATCH_ITEMS,
	PRICE_HISTORY_META_STORE,
	PRICE_HISTORY_SEED_ITEM_IDS,
	PRICE_HISTORY_SNAPSHOT_STORE,
	PRICE_HISTORY_WATCH_STORE,
	priceHistoryDayUtc,
	type PriceHistoryCaptureLeaseV1,
	type PriceHistoryDailyV1,
	type PriceHistorySnapshotV1,
	type PriceHistoryWatchItemV1,
} from './price-history-model';
import { aggregatePriceHistoryDay } from './price-history-statistics';

const DAY_MS = 86_400_000;

export type PriceHistoryStoreFailure = 'unavailable' | 'blocked' | 'future_schema' | 'corrupt' | 'quota';

export class PriceHistoryStoreError extends Error {
	constructor(readonly failure: PriceHistoryStoreFailure) {
		super(`Price-history storage is ${failure}.`);
		this.name = 'PriceHistoryStoreError';
	}
}

export type PriceHistorySlotClaim =
	| { status: 'acquired'; lease: PriceHistoryCaptureLeaseV1 }
	| { status: 'captured'; snapshot: PriceHistorySnapshotV1 }
	| { status: 'busy' };

export type PriceHistorySlotCommit =
	| { status: 'committed'; snapshot: PriceHistorySnapshotV1 }
	| { status: 'captured'; snapshot: PriceHistorySnapshotV1 }
	| { status: 'stale_fence' };

export interface PriceHistoryCompactionResult {
	dailyRecords: number;
	prunedSnapshots: number;
	prunedDaily: number;
}

/** Dedicated, fail-closed IndexedDB adapter. It never substitutes an in-memory store. */
export class IndexedDbPriceHistoryStore {
	constructor(private readonly database: IDBDatabase) {}

	static open(
		factory: IDBFactory,
		databaseName = PRICE_HISTORY_DB_NAME,
		databaseVersion = PRICE_HISTORY_DB_VERSION,
	): Promise<IndexedDbPriceHistoryStore> {
		return new Promise((resolve, reject) => {
			const request = factory.open(databaseName, databaseVersion);
			let settled = false;
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(PRICE_HISTORY_SNAPSHOT_STORE)) {
					const snapshots = database.createObjectStore(PRICE_HISTORY_SNAPSHOT_STORE, { keyPath: ['vaultId', 'slotStartMs'] });
					snapshots.createIndex('by-vault-captured', ['vaultId', 'capturedAtMs']);
				}
				if (!database.objectStoreNames.contains(PRICE_HISTORY_DAILY_STORE)) {
					const daily = database.createObjectStore(PRICE_HISTORY_DAILY_STORE, { keyPath: ['vaultId', 'itemId', 'dayUtc'] });
					daily.createIndex('by-vault-day', ['vaultId', 'dayUtc']);
					daily.createIndex('by-vault-item-day', ['vaultId', 'itemId', 'dayUtc']);
				}
				if (!database.objectStoreNames.contains(PRICE_HISTORY_WATCH_STORE)) {
					const watch = database.createObjectStore(PRICE_HISTORY_WATCH_STORE, { keyPath: ['vaultId', 'itemId'] });
					watch.createIndex('by-vault-observed', ['vaultId', 'lastObservedAtMs']);
				}
				if (!database.objectStoreNames.contains(PRICE_HISTORY_META_STORE)) {
					database.createObjectStore(PRICE_HISTORY_META_STORE, { keyPath: ['vaultId', 'key'] });
				}
			};
			request.onblocked = () => fail(new PriceHistoryStoreError('blocked'));
			request.onerror = () => {
				const future = request.error?.name === 'VersionError';
				fail(new PriceHistoryStoreError(future ? 'future_schema' : 'unavailable'));
			};
			request.onsuccess = () => {
				if (settled) { request.result.close(); return; }
				settled = true;
				request.result.onversionchange = () => request.result.close();
				resolve(new IndexedDbPriceHistoryStore(request.result));
			};
			function fail(error: Error): void {
				if (!settled) reject(error);
				settled = true;
			}
		});
	}

	async ensureSeedWatchList(vaultId: string, nowMs: number): Promise<PriceHistoryWatchItemV1[]> {
		await this.observeItems(vaultId, PRICE_HISTORY_SEED_ITEM_IDS, nowMs);
		return await this.readWatchList(vaultId);
	}

	/** Adds positive observed ids and evicts only the oldest non-seed entries beyond 400. */
	observeItems(vaultId: string, itemIds: readonly number[], nowMs: number): Promise<void> {
		const observed = new Set(itemIds.filter(positiveInteger));
		for (const seed of PRICE_HISTORY_SEED_ITEM_IDS) observed.add(seed);
		return this.transaction([PRICE_HISTORY_WATCH_STORE], 'readwrite', (transaction, resolve, reject) => {
			const store = transaction.objectStore(PRICE_HISTORY_WATCH_STORE);
			const request = store.getAll(keyRangeForVault(vaultId));
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				try {
					const existing = request.result.map(parseWatchItem);
					const byId = new Map(existing.map((entry) => [entry.itemId, entry]));
					for (const itemId of observed) {
						byId.set(itemId, {
							version: 1, vaultId, itemId,
							seed: PRICE_HISTORY_SEED_ITEM_IDS.includes(itemId),
							lastObservedAtMs: nowMs,
						});
					}
					const ordered = [...byId.values()].sort((left, right) =>
						Number(right.seed) - Number(left.seed)
						|| right.lastObservedAtMs - left.lastObservedAtMs
						|| left.itemId - right.itemId,
					).slice(0, PRICE_HISTORY_MAX_WATCH_ITEMS);
					const retained = new Set(ordered.map(({ itemId }) => itemId));
					for (const entry of existing) if (!retained.has(entry.itemId)) store.delete([vaultId, entry.itemId]);
					for (const entry of ordered) store.put(entry);
					transaction.oncomplete = () => resolve(undefined);
				} catch (error) { reject(error); transaction.abort(); }
			};
		});
	}

	readWatchList(vaultId: string): Promise<PriceHistoryWatchItemV1[]> {
		return this.readAll(PRICE_HISTORY_WATCH_STORE, keyRangeForVault(vaultId), parseWatchItem)
			.then((items) => items.sort((left, right) => left.itemId - right.itemId));
	}

	claimSlot(
		vaultId: string,
		slotStartMs: number,
		ownerId: string,
		nowMs: number,
		leaseMs = 120_000,
	): Promise<PriceHistorySlotClaim> {
		return this.transaction([PRICE_HISTORY_SNAPSHOT_STORE, PRICE_HISTORY_META_STORE], 'readwrite', (transaction, resolve, reject) => {
			const snapshots = transaction.objectStore(PRICE_HISTORY_SNAPSHOT_STORE);
			const meta = transaction.objectStore(PRICE_HISTORY_META_STORE);
			const snapshotRequest = snapshots.get([vaultId, slotStartMs]);
			snapshotRequest.onerror = () => reject(storeFailure(snapshotRequest.error));
			snapshotRequest.onsuccess = () => {
				try {
					if (snapshotRequest.result !== undefined) {
						const snapshot = parseSnapshot(snapshotRequest.result);
						transaction.oncomplete = () => resolve({ status: 'captured', snapshot });
						return;
					}
					const key = leaseKey(slotStartMs);
					const leaseRequest = meta.get([vaultId, key]);
					leaseRequest.onerror = () => reject(storeFailure(leaseRequest.error));
					leaseRequest.onsuccess = () => {
						try {
							const current = leaseRequest.result === undefined ? null : parseLeaseMeta(leaseRequest.result);
							if (current !== null && current.expiresAtMs > nowMs && current.ownerId !== ownerId) {
								transaction.oncomplete = () => resolve({ status: 'busy' });
								return;
							}
							const lease: PriceHistoryCaptureLeaseV1 = {
								version: 1, vaultId, slotStartMs, ownerId, leaseId: crypto.randomUUID(),
								fence: (current?.fence ?? 0) + 1,
								expiresAtMs: nowMs + leaseMs,
							};
							meta.put({ ...lease, key });
							transaction.oncomplete = () => resolve({ status: 'acquired', lease });
						} catch (error) { reject(error); transaction.abort(); }
					};
				} catch (error) { reject(error); transaction.abort(); }
			};
		});
	}

	commitSlot(lease: PriceHistoryCaptureLeaseV1, snapshot: PriceHistorySnapshotV1): Promise<PriceHistorySlotCommit> {
		if (snapshot.vaultId !== lease.vaultId || snapshot.slotStartMs !== lease.slotStartMs) {
			return Promise.resolve({ status: 'stale_fence' });
		}
		parseSnapshot(snapshot);
		return this.transaction([PRICE_HISTORY_SNAPSHOT_STORE, PRICE_HISTORY_META_STORE], 'readwrite', (transaction, resolve, reject) => {
			const snapshots = transaction.objectStore(PRICE_HISTORY_SNAPSHOT_STORE);
			const meta = transaction.objectStore(PRICE_HISTORY_META_STORE);
			const existingRequest = snapshots.get([lease.vaultId, lease.slotStartMs]);
			existingRequest.onerror = () => reject(storeFailure(existingRequest.error));
			existingRequest.onsuccess = () => {
				try {
					if (existingRequest.result !== undefined) {
						const existing = parseSnapshot(existingRequest.result);
						transaction.oncomplete = () => resolve({ status: 'captured', snapshot: existing });
						return;
					}
					const key = leaseKey(lease.slotStartMs);
					const leaseRequest = meta.get([lease.vaultId, key]);
					leaseRequest.onerror = () => reject(storeFailure(leaseRequest.error));
					leaseRequest.onsuccess = () => {
						try {
							const current = leaseRequest.result === undefined ? null : parseLeaseMeta(leaseRequest.result);
							if (current === null || current.leaseId !== lease.leaseId || current.fence !== lease.fence) {
								transaction.oncomplete = () => resolve({ status: 'stale_fence' });
								return;
							}
							snapshots.put(snapshot);
							meta.delete([lease.vaultId, key]);
							transaction.oncomplete = () => resolve({ status: 'committed', snapshot: structuredClone(snapshot) });
						} catch (error) { reject(error); transaction.abort(); }
					};
				} catch (error) { reject(error); transaction.abort(); }
			};
		});
	}

	readSnapshots(vaultId: string, fromCapturedAtMs = 0): Promise<PriceHistorySnapshotV1[]> {
		return this.readAll(PRICE_HISTORY_SNAPSHOT_STORE, keyRangeForVault(vaultId), parseSnapshot)
			.then((snapshots) => snapshots.filter(({ capturedAtMs }) => capturedAtMs >= fromCapturedAtMs)
				.sort((left, right) => left.capturedAtMs - right.capturedAtMs));
	}

	readDaily(vaultId: string, itemId: number, fromDayUtc: string): Promise<PriceHistoryDailyV1[]> {
		return this.readAll(PRICE_HISTORY_DAILY_STORE, keyRangeForVault(vaultId), parseDaily)
			.then((daily) => daily.filter((entry) => entry.itemId === itemId && entry.dayUtc >= fromDayUtc)
				.sort((left, right) => left.dayUtc.localeCompare(right.dayUtc)));
	}

	/** Rebuilds daily aggregates from raw data in the same transaction, then prunes raw and old daily rows. */
	compactAndPrune(
		vaultId: string,
		nowMs: number,
		rawRetentionDays: number,
		dailyRetentionDays: number,
	): Promise<PriceHistoryCompactionResult> {
		const rawCutoff = nowMs - rawRetentionDays * DAY_MS;
		const dailyCutoff = priceHistoryDayUtc(Math.max(0, nowMs - dailyRetentionDays * DAY_MS));
		return this.transaction([PRICE_HISTORY_SNAPSHOT_STORE, PRICE_HISTORY_DAILY_STORE], 'readwrite', (transaction, resolve, reject) => {
			const snapshotsStore = transaction.objectStore(PRICE_HISTORY_SNAPSHOT_STORE);
			const dailyStore = transaction.objectStore(PRICE_HISTORY_DAILY_STORE);
			const snapshotRequest = snapshotsStore.getAll(keyRangeForVault(vaultId));
			const dailyRequest = dailyStore.getAll(keyRangeForVault(vaultId));
			let raw: PriceHistorySnapshotV1[] | null = null;
			let existingDaily: PriceHistoryDailyV1[] | null = null;
			const continueWhenReady = (): void => {
				if (raw === null || existingDaily === null) return;
				try {
					const groups = new Map<string, { itemId: number; dayUtc: string; snapshots: PriceHistorySnapshotV1[] }>();
					for (const snapshot of raw) {
						const dayUtc = priceHistoryDayUtc(snapshot.capturedAtMs);
						for (const [itemId] of snapshot.items) {
							const key = `${String(itemId)}:${dayUtc}`;
							const group = groups.get(key) ?? { itemId, dayUtc, snapshots: [] };
							group.snapshots.push(snapshot);
							groups.set(key, group);
						}
					}
					for (const group of groups.values()) {
						dailyStore.put(aggregatePriceHistoryDay(vaultId, group.itemId, group.dayUtc, group.snapshots));
					}
					let prunedSnapshots = 0;
					for (const snapshot of raw) if (snapshot.capturedAtMs < rawCutoff) {
						snapshotsStore.delete([vaultId, snapshot.slotStartMs]); prunedSnapshots += 1;
					}
					let prunedDaily = 0;
					for (const entry of existingDaily) if (entry.dayUtc < dailyCutoff) {
						dailyStore.delete([vaultId, entry.itemId, entry.dayUtc]); prunedDaily += 1;
					}
					transaction.oncomplete = () => resolve({ dailyRecords: groups.size, prunedSnapshots, prunedDaily });
				} catch (error) { reject(error); transaction.abort(); }
			};
			snapshotRequest.onerror = () => reject(storeFailure(snapshotRequest.error));
			snapshotRequest.onsuccess = () => { try { raw = snapshotRequest.result.map(parseSnapshot); continueWhenReady(); } catch (error) { reject(error); transaction.abort(); } };
			dailyRequest.onerror = () => reject(storeFailure(dailyRequest.error));
			dailyRequest.onsuccess = () => { try { existingDaily = dailyRequest.result.map(parseDaily); continueWhenReady(); } catch (error) { reject(error); transaction.abort(); } };
		});
	}

	close(): void { this.database.close(); }

	private readAll<T>(storeName: string, range: IDBKeyRange, parse: (value: unknown) => T): Promise<T[]> {
		return this.transaction([storeName], 'readonly', (transaction, resolve, reject) => {
			const request = transaction.objectStore(storeName).getAll(range);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				try {
					const result = request.result.map(parse);
					transaction.oncomplete = () => resolve(result);
				} catch (error) { reject(error); transaction.abort(); }
			};
		});
	}

	private transaction<T>(
		stores: string[],
		mode: IDBTransactionMode,
		operation: (transaction: IDBTransaction, resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try { transaction = this.database.transaction(stores, mode); }
			catch { reject(new PriceHistoryStoreError('unavailable')); return; }
			transaction.onerror = () => reject(storeFailure(transaction.error));
			transaction.onabort = () => reject(storeFailure(transaction.error));
			operation(transaction, resolve, reject);
		});
	}
}

function keyRangeForVault(vaultId: string): IDBKeyRange {
	return IDBKeyRange.bound([vaultId], [vaultId, []]);
}

function leaseKey(slotStartMs: number): string { return `capture:${String(slotStartMs)}`; }

function parseLeaseMeta(value: unknown): PriceHistoryCaptureLeaseV1 {
	if (!record(value)) throw new PriceHistoryStoreError('corrupt');
	return parseLease(value);
}

function parseLease(value: Record<string, unknown>): PriceHistoryCaptureLeaseV1 {
	if (value.version !== 1 || !text(value.vaultId) || !nonNegativeInteger(value.slotStartMs)
		|| !text(value.ownerId) || !text(value.leaseId) || !positiveInteger(value.fence)
		|| !nonNegativeInteger(value.expiresAtMs)) throw new PriceHistoryStoreError('corrupt');
	return value as unknown as PriceHistoryCaptureLeaseV1;
}

function parseSnapshot(value: unknown): PriceHistorySnapshotV1 {
	if (!record(value) || value.version !== 1 || !text(value.vaultId) || !nonNegativeInteger(value.slotStartMs)
		|| !nonNegativeInteger(value.capturedAtMs) || !positiveInteger(value.intervalMs)
		|| (value.status !== 'complete' && value.status !== 'partial') || !Array.isArray(value.items)
		|| !Array.isArray(value.missingItemIds)) throw new PriceHistoryStoreError('corrupt');
	const items = value.items as unknown[];
	const missing = value.missingItemIds as unknown[];
	if (!items.every((entry) => Array.isArray(entry) && entry.length === 3 && positiveInteger(entry[0])
		&& nullableCopper(entry[1]) && nullableCopper(entry[2])) || !missing.every(positiveInteger)) {
		throw new PriceHistoryStoreError('corrupt');
	}
	const itemIds = items.map((entry) => (entry as unknown[])[0] as number);
	if (!ascending(itemIds) || !ascending(missing) || itemIds.some((id) => missing.includes(id))
		|| (value.status === 'complete' && missing.length > 0)) throw new PriceHistoryStoreError('corrupt');
	return structuredClone(value) as unknown as PriceHistorySnapshotV1;
}

function parseDaily(value: unknown): PriceHistoryDailyV1 {
	if (!record(value) || value.version !== 1 || !text(value.vaultId) || !positiveInteger(value.itemId)
		|| !utcDay(value.dayUtc) || !nonNegativeInteger(value.snapshotCount)
		|| !nonNegativeInteger(value.partialSnapshotCount) || value.partialSnapshotCount > value.snapshotCount
		|| !dailySide(value.bid) || !dailySide(value.ask)) throw new PriceHistoryStoreError('corrupt');
	return structuredClone(value) as unknown as PriceHistoryDailyV1;
}

function parseWatchItem(value: unknown): PriceHistoryWatchItemV1 {
	if (!record(value) || value.version !== 1 || !text(value.vaultId) || !positiveInteger(value.itemId)
		|| typeof value.seed !== 'boolean' || !nonNegativeInteger(value.lastObservedAtMs)) throw new PriceHistoryStoreError('corrupt');
	return structuredClone(value) as unknown as PriceHistoryWatchItemV1;
}

function dailySide(value: unknown): boolean {
	return value === null || (record(value) && positiveInteger(value.count) && nonNegativeInteger(value.minCopper)
		&& nonNegativeInteger(value.maxCopper) && nonNegativeInteger(value.medianCopperX2)
		&& nonNegativeInteger(value.closeCopper) && nonNegativeInteger(value.closeCapturedAtMs)
		&& value.minCopper <= value.maxCopper);
}

function storeFailure(error: DOMException | null): PriceHistoryStoreError {
	return new PriceHistoryStoreError(error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable');
}

function nullableCopper(value: unknown): boolean { return value === null || nonNegativeInteger(value); }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function utcDay(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)); }
function ascending(values: number[]): boolean { return values.every((value, index) => index === 0 || values[index - 1]! < value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
