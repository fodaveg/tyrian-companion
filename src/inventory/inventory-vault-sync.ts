import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { GuildWars2Client } from '../account/guild-wars-2-client';
import type { ItemHolding, StorageSnapshot } from '../account/storage-snapshot-model';
import type { StorageSnapshotService } from '../account/storage-snapshot-service';
import { captureInventoryPrices, captureInventoryTradingPostAccess } from '../advisor/inventory-advisor-evidence';
import type { AccountSignalsV1, InventoryPriceSnapshotV1 } from '../advisor/inventory-advisor-model';
import {
	recommendPosition,
	POSITION_RECOMMENDATION_ACTIONS,
	POSITION_RECOMMENDATION_REASON_CODES,
	type PositionRecommendationAction,
	type PositionRecommendationReasonCode,
} from '../advisor/inventory-position-recommendation';
import { sha256Text } from '../assets/managed-asset-hash';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import type { CatalogLocale, CatalogResolution } from '../catalog/public-catalog-model';
import type { PublicCatalogService } from '../catalog/public-catalog-service';
import { errorClassName } from '../core/local-debug-error-details';
import { normalizeVaultRelativePath } from '../core/vault-path';
import {
	isInventoryMarketDepthEvidence,
	valueInstantSellDepth,
	type InventoryMarketDepthEvidenceV1,
} from '../economy/commerce-listings';
import { captureInventoryMarketDepth } from '../economy/commerce-listings-capture';
import { classifyItemLiquidity, isTradingPostAccessible } from '../economy/item-liquidity';
import { selectDerivedWatchListItemIds, type PriceHistoryDailyV1 } from '../economy/price-history-model';
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
	recommendation: PositionRecommendationAction;
	recommendationReason: PositionRecommendationReasonCode;
	recommendationUntil: string | null;
	recommendationMissing: number | null;
	/** `recommendPosition`'s `pricePercentile`/`priceCoverageDays` (SPEC-recomendacion-por-objeto.md, M2). */
	pricePercentile: number | null;
	priceCoverageDays: number | null;
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
	| { status: 'applied' | 'unchanged'; created: number; updated: number; deactivated: number }
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
	tc_recommendation: PositionRecommendationAction;
	tc_recommendation_reason: PositionRecommendationReasonCode;
	tc_recommendation_until: string | null;
	tc_recommendation_missing: number | null;
	tc_price_percentile: number | null;
	tc_price_coverage_days: number | null;
	descripcion: string;
}

const INVENTORY_NOTE_KEYS = [
	'tc_schema', 'tc_kind', 'tc_marker', 'tc_position_id',
	'tc_item_id', 'tc_source', 'tc_character', 'tc_quantity',
	'tc_unit_sell_copper', 'tc_total_sell_copper', 'tc_sell_depth_status', 'tc_sell_covered_quantity',
	'tc_sell_uncovered_quantity', 'tc_unit_list_copper', 'tc_total_list_copper', 'tc_active',
	'tc_item_name', 'tc_item_type',
	'tc_item_rarity', 'tc_icon',
	'tc_recommendation', 'tc_recommendation_reason', 'tc_recommendation_until', 'tc_recommendation_missing',
	'tc_price_percentile', 'tc_price_coverage_days',
	'descripcion',
] as const;

/**
 * Keys that joined `INVENTORY_NOTE_KEYS` after notes were already being written into
 * real Vaults. A note that lacks one of them was written by an older build, not edited
 * by a person, so it is migrated in place (classified `owned`, replanned as `update`)
 * instead of being rejected. Everything else stays a conflict, which is the whole point
 * of the validation: an unknown extra key, a wrong type, a position id or a marker hash
 * that does not match are all still refused rather than overwritten.
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
] as const;

interface OwnedInventoryNote {
	fields: InventoryNoteFields;
	content: string;
}

const SOURCE_CODES: Record<InventoryPositionSource, string> = {
	character: 'c',
	shared_inventory: 's',
	bank: 'b',
	materials: 'm',
};
const INVENTORY_FOLDER = 'Inventory/Positions';
const MARKER_PREFIX = '<!-- tyrian-companion-inventory';

/**
 * Live inputs `recommendPosition` needs but does not read itself: price-history settings can
 * change between two captures of the same long-lived `InventoryVaultCaptureService`, so every
 * value here is read fresh on each `capture()` rather than captured once at construction time.
 * `readDaily` mirrors the reader `assemblePriceHistory`'s compaction port already exposes
 * (`src/runtime/assemble-price-history.ts`): the local price-history store, read-only, and empty
 * when price history has never been activated.
 */
