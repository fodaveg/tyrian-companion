import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { withObsidianHost } from './test/obsidian-host-harness';
import { inventoryAdvisorBuiltinBundleProvider } from './advisor/inventory-advisor-builtin-bundle';
import { indexedDbPriceHistoryPort } from './host/indexed-db-price-history';
import { PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN, PriceSeedBulkRefreshService } from './economy/price-seed-bulk-refresh';
import type { PriceSeedQueueCoverage } from './economy/price-seed-bulk-refresh';
import type { PriceSeedResult, PriceSeedV1 } from './economy/price-seed-model';

const NOW_MS = Date.parse('2026-09-26T07:35:00.000Z');
const STALE_AT_MS = NOW_MS - 25 * 60 * 60 * 1000;
const VAULT = 'seed-phases-test';

/**
 * 1 oct 2026: an explicit action waits only for the seeds that are MISSING. A copy past its 24 h is
 * what the analysis reads, and its refresh starts after the result is delivered and painted.
 *
 * Every test runs the real core methods (`refreshSale`, `refreshInventoryAdvisor`, the sync's own
 * seed pass) over the real `PriceSeedBulkRefreshService` and a real IndexedDB; only the download is
 * a probe whose answers the test releases by hand, so nothing here waits on a clock.
 */
describe('price seed phases through the core: missing seeds before the result, stale copies after it', () => {
	const open: Array<() => void> = [];

	afterEach(() => {
		for (const release of open.splice(0)) release();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function setup(staleItemIds: readonly number[]) {
		const factory = new IDBFactory();
		vi.stubGlobal('window', { indexedDB: factory });
		vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
		const cache = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		for (const itemId of staleItemIds) await cache.put(VAULT, itemId, seedOf(itemId), STALE_AT_MS);
		cache.close();
		const probe = seedProbe();
		const service = new PriceSeedBulkRefreshService({
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: VAULT, now: () => NOW_MS,
			fetchSeed: probe.fetchSeed,
		});
		const syncItemIds: { current: readonly number[] } = { current: [] };
		const renderInventoryAdvisorViews = vi.fn();
		const harness = {
			runtimeReady: true, vaultId: VAULT, unloaded: false,
			settings: { priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000 },
			priceSeedBulkRefresh: service,
			priceSeedQueueCoverage: null as PriceSeedQueueCoverage | null,
			priceSeedDeferredPass: null as Promise<void> | null,
			priceSeedCacheReader: null as { close(): void } | null,
			priceSeedCacheReaderOpening: null, saleHeroTimingFlight: null, saleHeroTiming: null,
			priceHistory: { readDaily: async () => [] },
			getInventoryAdvisorViewModel: () => ({ status: 'ready', groups: [{ rows: [{ itemId: 36038, ownedQuantity: 1 }] }] }),
			inventoryAdvisor: {
				// What the workflow does inside a sync's analysis: the analysis port's seed pass, then the result.
				refresh: async () => {
					if (syncItemIds.current.length > 0) await core.refreshPriceSeedsForSync.call(harness, syncItemIds.current);
					return { status: 'ready' };
				},
				analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 374 } }] } } } }),
			},
			renderInventoryAdvisorViews,
		};
		Object.setPrototypeOf(withObsidianHost(harness), TyrianCompanionCore.prototype);
		open.push(() => { probe.open(); service.dispose(); harness.priceSeedCacheReader?.close(); });
		const readCachedAt = async (itemId: number): Promise<number | null> => {
			const reader = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
			try { return (await reader.get(VAULT, itemId))?.cachedAtMs ?? null; } finally { reader.close(); }
		};
		return {
			harness, probe, service, renderInventoryAdvisorViews, readCachedAt,
			refreshSale: () => core.refreshSale.call(harness),
			/** One "Sincronizar inventario" analysis whose derived watch list is `itemIds`. */
			syncRefresh: (itemIds: readonly number[]) => {
				syncItemIds.current = itemIds;
				return core.refreshInventoryAdvisor.call(harness);
			},
			/** Whatever is still queued in the service has run once this resolves. */
			drain: async () => { await harness.priceSeedDeferredPass; await service.run([]); },
		};
	}

	it('Sale, only stale copies: the refresh resolves with no download made, and they follow one at a time', async () => {
		const calendar = calendarItemIds();
		const { harness, probe, refreshSale, readCachedAt } = await setup(calendar);

		expect(await firstOf(refreshSale(), probe)).toBe('resolved');
		expect(probe.calls).toEqual([]);

		await probe.started();
		expect(probe.calls).toHaveLength(1);
		probe.open();
		await harness.priceSeedDeferredPass;

		expect([...probe.calls].sort(byId)).toEqual([...calendar].sort(byId));
		expect(probe.maxInFlight()).toBe(1);
		expect(await readCachedAt(calendar[0]!)).toBe(NOW_MS);
	});

	it('Sale, missing and stale together: the refresh waits for the missing seeds and only for those', async () => {
		const calendar = calendarItemIds();
		const missing = calendar.slice(0, 2);
		const stale = calendar.slice(2);
		const { harness, probe, refreshSale } = await setup(stale);

		const refresh = refreshSale();
		for (const _itemId of missing) {
			await probe.started();
			probe.releaseOne();
		}
		expect(await firstOf(refresh, probe)).toBe('resolved');
		expect([...probe.calls].sort(byId)).toEqual([...missing].sort(byId));

		probe.open();
		await harness.priceSeedDeferredPass;
		expect([...probe.calls.slice(missing.length)].sort(byId)).toEqual([...stale].sort(byId));
		expect(probe.maxInFlight()).toBe(1);
	});

	it('sync, more than the cap: the missing seeds first, and 25 downloads per action between the two phases', async () => {
		const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
		const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
		const { probe, syncRefresh, drain } = await setup(stale);
		probe.open();

		await syncRefresh([...stale, ...missing]);
		expect(probe.calls).toEqual(missing);

		await drain();
		expect(probe.calls).toEqual([...missing, ...stale.slice(0, 5)]);
		expect(probe.calls).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(probe.maxInFlight()).toBe(1);
	});

	it('sync, the missing seeds alone reach the cap: no stale copy is refreshed by that action', async () => {
		const stale = [1, 2, 3];
		const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN + 4 }, (_unused, index) => index + 11);
		const { probe, syncRefresh, drain } = await setup(stale);
		probe.open();

		await syncRefresh([...stale, ...missing]);
		await drain();

		expect(probe.calls).toEqual(missing.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN));
	});

	it('sync, one missing seed and stale copies: the coverage comes with the result and the deferred pass repaints it once', async () => {
		const { harness, probe, syncRefresh, renderInventoryAdvisorViews } = await setup([1, 2, 3]);

		// Item 4 has no seed: the action waits for it, and for nothing else.
		const refresh = syncRefresh([1, 2, 3, 4]);
		expect(await firstOf(refresh, probe)).toBe('fetch_started');
		expect(probe.calls).toEqual([4]);
		probe.releaseOne();
		expect(await firstOf(refresh, probe)).toBe('resolved');
		// The three stale copies already count as data: the line is complete with the result.
		expect(harness.priceSeedQueueCoverage).toEqual({ total: 4, seeded: 4, noData: 0, pending: 0 });
		const rendersWithTheResult = renderInventoryAdvisorViews.mock.calls.length;
		expect(probe.calls).toEqual([4]);

		probe.open();
		await harness.priceSeedDeferredPass;

		expect(probe.calls).toEqual([4, 1, 2, 3]);
		expect(harness.priceSeedQueueCoverage).toEqual({ total: 4, seeded: 4, noData: 0, pending: 0 });
		expect(renderInventoryAdvisorViews.mock.calls.length).toBe(rendersWithTheResult + 1);
	});

	it('unload in the middle of the deferred pass: it stops, stores nothing more, and repaints nothing', async () => {
		const { harness, probe, service, syncRefresh, renderInventoryAdvisorViews, readCachedAt } = await setup([1, 2, 3]);

		expect(await firstOf(syncRefresh([1, 2, 3]), probe)).toBe('resolved');
		const coverageWithTheResult = harness.priceSeedQueueCoverage;
		expect(coverageWithTheResult).toEqual({ total: 3, seeded: 3, noData: 0, pending: 0 });
		await probe.started();
		const rendersBeforeUnload = renderInventoryAdvisorViews.mock.calls.length;

		// What `shutdownRuntime` does to this service.
		harness.unloaded = true;
		service.dispose();
		probe.open();
		await harness.priceSeedDeferredPass;

		expect(probe.calls).toEqual([1]);
		expect(await readCachedAt(1)).toBe(STALE_AT_MS);
		expect(renderInventoryAdvisorViews.mock.calls.length).toBe(rendersBeforeUnload);
		expect(harness.priceSeedQueueCoverage).toEqual(coverageWithTheResult);
	});

	it('a second action while a deferred pass is alive: no second deferred pass, its missing seeds wait their turn', async () => {
		const { probe, syncRefresh, drain } = await setup([1, 2, 3, 7, 8]);

		expect(await firstOf(syncRefresh([1, 2, 3]), probe)).toBe('resolved');
		await probe.started();
		expect(probe.calls).toEqual([1]);

		// 7 and 8 are stale copies only the second action knows; 9 and 10 have no seed at all.
		const second = syncRefresh([1, 2, 3, 7, 8, 9, 10]);
		probe.open();
		await second;
		await drain();

		expect(probe.calls).toEqual([1, 2, 3, 9, 10]);
		expect(probe.maxInFlight()).toBe(1);
	});
});

