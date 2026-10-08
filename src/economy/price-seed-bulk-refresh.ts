import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { SerialTaskRunner, SerialTaskTurn } from '../core/serial-task-queue';
import type { TyrianPriceHistoryPort, TyrianPriceSeedCache, TyrianPriceSeedNoSeedCache } from '../host/tyrian-host-storage';
import type { PriceSeedResult, PriceSeedQueueCoverage } from './price-seed-model';

/** Re-exported for existing callers (`main.ts`, this module's own tests); the type itself now lives in `./price-seed-model`. */
export type { PriceSeedQueueCoverage } from './price-seed-model';

/**
 * Decision 4 (SPEC-recomendacion-por-objeto.md §7, approved by David 11 sep 2026): after an
 * explicit "Sincronizar inventario" or Sale refresh, and only while price history is on, the list's
 * items get a datawars2 seed if their cache entry is missing or stale. One request at a time, never
 * two in flight, capped so a vault with hundreds of eligible items never fires a burst — the rest
 * waits for the next action. `docs/PLATFORM_POLICY.md` carries this same decision in prose.
 *
 * Since 1 oct 2026 the cap is one budget per visible action, spent in two phases
 * (`PriceSeedBulkRefreshPhase`): the items with no seed at all first, which the action waits for,
 * and then, out of whatever is left, the copies past their TTL, refreshed after the action has
 * delivered its result.
 */
export const PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN = 25;

/** Matches the panel's own TTL (`price-seed-panel-service.ts`): one shared cache, one freshness rule. */
export const PRICE_SEED_BULK_REFRESH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * H18.17 (auditoría 24 sep 2026, §3.E): before this, a `no_seed` answer was never cached, so it
 * re-spent one of the 25 per-run slots on EVERY sync — with more than 25 watch-listed items and a
 * failure early in the list, the rest could never be reached. This is the spaced retry that
 * replaces that: not immediate (so a genuinely unavailable item stops crowding out its neighbours),
 * not infinite (so a transient outage still heals on its own). Same cadence as the positive-seed
 * TTL above, which is itself a deliberate choice (not audited to any finer grain): one retry per
 * item per day, whichever direction the last answer went.
 */
export const PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS = 24 * 60 * 60 * 1000;

export interface PriceSeedBulkRefreshOutcome {
	/** How many items actually reached a request this run (excludes items skipped for a fresh cache or cooldown). */
	attempted: number;
	seeded: number;
	skippedCached: number;
	/** Items skipped because their last `no_seed` answer is still inside its spaced retry window. */
	skippedNoSeedCooldown: number;
	/** A fresh `no_seed` answer this run. Cached, so it no longer costs a slot on the next sync either. */
	noSeed: number;
	/** A real failure this run: a thrown download, or a storage read/write that itself failed. */
	failed: number;
	queueCoverage: PriceSeedQueueCoverage;
	/** `missing` phase only: copies past their TTL this run left untouched, for the `stale` phase to refresh. */
	staleSkipped?: number;
	/** `missing` phase only: what this run left of the per-action cap, the most the `stale` phase may request. */
	deferredBudget?: number;
}

/**
 * Which part of the list one run requests (1 oct 2026). Without a phase a run requests both, as it
 * always did.
 *
 * - `missing`: only the items with NO seed in the cache (and outside their `no_seed` cooldown). A
 *   copy past its TTL is left as it is and counted in `staleSkipped`. `budget` is what an earlier
 *   `missing` phase of the SAME action left of the cap; without it the phase has the whole cap.
 * - `stale`: only the copies past their TTL, at most `budget` of them, and never more than the
 *   per-run cap. An item with no seed is left for the next action's `missing` phase.
 *
 * `allowed` is asked before every item: once it answers false the run requests nothing more. The
 * caller uses it for the opt-in the person can switch off while a run is under way.
 */
export type PriceSeedBulkRefreshPhase =
	| { scope: 'missing'; budget?: number; allowed?: () => boolean }
	| { scope: 'stale'; budget: number; allowed?: () => boolean };

/**
 * What `fetchSeed` hands back: the seed result, plus how many newest days that download was
 * allowed to keep. The cache records it (Z12) so the panel can tell a copy the pass trimmed from
 * the whole history.
 */
