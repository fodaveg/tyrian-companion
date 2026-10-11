import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { LiveViewRuntime } from './runtime/live-view-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3f: the core's side of `LiveViewRuntime`. Each delegate of the core reaches the
 * runtime once, with the caller's arguments, and the port reads the core's fields as they stand.
 */
type Delegate = Exclude<keyof LiveViewRuntime, never>;
type Core = Record<string, (...args: unknown[]) => unknown>;

const STATE = { status: 'running' };
const ROWS: ReadonlyArray<readonly [core: string, runtime: Delegate, args: readonly unknown[]]> = [
	['getLiveSessionLoot', 'getLiveSessionLoot', []],
	['renderViews', 'renderViews', []],
	['renderInventoryAdvisorViews', 'renderInventoryAdvisorViews', []],
	['renderAchievementsViews', 'renderAchievementsViews', []],
	['renderInventorySyncRunChange', 'renderInventorySyncRunChange', [STATE]],
	['refreshBackgroundIndicators', 'refreshBackgroundIndicators', []],
	['activateView', 'activateView', []],
	['activateInventoryAdvisorView', 'activateInventoryAdvisorView', []],
	['activateSaleView', 'activateSaleView', []],
	['activateAchievementsView', 'activateAchievementsView', []],
];

describe('the core hands the live view to LiveViewRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(ROWS)('%s reaches LiveViewRuntime.%s once, with its arguments', (name, target, args) => {
		harness = createRuntimeHarness();
		const reached = vi.spyOn(LiveViewRuntime.prototype, target).mockImplementation(() => undefined);

		(harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
	});

	it('the port reads the core\'s placement and readiness as they stand', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { registeredPlacement: string | null; host: { ui: { revealView: unknown; revealSection?: unknown } } };
		const revealView = vi.fn(async () => undefined);
		const revealSection = vi.fn(async () => undefined);
		own.host.ui.revealView = revealView;
		own.host.ui.revealSection = revealSection;
		own.registeredPlacement = 'main';
		await (harness.core as unknown as Core).activateSaleView!();
		expect(revealSection).toHaveBeenCalledWith('tyrian-main-view', 'sale');
		own.registeredPlacement = 'sidebar';
		await (harness.core as unknown as Core).activateSaleView!();
		expect(revealView).toHaveBeenCalledOnce();
		expect((harness.core as unknown as Core).getLiveSessionLoot!()).toEqual({ status: 'idle' });
	});
});
