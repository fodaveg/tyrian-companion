import { describe, expect, it } from 'vitest';

import { classMethodBody, forbiddenBoundaryUses, type ModuleBoundary, readModuleSource } from '../test/module-boundary';

// Source-text half of `inventory-advisor-integration-architecture.test.ts` (GR-04): reads module source
// as text, so it sits in the frozen allowlist and runs only under `vitest.guardrails.config.mts`. The
// behavioural tests (command callbacks, capture receipt, workflow receipts) stay in the other file.
describe('H5.11 Inventory Advisor runtime integration (source text)', () => {
	it('registers separate open and explicit refresh commands without polling or on-load capture', () => {
		const source = readModuleSource('src/runtime/tyrian-companion-core.ts');
		const actionSource = readModuleSource('src/ui/product-action-controller.ts');
		expect(actionSource).toContain("'open-inventory-advisor',");
		expect(actionSource).toContain("'refresh-inventory-advisor',");
		// H18.32 review fix (26 sep 2026): a third open-* surface (Venta) joined open-companion and
		// open-inventory-advisor, and L2 (0.6.30) a fourth (Logros). The property this whole test
		// protects — opening a surface only navigates, an explicit refresh is the one thing that
		// captures — has to hold for each of them, so this asserts the full four-way state/navigate
		// mapping, not just the two-way one that predates it.
		expect(source).toContain("id === 'open-companion' || id === 'open-inventory-advisor' || id === 'open-sale' || id === 'open-achievements'");
		expect(source).toContain(
			"const state = id === 'open-companion' ? 'open_companion'\n"
			+ "\t\t\t\t: id === 'open-inventory-advisor' ? 'open_inventory_advisor'\n"
			+ "\t\t\t\t\t: id === 'open-sale' ? 'open_sale' : 'open_achievements';",
		);
		expect(source).toContain(
			"const navigate = id === 'open-companion' ? () => this.activateView()\n"
			+ "\t\t\t\t: id === 'open-inventory-advisor' ? () => this.activateInventoryAdvisorView()\n"
			+ "\t\t\t\t\t: id === 'open-sale' ? () => this.activateSaleView()\n"
			+ "\t\t\t\t\t\t: () => this.activateAchievementsView();",
		);
		expect(source).toContain("else if (id === 'refresh-inventory-advisor') await this.refreshInventoryAdvisor();");
		expect(source).toContain('registerProductActionPalette(');
		const onload = inventoryAdvisorOnloadSource(source);
		expect(inventoryAdvisorOnloadSafe(source)).toBe(true);
		expect(onload).not.toMatch(/setInterval[^\n]*inventory|inventory[^\n]*setInterval/iu);
		expect(classMethodBody(source, 'TyrianCompanionCore', 'renderViews')).not.toContain('renderInventoryAdvisorViews');
	});

	it('wires the exact built-in review-only provider instead of an unavailable production stub', () => {
		const source = readModuleSource('src/runtime/tyrian-companion-core.ts');
		expect(source).toMatch(/const inventoryTransport = new HostRequestTransport\(host\.http, \{[\s\S]*?timeoutMs: 30_000,[\s\S]*?diagnostics: this\.localDebugActions \?\? undefined,[\s\S]*?\}\);/u);
		expect(source.match(/operationPolicies: GW2_CHARACTER_OPERATION_POLICIES/gu)).toHaveLength(2);
		// The advisor stack gets the inventory-scoped client, catalog and snapshots, never the
		// session ones: its 30 s timeout and its own rate-limit share are the reason they exist.
		expect(source).toContain('client: inventoryClient,');
		expect(source).toContain('publicClient: inventoryPublicClient,');
		expect(source).toContain('snapshots: inventorySnapshots,');
		const runtime = readModuleSource('src/runtime/assemble-advisor.ts');
		expect(runtime).toContain('inventoryAdvisorBuiltinBundleProvider, personalValuation, materialStorageCapacity,');
		expect(source).toContain('() => this.settings.halloweenPersonalValuation');
		expect(runtime).toContain('capture: async (captureLocale, expectedPriceItemIds, _onProgress, actionContext) =>');
		expect(runtime).toContain('inventoryEvidence.capture(captureLocale, expectedPriceItemIds, (progress) => {');
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
		const source = readModuleSource('src/runtime/tyrian-companion-core.ts');
		const sabotaged = source.replace('async onload(): Promise<void> {', `async onload(): Promise<void> {\n\t\t${call};`);
		expect(inventoryAdvisorOnloadSafe(sabotaged)).toBe(false);
	});

	it('keeps discard review warning-only and contains no game executor or destroy action', () => {
		const files = [
			'src/advisor/inventory-advisor-workflow.ts',
			'src/advisor/inventory-advisor-presentation.ts',
			'src/ui/inventory-advisor-controller.ts',
			'src/ui/inventory-advisor-item-view.ts',
			'src/ui/inventory-advisor-view.ts',
		];
		for (const path of files) {
			const boundary: ModuleBoundary = {
				path,
				forbiddenImports: [],
				forbiddenNames: ['destroy', 'executor', 'requestUrl', 'requestDetailed'],
			};
			expect(forbiddenBoundaryUses(readModuleSource(path), boundary)).toEqual([]);
		}
		// The UI surfaces only ever receive the already-mapped `discard_review` presentation action;
		// the raw `discard_candidate` decision is a fact for the mapper below, not for a UI branch.
		for (const path of ['src/ui/inventory-advisor-item-view.ts', 'src/ui/inventory-advisor-view.ts']) {
			const boundary: ModuleBoundary = { path, forbiddenImports: [], forbiddenNames: ['discard_candidate'] };
			expect(forbiddenBoundaryUses(readModuleSource(path), boundary)).toEqual([]);
		}
		expect(readModuleSource('src/advisor/inventory-advisor-presentation.ts'))
			.toContain("presentationAction = decision.action === 'discard_candidate' ? 'discard_review'");
	});

	// Split out of 'overwrites one local sanitized capture receipt...' (GR-04): the write itself is checked
	// by behaviour in the architecture file; only this last assertion reads source text.
	it('keeps the capture receipt writer off plugin settings storage', () => {
		const mainSource = readModuleSource('src/runtime/tyrian-companion-core.ts');
		const writer = classMethodBody(mainSource, 'TyrianCompanionCore', 'writeInventoryAdvisorCaptureReceipt');
		expect(writer).not.toContain('saveData');
	});
});

function inventoryAdvisorOnloadSource(source: string): string {
	return source.slice(source.indexOf('async onload()'), source.indexOf('\n\tonunload()'));
}

function inventoryAdvisorOnloadSafe(source: string): boolean {
	const onload = inventoryAdvisorOnloadSource(source);
	return !/\bthis\.refreshInventoryAdvisor\s*\(|\b(?:this\.)?(?:inventoryAdvisor|inventoryWorkflow)\.refresh\s*\(|\b(?:this\.)?(?:inventoryEvidence|capture|InventoryAdvisorEvidenceService)\.capture\s*\(/u.test(onload);
}
