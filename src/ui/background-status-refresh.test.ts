import { describe, expect, it, vi } from 'vitest';

import { refreshBackgroundStatus } from './background-status-refresh';

describe('refreshBackgroundStatus', () => {
	it('preserves the focused node identity while updating existing status ports', () => {
		const focusedNode = { id: 'focused-control', focused: true };
		const dynamicNode = { text: 'No pending confirmations' };
		const view = {
			refreshBackgroundStatus: vi.fn(() => { dynamicNode.text = '1 pending confirmation'; }),
		};
		refreshBackgroundStatus([view]);
		expect(view.refreshBackgroundStatus).toHaveBeenCalledOnce();
		expect(dynamicNode.text).toBe('1 pending confirmation');
		expect(focusedNode).toEqual({ id: 'focused-control', focused: true });
	});
});
