import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { HalloweenObservationRuntime } from './runtime/halloween-observation-runtime';
import { PriceHistoryRuntime } from './runtime/price-history-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3g: the core's side of `PriceHistoryRuntime` and `HalloweenObservationRuntime`. Each
 * delegate of the core reaches its runtime once, with the caller's arguments, and answers what the
 * runtime answers; each port reads (and, where the runtime writes, writes) the core's own fields.
 */
type Core = Record<string, (...args: unknown[]) => unknown>;
type Row<T> = ReadonlyArray<readonly [core: string, runtime: keyof T & string, args: readonly unknown[]]>;

const DELTA = { status: 'ok', accountId: 'account-1' };
const CTX = { frontmatter: {} };
const PRICE_ROWS: Row<PriceHistoryRuntime> = [
	['getPriceHistoryState', 'getPriceHistoryState', []],
	['enablePriceHistory', 'enablePriceHistory', []],
	['isPriceHistoryOptInOffered', 'isPriceHistoryOptInOffered', []],
	['dismissPriceHistoryOptIn', 'dismissPriceHistoryOptIn', []],
	['loadPriceHistorySeries', 'loadPriceHistorySeries', [19721, 'ask', 42]],
	['ensurePriceHistorySeed', 'ensurePriceHistorySeed', [19721]],
	['getPriceHistorySeedState', 'getPriceHistorySeedState', [19721]],
	['paintPriceHistoryNoteBlockView', 'paintPriceHistoryNoteBlockView', ['source', null, CTX]],
	['resolvePriceHistoryItemCatalog', 'resolvePriceHistoryItemCatalog', [[19721]]],
	['getBagPriceIngameState', 'getBagPriceIngameState', []],
];
const HALLOWEEN_ROWS: Row<HalloweenObservationRuntime> = [
	['getHalloweenState', 'getHalloweenState', []],
	['getHalloweenPriceAlertState', 'getHalloweenPriceAlertState', []],
	['observeHalloweenDelta', 'observeHalloweenDelta', [DELTA, 'assisted_poll', 'session:s1', undefined]],
	['observeAcceptedHalloweenDelta', 'observeAcceptedHalloweenDelta', [DELTA]],
	['switchHalloweenAccount', 'switchHalloweenAccount', ['account-1', undefined]],
	['halloweenObservationActive', 'halloweenObservationActive', []],
	['sessionHalloweenInfoItemIds', 'sessionHalloweenInfoItemIds', ['s1']],
];
const SENTINEL = { sentinel: true };

describe('the core hands the price history and the Halloween observation to their runtimes', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(PRICE_ROWS)('%s reaches PriceHistoryRuntime.%s once, with its arguments, and answers what it answers', (name, target, args) => {
		harness = createRuntimeHarness();
		const reached = vi.spyOn(PriceHistoryRuntime.prototype, target).mockReturnValue(SENTINEL as never);

		const answer = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(answer).toBe(SENTINEL);
	});

	it.each(HALLOWEEN_ROWS)('%s reaches HalloweenObservationRuntime.%s once, with its arguments, and answers what it answers', (name, target, args) => {
		harness = createRuntimeHarness();
		const reached = vi.spyOn(HalloweenObservationRuntime.prototype, target).mockReturnValue(SENTINEL as never);

		const answer = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(answer).toBe(SENTINEL);
	});

	it('the price history port reads the core\'s settings and services as they stand, before and after they exist', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { settings: { priceHistoryEnabled: boolean }; runtimeReady: boolean; priceHistoryPanelSeed: unknown };
		const ensure = vi.fn(async () => undefined);
		const core = harness.core as unknown as Core;

		own.settings = { ...own.settings, priceHistoryEnabled: false };
		own.runtimeReady = true;
		own.priceHistoryPanelSeed = { ensure, getState: () => SENTINEL };
		await core.ensurePriceHistorySeed!(7);
		expect(ensure).not.toHaveBeenCalled();

		own.settings = { ...own.settings, priceHistoryEnabled: true };
		await core.ensurePriceHistorySeed!(7);
		expect(ensure).toHaveBeenCalledExactlyOnceWith(7);
		expect(core.getPriceHistorySeedState!(7)).toBe(SENTINEL);
	});

	it('a price-history compaction evaluates the Halloween price alert through HalloweenObservationRuntime (Z3-2)', async () => {
		harness = createRuntimeHarness();
		// The harness' diagnostics port has no `fireAndForget`, which `initializeRuntime` reaches for.
		const own = harness.core as unknown as { localDebugActions: object };
		own.localDebugActions = {
			...own.localDebugActions,
			fireAndForget: (_context: unknown, action: () => Promise<unknown>) => { void action().catch(() => undefined); },
		};
		await harness.initializeRuntime();
		const reached = vi.spyOn(HalloweenObservationRuntime.prototype, 'evaluatePriceAlert').mockResolvedValue(undefined);
		const compaction = harness.core as unknown as {
			priceHistory: { options: { afterCompaction(input: unknown): Promise<void> } };
		};
		const readDaily = vi.fn(async () => []);
		const actionContext = { actionId: 'a', correlationId: 'c' };

		await compaction.priceHistory.options.afterCompaction({ nowMs: 1_800_000, readDaily, actionContext });

		expect(reached).toHaveBeenCalledOnce();
		const [port, nowMs, context] = reached.mock.calls[0]!;
		expect(nowMs).toBe(1_800_000);
		expect(context).toBe(actionContext);
		await port.readDaily(36_038, '2026-10-01');
		expect(readDaily).toHaveBeenCalledWith(36_038, '2026-10-01');
	});

	it('the Halloween port writes the account references into the core\'s own fields', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { halloweenAccountRef: string | null; alertAccountRef: string | null };
		const core = harness.core as unknown as Core;

		const accountRef = await core.switchHalloweenAccount!('account-1') as string;

		expect(accountRef).toMatch(/^[0-9a-f]{64}$/);
		expect(own.alertAccountRef).toBe(accountRef);
		expect(own.halloweenAccountRef).toBe(accountRef);
	});
});
