import type { ItemLocation, SourceCoverage } from '../account/storage-snapshot-model';
import type { InventoryAdvisorCoverageV1, InventoryAdvisorReasonCode, InventoryRecommendationAction } from './inventory-advisor-model';
import type { InventoryDiscardAllowlistProofV1 } from './inventory-advisor-discard-model';
import type {
	InventoryContainerEconomyDecisionV1,
	InventoryContainerPersonalEconomyV1,
} from './inventory-container-economy';
import type { ContainerDispositionKernelExplanation } from '../economy/container-disposition-kernel';

export const INVENTORY_ADVISOR_PRESENTATION_VERSION = 1 as const;

export type InventoryAdvisorPresentationStatus = 'empty' | 'ready' | 'limited' | 'blocked' | 'invalid';
export type InventoryAdvisorPresentationGroup = 'market' | 'curated' | 'keep' | 'review';
export type InventoryAdvisorPresentationSort = 'value_desc' | 'name_asc' | 'action_asc';
export type InventoryAdvisorPresentationAction = Exclude<InventoryRecommendationAction, 'discard_candidate'> | 'discard_review';
export type InventoryAdvisorPresentationFilterAction = Exclude<InventoryAdvisorPresentationAction, 'discard_review'>;

export interface InventoryAdvisorPresentationFilters {
	query?: string;
	actions?: InventoryAdvisorPresentationFilterAction[];
	groups?: InventoryAdvisorPresentationGroup[];
}

export interface InventoryAdvisorPresentationOptions {
	filters?: InventoryAdvisorPresentationFilters;
	sort?: InventoryAdvisorPresentationSort;
}

export type InventoryAdvisorPresentationValue =
	| { status: 'available'; copper: number; route: 'instant_sell' | 'listing' | 'vendor' }
	| { status: 'not_applicable'; route: null }
	| { status: 'unavailable'; route: null };

export interface InventoryAdvisorPresentationAllocation {
	positionRef: string;
	quantity: number;
	location: ItemLocation;
}

export type InventoryAdvisorProtectionReason =
	| {
		kind: 'reservation_goal';
		id: string;
		title: string;
		quantity: number;
		reason: 'achievement' | 'purchase' | 'personal';
		basis: 'owned' | 'available';
		intendedUse: 'hold' | 'open' | 'consume' | 'exchange' | 'spend';
	}
	| {
		kind: 'keep_exception';
		id: string;
		quantity: number;
		reason: 'user_keep' | 'build' | 'gift' | 'collection' | 'custom';
		basis: 'owned' | 'available';
	};

export interface InventoryAdvisorMarketComparison {
	instantSellCopper: number | null;
	listingCopper: number | null;
	differenceCopper: number | null;
	differenceBasisPoints: number | null;
}

export interface InventoryAdvisorBurden {
	kind: 'retained' | 'unclassified';
	quantity: number;
	occupiedSlots: number;
}

export interface InventoryAdvisorPresentationRow {
	id: string;
	itemId: number;
	name: string;
	icon: string | null;
	ownedQuantity: number;
	availableQuantity: number;
	action: InventoryAdvisorPresentationAction;
	quantity: number;
	allocations: InventoryAdvisorPresentationAllocation[];
	reasonCodes: InventoryAdvisorReasonCode[];
	protectionReasons: InventoryAdvisorProtectionReason[];
	coverage: InventoryAdvisorCoverageV1;
	group: InventoryAdvisorPresentationGroup;
	value: InventoryAdvisorPresentationValue;
	marketComparison: InventoryAdvisorMarketComparison | null;
	burden: InventoryAdvisorBurden | null;
	irreversibleReviewOnly: boolean;
	discardProof: InventoryDiscardAllowlistProofV1 | null;
	containerEconomy?: {
		recommendation: InventoryContainerEconomyDecisionV1;
		recommendationBasis: 'liquid_only' | 'personal';
		liquidOnly: {
			decision: InventoryContainerEconomyDecisionV1;
			explanation: ContainerDispositionKernelExplanation;
		};
		personal: InventoryContainerPersonalEconomyV1;
	} | null;
}

export interface InventoryAdvisorPresentationSection {
	group: InventoryAdvisorPresentationGroup;
	rows: InventoryAdvisorPresentationRow[];
}

export interface InventoryAdvisorPresentation {
	version: typeof INVENTORY_ADVISOR_PRESENTATION_VERSION;
	status: InventoryAdvisorPresentationStatus;
	groups: InventoryAdvisorPresentationSection[];
	/** Redacted capture coverage for optional stores; omitted only by legacy/test fixtures. */
	optionalSources?: {
		bank: SourceCoverage;
		materials: SourceCoverage;
		delivery: SourceCoverage;
	};
	discardReview:
		| { status: 'unavailable' }
		| { status: 'review_only'; proofs: InventoryDiscardAllowlistProofV1[] };
}
