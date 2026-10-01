// `IDBKeyRange` is a real global in Electron; in Node it only exists once this shim loads.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

/**
 * Every request the plugin sends leaves through the host's `requestUrl`. The ones to datawars2
 * are counted and held here until the test answers them; anything else gets an empty answer.
 */
const datawars2 = vi.hoisted(() => ({
	requested: [] as number[],
	held: [] as Array<() => void>,
	inFlight: 0,
	maxInFlight: 0,
	opened: false,
}));

vi.mock('obsidian', async (importOriginal) => ({
	...await importOriginal<Record<string, unknown>>(),
	requestUrl: async ({ url }: { url: string }) => {
		const target = new URL(url);
		if (target.hostname !== 'api.datawars2.ie') return { status: 200, headers: {}, json: {}, text: '{}', arrayBuffer: new ArrayBuffer(0) };
		datawars2.requested.push(Number(target.searchParams.get('itemID')));
		datawars2.inFlight += 1;
		datawars2.maxInFlight = Math.max(datawars2.maxInFlight, datawars2.inFlight);
		if (!datawars2.opened) await new Promise<void>((resolve) => { datawars2.held.push(resolve); });
		datawars2.inFlight -= 1;
		return { status: 404, headers: {}, json: null, text: 'null', arrayBuffer: new ArrayBuffer(0) };
	},
}));

import { inventoryAdvisorBuiltinBundleProvider } from './advisor/inventory-advisor-builtin-bundle';
import type { TyrianSettings } from './core/settings';
import type { PriceHistoryPanelSeedState } from './economy/price-seed-panel-service';
import { indexedDbPriceHistoryPort } from './host/indexed-db-price-history';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/** Items no calendar entry uses: the panel's, and two note blocks'. */
const PANEL_ITEM_ID = 999_001;
const NOTE_BLOCK_ITEM_IDS = [999_002, 999_003] as const;

interface SeedWiring {
	settings: TyrianSettings;
	vaultId: string;
	refreshSale(): Promise<void>;
	loadPriceHistorySeries(itemId: number, side: 'bid', windowDays: 30): Promise<void>;
	priceHistoryPanelSeed: {
		ensure(itemId: number): Promise<PriceHistoryPanelSeedState>;
		getState(itemId: number): PriceHistoryPanelSeedState;
	};
	sellSignal: { ensureSeed(): Promise<void> } | null;
}

/**
 * Task 0812d53e, the wiring: after the real `initializeRuntime`, every path of the plugin that
 * downloads a datawars2 seed takes its turn in ONE queue, and the real `shutdownRuntime` lets that
 * queue go. A seed pass (`refreshSale`), the panel (`loadPriceHistorySeries`), the note blocks
 * (`priceHistoryPanelSeed.ensure`, which is all their `ensure` port calls) and the sell rule's seed
 * are all started while the first request is held.
 */
