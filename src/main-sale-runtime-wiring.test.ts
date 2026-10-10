// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { SaleRuntime } from './runtime/sale-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 2: the core's side of `SaleRuntime`, over the real `initializeRuntime`. The runtime's
 * own behaviour is tested on its own (`src/runtime/sale-runtime.test.ts`), with the steps the core
 * takes around it written out; this file proves the real core takes them. Only the core's public
 * facade is called (and the harness's own `shutdown`, the real `shutdownRuntime`); what reaches
 * `SaleRuntime` is observed on its prototype, never on a private field.
 */
describe('the core hands the Sale tab to SaleRuntime: facade, advisor refresh, sync action, Settings and unload', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
		vi.restoreAllMocks();
	});

	/** The real core after its real `initializeRuntime`, on a collector device with price history on. */
	async function bootedCore() {
		const runtime = createRuntimeHarness();
		harness = runtime;
		const setup = runtime.core as unknown as {
			localDebugActions: null;
			settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void };
		};
		// The harness's recording port predates `fireAndForget`; without a port the boot runs those
		// actions directly, as the other tests over the real runtime do.
		setup.localDebugActions = null;
		// `onload` builds the settings tab; `updateSettings` repaints it.
		setup.settingTab = { refreshConnectionRow: () => undefined, refreshForSettingsChange: () => undefined };
		// A configured key is what makes this device a collector.
		runtime.core.settings = { ...runtime.core.settings, priceHistoryEnabled: true, apiKeySecret: 'tyrian-test-key', language: 'es' };
		await runtime.initializeRuntime();
		return { runtime, core: runtime.core };
	}

	it('the public Sale getters answer what SaleRuntime reads through the port: the language, the detector the core built, no coverage yet', async () => {
		const { core } = await bootedCore();

		expect({
			locale: core.getSaleLocale(),
			sellSignal: core.getSellSignalState() === null ? 'absent' : 'present',
			coverage: core.getPriceSeedQueueCoverage(),
			status: core.getSaleViewModel().status,
		}).toEqual({ locale: 'es', sellSignal: 'present', coverage: null, status: 'loading' });
	});

	it('an advisor refresh recomputes the hero card verdict once, through SaleRuntime', async () => {
		const { core } = await bootedCore();
		const heroTiming = vi.spyOn(SaleRuntime.prototype, 'refreshSaleHeroTiming').mockResolvedValue();

		await core.refreshInventoryAdvisor();

		expect(heroTiming).toHaveBeenCalledOnce();
	});

	it('an inventory sync runs inside one SaleRuntime seed action', async () => {
		const { core } = await bootedCore();
		const syncAction = vi.spyOn(SaleRuntime.prototype, 'runPriceSeedSyncAction').mockResolvedValue(undefined);

		await core.runInventoryVaultSync();

		expect(syncAction).toHaveBeenCalledOnce();
	});

	it('Settings switching the price history off drops the stale copies waiting in SaleRuntime, and switching it on drops nothing', async () => {
		const { core } = await bootedCore();
		const drop = vi.spyOn(SaleRuntime.prototype, 'dropPriceSeedDeferredRequest');

		await core.updateSettings({ priceHistoryEnabled: false });
		const afterOff = drop.mock.calls.length;
		await core.updateSettings({ priceHistoryEnabled: true });

		expect({ afterOff, afterOn: drop.mock.calls.length }).toEqual({ afterOff: 1, afterOn: 1 });
	});

	it('the real shutdownRuntime disposes SaleRuntime once', async () => {
		const { runtime } = await bootedCore();
		const dispose = vi.spyOn(SaleRuntime.prototype, 'dispose');

		await runtime.shutdown();

		expect(dispose).toHaveBeenCalledOnce();
	});
});
