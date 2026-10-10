// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

/** Every datawars2 request is held here until the test answers it; anything else gets an empty answer. */
const datawars2 = vi.hoisted(() => ({ requested: [] as number[], held: [] as Array<() => void> }));

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	requestUrl: async ({ url }: { url: string }) => {
		const target = new URL(url);
		if (target.hostname !== 'api.datawars2.ie') return { status: 200, headers: {}, json: {}, text: '{}', arrayBuffer: new ArrayBuffer(0) };
		datawars2.requested.push(Number(target.searchParams.get('itemID')));
		await new Promise<void>((resolve) => { datawars2.held.push(resolve); });
		return { status: 404, headers: {}, json: null, text: 'null', arrayBuffer: new ArrayBuffer(0) };
	},
}));

import { HttpTransportError } from './core/http';
import { LocalDebugActionRunner } from './core/local-debug-action-runner';
import type { LocalDebugRecordInput } from './core/local-debug-contract';
import type { LocalDebugLogger } from './core/local-debug-logger';
import { PriceHistoryRuntime } from './economy/price-history-runtime';
import { SellSignalRuntime } from './economy/sell-signal-runtime';
import { HALLOWEEN_PRICE_ALERT_ITEM_ID } from './halloween/halloween-price-alert';
import { SaleRuntime } from './runtime/sale-runtime';
import { SaleItemView } from './ui/sale-item-view';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';
import type { InventoryAdvisorViewModel } from './ui/inventory-advisor-view-model';

/**
 * DE-01, step 2: the core's side of `SaleRuntime`, over the real `initializeRuntime`. The runtime's
 * own behaviour is tested on its own (`src/runtime/sale-runtime.test.ts`), with the steps the core
 * takes around it written out; this file proves the real core takes them. The facade cases call only
 * the core's public methods (and the harness's own `shutdown`, the real `shutdownRuntime`) and watch
 * `SaleRuntime`'s prototype. The port cases reach the core's `sale` field (a cast to a private of the
 * core, never of `SaleRuntime`) to drive the two paths the facade cannot: the inventory analysis's
 * seed pass and the price history's compaction hook.
 */
