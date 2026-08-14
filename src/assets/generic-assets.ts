import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';
import { halloweenManagedAssets } from './halloween-base';
import { sha256Text } from './managed-asset-hash';

export { sha256Text } from './managed-asset-hash';

const GENERIC_SESSION_BASE_BODY = `filters:
  and:
    - file.hasTag("gw2/session")
views:
  - type: table
    name: Sessions
    order:
      - tc_started_at
      - tc_duration_ms
      - tc_classification
`;

/** H5.6 exercises the generic asset engine; themed content is registered by H5.7. */
export async function genericManagedAssets(): Promise<PackagedAsset[]> {
	const draft = {
		id: 'sessions-base', kind: 'base', contentVersion: 1, locale: 'neutral',
		relativePath: 'Sessions.base',
	} as const;
	const bytes = `${managedAssetMarker(draft)}\n${GENERIC_SESSION_BASE_BODY}`;
	return [{ ...draft, bytes, contentHash: await sha256Text(bytes) }];
}

/** Complete H5.7 bundle; the manager selects neutral assets plus the active locale. */
export async function managedAssetsBundle(): Promise<PackagedAsset[]> {
	return [...await genericManagedAssets(), ...await halloweenManagedAssets()];
}
