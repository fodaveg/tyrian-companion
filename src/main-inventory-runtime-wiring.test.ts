import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

// What `initializeRuntime` hands the services it builds, recorded while the real ones still run.
const built = vi.hoisted(() => ({
	advisor: [] as unknown[],
	oneClick: [] as unknown[][],
	manual: [] as unknown[][],
}));
vi.mock('./runtime/assemble-advisor', async (importOriginal) => {
	const original = await importOriginal<typeof import('./runtime/assemble-advisor')>();
	return { ...original, assembleAdvisor: (input: Parameters<typeof original.assembleAdvisor>[0]) => { built.advisor.push(input); return original.assembleAdvisor(input); } };
});
vi.mock('./ui/inventory-vault-sync-run-controller', async (importOriginal) => {
	const original = await importOriginal<typeof import('./ui/inventory-vault-sync-run-controller')>();
	class Recording extends original.InventoryVaultOneClickSyncController {
		constructor(...args: ConstructorParameters<typeof original.InventoryVaultOneClickSyncController>) { super(...args); built.oneClick.push(args); }
	}
	return { ...original, InventoryVaultOneClickSyncController: Recording };
});
vi.mock('./ui/inventory-vault-sync-controller', async (importOriginal) => {
	const original = await importOriginal<typeof import('./ui/inventory-vault-sync-controller')>();
	class Recording extends original.InventoryVaultSyncController {
		constructor(...args: ConstructorParameters<typeof original.InventoryVaultSyncController>) { super(...args); built.manual.push(args); }
	}
	return { ...original, InventoryVaultSyncController: Recording };
});

import { InventoryRuntime } from './runtime/inventory-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3g: the core's side of `InventoryRuntime`. Each delegate of the core reaches the
 * runtime once, with the caller's arguments, and answers what the runtime answered; the port reads
 * and publishes the core's fields as they stand.
 */
type Delegate = keyof InventoryRuntime;
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

	describe('the closures initializeRuntime builds reach InventoryRuntime', () => {
		type OneClickDeps = { refreshAdvisor(onPhase: unknown, onProgress: unknown): Promise<void> };
		type AdvisorInput = {
			writeCaptureReceipt(receipt: unknown): unknown;
			preferencesBackup: { settings: { write(backup: unknown, final: boolean): Promise<unknown> } };
		};

		async function initialized(): Promise<void> {
			built.advisor.length = 0; built.oneClick.length = 0; built.manual.length = 0;
			harness = createRuntimeHarness();
			const setup = harness.core as unknown as {
				localDebugActions: null;
				settingTab: { refreshConnectionRow(): void; refreshForSettingsChange(): void };
			};
			// The harness's recording port predates `fireAndForget`; without a port the boot runs those actions directly.
			setup.localDebugActions = null;
			setup.settingTab = { refreshConnectionRow: () => undefined, refreshForSettingsChange: () => undefined };
			// A configured key is what makes this device a collector.
			harness.core.settings = { ...harness.core.settings, apiKeySecret: 'tyrian-test-key', language: 'es' };
			await harness.initializeRuntime();
		}

		it('the one-click sync refreshes the advisor through refreshInventoryAdvisorForSync', async () => {
			await initialized();
			const reached = vi.spyOn(InventoryRuntime.prototype, 'refreshInventoryAdvisorForSync').mockResolvedValue(undefined);
			const [deps] = built.oneClick.at(-1) as [OneClickDeps];
			const onPhase = () => undefined;
			const onProgress = () => undefined;
			await deps.refreshAdvisor(onPhase, onProgress);
			expect(reached).toHaveBeenCalledExactlyOnceWith(onPhase, onProgress);
		});

		it('the one-click sync records its outcome through recordInventorySyncOutcome', async () => {
			await initialized();
			const reached = vi.spyOn(InventoryRuntime.prototype, 'recordInventorySyncOutcome').mockResolvedValue(undefined);
			const onOutcome = (built.oneClick.at(-1) as unknown[])[3] as (outcome: unknown) => void;
			const outcome = { status: 'success' };
			onOutcome(outcome);
			await Promise.resolve();
			expect(reached).toHaveBeenCalledExactlyOnceWith(outcome);
		});

		it('the manual preview reads the notes\' analysis through inventoryAnalysisForNotes', async () => {
			await initialized();
			const reached = vi.spyOn(InventoryRuntime.prototype, 'inventoryAnalysisForNotes').mockRejectedValue(new Error('reached'));
			const [deps] = built.manual.at(-1) as [{ preview(): Promise<unknown> }];
			await expect(deps.preview()).rejects.toThrow('reached');
			expect(reached).toHaveBeenCalledOnce();
		});

		it('the advisor writes its receipt and the preferences copy through the facade', async () => {
			await initialized();
			const receipt = vi.spyOn(InventoryRuntime.prototype, 'writeInventoryAdvisorCaptureReceipt').mockResolvedValue(undefined);
			const backup = vi.spyOn(InventoryRuntime.prototype, 'writeInventoryPreferencesBackup').mockResolvedValue('saved');
			const input = built.advisor.at(-1) as AdvisorInput;
			const receiptValue = { version: 1 };
			await input.writeCaptureReceipt(receiptValue);
			const copy = { version: 1 };
			await input.preferencesBackup.settings.write(copy, true);
			expect(receipt).toHaveBeenCalledExactlyOnceWith(receiptValue);
			expect(backup).toHaveBeenCalledExactlyOnceWith(copy, true);
		});
	});
});
