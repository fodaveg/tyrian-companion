import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import { assembleAdvisor, type AdvisorAssemblyInput } from './assemble-advisor';

/** Z4-5: changing the API key invalidates the controller, and the next refresh must not join the old capture. */
describe('assembleAdvisor invalidate', () => {
	it('starts a new evidence capture for the refresh that follows an invalidate', async () => {
		const beginOperation = vi.fn();
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const input = {
			factory: new IDBFactory(),
			vaultId: 'vault',
			client: { beginOperation },
			publicClient: { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) },
			snapshots: { captureInventoryWithOperation: vi.fn(async () => { await held; throw new Error('stopped'); }) },
			rateLimit: { status: () => ({ state: 'ready' }), recordRateLimited: vi.fn() },
			locale: () => 'es',
			personalValuation: () => 'self',
			materialStorageCapacity: () => ({ base: 250, extra: 0 }),
			equipmentSalvagePreferences: () => ({}),
			writeCaptureReceipt: vi.fn(),
			phaseListener: { current: null },
			captureProgressListener: { current: null },
			catalogPersistence: new LocalDebugPersistenceProbe(),
			preferencesReadPersistence: new LocalDebugPersistenceProbe(),
			preferencesWritePersistence: new LocalDebugPersistenceProbe(),
			diagnostics: null,
		} as unknown as AdvisorAssemblyInput;
		// An operation that never ends keeps the first capture in flight.
		beginOperation.mockImplementation((() => ({ request: vi.fn(), requestDetailed: vi.fn() })) as never);
		const { controller } = assembleAdvisor(input);

		const first = controller.refresh();
		await vi.waitFor(() => expect(beginOperation).toHaveBeenCalledTimes(1));
		controller.invalidate();
		const second = controller.refresh();
		await vi.waitFor(() => expect(beginOperation).toHaveBeenCalledTimes(2));

		release();
		await Promise.allSettled([first, second]);
	});
});