export interface InventoryPositionRecommendationPort {
	priceHistoryEnabled(): boolean;
	capitalThresholdCopper(): number;
	maxPriceAgeMs(): number;
	priceHistoryWindowDays(): number;
	readDaily(itemId: number, fromDayUtc: string): Promise<readonly PriceHistoryDailyV1[]>;
	/**
	 * Replaces the capital-derived slice of the local price-history watch list with `itemIds`
	 * (already ranked and capped by `selectDerivedWatchListItemIds`). SPEC-recomendacion-por-
	 * objeto.md, decision 3, M2: called once per `capture()`, only while price history is on, so a
	 * fresh install and an install with the feature off never touch the watch list at all.
	 */
	updateDerivedWatchList(itemIds: readonly number[]): Promise<void>;
	/**
	 * Seeds datawars2 history, one item at a time, for whichever of `itemIds` lacks a fresh cache
	 * entry, capped per call. Decision 4, M2: called once per `capture()` right after the watch
	 * list update above, and only while price history is on, matching decision 4's "solo detrás del
	 * botón «Sincronizar»".
	 */
	refreshPriceSeeds(itemIds: readonly number[]): Promise<void>;
}

/**
 * Used whenever a caller (or a test) does not inject a real port: price history is off by
 * default, so this reproduces exactly the M1 outcome a fresh install gets — every position
 * comes back `review`/`price_history_disabled` — without any of the four values it will never
 * reach becoming a silent guess.
 */
const DEFAULT_RECOMMENDATION_PORT: InventoryPositionRecommendationPort = {
	priceHistoryEnabled: () => false,
	capitalThresholdCopper: () => 100_000,
	maxPriceAgeMs: () => 900_000,
	priceHistoryWindowDays: () => 180,
	readDaily: async () => [],
	updateDerivedWatchList: async () => undefined,
	refreshPriceSeeds: async () => undefined,
};

const POSITION_RECOMMENDATION_REQUIRED_DAYS = 42;

/**
 * Captures a stable account-wide snapshot and resolves the same public catalog and
 * instant-sale quote model used by the Inventory Advisor. Construction is inert.
 */
export class InventoryVaultCaptureService {
	constructor(
		private readonly client: Pick<GuildWars2Client, 'beginOperation'>,
		private readonly snapshots: Pick<StorageSnapshotService, 'captureWithOperation'>,
		private readonly catalog: Pick<PublicCatalogService, 'resolve'>,
		private readonly publicGateway: PublicCatalogGateway,
		private readonly recommendation: InventoryPositionRecommendationPort = DEFAULT_RECOMMENDATION_PORT,
		private readonly now: () => number = Date.now,
	) {}

