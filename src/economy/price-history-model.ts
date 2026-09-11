export const PRICE_HISTORY_DB_NAME = 'tyrian-companion-price-history';
export const PRICE_HISTORY_DB_VERSION = 1;
export const PRICE_HISTORY_SNAPSHOT_STORE = 'snapshots-v1';
export const PRICE_HISTORY_DAILY_STORE = 'daily-v1';
export const PRICE_HISTORY_WATCH_STORE = 'watch-v1';
export const PRICE_HISTORY_META_STORE = 'meta-v1';

export const PRICE_HISTORY_SEED_ITEM_IDS = Object.freeze([36_038, 36_041, 105_402, 48_715, 73_474]);
export const PRICE_HISTORY_MAX_WATCH_ITEMS = 400;
export const PRICE_HISTORY_MAX_BATCH_SIZE = 200;

export type PriceHistoryIntervalMinutes = 5 | 15 | 30 | 60;
export type PriceHistoryRawRetentionDays = 2 | 7 | 14 | 30;
export type PriceHistoryDailyRetentionDays = 42 | 90 | 180 | 365;
export type PriceHistoryWindowDays = 42 | 90 | 180;
export type PriceHistorySide = 'bid' | 'ask';
export type PriceHistoryCaptureStatus = 'complete' | 'partial';

export interface PriceHistorySettings {
	enabled: boolean;
	intervalMinutes: PriceHistoryIntervalMinutes;
	rawRetentionDays: PriceHistoryRawRetentionDays;
	dailyRetentionDays: PriceHistoryDailyRetentionDays;
}

export type PriceHistoryTuple = Readonly<[itemId: number, bidCopper: number | null, askCopper: number | null]>;

export interface PriceHistorySnapshotV1 {
	version: 1;
	vaultId: string;
	slotStartMs: number;
	capturedAtMs: number;
	intervalMs: number;
	status: PriceHistoryCaptureStatus;
	items: PriceHistoryTuple[];
	missingItemIds: number[];
}

export interface PriceHistoryDailySideV1 {
	count: number;
	minCopper: number;
	maxCopper: number;
	medianCopperX2: number;
	closeCopper: number;
	closeCapturedAtMs: number;
}

export interface PriceHistoryDailyV1 {
	version: 1;
	vaultId: string;
	itemId: number;
	dayUtc: string;
	snapshotCount: number;
	partialSnapshotCount: number;
	bid: PriceHistoryDailySideV1 | null;
	ask: PriceHistoryDailySideV1 | null;
}

export interface PriceHistoryWatchItemV1 {
	version: 1;
	vaultId: string;
	itemId: number;
	seed: boolean;
	/**
	 * True while an inventory-driven sync (SPEC-recomendacion-por-objeto.md, decision 3, M2) is the
	 * reason this item is watched. Absent on rows written before M2, which `parseWatchItem` reads as
	 * `false`: an older row is exactly a session-observed one, since the derived slice did not exist
	 * yet to have written it.
	 */
	derived: boolean;
	lastObservedAtMs: number;
}

export interface PriceHistoryCaptureLeaseV1 {
	version: 1;
	vaultId: string;
	slotStartMs: number;
	ownerId: string;
	leaseId: string;
	fence: number;
	expiresAtMs: number;
}

export const DEFAULT_PRICE_HISTORY_SETTINGS: Readonly<PriceHistorySettings> = Object.freeze({
	enabled: false,
	intervalMinutes: 15,
	rawRetentionDays: 7,
	dailyRetentionDays: 180,
});

export function priceHistorySlotStart(nowMs: number, intervalMs: number): number {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
		throw new RangeError('Price-history slot arguments are invalid.');
	}
	return Math.floor(nowMs / intervalMs) * intervalMs;
}

export function priceHistoryDayUtc(nowMs: number): string {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('Price-history timestamp is invalid.');
	return new Date(nowMs).toISOString().slice(0, 10);
}

export function normalizePriceHistoryItemIds(values: readonly number[], maximum = PRICE_HISTORY_MAX_WATCH_ITEMS): number[] {
	if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError('Price-history item maximum is invalid.');
	const result = [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))]
		.sort((left, right) => left - right);
	return result.slice(0, maximum);
}

export function priceHistoryIntervalMs(minutes: PriceHistoryIntervalMinutes): number {
	return minutes * 60_000;
}

/**
 * The "derived from inventory capital" slice of the watch list (SPEC-recomendacion-por-objeto.md,
 * decision 3, M2): every durable position whose demonstrated instant-sell value clears the
 * recommendation capital threshold, capped at `maxItems` by capital descending. Several rows can
 * share one item (different characters or containers), so their demonstrated capital is summed
 * rather than the last row seen winning; ties break by item id so the result is deterministic.
 *
 * Pure and side-effect free on purpose: the ranking and the cap are testable without IndexedDB, and
 * `IndexedDbPriceHistoryStore.applyDerivedWatchList` (price-history-store.ts) only ever writes what
 * this returns.
 */
export function selectDerivedWatchListItemIds(
	positions: readonly { itemId: number; totalSellCopper: number | null }[],
	capitalThresholdCopper: number,
	maxItems = PRICE_HISTORY_MAX_WATCH_ITEMS,
): number[] {
	if (!Number.isSafeInteger(maxItems) || maxItems <= 0) throw new RangeError('Derived watch list maximum is invalid.');
	const capitalByItem = new Map<number, number>();
	for (const position of positions) {
		if (!Number.isSafeInteger(position.itemId) || position.itemId <= 0) continue;
		if (position.totalSellCopper === null || !Number.isSafeInteger(position.totalSellCopper) || position.totalSellCopper < 0) continue;
		capitalByItem.set(position.itemId, (capitalByItem.get(position.itemId) ?? 0) + position.totalSellCopper);
	}
	return [...capitalByItem.entries()]
		.filter(([, capitalCopper]) => capitalCopper >= capitalThresholdCopper)
		.sort(([leftId, leftCopper], [rightId, rightCopper]) => rightCopper - leftCopper || leftId - rightId)
		.slice(0, maxItems)
		.map(([itemId]) => itemId);
}
