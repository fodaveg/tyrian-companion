import type { InventoryAdvisorContextualPresentationSource } from '../advisor/inventory-advisor-presentation';
import type { InventoryAdvisorReasonCode } from '../advisor/inventory-advisor-model';
import {
	decideInventoryObjectRoute,
	decideProtectedInventoryObject,
	inventoryObjectRoute,
	isActNowInventoryDecision,
	uncertainInventoryObjectDecision,
	type InventoryObjectDecisionV1,
	type InventoryObjectPositionResultV1,
	type InventoryObjectResultsV1,
	type InventoryObjectRoute,
} from '../advisor/inventory-object-result';
import type { PositionRecommendationSeasonalInput } from '../advisor/inventory-position-recommendation';
import { buildLegendaryReservationGoals, type LegendaryReservationSplit } from '../economy/legendary-goals';
import {
	LEGENDARY_MATERIALS_TABLE,
	legendaryMaterialsTableItemIds,
	type LegendaryMaterialsTableV1,
} from '../economy/legendary-materials';
import { selectDerivedWatchListItemIds, type PriceHistoryDailyV1 } from '../economy/price-history-model';
import { mergePriceHistoryWithSeed } from '../economy/price-seed-history-merge';
import type { PriceSeedV1 } from '../economy/price-seed-model';
import { sellOrWaitForQuantity } from '../economy/sell-or-wait';
import { buildInventoryAdvisorReservationBalance, createReservationPlan } from '../economy/reservation';
import type { ReservationGoal } from '../economy/reservation-model';
import {
	buildInventoryVaultPositionCores,
	comparePositions,
	evaluatePositionTimings,
	INVENTORY_NOTE_SCHEMA_VERSION,
	inventoryLocation,
	inventorySnapshotComplete,
	type InventoryVaultPosition,
	type InventoryVaultPositionCore,
	type InventoryVaultSyncInput,
} from './inventory-vault-sync';

/**
 * Live inputs the moment stage (`recommendPosition`) needs but does not read itself: settings can
 * change between two analyses, so every value is read fresh on each call rather than once at
 * construction time. `readDaily` mirrors the reader `assemblePriceHistory`'s compaction port already
 * exposes (`src/runtime/assemble-price-history.ts`): the local price-history store, read-only, and
 * empty when price history has never been activated.
 */
export interface InventoryPositionRecommendationPort {
	priceHistoryEnabled(): boolean;
	capitalThresholdCopper(): number;
	maxPriceAgeMs(): number;
	priceHistoryWindowDays(): number;
	readDaily(itemId: number, fromDayUtc: string): Promise<readonly PriceHistoryDailyV1[]>;
	/**
	 * Read-only lookup of the datawars2 seed `PriceSeedBulkRefreshService` already cached for
	 * `itemId` (decision 4, M2, `price-seed-cache-store.ts`), or null when nothing has been cached
	 * for it yet. Never triggers a download itself: `refreshPriceSeeds` below is the only member of
	 * this port that reaches the network. Read AFTER `refreshPriceSeeds` runs: a seed this same
	 * analysis just cached for a newly-derived item must be visible to this read, or decision 4's
	 * whole point (never wait 42 days per item) fails on exactly the sync that downloaded it.
	 */
	readCachedSeed(itemId: number): Promise<PriceSeedV1 | null>;
	/**
	 * Replaces the capital-derived slice of the local price-history watch list with `itemIds`
	 * (already ranked and capped by `selectDerivedWatchListItemIds`). SPEC-recomendacion-por-
	 * objeto.md, decision 3, M2: called once per inventory sync, only while price history is on, so a
	 * fresh install and an install with the feature off never touch the watch list at all.
	 */
	updateDerivedWatchList(itemIds: readonly number[]): Promise<void>;
	/**
	 * Seeds datawars2 history, one item at a time, for whichever of `itemIds` lacks a fresh cache
	 * entry, capped per call. Decision 4, M2: called once per inventory sync right after the watch
	 * list update above, and only while price history is on, matching decision 4's "solo detrás del
	 * botón «Sincronizar»".
	 */
	refreshPriceSeeds(itemIds: readonly number[]): Promise<void>;
	/**
	 * Rule (b), M3: this item's entry in the curated festival calendar (its window and the pack's
	 * shared `sellSignal` parameters), or `null` when the item has none, which routes it straight
	 * to rule (c). Synchronous and pure, but still read fresh per analysis: the bundle can expire
	 * between two analyses like any of its other fields.
	 */
	seasonalInputFor(itemId: number): PositionRecommendationSeasonalInput | null;
	/** Rule (a), M4: settings' current target list. Read fresh per analysis, empty by default. */
	legendaryTargetItemIds(): readonly number[];
	/** The curated table `legendaryTargetItemIds` are checked against, or `null` while unavailable. */
	legendaryMaterialsTable(): LegendaryMaterialsTableV1 | null;
	/**
	 * `GET /v2/account/legendaryarmory`'s per-id `count`, or `null` on any failure. Called only
	 * from an explicit analysis (the advisor's refresh, which every inventory sync starts with) and
	 * only while a target is chosen, never from settings or plugin load. `docs/PRODUCT.md:28`
	 * forbids treating "unknown" as "safe to sell": a `null` here is treated as "assume none of the
	 * targets are forged yet" (every target still gets a goal), the SAFER of the two guesses.
	 */
	readLegendaryArmoryCounts(): Promise<ReadonlyMap<number, number> | null>;
}

