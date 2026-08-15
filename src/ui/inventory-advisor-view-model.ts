import type { InventoryAdvisorPresentation, InventoryAdvisorPresentationRow } from '../advisor/inventory-advisor-presentation-model';
import type { InventoryAdvisorWorkflowBlockedReason } from '../advisor/inventory-advisor-workflow';

export type InventoryAdvisorViewStatus = 'loading' | 'empty' | 'ready' | 'limited' | 'blocked' | 'invalid';

export interface InventoryAdvisorViewRow {
	id: string;
	itemId: number;
	name: string;
	ownedQuantity: number;
	availableQuantity: number;
	action: InventoryAdvisorPresentationRow['action'];
	quantity: number;
	allocations: InventoryAdvisorPresentationRow['allocations'];
	reasonCodes: InventoryAdvisorPresentationRow['reasonCodes'];
	value: InventoryAdvisorPresentationRow['value'];
	coverage: InventoryAdvisorPresentationRow['coverage'];
	irreversibleReviewOnly: boolean;
	discardProof: InventoryAdvisorPresentationRow['discardProof'];
}

export interface InventoryAdvisorViewModel {
	status: InventoryAdvisorViewStatus;
	title: string;
	detail: string;
	/** Safe, closed diagnostic enum. It never contains account-bound values. */
	blockedReason?: InventoryAdvisorWorkflowBlockedReason | 'unexpected_failure';
	groups: InventoryAdvisorViewModelGroup[];
}

export interface InventoryAdvisorViewModelGroup {
	key: InventoryAdvisorPresentation['groups'][number]['group'];
	rows: InventoryAdvisorViewRow[];
}

/** Converts the data-only advisor presentation into a UI-neutral render model. */
export function buildInventoryAdvisorViewModel(presentation: InventoryAdvisorPresentation | null): InventoryAdvisorViewModel {
	if (presentation === null) return { status: 'loading', title: 'Inventory advisor', detail: 'Loading review-only recommendations.', groups: [] };
	return {
		status: presentation.status,
		title: 'Inventory advisor',
		detail: detailFor(presentation.status),
		groups: presentation.groups.map((group) => ({
			key: group.group,
			rows: group.rows.map((row) => ({
				id: row.id,
				itemId: row.itemId, name: row.name, ownedQuantity: row.ownedQuantity, availableQuantity: row.availableQuantity,
				action: row.action, quantity: row.quantity, allocations: structuredClone(row.allocations),
				reasonCodes: [...row.reasonCodes], value: { ...row.value }, coverage: { ...row.coverage },
				irreversibleReviewOnly: row.irreversibleReviewOnly,
				discardProof: row.discardProof === null ? null : structuredClone(row.discardProof),
			})),
		})),
	};
}

function detailFor(status: Exclude<InventoryAdvisorViewStatus, 'loading'>): string {
	const details: Record<Exclude<InventoryAdvisorViewStatus, 'loading'>, string> = {
		empty: 'No recommendations match these filters.',
		ready: 'Review each recommendation manually in game.',
		limited: 'Some evidence is limited; review manually in game.',
		blocked: 'Recommendations are blocked until evidence is complete.',
		invalid: 'Advisor evidence could not be validated.',
	};
	return details[status];
}
