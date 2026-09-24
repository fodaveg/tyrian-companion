import { parseDocument, stringify as stringifyYaml } from 'yaml';

import type { ItemHolding, StorageSnapshot } from '../account/storage-snapshot-model';
import type { AccountSignalsV1, InventoryPriceSnapshotV1 } from '../advisor/inventory-advisor-model';
import {
	INVENTORY_OBJECT_DECISION_ACTIONS,
	INVENTORY_OBJECT_DECISION_REASON_CODES,
	type InventoryObjectDecisionAction,
	type InventoryObjectDecisionReasonCode,
} from '../advisor/inventory-object-result';
import {
	recommendPosition,
	type PositionRecommendationSeasonalInput,
	type PositionRecommendationV1,
} from '../advisor/inventory-position-recommendation';
import { sha256Text } from '../assets/managed-asset-hash';
import type { CatalogLocale, CatalogResolution } from '../catalog/public-catalog-model';
import { errorClassName } from '../core/local-debug-error-details';
import { normalizeVaultRelativePath } from '../core/vault-path';
import {
	isInventoryMarketDepthEvidence,
	valueInstantSellDepth,
	type InventoryMarketDepthEvidenceV1,
} from '../economy/commerce-listings';
import { classifyItemLiquidity, isTradingPostAccessible, type TradingPostEligibility } from '../economy/item-liquidity';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import { scaledSellCopper, type LegendaryReservationSplit } from '../economy/legendary-goals';
import { priceHistoryNoteBlockMarkdown } from './price-history-note-block';

export const INVENTORY_NOTE_SCHEMA_VERSION = 1 as const;
export const INVENTORY_NOTE_KIND = 'gw2_inventory_position' as const;
export const INVENTORY_NOTE_MARKER = 'tyrian_companion_inventory_position' as const;

export type InventoryPositionSource = 'character' | 'shared_inventory' | 'bank' | 'materials';
type InventoryTradingPostAccess = AccountSignalsV1['tradingPostAccess'];

export interface InventoryVaultFile { path: string }

/** Vault-only port. It deliberately exposes neither filesystem paths nor adapter writes. */
export interface InventoryVaultPort {
	file(path: string): InventoryVaultFile | null;
	markdownFiles(): readonly InventoryVaultFile[];
	read(file: InventoryVaultFile): Promise<string>;
	createFolder(path: string): Promise<void>;
	create(path: string, content: string): Promise<InventoryVaultFile>;
	process(file: InventoryVaultFile, update: (content: string) => string): Promise<string>;
	trashFile(file: InventoryVaultFile): Promise<void>;
}

export interface InventoryVaultPosition {
	positionId: string;
	itemId: number;
	source: InventoryPositionSource;
	character: string | null;
	quantity: number;
	unitSellCopper: number | null;
	totalSellCopper: number | null;
	sellDepthStatus: 'complete' | 'partial' | 'no_market' | 'unavailable' | 'invalid';
	sellCoveredQuantity: number;
	sellUncoveredQuantity: number;
	unitListCopper: number | null;
	totalListCopper: number | null;
	name: string;
	type: string | null;
	rarity: string | null;
	icon: string | null;
	/**
	 * H18.14: the object's one decision (`InventoryObjectResultsV1`), the same one the advisor view
	 * shows for the row that covers this position: the advisor's route, timed by
	 * `recommendPosition` when the route is a market one.
	 */
	recommendation: InventoryObjectDecisionAction;
	recommendationReason: InventoryObjectDecisionReasonCode;
	recommendationUntil: string | null;
	recommendationMissing: number | null;
	/** `recommendPosition`'s `pricePercentile`/`priceCoverageDays` (SPEC-recomendacion-por-objeto.md, M2). */
	pricePercentile: number | null;
	priceCoverageDays: number | null;
	/**
	 * `recommendPosition`'s `priceQuotedAt`/`priceHistoryLastDay` (H18.2): today's quote and the
	 * history it was compared against carry their dates separately, never through `until`.
	 */
	priceQuotedAt: string | null;
	priceHistoryLastDay: string | null;
	/**
	 * How much of this position a reservation holds back, and how much is free to act on. When
	 * non-null they always sum to `quantity`: `reservedQuantity` is held back for the chosen
	 * legendary(ies), `freeQuantity` is everything rules (b)/(c) are still allowed to recommend
	 * selling. H18.1: a position no goal touches reads 0 reserved and its whole quantity free (the
	 * Base filters "sell now" on `freeQuantity`); both `null` means UNCERTAIN (a chosen legendary
	 * has no materials table, or its reservation plan could not be built), never "free".
	 */
	reservedQuantity: number | null;
	freeQuantity: number | null;
	/**
	 * H18.14: how much of the position the decision lets the player act on right now (sell, list,
	 * vendor, salvage, use, open, deposit). 0 while it waits, holds, keeps or asks for a review.
	 * Since the object result, `reservedQuantity` also counts the user's keep exceptions, not only
	 * goal reservations.
	 */
	actionableQuantity: number;
}

export interface InventoryVaultSyncInput {
	schemaVersion: typeof INVENTORY_NOTE_SCHEMA_VERSION;
	capturedAt: string;
	locale: CatalogLocale;
	positions: InventoryVaultPosition[];
}

export type InventoryVaultSyncStepStatus =
	| 'create'
	| 'update'
	| 'unchanged'
	| 'deactivate'
	| 'conflict';

export interface InventoryVaultSyncStep {
	positionId: string;
	path: string;
	status: InventoryVaultSyncStepStatus;
	before: string | null;
	after: string | null;
}

export interface InventoryVaultSyncPlan {
	schemaVersion: typeof INVENTORY_NOTE_SCHEMA_VERSION;
	root: string;
	capturedAt: string;
	positions: number;
	canApply: boolean;
	steps: InventoryVaultSyncStep[];
}

export type InventoryVaultSyncResult =
	/**
	 * H18.16: `conflicts` counts the notes this apply skipped (edited inside their managed block, or
	 * changed between preview and write). They no longer abort the plan: every other note lands.
	 * `InventoryVaultSyncService.apply` always sets it; it is optional only for callers that stub
	 * a result.
	 */
	| { status: 'applied' | 'unchanged'; created: number; updated: number; deactivated: number; conflicts?: number }
	| { status: 'conflict' | 'invalid' | 'unavailable'; message: string }
	/**
	 * A real storage rejection (e.g. `EACCES`) hit mid-apply, distinct from `conflict` (another
	 * writer's note occupies the path) and from `unavailable` (H15.11, 2026-09-10 incident: the
	 * apply is not atomic, so `written` carries how many of the plan's writes already landed
	 * instead of implying nothing did). `errorName` is the rejection's class only, never its
	 * message or stack.
	 */
	| { status: 'storage_failure'; message: string; written: number; errorName: string };

/**
 * `tc_unit_sell_copper` is the instant-sell (bid) quote and `tc_unit_list_copper` is
 * the listing (ask) quote. They are tracked separately, both nullable independently:
 * an item can be trading-post eligible with a published ask but no current bid, and
 * that must render as "no buy order right now" (only the sell column is null), not as
 * "not sellable" (both columns null).
 */
interface InventoryNoteFields {
	tc_schema: typeof INVENTORY_NOTE_SCHEMA_VERSION;
	tc_kind: typeof INVENTORY_NOTE_KIND;
	tc_marker: typeof INVENTORY_NOTE_MARKER;
	tc_position_id: string;
	tc_item_id: number;
	tc_source: InventoryPositionSource;
	tc_character: string | null;
	tc_quantity: number;
	tc_unit_sell_copper: number | null;
	tc_total_sell_copper: number | null;
	tc_sell_depth_status: InventoryVaultPosition['sellDepthStatus'];
	tc_sell_covered_quantity: number;
	tc_sell_uncovered_quantity: number;
	tc_unit_list_copper: number | null;
	tc_total_list_copper: number | null;
	tc_active: boolean;
	tc_item_name: string;
	tc_item_type: string | null;
	tc_item_rarity: string | null;
	tc_icon: string | null;
	tc_recommendation: InventoryObjectDecisionAction;
	tc_recommendation_reason: InventoryObjectDecisionReasonCode;
	tc_recommendation_until: string | null;
	tc_recommendation_missing: number | null;
	tc_price_percentile: number | null;
	tc_price_coverage_days: number | null;
	/** `InventoryVaultPosition.priceQuotedAt`/`priceHistoryLastDay` (H18.2). */
	tc_price_quoted_at: string | null;
	tc_price_history_last_day: string | null;
	/** `InventoryVaultPosition.reservedQuantity`/`freeQuantity` (M4, H18.1): both `null` means uncertain. */
	tc_reserved_quantity: number | null;
	tc_free_quantity: number | null;
	/** `InventoryVaultPosition.actionableQuantity` (H18.14). */
	tc_actionable_quantity: number;
	descripcion: string;
}

