import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import TyrianCompanionPlugin from './main';
import type { PositionRecommendationV1 } from './advisor/inventory-position-recommendation';
import { PriceSeedBulkRefreshService } from './economy/price-seed-bulk-refresh';
import type { IndexedDbPriceSeedCacheStore } from './economy/price-seed-cache-store';
import type { PriceSeedDayV1 } from './economy/price-seed-model';
import { datawars2RealHistorySacoDays } from './economy/__fixtures__/datawars2-real-history-36038-2026-09-26';
import { datawars2RealHistoryTrozoDays } from './economy/__fixtures__/datawars2-real-history-36041-2026-09-26';
import { datawars2RealHistoryBarraDays } from './economy/__fixtures__/datawars2-real-history-47909-2026-09-26';
import { datawars2RealHistoryJorcameloDays } from './economy/__fixtures__/datawars2-real-history-43320-2026-09-26';
import { datawars2RealHistoryColmillosAltaCalidadDays } from './economy/__fixtures__/datawars2-real-history-48805-2026-09-26';

const NOW_MS = Date.parse('2026-09-26T07:35:00.000Z');
const daysById = new Map<number, () => readonly PriceSeedDayV1[]>([
	[36038, datawars2RealHistorySacoDays], [36041, datawars2RealHistoryTrozoDays],
	[47909, datawars2RealHistoryBarraDays], [43320, datawars2RealHistoryJorcameloDays],
	[48805, datawars2RealHistoryColmillosAltaCalidadDays],
]);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Sale refresh: explicit action to real cache, merge and hero recommendation', () => {
	it('leaves auto-open read-only, respects opt-in, then seeds before the same advisor/hero refresh and reuses the cache', async () => {
		const factory = new IDBFactory();
		vi.stubGlobal('window', { indexedDB: factory });
		vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
		const fetched: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			factory, vaultId: 'sale-refresh-test', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				fetched.push(itemId);
				const days = daysById.get(itemId)?.();
				if (days === undefined) throw new Error('Missing real item history.');
				return { status: 'seeded', seed: { version: 1, itemId, source: 'datawars2', retrievedAt: new Date(NOW_MS).toISOString(), days: [...days] } };
			},
		});
		// The account boundary is recorded input. Everything from refreshSale through IndexedDB,
		// cache merging and recommendPosition runs production code; no pre-seeded test cache.
		const harness = {
			runtimeReady: true, vaultId: 'sale-refresh-test',
			settings: { priceHistoryEnabled: true, priceHistoryDailyRetentionDays: 400, recommendationCapitalThresholdCopper: 100_000 },
			priceSeedBulkRefresh: service, priceSeedQueueCoverage: null,
			priceSeedCacheReader: null as IndexedDbPriceSeedCacheStore | null,
			priceSeedCacheReaderOpening: null, saleHeroTimingFlight: null,
			saleHeroTiming: null as PositionRecommendationV1 | null,
			priceHistory: { readDaily: async () => [] },
			getInventoryAdvisorViewModel: () => ({ status: 'ready', groups: [{ rows: [{ itemId: 36038, ownedQuantity: 1 }] }] }),
			inventoryAdvisor: {
				refresh: async () => ({ status: 'ready' }),
				analysis: () => ({ source: { input: { prices: { items: [{ itemId: 36038, bid: { unitCopper: 374 } }] } } } }),
			},
			renderInventoryAdvisorViews: () => undefined,
		};
		Object.setPrototypeOf(harness, TyrianCompanionPlugin.prototype);
		try {
			await TyrianCompanionPlugin.prototype.refreshSale.call(harness as never, { refreshSeeds: false });
			expect(fetched).toEqual([]);
			expect(harness.saleHeroTiming).toMatchObject({ action: 'review', reason: 'insufficient_reference' });
			harness.settings.priceHistoryEnabled = false;
			await TyrianCompanionPlugin.prototype.refreshSale.call(harness as never);
			expect(fetched).toEqual([]);
			harness.settings.priceHistoryEnabled = true;
			await TyrianCompanionPlugin.prototype.refreshSale.call(harness as never);
			expect([...fetched].sort()).toEqual([...daysById.keys()].sort());
			expect(harness.saleHeroTiming?.action).not.toBe('review');
			expect(harness.saleHeroTiming?.sellOrWait?.seasons).toBe(7);
			await TyrianCompanionPlugin.prototype.refreshSale.call(harness as never);
			expect(fetched).toHaveLength(5);
		} finally {
			service.dispose();
			harness.priceSeedCacheReader?.close();
		}
	});
});
