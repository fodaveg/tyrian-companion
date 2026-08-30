import type { SourceCoverage, StorageSnapshot } from '../account/storage-snapshot-model';
import type { StorageSnapshotCaptureProgress } from '../account/storage-snapshot-service';
import type { CatalogLocale, CatalogResolution } from '../catalog/public-catalog-model';
import type { AccountSignalsV1, InventoryPriceSnapshotV1 } from './inventory-advisor-model';
import type { InventoryContainerPriceEvidenceV1 } from './inventory-container-economy';
import type { ActiveTradingPostOrdersEvidenceV1 } from '../account/trading-post-orders-model';
import type { InventoryMarketDepthEvidenceV1 } from '../economy/commerce-listings';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';

export const INVENTORY_ADVISOR_EVIDENCE_VERSION = 1 as const;

export type InventoryAdvisorEvidenceValidationFailure =
	| 'wrapper_shape'
	| 'snapshot_invalid'
	| 'catalog_invalid'
	| 'prices_invalid'
	| 'account_signals_invalid'
	| 'cross_reference_invalid'
	| 'snapshot_fingerprint_invalid'
	| 'timestamps_invalid'
	| 'coverage_invalid'
	| 'serialization_invalid';

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

export type InventoryAdvisorEvidenceFailure =
	| 'missing_key'
	| 'identity_mismatch'
	| 'snapshot_coverage_incomplete'
	| 'snapshot_structure_invalid'
	| 'rate_limited'
	| InventoryAdvisorEvidenceValidationFailure;

/**
 * One bounded, local-only refresh receipt. It deliberately excludes credentials,
 * account and character identifiers, inventory contents, URLs and response bodies.
 */
export interface InventoryAdvisorCaptureReceiptV1 {
	version: 1;
	recordedAt: string;
	status: InventoryAdvisorEvidenceStatus;
	failure: InventoryAdvisorEvidenceFailure | null;
	evidenceCoverage: InventoryAdvisorEvidenceCoverageV1 | null;
	evidenceDetails: {
		catalog: { requested: number; resolved: number; stale: number; unavailable: number };
		prices: { requested: number; captured: number; missing: number };
	} | null;
	containerPrices: 'complete' | 'partial' | 'unavailable' | 'not_requested';
	activeOrders?: {
		status: ActiveTradingPostOrdersEvidenceV1['status'];
		buys: ActiveTradingPostOrdersEvidenceV1['endpointCoverage']['buy']['status'];
		sells: ActiveTradingPostOrdersEvidenceV1['endpointCoverage']['sell']['status'];
	} | null;
	workflow: {
		status: 'progress';
		stage: 'preferences' | 'classification';
		elapsedMs: number;
	} | {
		status: 'failed';
		stage: 'capture' | 'preferences' | 'classification';
		reason: 'input_invalid' | 'unexpected_failure';
		elapsedMs: number;
	} | {
		status: 'blocked';
		reason: string;
	} | {
		status: 'ready';
		resultStatus: 'ready' | 'limited' | 'blocked' | 'invalid';
		lineCount: number;
		decisionCount: number;
		defaultVisibleDecisionCount: number;
		actionCounts: Array<{ action: string; count: number }>;
		reasonCounts: Array<{ reason: string; count: number }>;
	} | null;
	snapshot: {
		quality: StorageSnapshot['quality'];
		passes: StorageSnapshot['passes'];
		durationMs: number;
		roster: SourceCoverage;
		sharedInventory: SourceCoverage;
		bank: SourceCoverage;
		materials: SourceCoverage;
		commerceDelivery: SourceCoverage;
		characterInventories: SourceCoverage[];
		attempts: Array<{
			roster: SourceCoverage;
			sharedInventory: SourceCoverage;
			bank: SourceCoverage;
			materials: SourceCoverage;
			commerceDelivery: SourceCoverage;
			characterInventories: SourceCoverage[];
		}>;
	} | null;
}

export type InventoryAdvisorCaptureReceiptSink = (
	receipt: InventoryAdvisorCaptureReceiptV1,
) => void | Promise<void>;

export type InventoryAdvisorEvidenceCaptureResultV1 =
	| { status: 'complete' | 'partial'; evidence: InventoryAdvisorEvidenceV1;
		containerPrices?: InventoryContainerPriceEvidenceV1 | null;
		activeOrders?: ActiveTradingPostOrdersEvidenceV1;
		marketDepth?: InventoryMarketDepthEvidenceV1 }
	| { status: 'unavailable' | 'invalid'; evidence: null; containerPrices?: null;
		activeOrders?: undefined; failure?: InventoryAdvisorEvidenceFailure };

/** Adds the catalog/prices leg (always 4 concurrent requests) to the storage capture's own counters. */
export interface InventoryAdvisorCaptureProgress extends StorageSnapshotCaptureProgress {
	readonly catalogAndPrices: { readonly completed: number; readonly total: number };
}

export interface InventoryAdvisorEvidenceCapture {
	capture(
		locale: CatalogLocale,
		containerPriceItemIds?: readonly number[],
		onProgress?: (progress: InventoryAdvisorCaptureProgress) => void,
		actionContext?: ResolvedLocalDebugActionContext,
	): Promise<InventoryAdvisorEvidenceCaptureResultV1>;
}
