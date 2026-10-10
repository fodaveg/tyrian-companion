import { fileURLToPath, URL } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

// The third slice of the gate's vitest runs. `vitest.config.mts` excludes
// `bundle.test.ts` because it loads `hebra-main.mjs`, which does not exist
// until the `host-esm` step has built it; this config runs exactly that file,
// in the `hebra-bundle` step that comes after `host-esm`. Keep the path in
// sync with that exclusion so the test runs once and never before the build.
export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, '.claude/**'],
		include: ['src/host/hebra/bundle.test.ts'],
	},
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-mock.ts', import.meta.url)),
		},
	},
});
