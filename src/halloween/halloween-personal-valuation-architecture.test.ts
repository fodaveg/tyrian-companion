import { describe, expect, it } from 'vitest';

import { moduleSpecifiers, readModuleSource } from '../test/module-boundary';

describe('H11.6 personal Halloween valuation architecture', () => {
	it('keeps resolution pure and free of storage, network, Vault and plugin capabilities', () => {
		const source = readModuleSource('src/economy/container-personal-valuation.ts');
		expect(moduleSpecifiers(source)).toEqual(['./container-model']);
		expect(source).not.toMatch(/obsidian|vault\.|indexedDB|localStorage|fetch\(|requestDetailed|setTimeout|setInterval/u);
		expect(source).toContain('BigInt(outcome.expectedUnitsMillionths) * BigInt(entry.unitCopper)');
		expect(source).toContain("totalAdjustment: coverage === 'complete' ? knownAdjustment : null");
	});

	it('wires a dynamic settings overlay into memory-only reclassification without coupling it to Halloween opt-in', () => {
		const settings = readModuleSource('src/core/settings.ts');
		const settingsTab = readModuleSource('src/ui/settings-tab.ts');
		const main = readModuleSource('src/runtime/tyrian-companion-core.ts');
		expect(settings).toContain('SETTINGS_SCHEMA_VERSION = 16');
		expect(settings).toContain('halloweenPersonalValuation: { version: 1 as const, values: [] }');
		// 6 oct 2026: the page lost this row (presentation only); the saved overlay still feeds the
		// advisor through the settings key and the wiring asserted below.
		expect(settingsTab).not.toMatch(/halloween\.personal|HalloweenPersonalValuationSettings/u);
		expect(readModuleSource('src/runtime/assemble-advisor.ts'))
			.toContain('inventoryAdvisorBuiltinBundleProvider, personalValuation, materialStorageCapacity,');
		expect(main).toContain('personalValuation: () => this.settings.halloweenPersonalValuation');
		// R1a: `saveData` is reached through the host's settings port (`ObsidianHost.settings.save`).
		expect(main).toMatch(/previousPersonalValuation[\s\S]*settings\.save\(nextSettings\)[\s\S]*this\.settings = nextSettings[\s\S]*inventoryAdvisor\.reclassify\([^)]*\)/u);
	});

	it('covers the seven UI axes and makes no asset or contrast claim', () => {
		const component = readModuleSource('src/ui/halloween-personal-valuation-settings.ts');
		const tests = readModuleSource('src/ui/halloween-personal-valuation-settings.test.ts');
		const styles = readModuleSource('styles.css');
		const locale = readModuleSource('src/core/i18n-runtime-catalog.ts');
		const start = styles.indexOf('.tyrian-personal-valuation-setting');
		const end = styles.indexOf('.tyrian-companion-review fieldset', start);
		const personalStyles = styles.slice(start, end);
		// Tokens.
		expect(personalStyles).toMatch(/var\(--/u);
		expect(personalStyles).not.toMatch(/#[0-9a-f]{3,8}/iu);
		// Empty, zero, valid, invalid, saving and removed states.
		for (const state of ['empty', 'invalid', 'saving', 'saved_reclassified', 'saved_next_refresh',
			'removed_reclassified', 'removed_next_refresh']) expect(component + locale).toContain(state);
		expect(tests).toContain("unitCopper: 0");
		// Responsive behavior belongs to the component at 320/480/760.
		for (const width of [320, 480, 760]) expect(personalStyles).toContain(`@container (max-width: ${String(width)}px)`);
		// Accessible labels, alerts, focus and 44px targets.
		expect(component).toContain("setAttribute('aria-label'");
		expect(component).toContain("setAttribute('role', 'alert')");
		expect(component).toContain('input.focus()');
		expect(personalStyles).toContain('min-block-size: 44px');
		// Real long labels, large values, ten rows and explicit feedback are covered in DOM tests. Assets are N/A.
		expect(tests).toContain('toHaveLength(10)');
		expect(tests).toContain('Number.MAX_SAFE_INTEGER');
		expect(component).toContain("this.inputs.get(outcomeKey)?.focus()");
		expect(component).toContain("'saved_next_refresh'");
		expect(component + personalStyles).not.toMatch(/<img|createElement\('img'\)|\.svg|\.png|contrast (?:passes|verified)/iu);
	});

	it('documents the product, architecture and residual-risk contracts', () => {
		for (const file of ['docs/ARCHITECTURE.md', 'docs/PRODUCT.md', 'docs/THREAT-MODEL.md']) {
			expect(readModuleSource(file)).toContain('H11.6');
		}
	});
});