export type PriceSeedFetched = PriceSeedResult & { requestedDays?: number };

export interface PriceSeedBulkRefreshOptions {
	priceHistory: Pick<TyrianPriceHistoryPort, 'openSeedCache' | 'openNoSeedCache'>;
	vaultId: string;
	now: () => number;
	/**
	 * Already bound to the plugin's own transport (`fetchPriceSeed` in `price-seed-source.ts`):
	 * this module never imports a transport of its own, so it carries no outbound capability that
	 * a security review has not already seen on the caller's side.
	 */
	fetchSeed: (itemId: number, actionContext?: ResolvedLocalDebugActionContext) => Promise<PriceSeedFetched>;
	/**
	 * The turn every request of a pass takes before it is sent (1 oct 2026, task 0812d53e): the
	 * caller hands the queue it shares with the other seed downloads of the plugin, so a pass and
	 * a panel load are never two requests in flight. Required: a service built without a queue
	 * must not compile. A caller with nothing to share says so with `runSerialTaskUnqueued`, and
	 * then only the passes of this service are serial among themselves.
	 */
	serialize: SerialTaskRunner;
	maxItemsPerRun?: number;
	noSeedRetryMs?: number;
	diagnostics?: LocalDebugActionPort;
}

/**
 * Owns one cache-store connection for repeated bulk passes. Construction performs no I/O, and
 * every request lives behind an explicit inventory sync or Sale refresh (decision 4, amended
 * 2026-09-26). Concurrent actions share one queue, so they cannot duplicate or overlap downloads;
 * that queue (`pending`) orders the passes among themselves, and `options.serialize` orders each
 * request among every seed download of the plugin.
 */
