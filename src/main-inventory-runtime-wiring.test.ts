import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { InventoryRuntime } from './runtime/inventory-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3g: the core's side of `InventoryRuntime`. Each delegate of the core reaches the
 * runtime once, with the caller's arguments, and answers what the runtime answered; the port reads
 * and publishes the core's fields as they stand.
 */
type Delegate = Exclude<keyof InventoryRuntime, never>;
type Core = Record<string, (...args: unknown[]) => unknown>;

const GOAL = { id: 'goal-1' };
const KEEP = { id: 'keep-1' };
const ROWS: ReadonlyArray<readonly [core: string, runtime: Delegate, args: readonly unknown[]]> = [
	['getInventoryAdvisorViewModel', 'getInventoryAdvisorViewModel', []],
	['getInventoryPreferencesEditorState', 'getInventoryPreferencesEditorState', []],
	['createInventoryPreferencesEditorSession', 'createInventoryPreferencesEditorSession', []],
	['refreshInventoryAdvisor', 'refreshInventoryAdvisor', []],
	['getInventoryVaultSyncRunState', 'getInventoryVaultSyncRunState', []],
	['runInventoryVaultSync', 'runInventoryVaultSync', []],
	['confirmInventoryVaultSync', 'confirmInventoryVaultSync', []],
	['cancelInventoryVaultSync', 'cancelInventoryVaultSync', []],
	['previewInventoryVaultSync', 'previewInventoryVaultSync', [true]],
	['applyInventoryVaultSync', 'applyInventoryVaultSync', []],
	['getWalletVaultSyncState', 'getWalletVaultSyncState', []],
	['canApplyWalletVaultSync', 'canApplyWalletVaultSync', []],
	['previewWalletVaultSync', 'previewWalletVaultSync', []],
	['applyWalletVaultSync', 'applyWalletVaultSync', []],
	['loadInventoryPreferences', 'loadInventoryPreferences', []],
	['upsertInventoryGoal', 'upsertInventoryGoal', [GOAL]],
	['removeInventoryGoal', 'removeInventoryGoal', ['goal-1']],
	['upsertInventoryKeepException', 'upsertInventoryKeepException', [KEEP]],
	['removeInventoryKeepException', 'removeInventoryKeepException', ['keep-1']],
	['invalidateInventoryAdvisor', 'invalidateInventoryAdvisor', []],
];

const VOID_DELEGATES: ReadonlySet<string> = new Set(['cancelInventoryVaultSync', 'invalidateInventoryAdvisor']);

describe('the core hands the inventory to InventoryRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(ROWS)('%s reaches InventoryRuntime.%s once, with its arguments, and answers what it answers', (name, target, args) => {
		harness = createRuntimeHarness();
		const answer = { answered: name };
		const reached = vi.spyOn(InventoryRuntime.prototype, target).mockImplementation(() => answer as never);

		const result = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		// The two that return nothing, both `void` before the move too.
		if (!VOID_DELEGATES.has(name)) expect(result).toBe(answer);
	});

	it('answers the idle preferences and the empty advisor model before the runtime is ready', async () => {
		harness = createRuntimeHarness();
		const core = harness.core as unknown as Core;
		expect(core.getInventoryPreferencesEditorState!()).toEqual({ status: 'not_loaded', goals: [], keepExceptions: [] });
		expect(core.getInventoryAdvisorViewModel!()).toMatchObject({ status: 'loading' });
	});

	it('the port publishes the sync outcome into the core\'s own settings and saves it', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { settings: { inventorySyncLastRun: unknown }; inventory: InventoryRuntime };
		const outcome = {
			status: 'success', finishedAt: '2026-10-11T00:00:00.000Z', durationMs: 5, summary: null, error: null,
		};
		await own.inventory.recordInventorySyncOutcome(outcome as never);
		expect(own.settings.inventorySyncLastRun).toEqual(outcome);
		expect((harness.plugin as unknown as { saveData: ReturnType<typeof vi.fn> }).saveData).toHaveBeenCalledWith(expect.objectContaining({ inventorySyncLastRun: outcome }));
	});

	it('the port reads and writes the sync-analysis flag of the core', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as { inventoryAnalysisForSync: boolean; inventory: InventoryRuntime };
		let seen: boolean | null = null;
		vi.spyOn(InventoryRuntime.prototype, 'refreshInventoryAdvisor').mockImplementation(async () => {
			seen = own.inventoryAnalysisForSync;
		});
		await own.inventory.refreshInventoryAdvisorForSync(() => undefined, () => undefined);
		expect(seen).toBe(true);
		expect(own.inventoryAnalysisForSync).toBe(false);
	});
});