describe('the core hands the Sale tab to SaleRuntime: facade, advisor refresh, sync action, Settings and unload', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		// A failed test must not leave a seed download waiting into the next one.
		for (const release of datawars2.held.splice(0)) release();
		datawars2.requested.length = 0;
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

	it('the Sale refresh facade hands its options on, as the Sale view calls it', async () => {
		const { core } = await bootedCore();
		const refresh = vi.spyOn(SaleRuntime.prototype, 'refreshSale').mockResolvedValue();

		// `sale-item-view.ts`: `await this.actions.refreshSale({ refreshSeeds })`, false on auto-open.
		await core.refreshSale({ refreshSeeds: false });

		expect(refresh).toHaveBeenCalledWith({ refreshSeeds: false });
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

	/**
	 * The Sale view reports a failed refresh through `getSaleDiagnostics`, which the core answers with
	 * its own `localDebugActions`. The view is built with the real core as its actions (as
	 * `mountedViews` does) and made to refresh through the core's real `refreshSale`; only the runtime
	 * underneath throws. No DOM: the refresh call never touches `contentEl`.
	 */
	it('a Venta refresh that throws reaches the core\'s diagnostics as sale_refresh', async () => {
		const { core } = await bootedCore();
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		(core as unknown as { localDebugActions: LocalDebugActionRunner }).localDebugActions = new LocalDebugActionRunner({
			diagnostics: { record } as unknown as LocalDebugLogger, createId: () => 'sale-refresh-wiring',
		});
		vi.spyOn(SaleRuntime.prototype, 'refreshSale').mockRejectedValue(new Error('bazaar down'));
		const view = new SaleItemView({} as HTMLElement, { setIcon: () => undefined }, core);

		await (view as unknown as { callRefreshSale(refreshSeeds: boolean): Promise<boolean> }).callRefreshSale(false);

		expect(record.mock.calls.map(([input]) => input).find((input) => input.state === 'sale_refresh')).toMatchObject({
			component: 'ui', action: 'view_render', level: 'error', phase: 'failure', code: 'unknown_failure', state: 'sale_refresh',
		});
	});

	it('a transport timeout in a Venta refresh is registered with the code timeout, classified by the core', async () => {
		const { core } = await bootedCore();
		const record = vi.fn((_input: LocalDebugRecordInput) => true);
		(core as unknown as { localDebugActions: LocalDebugActionRunner }).localDebugActions = new LocalDebugActionRunner({
			diagnostics: { record } as unknown as LocalDebugLogger, createId: () => 'sale-refresh-timeout',
		});
		vi.spyOn(SaleRuntime.prototype, 'refreshSale').mockRejectedValue(new HttpTransportError('timeout', null, null, 'Request timed out.'));
		const view = new SaleItemView({} as HTMLElement, { setIcon: () => undefined }, core);

		await (view as unknown as { callRefreshSale(refreshSeeds: boolean): Promise<boolean> }).callRefreshSale(false);

		expect(record.mock.calls.map(([input]) => input).find((input) => input.state === 'sale_refresh')).toMatchObject({
			code: 'timeout', state: 'sale_refresh',
		});
	});

	it('the real shutdownRuntime disposes SaleRuntime once', async () => {
		const { runtime } = await bootedCore();
		const dispose = vi.spyOn(SaleRuntime.prototype, 'dispose');

		await runtime.shutdown();

		expect(dispose).toHaveBeenCalledOnce();
	});

	/**
	 * The port is read live: `SaleRuntime` is built with the core, before `initializeRuntime` sets the
	 * vault id and builds the price history, and before anything sets the diagnostics or unloads. A
	 * port that copied those values at construction would hand the runtime `null`, `null`, `null` and
	 * `false` for good. Each case below needs one of them as it stands at the moment of the read.
	 */
	describe('the port reads the core as it stands, not as it was when SaleRuntime was built', () => {
		/** The core's own `sale`: a private of the core (never of `SaleRuntime`), for the paths the facade does not reach. */
		const saleOf = (core: unknown): SaleRuntime => (core as { sale: SaleRuntime }).sale;

		it('vaultId and priceHistory: the hero card verdict reads the daily store and the seed cache the boot built', async () => {
			const { core } = await bootedCore();
			// The Saco owned, on a day its calendar window is open: the verdict goes on to read its history.
			vi.spyOn(core, 'getInventoryAdvisorViewModel').mockReturnValue(sacoOwned(1));
			vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 26, 7, 35, 0));
			const readDaily = vi.spyOn(PriceHistoryRuntime.prototype, 'readDaily');
			const readSeed = vi.spyOn(SaleRuntime.prototype, 'readCachedPriceSeed');

			await core.refreshInventoryAdvisor();

			expect({
				daily: readDaily.mock.calls.filter(([itemId]) => itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID).length,
				seed: readSeed.mock.calls.filter(([vaultId, itemId]) => typeof vaultId === 'string' && itemId === HALLOWEEN_PRICE_ALERT_ITEM_ID).length,
			}).toEqual({ daily: 1, seed: 1 });
		});

		it('unloaded: a seed pass that ends after the unload has begun leaves the coverage line as it was', async () => {
			const { runtime, core } = await bootedCore();
			const pass = saleOf(core).refreshPriceSeedsForSync([999_101]);
			await vi.waitFor(() => { expect(datawars2.requested).toEqual([999_101]); });

			const shutdown = runtime.shutdown();
			for (const release of datawars2.held.splice(0)) release();
			await Promise.allSettled([pass, shutdown]);

			expect(core.getPriceSeedQueueCoverage()).toBeNull();
		});

		it('localDebugActions: a diagnostics runner set after the boot receives the sell signal\'s compaction failure', async () => {
			const { core } = await bootedCore();
			const record = vi.fn((_input: LocalDebugRecordInput) => true);
			(core as unknown as { localDebugActions: LocalDebugActionRunner }).localDebugActions = new LocalDebugActionRunner({
				diagnostics: { record } as unknown as LocalDebugLogger, createId: () => 'sale-port-live',
			});
			vi.spyOn(SellSignalRuntime.prototype, 'ensureSeed').mockRejectedValue(new Error('indexeddb unavailable'));

			await saleOf(core).evaluateSellSignal({ nowMs: Date.UTC(2026, 4, 31, 12), readDaily: async () => [] });

			expect(record.mock.calls.map(([input]) => input).find(
				(input) => input.component === 'price_history' && input.action === 'price_history_compact' && input.phase === 'failure',
			)).toMatchObject({ code: 'unknown_failure', state: 'sell_signal' });
		});
	});
});

/** The advisor's model with the Saco de Halloween owned, the only row the hero card's verdict reads. */
function sacoOwned(ownedQuantity: number): InventoryAdvisorViewModel {
	return {
		status: 'ready', title: 'x', detail: 'y', groups: [{ key: 'curated', rows: [{
			id: '#/sale/hero/36038', itemId: HALLOWEEN_PRICE_ALERT_ITEM_ID, name: 'Saco de Halloween', icon: null,
			ownedQuantity, availableQuantity: ownedQuantity, action: 'open', quantity: ownedQuantity,
			allocations: [{ positionRef: '#/positions/36038/0', quantity: ownedQuantity, location: { source: 'character', character: 'Astra', container: 'bag', bagIndex: 0, slot: 0 } }],
			reasonCodes: [], protectionReasons: [], value: { status: 'not_applicable', route: null },
			marketComparison: null, burden: null,
			coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete', reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
			irreversibleReviewOnly: false, discardProof: null,
		}] }],
	};
}