	async capture(locale: CatalogLocale): Promise<InventoryVaultSyncInput> {
		const operation = this.client.beginOperation();
		const snapshot = await this.snapshots.captureWithOperation(operation);
		if (!inventorySnapshotComplete(snapshot)) throw new Error('inventory_capture_incomplete');
		const capturedAt = this.now();
		const priceHistoryEnabled = this.recommendation.priceHistoryEnabled();
		const windowDays = this.recommendation.priceHistoryWindowDays();
		const itemIds = [...new Set(
			Object.entries(snapshot.availableByItem).filter(([, quantity]) => quantity > 0).map(([itemId]) => Number(itemId)),
		)];
		const [catalog, prices, tradingPostAccess, marketDepth, dailyByItem] = await Promise.all([
			this.catalog.resolve(snapshot, locale),
			captureInventoryPrices(snapshot, this.publicGateway, capturedAt),
			captureInventoryTradingPostAccess(operation, snapshot.accountId),
			captureInventoryMarketDepth(itemIds, this.publicGateway, capturedAt),
			// No point reading a store nothing writes to: price history is opt-in, and the rule
			// this feeds short-circuits to `review`/`price_history_disabled` before it ever looks
			// at a percentile when it is off.
			priceHistoryEnabled ? this.readDailyByItem(itemIds, capturedAt, windowDays) : Promise.resolve(new Map<number, readonly PriceHistoryDailyV1[]>()),
		]);
		const capitalThresholdCopper = this.recommendation.capitalThresholdCopper();
		const input = await prepareInventoryVaultSyncInput(snapshot, catalog, prices, tradingPostAccess, locale, marketDepth, {
			priceHistoryEnabled,
			capitalThresholdCopper,
			maxPriceAgeMs: this.recommendation.maxPriceAgeMs(),
			priceHistoryWindowDays: windowDays,
			priceHistoryRequiredDays: POSITION_RECOMMENDATION_REQUIRED_DAYS,
			dailyByItem,
			capturedAtMs: capturedAt,
		});
		// Decisions 3 and 4 (SPEC-recomendacion-por-objeto.md §7, M2): both live behind the same
		// "Sincronizar inventario" gate as the percentile itself, and both are pointless with the
		// feature off, since nothing will ever read the watch list or a seed it produces.
		if (priceHistoryEnabled) {
			const derivedItemIds = selectDerivedWatchListItemIds(
				input.positions.map((position) => ({ itemId: position.itemId, totalSellCopper: position.totalSellCopper })),
				capitalThresholdCopper,
			);
			await this.recommendation.updateDerivedWatchList(derivedItemIds);
			await this.recommendation.refreshPriceSeeds(derivedItemIds);
		}
		return input;
	}

	private async readDailyByItem(
		itemIds: readonly number[],
		capturedAtMs: number,
		windowDays: number,
	): Promise<Map<number, readonly PriceHistoryDailyV1[]>> {
		const fromDayUtc = new Date(Math.max(0, capturedAtMs - windowDays * 86_400_000)).toISOString().slice(0, 10);
		const entries = await Promise.all(
			itemIds.map(async (itemId) => [itemId, await this.recommendation.readDaily(itemId, fromDayUtc)] as const),
		);
		return new Map(entries);
	}
}

/** Everything `recommendPosition` needs, resolved once per capture rather than per position. */
export interface InventoryPositionRecommendationInputs {
	capturedAtMs: number;
	priceHistoryEnabled: boolean;
	capitalThresholdCopper: number;
	maxPriceAgeMs: number;
	priceHistoryWindowDays: number;
	priceHistoryRequiredDays: number;
	dailyByItem: ReadonlyMap<number, readonly PriceHistoryDailyV1[]>;
}

