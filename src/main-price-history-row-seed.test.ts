import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { TyrianCompanionCore } from './runtime/tyrian-companion-core';

afterEach(() => vi.restoreAllMocks());

/**
 * `ensurePriceHistorySeed` is what a row's chart asks for when its «Detalles» opens. The contract
 * (David, 24 sep 2026: price history is opt-in): with the history off, opening a row starts no
 * request. And it is the row's own item: it never goes through `loadPriceHistorySeries`, which
 * would move the price panel's selection.
 */
describe('TyrianCompanionCore.ensurePriceHistorySeed', () => {
	function harness(overrides: { priceHistoryEnabled?: boolean; runtimeReady?: boolean; seed?: boolean } = {}) {
		const ensure = vi.fn(async () => undefined);
		const loadSeries = vi.fn(async () => undefined);
		const render = vi.fn();
		const self = {
			settings: { priceHistoryEnabled: overrides.priceHistoryEnabled ?? true },
			runtimeReady: overrides.runtimeReady ?? true,
			priceHistoryPanelSeed: overrides.seed === false ? null : { ensure },
			priceHistory: { loadSeries },
			renderInventoryAdvisorViews: render,
		};
		const run = async (itemId: number): Promise<void> => await TyrianCompanionCore.prototype.ensurePriceHistorySeed.call(self as never, itemId);
		return { run, ensure, loadSeries, render };
	}

	it('asks the seed service for that item, repaints the tab, and leaves the price panel\'s selection alone', async () => {
		const { run, ensure, loadSeries, render } = harness();

		await run(19_721);

		expect(ensure).toHaveBeenCalledTimes(1);
		expect(ensure).toHaveBeenCalledWith(19_721);
		expect(render).toHaveBeenCalledTimes(1);
		expect(loadSeries).not.toHaveBeenCalled();
	});

	it('does nothing at all while the history is off', async () => {
		const { run, ensure, render } = harness({ priceHistoryEnabled: false });

		await run(19_721);

		expect(ensure).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
	});

	it('does nothing before the runtime is ready, or without a seed service', async () => {
		for (const overrides of [{ runtimeReady: false }, { seed: false }]) {
			const { run, ensure, render } = harness(overrides);

			await run(19_721);

			expect(ensure).not.toHaveBeenCalled();
			expect(render).not.toHaveBeenCalled();
		}
	});
});
