/**
 * R1a: `main.ts` reaches every non-UI capability through `this.host`, the `ObsidianHost` it
 * builds from its own `app`, `manifest`, `loadData` and `saveData`. The model tests that call a
 * `TyrianCompanionPlugin.prototype` method on a plain object harness never had that getter, so
 * this gives the harness the same thing production has: the REAL `createObsidianHost` over the
 * harness's own fakes, built on first use like the plugin's own. A test that stubbed `app.vault`,
 * `saveData` or `navigator.clipboard` before R1a still observes exactly those stubs.
 */
import type { App, Plugin, PluginManifest } from 'obsidian';
import { vi } from 'vitest';

import { createObsidianHost } from '../host/obsidian/obsidian-host';
import type { TyrianHost } from '../host/tyrian-host';
import TyrianCompanionPlugin from '../main';
import type { TyrianCompanionCore } from '../runtime/tyrian-companion-core';

/**
 * R1c: the plugin Obsidian builds and the core it hands its `ObsidianHost` to, the production
 * path. The obsidian mock's `Plugin` stores nothing, so the members the host reads off the plugin
 * (`app`, `manifest`, `registerEvent`, and whatever `plugin` adds, such as `saveData`) are set on
 * it here; everything else a test arranges or reads (settings, services, private methods) is the
 * core's, reached through the same `as unknown as` cast the `main-*.test.ts` harnesses use.
 */
export function obsidianPluginCore(
	app: App,
	manifest: PluginManifest,
	plugin: Partial<Pick<Plugin, 'loadData' | 'saveData'>> = {},
): { readonly plugin: TyrianCompanionPlugin; readonly core: TyrianCompanionCore } {
	const obsidianPlugin = new TyrianCompanionPlugin(app, manifest);
	obsidianPlugin.app = app;
	obsidianPlugin.manifest = manifest;
	obsidianPlugin.registerEvent = vi.fn();
	Object.assign(obsidianPlugin, plugin);
	return { plugin: obsidianPlugin, core: obsidianPlugin.core };
}

export function withObsidianHost<T extends object>(harness: T): T & { readonly host: TyrianHost } {
	let host: TyrianHost | null = null;
	Object.defineProperty(harness, 'host', {
		configurable: true,
		enumerable: false,
		get: () => {
			host ??= createObsidianHost(harness as unknown as Plugin);
			return host;
		},
	});
	return harness as T & { readonly host: TyrianHost };
}
