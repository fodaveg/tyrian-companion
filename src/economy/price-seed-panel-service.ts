import type { HttpTransport } from '../core/http';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { SerialTaskRunner } from '../core/serial-task-queue';
import type { TyrianPriceHistoryPort, TyrianPriceSeedCache } from '../host/tyrian-host-storage';
import { fetchPriceSeed } from './price-seed-source';
import { PRICE_SEED_CHART_MAX_DAYS, type PriceSeedDayV1, type PriceSeedFailureReason } from './price-seed-model';

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
	priceHistory: Pick<TyrianPriceHistoryPort, 'openSeedCache'>;
	vaultId: string;
	transport: HttpTransport;
	now: () => number;
	/**
	 * The turn every download takes before it is sent (1 oct 2026, task 0812d53e): the caller hands
	 * the queue it shares with the other seed downloads of the plugin. The flight map below only
	 * joins callers of the SAME item; two different items, the panel's and a note block's or two
	 * note blocks', are two downloads, and without this they are two requests in flight.
	 * Required: a service built without a queue must not compile. A caller with nothing to share
	 * says so with `runSerialTaskUnqueued`.
	 */
	serialize: SerialTaskRunner;
	cacheTtlMs?: number;
	diagnostics?: LocalDebugActionPort;
}

const IDLE_STATE: Omit<PriceHistoryPanelSeedState, 'itemId'> = {
	status: 'idle', days: [], failureReason: null, retrievedAt: null,
};

/**
 * How many items' last-known state the service keeps in memory (Z16-c). The panel shows one item
 * and a note holds a handful of price-history blocks, so 64 covers everything visible at once with
 * a wide margin; each state carries the item's whole series, which is what grew without a bound.
 * Only this in-memory view is capped: the persisted `seed-v1` base is untouched, and an evicted
 * item is re-served from it on the next `ensure` with no network request.
 */
export const PRICE_SEED_PANEL_MAX_STATES = 64;

/**
 * A `Map` that keeps at most `maxEntries` entries, dropping the least recently used (read or
 * written) first. An entry the `pinned` callback names, an item with a load under way, is never
 * dropped, so a late `set` of its result cannot find it gone.
 */
class RecentStateMap extends Map<number, PriceHistoryPanelSeedState> {
	constructor(private readonly maxEntries: number, private readonly pinned: (itemId: number) => boolean) {
		super();
	}

	override get(itemId: number): PriceHistoryPanelSeedState | undefined {
		const value = super.get(itemId);
		if (value !== undefined) { super.delete(itemId); super.set(itemId, value); }
		return value;
	}

	override set(itemId: number, value: PriceHistoryPanelSeedState): this {
		super.delete(itemId);
		super.set(itemId, value);
		for (const key of this.keys()) {
			if (this.size <= this.maxEntries) break;
			if (key !== itemId && !this.pinned(key)) super.delete(key);
		}
		return this;
	}
}

export class PriceHistoryPanelSeedService {
	private readonly cacheTtlMs: number;
	private readonly serialize: SerialTaskRunner;
	private store: TyrianPriceSeedCache | null = null;
	private opening: Promise<TyrianPriceSeedCache | null> | null = null;
	private readonly states = new RecentStateMap(PRICE_SEED_PANEL_MAX_STATES, (itemId) => this.inFlight.has(itemId));
	private readonly inFlight = new Map<number, Promise<void>>();
	private disposed = false;

	constructor(private readonly options: PriceHistoryPanelSeedOptions) {
		this.cacheTtlMs = options.cacheTtlMs ?? PRICE_SEED_PANEL_CACHE_TTL_MS;
		this.serialize = options.serialize;
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
		let cached: Awaited<ReturnType<TyrianPriceSeedCache['get']>> = null;
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
		// The panel and the note chart both want the whole published history, not the sell rule's
		// year (H13.2 keeps its own default by never overriding `maxDays` on its own call).
		const turn = await this.serialize(async () => await fetchPriceSeed(itemId, {
			transport: this.options.transport, now: this.options.now, actionContext: span.context,
			maxDays: PRICE_SEED_CHART_MAX_DAYS,
		}));
		if (turn.status === 'dropped') {
			// Never asked for: the queue was let go before this item's turn. It goes back to what
			// it was before the load, with nothing written.
			if (cached === null) this.states.delete(itemId);
			else this.states.set(itemId, {
				status: 'seeded', itemId, days: cached.seed.days, failureReason: null, retrievedAt: cached.seed.retrievedAt,
			});
			span.cancel('disposed');
			return;
		}
		const result = turn.value;
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

	private async ensureStore(): Promise<TyrianPriceSeedCache | null> {
		if (this.store !== null) return this.store;
		if (this.opening === null) this.opening = this.openStore();
		return await this.opening;
	}

	private async openStore(): Promise<TyrianPriceSeedCache | null> {
		try {
			const store = await this.options.priceHistory.openSeedCache();
			this.store = store;
			return store;
		} catch {
			return null;
		} finally {
			this.opening = null;
		}
	}
}
