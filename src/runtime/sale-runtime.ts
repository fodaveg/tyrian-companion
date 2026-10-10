/**
 * The Sale tab's runtime (DE-01, step 2): the Venta view model and its hero card verdict, the
 * explicit Sale refresh, the datawars2 seed passes of an action (the missing seeds inside it, the
 * stale copies once it has ended), the cached seed reads and the sell signal's compaction hook.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * building the transports and the services that download (`priceSeedBulkRefresh`, `sellSignal`),
 * keeps the price history, and hands everything this reads through `SaleRuntimePort`. The getters
 * below carry the names of the core's own fields, so the moved code reads as it did there.
 */
import type { PositionRecommendationV1 } from '../advisor/inventory-position-recommendation';
import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
import { recommendPosition } from '../advisor/inventory-position-recommendation';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { startLocalDebugAction, type LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import { HALLOWEEN_FESTIVAL_ANCHORS } from '../economy/models/halloween-festival-anchors';
import type { PriceHistoryDailyV1 } from '../economy/price-history-model';
import type { PriceHistoryRuntime } from '../economy/price-history-runtime';
import type {
	PriceSeedBulkRefreshOutcome,
	PriceSeedBulkRefreshService,
	PriceSeedQueueCoverage,
} from '../economy/price-seed-bulk-refresh';
import { mergePriceHistoryWithSeed } from '../economy/price-seed-history-merge';
import type { PriceSeedV1 } from '../economy/price-seed-model';
import { festivalAnchorStartMs } from '../economy/seasonal-window';
import { SELL_SIGNAL_REFERENCE_DAYS } from '../economy/sell-signal';
import type { SellSignalRuntime, SellSignalRuntimeState } from '../economy/sell-signal-runtime';
import { HALLOWEEN_PRICE_ALERT_ITEM_ID } from '../halloween/halloween-price-alert';
import type { TyrianPriceHistoryPort, TyrianPriceSeedCache } from '../host/tyrian-host';
import { POSITION_RECOMMENDATION_REQUIRED_DAYS } from '../inventory/inventory-analysis';
import type { InventoryAdvisorViewModel, InventoryAdvisorViewRow } from '../ui/inventory-advisor-view-model';
import {
	buildSaleViewModel,
	computeListingNetCopper,
	type SaleSourceCalendarEntry,
	type SaleSourceDecision,
	type SaleSourceRow,
	type SaleViewModel,
} from '../ui/sale-view-model';
import { consulting, fireAndForgetLocal, refusedInConsult } from './core-actions';
import {
	FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS,
	FESTIVAL_ANCHORS,
	liveRulesExpiredAtMsFromLoad,
	resolveSaleCalendarCandidateSpan,
	resolveSaleSeasonalInputFor,
	saleBagSlotsUsed,
	saleInstantSellNetFor,
	saleOpenVsSellCopper,
	saleSourceRowFromAdvisorRow,
} from './core-sale-helpers';

/**
 * The part of an advisor analysis the Sale tab reads: the live price snapshot it was built from
 * (bid, ask and its capture time), the storage snapshot and the character whose bags it measured.
 * `InventoryAdvisorPresentationController.analysis` answers a superset of it.
 */
export interface SaleAdvisorAnalysis {
	readonly source: {
		readonly input: {
			readonly prices: {
				readonly capturedAt?: string;
				readonly items: ReadonlyArray<{
					readonly itemId: number;
					readonly bid?: { readonly unitCopper: number } | null;
					readonly ask?: { readonly unitCopper: number } | null;
				}>;
			};
			readonly snapshot?: StorageSnapshot;
		};
	};
	readonly objects?: {
		readonly storageSpace?: { readonly bagCharacter?: { readonly character: string } | null } | null;
	} | null;
}

/**
 * Everything `SaleRuntime` reads from the core and asks of it. Each member carries the name of the
 * core's own field or method, read live: a service the core builds in `initializeRuntime`, a
 * setting changed or the device turned to consult is seen as it stands at the moment of the read.
 */
export interface SaleRuntimePort {
	readonly settings: Pick<
		TyrianSettings,
		'language' | 'priceHistoryEnabled' | 'priceHistoryDailyRetentionDays' | 'recommendationCapitalThresholdCopper'
	>;
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** True from the moment the plugin starts to unload. */
	readonly unloaded: boolean;
	/** R1b: only an explicit `consult` stops the seed downloads and refuses the Sale refresh. */
	readonly collectorMode: CollectorMode | undefined;
	/** The vault the seed cache is keyed by; null until `initializeRuntime` has resolved it. */
	readonly vaultId: string | null;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** Only to open the read-only seed cache connection; the core keeps every other capability. */
	readonly host: { readonly priceHistory: Pick<TyrianPriceHistoryPort, 'openSeedCache'> };
	readonly inventoryAdvisor: { analysis(options?: { readOnly?: boolean }): SaleAdvisorAnalysis | null };
	readonly priceHistory: Pick<PriceHistoryRuntime, 'readDaily'> | null;
	/** Built by the core with the datawars2 transport and the shared download queue. */
	readonly priceSeedBulkRefresh: Pick<PriceSeedBulkRefreshService, 'run'> | null;
	/** Built by the core with the price history; null when the curated pack is unavailable. */
	readonly sellSignal: Pick<SellSignalRuntime, 'getState' | 'ensureSeed' | 'evaluate'> | null;
	/** Says once that this device only consults (`refusedInConsult`). */
	notifyConsultMode(): void;
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
	renderInventoryAdvisorViews(): void;
	/** The advisor refresh a Sale refresh ends with; it also recomputes the hero card's verdict. */
	refreshInventoryAdvisor(): Promise<void>;
}

export class SaleRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: SaleRuntimePort) {}

	/**
	 * The Sale tab's hero card verdict: `recommendPosition` run directly for the Saco (36038), the
	 * SAME rule every other row uses, even though the advisor's own route for it is `open` (a
	 * curated container) and therefore carries no timing of its own (`decideInventoryObjectRoute`
	 * stands the route instead). Refreshed alongside every `refreshInventoryAdvisor()`; null until
	 * the first one completes.
	 */
	private saleHeroTiming: PositionRecommendationV1 | null = null;
	private saleHeroTimingFlight: Promise<void> | null = null;
	/**
	 * H18.17: the last `run()`'s queue coverage, across the WHOLE derived watch list (not only the
	 * slice one run reached). `null` until the first "Sincronizar inventario" completes a pass.
	 * Read-only, in-memory; `getPriceSeedQueueCoverage` is the only thing that reads it.
	 */
	private priceSeedQueueCoverage: PriceSeedQueueCoverage | null = null;
	/**
	 * 1 oct 2026: the stale copies one explicit action left for after its end, until that same
	 * action ends and starts them (`startPriceSeedDeferredPass`). One slot: an action that finds a
	 * deferred pass waiting here or already running (`priceSeedDeferredPass`) leaves none of its own.
	 * Only the action that left a request holds it, so nothing else can start it; it is dropped,
	 * unstarted, when the opt-in is switched off, when an advisor refresh is refused in consult, when
	 * its action ends on a device that has turned to consult, and on unload.
	 */
	private priceSeedDeferredRequest: PriceSeedDeferredRequest | null = null;
	/** The deferred pass in flight, owned by the core and detached from the action that left it. */
	private priceSeedDeferredPass: Promise<void> | null = null;
	/**
	 * The inventory sync action in progress (`runPriceSeedSyncAction`), or null: what is left of its
	 * cap of 25 across every analysis it runs, and the request it has in the slot.
	 */
	private priceSeedSyncAction: PriceSeedSyncAction | null = null;
	/**
	 * Counts the seed passes of inventory syncs. A deferred pass rewrites the coverage line only
	 * while the pass that left it is still the newest one.
	 */
	private priceSeedSyncGeneration = 0;
	/**
	 * Read-only connection to the same `tyrian-companion-price-seed-cache` database
	 * `priceSeedBulkRefresh` writes into, for `previewInventorySync`'s recommendation port
	 * (decision 4, M2). Opened lazily on first read, same pattern as `priceHistoryPanelSeed`'s own
	 * `ensureStore`; never opened from `onload`, and never used to write.
	 */
	private priceSeedCacheReader: TyrianPriceSeedCache | null = null;
	private priceSeedCacheReaderOpening: Promise<TyrianPriceSeedCache | null> | null = null;

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): SaleRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get unloaded(): boolean { return this.port.unloaded; }
	/** Public, like the core's: `consulting` and `refusedInConsult` read it from `this`. */
	get collectorMode(): CollectorMode | undefined { return this.port.collectorMode; }
	private get vaultId(): string | null { return this.port.vaultId; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get host(): SaleRuntimePort['host'] { return this.port.host; }
	private get inventoryAdvisor(): SaleRuntimePort['inventoryAdvisor'] { return this.port.inventoryAdvisor; }
	private get priceHistory(): SaleRuntimePort['priceHistory'] { return this.port.priceHistory; }
	private get priceSeedBulkRefresh(): SaleRuntimePort['priceSeedBulkRefresh'] { return this.port.priceSeedBulkRefresh; }
	private get sellSignal(): SaleRuntimePort['sellSignal'] { return this.port.sellSignal; }
	/** Public, like the core's: `refusedInConsult` calls it on `this`. */
	notifyConsultMode(): void { this.port.notifyConsultMode(); }
	private getInventoryAdvisorViewModel(): InventoryAdvisorViewModel { return this.port.getInventoryAdvisorViewModel(); }
	private renderInventoryAdvisorViews(): void { this.port.renderInventoryAdvisorViews(); }
	private async refreshInventoryAdvisor(): Promise<void> { await this.port.refreshInventoryAdvisor(); }

	getSaleLocale() {
		return this.settings.language;
	}

	/**
	 * The Venta tab. A synchronous read, like `getInventoryAdvisorViewModel`: it reuses the
	 * SAME already-computed advisor model (names, icons, per-position `decision`, `marketComparison`
	 * net values, storage space) rather than a second engine, adding only the raw bid per unit the
	 * advisor row itself does not carry (`this.inventoryAdvisor.analysis()`'s own price snapshot,
	 * the same one that model was built from) and the curated festival calendar's raw candidate
	 * windows (`inventory-advisor-builtin-bundle.ts` + `HALLOWEEN_FESTIVAL_ANCHORS`), which the
	 * advisor model does not carry at all.
	 */
	getSaleViewModel(): SaleViewModel {
		const nowMs = Date.now();
		if (!this.runtimeReady) {
			return buildSaleViewModel({
				status: 'loading', nowMs, festivalStartMs: null,
				maxPriceAgeMs: FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS, hero: null, rows: [], calendar: [],
			});
		}
		const advisorModel = this.getInventoryAdvisorViewModel();
		// R1b (Hebra's report, 28 sep 2026): `refreshSale` refuses in consult (`refusedInConsult`)
		// and the advisor refresh is only ever the player's manual action on the Inventory tab, so a
		// consult device that captured nothing this session leaves `advisorModel.status` at `loading`
		// and nothing here is going to move it. Venta must not sit in "Leyendo…" waiting for a
		// refresh that will not run; it reaches a final, explained state instead, which names the
		// manual refresh that does fill it.
		if (consulting(this) && advisorModel.status === 'loading') {
			return buildSaleViewModel({
				status: 'empty', consultOnly: true, nowMs, festivalStartMs: null,
				maxPriceAgeMs: FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS, hero: null, rows: [], calendar: [],
			});
		}
		const bundleLoad = inventoryAdvisorBuiltinBundleProvider.load(new Date(nowMs).toISOString());
		const maxPriceAgeMs = bundleLoad.status === 'available'
			? bundleLoad.bundle.policy.maxPriceAgeMs : FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS;
		// H18.34: checked fresh against `nowMs` on every call, never against `advisorModel`'s own
		// `status` (which only updates on an explicit advisor refresh and can still read `ready` well
		// after the curated bundle's `validUntil` — the silent "sin datos" this field exists to fix).
		const rulesExpiredAtMs = liveRulesExpiredAtMsFromLoad(bundleLoad);
		const festivalStartMs = festivalAnchorStartMs(HALLOWEEN_FESTIVAL_ANCHORS, new Date(nowMs).getUTCFullYear());
		const rowsByItemId = new Map<number, InventoryAdvisorViewRow>();
		for (const group of advisorModel.groups) for (const row of group.rows) {
			if (!rowsByItemId.has(row.itemId)) rowsByItemId.set(row.itemId, row);
		}
		const analysis = this.inventoryAdvisor.analysis({ readOnly: true });
		const bidByItemId = new Map<number, number | null>(
			(analysis?.source.input.prices.items ?? []).map((entry) => [entry.itemId, entry.bid?.unitCopper ?? null]),
		);
		// Review fix (coordinator, round 2): the Saco's own "Publicar" figure needs the account's real
		// ask, same live snapshot the bid already comes from.
		const askByItemId = new Map<number, number | null>(
			(analysis?.source.input.prices.items ?? []).map((entry) => [entry.itemId, entry.ask?.unitCopper ?? null]),
		);
		const calendar: SaleSourceCalendarEntry[] = [];
		const calendarItemIds = new Set<number>();
		if (bundleLoad.status === 'available') {
			for (const entry of bundleLoad.bundle.festivalCalendar.entries) {
				calendarItemIds.add(entry.itemId);
				const advisorRow = rowsByItemId.get(entry.itemId) ?? null;
				calendar.push({
					itemId: entry.itemId,
					name: advisorRow?.name ?? String(entry.itemId),
					icon: advisorRow?.icon ?? null,
					candidates: entry.candidates
						.map((candidate) => resolveSaleCalendarCandidateSpan(candidate, FESTIVAL_ANCHORS, nowMs))
						.filter((span): span is { fromDay: string; toDay: string } => span !== null),
				});
			}
		}
		const heroRow = rowsByItemId.get(HALLOWEEN_PRICE_ALERT_ITEM_ID) ?? null;
		const hero = this.buildSaleHeroInput(
			heroRow, bidByItemId.get(HALLOWEEN_PRICE_ALERT_ITEM_ID) ?? null, askByItemId.get(HALLOWEEN_PRICE_ALERT_ITEM_ID) ?? null,
		);
		const rows: SaleSourceRow[] = [];
		for (const [itemId, row] of rowsByItemId) {
			if (itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID || !calendarItemIds.has(itemId)) continue;
			if (row.decision?.action === 'hold_for_legendary') continue;
			rows.push({ ...saleSourceRowFromAdvisorRow(row, bidByItemId.get(itemId) ?? null),
				bagSlotsUsed: saleBagSlotsUsed(row, analysis?.source.input.snapshot ?? null, analysis?.objects?.storageSpace?.bagCharacter?.character ?? null),
			});
		}
		return buildSaleViewModel({
			status: advisorModel.status,
			...(advisorModel.blockedReason === undefined ? {} : { blockedReason: advisorModel.blockedReason }),
			nowMs, festivalStartMs, maxPriceAgeMs, rulesExpiredAtMs,
			...(advisorModel.storageSpace === undefined ? {} : { storageSpace: advisorModel.storageSpace }),
			hero, rows, calendar,
		});
	}

	/**
	 * The Saco de Halloween's own hero card.
	 *
	 * Review fix (26 sep 2026): the verdict now comes from `recommendPosition` (`this.saleHeroTiming`,
	 * refreshed alongside `refreshInventoryAdvisor`), the SAME rule every other Sale row uses, even
	 * though the advisor's own route for the Saco is `open` and therefore carries no timing of its
	 * own (`decideInventoryObjectRoute` stands the route instead, discarding it — see
	 * `saleSourceRowFromAdvisorRow`'s doc comment). The account-level sell signal
	 * (`getSellSignalState`) stays only for the secondary "umbral del año" figure, never the verdict.
	 */
	private buildSaleHeroInput(
		row: InventoryAdvisorViewRow | null, bidCopper: number | null, askCopper: number | null = null,
	): (SaleSourceRow & {
		yearThresholdCopper: number | null;
		openVsSell: { openCopper: number; sellCopper: number } | null;
	}) | null {
		const analysis = this.inventoryAdvisor.analysis({ readOnly: true });
		const timing = this.saleHeroTiming;
		const projection = this.getSellSignalState()?.projection ?? null;
		if (row === null && timing === null) return null;
		const resolvedBid = bidCopper ?? (projection?.status === 'decided' ? projection.bidCopper : null);
		const decision: SaleSourceDecision | null = timing === null || timing.action === 'hold_for_legendary'
			? null
			: {
				action: timing.action, reason: timing.reason, until: timing.until,
				priceQuotedAt: timing.priceQuotedAt, sellWindowFromDay: timing.sellWindowFromDay, sellWindowToDay: timing.sellWindowToDay,
			};
		return {
			id: row?.id ?? `#/sale/hero/${String(HALLOWEEN_PRICE_ALERT_ITEM_ID)}`,
			itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID,
			name: row?.name ?? 'Saco de Halloween',
			icon: row?.icon ?? null,
			ownedQuantity: row?.ownedQuantity ?? 0,
			slotsUsed: row?.allocations.length ?? 0,
			bagSlotsUsed: row === null ? null : saleBagSlotsUsed(row, analysis?.source.input.snapshot ?? null, analysis?.objects?.storageSpace?.bagCharacter?.character ?? null),
			// The Saco is a container, never a bankable material.
			materialStorageEligible: false,
			decision,
			bidCopper: resolvedBid,
			instantSellNetCopper: row === null ? null : saleInstantSellNetFor(row),
			// Review fix (coordinator, round 2): same fallback as the bid above, from the account's own
			// live ask — the advisor never computes `marketComparison` for a container (its route is
			// always `open`, never `sell`/`list`), so this was the only field the hero could ever
			// fill on its own account data and never did.
			listingNetCopper: row?.marketComparison?.listingCopper
				?? computeListingNetCopper(askCopper, row?.ownedQuantity ?? 0),
			yearThresholdCopper: projection?.status === 'decided' ? projection.sellThresholdCopper : null,
			openVsSell: saleOpenVsSellCopper(row?.containerEconomy),
		};
	}

	/**
	 * Recomputes the Saco's `recommendPosition` verdict for the Sale tab's hero card. Read-only
	 * price history (never seeds, never captures on its own): `readDaily` is the same local store
	 * `sell-signal-runtime.ts`'s own compaction hook reads, and the datawars2 seed is read, never
	 * downloaded, from whatever `priceSeedBulkRefresh` already cached (mirrors
	 * `InventoryAnalysisService`'s own `readCachedSeed` port).
	 */
	async refreshSaleHeroTiming(): Promise<void> {
		if (this.saleHeroTimingFlight !== null) { await this.saleHeroTimingFlight; return; }
		const flight = this.computeSaleHeroTiming().finally(() => { this.saleHeroTimingFlight = null; });
		this.saleHeroTimingFlight = flight;
		await flight;
	}

	private async computeSaleHeroTiming(): Promise<void> {
		const nowMs = Date.now();
		const seasonal = resolveSaleSeasonalInputFor(HALLOWEEN_PRICE_ALERT_ITEM_ID, nowMs);
		if (seasonal === null) { this.saleHeroTiming = null; return; }
		const bundleLoad = inventoryAdvisorBuiltinBundleProvider.load(new Date(nowMs).toISOString());
		const maxPriceAgeMs = bundleLoad.status === 'available'
			? bundleLoad.bundle.policy.maxPriceAgeMs : FALLBACK_RECOMMENDATION_MAX_PRICE_AGE_MS;
		const advisorModel = this.getInventoryAdvisorViewModel();
		let ownedQuantity = 0;
		for (const group of advisorModel.groups) {
			const row = group.rows.find((candidate) => candidate.itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID);
			if (row !== undefined) { ownedQuantity = row.ownedQuantity; break; }
		}
		// `recommendPosition`'s `freeQuantity: 0` means "a goal reserves every unit"; the Saco is
		// never part of a legendary goal, so owning none is shown as the view's own "0 unidades"
		// state, never fed into the function as a false reservation.
		if (ownedQuantity <= 0) { this.saleHeroTiming = null; return; }
		const analysis = this.inventoryAdvisor.analysis();
		const todayBidCopper = analysis?.source.input.prices.items
			.find((entry) => entry.itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID)?.bid?.unitCopper ?? null;
		// Z8: the bid is as old as the analysis it comes from. A failed refresh keeps the previous
		// analysis, so dating the verdict `nowMs` would present a stale bid as just read.
		const analysisCapturedAtMs = todayBidCopper === null ? Number.NaN : Date.parse(analysis?.source.input.prices.capturedAt ?? '');
		const quotedAtMs = Number.isFinite(analysisCapturedAtMs) ? Math.min(analysisCapturedAtMs, nowMs) : nowMs;
		const windowDays = this.settings.priceHistoryDailyRetentionDays;
		const fromDayUtc = new Date(Math.max(0, nowMs - windowDays * 86_400_000)).toISOString().slice(0, 10);
		const daily = await (this.priceHistory?.readDaily(HALLOWEEN_PRICE_ALERT_ITEM_ID, fromDayUtc) ?? Promise.resolve([]));
		const seed = this.vaultId === null ? null : await this.readCachedPriceSeed(this.vaultId, HALLOWEEN_PRICE_ALERT_ITEM_ID);
		const merged = mergePriceHistoryWithSeed(HALLOWEEN_PRICE_ALERT_ITEM_ID, daily, seed);
		this.saleHeroTiming = recommendPosition({
			capturedAtMs: quotedAtMs,
			priceHistoryEnabled: this.settings.priceHistoryEnabled,
			// Never read: the Saco always has a calendar entry, so rule (b) (`evaluateSeasonalRule`)
			// decides before rule (c)'s capital-threshold check ever looks at this value.
			totalSellCopper: null,
			capitalThresholdCopper: this.settings.recommendationCapitalThresholdCopper,
			maxPriceAgeMs,
			priceHistoryDaily: merged,
			priceHistoryWindowDays: windowDays,
			priceHistoryRequiredDays: POSITION_RECOMMENDATION_REQUIRED_DAYS,
			seasonal,
			legendaryShortfall: null,
			freeQuantity: ownedQuantity,
			todayBidCopper,
			untradeable: false,
		});
	}

	/**
	 * The inventory sync's own seed pass (decision 4), behind the analysis port's `refreshPriceSeeds`.
	 * A method rather than a closure of `initializeRuntime` so the pass can be driven on its own.
	 *
	 * 1 oct 2026: it waits only for the items with NO seed, so the analysis that follows reads them.
	 * The copies past their 24 h are left for the end of the sync action (`runPriceSeedSyncAction`).
	 *
	 * A sync can analyse twice (`inventoryAnalysisForNotes`). The second pass spends what the first
	 * left of the action's cap, and its list replaces the first one's as the action's stale copies;
	 * if it leaves none of its own, the first one's are kept, within what is left of the cap.
	 * Outside a sync action (the manual preview's recovery read) there is nobody to start a deferred
	 * pass, so none is left: only the missing seeds are requested, with a cap of their own.
	 */
	async refreshPriceSeedsForSync(itemIds: readonly number[]): Promise<void> {
		const span = startLocalDebugAction(this.localDebugActions ?? undefined, {
			component: 'price_history', action: 'price_history_load_series', state: 'price_seed_bulk_refresh',
		});
		const action = this.priceSeedSyncAction ?? null;
		// From here on a deferred pass of an older sync list no longer speaks for the coverage line.
		this.priceSeedSyncGeneration += 1;
		const generation = this.priceSeedSyncGeneration;
		// Read before waiting: the missing seeds queue behind a deferred pass that is alive now, and
		// by the time they are served that pass is over.
		const aliveOnArrival = this.priceSeedDeferredAliveBesides(action?.request ?? null);
		// Null on the action's first analysis, which has the whole cap.
		const budget = action?.remaining ?? null;
		try {
			const outcome = await this.priceSeedBulkRefresh?.run(itemIds, undefined, {
				scope: 'missing', allowed: () => this.priceSeedDownloadsAllowed(),
				...(budget === null ? {} : { budget }),
			});
			if (outcome !== undefined && !this.unloaded) {
				// A stale copy is a seed too, so this coverage is already the whole list's: the deferred
				// pass recomputes it over the same list and can only confirm it or move it forward.
				this.priceSeedQueueCoverage = outcome.queueCoverage;
				if (action !== null && action === this.priceSeedSyncAction) {
					const remaining = outcome.deferredBudget ?? 0;
					action.remaining = remaining;
					// What an earlier analysis of this action left, if it is still waiting in the slot.
					const earlier = action.request !== null && this.priceSeedDeferredRequest === action.request ? action.request : null;
					if (earlier !== null) this.priceSeedDeferredRequest = null;
					// This analysis's list is the action's now: what an earlier analysis left gives way to it.
					let request = aliveOnArrival ? null : this.leavePriceSeedDeferredRequest(itemIds, outcome, generation);
					if (request === null && earlier !== null && remaining > 0) {
						// It left none of its own, so the earlier one stays, with what the action has left
						// of its cap NOW. Its generation is the older one: it does not rewrite the coverage.
						request = { ...earlier, budget: Math.min(earlier.budget, remaining) };
						this.priceSeedDeferredRequest = request;
					}
					action.request = request;
				}
			}
			span.success('refreshed', { itemCount: itemIds.length });
		} catch (error) {
			span.failure(error, 'storage_failure', 'store_unavailable', { itemCount: itemIds.length });
			throw error;
		}
	}

	/**
	 * What every seed download stands on, asked again when a deferred pass starts and before each
	 * item of any pass: the opt-in, and a device that still collects (the same test `refusedInConsult`
	 * makes). A device turned to consult under an action stops that action's downloads at the next item.
	 */
	private priceSeedDownloadsAllowed(): boolean {
		return this.settings.priceHistoryEnabled && !consulting(this);
	}

	/**
	 * Whether a deferred pass other than `own` request is waiting for its action to finish, or
	 * already downloading. Asked when an action ARRIVES: one that finds a pass alive leaves none of
	 * its own, even if that pass is over by the time its missing seeds have been served.
	 */
	private priceSeedDeferredAliveBesides(own: PriceSeedDeferredRequest | null): boolean {
		const waiting = this.priceSeedDeferredRequest ?? null;
		return (waiting !== null && waiting !== own) || Boolean(this.priceSeedDeferredPass);
	}

	/**
	 * Leaves the stale copies of one action for after its end: nothing is requested here. Only
	 * when the `missing` phase left both stale copies and part of the action's cap of 25, and only
	 * into an EMPTY slot with no pass in flight. That is decided here, at the moment of leaving the
	 * request: of two actions that overlap, the first to get here keeps the slot and the other
	 * leaves nothing. Returns the request, which is what lets its action, and nothing else, start it.
	 */
	private leavePriceSeedDeferredRequest(
		itemIds: readonly number[],
		outcome: PriceSeedBulkRefreshOutcome,
		syncGeneration: number | null,
	): PriceSeedDeferredRequest | null {
		const budget = outcome.deferredBudget ?? 0;
		if ((outcome.staleSkipped ?? 0) === 0 || budget <= 0) return null;
		if (this.priceSeedDeferredRequest || this.priceSeedDeferredPass) return null;
		const request: PriceSeedDeferredRequest = { itemIds: [...itemIds], budget, syncGeneration };
		this.priceSeedDeferredRequest = request;
		return request;
	}

	/**
	 * Starts the deferred pass an action left, once that action has ended: `refreshSale` after its
	 * advisor refresh has delivered and painted the result, an inventory sync after its notes
	 * (`runPriceSeedSyncAction`). The caller passes the request it left itself; one that is no longer
	 * in the slot (dropped meanwhile) is not started, and the slot is empty afterwards either way.
	 * Detached: the action never waits for it, its rejection goes to the diagnostic log, and what it
	 * downloads is read by the NEXT analysis.
	 */
	private startPriceSeedDeferredPass(request: PriceSeedDeferredRequest | null): void {
		if (request === null || this.priceSeedDeferredRequest !== request) return;
		this.priceSeedDeferredRequest = null;
		if (this.unloaded || this.priceSeedDeferredPass || !this.priceSeedDownloadsAllowed()) return;
		const pass = this.runPriceSeedDeferredPass(request);
		this.priceSeedDeferredPass = pass;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'price_history', action: 'price_history_load_series', state: 'price_seed_deferred_refresh' },
			() => pass);
	}

	private async runPriceSeedDeferredPass(request: PriceSeedDeferredRequest): Promise<void> {
		try {
			const outcome = await this.priceSeedBulkRefresh?.run(request.itemIds, undefined, {
				scope: 'stale', budget: request.budget, allowed: () => this.priceSeedDownloadsAllowed(),
			});
			// An unload in the middle leaves an outcome that never measured its coverage, and no view to paint.
			if (outcome === undefined || this.unloaded) return;
			// Sale's calendar is not the list the coverage line describes, and neither is the list of a
			// sync that a newer sync's seed pass has already replaced.
			if (request.syncGeneration === null || request.syncGeneration !== this.priceSeedSyncGeneration) return;
			this.priceSeedQueueCoverage = outcome.queueCoverage;
			// The coverage line only: no analysis and no Sale verdict is recomputed here.
			this.renderInventoryAdvisorViews();
		} finally {
			this.priceSeedDeferredPass = null;
		}
	}

	/**
	 * One inventory sync action, start to end, as far as the price seeds go: every analysis it runs
	 * shares one cap of 25, and the stale copies it left are started when the WHOLE action has ended
	 * (after the notes), never between its analyses, where a second analysis's missing seeds would
	 * queue behind them. An action that begins while another is open joins it and ends nothing.
	 */
	async runPriceSeedSyncAction<T>(work: () => Promise<T>): Promise<T> {
		if (this.priceSeedSyncAction) return await work();
		const action: PriceSeedSyncAction = { remaining: null, request: null };
		this.priceSeedSyncAction = action;
		try {
			return await work();
		} finally {
			this.priceSeedSyncAction = null;
			this.startPriceSeedDeferredPass(action.request);
		}
	}

	/**
	 * Explicit Sale refresh may fill the calendar's history, using the existing opt-in and cache. It
	 * waits for the calendar items with no seed, so the verdict that follows reads them; the copies
	 * past their 24 h are refreshed after the result (1 oct 2026), started here once the advisor
	 * refresh this action ends with has delivered and painted it.
	 */
	async refreshSale(options: { refreshSeeds: boolean } = { refreshSeeds: true }): Promise<void> {
		if (refusedInConsult(this)) return;
		let deferred: PriceSeedDeferredRequest | null = null;
		try {
			if (this.runtimeReady && options.refreshSeeds && this.settings.priceHistoryEnabled) {
				const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date().toISOString());
				if (loaded.status === 'available') {
					const itemIds = loaded.bundle.festivalCalendar.entries.map((entry) => entry.itemId);
					const aliveOnArrival = this.priceSeedDeferredAliveBesides(null);
					const outcome = await this.priceSeedBulkRefresh?.run(itemIds, undefined, {
						scope: 'missing', allowed: () => this.priceSeedDownloadsAllowed(),
					});
					// This is a calendar-only pass; its coverage must not replace the whole sync watch list.
					if (outcome !== undefined && !aliveOnArrival && !this.unloaded) deferred = this.leavePriceSeedDeferredRequest(itemIds, outcome, null);
				}
			}
			await this.refreshInventoryAdvisor();
		} finally {
			this.startPriceSeedDeferredPass(deferred);
		}
	}

	/** The sell/hold verdict for the Halloween bag, a permanent surface rather than only a transient alert. */
	getSellSignalState(): SellSignalRuntimeState | null {
		return this.sellSignal?.getState() ?? null;
	}

	/**
	 * H18.17: the datawars2 seed queue's coverage across the whole watch list — how many items have
	 * a history, how many are still pending their turn, how many answered with no data — from the
	 * last "Sincronizar inventario" pass. `null` until that first pass completes; never triggers work.
	 */
	getPriceSeedQueueCoverage(): PriceSeedQueueCoverage | null {
		return this.priceSeedQueueCoverage;
	}

	/** Seeds once and reads the merged series. Never throws into the compaction that called it. */
	async evaluateSellSignal(port: { nowMs: number; readDaily: PriceHistoryDailyReader }): Promise<void> {
		const runtime = this.sellSignal;
		if (runtime === null) return;
		try {
			await runtime.ensureSeed();
			const fromDayUtc = new Date(Math.max(0, port.nowMs - SELL_SIGNAL_SERIES_SPAN_MS)).toISOString().slice(0, 10);
			runtime.evaluate(await port.readDaily(HALLOWEEN_PRICE_ALERT_ITEM_ID, fromDayUtc), port.nowMs);
		} catch (error) {
			// H15.18 (2026-09-10 incident): the sell signal still never fails the compaction that
			// called this, but before this the local debug log never learned it had died either.
			this.localDebugActions?.event({
				component: 'price_history', action: 'price_history_compact', state: 'sell_signal',
				level: 'error', phase: 'failure', code: 'unknown_failure',
				details: unmappedErrorLogDetails(error),
			});
		}
	}

	/**
	 * Read-only lookup for `previewInventorySync`'s recommendation port (decision 4, M2): never
	 * downloads a seed, only reads whatever `priceSeedBulkRefresh` already cached. `null` on any
	 * storage failure, same fail-closed discipline `IndexedDbPriceSeedCacheStore` itself uses.
	 */
	async readCachedPriceSeed(vaultId: string, itemId: number): Promise<PriceSeedV1 | null> {
		const store = await this.ensurePriceSeedCacheReader();
		if (store === null) return null;
		try {
			return (await store.get(vaultId, itemId))?.seed ?? null;
		} catch {
			return null;
		}
	}

	private async ensurePriceSeedCacheReader(): Promise<TyrianPriceSeedCache | null> {
		if (this.priceSeedCacheReader !== null) return this.priceSeedCacheReader;
		if (this.priceSeedCacheReaderOpening === null) this.priceSeedCacheReaderOpening = this.openPriceSeedCacheReader();
		return await this.priceSeedCacheReaderOpening;
	}

	private async openPriceSeedCacheReader(): Promise<TyrianPriceSeedCache | null> {
		try {
			const store = await this.host.priceHistory.openSeedCache();
			this.priceSeedCacheReader = store;
			return store;
		} catch {
			return null;
		} finally {
			this.priceSeedCacheReaderOpening = null;
		}
	}

	/**
	 * Settings switched the price history opt-in off: the stale copies still waiting for their action
	 * to end are dropped with it, and switching it back on does not bring them back. A pass already
	 * downloading stops at its next item, on its own `allowed` check.
	 */
	dropPriceSeedDeferredRequest(): void {
		this.priceSeedDeferredRequest = null;
	}

	/**
	 * The unload: cuts a deferred pass in flight at its next item (with the core's disposal of
	 * `priceSeedBulkRefresh`), drops one that had not started yet, and closes the read-only cache.
	 */
	dispose(): void {
		this.priceSeedDeferredRequest = null;
		this.priceSeedCacheReader?.close();
		this.priceSeedCacheReader = null;
	}
}

