import type { ItemLocation } from '../account/storage-snapshot-model';
import type { InventoryAdvisorCoverageV1, InventoryAdvisorReasonCode, InventoryRecommendationAction } from './inventory-advisor-model';

export const INVENTORY_ADVISOR_PRESENTATION_VERSION = 1 as const;

export type InventoryAdvisorPresentationStatus = 'empty' | 'ready' | 'limited' | 'blocked' | 'invalid';
export type InventoryAdvisorPresentationGroup = 'market' | 'curated' | 'keep' | 'review';
export type InventoryAdvisorPresentationSort = 'value_desc' | 'name_asc' | 'action_asc';
export type InventoryAdvisorPresentationAction = Exclude<InventoryRecommendationAction, 'discard_candidate'>;

export interface InventoryAdvisorPresentationFilters {
	query?: string;
	actions?: InventoryAdvisorPresentationAction[];
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

export interface InventoryAdvisorPresentationRow {
	id: string;
	itemId: number;
	name: string;
	ownedQuantity: number;
	availableQuantity: number;
	action: InventoryAdvisorPresentationAction;
	quantity: number;
	allocations: InventoryAdvisorPresentationAllocation[];
	reasonCodes: InventoryAdvisorReasonCode[];
	coverage: InventoryAdvisorCoverageV1;
	group: InventoryAdvisorPresentationGroup;
	value: InventoryAdvisorPresentationValue;
	/** Reserved seam for H4.16 review evidence; it cannot be populated in H5.11-A. */
	irreversibleReviewOnly: false;
}

export interface InventoryAdvisorPresentationSection {
	group: InventoryAdvisorPresentationGroup;
	rows: InventoryAdvisorPresentationRow[];
}

export interface InventoryAdvisorPresentation {
	version: typeof INVENTORY_ADVISOR_PRESENTATION_VERSION;
	status: InventoryAdvisorPresentationStatus;
	groups: InventoryAdvisorPresentationSection[];
	/** H4.16 may later add an explicit reviewed-discard capability to this seam. */
	discardReview: { status: 'unavailable' };
}
