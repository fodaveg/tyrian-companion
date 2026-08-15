import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createInventoryAdvisorCommandCallbacks } from '../main';

describe('H5.11 Inventory Advisor runtime integration', () => {
	it('registers separate open and explicit refresh commands without polling or on-load capture', () => {
		const source = readFileSync('src/main.ts', 'utf8');
		expect(source).toContain("id: 'open-inventory-advisor'");
		expect(source).toContain('const inventoryAdvisorCommands = this.inventoryAdvisorCommandCallbacks()');
		expect(source).toContain('callback: inventoryAdvisorCommands.open');
		expect(source).toContain("id: 'refresh-inventory-advisor'");
		expect(source).toContain('callback: inventoryAdvisorCommands.refresh');
		const onload = inventoryAdvisorOnloadSource(source);
		expect(inventoryAdvisorOnloadSafe(source)).toBe(true);
		expect(onload).not.toMatch(/setInterval[^\n]*inventory|inventory[^\n]*setInterval/iu);
		const genericRender = source.slice(source.indexOf('\n\tprivate renderViews()'), source.indexOf('\n\tprivate renderInventoryAdvisorViews()'));
		expect(genericRender).not.toContain('renderInventoryAdvisorViews');
	});

	it('wires the exact built-in review-only provider instead of an unavailable production stub', () => {
		const source = readFileSync('src/main.ts', 'utf8');
		const runtime = source.slice(source.indexOf('function createInventoryAdvisorRuntime('), source.indexOf('\nfunction managedAssetsFailureCode('));
		expect(runtime).toContain('createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider)');
		expect(runtime).toContain('capture: async (captureLocale, expectedPriceItemIds) =>');
		expect(runtime).toContain('inventoryEvidence.capture(captureLocale, expectedPriceItemIds)');
		expect(runtime).not.toContain("rules: { current: () => ({ status: 'unavailable' }) }");
	});

	it.each([
		'this.refreshInventoryAdvisor()',
		'this.inventoryAdvisor.refresh()',
		'inventoryAdvisor.refresh()',
		'inventoryWorkflow.refresh("es")',
		'inventoryEvidence.capture("es")',
		'capture.capture("es")',
		'InventoryAdvisorEvidenceService.capture("es")',
	])('turns red when onload is sabotaged with %s', (call) => {
		const source = readFileSync('src/main.ts', 'utf8');
		const sabotaged = source.replace('async onload(): Promise<void> {', `async onload(): Promise<void> {\n\t\t${call};`);
		expect(inventoryAdvisorOnloadSafe(sabotaged)).toBe(false);
	});

	it('keeps command open capture-free and maps one refresh command callback to one refresh', async () => {
		const open = vi.fn();
		const capture = vi.fn(async () => undefined);
		const callbacks = createInventoryAdvisorCommandCallbacks({ open, refresh: capture });
		callbacks.open();
		expect(open).toHaveBeenCalledOnce();
		expect(capture).not.toHaveBeenCalled();
		callbacks.refresh();
		await Promise.resolve();
		expect(capture).toHaveBeenCalledOnce();
	});

	it('keeps discard review warning-only and contains no game executor or destroy action', () => {
		const files = [
			'src/advisor/inventory-advisor-workflow.ts',
			'src/advisor/inventory-advisor-presentation.ts',
			'src/ui/inventory-advisor-controller.ts',
			'src/ui/inventory-advisor-item-view.ts',
			'src/ui/inventory-advisor-view.ts',
		];
		const source = files.map((path) => readFileSync(path, 'utf8')).join('\n');
		expect(source).not.toMatch(/\bdestroy\s*\(|\bexecutor\b|requestUrl|\.requestDetailed\s*\(/u);
		const uiSource = ['src/ui/inventory-advisor-item-view.ts', 'src/ui/inventory-advisor-view.ts']
			.map((path) => readFileSync(path, 'utf8')).join('\n');
		expect(uiSource).not.toMatch(/action\s*===?\s*['"]discard_candidate|value\s*===?\s*['"]discard_candidate/u);
		expect(source).toContain("presentationAction = decision.action === 'discard_candidate' ? 'discard_review'");
	});
});

function inventoryAdvisorOnloadSource(source: string): string {
	return source.slice(source.indexOf('async onload()'), source.indexOf('\n\tonunload()'));
}

function inventoryAdvisorOnloadSafe(source: string): boolean {
	const onload = inventoryAdvisorOnloadSource(source);
	return !/\bthis\.refreshInventoryAdvisor\s*\(|\b(?:this\.)?(?:inventoryAdvisor|inventoryWorkflow)\.refresh\s*\(|\b(?:this\.)?(?:inventoryEvidence|capture|InventoryAdvisorEvidenceService)\.capture\s*\(/u.test(onload);
}
