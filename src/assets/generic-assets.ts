import { managedAssetMarker, type PackagedAsset } from './managed-assets-model';

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

export async function sha256Text(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value.replace(/\r\n?/gu, '\n'));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}
