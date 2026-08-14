import { describe, expect, it } from 'vitest';

import { projectPendingProposalUi } from './pending-proposal-command';

describe('projectPendingProposalUi', () => {
	it('keeps review unavailable while loading or unavailable', () => {
		expect(projectPendingProposalUi({ status: 'loading', pendingCount: 0, next: null })).toEqual({ commandAvailable: false, pendingCount: 0, ribbonLabel: null });
		expect(projectPendingProposalUi({ status: 'unavailable', pendingCount: 0, next: null, message: 'closed' })).toEqual({ commandAvailable: false, pendingCount: 0, ribbonLabel: null });
	});

	it('projects one palette action and a compact ribbon count', () => {
		expect(projectPendingProposalUi({ status: 'ready', pendingCount: 2, next: null })).toEqual({
			commandAvailable: true,
			pendingCount: 2,
			ribbonLabel: '2 pending confirmations',
		});
	});

	it('localizes the compact label without changing availability', () => {
		expect(projectPendingProposalUi({ status: 'ready', pendingCount: 2, next: null }, 'es')).toEqual({
			commandAvailable: true, pendingCount: 2, ribbonLabel: '2 confirmaciones pendientes',
		});
	});
});
