import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import type { SerialTaskRunner, SerialTaskTurn } from '../core/serial-task-queue';
import type { TyrianPriceHistoryPort, TyrianPriceSeedCache, TyrianPriceSeedNoSeedCache } from '../host/tyrian-host-storage';
import type { PriceSeedDayV1, PriceSeedResult, PriceSeedQueueCoverage, PriceSeedV1 } from './price-seed-model';

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
const PRICE_SEED_BULK_REFRESH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

/**
 * 9 oct 2026 (audit Z13), what keeps H18.17's purpose. The 24 h marker above is written when the
 * host ANSWERED that there is nothing: `unavailable` (a non-2xx status that is not transient: 404,
 * 400, 403, 410...), `empty` and `malformed`. Such an item does not crowd out its neighbours, and
 * those answers break the run of failures below. It is NOT written for `unreachable` (network or
 * transport failure, timeout, an oversized body, 408, 425, 429, any 5xx): the host did not say
 * anything about the item, so a pass made while it was limiting or down must not silence 25 items
 * for a day; it heals by itself at the next action. Each of those costs a request (up to the
 * transport's 10 s timeout), so a pass that sees this many `unreachable` in a row ends there, and each of those items then waits
 * `PRICE_SEED_BULK_REFRESH_UNREACHABLE_WAIT_MS` in memory so the next pass reaches the ones behind them.
 */
const PRICE_SEED_BULK_REFRESH_MAX_CONSECUTIVE_UNREACHABLE = 3;

/**
 * The short, memory-only wait of an item that answered `unreachable`. Without it the cut-off above
 * would starve the list: with no marker written, every pass starts again at the same first items,
 * and three of them failing for good (a stable 5xx) would keep the rest from ever being asked. An
 * item inside this wait is skipped with no request and does not count for the cut-off, so the next
 * pass begins with those behind it. Never persisted (the store and the 24 h marker are untouched)
 * and forgotten on reload; still `pending` in the coverage. It is also the longest a healthy host
 * waits to be asked again about an item it failed on.
 */
export const PRICE_SEED_BULK_REFRESH_UNREACHABLE_WAIT_MS = 15 * 60 * 1000;

/** Safety bound for the in-memory waits; a pass adds at most its cap, and expired ones are dropped first. */
const UNREACHABLE_WAIT_MAX_ENTRIES = 500;

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
	/** Present (true) only when the pass ended early after `PRICE_SEED_BULK_REFRESH_MAX_CONSECUTIVE_UNREACHABLE` unreachable answers in a row. */
	stoppedUnreachable?: true;
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
type PriceSeedBulkRefreshPhase =
	| { scope: 'missing'; budget?: number; allowed?: () => boolean }
	| { scope: 'stale'; budget: number; allowed?: () => boolean };

interface PriceSeedBulkRefreshOptions {
	priceHistory: Pick<TyrianPriceHistoryPort, 'openSeedCache' | 'openNoSeedCache'>;
	vaultId: string;
	now: () => number;
	/**
	 * Already bound to the plugin's own transport (`fetchPriceSeed` in `price-seed-source.ts`):
	 * this module never imports a transport of its own, so it carries no outbound capability that
	 * a security review has not already seen on the caller's side.
	 */
	fetchSeed: (itemId: number, actionContext?: ResolvedLocalDebugActionContext) => Promise<PriceSeedResult>;
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
	/** itemId (of this vault) to the instant its short `unreachable` wait ends. See the constant. */
	private readonly unreachableUntil = new Map<number, number>();

	constructor(private readonly options: PriceSeedBulkRefreshOptions) {
		this.maxItemsPerRun = options.maxItemsPerRun ?? PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN;
		this.noSeedRetryMs = options.noSeedRetryMs ?? PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS;
		this.serialize = options.serialize;
	}