/**
 * The managed frontmatter keys: the plugin owns their values and rewrites them. H18.16: any other
 * key in a note's frontmatter belongs to the user and is carried through every rewrite untouched.
 */
const INVENTORY_NOTE_KEYS = [
	'tc_schema', 'tc_kind', 'tc_marker', 'tc_position_id',
	'tc_item_id', 'tc_source', 'tc_character', 'tc_quantity',
	'tc_unit_sell_copper', 'tc_total_sell_copper', 'tc_sell_depth_status', 'tc_sell_covered_quantity',
	'tc_sell_uncovered_quantity', 'tc_unit_list_copper', 'tc_total_list_copper', 'tc_active',
	'tc_item_name', 'tc_item_type',
	'tc_item_rarity', 'tc_icon',
	'tc_recommendation', 'tc_recommendation_reason', 'tc_recommendation_until', 'tc_recommendation_missing',
	'tc_price_percentile', 'tc_price_coverage_days',
	'tc_price_quoted_at', 'tc_price_history_last_day',
	'tc_reserved_quantity', 'tc_free_quantity', 'tc_actionable_quantity',
	'descripcion',
] as const;

/** Managed keys an older build wrote and the current one drops (H14.21); never a user key. */
const RETIRED_INVENTORY_NOTE_KEYS = ['tc_captured_at'] as const;
const MANAGED_OR_RETIRED_KEYS: ReadonlySet<string> = new Set([...INVENTORY_NOTE_KEYS, ...RETIRED_INVENTORY_NOTE_KEYS]);

/**
 * Keys that joined `INVENTORY_NOTE_KEYS` after notes were already being written into
 * real Vaults. A note that lacks one of them was written by an older build, not edited
 * by a person, so it is migrated in place (classified `owned`, replanned as `update`)
 * instead of being rejected. A managed key with a wrong type, a position id that does not
 * match or a managed block whose hash does not match are still refused rather than
 * overwritten. Since H18.16 an unknown extra key is not one of them: it is the user's own
 * frontmatter and is carried through every rewrite.
 *
 * THIS IS THE ONLY LIST OF ITS KIND. Adding a frontmatter key without listing it here
 * turns every note already in the Vault into a conflict on the next sync, which writes
 * nothing at all: that is exactly what `tc_unit_list_copper`/`tc_total_list_copper` did
 * to a 1302-note Vault when they were added.
 */
const INVENTORY_NOTE_KEYS_ADDED_LATER = [
	'tc_unit_list_copper', 'tc_total_list_copper', 'tc_sell_depth_status',
	'tc_sell_covered_quantity', 'tc_sell_uncovered_quantity',
	'tc_recommendation', 'tc_recommendation_reason', 'tc_recommendation_until', 'tc_recommendation_missing',
	'tc_price_percentile', 'tc_price_coverage_days',
	// M4. Added in the SAME commit as INVENTORY_NOTE_KEYS above: the H15-adjacent incident this
	// file's own doc comment warns about (a key added to one list but not the other turning every
	// existing note into a conflict) is exactly what M4's own encargo measured once already.
	'tc_reserved_quantity', 'tc_free_quantity',
	// H18.2, same discipline: added to INVENTORY_NOTE_KEYS in the same commit.
	'tc_price_quoted_at', 'tc_price_history_last_day',
	// H18.14, same discipline.
	'tc_actionable_quantity',
] as const;

/**
 * An owned note split into what the plugin manages and what belongs to the user (H18.16).
 *
 * - `fields`: the managed frontmatter values, migrated to the current key set.
 * - `block`: the managed body between the marker line and `END_MARKER` (heading, description and,
 *   for the piloto items, the price-history block).
 * - `userFrontmatter`: every other frontmatter key, serialized, or null when there is none.
 * - `prefix`/`suffix`: the user's text before the marker line and after the managed block.
 */
interface OwnedInventoryNote {
	fields: InventoryNoteFields;
	/** False when `fields` needed a migration (a key added later, or a retired one): rewrite it. */
	currentKeys: boolean;
	block: string;
	userFrontmatter: string | null;
	prefix: string;
	suffix: string;
}

/** The parts of a note that belong to the user; empty for a note the plugin creates. */
interface InventoryNoteUserParts {
	userFrontmatter: string | null;
	prefix: string;
	suffix: string;
}

const NO_USER_PARTS: InventoryNoteUserParts = { userFrontmatter: null, prefix: '', suffix: '' };

const SOURCE_CODES: Record<InventoryPositionSource, string> = {
	character: 'c',
	shared_inventory: 's',
	bank: 'b',
	materials: 'm',
};
const INVENTORY_FOLDER = 'Inventory/Positions';
const MARKER_PREFIX = '<!-- tyrian-companion-inventory';
/**
 * H18.16: closes the managed body. Everything after this line is the user's text. The marker
 * line's `hash` covers only the managed body between the two lines, so text the user adds around
 * it (or frontmatter keys the user adds) never reads as a tampered note. A note written before
 * this line existed has no end marker; its managed body is recognised as described in
 * `classifyInventoryNote`.
 */
const END_MARKER = '<!-- /tyrian-companion-inventory -->';

/** Everything `recommendPosition` needs, resolved once per capture rather than per position. */
export interface InventoryPositionRecommendationInputs {
	capturedAtMs: number;
	priceHistoryEnabled: boolean;
	capitalThresholdCopper: number;
	maxPriceAgeMs: number;
	priceHistoryWindowDays: number;
	priceHistoryRequiredDays: number;
	dailyByItem: ReadonlyMap<number, readonly PriceHistoryDailyV1[]>;
	/** Rule (b), M3: per-item, unlike every other field here, because the calendar is per item. */
	seasonalInputFor(itemId: number): PositionRecommendationSeasonalInput | null;
}

/** Price history off (the default): every position comes back `review`/`price_history_disabled`. */
const DEFAULT_RECOMMENDATION_INPUTS: InventoryPositionRecommendationInputs = {
	capturedAtMs: 0,
	priceHistoryEnabled: false,
	capitalThresholdCopper: 100_000,
	maxPriceAgeMs: 900_000,
	priceHistoryWindowDays: 180,
	priceHistoryRequiredDays: 42,
	seasonalInputFor: () => null,
	dailyByItem: new Map(),
};

/**
 * Every `InventoryVaultPosition` field `buildInventoryVaultPositionCores` can settle without a
 * recommendation, plus `untradeable` (`recommendPosition`'s input of the same name), which only
 * feeds the verdict and never reaches the note.
 */
export type InventoryVaultPositionCore = Omit<InventoryVaultPosition,
	'recommendation' | 'recommendationReason' | 'recommendationUntil' | 'recommendationMissing' | 'pricePercentile' | 'priceCoverageDays'
	| 'priceQuotedAt' | 'priceHistoryLastDay' | 'reservedQuantity' | 'freeQuantity' | 'actionableQuantity'> & { untradeable: boolean };

/**
 * True only when this account can definitely not sell the item on the trading post, read from
 * `classifyItemLiquidity`'s own trading-post eligibility (its binding rule reads the holding's
 * binding, then the catalog's `AccountBound`/`SoulbindOnAcquire`) and `isTradingPostAccessible`'s
 * whitelist rule. `NoSell` is deliberately not read: it forbids VENDOR sales (`gw2-fees.ts`), not
 * trading-post ones. An unknown binding, a missing catalog entry, a missing quote or an unknown
 * account tier are doubts, not answers, and stay false here.
 */