/**
 * Used whenever a caller (or a test) does not inject a real port: price history is off by
 * default, so no value it never reaches becomes a silent guess.
 */
const DEFAULT_RECOMMENDATION_PORT: InventoryPositionRecommendationPort = {
	priceHistoryEnabled: () => false,
	capitalThresholdCopper: () => 100_000,
	maxPriceAgeMs: () => 900_000,
	priceHistoryWindowDays: () => 180,
	readDaily: async () => [],
	readCachedSeed: async () => null,
	updateDerivedWatchList: async () => undefined,
	refreshPriceSeeds: async () => undefined,
	seasonalInputFor: () => null,
	legendaryTargetItemIds: () => [],
	legendaryMaterialsTable: () => null,
	readLegendaryArmoryCounts: async () => null,
};

const POSITION_RECOMMENDATION_REQUIRED_DAYS = 42;

/** Tie-break between two routes covering the same share of one position: act first, doubt last. */
const ROUTE_PRIORITY: readonly InventoryObjectRoute[] = [
	'sell', 'list', 'vendor', 'salvage', 'open', 'use', 'deposit_material', 'discard_review', 'keep', 'review',
];

/** Goals the plugin derives itself, and the items their coverage leaves uncertain (H18.1). */
export interface InventoryDerivedGoals {
	goals: ReservationGoal[];
	uncertainItemIds: number[];
}

/** One advisor decision's share of one note position. */
interface PositionSlice {
	ref: string;
	route: InventoryObjectRoute;
	quantity: number;
	reasonCodes: readonly InventoryAdvisorReasonCode[];
	protection: 'goal' | 'keep' | null;
}

/**
 * H18.14 + H18.16: the analysis step shared by the advisor view, the inventory notes and the Base.
 *
 * It never captures anything. Everything it reads about the account is the advisor's own evidence
 * (`InventoryAdvisorContextualPresentationSource.input`), so the notes and the view always stand on
 * one capture per analysis. The only I/O is the local price-history store, the seed cache, and,
 * while a legendary target is chosen, `GET /v2/account/legendaryarmory`.
 */
export class InventoryAnalysisService {
	constructor(private readonly recommendation: InventoryPositionRecommendationPort = DEFAULT_RECOMMENDATION_PORT) {}

