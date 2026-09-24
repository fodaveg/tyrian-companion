import {
	priceHistoryDayUtc,
	type PriceHistoryDailySideV1,
	type PriceHistoryDailyV1,
	type PriceHistorySide,
	type PriceHistorySnapshotV1,
} from './price-history-model';

interface TimedCopper { value: number; capturedAtMs: number; slotStartMs: number }

interface MutableDailyAggregate {
	vaultId: string;
	itemId: number;
	dayUtc: string;
	snapshotCount: number;
	partialSnapshotCount: number;
	bid: TimedCopper[];
	ask: TimedCopper[];
}

/** Exact median: twice the median is integral for both odd and even sample counts. */
export function medianCopperX2(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const middle = Math.floor(values.length / 2);
	return values.length % 2 === 1
		? selectKth(values, middle) * 2
		: selectKth(values, middle - 1) + selectKth(values, middle);
}

/** Single pass over compact tuples and missing ids; partiality is attributed per item. */
export function buildPriceHistoryDailyAggregates(
	vaultId: string,
	snapshots: readonly PriceHistorySnapshotV1[],
): PriceHistoryDailyV1[] {
	const groups = new Map<string, MutableDailyAggregate>();
	for (const snapshot of snapshots) {
		const dayUtc = priceHistoryDayUtc(snapshot.capturedAtMs);
		for (const [itemId, bidCopper, askCopper] of snapshot.items) {
			const group = dailyGroup(groups, vaultId, itemId, dayUtc);
			group.snapshotCount += 1;
			if (bidCopper === null || askCopper === null) group.partialSnapshotCount += 1;
			if (bidCopper !== null) group.bid.push({ value: bidCopper, capturedAtMs: snapshot.capturedAtMs, slotStartMs: snapshot.slotStartMs });
			if (askCopper !== null) group.ask.push({ value: askCopper, capturedAtMs: snapshot.capturedAtMs, slotStartMs: snapshot.slotStartMs });
		}
		for (const itemId of snapshot.missingItemIds) {
			const group = dailyGroup(groups, vaultId, itemId, dayUtc);
			group.snapshotCount += 1;
			group.partialSnapshotCount += 1;
		}
	}
	return [...groups.values()].map((group) => ({
			version: 1,
			vaultId: group.vaultId,
			itemId: group.itemId,
			dayUtc: group.dayUtc,
			snapshotCount: group.snapshotCount,
			partialSnapshotCount: group.partialSnapshotCount,
			bid: aggregateSide(group.bid),
			ask: aggregateSide(group.ask),
		}));
}

export type PriceHistoryPercentileResult =
	| { status: 'ready'; percentile: number; coveredDays: number; valueCopper: number }
	| { status: 'insufficient_history'; coveredDays: number; requiredDays: number };

/**
 * Nearest-rank empirical percentile of `currentCopper` against locally observed UTC closes; it
 * never fills missing days.
 *
 * H18.2 (audit 2026-09-24 §3.A): the value being ranked is an explicit argument, today's own
 * quote, never "whatever the last historical close happens to be". Before this, a series that
 * ended 60 days ago had its last close ranked as if it were today's price. `daily` is the
 * REFERENCE only: the caller drops today's own day from it, so the reference and the observation
 * never double-count the same day. `coveredDays` counts the reference days plus the observation
 * itself, so a dense 42-day series that ends today still covers 42 days, exactly as before.
 */
export function calculatePriceHistoryPercentile(
	daily: readonly PriceHistoryDailyV1[],
	side: PriceHistorySide,
	windowDays: number,
	requiredDays: number,
	currentCopper: number,
): PriceHistoryPercentileResult {
	if (!Number.isSafeInteger(windowDays) || windowDays <= 0 || !Number.isSafeInteger(requiredDays) || requiredDays <= 0) {
		throw new RangeError('Price-history percentile window is invalid.');
	}
	if (!Number.isSafeInteger(currentCopper) || currentCopper < 0) {
		throw new RangeError('Price-history percentile observation is invalid.');
	}
	// The observation takes one of the window's days, so at most `windowDays - 1` reference days.
	const referenceDays = windowDays - 1;
	const reference = referenceDays === 0 ? [] : [...daily]
		.sort((left, right) => left.dayUtc.localeCompare(right.dayUtc))
		.slice(-referenceDays)
		.map((entry) => entry[side]?.closeCopper ?? null)
		.filter((value): value is number => value !== null);
	const points = [...reference, currentCopper];
	if (points.length < requiredDays) {
		return { status: 'insufficient_history', coveredDays: points.length, requiredDays };
	}
	const current = currentCopper;
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
	const copper = values.map(({ value }) => value);
	const median = medianCopperX2(copper);
	const close = values.reduce((latest, candidate) => candidate.capturedAtMs > latest.capturedAtMs
		|| (candidate.capturedAtMs === latest.capturedAtMs && candidate.slotStartMs > latest.slotStartMs) ? candidate : latest);
	return {
		count: values.length,
		minCopper: Math.min(...copper),
		maxCopper: Math.max(...copper),
		medianCopperX2: median!,
		closeCopper: close.value,
		closeCapturedAtMs: close.capturedAtMs,
	};
}

/** Deterministic median-of-medians selection keeps exact medians linear without sorting a day. */
function selectKth(values: readonly number[], index: number): number {
	if (values.length <= 5) return [...values].sort((left, right) => left - right)[index]!;
	const medians: number[] = [];
	for (let offset = 0; offset < values.length; offset += 5) {
		const group = values.slice(offset, offset + 5).sort((left, right) => left - right);
		medians.push(group[Math.floor(group.length / 2)]!);
	}
	const pivot = selectKth(medians, Math.floor(medians.length / 2));
	const lower: number[] = [];
	const equal: number[] = [];
	const higher: number[] = [];
	for (const value of values) {
		if (value < pivot) lower.push(value);
		else if (value > pivot) higher.push(value);
		else equal.push(value);
	}
	if (index < lower.length) return selectKth(lower, index);
	if (index < lower.length + equal.length) return pivot;
	return selectKth(higher, index - lower.length - equal.length);
}

function dailyGroup(
	groups: Map<string, MutableDailyAggregate>,
	vaultId: string,
	itemId: number,
	dayUtc: string,
): MutableDailyAggregate {
	const key = `${String(itemId)}:${dayUtc}`;
	const existing = groups.get(key);
	if (existing !== undefined) return existing;
	const created: MutableDailyAggregate = {
		vaultId, itemId, dayUtc, snapshotCount: 0, partialSnapshotCount: 0, bid: [], ask: [],
	};
	groups.set(key, created);
	return created;
}
