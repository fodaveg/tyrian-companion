import { fileURLToPath, URL } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// An agent worktree checked out under .claude/ is a full second copy of src/.
		// Without this, `vitest run` from the repo root collects both copies and reports
		// roughly double the test count as green.
		exclude: [...configDefaults.exclude, '.claude/**'],
	},
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-mock.ts', import.meta.url)),
		},
	},
});