	/**
	 * Rule (a), M4: the chosen legendary targets as reservation goals, joined to the user's own
	 * goals BEFORE classification (`mergeDerivedReservationGoals`) so the advisor reserves them like
	 * any other goal. Nothing to derive, and no armory read, while no target is chosen.
	 *
	 * H18.1 (audit 2026-09-24 §3.A): a chosen target that is NOT covered is never silently read as
	 * "nothing reserved". `uncertainItemIds` carries the items whose free share is unknown:
	 * - a chosen, unforged target without a table entry → every item any curated entry lists
	 *   (`legendaryMaterialsTableItemIds`), the best available guess at what it needs;
	 * - no curated table at all (unavailable or expired) with an unforged target → every item the
	 *   SHIPPED table (`LEGENDARY_MATERIALS_TABLE`) lists, for the same reason.
	 */
	async derivedGoals(): Promise<InventoryDerivedGoals> {
		const targets = this.recommendation.legendaryTargetItemIds();
		if (targets.length === 0) return { goals: [], uncertainItemIds: [] };
		const table = this.recommendation.legendaryMaterialsTable();
		// A read failure is treated as "assume none of the targets are forged yet" (see the port's
		// own doc comment): the safer of the two guesses, never a silent skip of rule (a).
		const owned = (await this.recommendation.readLegendaryArmoryCounts()) ?? new Map<number, number>();
		if (table === null) {
			const unforged = targets.some((itemId) => (owned.get(itemId) ?? 0) < 1);
			return { goals: [], uncertainItemIds: unforged ? sortedIds(legendaryMaterialsTableItemIds(LEGENDARY_MATERIALS_TABLE)) : [] };
		}
		const { goals, withoutTable } = buildLegendaryReservationGoals(targets, owned, table);
		return { goals, uncertainItemIds: withoutTable.length > 0 ? sortedIds(legendaryMaterialsTableItemIds(table)) : [] };
	}

