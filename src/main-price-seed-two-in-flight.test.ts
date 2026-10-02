import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { withObsidianHost } from './test/obsidian-host-harness';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import type { HttpRequest, HttpResponse, HttpTransport } from './core/http';
import { SerialTaskQueue } from './core/serial-task-queue';
import { inventoryAdvisorBuiltinBundleProvider } from './advisor/inventory-advisor-builtin-bundle';
import { indexedDbPriceHistoryPort } from './host/indexed-db-price-history';
import { PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN, PriceSeedBulkRefreshService } from './economy/price-seed-bulk-refresh';
import { PriceHistoryPanelSeedService } from './economy/price-seed-panel-service';
import { fetchPriceSeed } from './economy/price-seed-source';
import type { PriceSeedV1 } from './economy/price-seed-model';

const NOW_MS = Date.parse('2026-09-26T07:35:00.000Z');
const STALE_AT_MS = NOW_MS - 25 * 60 * 60 * 1000;
const VAULT = 'two-in-flight-test';
/** An item no calendar entry uses: the one the person picks in the panel. */
const PANEL_ITEM_ID = 999_001;

/**
 * `docs/PLATFORM_POLICY.md`: the datawars2 seed requests go one at a time, never two in flight, for
 * the whole plugin (task 0812d53e). A seed pass (`PriceSeedBulkRefreshService`) and a panel load
 * (`PriceHistoryPanelSeedService`) send through the same transport, so they take turns in one
 * `SerialTaskQueue`: the panel's request, which somebody is looking at, goes right after the request
 * in flight, ahead of the pass's items that have not started, and the pass goes on afterwards.
 *
 * Real core methods (`refreshSale`, `loadPriceHistorySeries`, the deferred pass), the two real
 * services, a real IndexedDB, and one transport instrumented once for both paths, every request
 * held until the test releases it. The services are built the way `initializeRuntime` builds them
 * (same transport, one queue, `fetchPriceSeed` for the bulk service); that wiring is copied here,
 * and observed over the real `initializeRuntime` in `main-price-seed-serial-wiring.test.ts`.
 */
describe('price seed downloads: a panel load next to a seed pass is never a second request in flight', () => {
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
		const transport = transportProbe();
		const priceHistory = indexedDbPriceHistoryPort({ indexedDB: factory });
		const downloads = new SerialTaskQueue();
		let passItemsQueued = 0;
		const bulk = new PriceSeedBulkRefreshService({
			priceHistory, vaultId: VAULT, now: () => NOW_MS,
			fetchSeed: async (itemId, actionContext) => await fetchPriceSeed(itemId, { transport, now: () => NOW_MS, actionContext }),
			serialize: async (task) => { passItemsQueued += 1; return await downloads.run('background', task); },
		});
		const panel = new PriceHistoryPanelSeedService({
			priceHistory, vaultId: VAULT, transport, now: () => NOW_MS, serialize: downloads.runner('interactive'),
		});
		const harness = {
			runtimeReady: true, vaultId: VAULT, unloaded: false,
			collectorMode: 'collector' as 'collector' | 'consult',
			notifyConsultMode: vi.fn(),
			settings: {
				...DEFAULT_SETTINGS, priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400,
			} as unknown as TyrianSettings,
			priceSeedBulkRefresh: bulk, priceHistoryPanelSeed: panel,
			priceSeedQueueCoverage: null, priceSeedDeferredRequest: null as object | null,
			priceSeedDeferredPass: null as Promise<void> | null, priceSeedSyncAction: null, priceSeedSyncGeneration: 0,
			priceSeedCacheReader: null as { close(): void } | null,
			priceSeedCacheReaderOpening: null, saleHeroTimingFlight: null, saleHeroTiming: null,
			priceHistory: { readDaily: async () => [], loadSeries: async () => undefined },
			getInventoryAdvisorViewModel: () => ({ status: 'ready', groups: [{ rows: [{ itemId: 36038, ownedQuantity: 1 }] }] }),
			inventoryAdvisor: {
				refresh: async () => ({ status: 'ready' }),
				analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 374 } }] } } } }),
			},
			localDebugActions: null,
			renderInventoryAdvisorViews: vi.fn(),
		};
		Object.setPrototypeOf(withObsidianHost(harness), TyrianCompanionCore.prototype);
		open.push(() => { transport.open(); bulk.dispose(); panel.dispose(); harness.priceSeedCacheReader?.close(); });
		return {
			harness, transport,
			refreshSale: async () => await core.refreshSale.call(harness),
			panelLoad: async () => await core.loadPriceHistorySeries.call(harness, PANEL_ITEM_ID, 'bid', 30),
			/**
			 * Resolves once the panel has read its cache and reached its download: the service marks the
			 * item `loading` right before it asks for it, queued or not.
			 */
			panelReachedItsDownload: async () => {
				await vi.waitFor(() => { expect(panel.getState(PANEL_ITEM_ID).status).toBe('loading'); });
			},
			/** Resolves once a pass has an item waiting in the queue, or has already sent a second request. */
			passReachedItsDownload: async () => {
				await vi.waitFor(() => { expect(passItemsQueued + transport.requestedItemIds().length).toBeGreaterThan(1); });
			},
		};
	}

	it('panel load during the missing phase of a Sale refresh: the panel request waits for the one in flight', async () => {
		const { transport, refreshSale, panelLoad, panelReachedItsDownload } = await setup([]);

		const sale = refreshSale();
		await transport.started();
		const panelLoading = panelLoad();
		await panelReachedItsDownload();

		expect(transport.inFlight()).toBe(1);
		transport.open();
		await Promise.all([sale, panelLoading]);
		expect(transport.maxInFlight()).toBe(1);
		expect(transport.requestedItemIds()).toContain(PANEL_ITEM_ID);
	});

	it('panel load during the deferred pass of a Sale refresh: the panel request waits for the one in flight', async () => {
		const calendar = calendarItemIds();
		const { harness, transport, refreshSale, panelLoad, panelReachedItsDownload } = await setup(calendar);

		const deferredStarted = transport.started();
		await refreshSale();
		await deferredStarted;
		const panelLoading = panelLoad();
		await panelReachedItsDownload();

		expect(transport.inFlight()).toBe(1);
		transport.open();
		await Promise.all([harness.priceSeedDeferredPass, panelLoading]);
		expect(transport.maxInFlight()).toBe(1);
		expect(transport.requestedItemIds()).toContain(PANEL_ITEM_ID);
	});

	it('the panel request goes right after the one in flight, and the pass then goes on in order, each item once, within its cap', async () => {
		const calendar = calendarItemIds();
		const { transport, refreshSale, panelLoad, panelReachedItsDownload } = await setup([]);
		// More than one item still to come in the pass, or "ahead of the pass" would prove nothing.
		expect(calendar.length).toBeGreaterThan(2);

		const sale = refreshSale();
		await transport.started();
		const panelLoading = panelLoad();
		await panelReachedItsDownload();
		expect(transport.requestedItemIds()).toEqual([calendar[0]]);

		const next = transport.started();
		transport.releaseOldest();
		await next;
		expect(transport.requestedItemIds()).toEqual([calendar[0], PANEL_ITEM_ID]);
		expect(transport.inFlight()).toBe(1);

		transport.open();
		await Promise.all([sale, panelLoading]);
		const passItems = calendar.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(transport.requestedItemIds()).toEqual([passItems[0], PANEL_ITEM_ID, ...passItems.slice(1)]);
		expect(transport.maxInFlight()).toBe(1);
	});

	it.each([
		['the price history opt-in switched off', (harness: { settings: TyrianSettings }) => { harness.settings = { ...harness.settings, priceHistoryEnabled: false }; }],
		['the device turned to consult', (harness: { collectorMode: 'collector' | 'consult' }) => { harness.collectorMode = 'consult'; }],
	] as const)('%s while a pass item waits behind the panel request: that item is not requested', async (_name, withdraw) => {
		const { harness, transport, refreshSale, panelLoad, passReachedItsDownload } = await setup([]);

		const panelStarted = transport.started();
		const panelLoading = panelLoad();
		await panelStarted;
		const sale = refreshSale();
		await passReachedItsDownload();
		withdraw(harness);
		transport.releaseOldest();
		// The pass item's turn comes the moment the panel request ends, before the panel load returns.
		await panelLoading;
		expect(transport.requestedItemIds()).toEqual([PANEL_ITEM_ID]);

		await sale;
		expect(transport.requestedItemIds()).toEqual([PANEL_ITEM_ID]);
	});
});

