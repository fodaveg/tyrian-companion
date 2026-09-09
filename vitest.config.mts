import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

// H14.16: `src/platform` is 0 bytes in the production bundle (H8 stays; only
// its tests move gate group) and the files in the source-text-assertion
// allowlist read raw source text with `readFileSync` instead of executing
// code, both slow relative to the signal they give the fast `check` gate.
// `vitest.guardrails.config.mts` runs exactly this excluded set; keep the two
// files in sync so together they still cover every test exactly once.
const frozenSourceTextTests = (JSON.parse(
	readFileSync(new URL('./scripts/source-text-assertion-allowlist.json', import.meta.url), 'utf8'),
) as { frozen: string[] }).frozen;

export default defineConfig({
	test: {
		// An agent worktree checked out under .claude/ is a full second copy of src/.
		// Without this, `vitest run` from the repo root collects both copies and reports
		// roughly double the test count as green.
		exclude: [...configDefaults.exclude, '.claude/**', 'src/platform/**', ...frozenSourceTextTests],
	},
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-mock.ts', import.meta.url)),
		},
	},
});