function definitelyUntradeable(
	tradingPost: TradingPostEligibility,
	tradingPostAccess: InventoryTradingPostAccess,
	price: InventoryPriceSnapshotV1['items'][number] | undefined,
): boolean {
	if (tradingPost.status === 'excluded') {
		return tradingPost.reason === 'account_bound' || tradingPost.reason === 'character_bound';
	}
	return tradingPostAccess === 'free_to_play' && price !== undefined
		&& !isTradingPostAccessible(tradingPost, tradingPostAccess, price.whitelisted);
}

/**
 * Groups holdings into rows and values them, stopping short of `recommendPosition`.
 *
 * Split out of `prepareInventoryVaultSyncInput` so the analysis can read `totalSellCopper` (what
 * `selectDerivedWatchListItemIds` needs) BEFORE it has any price-history series to feed
 * `recommendPosition` with, letting decisions 3 and 4 (SPEC-recomendacion-por-objeto.md §7, M2)
 * run ahead of that read instead of after it. Only loose holdings from the four supported
 * inventory locations are retained. H18.16: every input is the advisor analysis's own evidence
 * (`inventory-analysis.ts`); this function never captures anything.
 */
export async function buildInventoryVaultPositionCores(
	snapshot: StorageSnapshot,
	catalog: CatalogResolution,
	prices: InventoryPriceSnapshotV1,
	tradingPostAccess: InventoryTradingPostAccess,
	locale: CatalogLocale,
	marketDepth?: InventoryMarketDepthEvidenceV1,
): Promise<InventoryVaultPositionCore[]> {
	assertCaptureRelations(snapshot, catalog, prices, locale);
	if (marketDepth !== undefined && (!isInventoryMarketDepthEvidence(marketDepth)
		|| !sameNumbers(marketDepth.requestedItemIds, prices.requestedItemIds))) {
		throw new Error('inventory_capture_identity_mismatch');
	}
	const grouped = new Map<string, {
		itemId: number; source: InventoryPositionSource; character: string | null; quantity: number; holding: ItemHolding;
	}>();
	for (const holding of snapshot.holdings) {
		if (holding.kind !== 'item' || holding.state !== 'loose') continue;
		const location = inventoryLocation(holding);
		if (location === null) continue;
		const groupKey = JSON.stringify([holding.itemId, location.source, location.character]);
		const current = grouped.get(groupKey);
		if (current) current.quantity = safeAdd(current.quantity, holding.quantity);
		// The representative holding only feeds `classifyItemLiquidity`'s state/binding
		// check; the first stack seen for this item+location is a fine stand-in even
		// when several stacks are aggregated into one row.
		else grouped.set(groupKey, { itemId: holding.itemId, ...location, quantity: holding.quantity, holding });
	}

	const priceById = new Map(prices.items.map((price) => [price.itemId, price]));
	const depthById = new Map(marketDepth?.items.map((item) => [item.itemId, item]) ?? []);
	const consumedByItem = new Map<number, number>();
	const orderedGroups = [...grouped.values()].sort((left, right) => left.itemId - right.itemId
		|| left.source.localeCompare(right.source) || (left.character ?? '').localeCompare(right.character ?? ''));
	const cores: InventoryVaultPositionCore[] = [];
	for (const group of orderedGroups) {
		const item = catalog.items[String(group.itemId)] ?? null;
		const price = priceById.get(group.itemId);
		const liquidity = classifyItemLiquidity(group.holding, item, price === undefined ? 'missing' : 'available');
		const eligible = liquidity.status === 'ok'
			&& isTradingPostAccessible(liquidity.classification.tradingPost, tradingPostAccess, price?.whitelisted === true);
		const untradeable = liquidity.status === 'ok'
			&& definitelyUntradeable(liquidity.classification.tradingPost, tradingPostAccess, price);
		const unitSellCopper = eligible && price !== undefined && price.bid !== null ? price.bid.unitCopper : null;
		const unitListCopper = eligible && price !== undefined && price.ask !== null ? price.ask.unitCopper : null;
		const depth = eligible && unitSellCopper !== null ? depthById.get(group.itemId) : undefined;
		const consumed = consumedByItem.get(group.itemId) ?? 0;
		const demonstrated = depth?.coverage === 'complete'
			? valueInstantSellDepth(depth.buys, group.quantity, consumed)
			: null;
		if (demonstrated !== null && demonstrated.status !== 'invalid') {
			consumedByItem.set(group.itemId, safeAdd(consumed, demonstrated.coveredQuantity));
		}
		const sellDepthStatus = !eligible || depth === undefined ? 'unavailable'
			: depth.coverage !== 'complete' ? depth.coverage === 'invalid' ? 'invalid' : 'unavailable'
				: demonstrated?.status ?? 'invalid';
		const totalSellCopper = demonstrated?.status === 'complete' ? demonstrated.netCopper : null;
		cores.push({
			positionId: await positionId(group.itemId, group.source, group.character),
			itemId: group.itemId,
			source: group.source,
			character: group.character,
			quantity: group.quantity,
			unitSellCopper,
			totalSellCopper,
			sellDepthStatus,
			sellCoveredQuantity: demonstrated?.coveredQuantity ?? 0,
			sellUncoveredQuantity: demonstrated?.uncoveredQuantity ?? group.quantity,
			untradeable,
			unitListCopper,
			// The best ask is a competing listing, not demonstrated buyer capacity.
			totalListCopper: null,
			name: cleanText(item?.name ?? (locale === 'es' ? `Objeto ${String(group.itemId)}` : `Item ${String(group.itemId)}`)),
			type: item?.type ? cleanText(item.type) : null,
			rarity: item?.rarity ? cleanText(item.rarity) : null,
			icon: item?.icon ?? null,
		});
	}
	return cores;
}

/**
 * Sums `totalSellCopper` across every position of the same item (SPEC-recomendacion-por-objeto.md
 * §3.c / §7 decision 5, 11 sep 2026): David's decision is that the capital-parked threshold is a
 * property of the OBJECT, not of any one note — an object split across several notes (different
 * characters or containers) must get the SAME threshold verdict on every one of them.
 *
 * A `null` position contributes nothing to its item's sum without turning an otherwise-known total
 * into `null`; only an item whose EVERY position is `null` stays `null` here, exactly reproducing
 * rule (c)'s pre-existing null handling for a single, undemonstrated position (`recommendPosition`,
 * `src/advisor/inventory-position-recommendation.ts`).
 */
export function sumSellCopperByItem(
	positions: readonly { itemId: number; totalSellCopper: number | null }[],
): Map<number, number | null> {
	const sums = new Map<number, number>();
	const itemIds = new Set<number>();
	for (const { itemId, totalSellCopper } of positions) {
		itemIds.add(itemId);
		if (totalSellCopper === null) continue;
		sums.set(itemId, (sums.get(itemId) ?? 0) + totalSellCopper);
	}
	const result = new Map<number, number | null>();
	for (const itemId of itemIds) result.set(itemId, sums.get(itemId) ?? null);
	return result;
}

/**
 * Attaches `recommendPosition`'s verdict to every core row, in the same order it was given.
 *
 * `legendaryReservationByPositionId` is M4's rule (a): absent (the default) or missing an entry
 * for a given position, that position is entirely outside any legendary requirement this sync,
 * exactly reproducing the pre-M4 output (M4 test 8). Present, `scaledSellCopper` values the FREE
 * share for rules (b)/(c) only once the shortfall is confirmed to be 0 — with a shortfall, the
 * scaled value is never read at all, since rule (a) short-circuits before it.
 *
 * The value `recommendPosition` compares against the capital threshold (rule (c)) is, since 11 sep
 * 2026, `sumSellCopperByItem`'s per-`itemId` total of that same (possibly legendary-scaled) value,
 * never one position's own — every position of one object gets the same threshold decision. The
 * scaling happens BEFORE the sum (per position, using that position's own `freeQuantity`), not
 * after: summing raw values first and scaling the sum by one position's share would double-count
 * or under-count whenever positions of the same item carry different reservations.
 *
 * H18.1: every position gets a free quantity. Outside any reservation it is the whole stack; with
 * one it is the split's own share (0 for a fully reserved position, which `recommendPosition` then
 * holds for the goal whatever its price or season); for an item in `uncertainReservationItemIds`
 * whose free share is not already known to be 0 it is `null` (uncertain), never the whole stack.
 * H18.2: `todayBidCopper` is the position's own live quote (`unitSellCopper`), taken at
 * `capturedAtMs` in the same capture.
 */