	/**
	 * The one result per object for this analysis.
	 *
	 * 1. The note rows come from the advisor's own snapshot, catalog, prices and market depth.
	 * 2. Each advisor decision is laid onto the note positions its allocations touch. The part the
	 *    user's goals and keep exceptions protect is the position's reserved quantity; the rest is
	 *    free. This, not a second reservation pass, is what every surface calls reserved.
	 * 3. `recommendPosition` times the free part exactly as before (capital measured per object,
	 *    history, festival windows), and `decideInventoryObjectRoute` combines that moment with the
	 *    advisor's route.
	 * 4. A note position reads the decision of the advisor row that covers most of its free part, so
	 *    the note, the Base and the view row say the same thing.
	 *
	 * `refreshSeeds` is on only for an inventory sync (decision 4: datawars2 seeding "solo detrás
	 * del botón «Sincronizar»"); it runs before any history is read, so a seed just downloaded counts.
	 */
	async evaluate(
		source: InventoryAdvisorContextualPresentationSource,
		uncertainItemIds: readonly number[],
		options: { refreshSeeds: boolean } = { refreshSeeds: false },
	): Promise<InventoryObjectResultsV1> {
		const input = source.input;
		const report = source.result.report;
		// An invalid classification has nothing to time: the view shows it as invalid on its own,
		// and `inventoryVaultSyncInputFromAnalysis` refuses to write notes from it.
		if (report === null) {
			return { version: 1, snapshotId: input.snapshot.snapshotId, decisions: {}, positions: {}, uncertainItemIds: sortedIds(uncertainItemIds) };
		}
		const cores = await coresFromAnalysis(source);
		const capturedAtMs = Date.parse(input.prices.capturedAt);
		const priceHistoryEnabled = this.recommendation.priceHistoryEnabled();
		const capitalThresholdCopper = this.recommendation.capitalThresholdCopper();
		const windowDays = this.recommendation.priceHistoryWindowDays();
		if (priceHistoryEnabled && options.refreshSeeds) {
			const derivedItemIds = selectDerivedWatchListItemIds(
				cores.map((core) => ({ itemId: core.itemId, totalSellCopper: core.totalSellCopper })),
				capitalThresholdCopper,
			);
			await this.recommendation.updateDerivedWatchList(derivedItemIds);
			await this.recommendation.refreshPriceSeeds(derivedItemIds);
		}
		const itemIds = [...new Set(cores.map((core) => core.itemId))];
		// No point reading a store nothing writes to: price history is opt-in, and the moment stage
		// short-circuits before it ever looks at a percentile when it is off.
		const dailyByItem = priceHistoryEnabled
			? await this.readDailyByItem(itemIds, capturedAtMs, windowDays)
			: new Map<number, readonly PriceHistoryDailyV1[]>();

		const explanations = new Map(report.explanations.map((entry) => [entry.ref, entry.reasonCodes]));
		const positionIdByKey = new Map(cores.map((core) => [positionKey(core.itemId, core.source, core.character), core.positionId]));
		const slicesByPosition = new Map<string, PositionSlice[]>();
		const positionsByRef = new Map<string, string[]>();
		for (const line of report.lines) for (const decision of line.decisions) {
			const reasonCodes = explanations.get(decision.explanationRef) ?? [];
			for (const allocation of decision.allocations) {
				const holding = input.snapshot.holdings[holdingIndexOf(allocation.positionRef)];
				if (holding?.kind !== 'item' || holding.state !== 'loose') continue;
				const location = inventoryLocation(holding);
				const positionId = location === null ? undefined
					: positionIdByKey.get(positionKey(holding.itemId, location.source, location.character));
				if (positionId === undefined) continue;
				addSlice(slicesByPosition, positionId, {
					ref: decision.explanationRef, route: inventoryObjectRoute(decision.action), quantity: allocation.quantity,
					reasonCodes, protection: protectionOf(decision.action, reasonCodes),
				});
				positionsByRef.set(decision.explanationRef, [...(positionsByRef.get(decision.explanationRef) ?? []), positionId]);
			}
		}

		const goalByItem = goalsByItem(source);
		const splits = new Map<string, LegendaryReservationSplit>();
		for (const core of cores) {
			const protectedQuantity = (slicesByPosition.get(core.positionId) ?? [])
				.filter((slice) => slice.protection !== null).reduce((total, slice) => total + slice.quantity, 0);
			const reservedQuantity = Math.min(core.quantity, protectedQuantity);
			splits.set(core.positionId, {
				reservedQuantity, freeQuantity: core.quantity - reservedQuantity,
				shortfall: goalByItem.get(core.itemId)?.shortfall ?? 0,
			});
		}
		const uncertain = new Set(uncertainItemIds);
		const timings = evaluatePositionTimings(cores, {
			priceHistoryEnabled,
			capitalThresholdCopper,
			maxPriceAgeMs: this.recommendation.maxPriceAgeMs(),
			priceHistoryWindowDays: windowDays,
			priceHistoryRequiredDays: POSITION_RECOMMENDATION_REQUIRED_DAYS,
			dailyByItem,
			capturedAtMs,
			seasonalInputFor: (itemId) => this.recommendation.seasonalInputFor(itemId),
		}, splits, uncertain);
		const timingByPositionId = new Map(timings.map((entry) => [entry.core.positionId, entry]));

		const decisions: Record<string, InventoryObjectDecisionV1> = {};
		for (const line of report.lines) {
			const goal = goalByItem.get(line.itemId);
			for (const decision of line.decisions) {
				const reasonCodes = explanations.get(decision.explanationRef) ?? [];
				const protection = protectionOf(decision.action, reasonCodes);
				if (protection !== null) {
					decisions[decision.explanationRef] = decideProtectedInventoryObject(
						protection, goal?.legendary === true, goal?.shortfall ?? 0,
					);
					continue;
				}
				if (uncertain.has(line.itemId)) {
					decisions[decision.explanationRef] = uncertainInventoryObjectDecision();
					continue;
				}
				const timing = (positionsByRef.get(decision.explanationRef) ?? [])
					.map((positionId) => timingByPositionId.get(positionId))
					.find((entry) => entry !== undefined && entry.freeQuantity !== null && entry.freeQuantity > 0)?.timing ?? null;
				decisions[decision.explanationRef] = forQuantity(decideInventoryObjectRoute(
					inventoryObjectRoute(decision.action), primaryReason(reasonCodes), timing,
				), decision.quantity);
			}
		}

		const positions: Record<string, InventoryObjectPositionResultV1> = {};
		for (const { core, timing, reservedQuantity, freeQuantity } of timings) {
			const split = { reservedQuantity, freeQuantity };
			const slices = slicesByPosition.get(core.positionId) ?? [];
			const free = slices.filter((slice) => slice.protection === null);
			if (freeQuantity === null) {
				positions[core.positionId] = { ...uncertainInventoryObjectDecision(), ...split, actionableQuantity: 0 };
			} else if (slices.length > 0 && freeQuantity === 0) {
				const goal = goalByItem.get(core.itemId);
				positions[core.positionId] = {
					...decideProtectedInventoryObject(slices.some((slice) => slice.protection === 'goal') ? 'goal' : 'keep',
						goal?.legendary === true, goal?.shortfall ?? 0),
					...split, actionableQuantity: 0,
				};
			} else if (free.length === 0) {
				// No advisor decision covers this position (it cannot happen with one capture, since
				// the advisor allocates every unit): the moment stage stands alone, as it did before.
				positions[core.positionId] = { ...timing, ...split, actionableQuantity: timing.action === 'sell' ? freeQuantity : 0 };
			} else {
				const primary = [...free].sort(comparePrimarySlices)[0]!;
				const actionable = free.filter((slice) => isActNowInventoryDecision(decisions[slice.ref]!.action))
					.reduce((total, slice) => total + slice.quantity, 0);
				positions[core.positionId] = {
					...forQuantity(decisions[primary.ref]!, freeQuantity), ...split, actionableQuantity: Math.min(actionable, freeQuantity),
				};
			}
		}
		return {
			version: 1,
			snapshotId: input.snapshot.snapshotId,
			decisions,
			positions,
			uncertainItemIds: sortedIds(uncertain),
		};
	}

