import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';
import { withObsidianHost } from './test/obsidian-host-harness';
import { DEFAULT_SETTINGS, type TyrianSettings } from './core/settings';
import type { HttpRequest, HttpResponse, HttpTransport } from './core/http';
import { inventoryAdvisorBuiltinBundleProvider } from './advisor/inventory-advisor-builtin-bundle';
import { indexedDbPriceHistoryPort } from './host/indexed-db-price-history';
import { PriceSeedBulkRefreshService } from './economy/price-seed-bulk-refresh';
import { PriceHistoryPanelSeedService } from './economy/price-seed-panel-service';
import { fetchPriceSeed } from './economy/price-seed-source';
import type { PriceSeedV1 } from './economy/price-seed-model';

const NOW_MS = Date.parse('2026-09-26T07:35:00.000Z');
const STALE_AT_MS = NOW_MS - 25 * 60 * 60 * 1000;
const VAULT = 'two-in-flight-test';
/** An item no calendar entry uses: the one the person picks in the panel. */
const PANEL_ITEM_ID = 999_001;

/**
 * KNOWN NON-COMPLIANCE, characterised and not endorsed (task 0812d53e). `docs/PLATFORM_POLICY.md`
 * says the datawars2 seed requests are "en serie, nunca en paralelo" and that the deferred pass goes
 * "en serie por la misma cola". `PriceSeedBulkRefreshService` keeps that promise for its own passes
 * (one queue, `pending`), but the panel downloads through `PriceHistoryPanelSeedService`, which has
 * its own flight map and no knowledge of that queue, over the SAME transport. So a panel load made
 * while a sync, a Sale refresh or a deferred pass has a request in flight is a second request in
 * flight. These tests pin the CURRENT behaviour (2); when the two services share one queue, the
 * expected value becomes 1 and the comments here go with it.
 *
 * Real core methods (`refreshSale`, `loadPriceHistorySeries`, the deferred pass), the two real
 * services, a real IndexedDB, and one transport instrumented once for both paths. The services are
 * built the way `initializeRuntime` builds them (same transport, `fetchPriceSeed` for the bulk
 * service); `initializeRuntime` itself is not driven, so that wiring is copied here, not observed.
 */
describe('price seed downloads: a panel load next to a seed pass (known break of "never two in flight")', () => {
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
		const bulk = new PriceSeedBulkRefreshService({
			priceHistory, vaultId: VAULT, now: () => NOW_MS,
			fetchSeed: async (itemId, actionContext) => await fetchPriceSeed(itemId, { transport, now: () => NOW_MS, actionContext }),
		});
		const panel = new PriceHistoryPanelSeedService({ priceHistory, vaultId: VAULT, transport, now: () => NOW_MS });
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
		};
	}

	it('panel load during the missing phase of a Sale refresh: two requests are in flight together', async () => {
		const { transport, refreshSale, panelLoad } = await setup([]);

		const sale = refreshSale();
		await transport.started();
		const panelLoading = panelLoad();
		await transport.started();

		expect(transport.maxInFlight()).toBe(2);
		transport.open();
		await Promise.all([sale, panelLoading]);
	});

	it('panel load during the deferred pass of a Sale refresh: two requests are in flight together', async () => {
		const calendar = calendarItemIds();
		const { harness, transport, refreshSale, panelLoad } = await setup(calendar);

		await refreshSale();
		await transport.started();
		const panelLoading = panelLoad();
		await transport.started();

		expect(transport.maxInFlight()).toBe(2);
		transport.open();
		await Promise.all([harness.priceSeedDeferredPass, panelLoading]);
	});

	it('the panel request is for the panel item and the seed pass one is for a calendar item, over the same transport', async () => {
		const { transport, refreshSale, panelLoad } = await setup([]);

		const sale = refreshSale();
		await transport.started();
		const panelLoading = panelLoad();
		await transport.started();

		expect(transport.requestedItemIds().map((itemId) => itemId === PANEL_ITEM_ID)).toEqual([false, true]);
		transport.open();
		await Promise.all([sale, panelLoading]);
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
 * seed pass and the panel share, each request held until the test opens it. It answers 404 (a
 * `no_seed`), which is all these tests need: they count requests, not seeds.
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
		maxInFlight: () => maxInFlight,
		requestedItemIds: () => [...requested],
		/** Resolves when the next request starts. */
		started: () => new Promise<void>((resolve) => { waitingForACall.push(resolve); }),
		/** Releases every held request and lets the later ones answer at once. */
		open: () => { opened = true; for (const release of held.splice(0)) release(); },
	};
}
