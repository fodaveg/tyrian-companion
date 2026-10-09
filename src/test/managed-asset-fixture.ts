import { readFileSync } from 'node:fs';

import { sha256Text } from '../assets/managed-asset-hash';
import { managedAssetMarker, type PackagedAsset } from '../assets/managed-assets-model';

const SAMPLE_BASE_BODY = `filters:
  and:
    - file.hasTag("gw2/session")
    - tc_schema >= 1
    - tc_kind == "gw2_farming_session"
views:
  - type: table
    name: Sessions
    order:
      - tc_started_at
      - tc_duration_ms
      - tc_classification
`;

/**
 * A single-asset sample for the tests that exercise the generic managed-assets engine (H5.6). It is the
 * Base the plugin shipped as `Sessions.base` until the 0.6.16 bundle retired it; it is no longer in the
 * packaged bundle, which is why it lives with the tests.
 */
export async function genericManagedAssets(): Promise<PackagedAsset[]> {
	const draft = {
		id: 'sessions-base', kind: 'base', contentVersion: 2, locale: 'neutral',
		relativePath: 'Sessions.base',
	} as const;
	const bytes = `${managedAssetMarker(draft)}\n${SAMPLE_BASE_BODY}`;
	return [{ ...draft, bytes, contentHash: await sha256Text(bytes) }];
}

/** What 0.6.13 to 0.6.15 shipped besides the three Bases that stay: the three that this bundle retires. */
export async function legacyRetiredBases(): Promise<PackagedAsset[]> {
	const [sessions] = await genericManagedAssets();
	const body = sessions!.bytes.slice(sessions!.bytes.indexOf('\n') + 1);
	const make = async (id: string, locale: 'es' | 'neutral', relativePath: string): Promise<PackagedAsset> => {
		const draft = { id, kind: 'base', contentVersion: 1, locale, relativePath } as const;
		const bytes = `${managedAssetMarker(draft)}\n${body}`;
		return { ...draft, bytes, contentHash: await sha256Text(bytes) };
	};
	return [sessions!, await make('halloween-base', 'es', 'Halloween.base'), await make('materials-base', 'es', 'Materials.base')];
}

/**
 * The three Bases that bundle 8 retires, exactly as 0.6.15 published them (Sessions, and Halloween and
 * Materials in Spanish), dumped from that tag with `git archive` into `published-retired-bases.json`.
 * Their meaning hashes are the ones in `published-base-hashes.ts`; the synthetic ones above can not prove that.
 */
export async function publishedRetiredBases(): Promise<PackagedAsset[]> {
	return (await publishedRows()).filter((row) => row.id !== 'session-summaries-base');
}

/** `Session summaries.base` at `contentVersion` 1 (Spanish), as 0.6.15 published it: a published version that is NOT the current one. */
export async function publishedSummariesV1(): Promise<PackagedAsset> {
	return (await publishedRows()).find((row) => row.id === 'session-summaries-base')!;
}

async function publishedRows(): Promise<PackagedAsset[]> {
	const rows = JSON.parse(readFileSync(new URL('./published-retired-bases.json', import.meta.url), 'utf8')) as Array<Omit<PackagedAsset, 'contentHash'>>;
	return await Promise.all(rows.map(async (row) => ({ ...row, contentHash: await sha256Text(row.bytes) })));
}
