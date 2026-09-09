import type { App, PluginManifest } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import TyrianCompanionPlugin from './main';
import { COMPANION_VIEW_TYPE, TyrianCompanionView } from './ui/companion-view';

/**
 * H14.13: a single detection poll used to chain up to four `renderViews()` calls (the loot
 * tracker's `onStateChange`, both Halloween callbacks, the session's `onSessionStateChange`), and
 * every one of them emptied and rebuilt the whole Companion panel
 * (`companion-view.ts`'s `render()`, `surface.empty()`). This exercises the real private
 * `renderViews()`, not a copy of its logic: four synchronous calls must collapse into the one
 * `TyrianCompanionView.render()` a player's screen actually needed.
 */
describe('H14.13 renderViews coalescing', () => {
	afterEach(() => { vi.restoreAllMocks(); });

	it('collapses four renderViews() calls in the same tick into a single repaint', async () => {
		const render = vi.fn();
		const view = Object.assign(Object.create(TyrianCompanionView.prototype) as object, { render });
		const leaf = { view };
		const getLeavesOfType = vi.fn((type: string) => (type === COMPANION_VIEW_TYPE ? [leaf] : []));
		const app = { workspace: { getLeavesOfType } } as unknown as App;
		const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
		const plugin = new TyrianCompanionPlugin(app, manifest) as unknown as { app: App; renderViews(): void };
		// The test double for `Plugin` (`src/test/obsidian-mock.ts`) does not set `this.app` the
		// way the real Obsidian base class does; every other `main-*.test.ts` harness does this
		// same assignment after construction.
		plugin.app = app;

		plugin.renderViews();
		plugin.renderViews();
		plugin.renderViews();
		plugin.renderViews();
		// Nothing happens synchronously: the four calls only mark the panel dirty.
		expect(render).not.toHaveBeenCalled();

		await Promise.resolve();

		expect(render).toHaveBeenCalledOnce();
	});

	it('still repaints once for a lone call, and repaints again for a call in the next tick', async () => {
		const render = vi.fn();
		const view = Object.assign(Object.create(TyrianCompanionView.prototype) as object, { render });
		const leaf = { view };
		const getLeavesOfType = vi.fn((type: string) => (type === COMPANION_VIEW_TYPE ? [leaf] : []));
		const app = { workspace: { getLeavesOfType } } as unknown as App;
		const manifest = { id: 'tyrian-companion', version: 'test' } as PluginManifest;
		const plugin = new TyrianCompanionPlugin(app, manifest) as unknown as { app: App; renderViews(): void };
		// The test double for `Plugin` (`src/test/obsidian-mock.ts`) does not set `this.app` the
		// way the real Obsidian base class does; every other `main-*.test.ts` harness does this
		// same assignment after construction.
		plugin.app = app;

		plugin.renderViews();
		await Promise.resolve();
		expect(render).toHaveBeenCalledOnce();

		plugin.renderViews();
		await Promise.resolve();
		expect(render).toHaveBeenCalledTimes(2);
	});
});
