import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

// H14.16: `src/platform` is 0 bytes in the production bundle (H8 stays; only
// its tests move gate group) and the files in the source-text-assertion
// allowlist read raw source text with `readFileSync` instead of executing
// code, both slow relative to the signal they give the fast `check` gate.
// `vitest.guardrails.config.mts` runs exactly this excluded set; keep the two
// files in sync so together they still cover every test exactly once.
// `bundle.test.ts` is excluded for another reason: it loads `hebra-main.mjs`,
// which only exists after the `host-esm` step, so it has its own config and its
// own gate step (`hebra-bundle`) behind that build instead of running here.
const frozenSourceTextTests = (JSON.parse(
	readFileSync(new URL('./scripts/source-text-assertion-allowlist.json', import.meta.url), 'utf8'),
) as { frozen: string[] }).frozen;

// GR-17: with `TYRIAN_VITEST_JSON` set to a path (CI sets it on the `check` step), vitest also writes
// its JSON report there, so every push leaves the duration of each test file. The `default` reporter
// stays first and explicit: the console output and the verdict are the ones of a run without it. Passing
// `reporters` replaces vitest's own choice, which adds `github-actions` (annotations) on its own only when
// the list is empty, so it is added back here under `GITHUB_ACTIONS`.
const jsonReportPath = process.env.TYRIAN_VITEST_JSON;
const jsonReport = jsonReportPath === undefined || jsonReportPath === ''
	? {}
	: { reporters: process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions', 'json'] : ['default', 'json'], outputFile: { json: jsonReportPath } };

export default defineConfig({
	test: {
		...jsonReport,
		// An agent worktree checked out under .claude/ is a full second copy of src/.
		// Without this, `vitest run` from the repo root collects both copies and reports
		// roughly double the test count as green.
		exclude: [...configDefaults.exclude, '.claude/**', 'src/platform/**', 'src/host/hebra/bundle.test.ts', ...frozenSourceTextTests],
	},
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-mock.ts', import.meta.url)),
		},
	},
});
