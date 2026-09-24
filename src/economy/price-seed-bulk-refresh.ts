import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import { IndexedDbPriceSeedCacheStore, IndexedDbPriceSeedNoSeedStore } from './price-seed-cache-store';
import type { PriceSeedResult, PriceSeedQueueCoverage } from './price-seed-model';

/** Re-exported for existing callers (`main.ts`, this module's own tests); the type itself now lives in `./price-seed-model`. */
export type { PriceSeedQueueCoverage } from './price-seed-model';

/**
 * Decision 4 (SPEC-recomendacion-por-objeto.md §7, approved by David 11 sep 2026): after an
 * explicit "Sincronizar inventario", and only while price history is on, the watch list's items
 * get a datawars2 seed if their cache entry is missing or stale. One request at a time, never two
 * in flight, capped per run so a vault with hundreds of eligible items never fires a burst — the
 * rest waits for the next sync. `docs/PLATFORM_POLICY.md` carries this same decision in prose.
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
}

export interface PriceSeedBulkRefreshOptions {
	factory: IDBFactory;
	vaultId: string;
	now: () => number;
	/**
	 * Already bound to the plugin's own transport (`fetchPriceSeed` in `price-seed-source.ts`):
	 * this module never imports a transport of its own, so it carries no outbound capability that
	 * a security review has not already seen on the caller's side.
	 */
	fetchSeed: (itemId: number, actionContext?: ResolvedLocalDebugActionContext) => Promise<PriceSeedResult>;
	maxItemsPerRun?: number;
	noSeedRetryMs?: number;
	diagnostics?: LocalDebugActionPort;
}

/**
 * Owns one cache-store connection for repeated bulk passes. Construction performs no I/O, and
 * every request this makes lives behind `run`, itself only ever called right after the explicit
 * "Sincronizar inventario" action (decision 4).
 */
export class PriceSeedBulkRefreshService {
	private readonly maxItemsPerRun: number;
	private readonly noSeedRetryMs: number;
	private store: IndexedDbPriceSeedCacheStore | null = null;
	private noSeedStore: IndexedDbPriceSeedNoSeedStore | null = null;
	private opening: Promise<Stores | null> | null = null;
	private disposed = false;

