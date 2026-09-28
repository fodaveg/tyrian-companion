/**
 * R1a: `main.ts` reaches every non-UI capability through `this.host`, the `ObsidianHost` it
 * builds from its own `app`, `manifest`, `loadData` and `saveData`. The model tests that call a
 * `TyrianCompanionPlugin.prototype` method on a plain object harness never had that getter, so
 * this gives the harness the same thing production has: the REAL `createObsidianHost` over the
 * harness's own fakes, built on first use like the plugin's own. A test that stubbed `app.vault`,
 * `saveData` or `navigator.clipboard` before R1a still observes exactly those stubs.
 */
import type { Plugin } from 'obsidian';

import { createObsidianHost } from '../host/obsidian/obsidian-host';
import type { TyrianHost } from '../host/tyrian-host';

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
