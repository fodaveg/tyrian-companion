// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { IDBFactory } from 'fake-indexeddb';
import type { HebraPluginModule } from 'hebra-plugin-api';
import { describe, expect, it } from 'vitest';

import { createTyrianTestApi, TYRIAN_CAPABILITIES } from '../../test/hebra-plugin-fakes';

// The module Hebra actually downloads: `hebra-main.mjs`, built by `npm run build:host-esm` (the gate
// builds it before the tests). Loaded as Hebra loads it, one ES module on its own, and activated
// against the fake API with the REAL core inside: it exports `activate`, needs nothing besides what
// it bundles, and the core starts, registers its UI and stops cleanly. Skipped when not built.

const BUNDLE = join(process.cwd(), 'hebra-main.mjs');

describe.runIf(existsSync(BUNDLE))('hebra-main.mjs (build it with npm run build:host-esm)', () => {
	it('is one ES module that exports activate and runs the real core over the API, in consultation mode', async () => {
		// happy-dom has no IndexedDB; the bundle reads `window.indexedDB` like it does in Hebra.
		Object.defineProperty(window, 'indexedDB', { configurable: true, value: new IDBFactory() });
		// The path is a constant of this file, nobody's input.
		// eslint-disable-next-line no-unsanitized/method -- see above.
		const loaded = await import(/* @vite-ignore */ pathToFileURL(BUNDLE).href) as Partial<HebraPluginModule>;
		expect(Object.keys(loaded)).toEqual(['activate']);
		expect(typeof loaded.activate).toBe('function');

		const test = createTyrianTestApi({ capabilities: TYRIAN_CAPABILITIES, http: async () => ({ status: 503, headers: {}, text: '' }) });
		const cleanup = await loaded.activate?.(test.api);
		expect(test.fake.recorded.views.length).toBeGreaterThan(0);
		expect(test.fake.recorded.commands.every((command) => command.id.startsWith('tyrian-companion:'))).toBe(true);
		expect(test.fake.recorded.settingsPanels.length).toBeGreaterThan(0);
		expect(test.fake.recorded.codeBlocks.has('tyrian-price-history')).toBe(true);
		// No settings saved: consultation mode, so nothing is written to the library.
		expect(test.library.writes).toEqual([]);
		await cleanup?.();
	}, 30_000);
});
