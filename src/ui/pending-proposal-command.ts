import type { ProposalQueueState } from '../sessions/pending-proposal-service';
import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';

export interface PendingProposalUiProjection {
	commandAvailable: boolean;
	pendingCount: number;
	ribbonLabel: string | null;
}

/** Pure projection shared by palette and ribbon; it never opens or focuses UI. */
export function projectPendingProposalUi(state: ProposalQueueState, locale: Locale = 'en'): PendingProposalUiProjection {
	const pendingCount = state.status === 'ready' ? state.pendingCount : 0;
	const t = createTranslator(locale);
	return {
		commandAvailable: pendingCount > 0,
		pendingCount,
		ribbonLabel: pendingCount > 0
			? translateRuntime(t, pendingCount === 1 ? 'commands.pendingConfirmation' : 'commands.pendingConfirmations', { count: pendingCount })
			: null,
	};
}
