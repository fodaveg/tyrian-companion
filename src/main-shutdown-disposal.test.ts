import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import TyrianCompanionPlugin from './main';

/**
 * H14.14: `shutdownRuntime` used to leave three catalog-cache-backed instances open (the session
 * catalog, the inventory-vault-sync capture's own catalog, and the inventory advisor's, reached
 * through `InventoryAdvisorPresentationController.dispose()`'s new `ports.dispose` call) and never
 * closed `ProductActionController`'s cooldown timer. This exercises the real private
 * `shutdownRuntime`, not a copy of it.
 */
describe('H14.14 shutdownRuntime disposal', () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it('disposes the session catalog, the inventory-vault capture catalog, and the product actions, and awaits the in-game server close', async () => {
		const sessionCatalogDispose = vi.fn();
		const inventoryVaultCaptureCatalogDispose = vi.fn();
		const productActionsDispose = vi.fn();
		let closeResolved = false;
		const alertIngameServerClose = vi.fn(() => new Promise<void>((resolve) => {
			setTimeout(() => { closeResolved = true; resolve(); }, 0);
		}));
		const harness = Object.assign(Object.create(TyrianCompanionPlugin.prototype) as object, {
			sessionCatalog: { dispose: sessionCatalogDispose },
			inventoryVaultCaptureCatalog: { dispose: inventoryVaultCaptureCatalogDispose },
			productActions: { dispose: productActionsDispose },
			alertIngameServer: { close: alertIngameServerClose },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const shutdownRuntime = (TyrianCompanionPlugin.prototype as unknown as {
			shutdownRuntime(this: typeof harness): Promise<void>;
		}).shutdownRuntime;

		const result = shutdownRuntime.call(harness);
		// The close has to actually be awaited, not fired-and-forgotten: proves it by observing
		// the flag it flips is only set once `shutdownRuntime`'s own promise has resolved.
		await result;

		expect(sessionCatalogDispose).toHaveBeenCalledOnce();
		expect(inventoryVaultCaptureCatalogDispose).toHaveBeenCalledOnce();
		expect(productActionsDispose).toHaveBeenCalledOnce();
		expect(alertIngameServerClose).toHaveBeenCalledOnce();
		expect(closeResolved).toBe(true);
		expect((harness as { sessionCatalog: unknown }).sessionCatalog).toBeNull();
		expect((harness as { inventoryVaultCaptureCatalog: unknown }).inventoryVaultCaptureCatalog).toBeNull();
		expect((harness as { alertIngameServer: unknown }).alertIngameServer).toBeNull();
	});
});
