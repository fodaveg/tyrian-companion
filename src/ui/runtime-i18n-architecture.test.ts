import { describe, expect, it } from 'vitest';

import { hasDirectVisibleCopy, hasRawMarkdownPresentation, hasUnsafeRuntimeText } from '../test/runtime-i18n-source-analysis';

// The analysers' own behaviour on synthetic snippets (GR-04). The half that applies them to real module
// source lives in `runtime-i18n-architecture-source-text.test.ts`, which reads source text and therefore
// runs only under `vitest.guardrails.config.mts`.
describe('runtime UI i18n boundary', () => {
	it('turns red for visible literals in properties, setters, aria attributes and templates', () => {
		expect(hasDirectVisibleCopy("setting.setName('English')")).toBe(true);
		expect(hasDirectVisibleCopy("setting.setName('¿Seguro?')")).toBe(true);
		expect(hasDirectVisibleCopy("setting.setDesc('¡Atención!')")).toBe(true);
		expect(hasDirectVisibleCopy("node.setText('Éxito')")).toBe(true);
		expect(hasDirectVisibleCopy("node.setAttr('aria-label', 'English')")).toBe(true);
		expect(hasDirectVisibleCopy("node.createEl('p', { text: `English copy` })")).toBe(true);
	});

	it.each([
		['direct setter', 'error.setText(result.message)'],
		['destructured field', 'const { message } = result; error.setText(message)'],
		['two-hop alias', 'const first = result.message; const second = first; const final = second; error.setText(final)'],
		['named local function', 'function render(value) { error.setText(value); } render(result.message)'],
		['arrow callback', 'const notify = (value) => error.setText(value); notify(result.message)'],
		['immediate local callback', '((value) => error.setText(value))(result.message)'],
	] as const)('turns red when an untrusted runtime message reaches a visible sink through %s', (_, source) => {
		expect(hasUnsafeRuntimeText(source)).toBe(true);
	});

	it('keeps translated runtime copy outside the raw-data flow', () => {
		expect(hasUnsafeRuntimeText("error.setText(t('modal.reviewSaveFailed'))")).toBe(false);
		expect(hasUnsafeRuntimeText('const render = (value) => error.setText(localize(value)); render(result.message)')).toBe(false);
		expect(hasUnsafeRuntimeText('show(result.message)')).toBe(false);
	});

	it.each([
		['template alias', 'const route = decision.route; return `- Route: ${route}`;'],
		['sanitizer argument', 'return text(reason.code);'],
		['line append', 'lines.push(decision.route);'],
		['named local renderer', 'function render(value) { lines.push(value); } render(decision.route)'],
		['arrow local notifier', 'const notify = (value) => text(value); notify(reason.code)'],
	] as const)('turns red when Markdown bypasses a localized projection through %s', (_, source) => {
		expect(hasRawMarkdownPresentation(source)).toBe(true);
	});

	it('permits a Markdown projection that localizes the raw value before rendering', () => {
		expect(hasRawMarkdownPresentation('return `- Label: ${localizedRoute(decision.route)}`;')).toBe(false);
	});
});
