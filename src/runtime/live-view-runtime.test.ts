import { describe, expect, it, vi } from 'vitest';

import { LiveViewRuntime, TYRIAN_MAIN_VIEW_TYPE, type LiveViewControllers, type LiveViewRuntimePort } from './live-view-runtime';
import type { ViewPlacement } from './view-placement';

/**
 * DE-01, step 3f: `LiveViewRuntime` on its own, over a port checked with `satisfies`. The coalescing
 * of the repaint is also exercised through the real core in `src/main-render-coalescing.test.ts`.
 */

interface Spies {
	companion: ReturnType<typeof vi.fn>;
	advisor: ReturnType<typeof vi.fn>;
	advisorProgress: ReturnType<typeof vi.fn>;
	sale: ReturnType<typeof vi.fn>;
	achievements: ReturnType<typeof vi.fn>;
	refreshProductActions: ReturnType<typeof vi.fn>;
	refreshRibbon: ReturnType<typeof vi.fn>;
	revealView: ReturnType<typeof vi.fn>;
	revealSection: ReturnType<typeof vi.fn>;
}

function harness(overrides: { placement?: ViewPlacement | null; ready?: boolean; withSection?: boolean } = {}) {
	const spies: Spies = {
		companion: vi.fn(), advisor: vi.fn(), advisorProgress: vi.fn(), sale: vi.fn(), achievements: vi.fn(),
		refreshProductActions: vi.fn(), refreshRibbon: vi.fn(), revealView: vi.fn(async () => undefined), revealSection: vi.fn(async () => undefined),
	};
	const mounted = (render: ReturnType<typeof vi.fn>, extra: object = {}) => ({ current: () => [{ render, ...extra }] });
	const state = {
		placement: overrides.placement ?? null,
		ready: overrides.ready ?? true,
		tracker: { getState: () => ({ status: 'idle' as const }) } as unknown as LiveViewRuntimePort['liveSessionLoot'],
	};
	const port = {
		get runtimeReady() { return state.ready; },
		host: { ui: {
			revealView: spies.revealView,
			...(overrides.withSection === false ? {} : { revealSection: spies.revealSection }),
		} },
		mountedViews: {
			companion: mounted(spies.companion, { }),
			inventoryAdvisor: mounted(spies.advisor, { renderProgress: spies.advisorProgress }),
			sale: mounted(spies.sale),
			achievements: mounted(spies.achievements),
		} as unknown as LiveViewControllers,
		get registeredPlacement() { return state.placement; },
		productActions: { refresh: spies.refreshProductActions },
		commands: { refreshSessionRibbon: spies.refreshRibbon },
		get liveSessionLoot() { return state.tracker; },
	} satisfies LiveViewRuntimePort;
	return { runtime: new LiveViewRuntime(port), spies, state };
}

describe('LiveViewRuntime repaints', () => {
	it('coalesces calls of the same tick into one repaint of the Companion, ribbon and actions', async () => {
		const { runtime, spies } = harness();
		runtime.renderViews(); runtime.renderViews(); runtime.renderViews();
		expect(spies.companion).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(spies.companion).toHaveBeenCalledOnce();
		expect(spies.refreshRibbon).toHaveBeenCalledOnce();
		expect(spies.refreshProductActions).toHaveBeenCalledOnce();
		runtime.renderViews();
		await Promise.resolve();
		expect(spies.companion).toHaveBeenCalledTimes(2);
	});

	it('repaints the Inventory and the Sale tabs together, and Achievements on its own', () => {
		const { runtime, spies } = harness();
		runtime.renderInventoryAdvisorViews();
		expect(spies.advisor).toHaveBeenCalledOnce();
		expect(spies.sale).toHaveBeenCalledOnce();
		expect(spies.achievements).not.toHaveBeenCalled();
		runtime.renderAchievementsViews();
		expect(spies.achievements).toHaveBeenCalledOnce();
	});

	it('paints a running sync as progress, refreshing the actions only when the run starts', () => {
		const { runtime, spies } = harness();
		const running = { status: 'running' } as Parameters<LiveViewRuntime['renderInventorySyncRunChange']>[0];
		runtime.renderInventorySyncRunChange(running);
		runtime.renderInventorySyncRunChange(running);
		expect(spies.advisorProgress).toHaveBeenCalledTimes(2);
		expect(spies.refreshProductActions).toHaveBeenCalledOnce();
		expect(spies.advisor).not.toHaveBeenCalled();
		runtime.renderInventorySyncRunChange({ status: 'idle' } as Parameters<LiveViewRuntime['renderInventorySyncRunChange']>[0]);
		expect(spies.advisor).toHaveBeenCalledOnce();
		expect(spies.sale).toHaveBeenCalledOnce();
		// A new run after the outcome starts again.
		runtime.renderInventorySyncRunChange(running);
		expect(spies.refreshProductActions).toHaveBeenCalledTimes(3);
	});
});

describe('LiveViewRuntime sections', () => {
	it('opens the section\'s own view in the sidebar placement', async () => {
		const { runtime, spies } = harness({ placement: 'sidebar' });
		await runtime.activateSaleView();
		expect(spies.revealView).toHaveBeenCalledOnce();
		expect(spies.revealSection).not.toHaveBeenCalled();
	});

	it('enters the section of the main view, reading the placement as it stands', async () => {
		const { runtime, spies, state } = harness({ placement: 'sidebar' });
		await runtime.activateView();
		expect(spies.revealView).toHaveBeenCalledOnce();
		state.placement = 'main';
		await runtime.activateInventoryAdvisorView();
		expect(spies.revealSection).toHaveBeenCalledWith(TYRIAN_MAIN_VIEW_TYPE, 'inventory');
		await runtime.activateAchievementsView();
		expect(spies.revealSection).toHaveBeenLastCalledWith(TYRIAN_MAIN_VIEW_TYPE, 'achievements');
		expect(spies.revealView).toHaveBeenCalledOnce();
	});

	it('falls back to the view of its own when the host has no sections view', async () => {
		const { runtime, spies } = harness({ placement: 'main', withSection: false });
		await runtime.activateView();
		expect(spies.revealView).toHaveBeenCalledOnce();
	});
});

describe('LiveViewRuntime loot', () => {
	it('answers idle before the runtime is ready without touching the tracker', () => {
		const { runtime, state } = harness({ ready: false });
		state.tracker = { getState: () => { throw new Error('tracker is not built yet'); } };
		expect(runtime.getLiveSessionLoot()).toEqual({ status: 'idle' });
	});

	it('reads the tracker once ready', () => {
		const { runtime, state } = harness();
		const loot = { status: 'idle' as const, marker: 1 };
		state.tracker = { getState: () => loot };
		expect(runtime.getLiveSessionLoot()).toBe(loot);
	});
});