export function attachPositionRecommendations(
	cores: readonly InventoryVaultPositionCore[],
	recommendationInputs: InventoryPositionRecommendationInputs,
	legendaryReservationByPositionId: ReadonlyMap<string, LegendaryReservationSplit> = new Map(),
	uncertainReservationItemIds: ReadonlySet<number> = new Set(),
): InventoryVaultPosition[] {
	return evaluatePositionTimings(
		cores, recommendationInputs, legendaryReservationByPositionId, uncertainReservationItemIds,
	).map(positionFromTiming);
}

/** `recommendPosition`'s verdict for one core row, with the free/reserved split it was given. */
export interface InventoryPositionTiming {
	core: InventoryVaultPositionCore;
	timing: PositionRecommendationV1;
	reservedQuantity: number | null;
	freeQuantity: number | null;
}

/**
 * Without an advisor analysis the moment stage IS the whole decision (`prepareInventoryVaultSyncInput`,
 * `attachPositionRecommendations`): only its `sell` is something to act on now.
 */
function positionFromTiming({ core: { untradeable: _untradeable, ...core }, timing, reservedQuantity, freeQuantity }:
	InventoryPositionTiming): InventoryVaultPosition {
	return {
		...core,
		recommendation: timing.action,
		recommendationReason: timing.reason,
		recommendationUntil: timing.until,
		recommendationMissing: timing.missing,
		pricePercentile: timing.pricePercentile,
		priceCoverageDays: timing.priceCoverageDays,
		priceQuotedAt: timing.priceQuotedAt,
		priceHistoryLastDay: timing.priceHistoryLastDay,
		reservedQuantity,
		freeQuantity,
		actionableQuantity: timing.action === 'sell' ? freeQuantity ?? 0 : 0,
	};
}

/**
 * The moment stage for every core row: the capital threshold measured per object, the H18.1
 * free/reserved split, and `recommendPosition`'s verdict. `attachPositionRecommendations` turns it
 * straight into notes; the object result (`inventory-analysis.ts`) combines it with the advisor's
 * route first.
 */
export function evaluatePositionTimings(
	cores: readonly InventoryVaultPositionCore[],
	recommendationInputs: InventoryPositionRecommendationInputs,
	legendaryReservationByPositionId: ReadonlyMap<string, LegendaryReservationSplit> = new Map(),
	uncertainReservationItemIds: ReadonlySet<number> = new Set(),
): InventoryPositionTiming[] {
	const thresholdValueByPositionId = new Map<string, number | null>();
	for (const core of cores) {
		const reservation = legendaryReservationByPositionId.get(core.positionId) ?? null;
		const value = reservation === null || reservation.shortfall > 0 ? core.totalSellCopper
			: scaledSellCopper(core.totalSellCopper, reservation.freeQuantity, core.quantity);
		thresholdValueByPositionId.set(core.positionId, value);
	}
	const itemThresholdTotals = sumSellCopperByItem(cores.map((core) => ({
		itemId: core.itemId, totalSellCopper: thresholdValueByPositionId.get(core.positionId) ?? null,
	})));
	return cores.map((core) => {
		const { untradeable } = core;
		const reservation = legendaryReservationByPositionId.get(core.positionId) ?? null;
		const knownFree = reservation?.freeQuantity ?? core.quantity;
		const nothingFree = knownFree === 0 || (reservation !== null && reservation.shortfall > 0);
		const uncertain = uncertainReservationItemIds.has(core.itemId) && !nothingFree;
		const split = uncertain
			? { reservedQuantity: null, freeQuantity: null }
			: { reservedQuantity: reservation?.reservedQuantity ?? 0, freeQuantity: knownFree };
		const recommendation = recommendPosition({
			capturedAtMs: recommendationInputs.capturedAtMs,
			priceHistoryEnabled: recommendationInputs.priceHistoryEnabled,
			totalSellCopper: itemThresholdTotals.get(core.itemId) ?? null,
			capitalThresholdCopper: recommendationInputs.capitalThresholdCopper,
			maxPriceAgeMs: recommendationInputs.maxPriceAgeMs,
			priceHistoryDaily: recommendationInputs.dailyByItem.get(core.itemId) ?? [],
			priceHistoryWindowDays: recommendationInputs.priceHistoryWindowDays,
			priceHistoryRequiredDays: recommendationInputs.priceHistoryRequiredDays,
			seasonal: recommendationInputs.seasonalInputFor(core.itemId),
			legendaryShortfall: reservation?.shortfall ?? null,
			freeQuantity: split.freeQuantity,
			todayBidCopper: core.unitSellCopper,
			untradeable,
		});
		return { core, timing: recommendation, ...split };
	});
}

/**
 * Converts account-bound evidence into the identity-free rows allowed in Vault.
 * Only loose holdings from the four supported inventory locations are retained.
 */
export async function prepareInventoryVaultSyncInput(
	snapshot: StorageSnapshot,
	catalog: CatalogResolution,
	prices: InventoryPriceSnapshotV1,
	tradingPostAccess: InventoryTradingPostAccess,
	locale: CatalogLocale,
	marketDepth?: InventoryMarketDepthEvidenceV1,
	recommendationInputs: InventoryPositionRecommendationInputs = DEFAULT_RECOMMENDATION_INPUTS,
): Promise<InventoryVaultSyncInput> {
	const cores = await buildInventoryVaultPositionCores(snapshot, catalog, prices, tradingPostAccess, locale, marketDepth);
	const positions = attachPositionRecommendations(cores, recommendationInputs);
	positions.sort(comparePositions);
	return {
		schemaVersion: INVENTORY_NOTE_SCHEMA_VERSION,
		capturedAt: snapshot.completedAt,
		locale,
		positions,
	};
}

/** Plans and applies only versioned Tyrian inventory notes below one portable Vault root. */
export class InventoryVaultSyncService {
	private flight: Promise<InventoryVaultSyncResult> | null = null;
	private flightPlanKey: string | null = null;

	constructor(
		private readonly vault: InventoryVaultPort,
		private readonly configDir: string,
	) {}

