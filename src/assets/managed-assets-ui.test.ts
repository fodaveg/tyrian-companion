import { describe, expect, it, vi } from 'vitest';

import {
	projectManagedAssetsActions,
	projectManagedAssetsRootDivergence,
	runConfirmedManagedAssetsRemoval,
} from './managed-assets-ui';

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

describe('managed-assets root divergence', () => {
	it('reports the divergence when the managed root left the output folder behind', () => {
		expect(projectManagedAssetsRootDivergence({
			managedAssetsRoot: 'Tyrian Companion', outputFolder: '02 - Áreas/Guild Wars 2/Tyrian Companion',
			legacyManagedAssetsRoot: null,
		})).toEqual({ managedAssetsRoot: 'Tyrian Companion', outputFolder: '02 - Áreas/Guild Wars 2/Tyrian Companion' });
	});

	it('reports no divergence once both roots match', () => {
		expect(projectManagedAssetsRootDivergence({
			managedAssetsRoot: 'Tyrian Companion', outputFolder: 'Tyrian Companion', legacyManagedAssetsRoot: null,
		})).toBeNull();
	});

	it('reports no divergence while unowned', () => {
		expect(projectManagedAssetsRootDivergence({
			managedAssetsRoot: null, outputFolder: 'Tyrian Companion', legacyManagedAssetsRoot: null,
		})).toBeNull();
	});

	it('defers to the legacy-root messaging instead of reporting a divergence', () => {
		expect(projectManagedAssetsRootDivergence({
			managedAssetsRoot: 'Tyrian Companion', outputFolder: 'Other Folder', legacyManagedAssetsRoot: 'Legacy Root',
		})).toBeNull();
	});
});