describe('price seed downloads over the real runtime: one request in flight for the whole plugin', () => {
	let harness: RuntimeHarness | null = null;

	let started: Array<Promise<unknown>> = [];

	afterEach(async () => {
		// A failed test must not leave a pass running into the next one's counters.
		datawars2.opened = true;
		for (const release of datawars2.held.splice(0)) release();
		await Promise.allSettled(started);
		started = [];
		harness?.dispose();
		harness = null;
		datawars2.requested.length = 0;
		datawars2.inFlight = 0;
		datawars2.maxInFlight = 0;
		datawars2.opened = false;
	});

	async function everySeedPathStarted() {
		const runtime = createRuntimeHarness();
		harness = runtime;
		const core = runtime.core as unknown as SeedWiring & { localDebugActions: null };
		// The harness's recording port predates `fireAndForget`; without a port the boot runs those
		// actions directly, as the other tests over the real runtime do.
		core.localDebugActions = null;
		// A configured key is what makes this device a collector; consult devices download no seed.
		core.settings = { ...core.settings, priceHistoryEnabled: true, apiKeySecret: 'tyrian-test-key' };
		await runtime.initializeRuntime();
		// The boot itself asks datawars2 for nothing: every request counted below is one of these paths'.
		expect(datawars2.requested).toEqual([]);

		const sale = core.refreshSale();
		await vi.waitFor(() => { expect(datawars2.requested).toHaveLength(1); });
		const interactive = [PANEL_ITEM_ID, ...NOTE_BLOCK_ITEM_IDS];
		const loads: Array<Promise<unknown>> = [
			core.loadPriceHistorySeries(PANEL_ITEM_ID, 'bid', 30),
			...NOTE_BLOCK_ITEM_IDS.map(async (itemId) => await core.priceHistoryPanelSeed.ensure(itemId)),
		];
		if (core.sellSignal === null) throw new Error('Expected the sell signal runtime to be assembled.');
		const sellSeed = core.sellSignal.ensureSeed();
		started = [sale, ...loads, sellSeed];
		// Every interactive load has read its cache and reached its download, queued or sent.
		await vi.waitFor(() => {
			expect(interactive.map((itemId) => core.priceHistoryPanelSeed.getState(itemId).status))
				.toEqual(interactive.map(() => 'loading'));
		});
		return { runtime, core, pending: started, interactive };
	}

	it('a seed pass, the panel, two note blocks and the sell rule, all asked for together: never two requests in flight', async () => {
		const { pending, interactive } = await everySeedPathStarted();
		const calendar = calendarItemIds();

		expect(datawars2.inFlight).toBe(1);
		expect(datawars2.requested).toEqual([calendar[0]]);

		datawars2.opened = true;
		for (const release of datawars2.held.splice(0)) release();
		await Promise.all(pending);

		expect(datawars2.maxInFlight).toBe(1);
		// What somebody is looking at went right after the request in flight, ahead of the rest of
		// the pass and of the sell rule's seed. (Among themselves they go in the order they reached
		// their download: the panel reads its local series first, so it gets there after the blocks.)
		expect(datawars2.requested.slice(1, 1 + interactive.length).sort((left, right) => left - right)).toEqual(interactive);
		// Nothing was lost on the way: the pass's other items and the sell rule's own seed followed.
		expect(datawars2.requested.length).toBeGreaterThan(1 + interactive.length);
	});

	it('shutdown with downloads waiting: no new request, every promise resolved, nothing written to either cache', async () => {
		const { runtime, core, pending, interactive } = await everySeedPathStarted();
		const calendar = calendarItemIds();
		expect(datawars2.requested).toEqual([calendar[0]]);

		// Collected as they settle, so a promise left unresolved is a failed assertion and not a hang.
		let settled = 0;
		for (const promise of pending) void promise.then(() => { settled += 1; });
		const shutdown = runtime.shutdown();
		// What waited for a turn is resolved by the shutdown alone, with the first request still held.
		await vi.waitFor(() => { expect(settled).toBe(pending.length - 1); });
		// The request in flight ends as it would, and anything asked for from here on would be
		// answered at once (and counted): nothing that waited behind it is asked for.
		datawars2.opened = true;
		for (const release of datawars2.held.splice(0)) release();
		await Promise.all([...pending, shutdown]);

		expect(datawars2.requested).toEqual([calendar[0]]);
		const port = indexedDbPriceHistoryPort({ indexedDB: window.indexedDB });
		const seeds = await port.openSeedCache();
		const noSeeds = await port.openNoSeedCache();
		for (const itemId of [...calendar, ...interactive]) {
			expect(await seeds.get(core.vaultId, itemId)).toBeNull();
			expect(await noSeeds.get(core.vaultId, itemId)).toBeNull();
		}
		seeds.close();
		noSeeds.close();
	});
});

function calendarItemIds(): number[] {
	const loaded = inventoryAdvisorBuiltinBundleProvider.load(new Date().toISOString());
	if (loaded.status !== 'available') throw new Error('Expected the built-in bundle to be available.');
	return loaded.bundle.festivalCalendar.entries.map((entry) => entry.itemId);
}
