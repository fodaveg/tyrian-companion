import type { InventoryAdvisorPresentation, InventoryAdvisorPresentationRow } from '../advisor/inventory-advisor-presentation-model';
import type { InventoryAdvisorWorkflowBlockedReason } from '../advisor/inventory-advisor-workflow';

export type InventoryAdvisorViewStatus = 'loading' | 'empty' | 'ready' | 'limited' | 'blocked' | 'invalid';

export interface InventoryAdvisorViewRow {
	id: string;
	itemId: number;
	name: string;
	icon: string | null;
	ownedQuantity: number;
	availableQuantity: number;
	action: InventoryAdvisorPresentationRow['action'];
	quantity: number;
	allocations: InventoryAdvisorPresentationRow['allocations'];
	reasonCodes: InventoryAdvisorPresentationRow['reasonCodes'];
	protectionReasons: InventoryAdvisorPresentationRow['protectionReasons'];
	value: InventoryAdvisorPresentationRow['value'];
	marketComparison: InventoryAdvisorPresentationRow['marketComparison'];
	burden: InventoryAdvisorPresentationRow['burden'];
	materialStorage?: InventoryAdvisorPresentationRow['materialStorage'];
	coverage: InventoryAdvisorPresentationRow['coverage'];
	irreversibleReviewOnly: boolean;
	discardProof: InventoryAdvisorPresentationRow['discardProof'];
	containerEconomy?: InventoryAdvisorPresentationRow['containerEconomy'];
}

export interface InventoryAdvisorViewModel {
	status: InventoryAdvisorViewStatus;
	title: string;
	detail: string;
	/** Safe, closed diagnostic enum. It never contains account-bound values. */
	blockedReason?: InventoryAdvisorWorkflowBlockedReason | 'unexpected_failure';
	/** A failed refresh did not replace the last valid in-memory result. */
	refreshWarning?: InventoryAdvisorWorkflowBlockedReason | 'unexpected_failure';
	/** Redacted availability of opt-in stores; null until a trusted capture exists. */
	optionalSources?: InventoryAdvisorPresentation['optionalSources'] | null;
	groups: InventoryAdvisorViewModelGroup[];
	/**
	 * Bumped only when the underlying content actually changes (a fresh capture, an
	 * invalidate, a block). A live sync-panel tick reuses the same number, so the
	 * view can skip rebuilding the results table for it. Absent outside the plugin's
	 * own controller (e.g. hand-built test fixtures), where every render rebuilds.
	 */
	contentVersion?: number;
}

export interface InventoryAdvisorViewModelGroup {
	key: InventoryAdvisorPresentation['groups'][number]['group'];
	rows: InventoryAdvisorViewRow[];
}

/** Converts the data-only advisor presentation into a UI-neutral render model. */
export function buildInventoryAdvisorViewModel(presentation: InventoryAdvisorPresentation | null): InventoryAdvisorViewModel {
	if (presentation === null) return { status: 'loading', title: 'Inventory advisor', detail: 'Loading review-only recommendations.', optionalSources: null, groups: [] };
	return {
		status: presentation.status,
		title: 'Inventory advisor',
		detail: detailFor(presentation.status),
		optionalSources: presentation.optionalSources === undefined ? null : structuredClone(presentation.optionalSources),
		groups: presentation.groups.map((group) => ({
			key: group.group,
			rows: group.rows.map((row) => ({
				id: row.id,
				itemId: row.itemId, name: row.name, icon: row.icon, ownedQuantity: row.ownedQuantity, availableQuantity: row.availableQuantity,
				action: row.action, quantity: row.quantity, allocations: structuredClone(row.allocations),
				reasonCodes: [...row.reasonCodes], protectionReasons: structuredClone(row.protectionReasons),
				value: { ...row.value }, marketComparison: row.marketComparison === null ? null : { ...row.marketComparison },
				burden: row.burden === null ? null : { ...row.burden }, coverage: { ...row.coverage },
				...(row.materialStorage === undefined ? {} : {
					materialStorage: row.materialStorage === null ? null : { ...row.materialStorage },
				}),
				irreversibleReviewOnly: row.irreversibleReviewOnly,
				discardProof: row.discardProof === null ? null : structuredClone(row.discardProof),
				containerEconomy: row.containerEconomy == null ? null : structuredClone(row.containerEconomy),
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