const core = TyrianCompanionCore.prototype as unknown as {
	refreshSale(this: object): Promise<void>;
	loadPriceHistorySeries(this: object, itemId: number, side: 'bid', windowDays: 30): Promise<void>;
};

function calendarItemIds(): number[] {
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date(NOW_MS).toISOString());
	if (loaded.status !== 'available') throw new Error('Expected the built-in bundle to be available.');
	return loaded.bundle.festivalCalendar.entries.map((entry) => entry.itemId);
}

function seedOf(itemId: number): PriceSeedV1 {
	return { version: 1, itemId, source: 'datawars2', retrievedAt: new Date(NOW_MS).toISOString(), days: [{ dayUtc: '2026-09-25', bidCopper: 100, askCopper: 110 }] };
}

/**
 * The one transport both services send through, instrumented: a single in-flight counter that the
 * seed pass and the panel share, each request held until the test releases it. It answers 404 (a
 * `no_seed`), which is all these tests need: they count and order requests, not seeds.
 */
function transportProbe() {
	const requested: number[] = [];
	const held: Array<() => void> = [];
	const waitingForACall: Array<() => void> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let opened = false;
	const transport: HttpTransport = {
		send: async (request: HttpRequest): Promise<HttpResponse> => {
			requested.push(Number(new URL(request.url).searchParams.get('itemID')));
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			for (const notify of waitingForACall.splice(0)) notify();
			if (!opened) await new Promise<void>((resolve) => { held.push(resolve); });
			inFlight -= 1;
			return { status: 404, headers: {}, body: null };
		},
	};
	return {
		...transport,
		inFlight: () => inFlight,
		maxInFlight: () => maxInFlight,
		requestedItemIds: () => [...requested],
		/** Resolves when the next request starts. */
		started: () => new Promise<void>((resolve) => { waitingForACall.push(resolve); }),
		/** Answers the request that has been held the longest, and only that one. */
		releaseOldest: () => {
			const release = held.shift();
			if (release === undefined) throw new Error('No request is held.');
			release();
		},
		/** Releases every held request and lets the later ones answer at once. */
		open: () => { opened = true; for (const release of held.splice(0)) release(); },
	};
}
