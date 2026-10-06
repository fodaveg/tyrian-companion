import { describe, expect, it, vi } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import { LiveSessionLootTracker } from './live-session-loot';
import { SESSION_SACK_ITEM_IDS } from './session-economy-evidence';

describe('LiveSessionLootTracker', () => {
	it('accumulates positive poll gains, resolves readable names, and alerts independently from Halloween', async () => {
		const onAlert = vi.fn();
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => path.startsWith('items?')
				? { status: 200, headers: {}, body: [{ id: 19722, name: 'Pimpollo de madera ancestral' }] }
				: { status: 200, headers: {}, body: [{ id: 19722, whitelisted: true,
					buys: { quantity: 100, unit_price: 20_000 }, sells: { quantity: 100, unit_price: 21_000 } }] }),
		};
		const tracker = new LiveSessionLootTracker({
			gateway, locale: () => 'es', thresholdCopper: () => 30_000, onAlert,
		});
		tracker.begin('session');
		await tracker.observe('session', delta(19722, 2));
		await tracker.observe('session', delta(19722, 1));

		expect(tracker.getState()).toMatchObject({
			status: 'observing', knownTotalCopper: 51_000,
			rows: [{ itemId: 19722, name: 'Pimpollo de madera ancestral', quantity: 3, unitCopper: 17_000, totalCopper: 51_000 }],
		});
		expect(onAlert).toHaveBeenCalledOnce();
		expect(onAlert).toHaveBeenCalledWith({ kind: 'valuable_loot', itemId: 19722, name: 'Pimpollo de madera ancestral',
			quantity: 2, totalCopper: 34_000, priceStatus: 'known', reason: 'valuable' });
		expect(tracker.displayNames()).toEqual({ 'item:19722': 'Pimpollo de madera ancestral' });
	});

	it('reconciles the accumulated feed against the final session net without emitting a second alert', async () => {
		const onAlert = vi.fn();
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => path.startsWith('items?')
				? { status: 200, headers: {}, body: [{ id: 1, name: 'Infusión valiosa' }] }
				: { status: 200, headers: {}, body: [{ id: 1, whitelisted: true,
					buys: { quantity: 1, unit_price: 1_000_000 }, sells: { quantity: 1, unit_price: 1_100_000 } }] }),
		};
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'es', thresholdCopper: () => 10_000, onAlert });
		tracker.begin('session');
		await tracker.observe('session', delta(1, 2));
		await tracker.reconcile('session', delta(1, 1));

		expect(tracker.getState()).toMatchObject({ status: 'complete', rows: [{ quantity: 1, totalCopper: 850_000 }] });
		expect(onAlert).toHaveBeenCalledTimes(1);
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

	/**
	 * H13.16. The whole point of `priceStatus`: `state.error` alone cannot tell these two apart
	 * (both read `prices_unavailable`), which is exactly what let a failed `commerce/prices`
	 * batch read the same as a confirmed absence of a market. Only the per-row `priceStatus`
	 * distinguishes them, and that is what has to reach the alert text.
	 */
	it('marks a row unavailable, not unquoted, when the whole commerce/prices batch fails', async () => {
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => path.startsWith('items?')
				? { status: 200, headers: {}, body: [{ id: 83_008, name: 'Pieza de equipo excepcional sin identificar' }] }
				: { status: 404, headers: {}, body: null }),
		};
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'es', thresholdCopper: () => 10_000 });
		tracker.begin('session');
		await tracker.observe('session', delta(83_008, 1));

		expect(tracker.getState()).toMatchObject({
			error: 'prices_unavailable',
			rows: [{ itemId: 83_008, unitCopper: null, totalCopper: null, priceStatus: 'unavailable' }],
		});
	});

	it('marks a row unquoted, not unavailable, when the trading post answers with no bid', async () => {
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => path.startsWith('items?')
				? { status: 200, headers: {}, body: [{ id: 5, name: 'Reliquia sin oferta' }] }
				: { status: 200, headers: {}, body: [{ id: 5, whitelisted: true,
					buys: { quantity: 0, unit_price: 0 }, sells: { quantity: 0, unit_price: 0 } }] }),
		};
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'es', thresholdCopper: () => 10_000 });
		tracker.begin('session');
		await tracker.observe('session', delta(5, 1));

		expect(tracker.getState()).toMatchObject({
			error: 'prices_unavailable',
			rows: [{ itemId: 5, unitCopper: null, totalCopper: null, priceStatus: 'unquoted' }],
		});
	});

	it('retries unresolved enrichment on an empty later poll and emits one pending valuable alert', async () => {
		const onAlert = vi.fn();
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
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'es', thresholdCopper: () => 500_000, onAlert });
		tracker.begin('session');
		await tracker.observe('session', delta(1, 1));
		expect(onAlert).not.toHaveBeenCalled();

		available = true;
		await tracker.observe('session', delta(1, 0));
		await tracker.observe('session', delta(1, 0));

		expect(tracker.getState()).toMatchObject({
			rows: [{ name: 'Infusión valiosa', quantity: 1, totalCopper: 850_000 }], error: null,
		});
		expect(onAlert).toHaveBeenCalledOnce();
		expect(onAlert).toHaveBeenCalledWith({ kind: 'valuable_loot', itemId: 1, name: 'Infusión valiosa',
			quantity: 1, totalCopper: 850_000, priceStatus: 'known', reason: 'valuable' });
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

	/**
	 * H13.14. The counter has to move on the sacks alone, and it has to keep moving while the
	 * public catalog is down: the sack count is read off the account delta, not off a price.
	 */
	it('counts only the sack ids and keeps counting while enrichment fails', async () => {
		const tracker = new LiveSessionLootTracker({
			gateway: { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) },
			locale: () => 'es', thresholdCopper: () => 10_000, sackItemIds: [36_038],
		});
		tracker.begin('session');
		await tracker.observe('session', delta(36_038, 7));
		await tracker.observe('session', delta(36_041, 40));
		const observing = tracker.getState();
		await tracker.observe('session', delta(36_038, 5));
		const later = tracker.getState();

		expect(observing).toMatchObject({ status: 'observing', sackQuantity: 7, error: 'catalog_unavailable' });
		expect(later).toMatchObject({ status: 'observing', sackQuantity: 12 });
	});

	it('counts the same sacks the durable note counts when no list is injected', async () => {
		const tracker = new LiveSessionLootTracker({
			gateway: { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) },
			locale: () => 'es', thresholdCopper: () => 10_000,
		});
		tracker.begin('session');
		await tracker.observe('session', delta(SESSION_SACK_ITEM_IDS[0]!, 3));

		expect(tracker.getState()).toMatchObject({ sackQuantity: 3 });
	});

	it('retains observed increments alongside the signed closing net', async () => {
		const tracker = new LiveSessionLootTracker({
			gateway: { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) },
			locale: () => 'es', thresholdCopper: () => 10_000, sackItemIds: [36_038],
		});
		tracker.begin('session');
		await tracker.observe('session', delta(36_038, 7));
		await tracker.reconcile('session', delta(36_038, 9));

		expect(tracker.getState()).toMatchObject({ status: 'complete', sackQuantity: 7, observedSackGains: 7, netSackQuantity: 9, totalSacksObtained: null });
	});

	it('does not claim zero obtained bags when acquisition and opening are invisible between polls', async () => {
		const tracker = new LiveSessionLootTracker({ gateway: { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) },
			locale: () => 'es', thresholdCopper: () => 10_000 });
		tracker.begin('session');
		await tracker.observe('session', delta(36038, 100));
		await tracker.observe('session', delta(36038, -100));
		await tracker.reconcile('session', delta(36038, 0));
		expect(tracker.sackObservation('session')).toEqual({ itemId: 36038, observedGains: 100, netRetained: 0, totalObtained: null });
		expect(tracker.getState()).toMatchObject({ sackQuantity: 100, knownTotalCopper: 0, rows: [] });
		tracker.begin('unseen');
		await tracker.reconcile('unseen', delta(36038, 0));
		expect(tracker.sackObservation('unseen')).toMatchObject({ observedGains: 0, totalObtained: null });
		tracker.begin('restored', true);
		await tracker.observe('restored', delta(36038, 10));
		expect(tracker.sackObservation('restored')).toMatchObject({ observedGains: null });
	});

	/**
	 * The Botín list of the Companion tab keeps one line per `itemId` across repaints (audit 3.5),
	 * so two rows with the same id would share a line. The tracker never produces them: every gain
	 * of an item lands on the one row its id keys, on every path that writes or reads a row.
	 */
	it('keeps one row per item id, with the quantity added up, on every path that touches a row', async () => {
		const alerted: Array<[number, number]> = [];
		const onAlert = (alert: { itemId: number; quantity: number }): void => { alerted.push([alert.itemId, alert.quantity]); };
		let available = false;
		const gateway = {
			requestDetailed: vi.fn(async (path: string) => {
				if (!available) throw new Error('temporary outage');
				const ids = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('ids')?.split(',').map(Number) ?? [];
				return path.startsWith('items?')
					? { status: 200, headers: {}, body: ids.map((id) => ({ id, name: `Objeto ${String(id)}` })) }
					: { status: 200, headers: {}, body: ids.map((id) => ({ id, whitelisted: true,
						buys: { quantity: 1, unit_price: 1_000 * id }, sells: { quantity: 1, unit_price: 1_100 * id } })) };
			}),
		};
		const tracker = new LiveSessionLootTracker({ gateway, locale: () => 'es', thresholdCopper: () => 1, onAlert });
		const quantities = (): Array<[number, number]> => {
			const state = tracker.getState();
			if (state.status === 'idle') throw new Error('Expected a tracker with a session.');
			return state.rows.map((row): [number, number] => [row.itemId, row.quantity]).sort(([left], [right]) => left - right);
		};

		// A restored session, the public catalog down: every gain waits unresolved, none alerts.
		tracker.begin('session', true);
		await tracker.observe('session', delta(7, 2));
		await tracker.observe('session', delta(9, 1));
		await tracker.observe('session', delta(7, 3));
		// The same id twice inside one poll still lands on its one row.
		await tracker.observe('session', { ...delta(7, 0), itemChanges: [
			{ id: 9, before: 1, after: 2, delta: 1 }, { id: 9, before: 2, after: 6, delta: 4 },
		] });
		expect(quantities()).toEqual([[7, 5], [9, 6]]);
		expect(tracker.getState()).toMatchObject({ restored: true });
		expect(alerted).toEqual([]);

		// The catalog answers: the pending gains resolve into alerts against the rows that exist,
		// and the gains of this poll are added to them.
		available = true;
		await tracker.observe('session', { ...delta(7, 0), itemChanges: [
			{ id: 7, before: 5, after: 6, delta: 1 }, { id: 11, before: 0, after: 4, delta: 4 },
		] });
		expect(quantities()).toEqual([[7, 6], [9, 6], [11, 4]]);
		expect(alerted.sort(([leftId, leftQuantity], [rightId, rightQuantity]) => leftId - rightId || leftQuantity - rightQuantity))
			.toEqual([[7, 1], [7, 2], [7, 3], [9, 1], [9, 1], [9, 4], [11, 4]]);
		expect(Object.keys(tracker.displayNames()).sort()).toEqual(['item:11', 'item:7', 'item:9']);

		// The final net restates the rows; it does not append to them.
		await tracker.reconcile('session', { ...delta(7, 0), itemChanges: [
			{ id: 7, before: 0, after: 6, delta: 6 }, { id: 11, before: 0, after: 3, delta: 3 },
		] });
		expect(quantities()).toEqual([[7, 6], [11, 3]]);

		// Even a net that named one id twice would leave a single row for it.
		await tracker.reconcile('session', { ...delta(7, 0), itemChanges: [
			{ id: 7, before: 0, after: 2, delta: 2 }, { id: 11, before: 0, after: 3, delta: 3 }, { id: 7, before: 2, after: 6, delta: 4 },
		] });
		expect(quantities().map(([itemId]) => itemId)).toEqual([7, 11]);
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
