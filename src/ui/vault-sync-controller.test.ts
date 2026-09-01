import { describe, expect, it, vi } from 'vitest';

import type { InventoryVaultSyncPlan, InventoryVaultSyncResult } from '../inventory/inventory-vault-sync';
import type { WalletVaultSyncPlan, WalletVaultSyncResult } from '../wallet/wallet-vault-sync';
import { InventoryVaultSyncController } from './inventory-vault-sync-controller';
import type {
	VaultSyncController,
	VaultSyncControllerPorts,
	VaultSyncPlanShape,
	VaultSyncResultShape,
	VaultSyncStepStatus,
	VaultSyncViewState,
} from './vault-sync-controller';
import { WalletVaultSyncController } from './wallet-vault-sync-controller';

/**
 * Every scenario below is written once and executed against both domain bindings, so a fix
 * to the staleness guard, to the error mapping or to the disposal semantics can no longer
 * land in one controller and miss the other.
 */
interface VaultSyncBinding<Plan extends VaultSyncPlanShape, Result extends VaultSyncResultShape> {
	readonly domain: string;
	readonly planWith: (statuses: readonly VaultSyncStepStatus[], canApply?: boolean) => Plan;
	readonly results: {
		readonly applied: Result;
		readonly conflict: Result;
		readonly invalid: Result;
		readonly unavailable: Result;
	};
	readonly create: (ports: VaultSyncControllerPorts<Plan, Result>) => VaultSyncController<Plan, Result>;
}

const walletBinding: VaultSyncBinding<WalletVaultSyncPlan, WalletVaultSyncResult> = {
	domain: 'wallet',
	planWith: (statuses, canApply = !statuses.includes('conflict')) => ({
		schemaVersion: 1,
		root: 'Tyrian Companion',
		capturedAt: '2026-08-25T08:00:00.000Z',
		positions: statuses.length,
		canApply,
		steps: statuses.map((status, index) => ({
			currencyId: index + 1,
			path: `Tyrian Companion/Wallet/Currencies/${String(index + 1)}.md`,
			status,
			before: status === 'create' ? null : `before-${String(index)}`,
			after: status === 'conflict' ? null : `after-${String(index)}`,
		})),
	}),
	results: {
		applied: { status: 'applied', created: 1, updated: 0, deactivated: 0 },
		conflict: { status: 'conflict', message: 'note changed outside the plugin' },
		invalid: { status: 'invalid', message: 'plan no longer matches the Vault' },
		unavailable: { status: 'unavailable', message: 'writer unavailable' },
	},
	create: (ports) => new WalletVaultSyncController(ports),
};

const inventoryBinding: VaultSyncBinding<InventoryVaultSyncPlan, InventoryVaultSyncResult> = {
	domain: 'inventory',
	planWith: (statuses, canApply = !statuses.includes('conflict')) => ({
		schemaVersion: 1,
		root: 'Tyrian Companion',
		capturedAt: '2026-08-25T08:00:00.000Z',
		positions: statuses.length,
		canApply,
		steps: statuses.map((status, index) => ({
			positionId: `${String(index + 1)}-b-account`,
			path: `Tyrian Companion/Inventory/Positions/${String(index + 1)}-b-account.md`,
			status,
			before: status === 'create' ? null : `before-${String(index)}`,
			after: status === 'conflict' ? null : `after-${String(index)}`,
		})),
	}),
	results: {
		applied: { status: 'applied', created: 1, updated: 0, deactivated: 0 },
		conflict: { status: 'conflict', message: 'note changed outside the plugin' },
		invalid: { status: 'invalid', message: 'plan no longer matches the Vault' },
		unavailable: { status: 'unavailable', message: 'writer unavailable' },
	},
	create: (ports) => new InventoryVaultSyncController(ports),
};