	constructor(private readonly options: PriceSeedBulkRefreshOptions) {
		this.maxItemsPerRun = options.maxItemsPerRun ?? PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN;
		this.noSeedRetryMs = options.noSeedRetryMs ?? PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS;
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
	 * `fetchSeed` calls are ever in flight together. One item's failure is recorded and the loop
	 * moves on to the next id; it never stops early except at the cap.
	 */
	async run(itemIds: readonly number[], parent?: ResolvedLocalDebugActionContext): Promise<PriceSeedBulkRefreshOutcome> {
		const outcome: PriceSeedBulkRefreshOutcome = {
			attempted: 0, seeded: 0, skippedCached: 0, skippedNoSeedCooldown: 0, noSeed: 0, failed: 0,
			queueCoverage: { total: itemIds.length, seeded: 0, noData: 0, pending: itemIds.length },
		};
		if (this.disposed) return outcome;
		const stores = await this.ensureStores();
		if (stores === null || this.disposed) return outcome;
		for (const itemId of itemIds) {
			if (this.disposed || outcome.attempted >= this.maxItemsPerRun) break;
			await this.refreshOne(stores, itemId, outcome, parent);
		}
		if (!this.disposed) outcome.queueCoverage = await this.computeQueueCoverage(stores, itemIds);
		return outcome;
	}

	private async refreshOne(
		stores: Stores,
		itemId: number,
		outcome: PriceSeedBulkRefreshOutcome,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<void> {
		const { store, noSeedStore } = stores;
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'price_history', action: 'price_history_load_series',
			...(parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } }),
			details: { bulkRefreshItemId: itemId },
		}, this.options.now);
		const nowMs = this.options.now();
		let cached: Awaited<ReturnType<IndexedDbPriceSeedCacheStore['get']>>;
		try {
			cached = await store.get(this.options.vaultId, itemId);
		} catch (error) {
			outcome.failed += 1;
			span.failure(error, 'storage_failure', 'store_unavailable');
			return;
		}
		if (cached !== null && nowMs - cached.cachedAtMs < PRICE_SEED_BULK_REFRESH_CACHE_TTL_MS) {
			outcome.skippedCached += 1;
			span.skip('skipped', 'cached');
			return;
		}
		let recentNoSeed: Awaited<ReturnType<IndexedDbPriceSeedNoSeedStore['get']>>;
		try {
			recentNoSeed = await noSeedStore.get(this.options.vaultId, itemId);
		} catch (error) {
			outcome.failed += 1;
			span.failure(error, 'storage_failure', 'store_unavailable');
			return;
		}
		if (recentNoSeed !== null && nowMs - recentNoSeed.failedAtMs < this.noSeedRetryMs) {
			// H18.17: the item that used to re-spend its slot on every single sync. Spaced, not
			// infinite: `this.noSeedRetryMs` is exactly what lets it be asked again later.
			outcome.skippedNoSeedCooldown += 1;
			span.skip('skipped', `no_seed_cooldown_${recentNoSeed.reason}`);
			return;
		}
		outcome.attempted += 1;
		let result: PriceSeedResult;
		try {
			result = await this.options.fetchSeed(itemId, span.context);
		} catch (error) {
			// The download itself throwing (rather than answering `no_seed`) never stops item k+1.
			outcome.failed += 1;
			span.failure(error, 'unknown_failure', 'no_seed');
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
			outcome.noSeed += 1;
			span.skip('unavailable', `no_seed_${result.reason}`);
			return;
		}
		try {
			await store.put(this.options.vaultId, itemId, result.seed, nowMs);
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
		outcome.seeded += 1;
		span.success('seeded');
	}

	/**
	 * Classifies every item in the WATCH LIST, not just the ones this run reached: the per-run cap
	 * means most of it is usually untouched by the loop above, but the point of this pass (H18.17)
	 * is a caller-visible answer to "how much of the queue is covered", which the cap must never hide.
	 */
	private async computeQueueCoverage(stores: Stores, itemIds: readonly number[]): Promise<PriceSeedQueueCoverage> {
		const coverage: PriceSeedQueueCoverage = { total: itemIds.length, seeded: 0, noData: 0, pending: 0 };
		for (const itemId of itemIds) {
			if (await this.hasSeed(stores.store, itemId)) { coverage.seeded += 1; continue; }
			if (await this.hasNoSeed(stores.noSeedStore, itemId)) { coverage.noData += 1; continue; }
			coverage.pending += 1;
		}
		return coverage;
	}

	private async hasSeed(store: IndexedDbPriceSeedCacheStore, itemId: number): Promise<boolean> {
		try { return (await store.get(this.options.vaultId, itemId)) !== null; }
		catch { return false; }
	}

	private async hasNoSeed(noSeedStore: IndexedDbPriceSeedNoSeedStore, itemId: number): Promise<boolean> {
		try { return (await noSeedStore.get(this.options.vaultId, itemId)) !== null; }
		catch { return false; }
	}

	private async ensureStores(): Promise<Stores | null> {
		if (this.store !== null && this.noSeedStore !== null) return { store: this.store, noSeedStore: this.noSeedStore };
		if (this.opening === null) this.opening = this.openStores();
		return await this.opening;
	}

	private async openStores(): Promise<Stores | null> {
		let store: IndexedDbPriceSeedCacheStore | null = null;
		try {
			store = await IndexedDbPriceSeedCacheStore.open(this.options.factory);
			const noSeedStore = await IndexedDbPriceSeedNoSeedStore.open(this.options.factory);
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

interface Stores {
	store: IndexedDbPriceSeedCacheStore;
	noSeedStore: IndexedDbPriceSeedNoSeedStore;
}
