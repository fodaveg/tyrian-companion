import { describe, expect, it } from 'vitest';

import { readModuleSource } from '../test/module-boundary';
import { hasDirectVisibleCopy, hasRawMarkdownPresentation, hasUnsafeRuntimeText } from '../test/runtime-i18n-source-analysis';

// Source-text half of `runtime-i18n-architecture.test.ts` (GR-04): applies the analysers to real module
// source, so it sits in the frozen allowlist and runs only under `vitest.guardrails.config.mts`.
const RUNTIME_UI_FILES = [
	'src/main.ts',
	'src/runtime/tyrian-companion-core.ts',
	'src/runtime/core-sale-rules.ts',
	'src/runtime/core-outcomes.ts',
	'src/runtime/core-actions.ts',
	'src/runtime/sale-runtime.ts',
	'src/ui/companion-view.ts',
	'src/ui/companion-status-model.ts',
	'src/ui/inventory-advisor-view.ts',
	'src/ui/manual-session-start-modal.ts',
	'src/ui/settings-tab.ts',
	'src/ui/session-command-adapter.ts',
	'src/ui/session-command-controller.ts',
	'src/ui/session-command-model.ts',
	'src/ui/pending-proposal-command.ts',
] as const;

const MARKDOWN_RENDERERS = [
	'src/sessions/session-note-renderer.ts',
	'src/sessions/loot-presentation-markdown.ts',
] as const;

describe('runtime UI i18n boundary (source text)', () => {
	it.each(RUNTIME_UI_FILES)('%s does not introduce direct visible copy', (path) => {
		const source = readModuleSource(path);
		expect(hasDirectVisibleCopy(source)).toBe(false);
	});

	it.each(['src/runtime/core-sale-rules.ts', 'src/runtime/core-outcomes.ts', 'src/runtime/core-actions.ts', 'src/runtime/sale-runtime.ts'] as const)(
		'%s is covered by the guard: a visible literal added to it turns the check red',
		(path) => {
			expect(RUNTIME_UI_FILES).toContain(path);
			expect(hasDirectVisibleCopy(`${readModuleSource(path)}\nsetting.setName('English');`)).toBe(true);
		},
	);

	it('keeps the real companion view and manual-session modal outside the raw-data flow', () => {
		for (const path of ['src/ui/companion-view.ts', 'src/ui/manual-session-start-modal.ts'] as const) {
			expect(hasUnsafeRuntimeText(readModuleSource(path))).toBe(false);
		}
	});

	it.each(MARKDOWN_RENDERERS)('%s does not interpolate presentation enums or raw API fields into Markdown', (path) => {
		expect(hasRawMarkdownPresentation(readModuleSource(path))).toBe(false);
	});
});
