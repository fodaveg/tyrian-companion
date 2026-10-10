/**
 * Sale tab helpers that read no runtime state (DE-01, step 1): the curated festival anchors, the
 * calendar window lookups and the advisor-row mappers the Sale view and `TyrianCompanionCore` share.
 * Moved here unchanged from `tyrian-companion-core.ts`, which re-exports the public ones. Step 2
 * added the curated bundle's fallback price age and live expiry, which `SaleRuntime` and the core
 * both read.
 */
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import {
	inventoryAdvisorBuiltinBundleProvider,
	INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL,
	type InventoryAdvisorBuiltinBundleProvider,
} from '../advisor/inventory-advisor-builtin-bundle';
import {
	POSITION_RECOMMENDATION_REASON_CODES,
	type PositionRecommendationReasonCode,
	type PositionRecommendationSeasonalInput,
} from '../advisor/inventory-position-recommendation';
import { priceHistoryDayUtc } from '../economy/price-history-model';
import { HALLOWEEN_FESTIVAL_ANCHORS } from '../economy/models/halloween-festival-anchors';
import {
	festivalAnchorStartMs,
	festivalCalendarEntryForItem,
	resolveFestivalCalendarWindow,
	type FestivalAnchorsTableV1,
	type FestivalCalendarCandidateV1,
} from '../economy/seasonal-window';
import type { InventoryAdvisorViewRow } from '../ui/inventory-advisor-view-model';
import type { SaleSourceDecision, SaleSourceRow } from '../ui/sale-view-model';

/**
 * H18.20: every curated festival this plugin anchors a selling window to, keyed by `festivalId`.
 * Only Halloween is curated today; a second festival is a second entry here, not a new mechanism.
 */
export const FESTIVAL_ANCHORS: ReadonlyMap<string, FestivalAnchorsTableV1> = new Map([
	[HALLOWEEN_FESTIVAL_ANCHORS.festivalId, HALLOWEEN_FESTIVAL_ANCHORS],
]);

const SALE_DAY_MS = 86_400_000;

/**
 * One calendar candidate resolved to this cycle's concrete `YYYY-MM-DD` span, for the Sale
 * tab's own calendar section — distinct from `resolveFestivalCalendarWindow` above, which picks the
 * ONE window that currently governs a position's recommendation; the calendar shows every candidate
 * an item carries (the Saco's "before the festival" AND its May window), never only the governing one.
 *
 * Product decision (coordinator, round 2, 26 sep 2026): an `annual` candidate (e.g. Jorcamelo's
 * plain June window, unrelated to any festival anchor — `inventory-advisor-builtin-bundle.ts`'s own
 * §5 audit verdict) that has already fully closed THIS year rolls to the SAME interval next year,
 * never a guessed date: the window's own `opensOn`/`closesOn` are real, curated data, only the YEAR
 * advances by exactly one. Does not handle a window that wraps the year boundary (`closesOn` before
 * `opensOn`, e.g. Dec-Jan): no candidate in the curated calendar needs that today.
 */
export function resolveSaleCalendarCandidateSpan(
	candidate: FestivalCalendarCandidateV1,
	anchors: ReadonlyMap<string, FestivalAnchorsTableV1>,
	nowMs: number,
): { fromDay: string; toDay: string } | null {
	const year = new Date(nowMs).getUTCFullYear();
	if (candidate.kind === 'annual') {
		const todayUtc = priceHistoryDayUtc(nowMs);
		const closesThisYear = `${String(year)}-${candidate.window.closesOn}`;
		const resolvedYear = closesThisYear < todayUtc ? year + 1 : year;
		return { fromDay: `${String(resolvedYear)}-${candidate.window.opensOn}`, toDay: `${String(resolvedYear)}-${candidate.window.closesOn}` };
	}
	const table = anchors.get(candidate.window.festivalId);
	if (table === undefined) return null;
	const startMs = festivalAnchorStartMs(table, year);
	if (startMs === null) return null;
	return {
		fromDay: priceHistoryDayUtc(startMs + candidate.window.opensOffsetDays * SALE_DAY_MS),
		toDay: priceHistoryDayUtc(startMs + candidate.window.closesOffsetDays * SALE_DAY_MS),
	};
}

