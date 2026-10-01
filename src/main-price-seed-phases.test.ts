import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { withObsidianHost } from './test/obsidian-host-harness';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
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
 * what the analysis reads, and its refresh starts once the action that left it has ended.
 *
 * Every test runs the real core methods (`refreshSale`, `runInventoryVaultSync` and the analyses it
 * runs, the sync's own seed pass) over the real `PriceSeedBulkRefreshService` and a real IndexedDB;
 * the one-click controller is replaced by the steps it takes, and only the download is
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
		/** The derived watch list of each analysis a sync runs, in order; an analysis past the last one seeds nothing. */
		const syncLists: Array<readonly number[]> = [];
		const analysisHolds: Gate[] = [];
		let syncSteps: () => Promise<void> = async () => undefined;
		const renderInventoryAdvisorViews = vi.fn();
		// What the workflow does inside an analysis that runs on behalf of a sync: the analysis port's
		// seed pass over that analysis's watch list, then the result. Any other analysis seeds nothing.
		const analyse = vi.fn(async () => {
			const itemIds = harness.inventoryAnalysisForSync ? syncLists.shift() : undefined;
			if (itemIds !== undefined) {
				if (itemIds.length > 0) await core.refreshPriceSeedsForSync.call(harness, itemIds);
				await analysisHolds.shift()?.wait();
			}
			return { status: 'ready' };
		});
		const harness = {
			runtimeReady: true, vaultId: VAULT, unloaded: false,
			collectorMode: 'collector' as 'collector' | 'consult',
			notifyConsultMode: vi.fn(),
			settings: {
				...DEFAULT_SETTINGS,
				priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000,
			} as unknown as TyrianSettings,
			// What `updateSettings` and `shutdownRuntime` reach on their way through the real core.
			app: { vault: { configDir: 'test-config-dir' } },
			saveData: vi.fn(async () => undefined),
			halloween: null, halloweenPriceAlert: null,
			renderViews: vi.fn(),
			settingTab: { refreshForSettingsChange: vi.fn() },
			ingameReceipts: { dispose: vi.fn() },
			priceSeedBulkRefresh: service,
			priceSeedQueueCoverage: null as PriceSeedQueueCoverage | null,
			priceSeedDeferredRequest: null as object | null,
			priceSeedDeferredPass: null as Promise<void> | null,
			priceSeedSyncAction: null as object | null,
			priceSeedSyncGeneration: 0,
			priceSeedCacheReader: null as { close(): void } | null,
			priceSeedCacheReaderOpening: null, saleHeroTimingFlight: null, saleHeroTiming: null,
			priceHistory: {
				readDaily: async () => [], configure: async () => undefined, setOnline: () => undefined, dispose: () => undefined,
			},
			getInventoryAdvisorViewModel: () => ({ status: 'ready', groups: [{ rows: [{ itemId: 36038, ownedQuantity: 1 }] }] }),
			inventoryAnalysisForSync: false,
			inventoryAdvisorPhaseListener: { current: null }, inventoryAdvisorCaptureProgressListener: { current: null },
			inventoryAdvisor: {
				refresh: () => analyse(),
				// No object results: an analysis the notes cannot be written from, so a sync that goes on to
				// its notes runs the recovery read (`inventoryAnalysisForNotes`), a second analysis.
				analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 374 } }] } } }, objects: null }),
				dispose: () => undefined,
			},
			// The one-click controller's place: `run` is the whole action `runInventoryVaultSync` waits for.
			inventoryVaultSyncRun: {
				run: async () => { await syncSteps(); return { status: 'idle', lastRun: null }; },
				current: () => ({ status: 'idle', lastRun: null }),
				dispose: () => undefined,
			},
			renderInventoryAdvisorViews,
		};
		Object.setPrototypeOf(withObsidianHost(harness), TyrianCompanionCore.prototype);
		open.push(() => { probe.open(); service.dispose(); harness.priceSeedCacheReader?.close(); });
		const readCachedAt = async (itemId: number): Promise<number | null> => {
			const reader = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
			try { return (await reader.get(VAULT, itemId))?.cachedAtMs ?? null; } finally { reader.close(); }
		};
		/**
		 * One whole "Sincronizar inventario" through the real `runInventoryVaultSync`: the sync's own
		 * analysis, then (with `recoveryRead`) the second analysis the notes ask for, then (with
		 * `notesHold`) the time it spends writing notes. `lists` is the watch list of each analysis.
		 */
		const sync = (
			lists: ReadonlyArray<readonly number[]>,
			options: { recoveryRead?: boolean; analysisHold?: Gate; notesHold?: Gate; failAfterAnalysis?: boolean } = {},
		): Promise<void> => {
			syncLists.splice(0, syncLists.length, ...lists);
			analysisHolds.splice(0, analysisHolds.length, ...(options.analysisHold ? [options.analysisHold] : []));
			syncSteps = async () => {
				await core.refreshInventoryAdvisorForSync.call(harness, () => undefined, () => undefined);
				if (options.failAfterAnalysis) throw new Error('The sync run rejected after its analysis.');
				// The recovery read cannot be written from either in this harness; the run settles on it
				// as the controller does, with an error it records and does not rethrow.
				if (options.recoveryRead) await core.inventoryAnalysisForNotes.call(harness).catch(() => undefined);
				await options.notesHold?.wait();
			};
			return core.runInventoryVaultSync.call(harness);
		};
		return {
			harness, probe, service, renderInventoryAdvisorViews, readCachedAt, analyse, sync,
			/** One explicit Sale refresh: the calendar's seed pass, then an analysis that is not a sync's. */
			refreshSale: () => core.refreshSale.call(harness),
			/** One "Sincronizar inventario", start to end, whose derived watch list is `itemIds`. */
			syncRefresh: (itemIds: readonly number[]) => sync([itemIds]),
			/** The analysis the manual preview asks for, with no `runInventoryVaultSync` around it. */
			recoveryReadAlone: async (itemIds: readonly number[]): Promise<void> => {
				syncLists.splice(0, syncLists.length, itemIds);
				await core.inventoryAnalysisForNotes.call(harness).catch(() => undefined);
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
		for (let answered = 0; answered < missing.length; answered += 1) {
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
		const { harness, probe, syncRefresh, renderInventoryAdvisorViews, analyse } = await setup([1, 2, 3]);

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
		// What the deferred pass downloaded is for the next analysis: it starts none itself.
		expect(analyse).toHaveBeenCalledTimes(1);
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

	it('a Sale refresh while a sync\'s deferred pass is alive: the calendar\'s stale copies are not queued behind it', async () => {
		const calendar = calendarItemIds();
		const { probe, syncRefresh, refreshSale, drain } = await setup([1, 2, 3, ...calendar]);

		expect(await firstOf(syncRefresh([1, 2, 3]), probe)).toBe('resolved');
		await probe.started();

		const sale = refreshSale();
		probe.open();
		await sale;
		await drain();

		expect(probe.calls).toEqual([1, 2, 3]);
		expect(probe.maxInFlight()).toBe(1);
	});

	/**
	 * Review of 1 oct 2026. The deferred pass belongs to the action that left it: it starts when that
	 * whole action ends, only while the opt-in still stands, and nothing else can start it.
	 */
	describe('the deferred pass is started by its own action, at its end, and only while it is still allowed', () => {
		it('sync with a second analysis: its missing seeds are not queued behind the stale copies, which start when the whole action ends', async () => {
			const missing = [11, 12, 13, 14, 15];
			const later = [21, 22];
			const { harness, probe, service, sync, drain, analyse } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3, ...missing], [1, 2, 3, ...missing, ...later]], { recoveryRead: true, notesHold: notes });
			await notes.reached;
			// "Analizar" pressed while the sync is still writing its notes: it starts nothing either.
			await core.refreshInventoryAdvisor.call(harness);
			await service.run([]);

			expect(probe.calls).toEqual([...missing, ...later]);
			expect(harness.priceSeedDeferredPass).toBeNull();

			notes.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([...missing, ...later, 1, 2, 3]);
			expect(probe.maxInFlight()).toBe(1);
			expect(analyse).toHaveBeenCalledTimes(3);
		});

		it('sync with a second analysis: the cap of 25 is the action\'s, and the second analysis does not get a new one', async () => {
			const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
			const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
			const later = Array.from({ length: 10 }, (_unused, index) => index + 41);
			const { probe, sync, drain } = await setup(stale);
			probe.open();

			await sync([[...stale, ...missing], [...stale, ...missing, ...later]], { recoveryRead: true });
			await drain();

			// 20 missing seeds in the first analysis, the 5 left of the cap in the second, and no stale copy.
			expect(probe.calls).toEqual([...missing, ...later.slice(0, 5)]);
			expect(probe.calls).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		});

		it('sync with a second analysis that leaves no stale copies of its own: the first analysis\'s are kept and refreshed out of what the action has left of its cap', async () => {
			const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
			const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
			const later = [41, 42, 43];
			const { probe, sync, drain } = await setup(stale);
			probe.open();

			// The second analysis's list has no copy past its 24 h: three missing seeds and nothing else.
			await sync([[...stale, ...missing], later], { recoveryRead: true });
			await drain();

			// 20 + 3 missing seeds leave 2 of the cap: two stale copies of the first list, not the 5 it had left.
			expect(probe.calls).toEqual([...missing, ...later, 1, 2]);
			expect(probe.calls).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
			expect(probe.maxInFlight()).toBe(1);
		});

		it('sync with a second analysis that spends the rest of the cap and leaves no stale copies of its own: nothing is kept and no deferred pass starts', async () => {
			const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
			const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
			const later = Array.from({ length: 10 }, (_unused, index) => index + 41);
			const { harness, probe, sync, drain } = await setup(stale);
			probe.open();

			await sync([[...stale, ...missing], later], { recoveryRead: true });

			expect(harness.priceSeedDeferredPass).toBeNull();
			expect(harness.priceSeedDeferredRequest).toBeNull();
			await drain();
			expect(probe.calls).toEqual([...missing, ...later.slice(0, 5)]);
		});

		it('sync that rejects after its analysis: the stale copies it left are started by that same action, and nothing stays in the slot', async () => {
			const { harness, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();

			await expect(sync([[1, 2, 3]], { failAfterAnalysis: true })).rejects.toThrow('The sync run rejected after its analysis.');

			expect(harness.priceSeedDeferredRequest).toBeNull();
			expect(harness.priceSeedSyncAction).toBeNull();
			await drain();
			expect(probe.calls).toEqual([1, 2, 3]);
		});

		it('sync, the device turned to consult between two missing seeds: the downloads stop after the one in flight', async () => {
			const { harness, probe, sync, drain } = await setup([]);

			const action = sync([[11, 12, 13]]);
			await probe.started();
			expect(probe.calls).toEqual([11]);
			harness.collectorMode = 'consult';
			probe.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([11]);
		});

		it('the opt-in switched off before the action ends: no deferred pass starts', async () => {
			const { harness, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			// Straight on the settings, not through `updateSettings`, which empties the slot itself.
			harness.settings.priceHistoryEnabled = false;
			notes.open();
			await action;

			expect(harness.priceSeedDeferredPass).toBeNull();
			await drain();
			expect(probe.calls).toEqual([]);
		});

		it('the opt-in switched off in the middle of the deferred pass: it stops at the next item', async () => {
			const { harness, probe, sync } = await setup([1, 2, 3]);

			expect(await firstOf(sync([[1, 2, 3]]), probe)).toBe('resolved');
			await probe.started();
			expect(probe.calls).toEqual([1]);

			harness.settings.priceHistoryEnabled = false;
			probe.open();
			await harness.priceSeedDeferredPass;

			expect(probe.calls).toEqual([1]);
		});

		it('the opt-in switched off in Settings while the stale copies wait: the slot is emptied, and switching it back on starts nothing', async () => {
			const { harness, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			expect(harness.priceSeedDeferredRequest).not.toBeNull();

			await core.updateSettings.call(harness, { priceHistoryEnabled: false });
			expect(harness.priceSeedDeferredRequest).toBeNull();

			await core.updateSettings.call(harness, { priceHistoryEnabled: true });
			notes.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([]);
		});

		it('Sale, the device turned to consult while the missing seed downloads: the stale copies are dropped, and a later "Analizar" starts nothing', async () => {
			const calendar = calendarItemIds();
			const missing = calendar.slice(0, 1);
			const { harness, probe, refreshSale, drain } = await setup(calendar.slice(1));

			const refresh = refreshSale();
			await probe.started();
			// The advisor refresh that closes this Sale refresh is now refused before it starts.
			harness.collectorMode = 'consult';
			probe.releaseOne();
			await refresh;

			expect(harness.priceSeedDeferredRequest).toBeNull();

			harness.collectorMode = 'collector';
			await core.refreshInventoryAdvisor.call(harness);
			probe.open();
			await drain();

			expect(probe.calls).toEqual(missing);
		});

		it('sync, the device turned to consult while the notes are written, with no refresh refused: no deferred pass starts and the slot is left empty', async () => {
			const { harness, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			expect(harness.priceSeedDeferredRequest).not.toBeNull();
			// Nothing asks for an advisor refresh from here on, so nothing is refused in consult.
			harness.collectorMode = 'consult';
			notes.open();
			await action;

			expect(harness.priceSeedDeferredPass).toBeNull();
			expect(harness.priceSeedDeferredRequest).toBeNull();
			await drain();
			expect(probe.calls).toEqual([]);
		});

		it('sync, a refresh refused in consult while the notes are written, and the device back to collector before the end: the stale copies stay dropped', async () => {
			const { harness, probe, sync, drain } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			harness.collectorMode = 'consult';
			// "Analizar" pressed in consult: refused, and what waited in the slot goes with it.
			await core.refreshInventoryAdvisor.call(harness);
			expect(harness.priceSeedDeferredRequest).toBeNull();
			harness.collectorMode = 'collector';
			notes.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([]);
		});

		it('sync, the opt-in switched off between two missing seeds: the downloads stop after the one in flight', async () => {
			const { harness, probe, sync, drain } = await setup([]);

			const action = sync([[11, 12, 13]]);
			await probe.started();
			expect(probe.calls).toEqual([11]);
			harness.settings.priceHistoryEnabled = false;
			probe.open();
			await action;
			await drain();

			expect(probe.calls).toEqual([11]);
		});

		it('Sale, the opt-in switched off between two missing seeds: the downloads stop after the one in flight', async () => {
			const calendar = calendarItemIds();
			const { harness, probe, refreshSale, drain } = await setup([]);

			const refresh = refreshSale();
			await probe.started();
			harness.settings.priceHistoryEnabled = false;
			probe.open();
			await refresh;
			await drain();

			expect(probe.calls).toEqual(calendar.slice(0, 1));
		});

		it('a sync and a Sale refresh overlapping, neither with a deferred pass alive when it arrived: the first to leave its stale copies keeps the slot', async () => {
			const calendar = calendarItemIds();
			const { probe, sync, refreshSale, drain } = await setup([1, 2, 3, ...calendar]);
			const analysis = gate();

			// The sync waits for its one missing seed; the Sale refresh arrives meanwhile, and its own
			// missing phase (nothing to request) queues behind it.
			const action = sync([[1, 2, 3, 4]], { analysisHold: analysis });
			await probe.started();
			const sale = refreshSale();
			probe.releaseOne();
			// The sync has left its stale copies and is still analysing when the Sale refresh finishes.
			await analysis.reached;
			await sale;
			analysis.open();
			await action;
			probe.open();
			await drain();

			expect(probe.calls).toEqual([4, 1, 2, 3]);
			expect(probe.maxInFlight()).toBe(1);
		});

		it('a deferred pass of an older sync list: once a newer sync has started it neither rewrites the coverage nor repaints', async () => {
			const { harness, probe, sync, renderInventoryAdvisorViews } = await setup([1, 2, 3]);

			expect(await firstOf(sync([[1, 2, 3]]), probe)).toBe('resolved');
			await probe.started();
			const coverageOfTheOlderSync = harness.priceSeedQueueCoverage;

			const newer = sync([[1, 2, 3, 5]]);
			const rendersOnceTheNewerSyncStarted = renderInventoryAdvisorViews.mock.calls.length;
			// The older pass's three downloads answer; the next one to start is the newer sync's missing seed.
			for (let answered = 0; answered < 3; answered += 1) {
				const next = probe.started();
				probe.releaseOne();
				await next;
			}
			expect(probe.calls).toEqual([1, 2, 3, 5]);

			expect(renderInventoryAdvisorViews.mock.calls.length).toBe(rendersOnceTheNewerSyncStarted);
			expect(harness.priceSeedQueueCoverage).toBe(coverageOfTheOlderSync);

			probe.open();
			await newer;
			expect(harness.priceSeedQueueCoverage).toEqual({ total: 4, seeded: 4, noData: 0, pending: 0 });
		});

		it('a sync\'s analysis outside the sync action (the manual preview\'s recovery read): the missing seed is requested and no stale copy is left waiting', async () => {
			const { harness, probe, recoveryReadAlone, drain } = await setup([1, 2, 3]);
			probe.open();

			await recoveryReadAlone([1, 2, 3, 4]);
			await drain();

			expect(probe.calls).toEqual([4]);
			expect(harness.priceSeedDeferredRequest).toBeNull();
		});

		it('the real shutdownRuntime while the stale copies wait: the slot is emptied and the action\'s end starts nothing', async () => {
			const { harness, probe, sync } = await setup([1, 2, 3]);
			probe.open();
			const notes = gate();

			const action = sync([[1, 2, 3]], { notesHold: notes });
			await notes.reached;
			expect(harness.priceSeedDeferredRequest).not.toBeNull();

			await core.shutdownRuntime.call(harness);
			expect(harness.priceSeedDeferredRequest).toBeNull();

			notes.open();
			await action;
			expect(harness.priceSeedDeferredPass).toBeNull();
			expect(probe.calls).toEqual([]);
		});
	});
});

const core = TyrianCompanionCore.prototype as unknown as {
	refreshSale(this: object): Promise<void>;
	refreshInventoryAdvisor(this: object): Promise<void>;
	refreshPriceSeedsForSync(this: object, itemIds: readonly number[]): Promise<void>;
	runInventoryVaultSync(this: object): Promise<void>;
	refreshInventoryAdvisorForSync(this: object, onPhase: () => void, onCaptureProgress: () => void): Promise<void>;
	inventoryAnalysisForNotes(this: object): Promise<unknown>;
	updateSettings(this: object, update: Partial<TyrianSettings>): Promise<unknown>;
	shutdownRuntime(this: object): Promise<void>;
};

interface Gate {
	/** Resolves once the code under test has reached this point. */
	readonly reached: Promise<void>;
	/** What the code under test awaits: it marks the point as reached and waits for `open`. */
	wait(): Promise<void>;
	open(): void;
}

/** A point where the test holds the action until it decides to let it go on. */
function gate(): Gate {
	let open!: () => void;
	let reach!: () => void;
	const opened = new Promise<void>((resolve) => { open = resolve; });
	const reached = new Promise<void>((resolve) => { reach = resolve; });
	return { reached, open, wait: async () => { reach(); await opened; } };
}

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