	/**
	 * H18.16 (audit 2026-09-24 §3.E, prueba 9):
	 * - A note is `unchanged`, and never rewritten, when its managed values and managed block already
	 *   say what this analysis says. The two clock fields (`tc_price_quoted_at` and a price
	 *   verdict's `tc_recommendation_until`, both derived from the capture instant) do not count as
	 *   a change on their own: a resync with the same data writes nothing, whatever the time.
	 * - A rewrite replaces the managed values and block only. The user's frontmatter keys and the
	 *   text around the managed block are carried through byte for byte.
	 * - A note the plugin cannot safely rewrite (edited inside its managed block, a foreign note in
	 *   the folder, a duplicate identity) is a `conflict` step for THAT note alone; the rest of the
	 *   plan still applies (`canApply` stays true).
	 */
	async preview(root: string, input: InventoryVaultSyncInput): Promise<InventoryVaultSyncPlan> {
		const normalizedRoot = normalizeInventoryRoot(root, this.configDir);
		if (normalizedRoot === null || !isInventoryVaultSyncInput(input)) throw new Error('invalid_inventory_sync_input');
		const folder = inventoryFolder(normalizedRoot);
		const desired = new Map<string, { position: InventoryVaultPosition; path: string; fields: InventoryNoteFields; block: string }>();
		for (const position of input.positions) {
			if (position.positionId !== await positionId(position.itemId, position.source, position.character)) {
				throw new Error('invalid_inventory_sync_input');
			}
			const path = `${folder}/${position.positionId}.md`;
			const fields = fieldsFor(position, input.locale);
			desired.set(position.positionId, { position, path, fields, block: renderInventoryBlock(fields) });
		}

		const steps: InventoryVaultSyncStep[] = [];
		const seenOwned = new Set<string>();
		const conflictPaths = new Set<string>();
		for (const file of this.inventoryFiles(folder)) {
			const content = normalizeLf(await this.vault.read(file));
			const classified = await classifyInventoryNote(content);
			if (classified.status === 'foreign') {
				steps.push(step(file.path, file.path, 'conflict', content, null));
				conflictPaths.add(file.path);
				continue;
			}
			if (classified.status === 'conflict') {
				steps.push(step(classified.positionId ?? file.path, file.path, 'conflict', content, null));
				conflictPaths.add(file.path);
				continue;
			}
			const owned = classified.note;
			const expectedPath = `${folder}/${owned.fields.tc_position_id}.md`;
			if (file.path !== expectedPath || seenOwned.has(owned.fields.tc_position_id)) {
				steps.push(step(owned.fields.tc_position_id, file.path, 'conflict', content, null));
				conflictPaths.add(file.path);
				continue;
			}
			seenOwned.add(owned.fields.tc_position_id);
			const target = desired.get(owned.fields.tc_position_id);
			if (target) {
				steps.push(sameManagedContent(owned, target.fields, target.block)
					? step(target.position.positionId, file.path, 'unchanged', content, content)
					: step(target.position.positionId, file.path, 'update', content,
						await renderInventoryNote(target.fields, target.block, owned)));
				continue;
			}
			// The position no longer appears on the account: the note is removed rather than
			// rewritten with `tc_active: false`, including one already left in that stale state
			// by an earlier build, so the Vault converges to zero deactivated notes instead of
			// accumulating them. H18.16: a note that carries the user's own text is the exception.
			// Trashing it would delete what the user wrote, so it is rewritten inactive instead
			// (`tc_active: false`, quantity 0, out of every Base view) with that text intact.
			if (!hasUserParts(owned)) {
				steps.push(step(owned.fields.tc_position_id, file.path, 'deactivate', content, null));
				continue;
			}
			const inactive = inactiveInventoryNoteFields(owned.fields);
			steps.push(sameManagedContent(owned, inactive, owned.block)
				? step(owned.fields.tc_position_id, file.path, 'unchanged', content, content)
				: step(owned.fields.tc_position_id, file.path, 'deactivate', content,
					await renderInventoryNote(inactive, owned.block, owned)));
		}

		for (const target of desired.values()) {
			// A path the loop above already reported as a conflict is one note, counted once.
			if (seenOwned.has(target.position.positionId) || conflictPaths.has(target.path)) continue;
			const occupied = this.vault.file(target.path);
			if (occupied) {
				const content = normalizeLf(await this.vault.read(occupied));
				steps.push(step(target.position.positionId, target.path, 'conflict', content, null));
			} else {
				steps.push(step(target.position.positionId, target.path, 'create', null,
					await renderInventoryNote(target.fields, target.block, NO_USER_PARTS)));
			}
		}
		steps.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
		return {
			schemaVersion: INVENTORY_NOTE_SCHEMA_VERSION,
			root: normalizedRoot,
			capturedAt: input.capturedAt,
			positions: input.positions.length,
			canApply: true,
			steps,
		};
	}

	/**
	 * `onStep`, when given, reports real progress: how many of `plan.steps` are
	 * settled (already-unchanged entries count as settled from the start) against
	 * the plan's own total. It is never a substitute for the returned result.
	 */
	apply(plan: InventoryVaultSyncPlan, onStep?: (completed: number, total: number) => void): Promise<InventoryVaultSyncResult> {
		const planKey = JSON.stringify(plan);
		if (this.flight) {
			return this.flightPlanKey === planKey
				? this.flight
				: Promise.resolve({ status: 'invalid', message: 'Another inventory plan is already being applied.' });
		}
		const flight = this.applyInternal(plan, onStep).finally(() => {
			if (this.flight === flight) {
				this.flight = null;
				this.flightPlanKey = null;
			}
		});
		this.flight = flight;
		this.flightPlanKey = planKey;
		return flight;
	}

	private async applyInternal(
		plan: InventoryVaultSyncPlan,
		onStep?: (completed: number, total: number) => void,
	): Promise<InventoryVaultSyncResult> {
		if (!isInventoryVaultSyncPlan(plan, this.configDir) || !plan.canApply) {
			return { status: 'invalid', message: 'The inventory preview is invalid or blocked.' };
		}
		const total = plan.steps.length;
		let completed = 0;
		// H18.16: a conflict belongs to its own note. A step the preview already marked as one, or a
		// note that changed between preview and write (the user typing in it), is skipped and
		// counted; every other planned write still lands.
		let conflicts = 0;
		try {
			const skipped = new Set<InventoryVaultSyncStep>();
			for (const entry of plan.steps) {
				if (entry.status === 'conflict') {
					skipped.add(entry);
					conflicts += 1;
					continue;
				}
				if (entry.status === 'unchanged') continue;
				const file = this.vault.file(entry.path);
				const moved = entry.before === null
					? file !== null
					: file === null || normalizeLf(await this.vault.read(file)) !== entry.before;
				if (moved) {
					skipped.add(entry);
					conflicts += 1;
				}
			}
			const writes = plan.steps.filter((entry) => entry.status !== 'unchanged' && !skipped.has(entry));
			completed = total - writes.length;
			onStep?.(completed, total);
			if (writes.length === 0) return { status: 'unchanged', created: 0, updated: 0, deactivated: 0, conflicts };
			await ensureFolders(this.vault, inventoryFolder(plan.root));
			let created = 0;
			let updated = 0;
			let deactivated = 0;
			for (const entry of writes) {
				if (entry.status === 'create') {
					if (entry.after === null) return { status: 'invalid', message: 'The inventory plan contains an empty write.' };
					let landed = true;
					try { await this.vault.create(entry.path, entry.after); }
					catch (error) {
						const raced = this.vault.file(entry.path);
						// No file landed at all: the create really failed (e.g. `EACCES`), not a race
						// against another writer, so this is a storage failure, not a conflict.
						if (!raced) {
							return {
								status: 'storage_failure', message: 'An inventory note could not be created.',
								written: completed, errorName: errorClassName(error),
							};
						}
						landed = normalizeLf(await this.vault.read(raced)) === entry.after;
					}
					if (landed) created += 1;
					else conflicts += 1;
					completed += 1;
					onStep?.(completed, total);
					continue;
				}
				if (entry.status === 'deactivate' && entry.after === null) {
					const file = this.vault.file(entry.path);
					if (!file || entry.before === null) conflicts += 1;
					else {
						await this.vault.trashFile(file);
						deactivated += 1;
					}
					completed += 1;
					onStep?.(completed, total);
					continue;
				}
				if (entry.after === null) return { status: 'invalid', message: 'The inventory plan contains an empty write.' };
				const file = this.vault.file(entry.path);
				let applied = false;
				if (file && entry.before !== null) {
					await this.vault.process(file, (current) => {
						if (normalizeLf(current) !== entry.before) return current;
						applied = true;
						return entry.after!;
					});
				}
				const verified = this.vault.file(entry.path);
				if (!applied || !verified || normalizeLf(await this.vault.read(verified)) !== entry.after) conflicts += 1;
				else if (entry.status === 'deactivate') deactivated += 1;
				else updated += 1;
				completed += 1;
				onStep?.(completed, total);
			}
			return created + updated + deactivated === 0
				? { status: 'unchanged', created, updated, deactivated, conflicts }
				: { status: 'applied', created, updated, deactivated, conflicts };
		} catch (error) {
			return {
				status: 'storage_failure', message: 'Inventory notes could not be written safely.',
				written: completed, errorName: errorClassName(error),
			};
		}
	}

	private inventoryFiles(folder: string): InventoryVaultFile[] {
		const prefix = `${folder}/`;
		return this.vault.markdownFiles().filter((file) => file.path.startsWith(prefix) && file.path.endsWith('.md'))
			.sort((left, right) => left.path.localeCompare(right.path));
	}
}

/**
 * Which note a holding belongs to: a character's bag, the shared inventory, the bank or the
 * material storage, or null for any other place (equipped, delivery box), which no note covers.
 */
export function inventoryLocation(holding: ItemHolding): { source: InventoryPositionSource; character: string | null } | null {
	if (holding.location.source === 'character' && holding.location.container === 'bag') {
		return { source: 'character', character: holding.location.character.normalize('NFC') };
	}
	if (holding.location.source === 'shared_inventory' || holding.location.source === 'bank' || holding.location.source === 'materials') {
		return { source: holding.location.source, character: null };
	}
	return null;
}

