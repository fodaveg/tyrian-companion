import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { InventoryAdvisorCaptureReceiptV1 } from '../advisor/inventory-advisor-evidence-model';
import type { InventoryAdvisorWorkflowResult } from '../advisor/inventory-advisor-workflow';
import TyrianCompanionPlugin, {
	createInventoryAdvisorCommandCallbacks,
	inventoryAdvisorWorkflowFailureReceipt,
	inventoryAdvisorWorkflowReceipt,
} from '../main';

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
		expect(source).toContain('new ObsidianRequestTransport({ timeoutMs: 30_000 })');
		expect(source).toContain('inventoryClient, inventoryPublicClient, inventorySnapshots,');
		const runtime = source.slice(source.indexOf('function createInventoryAdvisorRuntime('), source.indexOf('\nfunction managedAssetsFailureCode('));
		expect(runtime).toContain('createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider)');
		expect(runtime).toContain('capture: async (captureLocale, expectedPriceItemIds) =>');
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

	it('overwrites one local sanitized capture receipt without using plugin settings storage', async () => {
		const writes: Array<{ path: string; data: string }> = [];
		const harness: CaptureReceiptHarness = {
			app: { vault: { configDir: 'test-config-dir', adapter: {
				write: async (path, data) => { writes.push({ path, data }); },
			} } },
			manifest: { id: 'tyrian-companion' },
		};
		const receipt: InventoryAdvisorCaptureReceiptV1 = {
			version: 1,
			recordedAt: '2026-08-15T07:00:00.000Z',
			status: 'invalid',
			failure: 'snapshot_coverage_incomplete',
			evidenceCoverage: null,
			evidenceDetails: null,
			containerPrices: 'not_requested',
			workflow: null,
			snapshot: null,
		};
		const writeReceipt = (TyrianCompanionPlugin.prototype as unknown as {
			writeInventoryAdvisorCaptureReceipt(
				this: CaptureReceiptHarness,
				receipt: InventoryAdvisorCaptureReceiptV1,
			): Promise<void>;
		}).writeInventoryAdvisorCaptureReceipt.bind(harness);

		await writeReceipt(receipt);

		expect(writes).toEqual([{
			path: 'test-config-dir/plugins/tyrian-companion/inventory-advisor-capture-receipt.json',
			data: `${JSON.stringify(receipt, null, '\t')}\n`,
		}]);
		const mainSource = readFileSync('src/main.ts', 'utf8');
		const writer = mainSource.slice(
			mainSource.indexOf('private async writeInventoryAdvisorCaptureReceipt'),
			mainSource.indexOf('\n\tasync loadInventoryPreferences'),
		);
		expect(writer).not.toContain('saveData');
	});

	it('records workflow rows, default visibility, actions and reasons without item identity', () => {
		const result = {
			status: 'ready',
			source: { result: { status: 'limited', report: {
				lines: [{
					itemId: 99,
					name: 'Private item name',
					decisions: [{ action: 'sell' }, { action: 'review' }],
				}],
				explanations: [
					{ reasonCodes: ['price_partial'] },
					{ reasonCodes: ['price_partial', 'rule_missing'] },
				],
			} } },
		} as unknown as InventoryAdvisorWorkflowResult;

		const receipt = inventoryAdvisorWorkflowReceipt(result);

		expect(receipt).toEqual({
			status: 'ready',
			resultStatus: 'limited',
			lineCount: 1,
			decisionCount: 2,
			defaultVisibleDecisionCount: 1,
			actionCounts: [{ action: 'review', count: 1 }, { action: 'sell', count: 1 }],
			reasonCounts: [{ reason: 'price_partial', count: 2 }, { reason: 'rule_missing', count: 1 }],
		});
		expect(JSON.stringify(receipt)).not.toMatch(/Private item name|99/u);
	});

	it('always reduces a workflow rejection to a phase-local safe receipt', () => {
		expect(inventoryAdvisorWorkflowFailureReceipt(
			new Error('inventory_advisor_input_invalid'), 'classification', 12,
		)).toEqual({ status: 'failed', stage: 'classification', reason: 'input_invalid', elapsedMs: 12 });
		expect(inventoryAdvisorWorkflowFailureReceipt(
			new Error('secret account detail'), 'preferences', Number.NaN,
		)).toEqual({ status: 'failed', stage: 'preferences', reason: 'unexpected_failure', elapsedMs: 0 });
		expect(JSON.stringify(inventoryAdvisorWorkflowFailureReceipt(
			new Error('secret account detail'), 'preferences', 3,
		))).not.toContain('secret account detail');
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

interface CaptureReceiptHarness {
	app: { vault: { configDir: string; adapter: {
		write(path: string, data: string): Promise<void>;
	} } };
	manifest: { id: string };
}

function inventoryAdvisorOnloadSource(source: string): string {
	return source.slice(source.indexOf('async onload()'), source.indexOf('\n\tonunload()'));
}

function inventoryAdvisorOnloadSafe(source: string): boolean {
	const onload = inventoryAdvisorOnloadSource(source);
	return !/\bthis\.refreshInventoryAdvisor\s*\(|\b(?:this\.)?(?:inventoryAdvisor|inventoryWorkflow)\.refresh\s*\(|\b(?:this\.)?(?:inventoryEvidence|capture|InventoryAdvisorEvidenceService)\.capture\s*\(/u.test(onload);
}