	dispose(): void {
		this.disposed = true;
		this.unreachableUntil.clear();
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
		let unreachableStreak = 0;
		for (const itemId of itemIds) {
			if (this.disposed || outcome.attempted >= cap) break;
			if (phase?.allowed !== undefined && !phase.allowed()) break;
			const answer = await this.refreshOne(stores, itemId, outcome, known, parent, phase);
			// Only a request that went out and was not answered counts; skips and answers break the streak.
			if (answer === 'unreachable') unreachableStreak += 1;
			else if (answer !== 'none') unreachableStreak = 0;
			if (unreachableStreak >= PRICE_SEED_BULK_REFRESH_MAX_CONSECUTIVE_UNREACHABLE) {
				outcome.stoppedUnreachable = true;
				break;
			}
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
	): Promise<RefreshAnswer> {
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
			return 'none';
		}
		if (cached !== null) known.set(itemId, 'seeded');
		if (cached !== null && nowMs - cached.cachedAtMs < PRICE_SEED_BULK_REFRESH_CACHE_TTL_MS) {
			outcome.skippedCached += 1;
			span.skip('skipped', 'cached');
			return 'none';
		}
		let recentNoSeed: Awaited<ReturnType<TyrianPriceSeedNoSeedCache['get']>>;
		try {
			recentNoSeed = await noSeedStore.get(this.options.vaultId, itemId);
		} catch (error) {
			outcome.failed += 1;
			span.failure(error, 'storage_failure', 'store_unavailable');
			return 'none';
		}
		if (cached === null) known.set(itemId, recentNoSeed !== null ? 'noData' : 'pending');
		if (recentNoSeed !== null && nowMs - recentNoSeed.failedAtMs < this.noSeedRetryMs) {
			// H18.17: the item that used to re-spend its slot on every single sync. Spaced, not
			// infinite: `this.noSeedRetryMs` is exactly what lets it be asked again later.
			outcome.skippedNoSeedCooldown += 1;
			span.skip('skipped', `no_seed_cooldown_${recentNoSeed.reason}`);
			return 'none';
		}
		const waitUntil = this.unreachableUntil.get(itemId);
		if (waitUntil !== undefined) {
			if (nowMs < waitUntil) {
				// Failed `unreachable` a moment ago: not asked again yet, and not counted for the cut-off.
				span.skip('skipped', 'unreachable_wait');
				return 'none';
			}
			this.unreachableUntil.delete(itemId);
		}
		if (phase?.scope === 'missing' && cached !== null) {
			// A copy past its TTL: the analysis reads it as it is, and the `stale` phase refreshes it.
			outcome.staleSkipped = (outcome.staleSkipped ?? 0) + 1;
			span.skip('skipped', 'stale_deferred');
			return 'none';
		}
		if (phase?.scope === 'stale' && cached === null) {
			span.skip('skipped', 'missing_not_deferred');
			return 'none';
		}
		let turn: SerialTaskTurn<PriceSeedResult | null>;
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
			return 'none';
		}
		if (turn.status === 'dropped' || turn.value === null) {
			// Never asked for: the queue was let go, or the turn came too late. Nothing is counted
			// and nothing is written, so the item is as missing or as stale as it was.
			span.skip('skipped', turn.status === 'dropped' || this.disposed ? 'disposed' : 'not_allowed');
			return 'none';
		}
		const result = turn.value;
		if (!(result.status === 'no_seed' && result.reason === 'unreachable')) this.unreachableUntil.delete(itemId);
		if (this.disposed) {
			// `dispose` closed both stores while this request was in flight: its answer has nowhere to
			// go, and writing it would only record a storage failure nobody can act on.
			span.skip('skipped', 'disposed');
			return 'none';
		}
		if (result.status === 'no_seed' && result.reason === 'unreachable') {
			// The host did not answer about this item (limiting, down, timed out): nothing is
			// remembered, so the next action asks again. See the constant above.
			outcome.failed += 1;
			this.rememberUnreachable(itemId, nowMs);
			span.skip('unavailable', 'no_seed_unreachable');
			return 'unreachable';
		}
		if (result.status === 'no_seed') {
			try {
				await noSeedStore.put(this.options.vaultId, itemId, result.reason, nowMs);
			} catch (error) {
				// The download answered; only the negative-cache write failed, which costs the next
				// run a repeated (free, no-network-hiding-behind-it) attempt and nothing else.
				outcome.failed += 1;
				span.failure(error, 'storage_failure', 'store_unavailable');
				return 'none';
			}
			known.set(itemId, cached !== null ? 'seeded' : 'noData');
			outcome.noSeed += 1;
			span.skip('unavailable', `no_seed_${result.reason}`);
			return 'answered';
		}
		try {
			await store.put(this.options.vaultId, itemId, mergeKeepingOlderDays(cached?.seed ?? null, result.seed), nowMs);
		} catch (error) {
			// The download succeeded; only the cache write failed, which costs the next run a
			// repeated download and nothing else.
			outcome.failed += 1;
			span.failure(error, 'storage_failure', 'store_unavailable');
			return 'none';
		}
		// Best-effort: a stale `no_seed` marker left behind is harmless (the positive cache above
		// is always checked first), so its own failure never turns a successful seed into one.
		try { await noSeedStore.delete(this.options.vaultId, itemId); } catch { /* see above */ }
		known.set(itemId, 'seeded');
		outcome.seeded += 1;
		span.success('seeded');
		return 'answered';
	}

	private rememberUnreachable(itemId: number, nowMs: number): void {
		if (this.unreachableUntil.size >= UNREACHABLE_WAIT_MAX_ENTRIES) {
			for (const [id, until] of this.unreachableUntil) if (until <= nowMs) this.unreachableUntil.delete(id);
			if (this.unreachableUntil.size >= UNREACHABLE_WAIT_MAX_ENTRIES) {
				const oldest = this.unreachableUntil.keys().next();
				if (oldest.done !== true) this.unreachableUntil.delete(oldest.value);
			}
		}
		this.unreachableUntil.delete(itemId);
		this.unreachableUntil.set(itemId, nowMs + PRICE_SEED_BULK_REFRESH_UNREACHABLE_WAIT_MS);
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
/** What one item's turn tells the loop: `unreachable` is the host not answering, `answered` any answer it gave, `none` no request that settled. */
type RefreshAnswer = 'unreachable' | 'answered' | 'none';

interface Stores {
	store: TyrianPriceSeedCache;
	noSeedStore: TyrianPriceSeedNoSeedCache;
}

/**
 * Z12: the pass downloads only the newest `maxDays` (400 outside the festival calendar), and
 * writing that over a longer copy the panel had downloaded cut the chart short for good, with no
 * extra request that could repair it inside the 24 h rule (H18.17). So the days the previous copy
 * has that the new download no longer reaches are kept, and on the days both have, the new one
 * wins. Days stay ascending and unique, which is what `isPriceSeed` requires. The result never has
 * more days than the longer of the two inputs (the oldest are dropped): a copy refreshed every day
 * would otherwise gain a day per pass for every item the pass covers, without bound.
 */
function mergeKeepingOlderDays(previous: PriceSeedV1 | null, fresh: PriceSeedV1): PriceSeedV1 {
	if (previous === null || previous.days.length === 0 || fresh.days.length === 0) return fresh;
	const byDay = new Map<string, PriceSeedDayV1>();
	for (const day of previous.days) byDay.set(day.dayUtc, day);
	for (const day of fresh.days) byDay.set(day.dayUtc, day);
	if (byDay.size === fresh.days.length) return fresh;
	const sorted = [...byDay.values()].sort((left, right) => (left.dayUtc < right.dayUtc ? -1 : left.dayUtc > right.dayUtc ? 1 : 0));
	const cap = Math.max(previous.days.length, fresh.days.length);
	const days = sorted.length > cap ? sorted.slice(sorted.length - cap) : sorted;
	return { ...fresh, days };
}
