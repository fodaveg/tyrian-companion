import { describe, expect, it } from 'vitest';

import { classMethodBody, classMethodCallChains, calleeChains, readModuleSource } from '../test/module-boundary';

describe('product action architecture', () => {
	it('registers the palette exactly once, wired to the plugin\'s own session commands and executor', () => {
		const main = readModuleSource('src/runtime/tyrian-companion-core.ts');
		expect(calleeChains(main).filter((chain) => chain === 'registerProductActionPalette')).toHaveLength(1);
		const setup = classMethodBody(main, 'TyrianCompanionCore', 'setupProductActions');
		expect(setup).toContain('sessionCommands: this.sessionCommands');
		expect(setup).toContain('execute: (id) => this.executeProductAction');
	});

	it('renders the same product shell from the companion and inventory surfaces, never from settings', () => {
		const companion = readModuleSource('src/ui/companion-view.ts');
		const inventory = readModuleSource('src/ui/inventory-advisor-item-view.ts');
		const settings = readModuleSource('src/ui/settings-tab.ts');
		for (const surface of [companion, inventory]) {
			const chains = calleeChains(surface);
			expect(chains).toContain('renderProductShell');
			expect(chains).toContain('this.actions.getProductActionController');
		}
		// The Settings tab renders native Obsidian rows only; the product shell header lives elsewhere.
		expect(calleeChains(settings)).not.toContain('renderProductShell');
	});

	it('refreshes the product actions from both view repaints, never from inside their own setup', () => {
		const main = readModuleSource('src/runtime/tyrian-companion-core.ts');
		const setup = classMethodCallChains(main, 'TyrianCompanionCore', 'setupProductActions');
		expect(setup).not.toContain('this.renderViews');
		expect(setup).not.toContain('this.renderInventoryAdvisorViews');
		expect(setup).not.toContain('this.settingTab.refreshForSettingsChange');
		// `renderViews()` only marks the Companion surface dirty; the coalesced microtask it
		// schedules is what actually refreshes the actions, in `flushRenderViews`.
		expect(classMethodCallChains(main, 'TyrianCompanionCore', 'flushRenderViews'))
			.toContain('this.productActions?.refresh');
		expect(classMethodCallChains(main, 'TyrianCompanionCore', 'renderInventoryAdvisorViews'))
			.toContain('this.productActions?.refresh');
	});

	it('keeps responsive, focus, reduced-motion, and 44px contracts in the product stylesheet', () => {
		const styles = readModuleSource('styles.css');
		expect(styles).toContain('@container (max-width: 599px)');
		expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
		// The workspace holds only the content area now: no `actions` area, and no narrow-width
		// override of a template that is the same single column at every width.
		expect(styles).toContain('grid-template-areas: "content"');
		expect(styles).not.toContain('"actions"');
		expect(styles).not.toContain('@container (max-width: 1049px)');
		// The action panel was retired (nothing mounts it), so none of its rules may linger.
		expect(styles).not.toContain('tyrian-action-panel');
		expect(styles).toContain('.tyrian-product-shell button:focus-visible');
	});

	// R1c (Hebra checkpoint 16): a container cannot be queried by an @container rule tied to
	// itself. `.tyrian-product-surface` establishes the container `contentEl` always carries (from
	// `renderProductShell`), so its own padding must be queried on `.tyrian-product-shell`, its one
	// direct child, or the 599px rule below never actually applies to any of the three views.
	it('queries the shell child for the narrow padding, never the surface that establishes the container', () => {
		const styles = readModuleSource('styles.css');
		const surfaceBlock = styles.match(/\.tyrian-product-surface\s*\{[^}]*\}/u)?.[0] ?? '';
		expect(surfaceBlock).not.toContain('padding');
		expect(styles).toMatch(/\.tyrian-product-shell\s*\{\s*padding: var\(--size-4-4\);/u);
		expect(styles).toMatch(/@container \(max-width: 599px\)\s*\{\s*\.tyrian-product-shell\s*\{\s*padding: var\(--size-4-2\);/u);
		// The Companion view's own `contentEl` also carries `.tyrian-product-surface`; repeating
		// container-type/max-width/padding/overflow-x on `.tyrian-companion-view` let this later,
		// equal-specificity block win the padding one over the @container rule above on that view only.
		expect(styles).not.toMatch(/^\.tyrian-companion-view \{/mu);
	});
});
