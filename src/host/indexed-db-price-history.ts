import { IndexedDbPriceHistoryStore } from '../economy/price-history-store';
import { IndexedDbPriceSeedCacheStore, IndexedDbPriceSeedNoSeedStore } from '../economy/price-seed-cache-store';
import type { TyrianKvPort, TyrianPriceHistoryPort } from './tyrian-host-storage';

/**
 * `TyrianHost.priceHistory` over the three IndexedDB databases the plugin already owns
 * (`tyrian-companion-price-history`, `-price-seed-cache`, `-price-seed-no-seed-cache`), opened
 * against the host's `kv` factory exactly as `price-history-runtime.ts`,
 * `price-seed-panel-service.ts` and `price-seed-bulk-refresh.ts` open them. `ObsidianHost` uses
 * it as is; another host may reuse it or hand back its own stores with the same operations.
 */
export function indexedDbPriceHistoryPort(kv: TyrianKvPort): TyrianPriceHistoryPort {
	return {
		open: async (diagnostics) => await IndexedDbPriceHistoryStore.open(kv.indexedDB, undefined, undefined, diagnostics),
		openSeedCache: async () => await IndexedDbPriceSeedCacheStore.open(kv.indexedDB),
		openNoSeedCache: async () => await IndexedDbPriceSeedNoSeedStore.open(kv.indexedDB),
	};
}