/**
 * Rule (b), M3: `itemId`'s calendar window plus the pack's shared sellSignal parameters, or null
 * (rule (c)) when it has no entry or the pack is unavailable. Shared by `setupProductActions`'s own
 * `InventoryAnalysisService` port (the regular rows) and `refreshSaleHeroTiming` below (the Saco's
 * hero card): one calendar lookup, not two.
 */
export function resolveSaleSeasonalInputFor(itemId: number, asOfMs: number): PositionRecommendationSeasonalInput | null {
	const asOf = new Date(asOfMs);
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(asOf.toISOString());
	if (loaded.status !== 'available') return null;
	const entry = festivalCalendarEntryForItem(loaded.bundle.festivalCalendar, itemId);
	if (entry === null) return null;
	// H18.20: an item can carry several candidate windows (e.g. "before the festival" anchored to
	// its real start, plus a plain annual one); this picks whichever governs `asOf`, or returns
	// null when the only applicable candidate needs a festival year this build has no anchor for
	// (declared lack of coverage, never a guessed date).
	const window = resolveFestivalCalendarWindow(entry, FESTIVAL_ANCHORS, asOfMs);
	if (window === null) return null;
	return {
		window,
		...(entry.candidates.every((candidate) => candidate.kind === 'annual') ? { annualWaitWindow: window } : {}),
		parameters: {
			minimumOfMaxBps: loaded.bundle.economyPack.sellSignal.minimumOfMaxBps,
			referenceDays: loaded.bundle.economyPack.sellSignal.referenceDays,
			minimumReferenceDays: loaded.bundle.economyPack.sellSignal.minimumReferenceDays,
		},
	};
}

const POSITION_RECOMMENDATION_REASON_SET: ReadonlySet<string> = new Set(POSITION_RECOMMENDATION_REASON_CODES);

/**
 * `decideInventoryObjectRoute` (`inventory-object-result.ts`) only keeps `recommendPosition`'s own
 * timing when the advisor's route is `sell` or `list`; every other route (open, vendor, salvage,
 * use, deposit, keep, review, discard review) stands with the ADVISOR's own reason instead
 * (`InventoryAdvisorReasonCode`, a different closed set). Checking membership in the moment stage's
 * own set, rather than trusting the wider `action` union, is what keeps a row whose route pre-empted
 * the timing from reaching `inventory.decision.reason.*` with a key that catalog does not have.
 */
function isPositionRecommendationReasonCode(value: string): value is PositionRecommendationReasonCode {
	return POSITION_RECOMMENDATION_REASON_SET.has(value);
}

/** Counts whole loose stacks in the selected bags, preserving reservations and physical placement. */
export function saleBagSlotsUsed(row: Pick<InventoryAdvisorViewRow, 'allocations'>, snapshot: StorageSnapshot | null, character: string | null): number | null {
	if (snapshot === null || character === null) return null;
	const cleared = new Set<number>();
	for (const allocation of row.allocations) {
		const match = /^#\/positions\/(\d+)\/(\d+)$/u.exec(allocation.positionRef);
		if (match === null) continue;
		const index = Number(match[2]);
		const holding = snapshot.holdings[index];
		if (holding?.itemId === Number(match[1]) && holding.state === 'loose' && holding.quantity === allocation.quantity
			&& holding.location.source === 'character' && holding.location.container === 'bag'
			&& holding.location.character === character) cleared.add(index);
	}
	return cleared.size;
}

/**
 * One advisor row turned into the Sale tab's own input shape.
 *
 * `hold_for_legendary` and every route other than `sell`/`list` become no decision at all (ficha
 * decision 2 and the doc comment above): a position reserved for a legendary goal, or one whose
 * route already decided something other than a market sale, has nothing this tab can time. It
 * shows as "sin datos" rather than guessing, and (ficha decision 3) still gets the low-space
 * "depositar" override in `buildSaleViewModel` when it is a bankable material.
 *
 * Instant-sale totals reuse the same depth-aware position valuation as Inventory/Base. A live
 * unit bid alone cannot establish the proceeds for a whole stack; unknown depth remains unknown.
 */
