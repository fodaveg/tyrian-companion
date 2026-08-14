import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-mock.ts', import.meta.url)),
		},
	},
});
