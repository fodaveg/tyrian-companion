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
import { buildPriceHistoryDailyAggregates } from './price-history-statistics';

const DAY_MS = 86_400_000;
const COMPACTION_READY_KEY = 'compaction:v1:ready';
const COMPACTION_DIRTY_PREFIX = 'compaction:v1:dirty:';

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
	compactedDays: number;
	peakSnapshotsPerDay: number;
	peakSnapshotTuplesPerDay: number;
}

interface PriceHistoryDirtyDayMetaV1 {
	version: 1;
	vaultId: string;
	key: string;
	dayUtc: string;
}

interface PriceHistoryCompactionDayResult {
	dailyRecords: number;
	snapshotCount: number;
	snapshotTupleCount: number;
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
							meta.put(dirtyDayMeta(lease.vaultId, priceHistoryDayUtc(snapshot.capturedAtMs)));
							meta.delete([lease.vaultId, key]);
							transaction.oncomplete = () => resolve({ status: 'committed', snapshot: structuredClone(snapshot) });
						} catch (error) { reject(error); transaction.abort(); }
					};
				} catch (error) { reject(error); transaction.abort(); }
			};
		});
	}

	readSnapshots(vaultId: string, fromCapturedAtMs = 0): Promise<PriceHistorySnapshotV1[]> {
		return this.readCursorAll(
			PRICE_HISTORY_SNAPSHOT_STORE,
			keyRangeForVault(vaultId),
			parseSnapshot,
		).then((snapshots) => snapshots.filter(({ capturedAtMs }) => capturedAtMs >= fromCapturedAtMs)
			.sort((left, right) => left.capturedAtMs - right.capturedAtMs));
	}

	readDaily(vaultId: string, itemId: number, fromDayUtc: string): Promise<PriceHistoryDailyV1[]> {
		return this.readIndexAll(
			PRICE_HISTORY_DAILY_STORE,
			'by-vault-item-day',
			IDBKeyRange.bound([vaultId, itemId, fromDayUtc], [vaultId, itemId, '\uffff']),
			parseDaily,
		).then((daily) => daily.sort((left, right) => left.dayUtc.localeCompare(right.dayUtc)));
	}

	/** Compacts dirty UTC days independently, then prunes with cursors to keep peak memory day-bounded. */
	async compactAndPrune(
		vaultId: string,
		nowMs: number,
		rawRetentionDays: number,
		dailyRetentionDays: number,
	): Promise<PriceHistoryCompactionResult> {
		const rawCutoffDay = priceHistoryDayUtc(Math.max(0, nowMs - rawRetentionDays * DAY_MS));
		const dailyCutoff = priceHistoryDayUtc(Math.max(0, nowMs - dailyRetentionDays * DAY_MS));
		await this.ensureIncrementalCompactionMarkers(vaultId);
		let dailyRecords = 0;
		let compactedDays = 0;
		let peakSnapshotsPerDay = 0;
		let peakSnapshotTuplesPerDay = 0;
		for (let dayUtc = await this.nextDirtyDay(vaultId); dayUtc !== null; dayUtc = await this.nextDirtyDay(vaultId)) {
			const result = await this.compactDirtyDay(vaultId, dayUtc, dailyCutoff);
			dailyRecords += result.dailyRecords;
			compactedDays += 1;
			peakSnapshotsPerDay = Math.max(peakSnapshotsPerDay, result.snapshotCount);
			peakSnapshotTuplesPerDay = Math.max(peakSnapshotTuplesPerDay, result.snapshotTupleCount);
		}
		const prunedSnapshots = await this.pruneSnapshotsBefore(vaultId, dayStartMs(rawCutoffDay));
		const prunedDaily = await this.pruneDailyBefore(vaultId, dailyCutoff);
		return { dailyRecords, prunedSnapshots, prunedDaily, compactedDays, peakSnapshotsPerDay, peakSnapshotTuplesPerDay };
	}

	private ensureIncrementalCompactionMarkers(vaultId: string): Promise<void> {
		return this.transaction([PRICE_HISTORY_SNAPSHOT_STORE, PRICE_HISTORY_META_STORE], 'readwrite', (transaction, resolve, reject) => {
			const snapshotsStore = transaction.objectStore(PRICE_HISTORY_SNAPSHOT_STORE);
			const metaStore = transaction.objectStore(PRICE_HISTORY_META_STORE);
			const readyRequest = metaStore.get([vaultId, COMPACTION_READY_KEY]);
			readyRequest.onerror = () => reject(storeFailure(readyRequest.error));
			readyRequest.onsuccess = () => {
				if (readyRequest.result !== undefined) {
					try { parseCompactionReadyMeta(readyRequest.result, vaultId); }
					catch (error) { reject(error); transaction.abort(); return; }
					transaction.oncomplete = () => resolve(undefined);
					return;
				}
				let lastDayUtc: string | null = null;
				const cursorRequest = snapshotsStore.openCursor(keyRangeForVault(vaultId));
				cursorRequest.onerror = () => reject(storeFailure(cursorRequest.error));
				cursorRequest.onsuccess = () => {
					const cursor = cursorRequest.result;
					if (cursor === null) {
						metaStore.put({ version: 1, vaultId, key: COMPACTION_READY_KEY });
						transaction.oncomplete = () => resolve(undefined);
						return;
					}
				try {
					const snapshot = parseSnapshot(cursor.value);
					const dayUtc = priceHistoryDayUtc(snapshot.capturedAtMs);
					if (dayUtc !== lastDayUtc) metaStore.put(dirtyDayMeta(vaultId, dayUtc));
					lastDayUtc = dayUtc;
					cursor.continue();
				} catch (error) { reject(error); transaction.abort(); }
			};
			};
		});
	}

	private nextDirtyDay(vaultId: string): Promise<string | null> {
		return this.transaction([PRICE_HISTORY_META_STORE], 'readonly', (transaction, resolve, reject) => {
			const request = transaction.objectStore(PRICE_HISTORY_META_STORE).openCursor(dirtyDayRange(vaultId));
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				try {
					const dayUtc = request.result === null ? null : parseDirtyDayMeta(request.result.value, vaultId).dayUtc;
					transaction.oncomplete = () => resolve(dayUtc);
				} catch (error) { reject(error); transaction.abort(); }
			};
		});
	}

	private compactDirtyDay(vaultId: string, dayUtc: string, dailyCutoff: string): Promise<PriceHistoryCompactionDayResult> {
		return this.transaction(
			[PRICE_HISTORY_SNAPSHOT_STORE, PRICE_HISTORY_DAILY_STORE, PRICE_HISTORY_META_STORE],
			'readwrite',
			(transaction, resolve, reject) => {
				const snapshotsStore = transaction.objectStore(PRICE_HISTORY_SNAPSHOT_STORE);
				const dailyStore = transaction.objectStore(PRICE_HISTORY_DAILY_STORE);
				const metaStore = transaction.objectStore(PRICE_HISTORY_META_STORE);
				const startMs = dayStartMs(dayUtc);
				const snapshotRequest = snapshotsStore.index('by-vault-captured').getAll(capturedRange(vaultId, startMs, startMs + DAY_MS));
				const dailyRequest = dailyStore.index('by-vault-day').getAll(IDBKeyRange.only([vaultId, dayUtc]));
				let raw: PriceHistorySnapshotV1[] | null = null;
				let existingDaily: PriceHistoryDailyV1[] | null = null;
				const continueWhenReady = (): void => {
					if (raw === null || existingDaily === null) return;
					try {
						const existingByKey = new Map(existingDaily.map((entry) => [dailyKey(entry.itemId, entry.dayUtc), entry]));
						let dailyRecords = 0;
						if (dayUtc >= dailyCutoff) for (const aggregate of buildPriceHistoryDailyAggregates(vaultId, raw)) {
							if (!sameDaily(existingByKey.get(dailyKey(aggregate.itemId, aggregate.dayUtc)), aggregate)) {
								dailyStore.put(aggregate);
								dailyRecords += 1;
							}
						}
						metaStore.delete([vaultId, dirtyDayKey(dayUtc)]);
						const snapshotTupleCount = raw.reduce((sum, snapshot) => sum + snapshot.items.length + snapshot.missingItemIds.length, 0);
						transaction.oncomplete = () => resolve({ dailyRecords, snapshotCount: raw!.length, snapshotTupleCount });
					} catch (error) { reject(error); transaction.abort(); }
				};
				snapshotRequest.onerror = () => reject(storeFailure(snapshotRequest.error));
				snapshotRequest.onsuccess = () => {
					try { raw = snapshotRequest.result.map(parseSnapshot); continueWhenReady(); }
					catch (error) { reject(error); transaction.abort(); }
				};
				dailyRequest.onerror = () => reject(storeFailure(dailyRequest.error));
				dailyRequest.onsuccess = () => {
					try { existingDaily = dailyRequest.result.map(parseDaily); continueWhenReady(); }
					catch (error) { reject(error); transaction.abort(); }
				};
			},
		);
	}

	private pruneSnapshotsBefore(vaultId: string, beforeMs: number): Promise<number> {
		if (beforeMs <= 0) return Promise.resolve(0);
		return this.pruneByCursor(
			PRICE_HISTORY_SNAPSHOT_STORE,
			'by-vault-captured',
			capturedRange(vaultId, 0, beforeMs),
			parseSnapshot,
		);
	}

	private pruneDailyBefore(vaultId: string, beforeDayUtc: string): Promise<number> {
		return this.pruneByCursor(
			PRICE_HISTORY_DAILY_STORE,
			'by-vault-day',
			IDBKeyRange.bound([vaultId, ''], [vaultId, beforeDayUtc], false, true),
			parseDaily,
		);
	}

	private pruneByCursor(
		storeName: string,
		indexName: string,
		range: IDBKeyRange,
		parse: (value: unknown) => unknown,
	): Promise<number> {
		return this.transaction([storeName], 'readwrite', (transaction, resolve, reject) => {
			let deleted = 0;
			const request = transaction.objectStore(storeName).index(indexName).openCursor(range);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor === null) { transaction.oncomplete = () => resolve(deleted); return; }
				try { parse(cursor.value); cursor.delete(); deleted += 1; cursor.continue(); }
				catch (error) { reject(error); transaction.abort(); }
			};
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

	private readIndexAll<T>(storeName: string, indexName: string, range: IDBKeyRange, parse: (value: unknown) => T): Promise<T[]> {
		return this.transaction([storeName], 'readonly', (transaction, resolve, reject) => {
			const request = transaction.objectStore(storeName).index(indexName).getAll(range);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				try {
					const result = request.result.map(parse);
					transaction.oncomplete = () => resolve(result);
				} catch (error) { reject(error); transaction.abort(); }
			};
		});
	}

	private readCursorAll<T>(storeName: string, range: IDBKeyRange, parse: (value: unknown) => T): Promise<T[]> {
		return this.transaction([storeName], 'readonly', (transaction, resolve, reject) => {
			const result: T[] = [];
			const request = transaction.objectStore(storeName).openCursor(range);
			request.onerror = () => reject(storeFailure(request.error));
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor === null) { transaction.oncomplete = () => resolve(result); return; }
				try { result.push(parse(cursor.value)); cursor.continue(); }
				catch (error) { reject(error); transaction.abort(); }
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

function capturedRange(vaultId: string, fromMs: number, toMs: number): IDBKeyRange {
	return IDBKeyRange.bound([vaultId, fromMs], [vaultId, toMs], false, true);
}

function dayStartMs(dayUtc: string): number {
	const startMs = Date.parse(`${dayUtc}T00:00:00.000Z`);
	if (!Number.isSafeInteger(startMs) || startMs < 0) throw new PriceHistoryStoreError('corrupt');
	return startMs;
}

function dirtyDayKey(dayUtc: string): string { return `${COMPACTION_DIRTY_PREFIX}${dayUtc}`; }

function dirtyDayMeta(vaultId: string, dayUtc: string): PriceHistoryDirtyDayMetaV1 {
	return { version: 1, vaultId, key: dirtyDayKey(dayUtc), dayUtc };
}

function dirtyDayRange(vaultId: string): IDBKeyRange {
	return IDBKeyRange.bound([vaultId, COMPACTION_DIRTY_PREFIX], [vaultId, `${COMPACTION_DIRTY_PREFIX}\uffff`]);
}

function parseDirtyDayMeta(value: unknown, vaultId: string): PriceHistoryDirtyDayMetaV1 {
	if (!record(value) || value.version !== 1 || value.vaultId !== vaultId || !utcDay(value.dayUtc)
		|| value.key !== dirtyDayKey(value.dayUtc)) throw new PriceHistoryStoreError('corrupt');
	return value as unknown as PriceHistoryDirtyDayMetaV1;
}

function parseCompactionReadyMeta(value: unknown, vaultId: string): void {
	if (!record(value) || value.version !== 1 || value.vaultId !== vaultId || value.key !== COMPACTION_READY_KEY) {
		throw new PriceHistoryStoreError('corrupt');
	}
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
	const incompleteSides = items.some((entry) => (entry as unknown[])[1] === null || (entry as unknown[])[2] === null);
	if (!ascending(itemIds) || !ascending(missing) || itemIds.some((id) => missing.includes(id))
		|| (value.status === 'complete' && (missing.length > 0 || incompleteSides))
		|| (value.status === 'partial' && missing.length === 0 && !incompleteSides)) throw new PriceHistoryStoreError('corrupt');
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

function dailyKey(itemId: number, dayUtc: string): string { return `${String(itemId)}:${dayUtc}`; }

function sameDaily(left: PriceHistoryDailyV1 | undefined, right: PriceHistoryDailyV1): boolean {
	return left !== undefined
		&& left.version === right.version && left.vaultId === right.vaultId && left.itemId === right.itemId
		&& left.dayUtc === right.dayUtc && left.snapshotCount === right.snapshotCount
		&& left.partialSnapshotCount === right.partialSnapshotCount
		&& sameSide(left.bid, right.bid) && sameSide(left.ask, right.ask);
}

function sameSide(left: PriceHistoryDailyV1['bid'], right: PriceHistoryDailyV1['bid']): boolean {
	return left === null ? right === null : right !== null
		&& left.count === right.count && left.minCopper === right.minCopper && left.maxCopper === right.maxCopper
		&& left.medianCopperX2 === right.medianCopperX2 && left.closeCopper === right.closeCopper
		&& left.closeCapturedAtMs === right.closeCapturedAtMs;
}
