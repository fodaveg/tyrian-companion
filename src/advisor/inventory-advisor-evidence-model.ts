import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogLocale, CatalogResolution } from '../catalog/public-catalog-model';
import type { AccountSignalsV1, InventoryPriceSnapshotV1 } from './inventory-advisor-model';
import type { InventoryContainerPriceEvidenceV1 } from './inventory-container-economy';

export const INVENTORY_ADVISOR_EVIDENCE_VERSION = 1 as const;

export type InventoryAdvisorEvidenceStatus = 'complete' | 'partial' | 'unavailable' | 'invalid';

/** TTLs are explicit evidence facts; H4.13 policy decides whether they are fresh enough. */
export interface InventoryAdvisorEvidenceTtlV1 {
	snapshotMs: number;
	catalogMs: number;
	pricesMs: number;
	accountSignalsMs: number;
}

export interface InventoryAdvisorEvidenceCoverageV1 {
	snapshot: 'complete' | 'partial' | 'unavailable';
	catalog: 'complete' | 'partial' | 'unavailable';
	prices: 'complete' | 'partial' | 'unavailable';
	accountSignals: 'complete' | 'partial' | 'unavailable';
}

/** Account-wide, capture-time evidence that can be placed into InventoryAdvisorInputV1 unchanged. */
export interface InventoryAdvisorEvidenceV1 {
	version: typeof INVENTORY_ADVISOR_EVIDENCE_VERSION;
	scope: 'supported_storage_v1';
	accountId: string;
	snapshotId: string;
	schemaVersion: string;
	capturedAt: string;
	finishedAt: string;
	locale: CatalogLocale;
	snapshot: StorageSnapshot;
	snapshotFingerprint: string;
	ttl: InventoryAdvisorEvidenceTtlV1;
	coverage: InventoryAdvisorEvidenceCoverageV1;
	catalog: CatalogResolution;
	prices: InventoryPriceSnapshotV1;
	accountSignals: AccountSignalsV1;
}

export type InventoryAdvisorEvidenceCaptureResultV1 =
	| { status: 'complete' | 'partial'; evidence: InventoryAdvisorEvidenceV1;
		containerPrices?: InventoryContainerPriceEvidenceV1 | null }
	| { status: 'unavailable' | 'invalid'; evidence: null; containerPrices?: null };

export interface InventoryAdvisorEvidenceCapture {
	capture(locale: CatalogLocale, containerPriceItemIds?: readonly number[]): Promise<InventoryAdvisorEvidenceCaptureResultV1>;
}
