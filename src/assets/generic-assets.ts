import type { PackagedAsset } from './managed-assets-model';
import { inventoryManagedAssets } from './inventory-bases';
import { sessionSummariesManagedAssets } from './session-summaries-base';
import { walletManagedAssets } from './wallet-base';

export { sha256Text } from './managed-asset-hash';

/** Complete H5.7 bundle; the manager selects neutral assets plus the active locale. */
export async function managedAssetsBundle(): Promise<PackagedAsset[]> {
	return [
		...await inventoryManagedAssets(),
		...await walletManagedAssets(),
		...await sessionSummariesManagedAssets(),
	];
}