	/** Own capture merged with whatever seed is already cached for the item (decision 4, M2). */
	private async readDailyByItem(
		itemIds: readonly number[],
		capturedAtMs: number,
		windowDays: number,
	): Promise<Map<number, readonly PriceHistoryDailyV1[]>> {
		const fromDayUtc = new Date(Math.max(0, capturedAtMs - windowDays * 86_400_000)).toISOString().slice(0, 10);
		const entries = await Promise.all(
			itemIds.map(async (itemId) => {
				const [daily, seed] = await Promise.all([
					this.recommendation.readDaily(itemId, fromDayUtc),
					this.recommendation.readCachedSeed(itemId),
				]);
				return [itemId, mergePriceHistoryWithSeed(itemId, daily, seed)] as const;
			}),
		);
		return new Map(entries);
	}
}

/**
 * Whether an analysis can rewrite the notes: its result exists, it belongs to the same snapshot,
 * the snapshot is stable and complete in every store (`inventorySnapshotComplete`), the catalog
 * answered, and the capture is no older than the advisor's own snapshot policy. Anything else
 * asks for one more analysis, which the view then shares (H18.16).
 */
export function inventoryAnalysisReadyForNotes(
	source: InventoryAdvisorContextualPresentationSource,
	objects: InventoryObjectResultsV1 | null,
	nowMs: number,
): boolean {
	const snapshot = source.input.snapshot;
	const completedAtMs = Date.parse(snapshot.completedAt);
	return objects !== null && objects.snapshotId === snapshot.snapshotId && source.result.report !== null
		&& inventorySnapshotComplete(snapshot) && !catalogUnavailable(source) && Number.isFinite(completedAtMs)
		&& nowMs - completedAtMs <= source.input.policy.maxSnapshotAgeMs;
}

/**
 * The notes' sync input for one analysis: the note rows valued from the advisor's own evidence,
 * each carrying its share of the object result. No request is made here.
 */
export async function inventoryVaultSyncInputFromAnalysis(
	source: InventoryAdvisorContextualPresentationSource,
	objects: InventoryObjectResultsV1,
): Promise<InventoryVaultSyncInput> {
	const input = source.input;
	if (objects.snapshotId !== input.snapshot.snapshotId) throw new Error('inventory_capture_identity_mismatch');
	if (source.result.report === null) throw new Error('inventory_analysis_invalid');
	if (!inventorySnapshotComplete(input.snapshot) || catalogUnavailable(source)) throw new Error('inventory_capture_incomplete');
	const cores = await coresFromAnalysis(source);
	const positions = cores.map(({ untradeable: _untradeable, ...core }): InventoryVaultPosition => {
		const result = objects.positions[core.positionId];
		if (result === undefined) throw new Error('inventory_capture_identity_mismatch');
		return {
			...core,
			recommendation: result.action,
			recommendationReason: result.reason,
			recommendationUntil: result.until,
			recommendationMissing: result.missing,
			pricePercentile: result.pricePercentile,
			priceCoverageDays: result.priceCoverageDays,
			priceQuotedAt: result.priceQuotedAt,
			priceHistoryLastDay: result.priceHistoryLastDay,
			sellWindowFromDay: result.sellWindowFromDay,
			sellWindowToDay: result.sellWindowToDay,
			sellOrWait: result.sellOrWait,
			reservedQuantity: result.reservedQuantity,
			freeQuantity: result.freeQuantity,
			actionableQuantity: result.actionableQuantity,
		};
	});
	positions.sort(comparePositions);
	return { schemaVersion: INVENTORY_NOTE_SCHEMA_VERSION, capturedAt: input.snapshot.completedAt, locale: input.catalog.locale, positions };
}

