import { describe, expect, it } from 'vitest';

import { createTranslator } from '../core/i18n';
import { forbiddenBoundaryUses, type ModuleBoundary, calleeChains, readModuleSource } from '../test/module-boundary';

// Source-text half of `settings-tab.test.ts` (GR-04): this file reads `settings-tab.ts` and
// `styles.css` as text, so it lives in the frozen allowlist and runs only under
// `vitest.guardrails.config.mts`. The behavioural tests stay in `settings-tab.test.ts`, which
// `check` runs.
describe('settings information architecture (source text)', () => {
	it('keeps the page DOM-light: native rows, a closed details block, focus restored and the save-state announcer', () => {
		const source = readModuleSource('src/ui/settings-tab.ts');
		const styles = readModuleSource('styles.css');
		expect(calleeChains(source)).not.toContain('renderProductShell');
		const boundary: ModuleBoundary = {
			path: 'src/ui/settings-tab.ts',
			forbiddenImports: [],
			forbiddenNames: ['tyrian-companion-settings__essentials', 'tyrian-companion-settings__advanced', 'tablist'],
		};
		expect(forbiddenBoundaryUses(source, boundary)).toEqual([]);
		for (const gone of [
			'tyrian-companion-settings__essentials', 'tyrian-companion-settings__advanced',
			'tyrian-product-settings__layout', 'tyrian-product-settings__panels', 'tyrian-product-settings__section',
			'tyrian-product-settings__nav',
		]) expect(styles).not.toContain(gone);
		expect(styles).toMatch(/\.tyrian-companion-settings__maintenance > summary:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--interactive-accent\);/u);
		expect(styles).toMatch(/\.tyrian-companion-settings \.setting-item-control\s*\{[\s\S]*flex-wrap:\s*wrap;/u);
		expect(styles).not.toMatch(/\.tyrian-companion-settings[^{]*\{[^}]*min-(?:block-size|height):\s*44px/su);
		expect(source).toContain('restoreSettingsFocus(this.containerEl, focus)');
		expect(source).toContain('control.focus({ preventScroll: true })');
		expect(source).toContain("state === 'error' ? 'alert' : 'status'");
		expect(createTranslator('es').t('settings.save.saving')).toBe('Guardando…');
		expect(createTranslator('en').t('settings.save.error')).toContain('last saved setting is preserved');
	});
});
