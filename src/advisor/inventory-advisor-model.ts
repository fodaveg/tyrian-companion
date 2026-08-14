import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import type { ReservationGoal } from '../economy/reservation-model';
import type { InventoryRecommendationEnvelopeV1 } from '../economy/inventory-recommendation-envelope';

export const INVENTORY_ADVISOR_VERSION = 1 as const;
export const INVENTORY_ADVISOR_SCOPE = 'supported_storage_v1' as const;
export const INVENTORY_PRICE_SNAPSHOT_VERSION = 1 as const;
export const INVENTORY_RULE_PACK_VERSION = 1 as const;
export const INVENTORY_ADVISOR_POLICY_VERSION = 1 as const;

export type InventoryRecommendationAction =
	| 'sell'
	| 'list'
	| 'vendor'
	| 'salvage'
	| 'use'
	| 'open'
	| 'keep'
	| 'review'
	| 'discard_candidate';

export type InventoryAdvisorReasonCode =
	| 'snapshot_invalid'
	| 'snapshot_scope_limited'
	| 'identity_mismatch'
	| 'catalog_missing'
	| 'catalog_invalid'
	| 'catalog_stale'
	| 'price_missing'
	| 'price_stale'
	| 'price_partial'
	| 'binding_unknown'
	| 'tp_access_unknown'
	| 'position_not_actionable'
	| 'reserved_for_goal'
	| 'user_keep_exception'
	| 'rule_missing'
	| 'rule_stale'
	| 'rule_conflict'
	| 'unlock_coverage_unknown'
	| 'collection_coverage_unknown'
	| 'already_unlocked'
	| 'no_sell'
	| 'no_salvage'
	| 'salvage_value_unknown'
	| 'delete_warning'
	| 'alternative_route_exists'
	| 'discard_not_allowlisted'
	| 'arithmetic_overflow';

export interface InventoryPriceSideV1 {
	unitCopper: number;
	quantity: number;
}

export interface InventoryItemPriceV1 {
	itemId: number;
	whitelisted: boolean;
	bid: InventoryPriceSideV1 | null;
	ask: InventoryPriceSideV1 | null;
}

export interface InventoryPriceSnapshotV1 {
	version: typeof INVENTORY_PRICE_SNAPSHOT_VERSION;
	accountId: string;
	snapshotId: string;
	capturedAt: string;
	source: 'gw2-commerce-prices';
	schemaVersion: string;
	requestedItemIds: number[];
	status: 'complete' | 'partial' | 'unavailable';
	items: InventoryItemPriceV1[];
	missingItemIds: number[];
}

export interface KeepExceptionQuantityAll {
	mode: 'all';
}

export interface KeepExceptionQuantityMinimum {
	mode: 'minimum';
	value: number;
}

export interface KeepExceptionV1 {
	version: typeof INVENTORY_ADVISOR_VERSION;
	exceptionId: string;
	itemId: number;
	status: 'active' | 'paused';
	basis: 'owned' | 'available';
	quantity: KeepExceptionQuantityAll | KeepExceptionQuantityMinimum;
	reason: 'user_keep' | 'build' | 'gift' | 'collection' | 'custom';
}

export interface AccountSignalsV1 {
	version: typeof INVENTORY_ADVISOR_VERSION;
	accountId: string;
	capturedAt: string;
	tradingPostAccess: 'full' | 'free_to_play' | 'unknown';
	unlockCoverage: 'complete' | 'partial' | 'unavailable';
	unlockedRecipes: number[] | null;
	unlockedSkins: number[] | null;
	unlockedMinis: number[] | null;
	achievementCoverage: 'complete' | 'partial' | 'unavailable';
	completedAchievementBits: Record<string, number[]> | null;
}

export interface InventoryRuleSourceV1 {
	id: string;
	url: string;
	retrievedAt: string;
}

export interface InventoryAdvisorRuleV1 {
	ruleId: string;
	itemId: number;
	action: 'salvage' | 'use' | 'open' | 'discard_candidate';
	status: 'approved' | 'revoked';
	reason: 'curated_salvage' | 'curated_use' | 'curated_open' | 'curated_discard_review';
}

export interface InventoryAdvisorRulePackV1 {
	schemaVersion: typeof INVENTORY_RULE_PACK_VERSION;
	id: string;
	version: number;
	publishedAt: string;
	reviewedAt: string;
	validUntil: string;
	sha256: string;
	sources: InventoryRuleSourceV1[];
	rules: InventoryAdvisorRuleV1[];
}