/** Matches `DEFAULT_RECOMMENDATION_PORT`: every position comes back `review`/`price_history_disabled`. */
const DEFAULT_RECOMMENDATION_INPUTS: InventoryPositionRecommendationInputs = {
	capturedAtMs: 0,
	priceHistoryEnabled: false,
	capitalThresholdCopper: 100_000,
	maxPriceAgeMs: 900_000,
	priceHistoryWindowDays: 180,
	priceHistoryRequiredDays: 42,
	dailyByItem: new Map(),
};

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
	const positions: InventoryVaultPosition[] = [];
	for (const group of orderedGroups) {
		const item = catalog.items[String(group.itemId)] ?? null;
		const price = priceById.get(group.itemId);
		const liquidity = classifyItemLiquidity(group.holding, item, price === undefined ? 'missing' : 'available');
		const eligible = liquidity.status === 'ok'
			&& isTradingPostAccessible(liquidity.classification.tradingPost, tradingPostAccess, price?.whitelisted === true);
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
		const recommendation = recommendPosition({
			capturedAtMs: recommendationInputs.capturedAtMs,
			priceHistoryEnabled: recommendationInputs.priceHistoryEnabled,
			totalSellCopper,
			capitalThresholdCopper: recommendationInputs.capitalThresholdCopper,
			maxPriceAgeMs: recommendationInputs.maxPriceAgeMs,
			priceHistoryDaily: recommendationInputs.dailyByItem.get(group.itemId) ?? [],
			priceHistoryWindowDays: recommendationInputs.priceHistoryWindowDays,
			priceHistoryRequiredDays: recommendationInputs.priceHistoryRequiredDays,
		});
		positions.push({
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
			unitListCopper,
			// The best ask is a competing listing, not demonstrated buyer capacity.
			totalListCopper: null,
			name: cleanText(item?.name ?? (locale === 'es' ? `Objeto ${String(group.itemId)}` : `Item ${String(group.itemId)}`)),
			type: item?.type ? cleanText(item.type) : null,
			rarity: item?.rarity ? cleanText(item.rarity) : null,
			icon: item?.icon ?? null,
			recommendation: recommendation.action,
			recommendationReason: recommendation.reason,
			recommendationUntil: recommendation.until,
			recommendationMissing: recommendation.missing,
			pricePercentile: recommendation.pricePercentile,
			priceCoverageDays: recommendation.priceCoverageDays,
		});
	}
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

	async preview(root: string, input: InventoryVaultSyncInput): Promise<InventoryVaultSyncPlan> {
		const normalizedRoot = normalizeInventoryRoot(root, this.configDir);
		if (normalizedRoot === null || !isInventoryVaultSyncInput(input)) throw new Error('invalid_inventory_sync_input');
		const folder = inventoryFolder(normalizedRoot);
		const desired = new Map<string, { position: InventoryVaultPosition; path: string; content: string }>();
		for (const position of input.positions) {
			if (position.positionId !== await positionId(position.itemId, position.source, position.character)) {
				throw new Error('invalid_inventory_sync_input');
			}
			const path = `${folder}/${position.positionId}.md`;
			const content = await renderInventoryNote(position, input.locale);
			desired.set(position.positionId, { position, path, content });
		}

		const steps: InventoryVaultSyncStep[] = [];
		const seenOwned = new Set<string>();
		for (const file of this.inventoryFiles(folder)) {
			const content = normalizeLf(await this.vault.read(file));
			const classified = await classifyInventoryNote(content);
			if (classified.status === 'foreign') {
				steps.push(step(file.path, file.path, 'conflict', content, null));
				continue;
			}
			if (classified.status === 'conflict') {
				steps.push(step(classified.positionId ?? file.path, file.path, 'conflict', content, null));
				continue;
			}
			const owned = classified.note;
			const expectedPath = `${folder}/${owned.fields.tc_position_id}.md`;
			if (file.path !== expectedPath || seenOwned.has(owned.fields.tc_position_id)) {
				steps.push(step(owned.fields.tc_position_id, file.path, 'conflict', content, null));
				continue;
			}
			seenOwned.add(owned.fields.tc_position_id);
			const target = desired.get(owned.fields.tc_position_id);
			if (target) {
				steps.push(step(target.position.positionId, file.path,
					content === target.content ? 'unchanged' : 'update', content, target.content));
				continue;
			}
			// The position no longer appears on the account: the note is removed rather than
			// rewritten with `tc_active: false`, including one already left in that stale state
			// by an earlier build, so the Vault converges to zero deactivated notes instead of
			// accumulating them.
			steps.push(step(owned.fields.tc_position_id, file.path, 'deactivate', content, null));
		}

		for (const target of desired.values()) {
			if (seenOwned.has(target.position.positionId)) continue;
			const occupied = this.vault.file(target.path);
			if (occupied) {
				const content = normalizeLf(await this.vault.read(occupied));
				steps.push(step(target.position.positionId, target.path, 'conflict', content, null));
			} else {
				steps.push(step(target.position.positionId, target.path, 'create', null, target.content));
			}
		}
		steps.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
		return {
			schemaVersion: INVENTORY_NOTE_SCHEMA_VERSION,
			root: normalizedRoot,
			capturedAt: input.capturedAt,
			positions: input.positions.length,
			canApply: steps.every((entry) => entry.status !== 'conflict'),
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
		try {
			for (const entry of plan.steps) {
				const file = this.vault.file(entry.path);
				if (entry.before === null) {
					if (file !== null) return { status: 'conflict', message: 'An inventory note appeared after preview.' };
				} else {
					if (file === null || normalizeLf(await this.vault.read(file)) !== entry.before) {
						return { status: 'conflict', message: 'An inventory note changed after preview.' };
					}
				}
			}
			const writes = plan.steps.filter((entry) => entry.status !== 'unchanged');
			completed = total - writes.length;
			onStep?.(completed, total);
			if (writes.length === 0) return { status: 'unchanged', created: 0, updated: 0, deactivated: 0 };
			await ensureFolders(this.vault, inventoryFolder(plan.root));
			let created = 0;
			let updated = 0;
			let deactivated = 0;
			for (const entry of writes) {
				if (entry.status === 'create') {
					if (entry.after === null) return { status: 'invalid', message: 'The inventory plan contains an empty write.' };
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
						if (normalizeLf(await this.vault.read(raced)) !== entry.after) {
							return { status: 'conflict', message: 'An inventory note occupied a planned path.' };
						}
					}
					created += 1;
					completed += 1;
					onStep?.(completed, total);
					continue;
				}
				if (entry.status === 'deactivate') {
					const file = this.vault.file(entry.path);
					if (!file || entry.before === null) return { status: 'conflict', message: 'An inventory note disappeared during apply.' };
					await this.vault.trashFile(file);
					deactivated += 1;
					completed += 1;
					onStep?.(completed, total);
					continue;
				}
				if (entry.after === null) return { status: 'invalid', message: 'The inventory plan contains an empty write.' };
				const file = this.vault.file(entry.path);
				if (!file || entry.before === null) return { status: 'conflict', message: 'An inventory note disappeared during apply.' };
				let applied = false;
				await this.vault.process(file, (current) => {
					if (normalizeLf(current) !== entry.before) return current;
					applied = true;
					return entry.after!;
				});
				const verified = this.vault.file(entry.path);
				if (!applied || !verified || normalizeLf(await this.vault.read(verified)) !== entry.after) {
					return { status: 'conflict', message: 'An inventory note changed during apply.' };
				}
				updated += 1;
				completed += 1;
				onStep?.(completed, total);
			}
			return { status: 'applied', created, updated, deactivated };
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

function inventoryLocation(holding: ItemHolding): { source: InventoryPositionSource; character: string | null } | null {
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

function inventorySnapshotComplete(snapshot: StorageSnapshot): boolean {
	return snapshot.quality === 'stable' &&
		(['characters', 'shared_inventory', 'bank', 'materials'] as const)
			.every((source) => snapshot.coverage.sources[source].status === 'complete') &&
		Object.values(snapshot.coverage.characters).every((coverage) => coverage.status === 'complete');
}

function comparePositions(left: InventoryVaultPosition, right: InventoryVaultPosition): number {
	return left.itemId - right.itemId || left.source.localeCompare(right.source) ||
		(left.character ?? '').localeCompare(right.character ?? '') || left.positionId.localeCompare(right.positionId);
}

/**
 * A stale position is deleted rather than rewritten as inactive (H14.21), so every note
 * this builds describes a position that is still on the account: `tc_active` stays in the
 * schema for the Base filter's sake, but it is always `true` here.
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
		descripcion: locale === 'es' ? 'Existencia de inventario gestionada por Tyrian Companion.' : 'Inventory holding managed by Tyrian Companion.',
	};
}

/**
 * `tc_captured_at` deliberately never lands here (H14.21): it used to make every position's
 * marker hash change on every capture, rewriting all of them even when nothing about the
 * holding itself moved. The Base column that showed it now reads `file.mtime` instead.
 */
async function renderInventoryNote(position: InventoryVaultPosition, locale: CatalogLocale): Promise<string> {
	const fields = fieldsFor(position, locale);
	const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd();
	const heading = cleanText(position.name).replace(/^[#]/u, '\\$&');
	// Piloto H9.2: a fixed, tiny allowlist of items also gets a managed price-history
	// code block. Every other position keeps the exact body it always had.
	const priceHistoryBlock = priceHistoryNoteBlockMarkdown(position.itemId, fields.tc_item_name);
	const body = priceHistoryBlock === null
		? `# ${heading}\n\n${fields.descripcion}\n`
		: `# ${heading}\n\n${fields.descripcion}\n\n${priceHistoryBlock}\n`;
	const markerBase = markerLine(position.positionId, null);
	const unsigned = `---\n${frontmatter}\n---\n${markerBase}\n${body}`;
	const hash = await sha256Text(unsigned);
	return `---\n${frontmatter}\n---\n${markerLine(position.positionId, hash)}\n${body}`;
}

function markerLine(position: string, hash: string | null): string {
	const base = `${MARKER_PREFIX} schema=${String(INVENTORY_NOTE_SCHEMA_VERSION)} marker=${INVENTORY_NOTE_MARKER} position=${position}`;
	return hash === null ? `${base} -->` : `${base} hash=${hash} -->`;
}

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
	const markerWithHash = marker[0];
	const unsigned = content.replace(markerWithHash, markerLine(positionId, null));
	if (await sha256Text(unsigned) !== marker[4]) return { status: 'conflict', positionId };
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/u);
	if (!frontmatter) return { status: 'conflict', positionId };
	let parsed: unknown;
	try { parsed = parseYaml(frontmatter[1]!); }
	catch { return { status: 'conflict', positionId }; }
	const fields = migrateInventoryNoteFields(parsed);
	if (!isInventoryNoteFields(fields) || fields.tc_position_id !== positionId) return { status: 'conflict', positionId };
	return { status: 'owned', note: { fields, content } };
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
		positionRecommendationAction(value.recommendation) && positionRecommendationReason(value.recommendationReason) &&
		(value.recommendationUntil === null || iso(value.recommendationUntil)) &&
		nullableNonNegative(value.recommendationMissing) &&
		nullablePercentile(value.pricePercentile) && nullableNonNegative(value.priceCoverageDays);
}

/**
 * Brings frontmatter written by an older build up to the current key set by defaulting
 * the absent `INVENTORY_NOTE_KEYS_ADDED_LATER` to `null`, so the note validates and the
 * plan rewrites it with the missing columns. It only ever ADDS known keys: a key we
 * never wrote is left in place so that `isInventoryNoteFields` still rejects it, which
 * is what keeps a hand-edited note a conflict.
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
		migrated[key] = key === 'tc_sell_depth_status' ? 'unavailable'
			: key === 'tc_sell_covered_quantity' ? 0
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
		positionRecommendationAction(value.tc_recommendation) && positionRecommendationReason(value.tc_recommendation_reason) &&
		(value.tc_recommendation_until === null || iso(value.tc_recommendation_until)) &&
		nullableNonNegative(value.tc_recommendation_missing) &&
		nullablePercentile(value.tc_price_percentile) && nullableNonNegative(value.tc_price_coverage_days) &&
		nonEmptyText(value.descripcion);
}

function positionRecommendationAction(value: unknown): value is PositionRecommendationAction {
	return (POSITION_RECOMMENDATION_ACTIONS as readonly unknown[]).includes(value);
}

function positionRecommendationReason(value: unknown): value is PositionRecommendationReasonCode {
	return (POSITION_RECOMMENDATION_REASON_CODES as readonly unknown[]).includes(value);
}

function isInventoryVaultSyncPlan(value: unknown, configDir: string): value is InventoryVaultSyncPlan {
	return record(value) && value.schemaVersion === INVENTORY_NOTE_SCHEMA_VERSION && normalizeInventoryRoot(value.root, configDir) === value.root &&
		iso(value.capturedAt) && nonNegative(value.positions) && typeof value.canApply === 'boolean' && value.canApply && Array.isArray(value.steps) &&
		value.steps.every((entry) => record(entry) && exactKeys(entry, ['positionId', 'path', 'status', 'before', 'after']) &&
			typeof entry.positionId === 'string' && typeof entry.path === 'string' && normalizeVaultRelativePath(entry.path, { forbiddenPathPrefixes: [configDir] }) === entry.path &&
			['create', 'update', 'unchanged', 'deactivate'].includes(String(entry.status)) &&
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