async function positionId(itemId: number, source: InventoryPositionSource, character: string | null): Promise<string> {
	const suffix = character === null ? 'account' : (await sha256Text(character.normalize('NFC'))).slice(0, 24);
	return `${String(itemId)}-${SOURCE_CODES[source]}-${suffix}`;
}

function inventoryFolder(root: string): string { return `${root}/${INVENTORY_FOLDER}`; }

function normalizeInventoryRoot(value: unknown, configDir: string): string | null {
	return normalizeVaultRelativePath(value, { forbiddenPathPrefixes: [configDir], maxPathLength: 128 });
}

function assertCaptureRelations(
	snapshot: StorageSnapshot,
	catalog: CatalogResolution,
	prices: InventoryPriceSnapshotV1,
	locale: CatalogLocale,
): void {
	if ((locale !== 'es' && locale !== 'en') || catalog.locale !== locale || catalog.snapshotId !== snapshot.snapshotId ||
		catalog.schemaVersion !== snapshot.schemaVersion || prices.accountId !== snapshot.accountId ||
		prices.snapshotId !== snapshot.snapshotId || prices.schemaVersion !== snapshot.schemaVersion ||
		!Number.isFinite(Date.parse(snapshot.completedAt))) throw new Error('inventory_capture_identity_mismatch');
}

/**
 * Notes describe every supported store, so only a stable snapshot with all four stores and every
 * character complete may rewrite them. The advisor tolerates less; a notes sync does not.
 */
export function inventorySnapshotComplete(snapshot: StorageSnapshot): boolean {
	return snapshot.quality === 'stable' &&
		(['characters', 'shared_inventory', 'bank', 'materials'] as const)
			.every((source) => snapshot.coverage.sources[source].status === 'complete') &&
		Object.values(snapshot.coverage.characters).every((coverage) => coverage.status === 'complete');
}

/** The canonical note order: item, store, character, then the opaque position id. */
export function comparePositions(left: InventoryVaultPosition, right: InventoryVaultPosition): number {
	return left.itemId - right.itemId || left.source.localeCompare(right.source) ||
		(left.character ?? '').localeCompare(right.character ?? '') || left.positionId.localeCompare(right.positionId);
}

/**
 * Every note this builds describes a position that is still on the account (`tc_active: true`).
 * A stale position is deleted (H14.21) unless its note carries the user's own text (H18.16), in
 * which case `inactiveInventoryNoteFields` rewrites it inactive instead.
 */
function fieldsFor(position: InventoryVaultPosition, locale: CatalogLocale): InventoryNoteFields {
	return {
		tc_schema: INVENTORY_NOTE_SCHEMA_VERSION,
		tc_kind: INVENTORY_NOTE_KIND,
		tc_marker: INVENTORY_NOTE_MARKER,
		tc_position_id: position.positionId,
		tc_item_id: position.itemId,
		tc_source: position.source,
		tc_character: position.character,
		tc_quantity: position.quantity,
		tc_unit_sell_copper: position.unitSellCopper,
		tc_total_sell_copper: position.totalSellCopper,
		tc_sell_depth_status: position.sellDepthStatus,
		tc_sell_covered_quantity: position.sellCoveredQuantity,
		tc_sell_uncovered_quantity: position.sellUncoveredQuantity,
		tc_unit_list_copper: position.unitListCopper,
		tc_total_list_copper: position.totalListCopper,
		tc_active: true,
		tc_item_name: position.name,
		tc_item_type: position.type,
		tc_item_rarity: position.rarity,
		tc_icon: position.icon,
		tc_recommendation: position.recommendation,
		tc_recommendation_reason: position.recommendationReason,
		tc_recommendation_until: position.recommendationUntil,
		tc_recommendation_missing: position.recommendationMissing,
		tc_price_percentile: position.pricePercentile,
		tc_price_coverage_days: position.priceCoverageDays,
		tc_price_quoted_at: position.priceQuotedAt,
		tc_price_history_last_day: position.priceHistoryLastDay,
		tc_reserved_quantity: position.reservedQuantity,
		tc_free_quantity: position.freeQuantity,
		tc_actionable_quantity: position.actionableQuantity,
		descripcion: locale === 'es' ? 'Existencia de inventario gestionada por Tyrian Companion.' : 'Inventory holding managed by Tyrian Companion.',
	};
}

/**
 * H18.16: a position gone from the account whose note holds the user's text. Nothing is left to
 * act on, so every quantity and demonstrated value drops to 0/null and `tc_active` turns false,
 * which takes the note out of every Base view; the item's identity and last quotes stay as they
 * were, next to what the user wrote.
 */
function inactiveInventoryNoteFields(fields: InventoryNoteFields): InventoryNoteFields {
	return {
		...fields,
		tc_quantity: 0,
		tc_active: false,
		tc_total_sell_copper: null,
		tc_sell_depth_status: 'unavailable',
		tc_sell_covered_quantity: 0,
		tc_sell_uncovered_quantity: 0,
		tc_total_list_copper: null,
		tc_recommendation_until: null,
		tc_recommendation_missing: null,
		tc_reserved_quantity: 0,
		tc_free_quantity: 0,
		tc_actionable_quantity: 0,
	};
}

/**
 * The managed body: heading, description and, for the piloto H9.2 allowlist, the managed
 * price-history code block. Every other position keeps the exact body it always had. Built from
 * the managed fields alone, so the same values always render the same bytes.
 */
