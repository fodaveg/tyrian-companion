import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('product action architecture', () => {
	it('registers the palette once from the same controller rendered by all three surfaces', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		const companion = readFileSync('src/ui/companion-view.ts', 'utf8');
		const inventory = readFileSync('src/ui/inventory-advisor-item-view.ts', 'utf8');
		const settings = readFileSync('src/ui/settings-tab.ts', 'utf8');
		const panel = readFileSync('src/ui/product-shell.ts', 'utf8');
		expect(main.match(/registerProductActionPalette\(/gu)).toHaveLength(1);
		expect(main).toContain('sessionCommands: this.sessionCommands');
		expect(main).toContain('execute: (id) => this.executeProductAction');
		for (const surface of [companion, inventory, settings]) {
			expect(surface).toContain('renderProductShell(');
			expect(surface).toContain('getProductActionController');
		}
		expect(panel).toContain("button.addEventListener('click', () => { void controller.run(action.id).catch(() => undefined); });");
		expect(panel).toContain("createEl('aside', { cls: 'tyrian-action-panel' })");
		const setup = main.slice(main.indexOf('private setupProductActions()'), main.indexOf('\n\tprivate async executeProductAction'));
		expect(setup).not.toContain('renderViews()');
		expect(setup).not.toContain('renderInventoryAdvisorViews()');
		expect(setup).not.toContain('refreshForSettingsChange()');
		const companionRefresh = main.slice(main.indexOf('private renderViews()'), main.indexOf('\n\tprivate renderInventoryAdvisorViews()'));
		const inventoryRefresh = main.slice(main.indexOf('private renderInventoryAdvisorViews()'), main.indexOf('\n\tprivate invalidateInventoryAdvisor()'));
		expect(companionRefresh).toContain('this.productActions?.refresh();');
		expect(inventoryRefresh).toContain('this.productActions?.refresh();');
	});

	it('keeps responsive, focus, reduced-motion, and 44px contracts in the product stylesheet', () => {
		const styles = readFileSync('styles.css', 'utf8');
		expect(styles).toContain('@container (max-width: 1049px)');
		expect(styles).toContain('@container (max-width: 599px)');
		expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
		expect(styles).toContain('grid-template-areas: "actions" "content"');
		expect(styles).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
		expect(styles).toMatch(/@container \(max-width: 599px\)[\s\S]*?tyrian-action-panel__list[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/u);
		expect(styles).toMatch(/tyrian-action-panel__action button[\s\S]*?min-height:\s*44px/u);
		expect(styles).toContain('.tyrian-product-shell button:focus-visible');
	});
});
