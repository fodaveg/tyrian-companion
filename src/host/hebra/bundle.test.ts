// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { IDBFactory } from 'fake-indexeddb';
import type { HebraPluginModule } from 'hebra-plugin-api';
import { describe, expect, it } from 'vitest';

import { createTyrianTestApi, TYRIAN_CAPABILITIES } from '../../test/hebra-plugin-fakes';

// The module Hebra actually downloads: `hebra-main.mjs`, built by `npm run build:host-esm`. Loaded as
// Hebra loads it, one ES module on its own, and activated against the fake API with the REAL core
// inside: it exports `activate`, needs nothing besides what it bundles, and the core starts,
// registers its UI and stops cleanly.
//
// This file is NOT part of the `unit` gate step (`vitest.config.mts` excludes it): the `hebra-bundle`
// step runs it through `vitest.hebra-bundle.config.mts` right after `host-esm` builds the bundle, so
// it judges the bundle of the tree being measured. It never skips: a missing bundle is a failure,
// because a skipped test here is how the published artefact went untested in CI.

const BUNDLE = join(process.cwd(), 'hebra-main.mjs');

describe('hebra-main.mjs (build it with npm run build:host-esm)', () => {
	it('exists: the gate builds it before this test, so its absence is a red, not a skip', () => {
		expect(existsSync(BUNDLE), `${BUNDLE} is missing: run npm run build:host-esm before this test`).toBe(true);
	});

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