export class PriceSeedBulkRefreshService {
	private readonly maxItemsPerRun: number;
	private readonly noSeedRetryMs: number;
	private readonly serialize: SerialTaskRunner;
	private store: TyrianPriceSeedCache | null = null;
	private noSeedStore: TyrianPriceSeedNoSeedCache | null = null;
	private opening: Promise<Stores | null> | null = null;
	private disposed = false;
	private pending: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: PriceSeedBulkRefreshOptions) {
		this.maxItemsPerRun = options.maxItemsPerRun ?? PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN;
		this.noSeedRetryMs = options.noSeedRetryMs ?? PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS;
		this.serialize = options.serialize;
	}

	dispose(): void {
		this.disposed = true;
		this.store?.close();
		this.store = null;
		this.noSeedStore?.close();
		this.noSeedStore = null;
	}

	/**
	 * Serial by construction: the loop `await`s every step before starting the next one, so no two
	 * `fetchSeed` calls of this service are ever in flight together, and each of them takes its turn
	 * in `options.serialize`, behind whatever else the plugin is downloading. One item's failure is
	 * recorded and the loop moves on to the next id; it stops early only at the cap, on `dispose`,
	 * or when the phase's `allowed` answers false, which is asked before every item and once more
	 * when the item's turn comes.
	 */
	async run(
		itemIds: readonly number[],
		parent?: ResolvedLocalDebugActionContext,
		phase?: PriceSeedBulkRefreshPhase,
	): Promise<PriceSeedBulkRefreshOutcome> {
		const flight = this.pending.then(() => this.runSequential(itemIds, parent, phase));
		this.pending = flight.catch(() => undefined);
		return await flight;
	}

	private async runSequential(
		itemIds: readonly number[],
		parent?: ResolvedLocalDebugActionContext,
		phase?: PriceSeedBulkRefreshPhase,
	): Promise<PriceSeedBulkRefreshOutcome> {
		const outcome: PriceSeedBulkRefreshOutcome = {
			attempted: 0, seeded: 0, skippedCached: 0, skippedNoSeedCooldown: 0, noSeed: 0, failed: 0,
			queueCoverage: { total: itemIds.length, seeded: 0, noData: 0, pending: itemIds.length },
		};
		if (phase?.scope === 'missing') { outcome.staleSkipped = 0; outcome.deferredBudget = 0; }
		if (this.disposed) return outcome;
		const stores = await this.ensureStores();
		if (stores === null || this.disposed) return outcome;
		// A phase with a budget spends what the earlier phases of the same action left, never more than the cap.
		const cap = phase?.budget === undefined
			? this.maxItemsPerRun
			: Math.min(this.maxItemsPerRun, Math.max(0, Math.floor(phase.budget)));
		// What the loop already read for each item, so the coverage below does not read it again.
		const known = new Map<number, CoverageKind>();
		for (const itemId of itemIds) {
			if (this.disposed || outcome.attempted >= cap) break;
			if (phase?.allowed !== undefined && !phase.allowed()) break;
			await this.refreshOne(stores, itemId, outcome, known, parent, phase);
		}
		if (phase?.scope === 'missing') outcome.deferredBudget = Math.max(0, cap - outcome.attempted);
		if (!this.disposed) outcome.queueCoverage = await this.computeQueueCoverage(stores, itemIds, known);
		return outcome;
	}

	private async refreshOne(
		stores: Stores,
		itemId: number,
		outcome: PriceSeedBulkRefreshOutcome,
		known: Map<number, CoverageKind>,
		parent?: ResolvedLocalDebugActionContext,
		phase?: PriceSeedBulkRefreshPhase,
	): Promise<void> {
		const { store, noSeedStore } = stores;
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'price_history', action: 'price_history_load_series',
			...(parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } }),
			details: { bulkRefreshItemId: itemId },
		}, this.options.now);
		const nowMs = this.options.now();
		let cached: Awaited<ReturnType<TyrianPriceSeedCache['get']>>;
		try {
			cached = await store.get(this.options.vaultId, itemId);
		} catch (error) {
			outcome.failed += 1;
			span.failure(error, 'storage_failure', 'store_unavailable');
			return;
		}
		if (cached !== null) known.set(itemId, 'seeded');
		if (cached !== null && nowMs - cached.cachedAtMs < PRICE_SEED_BULK_REFRESH_CACHE_TTL_MS) {
			outcome.skippedCached += 1;
			span.skip('skipped', 'cached');
			return;
		}
		let recentNoSeed: Awaited<ReturnType<TyrianPriceSeedNoSeedCache['get']>>;
		try {
			recentNoSeed = await noSeedStore.get(this.options.vaultId, itemId);
		} catch (error) {
			outcome.failed += 1;
			span.failure(error, 'storage_failure', 'store_unavailable');
			return;
		}
		if (cached === null) known.set(itemId, recentNoSeed !== null ? 'noData' : 'pending');
		if (recentNoSeed !== null && nowMs - recentNoSeed.failedAtMs < this.noSeedRetryMs) {
			// H18.17: the item that used to re-spend its slot on every single sync. Spaced, not
			// infinite: `this.noSeedRetryMs` is exactly what lets it be asked again later.
			outcome.skippedNoSeedCooldown += 1;
			span.skip('skipped', `no_seed_cooldown_${recentNoSeed.reason}`);
			return;
		}
		if (phase?.scope === 'missing' && cached !== null) {
			// A copy past its TTL: the analysis reads it as it is, and the `stale` phase refreshes it.
			outcome.staleSkipped = (outcome.staleSkipped ?? 0) + 1;
			span.skip('skipped', 'stale_deferred');
			return;
		}
		if (phase?.scope === 'stale' && cached === null) {
			span.skip('skipped', 'missing_not_deferred');
			return;
		}
		let turn: SerialTaskTurn<PriceSeedFetched | null>;
		try {
			turn = await this.serialize(async () => {
				// Asked again now that the turn has come: the item may have waited behind other
				// downloads, and the person may have withdrawn the permission meanwhile.
				if (this.disposed || (phase?.allowed !== undefined && !phase.allowed())) return null;
				outcome.attempted += 1;
				return await this.options.fetchSeed(itemId, span.context);
			});
		} catch (error) {
			// The download itself throwing (rather than answering `no_seed`) never stops item k+1.
			outcome.failed += 1;
			span.failure(error, 'unknown_failure', 'no_seed');
			return;
		}
		if (turn.status === 'dropped' || turn.value === null) {
			// Never asked for: the queue was let go, or the turn came too late. Nothing is counted
			// and nothing is written, so the item is as missing or as stale as it was.
			span.skip('skipped', turn.status === 'dropped' || this.disposed ? 'disposed' : 'not_allowed');
			return;
		}
		const result = turn.value;
		if (this.disposed) {
			// `dispose` closed both stores while this request was in flight: its answer has nowhere to
			// go, and writing it would only record a storage failure nobody can act on.
			span.skip('skipped', 'disposed');
			return;
		}
		if (result.status === 'no_seed') {
			try {
				await noSeedStore.put(this.options.vaultId, itemId, result.reason, nowMs);
			} catch (error) {
				// The download answered; only the negative-cache write failed, which costs the next
				// run a repeated (free, no-network-hiding-behind-it) attempt and nothing else.
				outcome.failed += 1;
				span.failure(error, 'storage_failure', 'store_unavailable');
				return;
			}
			known.set(itemId, cached !== null ? 'seeded' : 'noData');
			outcome.noSeed += 1;
			span.skip('unavailable', `no_seed_${result.reason}`);
			return;
		}
		try {
			await store.put(this.options.vaultId, itemId, result.seed, nowMs, result.requestedDays);
		} catch (error) {
			// The download succeeded; only the cache write failed, which costs the next run a
			// repeated download and nothing else.
			outcome.failed += 1;
			span.failure(error, 'storage_failure', 'store_unavailable');
			return;
		}
		// Best-effort: a stale `no_seed` marker left behind is harmless (the positive cache above
		// is always checked first), so its own failure never turns a successful seed into one.
		try { await noSeedStore.delete(this.options.vaultId, itemId); } catch { /* see above */ }
		known.set(itemId, 'seeded');
		outcome.seeded += 1;
		span.success('seeded');
	}

	/**
	 * Classifies every item in the WATCH LIST, not just the ones this run reached: the per-run cap
	 * means most of it is usually untouched by the loop above, but the point of this pass (H18.17)
	 * is a caller-visible answer to "how much of the queue is covered", which the cap must never hide.
	 */
	private async computeQueueCoverage(
		stores: Stores, itemIds: readonly number[], known: ReadonlyMap<number, CoverageKind>,
	): Promise<PriceSeedQueueCoverage> {
		const coverage: PriceSeedQueueCoverage = { total: itemIds.length, seeded: 0, noData: 0, pending: 0 };
		for (const itemId of itemIds) {
			// Item 9: the loop read this item already; only the ones it never reached are read here.
			const seen = known.get(itemId);
			if (seen !== undefined) { coverage[seen] += 1; continue; }
			if (await this.hasSeed(stores.store, itemId)) { coverage.seeded += 1; continue; }
			if (await this.hasNoSeed(stores.noSeedStore, itemId)) { coverage.noData += 1; continue; }
			coverage.pending += 1;
		}
		return coverage;
	}

	private async hasSeed(store: TyrianPriceSeedCache, itemId: number): Promise<boolean> {
		try { return (await store.get(this.options.vaultId, itemId)) !== null; }
		catch { return false; }
	}

	private async hasNoSeed(noSeedStore: TyrianPriceSeedNoSeedCache, itemId: number): Promise<boolean> {
		try { return (await noSeedStore.get(this.options.vaultId, itemId)) !== null; }
		catch { return false; }
	}

	private async ensureStores(): Promise<Stores | null> {
		if (this.store !== null && this.noSeedStore !== null) return { store: this.store, noSeedStore: this.noSeedStore };
		if (this.opening === null) this.opening = this.openStores();
		return await this.opening;
	}

	private async openStores(): Promise<Stores | null> {
		let store: TyrianPriceSeedCache | null = null;
		try {
			store = await this.options.priceHistory.openSeedCache();
			const noSeedStore = await this.options.priceHistory.openNoSeedCache();
			this.store = store;
			this.noSeedStore = noSeedStore;
			return { store, noSeedStore };
		} catch {
			// If the second open fails, the first must not leak a connection nothing else will close.
			store?.close();
			return null;
		} finally {
			this.opening = null;
		}
	}
}

/** Which `PriceSeedQueueCoverage` counter an item falls in. */
type CoverageKind = 'seeded' | 'noData' | 'pending';

interface Stores {
	store: TyrianPriceSeedCache;
	noSeedStore: TyrianPriceSeedNoSeedCache;
}
