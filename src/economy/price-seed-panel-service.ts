import type { HttpTransport } from '../core/http';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import { IndexedDbPriceSeedCacheStore } from './price-seed-cache-store';
import { fetchPriceSeed } from './price-seed-source';
import type { PriceSeedDayV1, PriceSeedFailureReason } from './price-seed-model';

/**
 * Fills the panel's chart with datawars2's history, for whichever item it is
 * currently showing.
 *
 * Deferred by construction: nothing here runs until `ensure` is called, and
 * the only caller is the panel's own load action, itself only reachable once
 * the user has opened the view and picked an item. Building this service does
 * no I/O; `docs/PLATFORM_POLICY.md` never has to make an exception for it.
 *
 * Cached: a successful download is kept in `price-seed-cache-store.ts` and
 * served from there for `cacheTtlMs` before it is asked for again, so opening
 * the panel a second time inside that window never repeats the 2.2 MB request.
 * A refresh failure keeps serving the last cached seed rather than blanking
 * the chart; only a first request that fails leaves the item unseeded.
 */
export type PriceHistoryPanelSeedStatus = 'idle' | 'loading' | 'seeded' | 'no_seed' | 'store_unavailable';

export interface PriceHistoryPanelSeedState {
	status: PriceHistoryPanelSeedStatus;
	itemId: number | null;
	/** Ascending by day, unique by day, third-party. Empty unless `status` is `seeded`. */
	days: readonly PriceSeedDayV1[];
	failureReason: PriceSeedFailureReason | null;
	retrievedAt: string | null;
}

/** A day old cached seed is refreshed on the next load; datawars2 publishes at most one new day per day. */
export const PRICE_SEED_PANEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PriceHistoryPanelSeedOptions {
	factory: IDBFactory;
	vaultId: string;
	transport: HttpTransport;
	now: () => number;
	cacheTtlMs?: number;
	diagnostics?: LocalDebugActionPort;
}

const IDLE_STATE: Omit<PriceHistoryPanelSeedState, 'itemId'> = {
	status: 'idle', days: [], failureReason: null, retrievedAt: null,
};

export class PriceHistoryPanelSeedService {
	private readonly cacheTtlMs: number;
	private store: IndexedDbPriceSeedCacheStore | null = null;
	private opening: Promise<IndexedDbPriceSeedCacheStore | null> | null = null;
	private readonly states = new Map<number, PriceHistoryPanelSeedState>();
	private readonly inFlight = new Map<number, Promise<void>>();
	private disposed = false;

	constructor(private readonly options: PriceHistoryPanelSeedOptions) {
		this.cacheTtlMs = options.cacheTtlMs ?? PRICE_SEED_PANEL_CACHE_TTL_MS;
	}

	/** Last known state for the item, without triggering any work. */
	getState(itemId: number): PriceHistoryPanelSeedState {
		return this.states.get(itemId) ?? { ...IDLE_STATE, itemId };
	}

	/** Downloads or serves the cache for one item. Concurrent callers for the same item share the flight. */
	async ensure(itemId: number, parent?: ResolvedLocalDebugActionContext): Promise<PriceHistoryPanelSeedState> {
		if (this.disposed || !Number.isSafeInteger(itemId) || itemId <= 0) return this.getState(itemId);
		const existing = this.inFlight.get(itemId);
		if (existing !== undefined) { await existing; return this.getState(itemId); }
		const flight = this.load(itemId, parent);
		this.inFlight.set(itemId, flight);
		await flight;
		if (this.inFlight.get(itemId) === flight) this.inFlight.delete(itemId);
		return this.getState(itemId);
	}

	dispose(): void {
		this.disposed = true;
		this.store?.close();
		this.store = null;
		this.opening = null;
	}

	private async load(itemId: number, parent?: ResolvedLocalDebugActionContext): Promise<void> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'price_history', action: 'price_history_load_series',
			...(parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } }),
			details: { seedItemId: itemId },
		}, this.options.now);
		const store = await this.ensureStore();
		if (store === null) {
			this.states.set(itemId, { ...IDLE_STATE, itemId, status: 'store_unavailable' });
			span.failure(new Error('price_seed_cache_unavailable'), 'storage_failure', 'store_unavailable');
			return;
		}
		let cached: Awaited<ReturnType<IndexedDbPriceSeedCacheStore['get']>> = null;
		try {
			cached = await store.get(this.options.vaultId, itemId);
		} catch (error) {
			span.failure(error, 'storage_failure', 'store_unavailable');
			this.states.set(itemId, { ...IDLE_STATE, itemId, status: 'store_unavailable' });
			return;
		}
		const nowMs = this.options.now();
		if (cached !== null && nowMs - cached.cachedAtMs < this.cacheTtlMs) {
			this.states.set(itemId, {
				status: 'seeded', itemId, days: cached.seed.days, failureReason: null, retrievedAt: cached.seed.retrievedAt,
			});
			span.success('seeded', { source: 'cache' });
			return;
		}
		this.states.set(itemId, {
			status: 'loading', itemId, days: cached?.seed.days ?? [],
			failureReason: null, retrievedAt: cached?.seed.retrievedAt ?? null,
		});
		const result = await fetchPriceSeed(itemId, { transport: this.options.transport, now: this.options.now, actionContext: span.context });
		if (this.disposed) { span.cancel('disposed'); return; }
		if (result.status === 'no_seed') {
			if (cached !== null) {
				// A refresh failure keeps serving the stale cache; the chart never blanks over a hiccup.
				this.states.set(itemId, {
					status: 'seeded', itemId, days: cached.seed.days, failureReason: result.reason, retrievedAt: cached.seed.retrievedAt,
				});
			} else {
				this.states.set(itemId, { status: 'no_seed', itemId, days: [], failureReason: result.reason, retrievedAt: null });
			}
			span.skip('unavailable', `no_seed_${result.reason}`);
			return;
		}
		try {
			await store.put(this.options.vaultId, itemId, result.seed, nowMs);
		} catch (error) {
			// The download itself succeeded; a failed write only costs the next open a repeated
			// download, so the panel still gets to show what was just fetched.
			span.failure(error, 'storage_failure', 'store_unavailable');
			this.states.set(itemId, {
				status: 'seeded', itemId, days: result.seed.days, failureReason: null, retrievedAt: result.seed.retrievedAt,
			});
			return;
		}
		this.states.set(itemId, {
			status: 'seeded', itemId, days: result.seed.days, failureReason: null, retrievedAt: result.seed.retrievedAt,
		});
		span.success('seeded', { source: 'network' });
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
