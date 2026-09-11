import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import { IndexedDbPriceSeedCacheStore } from './price-seed-cache-store';
import type { PriceSeedResult } from './price-seed-model';

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

export interface PriceSeedBulkRefreshOutcome {
	/** How many items actually reached a request this run (excludes items skipped for a fresh cache). */
	attempted: number;
	seeded: number;
	skippedCached: number;
	failed: number;
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
	diagnostics?: LocalDebugActionPort;
}

/**
 * Owns one cache-store connection for repeated bulk passes. Construction performs no I/O, and
 * every request this makes lives behind `run`, itself only ever called right after the explicit
 * "Sincronizar inventario" action (decision 4).
 */
export class PriceSeedBulkRefreshService {
	private readonly maxItemsPerRun: number;
	private store: IndexedDbPriceSeedCacheStore | null = null;
	private opening: Promise<IndexedDbPriceSeedCacheStore | null> | null = null;
	private disposed = false;

	constructor(private readonly options: PriceSeedBulkRefreshOptions) {
		this.maxItemsPerRun = options.maxItemsPerRun ?? PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN;
	}

	dispose(): void {
		this.disposed = true;
		this.store?.close();
		this.store = null;
	}

	/**
	 * Serial by construction: the loop `await`s every step before starting the next one, so no two
	 * `fetchSeed` calls are ever in flight together. One item's failure is recorded and the loop
	 * moves on to the next id; it never stops early except at the cap.
	 */
	async run(itemIds: readonly number[], parent?: ResolvedLocalDebugActionContext): Promise<PriceSeedBulkRefreshOutcome> {
		const outcome: PriceSeedBulkRefreshOutcome = { attempted: 0, seeded: 0, skippedCached: 0, failed: 0 };
		if (this.disposed) return outcome;
		const store = await this.ensureStore();
		if (store === null || this.disposed) return outcome;
		for (const itemId of itemIds) {
			if (this.disposed || outcome.attempted >= this.maxItemsPerRun) break;
			await this.refreshOne(store, itemId, outcome, parent);
		}
		return outcome;
	}

	private async refreshOne(
		store: IndexedDbPriceSeedCacheStore,
		itemId: number,
		outcome: PriceSeedBulkRefreshOutcome,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<void> {
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
			outcome.failed += 1;
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
		outcome.seeded += 1;
		span.success('seeded');
	}

	private async ensureStore(): Promise<IndexedDbPriceSeedCacheStore | null> {
		if (this.store !== null) return this.store;
		if (this.opening === null) this.opening = this.openStore();
		return await this.opening;
	}

	private async openStore(): Promise<IndexedDbPriceSeedCacheStore | null> {
		try {
			const store = await IndexedDbPriceSeedCacheStore.open(this.options.factory);
			this.store = store;
			return store;
		} catch {
			return null;
		} finally {
			this.opening = null;
		}
	}
}