export function saleSourceRowFromAdvisorRow(row: InventoryAdvisorViewRow, bidCopper: number | null): SaleSourceRow {
	const decision = row.decision ?? null;
	const timed: SaleSourceDecision | null = decision === null ? null
		: decision.action !== 'sell' && decision.action !== 'hold' && decision.action !== 'sell_at_season' && decision.action !== 'review' ? null
			: !isPositionRecommendationReasonCode(decision.reason) ? null
				: {
					action: decision.action, reason: decision.reason, until: decision.until,
					priceQuotedAt: decision.priceQuotedAt, sellWindowFromDay: decision.sellWindowFromDay, sellWindowToDay: decision.sellWindowToDay,
				};
	return {
		id: row.id, itemId: row.itemId, name: row.name, icon: row.icon,
		ownedQuantity: row.ownedQuantity, slotsUsed: row.allocations.length,
		materialStorageEligible: row.materialStorage != null,
		decision: timed,
		bidCopper,
		instantSellNetCopper: saleInstantSellNetFor(row),
		listingNetCopper: row.marketComparison?.listingCopper ?? null,
	};
}

/** Only a valuation covering the displayed quantity can be called its instant-sale net. */
export function saleInstantSellNetFor(row: InventoryAdvisorViewRow): number | null {
	if (row.quantity !== row.ownedQuantity) return null;
	if (row.value.status === 'available' && row.value.route === 'instant_sell') return row.value.copper;
	const comparison = row.marketComparison;
	return comparison?.depthStatus === 'complete' && comparison.coveredQuantity === row.quantity
		? comparison.instantSellCopper : null;
}

/**
 * Review fix: the curated container economy's own liquid-only comparison
 * (`evaluateInventoryContainerEconomy`, already run for the Saco's advisor row — never recomputed
 * here) turned into the two totals the hero card shows side by side. `null` whenever the account's
 * row carries no `containerEconomy` (activation pending, price stale, market depth missing, etc.):
 * shown as "no disponible", never guessed from a different calculation.
 */
export function saleOpenVsSellCopper(
	containerEconomy: InventoryAdvisorViewRow['containerEconomy'],
): { openCopper: number; sellCopper: number } | null {
	if (containerEconomy == null) return null;
	const { explanation } = containerEconomy.liquidOnly;
	const openMicroCopper = BigInt(explanation.open.totalExpectedMicroCopper);
	return { openCopper: Number(openMicroCopper / 1_000_000n), sellCopper: explanation.sellNow.netCopper };
}

/**
 * `recommendPosition`'s `maxPriceAgeMs` while the curated pack is unavailable or expired.
 * Mirrors the value the bundle itself ships (`src/advisor/inventory-advisor-builtin-bundle.ts`),
 * used only as the fallback: the live wiring always prefers the pack's own `policy.maxPriceAgeMs`.
 */
export const FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS = 900_000;

/**
 * H18.35: the one place that turns an `inventoryAdvisorBuiltinBundleProvider.load` result into the
 * live `rulesExpiredAtMs` both `getSaleViewModel` (H18.34) and `getInventoryAdvisorViewModel`
 * (H18.35) check on every read, never on a cached advisor result's own `status`. `null` for every
 * other outcome (`available`, or `unavailable` with `reason: 'invalid'`): only the bundle's own
 * `validUntil`, past, produces a date.
 */
export function liveRulesExpiredAtMsFromLoad(
	bundleLoad: ReturnType<InventoryAdvisorBuiltinBundleProvider['load']>,
): number | null {
	return bundleLoad.status === 'unavailable' && bundleLoad.reason === 'expired'
		? Date.parse(INVENTORY_ADVISOR_BUILTIN_BUNDLE_VALID_UNTIL) : null;
}