/**
 * How far back the daily store is read for the sell signal.
 *
 * A day of margin over the reference window, so a compaction running just
 * before midnight UTC still has the whole year behind it.
 */
const SELL_SIGNAL_SERIES_SPAN_MS = (SELL_SIGNAL_REFERENCE_DAYS + 1) * 86_400_000;

type PriceHistoryDailyReader = (itemId: number, fromDayUtc: string) => Promise<PriceHistoryDailyV1[]>;

/** The stale seed copies one explicit action left to refresh once it has ended (1 oct 2026). */
interface PriceSeedDeferredRequest {
	/** The action's whole list; the pass itself requests only the copies past their TTL. */
	readonly itemIds: readonly number[];
	/** What the action's `missing` phases left of the cap of 25. */
	readonly budget: number;
	/**
	 * The inventory sync seed pass that left it (`priceSeedSyncGeneration` at that moment), whose list
	 * is the one the coverage line describes; null for Sale's calendar, which never rewrites that line.
	 */
	readonly syncGeneration: number | null;
}

/** One inventory sync action in progress, as far as the price seeds go (`runPriceSeedSyncAction`). */
interface PriceSeedSyncAction {
	/** What its analyses so far left of the cap of 25; null until the first one has run its seed pass. */
	remaining: number | null;
	/** The stale copies its latest analysis left in the slot, which only this action may start; null if none. */
	request: PriceSeedDeferredRequest | null;
}