function describeSharedVaultSyncMachine<Plan extends VaultSyncPlanShape, Result extends VaultSyncResultShape>(
	binding: VaultSyncBinding<Plan, Result>,
): void {
	describe(`shared Vault sync machine, ${binding.domain} binding`, () => {
		it('drops a preview that resolves after an invalidation', async () => {
			const pending = deferred<Plan>();
			const controller = binding.create({
				disabledReason: () => null,
				preview: () => pending.promise,
				apply: async () => binding.results.applied,
			});
			const settled = controller.preview();
			controller.invalidate();
			pending.resolve(binding.planWith(['create']));
			await expect(settled).resolves.toEqual({ status: 'idle' });
			expect(controller.current()).toEqual({ status: 'idle' });
			expect(controller.canApply()).toBe(false);
		});

		it('drops an apply that resolves after an invalidation', async () => {
			const applying = deferred<Result>();
			const controller = binding.create({
				disabledReason: () => null,
				preview: async () => binding.planWith(['create']),
				apply: () => applying.promise,
			});
			await controller.preview();
			const settled = controller.apply();
			controller.invalidate();
			applying.resolve(binding.results.applied);
			await expect(settled).resolves.toEqual({ status: 'idle' });
			expect(controller.current()).toEqual({ status: 'idle' });
		});

		it('maps a failed capture to capture_unavailable', async () => {
			const controller = binding.create({
				disabledReason: () => null,
				preview: () => Promise.reject(new Error('capture down')),
				apply: async () => binding.results.applied,
			});
			await expect(controller.preview()).resolves.toEqual({ status: 'error', reason: 'capture_unavailable' });
		});

		it('maps an unavailable writer to write_unavailable and a thrown writer to unexpected_failure', async () => {
			const unavailable = binding.create({
				disabledReason: () => null,
				preview: async () => binding.planWith(['create']),
				apply: async () => binding.results.unavailable,
			});
			await unavailable.preview();
			await expect(unavailable.apply()).resolves.toEqual({ status: 'error', reason: 'write_unavailable' });

			const thrown = binding.create({
				disabledReason: () => null,
				preview: async () => binding.planWith(['create']),
				apply: () => Promise.reject(new Error('writer exploded')),
			});
			await thrown.preview();
			await expect(thrown.apply()).resolves.toEqual({ status: 'error', reason: 'unexpected_failure' });
		});

		it.each(['conflict', 'invalid'] as const)('maps a %s writer result to the conflict state', async (outcome) => {
			const controller = binding.create({
				disabledReason: () => null,
				preview: async () => binding.planWith(['create']),
				apply: async () => binding.results[outcome],
			});
			await controller.preview();
			await expect(controller.apply()).resolves.toEqual({
				status: 'conflict',
				summary: { positions: 1, create: 1, update: 0, unchanged: 0, deactivate: 0, conflicts: 0 },
			});
		});

		it('stops touching ports once disposed and reports unsafe_root', async () => {
			const preview = vi.fn(async () => binding.planWith(['create']));
			const apply = vi.fn(async () => binding.results.applied);
			const controller = binding.create({ disabledReason: () => null, preview, apply });
			await controller.preview();
			controller.dispose();
			expect(controller.current()).toEqual({ status: 'disabled', reason: 'unsafe_root' });
			await expect(controller.preview()).resolves.toEqual({ status: 'disabled', reason: 'unsafe_root' });
			await expect(controller.apply()).resolves.toEqual({ status: 'disabled', reason: 'unsafe_root' });
			expect(controller.canApply()).toBe(false);
			expect(preview).toHaveBeenCalledOnce();
			expect(apply).not.toHaveBeenCalled();
		});

		it('hands out a detached copy of the state on every read', async () => {
			const controller = binding.create({
				disabledReason: () => null,
				preview: async () => binding.planWith(['create']),
				apply: async () => binding.results.applied,
			});
			await controller.preview();
			const first = controller.current();
			const second = controller.current();
			expect(first).toEqual(second);
			expect(first).not.toBe(second);
		});
	});
}

/** Drives one binding through the full lifecycle and records what an observer would render. */
async function traceOf<Plan extends VaultSyncPlanShape, Result extends VaultSyncResultShape>(
	binding: VaultSyncBinding<Plan, Result>,
): Promise<VaultSyncViewState<Result>[]> {
	const controller = binding.create({
		disabledReason: () => null,
		preview: async () => binding.planWith(['create', 'update', 'unchanged', 'deactivate']),
		apply: async () => binding.results.applied,
	});
	const trace = [controller.current(), await controller.preview(), await controller.apply()];
	controller.invalidate();
	trace.push(controller.current());
	controller.dispose();
	trace.push(controller.current());
	return trace;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describeSharedVaultSyncMachine(walletBinding);
describeSharedVaultSyncMachine(inventoryBinding);

describe('Vault sync domains share one machine', () => {
	it('projects the identical lifecycle for wallet and inventory', async () => {
		const wallet = await traceOf(walletBinding);
		const inventory = await traceOf(inventoryBinding);
		expect(wallet).toEqual(inventory);
		expect(wallet).toEqual([
			{ status: 'idle' },
			{ status: 'preview', summary: { positions: 4, create: 1, update: 1, unchanged: 1, deactivate: 1, conflicts: 0 } },
			{
				status: 'success',
				summary: { positions: 4, create: 1, update: 1, unchanged: 1, deactivate: 1, conflicts: 0 },
				result: { status: 'applied', created: 1, updated: 0, deactivated: 0 },
			},
			{ status: 'idle' },
			{ status: 'disabled', reason: 'unsafe_root' },
		]);
	});
});
