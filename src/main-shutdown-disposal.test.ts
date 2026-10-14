import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import type { LiveSessionRuntime } from './runtime/live-session-runtime';
import { AlertRuntime, type AlertRuntimePort } from './runtime/alert-runtime';
import { TyrianCompanionCore } from './runtime/tyrian-companion-core';

/**
 * H14.14: `shutdownRuntime` used to leave three catalog-cache-backed instances open (the session
 * catalog, the inventory-vault-sync capture's own catalog, and the inventory advisor's, reached
 * through `InventoryAdvisorPresentationController.dispose()`'s new `ports.dispose` call) and never
 * closed `ProductActionController`'s cooldown timer. This exercises the real private
 * `shutdownRuntime`, not a copy of it.
 *
 * H18.16: the inventory notes no longer capture anything of their own (they are written from the
 * advisor's analysis), so their private catalog is gone; the advisor's is still closed through
 * its controller's `dispose`.
 */
describe('H14.14 shutdownRuntime disposal', () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it('disposes the session catalog and the product actions, and awaits the in-game server close', async () => {
		const sessionCatalogDispose = vi.fn();
		const productActionsDispose = vi.fn();
		let closeResolved = false;
		const alertIngameServerClose = vi.fn(() => new Promise<void>((resolve) => {
			setTimeout(() => { closeResolved = true; resolve(); }, 0);
		}));
		// The in-game server lives in `AlertRuntime` now (DE-01, step 3g): a real one holding the fake handle.
		const alerts = Object.assign(new AlertRuntime({} as AlertRuntimePort), { alertIngameServer: { close: alertIngameServerClose } });
		const disposedReceipts = vi.spyOn(alerts, 'disposeIngameReceipts');
		const disposedPresence = vi.spyOn(alerts, 'disposeIngamePresence');
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			sessionCatalog: { dispose: sessionCatalogDispose },
			productActions: { dispose: productActionsDispose },
			alerts,
			// No assisted proposal is live: the live session runtime closes none (DE-01, step 3d).
			live: { excludeLiveAssistedProposal: () => null } satisfies Pick<LiveSessionRuntime, 'excludeLiveAssistedProposal'>,
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const shutdownRuntime = (TyrianCompanionCore.prototype as unknown as {
			shutdownRuntime(this: typeof harness): Promise<void>;
		}).shutdownRuntime;

		const result = shutdownRuntime.call(harness);
		// The close has to actually be awaited, not fired-and-forgotten: proves it by observing
		// the flag it flips is only set once `shutdownRuntime`'s own promise has resolved.
		await result;

		expect(sessionCatalogDispose).toHaveBeenCalledOnce();
		expect(productActionsDispose).toHaveBeenCalledOnce();
		expect(alertIngameServerClose).toHaveBeenCalledOnce();
		expect(disposedReceipts).toHaveBeenCalledOnce();
		expect(disposedPresence).toHaveBeenCalledOnce();
		expect(closeResolved).toBe(true);
		expect((harness as { sessionCatalog: unknown }).sessionCatalog).toBeNull();
		expect((alerts as unknown as { alertIngameServer: unknown }).alertIngameServer).toBeNull();
	});

	/** Z6-5: a drain that rejects must not skip the disposals that do not depend on the bridge. */
	it('still releases what does not depend on the bridge when the in-game server close rejects, and keeps the rest for a retry', async () => {
		const alerts = Object.assign(new AlertRuntime({} as AlertRuntimePort), {
			alertIngameServer: { close: vi.fn(async () => { throw new Error('Live source gap has not been durably stored.'); }) },
		});
		const flush = vi.fn(async () => undefined);
		const independent = {
			collectorHeartbeat: { stop: vi.fn() }, priceHistory: { dispose: vi.fn() },
			assistedDetection: { dispose: vi.fn() }, halloween: { dispose: vi.fn() },
		};
		const dependent = {
			liveEconomy: { dispose: vi.fn(async () => undefined) }, liveSessions: { dispose: vi.fn(async () => undefined), stopTimers: vi.fn() },
			sessions: { dispose: vi.fn(async () => undefined) },
		};
		const harness = Object.assign(Object.create(TyrianCompanionCore.prototype) as object, {
			alerts, ...independent, ...dependent,
			live: { excludeLiveAssistedProposal: () => null } satisfies Pick<LiveSessionRuntime, 'excludeLiveAssistedProposal'>,
			localDebugActions: null, localDebug: { flush },
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const shutdownRuntime = (TyrianCompanionCore.prototype as unknown as {
			shutdownRuntime(this: typeof harness): Promise<void>;
		}).shutdownRuntime;

		// The rejection still reaches the caller (Hebra reports it, Obsidian holds it for a retry).
		await expect(shutdownRuntime.call(harness)).rejects.toThrow('durably stored');
		expect(independent.collectorHeartbeat.stop).toHaveBeenCalledOnce();
		expect(independent.priceHistory.dispose).toHaveBeenCalledOnce();
		expect(independent.assistedDetection.dispose).toHaveBeenCalledOnce();
		expect(independent.halloween.dispose).toHaveBeenCalledOnce();
		// The log is still drained when the unload failed.
		expect(flush).toHaveBeenCalled();
		// What the bridge's callbacks still use stays alive until the drain succeeds.
		expect(dependent.liveEconomy.dispose).not.toHaveBeenCalled();
		expect(dependent.liveSessions.dispose).not.toHaveBeenCalled();
		expect(dependent.liveSessions.stopTimers).toHaveBeenCalledOnce();
		expect(dependent.sessions.dispose).not.toHaveBeenCalled();
	});
});
