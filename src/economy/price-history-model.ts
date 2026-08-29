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