const core = TyrianCompanionCore.prototype as unknown as {
	refreshSale(this: object): Promise<void>;
	refreshInventoryAdvisor(this: object): Promise<void>;
	refreshPriceSeedsForSync(this: object, itemIds: readonly number[]): Promise<void>;
};

const byId = (left: number, right: number): number => left - right;

/** The festival calendar's items, the list an explicit Sale refresh seeds. */
function calendarItemIds(): number[] {
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date(NOW_MS).toISOString());
	if (loaded.status !== 'available') throw new Error('Expected the built-in bundle to be available.');
	return loaded.bundle.festivalCalendar.entries.map((entry) => entry.itemId);
}

function seedOf(itemId: number): PriceSeedV1 {
	return { version: 1, itemId, source: 'datawars2', retrievedAt: new Date(NOW_MS).toISOString(), days: [{ dayUtc: '2026-09-25', bidCopper: 100, askCopper: 110 }] };
}

/** Which happens first: the action resolves, or a download starts while it is still pending. */
async function firstOf(action: Promise<void>, probe: ReturnType<typeof seedProbe>): Promise<'resolved' | 'fetch_started'> {
	return await Promise.race([
		action.then(() => 'resolved' as const),
		probe.started().then(() => 'fetch_started' as const),
	]);
}

/**
 * The download, instrumented: every call is recorded and held until the test releases it, so the
 * order of the calls and how many are in flight together are facts the test reads, not timings.
 */
function seedProbe() {
	const calls: number[] = [];
	const held: Array<() => void> = [];
	const waitingForACall: Array<() => void> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let opened = false;
	return {
		calls,
		maxInFlight: () => maxInFlight,
		fetchSeed: async (itemId: number): Promise<PriceSeedResult> => {
			calls.push(itemId);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			for (const notify of waitingForACall.splice(0)) notify();
			if (!opened) await new Promise<void>((resolve) => { held.push(resolve); });
			inFlight -= 1;
			return { status: 'seeded', seed: seedOf(itemId) };
		},
		/** Resolves when the next download starts. */
		started: () => new Promise<void>((resolve) => { waitingForACall.push(resolve); }),
		releaseOne: () => { held.shift()?.(); },
		/** Releases every held download and lets the later ones answer at once. */
		open: () => { opened = true; for (const release of held.splice(0)) release(); },
	};
}
