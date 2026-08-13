import type { ProposalQueueState } from '../sessions/pending-proposal-service';

export interface PendingProposalUiProjection {
	commandAvailable: boolean;
	pendingCount: number;
	ribbonLabel: string | null;
}

/** Pure projection shared by palette and ribbon; it never opens or focuses UI. */
export function projectPendingProposalUi(state: ProposalQueueState): PendingProposalUiProjection {
	const pendingCount = state.status === 'ready' ? state.pendingCount : 0;
	return {
		commandAvailable: pendingCount > 0,
		pendingCount,
		ribbonLabel: pendingCount > 0
			? `${String(pendingCount)} pending confirmation${pendingCount === 1 ? '' : 's'}`
			: null,
	};
}
