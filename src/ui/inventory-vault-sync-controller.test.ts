/* eslint-disable @typescript-eslint/unbound-method -- Vitest spies intentionally occupy port method slots. */
import { describe, expect, it, vi } from 'vitest';

import type { InventoryVaultSyncPlan, InventoryVaultSyncResult } from '../inventory/inventory-vault-sync';
import {
	InventoryVaultSyncController,
	summarizeInventoryVaultSyncPlan,
	type InventoryVaultSyncControllerPorts,
} from './inventory-vault-sync-controller';

describe('inventory Vault sync controller', () => {
	it('opens and reads state without capturing or applying account data', () => {
		const ports = portsFor();
		const controller = new InventoryVaultSyncController(ports);
		expect(controller.current()).toEqual({ status: 'idle' });
		expect(ports.preview).not.toHaveBeenCalled();
		expect(ports.apply).not.toHaveBeenCalled();
	});

	it('enters loading only after explicit preview and exposes a closed summary', async () => {
		const pending = deferred<InventoryVaultSyncPlan>();
		const ports = portsFor({ preview: vi.fn(() => pending.promise) });
		const controller = new InventoryVaultSyncController(ports);
		const result = controller.preview();
		expect(controller.current()).toEqual({ status: 'loading' });
		expect(ports.preview).toHaveBeenCalledOnce();
		pending.resolve(planWith(['create', 'update', 'unchanged', 'deactivate']));
		await expect(result).resolves.toEqual({
			status: 'preview',
			summary: { positions: 4, create: 1, update: 1, unchanged: 1, deactivate: 1, conflicts: 0 },
		});
		expect(controller.canApply()).toBe(true);
	});

	it.each(['missing_key', 'legacy_root', 'unsafe_root'] as const)(
		'disables preview and apply for %s without calling either port',
		async (reason) => {
			const ports = portsFor({ disabledReason: () => reason });
			const controller = new InventoryVaultSyncController(ports);
			await expect(controller.preview()).resolves.toEqual({ status: 'disabled', reason });
			await expect(controller.apply()).resolves.toEqual({ status: 'disabled', reason });
			expect(ports.preview).not.toHaveBeenCalled();
			expect(ports.apply).not.toHaveBeenCalled();
		},
	);

	it('requires a successful explicit preview before apply and projects applying then success', async () => {
		const applying = deferred<InventoryVaultSyncResult>();
		const plan = planWith(['create']);
		const ports = portsFor({ preview: vi.fn(async () => plan), apply: vi.fn(() => applying.promise) });
		const controller = new InventoryVaultSyncController(ports);
		await controller.apply();
		expect(ports.apply).not.toHaveBeenCalled();
		await controller.preview();
		const result = controller.apply();
		expect(controller.current()).toMatchObject({ status: 'applying', summary: { create: 1 } });
		expect(ports.apply).toHaveBeenCalledOnce();
		applying.resolve({ status: 'applied', created: 1, updated: 0, deactivated: 0 });
		await expect(result).resolves.toMatchObject({
			status: 'success', result: { status: 'applied', created: 1, updated: 0, deactivated: 0 },
		});
		expect(controller.canApply()).toBe(false);
	});

	it('projects preview conflicts without retaining an applicable plan', async () => {
		const blocked = planWith(['create', 'conflict'], false);
		const ports = portsFor({ preview: vi.fn(async () => blocked) });
		const controller = new InventoryVaultSyncController(ports);
		await expect(controller.preview()).resolves.toMatchObject({
			status: 'conflict', summary: { create: 1, conflicts: 1 },
		});
		expect(controller.canApply()).toBe(false);
		await controller.apply();
		expect(ports.apply).not.toHaveBeenCalled();
	});

	it.each([
		['capture permission', new Error('403 secret token'), 'capture_unavailable'],
		['capture network', new Error('network account-private'), 'capture_unavailable'],
	] as const)('redacts %s failures into a stable error reason', async (_label, failure, reason) => {
		const controller = new InventoryVaultSyncController(portsFor({ preview: vi.fn(async () => { throw failure; }) }));
		expect(await controller.preview()).toEqual({ status: 'error', reason });
		expect(JSON.stringify(controller.current())).not.toMatch(/secret|account-private|403/u);
	});

	it.each([
		[{ status: 'conflict', message: 'RAW_CONFLICT_SECRET' }, 'conflict'],
		[{ status: 'invalid', message: 'RAW_FUTURE_SECRET' }, 'conflict'],
		[{ status: 'unavailable', message: 'RAW_VAULT_SECRET' }, 'error'],
	] as const)('projects apply result %j as %s without exposing backend messages', async (backend, expected) => {
		const ports = portsFor({ apply: vi.fn(async () => backend) });
		const controller = new InventoryVaultSyncController(ports);
		await controller.preview();
		const state = await controller.apply();
		expect(state.status).toBe(expected);
		expect(JSON.stringify(state)).not.toContain(backend.message);
	});

	it('maps an unexpected Vault exception to error and clears the applicable plan', async () => {
		const ports = portsFor({ apply: vi.fn(async () => { throw new Error('raw Vault failure'); }) });
		const controller = new InventoryVaultSyncController(ports);
		await controller.preview();
		expect(await controller.apply()).toEqual({ status: 'error', reason: 'unexpected_failure' });
		expect(controller.canApply()).toBe(false);
	});

	it('ignores stale preview completion after invalidate or dispose', async () => {
		for (const terminate of ['invalidate', 'dispose'] as const) {
			const pending = deferred<InventoryVaultSyncPlan>();
			const ports = portsFor({ preview: vi.fn(() => pending.promise) });
			const controller = new InventoryVaultSyncController(ports);
			const result = controller.preview();
			controller[terminate]();
			pending.resolve(planWith(['create']));
			const state = await result;
			expect(state.status).toBe(terminate === 'dispose' ? 'disabled' : 'idle');
			expect(controller.canApply()).toBe(false);
		}
	});

	it('summarizes only the closed plan enums', () => {
		expect(summarizeInventoryVaultSyncPlan(planWith([
			'create', 'create', 'update', 'unchanged', 'deactivate', 'conflict',
		]))).toEqual({ positions: 6, create: 2, update: 1, unchanged: 1, deactivate: 1, conflicts: 1 });
	});
});

function portsFor(overrides: Partial<InventoryVaultSyncControllerPorts> = {}): InventoryVaultSyncControllerPorts & {
	preview: ReturnType<typeof vi.fn>;
	apply: ReturnType<typeof vi.fn>;
} {
	return {
		disabledReason: overrides.disabledReason ?? (() => null),
		preview: (overrides.preview ?? vi.fn(async () => planWith(['create']))) as ReturnType<typeof vi.fn>,
		apply: (overrides.apply ?? vi.fn(async () => ({ status: 'unchanged', created: 0, updated: 0, deactivated: 0 } as const))) as ReturnType<typeof vi.fn>,
	};
}

function planWith(
	statuses: InventoryVaultSyncPlan['steps'][number]['status'][],
	canApply = !statuses.includes('conflict'),
): InventoryVaultSyncPlan {
	return {
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
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
/* eslint-enable @typescript-eslint/unbound-method -- End intentional Vitest port-spy assertions. */
