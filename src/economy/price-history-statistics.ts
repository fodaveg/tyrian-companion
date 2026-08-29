import {
	priceHistoryDayUtc,
	type PriceHistoryDailySideV1,
	type PriceHistoryDailyV1,
	type PriceHistorySide,
	type PriceHistorySnapshotV1,
} from './price-history-model';

interface TimedCopper { value: number; capturedAtMs: number }

/** Exact median: twice the median is integral for both odd and even sample counts. */
export function medianCopperX2(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 1
		? ordered[middle]! * 2
		: ordered[middle - 1]! + ordered[middle]!;
}

/** Rebuilds one UTC day from raw snapshots. Gaps and null sides remain absent evidence. */
export function aggregatePriceHistoryDay(
	vaultId: string,
	itemId: number,
	dayUtc: string,
	snapshots: readonly PriceHistorySnapshotV1[],
): PriceHistoryDailyV1 {
	const day = snapshots.filter((snapshot) => priceHistoryDayUtc(snapshot.capturedAtMs) === dayUtc)
		.sort((left, right) => left.capturedAtMs - right.capturedAtMs || left.slotStartMs - right.slotStartMs);
	const bid: TimedCopper[] = [];
	const ask: TimedCopper[] = [];
	for (const snapshot of day) {
		const tuple = snapshot.items.find(([candidate]) => candidate === itemId);
		if (tuple?.[1] !== null && tuple?.[1] !== undefined) bid.push({ value: tuple[1], capturedAtMs: snapshot.capturedAtMs });
		if (tuple?.[2] !== null && tuple?.[2] !== undefined) ask.push({ value: tuple[2], capturedAtMs: snapshot.capturedAtMs });
	}
	return {
		version: 1,
		vaultId,
		itemId,
		dayUtc,
		snapshotCount: day.length,
		partialSnapshotCount: day.filter((snapshot) => snapshot.status === 'partial').length,
		bid: aggregateSide(bid),
		ask: aggregateSide(ask),
	};
}

export type PriceHistoryPercentileResult =
	| { status: 'ready'; percentile: number; coveredDays: number; valueCopper: number }
	| { status: 'insufficient_history'; coveredDays: number; requiredDays: number };

/** Nearest-rank empirical percentile over locally observed UTC closes; it never fills missing days. */
export function calculatePriceHistoryPercentile(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	windowDays: number,
	requiredDays = 42,
): PriceHistoryPercentileResult {
	if (!Number.isSafeInteger(windowDays) || windowDays <= 0 || !Number.isSafeInteger(requiredDays) || requiredDays <= 0) {
		throw new RangeError('Price-history percentile window is invalid.');
	}
	const points = [...daily]
		.sort((left, right) => left.dayUtc.localeCompare(right.dayUtc))
		.slice(-windowDays)
		.map((entry) => entry[side]?.closeCopper ?? null)
		.filter((value): value is number => value !== null);
	if (points.length < requiredDays) {
		return { status: 'insufficient_history', coveredDays: points.length, requiredDays };
	}
	const current = points.at(-1)!;
	const atOrBelow = points.filter((value) => value <= current).length;
	return {
		status: 'ready',
		percentile: Math.round((atOrBelow / points.length) * 10_000) / 100,
		coveredDays: points.length,
		valueCopper: current,
	};
}

function aggregateSide(values: readonly TimedCopper[]): PriceHistoryDailySideV1 | null {
	if (values.length === 0) return null;
	const median = medianCopperX2(values.map(({ value }) => value));
	const close = values.at(-1)!;
	return {
		count: values.length,
		minCopper: Math.min(...values.map(({ value }) => value)),
		maxCopper: Math.max(...values.map(({ value }) => value)),
		medianCopperX2: median!,
		closeCopper: close.value,
		closeCapturedAtMs: close.capturedAtMs,
	};
}
