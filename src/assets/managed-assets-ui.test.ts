import { describe, expect, it, vi } from 'vitest';

import { projectManagedAssetsActions, runConfirmedManagedAssetsRemoval } from './managed-assets-ui';

describe('managed-assets settings actions', () => {
	it('disables every action while an operation is working', () => {
		expect(projectManagedAssetsActions({ working: true, hasManagedRoot: true, canMove: true })).toEqual({
			preview: false, apply: false, repair: false, move: false, remove: false,
		});
	});

	it('requires an explicit confirmation before remove', async () => {
		const remove = vi.fn(async () => undefined);
		await expect(runConfirmedManagedAssetsRemoval(async () => false, remove)).resolves.toBe(false);
		expect(remove).not.toHaveBeenCalled();
		await expect(runConfirmedManagedAssetsRemoval(async () => true, remove)).resolves.toBe(true);
		expect(remove).toHaveBeenCalledOnce();
	});
});
