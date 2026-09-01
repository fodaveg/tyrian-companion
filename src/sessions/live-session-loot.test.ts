import { describe, expect, it, vi } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import { LiveSessionLootTracker } from './live-session-loot';

describe('LiveSessionLootTracker', () => {
	it('accumulates positive poll gains, resolves readable names, and alerts independently from Halloween', async () => {
		const onValuable = vi.fn();
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => path.startsWith('items?')
				? { status: 200, headers: {}, body: [{ id: 19722, name: 'Pimpollo de madera ancestral' }] }
				: { status: 200, headers: {}, body: [{ id: 19722, whitelisted: true,
					buys: { quantity: 100, unit_price: 20_000 }, sells: { quantity: 100, unit_price: 21_000 } }] }),
		};
		const tracker = new LiveSessionLootTracker({
			gateway, locale: () => 'es', thresholdCopper: () => 30_000, onValuable,
		});
		tracker.begin('session');
		await tracker.observe('session', delta(19722, 2));
		await tracker.observe('session', delta(19722, 1));

		expect(tracker.getState()).toMatchObject({
			status: 'observing', knownTotalCopper: 51_000,
			rows: [{ itemId: 19722, name: 'Pimpollo de madera ancestral', quantity: 3, unitCopper: 17_000, totalCopper: 51_000 }],
		});
		expect(onValuable).toHaveBeenCalledOnce();
		expect(onValuable).toHaveBeenCalledWith({ name: 'Pimpollo de madera ancestral', quantity: 2, totalCopper: 34_000 });
		expect(tracker.displayNames()).toEqual({ 'item:19722': 'Pimpollo de madera ancestral' });
	});

	it('reconciles the accumulated feed against the final session net without emitting a second alert', async () => {
		const onValuable = vi.fn();
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => path.startsWith('items?')
				? { status: 200, headers: {}, body: [{ id: 1, name: 'Infusión valiosa' }] }
				: { status: 200, headers: {}, body: [{ id: 1, whitelisted: true,
					buys: { quantity: 1, unit_price: 1_000_000 }, sells: { quantity: 1, unit_price: 1_100_000 } }] }),
		};
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'es', thresholdCopper: () => 10_000, onValuable });
		tracker.begin('session');
		await tracker.observe('session', delta(1, 2));
		await tracker.reconcile('session', delta(1, 1));

		expect(tracker.getState()).toMatchObject({ status: 'complete', rows: [{ quantity: 1, totalCopper: 850_000 }] });
		expect(onValuable).toHaveBeenCalledTimes(1);
	});

	it('never exposes a raw id when public metadata is unavailable', async () => {
		const tracker = new LiveSessionLootTracker({
			gateway: { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) },
			locale: () => 'es', thresholdCopper: () => 10_000,
		});
		tracker.begin('restored', true);
		await tracker.observe('restored', delta(9349, 1));
		const state = tracker.getState();
		expect(state).toMatchObject({
			status: 'observing', restored: true, error: 'catalog_unavailable',
			rows: [{ name: 'Objeto sin identificar', totalCopper: null }],
		});
		expect(JSON.stringify(state)).not.toContain('#9349');
	});

	it('retries unresolved enrichment on an empty later poll and emits one pending valuable alert', async () => {
		const onValuable = vi.fn();
		let available = false;
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => {
				if (!available) throw new Error('temporary outage');
				return path.startsWith('items?')
					? { status: 200, headers: {}, body: [{ id: 1, name: 'Infusión valiosa' }] }
					: { status: 200, headers: {}, body: [{ id: 1, whitelisted: true,
						buys: { quantity: 1, unit_price: 1_000_000 }, sells: { quantity: 1, unit_price: 1_100_000 } }] };
			}),
		};
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'es', thresholdCopper: () => 500_000, onValuable });
		tracker.begin('session');
		await tracker.observe('session', delta(1, 1));
		expect(onValuable).not.toHaveBeenCalled();

		available = true;
		await tracker.observe('session', delta(1, 0));
		await tracker.observe('session', delta(1, 0));

		expect(tracker.getState()).toMatchObject({
			rows: [{ name: 'Infusión valiosa', quantity: 1, totalCopper: 850_000 }], error: null,
		});
		expect(onValuable).toHaveBeenCalledOnce();
		expect(onValuable).toHaveBeenCalledWith({ name: 'Infusión valiosa', quantity: 1, totalCopper: 850_000 });
	});

	it('batches public item and price requests in groups of at most 200 ids', async () => {
		const requestedBatches: number[][] = [];
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => {
				const ids = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('ids')
					?.split(',').map(Number) ?? [];
				requestedBatches.push(ids);
				return path.startsWith('items?')
					? { status: 200, headers: {}, body: ids.map((id) => ({ id, name: `Item ${String(id)}` })) }
					: { status: 200, headers: {}, body: ids.map((id) => ({ id, whitelisted: true,
						buys: { quantity: 1, unit_price: 100 }, sells: { quantity: 1, unit_price: 101 } })) };
			}),
		};
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'en', thresholdCopper: () => 1_000_000 });
		tracker.begin('session');
		await tracker.observe('session', manyItemDelta(201));

		expect(requestedBatches).toHaveLength(4);
		expect(requestedBatches.every((ids) => ids.length <= 200)).toBe(true);
		expect(requestedBatches.map((ids) => ids.length)).toEqual([200, 200, 1, 1]);
		const state = tracker.getState();
		if (state.status === 'idle') throw new Error('Expected an observing tracker.');
		expect(state.rows.find(({ itemId }) => itemId === 1)).toMatchObject({ name: 'Item 1' });
		expect(state.rows.find(({ itemId }) => itemId === 201)).toMatchObject({ name: 'Item 201' });
	});
});

function delta(itemId: number, quantity: number): StorageDelta {
	return {
		version: 1, status: 'comparable', accountId: 'account', beforeSnapshotId: 'before', afterSnapshotId: 'after',
		window: { from: '2026-09-01T08:00:00.000Z', to: '2026-09-01T08:02:00.000Z' },
		surface: 'core_and_delivery', currencySurface: 'wallet_and_delivery', reasons: [], warnings: [],
		itemChanges: [{ id: itemId, before: 0, after: quantity, delta: quantity }],
		currencyChanges: [], availabilityChanges: [], compositionChanges: [],
	};
}

function manyItemDelta(count: number): StorageDelta {
	return {
		...delta(1, 1),
		itemChanges: Array.from({ length: count }, (_value, index) => ({
			id: index + 1, before: 0, after: 1, delta: 1,
		})),
	};
}