export interface InventoryAdvisorPolicyV1 {
	version: typeof INVENTORY_ADVISOR_POLICY_VERSION;
	maxPriceAgeMs: number;
	maxCatalogAgeMs: number;
	maxAccountSignalsAgeMs: number;
	maxRulePackAgeMs: number;
	maxFutureSkewMs: number;
	listingMinimumAdvantageBps: number;
}

export interface InventoryAdvisorInputV1 {
	version: typeof INVENTORY_ADVISOR_VERSION;
	asOf: string;
	snapshot: StorageSnapshot;
	catalog: CatalogResolution;
	prices: InventoryPriceSnapshotV1;
	goals: ReservationGoal[];
	keepExceptions: KeepExceptionV1[];
	accountSignals: AccountSignalsV1;
	rulePack: InventoryAdvisorRulePackV1;
	policy: InventoryAdvisorPolicyV1;
}

export interface InventoryAdvisorReasonV1 {
	code: InventoryAdvisorReasonCode;
	itemId: number | null;
	goalId: string | null;
	ruleId: string | null;
}

export interface InventoryAdvisorPositionV1 {
	ref: string;
	holdingIndex: number;
	itemId: number;
	quantity: number;
	source: 'character' | 'shared_inventory' | 'bank' | 'materials' | 'commerce_delivery';
	state: 'loose' | 'equipped_container' | 'embedded_upgrade' | 'embedded_infusion' | 'pending_claim';
}

export interface InventoryAdvisorCoverageV1 {
	inventory: 'complete' | 'limited' | 'unknown';
	catalog: 'complete' | 'limited' | 'unknown';
	prices: 'complete' | 'limited' | 'unknown';
	reservations: 'complete' | 'limited' | 'unknown';
	accountSignals: 'complete' | 'limited' | 'unknown';
	rules: 'complete' | 'limited' | 'unknown';
}

export interface InventoryDecisionAllocationV1 {
	positionRef: string;
	quantity: number;
}

export interface InventoryDiscardProofV1 {
	rulePackSha256: string;
	catalogSource: 'network' | 'cache_fresh';
	tradingPost: 'unavailable';
	vendor: 'unavailable';
	salvage: 'no_salvage';
	use: 'not_applicable';
	open: 'not_applicable';
	unlocks: 'complete';
	collections: 'complete';
	deleteWarning: false;
}

export interface InventoryRecommendationDecisionV1 {
	action: InventoryRecommendationAction;
	itemId: number;
	quantity: number;
	allocations: InventoryDecisionAllocationV1[];
	explanationRef: string;
	ruleId: string | null;
	safety: 'manual_only' | 'irreversible_review_only';
	discardProof: InventoryDiscardProofV1 | null;
}

export interface InventoryAdvisorLineV1 {
	itemId: number;
	name: string;
	ownedQuantity: number;
	availableQuantity: number;
	positions: InventoryAdvisorPositionV1[];
	coverage: InventoryAdvisorCoverageV1;
	reservedQuantity: number;
	exceptionQuantity: number;
	actionedQuantity: number;
	unclassifiedQuantity: number;
	decisions: InventoryRecommendationDecisionV1[];
	reasons: InventoryAdvisorReasonV1[];
}

export interface InventoryAdvisorExplanationV1 {
	ref: string;
	itemId: number;
	action: InventoryRecommendationAction;
	reasonCodes: InventoryAdvisorReasonCode[];
	evidenceRefs: string[];
	ruleId: string | null;
}

export interface InventoryAdvisorReportV1 {
	version: typeof INVENTORY_ADVISOR_VERSION;
	scope: typeof INVENTORY_ADVISOR_SCOPE;
	accountId: string;
	snapshotId: string;
	asOf: string;
	coverage: 'complete' | 'limited' | 'blocked';
	lines: InventoryAdvisorLineV1[];
	reasons: InventoryAdvisorReasonV1[];
	explanations: InventoryAdvisorExplanationV1[];
	rulePack: InventoryAdvisorRulePackV1;
}

export type InventoryAdvisorResultV1 =
	| {
		status: 'ready' | 'limited' | 'blocked';
		report: InventoryAdvisorReportV1;
		envelope: InventoryRecommendationEnvelopeV1;
	}
	| {
		status: 'invalid';
		reasons: InventoryAdvisorReasonV1[];
		report: null;
		envelope: null;
	};
