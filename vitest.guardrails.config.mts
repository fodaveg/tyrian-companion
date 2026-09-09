import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

// The other half of the H14.16 split: only `src/platform` and the frozen
// source-text-assertion tests, which `vitest.config.mts` excludes from the
// fast `check` gate. Keep this file's `include` in sync with that file's
// `exclude` so together they still cover every test exactly once.
const frozenSourceTextTests = (JSON.parse(
	readFileSync(new URL('./scripts/source-text-assertion-allowlist.json', import.meta.url), 'utf8'),
) as { frozen: string[] }).frozen;

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, '.claude/**'],
		include: ['src/platform/**/*.test.ts', ...frozenSourceTextTests],
	},
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-mock.ts', import.meta.url)),
		},
	},
});
