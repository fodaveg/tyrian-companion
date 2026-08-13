import { describe, expect, it, vi } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import {
	isSessionPriceSnapshot,
	SessionPriceSnapshotService,
} from './session-price-snapshot';

const capturedAt = Date.parse('2026-08-13T10:00:00.000Z');

function delta(changes: Array<{ id: number; before: number; after: number }>): StorageDelta {
	return {
		version: 1,
		status: 'comparable',
		accountId: 'account-1',
		beforeSnapshotId: 'before',
		afterSnapshotId: 'after',
		window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T10:00:00.000Z' },
		surface: 'core_and_delivery',
		currencySurface: 'wallet_and_delivery',
		reasons: [],
		warnings: [],
		itemChanges: changes.map((change) => ({ ...change, delta: change.after - change.before })),
		currencyChanges: [],
		availabilityChanges: [],
		compositionChanges: [],
	};
}

function gateway(body: unknown, status = 200): PublicCatalogGateway & { requestDetailed: ReturnType<typeof vi.fn> } {
	return {
		requestDetailed: vi.fn(async () => ({ status, headers: {}, body })),
	};
}

describe('SessionPriceSnapshotService', () => {
	it('captures bid, ask, timestamp and source for gained items only', async () => {
		const api = gateway([
			{ id: 20, whitelisted: false, buys: { quantity: 8, unit_price: 123 }, sells: { quantity: 5, unit_price: 150 } },
			{ id: 10, whitelisted: true, buys: { quantity: 0, unit_price: 0 }, sells: { quantity: 2, unit_price: 44 } },
		]);
		const storageDelta = delta([
			{ id: 20, before: 1, after: 4 },
			{ id: 10, before: 0, after: 2 },
			{ id: 30, before: 5, after: 1 },
		]);
		const service = new SessionPriceSnapshotService(api, () => capturedAt);

		const result = await service.capture('session-1', storageDelta);

		// eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest mock is a standalone arrow function.
		expect(api.requestDetailed).toHaveBeenCalledWith(expect.stringContaining('commerce/prices?ids=10,20&'));
		expect(result).toEqual({
			version: 1,
			sessionId: 'session-1',
			capturedAt: '2026-08-13T10:00:00.000Z',
			source: 'gw2-commerce-prices',
			schemaVersion: '2024-07-20T01:00:00.000Z',
			status: 'complete',
			items: [
				{ itemId: 10, quantityGained: 2, whitelisted: true, bid: null, ask: { quantity: 2, unitCopper: 44 } },
				{ itemId: 20, quantityGained: 3, whitelisted: false, bid: { quantity: 8, unitCopper: 123 }, ask: { quantity: 5, unitCopper: 150 } },
			],
			missingItemIds: [],
		});
		expect(isSessionPriceSnapshot(result, 'session-1', storageDelta)).toBe(true);
	});

	it('keeps omitted or malformed IDs explicit instead of inventing zero prices', async () => {
		const api = gateway([
			{ id: 10, whitelisted: true, buys: { quantity: 1, unit_price: 10 }, sells: { quantity: 2, unit_price: 12 } },
			{ id: 20, whitelisted: true, buys: { quantity: 0, unit_price: 9 }, sells: { quantity: 2, unit_price: 12 } },
		], 206);
		const storageDelta = delta([{ id: 10, before: 0, after: 1 }, { id: 20, before: 0, after: 1 }]);

		const result = await new SessionPriceSnapshotService(api, () => capturedAt)
			.capture('session-1', storageDelta);

		expect(result.status).toBe('partial');
		expect(result.items.map((item) => item.itemId)).toEqual([10]);
		expect(result.missingItemIds).toEqual([20]);
		expect(isSessionPriceSnapshot(result, 'session-1', storageDelta)).toBe(true);
	});

	it('returns an unavailable close-time snapshot when the public request fails', async () => {
		const api: PublicCatalogGateway = { requestDetailed: vi.fn(async () => { throw new Error('offline'); }) };
		const storageDelta = delta([{ id: 20, before: 0, after: 4 }]);

		const result = await new SessionPriceSnapshotService(api, () => capturedAt)
			.capture('session-1', storageDelta);

		expect(result).toMatchObject({ status: 'unavailable', items: [], missingItemIds: [20] });
		expect(isSessionPriceSnapshot(result, 'session-1', storageDelta)).toBe(true);
	});

	it('uses batches of at most 200 sorted IDs', async () => {
		const changes = Array.from({ length: 201 }, (_, index) => ({ id: 201 - index, before: 0, after: 1 }));
		const api: PublicCatalogGateway = {
			requestDetailed: vi.fn(async (path: string) => {
				const ids = new URLSearchParams(path.split('?')[1]).get('ids')!.split(',').map(Number);
				return {
					status: 200,
					headers: {},
					body: ids.map((id) => ({ id, whitelisted: true, buys: { quantity: 1, unit_price: id }, sells: { quantity: 1, unit_price: id + 1 } })),
				};
			}),
		};

		const result = await new SessionPriceSnapshotService(api, () => capturedAt)
			.capture('session-1', delta(changes));

		// eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest mock is a standalone arrow function.
		expect(api.requestDetailed).toHaveBeenCalledTimes(2);
		expect(result.items).toHaveLength(201);
		expect(result.items[0]?.itemId).toBe(1);
		expect(result.items.at(-1)?.itemId).toBe(201);
	});

	it('rejects duplicates and tampering against the gained quantities', async () => {
		const storageDelta = delta([{ id: 10, before: 0, after: 2 }]);
		const duplicate = gateway([
			{ id: 10, whitelisted: true, buys: { quantity: 1, unit_price: 10 }, sells: { quantity: 1, unit_price: 11 } },
			{ id: 10, whitelisted: true, buys: { quantity: 1, unit_price: 10 }, sells: { quantity: 1, unit_price: 11 } },
		]);
		const result = await new SessionPriceSnapshotService(duplicate, () => capturedAt)
			.capture('session-1', storageDelta);
		expect(result).toMatchObject({ status: 'unavailable', items: [], missingItemIds: [10] });
		expect(isSessionPriceSnapshot(result, 'session-1', storageDelta)).toBe(true);
		expect(isSessionPriceSnapshot({ ...result, missingItemIds: [] }, 'session-1', storageDelta)).toBe(false);
	});
});
