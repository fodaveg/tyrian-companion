import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import { ManagedAssetsRuntime } from './runtime/managed-assets-runtime';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';

/**
 * DE-01, step 3g: the core's side of `ManagedAssetsRuntime`. Each delegate of the core reaches the
 * runtime once, with the caller's arguments, and answers what the runtime answers; the port reads the
 * core's fields as they stand and writes the row's view back to the core's own field.
 */
type Delegate = Exclude<keyof ManagedAssetsRuntime, 'collectorMode' | 'notifyConsultMode'>;
type Core = Record<string, (...args: unknown[]) => unknown>;

const GUARD = () => true;
const OPTIONS = { createOutputFolder: true };
const PARENT = { id: 'parent' };
const ROWS: ReadonlyArray<readonly [core: string, runtime: Delegate, args: readonly unknown[]]> = [
	['managedAssetsSupported', 'managedAssetsSupported', []],
	['managedAssetsCanMove', 'managedAssetsCanMove', []],
	['hasManagedAssetsRoot', 'hasManagedAssetsRoot', []],
	['previewManagedAssets', 'previewManagedAssets', []],
	['applyManagedAssets', 'applyManagedAssets', [GUARD, OPTIONS]],
	['repairManagedAssets', 'repairManagedAssets', [OPTIONS]],
	['replaceUnownedManagedAssets', 'replaceUnownedManagedAssets', [['inventory-base'], OPTIONS]],
	['listUnownedManagedAssets', 'listUnownedManagedAssets', []],
	['relocateManagedAssets', 'relocateManagedAssets', [PARENT]],
	['removeManagedAssets', 'removeManagedAssets', []],
	['reconcileManagedAssetsRoot', 'reconcileManagedAssetsRoot', [PARENT]],
	['updateManagedAssetsAfterInventorySync', 'updateManagedAssetsAfterInventorySync', []],
	['updateManagedAssetsOnLoad', 'updateManagedAssetsOnLoad', []],
	['retryManagedAssetsReconciliation', 'retryManagedAssetsReconciliation', []],
	['getManagedAssetsView', 'getManagedAssetsView', []],
];

describe('the core hands the managed assets to ManagedAssetsRuntime', () => {
	let harness: RuntimeHarness | null = null;
	afterEach(() => { harness?.dispose(); harness = null; vi.restoreAllMocks(); });

	it.each(ROWS)('%s reaches ManagedAssetsRuntime.%s once, with its arguments, and answers what it answers', (name, target, args) => {
		harness = createRuntimeHarness();
		const answer = { sentinel: name };
		const reached = vi.spyOn(ManagedAssetsRuntime.prototype, target).mockImplementation((() => answer) as never);

		const got = (harness.core as unknown as Core)[name]!(...args);

		expect(reached).toHaveBeenCalledExactlyOnceWith(...args);
		expect(got).toBe(answer);
	});

	it('the delegates with a default pass it on: no options reach the runtime as an empty object', () => {
		harness = createRuntimeHarness();
		const apply = vi.spyOn(ManagedAssetsRuntime.prototype, 'applyManagedAssets').mockResolvedValue(undefined);
		const repair = vi.spyOn(ManagedAssetsRuntime.prototype, 'repairManagedAssets').mockResolvedValue(undefined);
		const core = harness.core as unknown as Core;

		void core.applyManagedAssets!();
		void core.repairManagedAssets!();

		expect(apply).toHaveBeenCalledExactlyOnceWith(undefined, {});
		expect(repair).toHaveBeenCalledExactlyOnceWith({});
	});

	it('the port reads the core\'s settings and host as they stand, and the row\'s view is the core\'s own field', async () => {
		harness = createRuntimeHarness();
		const own = harness.core as unknown as {
			settings: Record<string, unknown>;
			managedAssetsView: unknown;
			host: { capabilities?: Record<string, unknown> };
			settingTab: { refreshManagedAssetsRow(): void };
			localDebugActions: null;
		};
		own.localDebugActions = null;
		const refreshRow = vi.fn();
		own.settingTab = { refreshManagedAssetsRow: refreshRow };
		const core = harness.core as unknown as Core;
		own.host.capabilities = { ...own.host.capabilities, managedAssets: true, managedAssetsMove: true };
		own.settings = { ...own.settings, managedAssetsRoot: null, legacyManagedAssetsRoot: null };
		expect(core.hasManagedAssetsRoot!()).toBe(false);
		own.settings = { ...own.settings, managedAssetsRoot: 'Tyrian Companion' };
		expect(core.hasManagedAssetsRoot!()).toBe(true);
		own.host.capabilities = { ...own.host.capabilities, managedAssets: false };
		expect(core.managedAssetsSupported!()).toBe(false);

		// Not ready yet: the press is refused in the row, which is the core's own field, and the view comes back as a copy.
		own.host.capabilities = { ...own.host.capabilities, managedAssets: true };
		await core.previewManagedAssets!();
		expect(own.managedAssetsView).toMatchObject({ status: 'error', message: 'runtime_starting' });
		expect(refreshRow).toHaveBeenCalled();
		const view = core.getManagedAssetsView!() as { status: string };
		expect(view).toEqual(own.managedAssetsView);
		expect(view).not.toBe(own.managedAssetsView);
	});
});
