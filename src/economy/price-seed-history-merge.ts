import type { PriceHistoryDailySideV1, PriceHistoryDailyV1 } from './price-history-model';
import type { PriceSeedDayV1, PriceSeedV1 } from './price-seed-model';
import { unionByDayLocalWins } from './sell-signal';

/**
 * Combines this item's own captured daily series with its cached datawars2 seed, for
 * `recommendPosition`'s sake (SPEC-recomendacion-por-objeto.md, decision 4, M2).
 *
 * Before this existed, `InventoryVaultCaptureService.capture` fed `recommendPosition` only the
 * plugin's own capture: a seed cached by `PriceSeedBulkRefreshService` for a brand-new watch-list
 * item sat in `tyrian-companion-price-seed-cache` and was never read, so the item stayed
 * `review`/`price_history_insufficient` until 42 days of the plugin's OWN captures accumulated —
 * exactly the wait decision 4 exists to avoid.
 *
 * Same precedence `mergeSellSignalSeries` (`sell-signal.ts`) uses for the H13.2 sell-signal
 * series: the plugin's own capture wins over the seed for any day both cover (`unionByDayLocalWins`),
 * and neither side invents a day the other is missing. A seed-only day becomes a synthetic
 * `PriceHistoryDailyV1` entry so `calculatePriceHistoryPercentile` can read its `bid.closeCopper`
 * exactly like a captured one; every other field on that entry is a single-sample placeholder
 * (`count: 1`), since a seed day is one datawars2 aggregate, not several vault snapshots.
 *
 * Read-only and pure: no network, no IndexedDB. The seed itself is looked up by the caller
 * (`InventoryPositionRecommendationPort.readCachedSeed`); this module never downloads or caches
 * one, which is why it stays outside the `inventory-position-recommendation.ts` boundary that
 * `inventory-advisor-architecture.test.ts` polices without needing to be added to it.
 */
export function mergePriceHistoryWithSeed(
	itemId: number,
	daily: readonly PriceHistoryDailyV1[],
	seed: PriceSeedV1 | null,
): PriceHistoryDailyV1[] {
	const captured = new Map(daily.filter((entry) => entry.itemId === itemId).map((entry) => [entry.dayUtc, entry] as const));
	if (seed === null || seed.itemId !== itemId || seed.days.length === 0) return [...captured.values()];
	// `vaultId` is carried only because `PriceHistoryDailyV1` requires it; nothing downstream of
	// this merge (`calculatePriceHistoryPercentile`, `filterByCalendarWindow`) ever reads it. Reused
	// from an existing captured entry when there is one, so a synthesized day is not visibly
	// foreign to whichever vault actually captured its neighbours.
	const vaultId = captured.values().next().value?.vaultId ?? '';
	const seeded = new Map(seed.days.map((day) => [day.dayUtc, seedHistoryEntry(vaultId, itemId, day)] as const));
	return [...unionByDayLocalWins(seeded, captured).values()];
}

function seedHistoryEntry(vaultId: string, itemId: number, day: PriceSeedDayV1): PriceHistoryDailyV1 {
	return {
		version: 1,
		vaultId,
		itemId,
		dayUtc: day.dayUtc,
		snapshotCount: 0,
		partialSnapshotCount: 0,
		bid: singleSampleSide(day.bidCopper),
		ask: day.askCopper === null ? null : singleSampleSide(day.askCopper),
	};
}

function singleSampleSide(copper: number): PriceHistoryDailySideV1 {
	return { count: 1, minCopper: copper, maxCopper: copper, medianCopperX2: copper * 2, closeCopper: copper, closeCapturedAtMs: 0 };
}
