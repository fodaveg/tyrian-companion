import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import type { InventoryAdvisorCaptureReceiptV1 } from '../advisor/inventory-advisor-evidence-model';
import type { InventoryAdvisorWorkflowResult } from '../advisor/inventory-advisor-workflow';
import { TyrianCompanionCore, createInventoryAdvisorCommandCallbacks } from '../runtime/tyrian-companion-core';
import {
	inventoryAdvisorWorkflowFailureReceipt,
	inventoryAdvisorWorkflowReceipt,
} from '../runtime/assemble-advisor';
import { withObsidianHost } from '../test/obsidian-host-harness';

describe('H5.11 Inventory Advisor runtime integration', () => {
	it('keeps command open capture-free and maps one refresh command callback to one refresh', async () => {
		const open = vi.fn();
		const capture = vi.fn(async () => undefined);
		const callbacks = createInventoryAdvisorCommandCallbacks({ open, refresh: capture });
		callbacks.open();
		await Promise.resolve();
		expect(open).toHaveBeenCalledOnce();
		expect(capture).not.toHaveBeenCalled();
		callbacks.refresh();
		await Promise.resolve();
		expect(capture).toHaveBeenCalledOnce();
	});

	it('overwrites one local sanitized capture receipt without using plugin settings storage', async () => {
		const writes: Array<{ path: string; data: string }> = [];
		// The receipt goes through the real `ObsidianHost` (vault adapter, plugin id) over these fakes.
		const harness: CaptureReceiptHarness = withObsidianHost({
			app: { vault: { configDir: 'test-config-dir', adapter: {
				write: async (path: string, data: string) => { writes.push({ path, data }); },
			} } },
			manifest: { id: 'tyrian-companion' },
		});
		const receipt: InventoryAdvisorCaptureReceiptV1 = {
			version: 1,
			recordedAt: '2026-08-15T07:00:00.000Z',
			status: 'invalid',
			failure: 'snapshot_coverage_incomplete',
			evidenceCoverage: null,
			evidenceDetails: null,
			containerPrices: 'not_requested',
			workflow: null,
			timings: null,
			snapshot: null,
		};
		const writeReceipt = (TyrianCompanionCore.prototype as unknown as {
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
});

interface CaptureReceiptHarness {
	app: { vault: { configDir: string; adapter: {
		write(path: string, data: string): Promise<void>;
	} } };
	manifest: { id: string };
}
