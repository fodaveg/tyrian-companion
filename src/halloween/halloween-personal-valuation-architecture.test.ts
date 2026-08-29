import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
import { sha256StandardCanonicalValue } from '../advisor/inventory-advisor-contract';
import { halloweenTrickOrTreatBagModel } from '../economy/models/halloween-trick-or-treat-bag';
import { moduleSpecifiers } from '../test/module-boundary';

describe('H11.6 personal Halloween valuation architecture', () => {
	it('keeps the manual overlay outside the curated model, economy pack and fingerprints', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load('2026-08-16T05:23:00.000Z');
		if (loaded.status !== 'available') throw new Error('Expected built-in bundle.');
		const model = halloweenTrickOrTreatBagModel();
		expect(loaded.bundle.economyPack.modelFingerprint).toBe(
			'7501839c02bbbcf5e07e6fe662d1ae3ceaf5e6b5a423f9d6a09432b1ab524fc1',
		);
		expect(loaded.bundle.economyPack.modelFingerprint).toBe(sha256StandardCanonicalValue(model));
		expect(loaded.bundle.economyPack.sha256).toBe(
			'ba445d034b605d9c5db6219c1a8a689f334a62816aed75ba70b2f17d99dc0f5f',
		);
		expect(JSON.stringify(model)).not.toContain('personalValuation');
		expect(JSON.stringify(loaded.bundle.economyPack)).not.toContain('personalValuation');
	});

	it('keeps resolution pure and free of storage, network, Vault and plugin capabilities', () => {
		const source = readFileSync('src/economy/container-personal-valuation.ts', 'utf8');
		expect(moduleSpecifiers(source)).toEqual(['./container-model']);
		expect(source).not.toMatch(/obsidian|vault\.|indexedDB|localStorage|fetch\(|requestDetailed|setTimeout|setInterval/u);
		expect(source).toContain('BigInt(outcome.expectedUnitsMillionths) * BigInt(entry.unitCopper)');
		expect(source).toContain("totalAdjustment: coverage === 'complete' ? knownAdjustment : null");
	});

	it('wires a dynamic settings overlay into memory-only reclassification without coupling it to Halloween opt-in', () => {
		const settings = readFileSync('src/core/settings.ts', 'utf8');
		const settingsTab = readFileSync('src/ui/settings-tab.ts', 'utf8');
		const main = readFileSync('src/main.ts', 'utf8');
		expect(settings).toContain('SETTINGS_SCHEMA_VERSION = 8');
		expect(settings).toContain('halloweenPersonalValuation: { version: 1 as const, values: [] }');
		expect(settingsTab.indexOf("settings.halloween.personal.name")).toBeLessThan(
			settingsTab.indexOf("settings.halloween.enabled.name"),
		);
		expect(main).toContain('createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider, personalValuation)');
		expect(main).toMatch(/previousPersonalValuation[\s\S]*saveData\(this\.settings\)[\s\S]*inventoryAdvisor\.reclassify\(\)/u);
	});

	it('covers the seven UI axes and makes no asset or contrast claim', () => {
		const component = readFileSync('src/ui/halloween-personal-valuation-settings.ts', 'utf8');
		const tests = readFileSync('src/ui/halloween-personal-valuation-settings.test.ts', 'utf8');
		const styles = readFileSync('styles.css', 'utf8');
		const locale = readFileSync('src/core/i18n-runtime-catalog.ts', 'utf8');
		const start = styles.indexOf('.tyrian-personal-valuation-setting');
		const end = styles.indexOf('.tyrian-companion-review fieldset', start);
		const personalStyles = styles.slice(start, end);
		// Tokens.
		expect(personalStyles).toMatch(/var\(--/u);
		expect(personalStyles).not.toMatch(/#[0-9a-f]{3,8}/iu);
		// Empty, zero, valid, invalid, saving and removed states.
		for (const state of ['empty', 'invalid', 'saving', 'saved', 'removed']) expect(component + locale).toContain(state);
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
		expect(component).toContain("feedback.set(outcomeKey, unitCopper === null ? 'removed' : 'saved')");
		expect(component + personalStyles).not.toMatch(/<img|createElement\('img'\)|\.svg|\.png|contrast (?:passes|verified)/iu);
	});

	it('documents the product, architecture and residual-risk contracts', () => {
		for (const file of ['docs/ARCHITECTURE.md', 'docs/PRODUCT.md', 'docs/THREAT-MODEL.md']) {
			expect(readFileSync(file, 'utf8')).toContain('H11.6');
		}
	});
});