function renderInventoryBlock(fields: InventoryNoteFields): string {
	const heading = cleanText(fields.tc_item_name).replace(/^[#]/u, '\\$&');
	const priceHistoryBlock = priceHistoryNoteBlockMarkdown(fields.tc_item_id, fields.tc_item_name);
	return priceHistoryBlock === null
		? `# ${heading}\n\n${fields.descripcion}\n`
		: `# ${heading}\n\n${fields.descripcion}\n\n${priceHistoryBlock}\n`;
}

/**
 * `tc_captured_at` deliberately never lands here (H14.21): it used to make every position's
 * marker hash change on every capture, rewriting all of them even when nothing about the
 * holding itself moved. The Base column that showed it now reads `file.mtime` instead.
 *
 * H18.16: the managed values come first, then the user's own frontmatter keys; the user's text
 * before the marker line and after `END_MARKER` is written back unchanged. The marker's hash
 * covers the managed block only.
 */
async function renderInventoryNote(
	fields: InventoryNoteFields,
	block: string,
	user: InventoryNoteUserParts,
): Promise<string> {
	const managed = stringifyYaml(fields, { lineWidth: 0 }).trimEnd();
	const frontmatter = user.userFrontmatter === null ? managed : `${managed}\n${user.userFrontmatter}`;
	const hash = await sha256Text(block);
	return `---\n${frontmatter}\n---\n${user.prefix}${markerLine(fields.tc_position_id, hash)}\n${block}${END_MARKER}\n${user.suffix}`;
}

/** True when the note carries anything the user wrote: frontmatter keys or text of their own. */
function hasUserParts(note: InventoryNoteUserParts): boolean {
	return note.userFrontmatter !== null || note.prefix.trim().length > 0 || note.suffix.trim().length > 0;
}

/**
 * Whether a rewrite would change anything the plugin manages. `tc_price_quoted_at` and a price
 * verdict's `tc_recommendation_until` are the capture instant plus a constant; comparing them
 * would rewrite every note on every sync (audit 2026-09-24 §3.E, "la vigencia de 15 minutos entra
 * en el hash"). So the quote date only counts by its presence, and a price expiry by its distance
 * from the quote; a seasonal window's open or close is a real date and is compared as such. A note
 * an older build wrote (a managed key missing or retired) is never "the same": its migrated values
 * may coincide, but the note itself still lacks the column, so it is rewritten once.
 */
function sameManagedContent(note: OwnedInventoryNote, fields: InventoryNoteFields, block: string): boolean {
	return note.currentKeys && note.block === block
		&& comparableManagedFields(note.fields) === comparableManagedFields(fields);
}

function comparableManagedFields(fields: InventoryNoteFields): string {
	const quotedAt = fields.tc_price_quoted_at;
	const until = fields.tc_recommendation_until;
	const seasonal = fields.tc_recommendation_reason === 'seasonal_sell_window' || fields.tc_recommendation_reason === 'seasonal_hold';
	const comparableUntil = until === null || seasonal || quotedAt === null
		? until
		: `+${String(Date.parse(until) - Date.parse(quotedAt))}ms`;
	return JSON.stringify(INVENTORY_NOTE_KEYS.map((key) => key === 'tc_price_quoted_at' ? quotedAt !== null
		: key === 'tc_recommendation_until' ? comparableUntil : fields[key]));
}

function markerLine(position: string, hash: string | null): string {
	const base = `${MARKER_PREFIX} schema=${String(INVENTORY_NOTE_SCHEMA_VERSION)} marker=${INVENTORY_NOTE_MARKER} position=${position}`;
	return hash === null ? `${base} -->` : `${base} hash=${hash} -->`;
}

/**
 * Recognises an owned note and splits it into managed and user parts (H18.16).
 *
 * The managed block is the text between the marker line and `END_MARKER`, and the marker's hash
 * must match it: an edit inside it is the one edit that still makes the note a conflict, since
 * rewriting it would delete what the user typed there. Frontmatter keys the plugin does not manage
 * and any text outside the block are the user's and never block anything.
 *
 * A note written before `END_MARKER` existed is recognised two ways: byte for byte by its old
 * whole-note hash (nothing added yet), or by its managed block rendered from its own managed
 * values followed by whatever the user appended. It stays in that older shape until its data
 * changes; the next rewrite adds the end marker.
 */
async function classifyInventoryNote(content: string): Promise<
	| { status: 'owned'; note: OwnedInventoryNote }
	| { status: 'foreign' }
	| { status: 'conflict'; positionId: string | null }
> {
	const marker = content.match(/<!-- tyrian-companion-inventory schema=(\d+) marker=([^\s]+) position=([^\s]+)(?: hash=([a-f0-9]{64}))? -->/u);
	if (!marker) return content.includes(MARKER_PREFIX) ? { status: 'conflict', positionId: null } : { status: 'foreign' };
	const positionId = marker[3] ?? null;
	if (marker[1] !== String(INVENTORY_NOTE_SCHEMA_VERSION) || marker[2] !== INVENTORY_NOTE_MARKER || !positionId || !marker[4]) {
		return { status: 'conflict', positionId };
	}
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!frontmatter) return { status: 'conflict', positionId };
	const rest = content.slice(frontmatter[0].length);
	const markerAt = rest.indexOf(marker[0]);
	if (markerAt < 0 || (markerAt > 0 && rest[markerAt - 1] !== '\n') || rest[markerAt + marker[0].length] !== '\n') {
		return { status: 'conflict', positionId };
	}
	let parsed: { managed: Record<string, unknown>; userFrontmatter: string | null } | null;
	try { parsed = splitInventoryFrontmatter(frontmatter[1]!); }
	catch { return { status: 'conflict', positionId }; }
	if (parsed === null) return { status: 'conflict', positionId };
	const fields = migrateInventoryNoteFields(parsed.managed);
	if (!isInventoryNoteFields(fields) || fields.tc_position_id !== positionId) return { status: 'conflict', positionId };
	const prefix = rest.slice(0, markerAt);
	const afterMarker = rest.slice(markerAt + marker[0].length + 1);
	const endAt = endMarkerAt(afterMarker);
	let block: string;
	let suffix: string;
	if (endAt >= 0) {
		block = afterMarker.slice(0, endAt);
		suffix = afterMarker.slice(endAt + END_MARKER.length).replace(/^\n/u, '');
		if (await sha256Text(block) !== marker[4]) return { status: 'conflict', positionId };
	} else if (await sha256Text(content.replace(marker[0], markerLine(positionId, null))) === marker[4]) {
		block = afterMarker;
		suffix = '';
	} else {
		const expected = renderInventoryBlock(fields);
		if (!afterMarker.startsWith(expected)) return { status: 'conflict', positionId };
		block = expected;
		suffix = afterMarker.slice(expected.length);
	}
	const currentKeys = INVENTORY_NOTE_KEYS.every((key) => key in parsed.managed)
		&& RETIRED_INVENTORY_NOTE_KEYS.every((key) => !(key in parsed.managed));
	return { status: 'owned', note: { fields, currentKeys, block, userFrontmatter: parsed.userFrontmatter, prefix, suffix } };
}

/** Where `END_MARKER` starts as a whole line of `text`, or -1. */
function endMarkerAt(text: string): number {
	let from = 0;
	for (;;) {
		const at = text.indexOf(END_MARKER, from);
		if (at < 0) return -1;
		const next = text[at + END_MARKER.length];
		if ((at === 0 || text[at - 1] === '\n') && (next === undefined || next === '\n')) return at;
		from = at + 1;
	}
}

/**
 * Separates the managed keys (current or retired) from the user's own, keeping the user's part as
 * YAML that round-trips the user's own formatting as far as the parser allows. Null when the
 * frontmatter is not a valid YAML mapping.
 */
function splitInventoryFrontmatter(text: string): { managed: Record<string, unknown>; userFrontmatter: string | null } | null {
	const document = parseDocument(text);
	if (document.errors.length > 0) return null;
	const value: unknown = document.toJS();
	if (!record(value)) return null;
	const managed: Record<string, unknown> = {};
	let userKeys = 0;
	for (const [key, entry] of Object.entries(value)) {
		if (MANAGED_OR_RETIRED_KEYS.has(key)) managed[key] = entry;
		else userKeys += 1;
	}
	if (userKeys === 0) return { managed, userFrontmatter: null };
	for (const key of MANAGED_OR_RETIRED_KEYS) document.delete(key);
	return { managed, userFrontmatter: document.toString({ lineWidth: 0 }).trimEnd() };
}

function step(
	positionId: string,
	path: string,
	status: InventoryVaultSyncStepStatus,
	before: string | null,
	after: string | null,
): InventoryVaultSyncStep {
	return { positionId, path, status, before, after };
}

function isInventoryVaultSyncInput(value: unknown): value is InventoryVaultSyncInput {
	if (!record(value) || value.schemaVersion !== INVENTORY_NOTE_SCHEMA_VERSION ||
		(value.locale !== 'es' && value.locale !== 'en') || !iso(value.capturedAt) || !Array.isArray(value.positions)) return false;
	return value.positions.every(isInventoryPosition) && new Set(value.positions.map((entry) => entry.positionId)).size === value.positions.length;
}

function isInventoryPosition(value: unknown): value is InventoryVaultPosition {
	return record(value) && typeof value.positionId === 'string' && /^[1-9]\d*-[csbm]-(?:account|[a-f0-9]{24})$/u.test(value.positionId) &&
		positive(value.itemId) && inventorySource(value.source) && (value.character === null || nonEmptyText(value.character)) &&
		(value.source === 'character' ? value.character !== null : value.character === null) && positive(value.quantity) &&
		nullableNonNegative(value.unitSellCopper) && nullableNonNegative(value.totalSellCopper) &&
		['complete', 'partial', 'no_market', 'unavailable', 'invalid'].includes(String(value.sellDepthStatus)) &&
		nonNegative(value.sellCoveredQuantity) && nonNegative(value.sellUncoveredQuantity) &&
		value.sellCoveredQuantity + value.sellUncoveredQuantity === value.quantity &&
		(value.sellDepthStatus === 'complete' ? value.sellUncoveredQuantity === 0 && value.totalSellCopper !== null
			: value.totalSellCopper === null) &&
		nullableNonNegative(value.unitListCopper) && nullableNonNegative(value.totalListCopper) && nonEmptyText(value.name) &&
		(value.type === null || nonEmptyText(value.type)) && (value.rarity === null || nonEmptyText(value.rarity)) &&
		(value.icon === null || nonEmptyText(value.icon)) &&
		(value.unitSellCopper !== null || value.totalSellCopper === null) &&
		(value.unitListCopper !== null || value.totalListCopper === null) &&
		objectDecisionAction(value.recommendation) && objectDecisionReason(value.recommendationReason) &&
		(value.recommendationUntil === null || iso(value.recommendationUntil)) &&
		nullableNonNegative(value.recommendationMissing) &&
		nullablePercentile(value.pricePercentile) && nullableNonNegative(value.priceCoverageDays) &&
		(value.priceQuotedAt === null || iso(value.priceQuotedAt)) && nullableDayUtc(value.priceHistoryLastDay) &&
		legendarySplit(value.reservedQuantity, value.freeQuantity, value.quantity) &&
		nonNegative(value.actionableQuantity) && value.actionableQuantity <= value.quantity;
}

/** Both null (outside any legendary requirement), or both non-negative integers summing to `quantity`. */
function legendarySplit(reserved: unknown, free: unknown, quantity: number): boolean {
	if (reserved === null && free === null) return true;
	return nonNegative(reserved) && nonNegative(free) && reserved + free === quantity;
}

/**
 * Brings frontmatter written by an older build up to the current key set by defaulting
 * the absent `INVENTORY_NOTE_KEYS_ADDED_LATER` to `null`, so the note validates and the
 * plan rewrites it with the missing columns. It only ever ADDS known keys. It only ever
 * sees managed keys: since H18.16 `splitInventoryFrontmatter` sets every other key aside
 * as the user's own before this runs, so a user's property never reads as a corrupt note.
 *
 * `tc_captured_at` is the one key this REMOVES (H14.21): every note written before that
 * migration carries it, and dropping it here is what lets `isInventoryNoteFields` accept
 * the note again instead of treating the field it no longer expects as a conflict. The
 * note gets rewritten once, without it, and its hash is stable from then on.
 */
function migrateInventoryNoteFields(value: unknown): unknown {
	if (!record(value)) return value;
	const migrated: Record<string, unknown> = { ...value };
	delete migrated.tc_captured_at;
	if (!('tc_sell_depth_status' in migrated)) {
		// A legacy total came from one top-of-book quote, not demonstrated depth.
		migrated.tc_total_sell_copper = null;
	}
	for (const key of INVENTORY_NOTE_KEYS_ADDED_LATER) if (!(key in migrated)) {
		// A note this old never had a recommendation computed for it at all: `review` with
		// `price_history_disabled` is the safe placeholder (docs/PRODUCT.md:28, never guess a
		// sell), and this same sync pass immediately rewrites it with the real value from
		// `fieldsFor`, so the placeholder is never actually shown to anyone.
		// tc_reserved_quantity/tc_free_quantity (M4) fall through to the trailing `null`: a note
		// this old predates the legendary-reservation feature entirely. Since H18.1 null/null reads
		// "uncertain", the safe placeholder for the same reason as above, never a guessed split; the
		// same pass rewrites it. tc_price_quoted_at/tc_price_history_last_day (H18.2) likewise.
		// tc_actionable_quantity (H18.14) defaults to 0, "nothing to act on", for the same reason.
		migrated[key] = key === 'tc_sell_depth_status' ? 'unavailable'
			: key === 'tc_sell_covered_quantity' || key === 'tc_actionable_quantity' ? 0
				: key === 'tc_sell_uncovered_quantity' ? migrated.tc_quantity
					: key === 'tc_recommendation' ? 'review'
						: key === 'tc_recommendation_reason' ? 'price_history_disabled' : null;
	}
	return migrated;
}

function isInventoryNoteFields(value: unknown): value is InventoryNoteFields {
	if (!record(value) || !exactKeys(value, INVENTORY_NOTE_KEYS)) return false;
	return value.tc_schema === INVENTORY_NOTE_SCHEMA_VERSION && value.tc_kind === INVENTORY_NOTE_KIND &&
		value.tc_marker === INVENTORY_NOTE_MARKER && typeof value.tc_position_id === 'string' &&
		positive(value.tc_item_id) && inventorySource(value.tc_source) &&
		(value.tc_character === null || nonEmptyText(value.tc_character)) &&
		(value.tc_source === 'character' ? value.tc_character !== null : value.tc_character === null) &&
		nonNegative(value.tc_quantity) && nullableNonNegative(value.tc_unit_sell_copper) &&
		nullableNonNegative(value.tc_total_sell_copper) &&
		['complete', 'partial', 'no_market', 'unavailable', 'invalid'].includes(String(value.tc_sell_depth_status)) &&
		nonNegative(value.tc_sell_covered_quantity) && nonNegative(value.tc_sell_uncovered_quantity) &&
		value.tc_sell_covered_quantity + value.tc_sell_uncovered_quantity === value.tc_quantity &&
		(value.tc_sell_depth_status === 'complete' ? value.tc_sell_uncovered_quantity === 0
			: value.tc_total_sell_copper === null) && nullableNonNegative(value.tc_unit_list_copper) &&
		nullableNonNegative(value.tc_total_list_copper) && typeof value.tc_active === 'boolean' &&
		value.tc_active === (value.tc_quantity > 0) &&
		nonEmptyText(value.tc_item_name) && (value.tc_item_type === null || nonEmptyText(value.tc_item_type)) &&
		(value.tc_item_rarity === null || nonEmptyText(value.tc_item_rarity)) &&
		(value.tc_icon === null || nonEmptyText(value.tc_icon)) &&
		objectDecisionAction(value.tc_recommendation) && objectDecisionReason(value.tc_recommendation_reason) &&
		(value.tc_recommendation_until === null || iso(value.tc_recommendation_until)) &&
		nullableNonNegative(value.tc_recommendation_missing) &&
		nullablePercentile(value.tc_price_percentile) && nullableNonNegative(value.tc_price_coverage_days) &&
		(value.tc_price_quoted_at === null || iso(value.tc_price_quoted_at)) && nullableDayUtc(value.tc_price_history_last_day) &&
		legendarySplit(value.tc_reserved_quantity, value.tc_free_quantity, value.tc_quantity) &&
		nonNegative(value.tc_actionable_quantity) && value.tc_actionable_quantity <= value.tc_quantity &&
		nonEmptyText(value.descripcion);
}

function objectDecisionAction(value: unknown): value is InventoryObjectDecisionAction {
	return (INVENTORY_OBJECT_DECISION_ACTIONS as readonly unknown[]).includes(value);
}

function objectDecisionReason(value: unknown): value is InventoryObjectDecisionReasonCode {
	return (INVENTORY_OBJECT_DECISION_REASON_CODES as readonly unknown[]).includes(value);
}

function isInventoryVaultSyncPlan(value: unknown, configDir: string): value is InventoryVaultSyncPlan {
	return record(value) && value.schemaVersion === INVENTORY_NOTE_SCHEMA_VERSION && normalizeInventoryRoot(value.root, configDir) === value.root &&
		iso(value.capturedAt) && nonNegative(value.positions) && typeof value.canApply === 'boolean' && value.canApply && Array.isArray(value.steps) &&
		value.steps.every((entry) => record(entry) && exactKeys(entry, ['positionId', 'path', 'status', 'before', 'after']) &&
			typeof entry.positionId === 'string' && typeof entry.path === 'string' && normalizeVaultRelativePath(entry.path, { forbiddenPathPrefixes: [configDir] }) === entry.path &&
			['create', 'update', 'unchanged', 'deactivate', 'conflict'].includes(String(entry.status)) &&
			(entry.before === null || typeof entry.before === 'string') && (entry.after === null || typeof entry.after === 'string'));
}

async function ensureFolders(vault: InventoryVaultPort, path: string): Promise<void> {
	const segments = path.split('/');
	for (let index = 1; index <= segments.length; index += 1) {
		const folder = segments.slice(0, index).join('/');
		if (vault.file(folder)) continue;
		try { await vault.createFolder(folder); }
		catch { if (!vault.file(folder)) throw new Error('inventory_folder_unavailable'); }
	}
}

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result) || result < 0) throw new Error('inventory_quantity_overflow');
	return result;
}

function cleanText(value: string): string {
	return value.normalize('NFC').replace(/[\p{Cc}\p{Cs}]+/gu, ' ').trim().slice(0, 256) || 'Unknown item';
}

function normalizeLf(value: string): string { return value.replace(/\r\n?/gu, '\n'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const expected = new Set(keys); return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key)); }
function sameNumbers(left: number[], right: number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function inventorySource(value: unknown): value is InventoryPositionSource { return ['character', 'shared_inventory', 'bank', 'materials'].includes(String(value)); }
function nonEmptyText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.normalize('NFC'); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function nullableNonNegative(value: unknown): value is number | null { return value === null || nonNegative(value); }
function nullablePercentile(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100);
}
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
/** A real UTC calendar day in `YYYY-MM-DD`, or null. */
function nullableDayUtc(value: unknown): value is string | null {
	return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
		&& Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
}
