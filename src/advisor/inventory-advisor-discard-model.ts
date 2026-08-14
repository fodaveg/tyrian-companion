import type { InventoryAdvisorEngineInputV1 } from './inventory-advisor-classifier-model';
import type { InventoryAdvisorReportV1, InventoryAdvisorResultV1 } from './inventory-advisor-model';
import type { InventoryRecommendationEnvelopeV1 } from '../economy/inventory-recommendation-envelope';

export const INVENTORY_DISCARD_ALLOWLIST_VERSION = 1 as const;

/** H4.16 consumes a verified H4.15 producer result without changing its input evidence. */
export interface InventoryDiscardAllowlistInputV1 {
	engineInput: InventoryAdvisorEngineInputV1;
	producerResult: InventoryAdvisorResultV1;
}

/** Evidence retained alongside a review-only discard candidate. */
export interface InventoryDiscardAllowlistProofV1 {
	itemId: number;
	explanationRef: string;
	producerResultSha256: string;
	discardRuleId: string;
	discardRuleSourceIds: string[];
	assertionIds: { use: string; open: string; salvage: string };
	assertionSourceIds: { use: string[]; open: string[]; salvage: string[] };
}

export type InventoryDiscardAllowlistResultV1 =
	| {
		version: typeof INVENTORY_DISCARD_ALLOWLIST_VERSION;
		status: 'ready' | 'limited' | 'blocked';
		producerResultSha256: string;
		report: InventoryAdvisorReportV1;
		envelope: InventoryRecommendationEnvelopeV1;
		proofs: InventoryDiscardAllowlistProofV1[];
	}
	| {
		version: typeof INVENTORY_DISCARD_ALLOWLIST_VERSION;
		status: 'invalid';
		producerResultSha256: null;
		report: null;
		envelope: null;
		proofs: [];
	};