function coresFromAnalysis(source: InventoryAdvisorContextualPresentationSource): Promise<InventoryVaultPositionCore[]> {
	const input = source.input;
	return buildInventoryVaultPositionCores(
		input.snapshot, input.catalog, input.prices, input.accountSignals.tradingPostAccess, input.catalog.locale,
		source.discardContext.engineInput.marketDepth,
	);
}

/** The advisor degrades a failed catalog request to "every item unavailable"; notes never use that. */
function catalogUnavailable(source: InventoryAdvisorContextualPresentationSource): boolean {
	const coverage = Object.values(source.input.catalog.coverage.items);
	return Object.keys(source.input.snapshot.ownedByItem).length > 0 && coverage.every((entry) => entry.status === 'unavailable');
}

/** Per item, what the reservation plan of this analysis's goals still lacks and whether a legendary asks for it. */
function goalsByItem(source: InventoryAdvisorContextualPresentationSource): Map<number, { shortfall: number; legendary: boolean }> {
	const result = new Map<number, { shortfall: number; legendary: boolean }>();
	const balance = buildInventoryAdvisorReservationBalance(source.input.snapshot);
	const plan = balance.status === 'ok' ? createReservationPlan({ goals: source.input.goals, balance: balance.balance }) : null;
	if (plan === null || plan.status !== 'ok') return result;
	for (const asset of plan.plan.assets) {
		if (asset.namespace !== 'item' || asset.allocations.length === 0) continue;
		result.set(asset.id, {
			shortfall: asset.shortfall,
			legendary: asset.allocations.some((allocation) => allocation.reason === 'legendary'),
		});
	}
	return result;
}

function protectionOf(
	action: string,
	reasonCodes: readonly InventoryAdvisorReasonCode[],
): 'goal' | 'keep' | null {
	if (action !== 'keep') return null;
	if (reasonCodes.includes('reserved_for_goal')) return 'goal';
	return reasonCodes.includes('user_keep_exception') ? 'keep' : null;
}

/**
 * H18.19: the sell-now-or-wait comparison restated for the units this surface shows. The moment
 * stage compares one note's free quantity; an advisor row covers its own quantity, and a note reads
 * the row that covers most of it, so each states the advantage for exactly its own units.
 */
function forQuantity(decision: InventoryObjectDecisionV1, quantity: number): InventoryObjectDecisionV1 {
	return decision.sellOrWait === null ? decision : { ...decision, sellOrWait: sellOrWaitForQuantity(decision.sellOrWait, quantity) };
}

/** The advisor's leading reason for a decision; every public decision explains itself with one. */
function primaryReason(reasonCodes: readonly InventoryAdvisorReasonCode[]): InventoryAdvisorReasonCode {
	return reasonCodes[0] ?? 'rule_missing';
}

/** Adds one allocation to a position, merging stacks of the same decision into one slice. */
function addSlice(slicesByPosition: Map<string, PositionSlice[]>, positionId: string, slice: PositionSlice): void {
	const slices = slicesByPosition.get(positionId) ?? [];
	const same = slices.find((entry) => entry.ref === slice.ref);
	if (same === undefined) slices.push(slice);
	else same.quantity += slice.quantity;
	slicesByPosition.set(positionId, slices);
}

function comparePrimarySlices(left: PositionSlice, right: PositionSlice): number {
	return right.quantity - left.quantity
		|| ROUTE_PRIORITY.indexOf(left.route) - ROUTE_PRIORITY.indexOf(right.route)
		|| left.ref.localeCompare(right.ref);
}

/** `#/positions/<itemId>/<holdingIndex>`, the advisor's own position reference. */
function holdingIndexOf(positionRef: string): number {
	const match = /^#\/positions\/\d+\/(\d+)$/u.exec(positionRef);
	return match === null ? -1 : Number(match[1]);
}

function positionKey(itemId: number, source: string, character: string | null): string {
	return JSON.stringify([itemId, source, character]);
}

function sortedIds(values: Iterable<number>): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}
