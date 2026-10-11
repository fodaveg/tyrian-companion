import { describe, expect, it } from 'vitest';

import type { HttpResponse } from '../core/http';
import { StorageSnapshotService } from './storage-snapshot-service';
import { canonicalHoldingOrder } from './storage-snapshot-pure';
import type { ItemHolding } from './storage-snapshot-model';

function holding(itemId: number, location: ItemHolding['location']): ItemHolding {
	return { kind: 'item', itemId, quantity: 1, state: 'loose', location, metadata: {} };
}

describe('Z4-2 canonical holding order', () => {
	it('orders by source, character, container, bag and slot whatever order they arrived in', () => {
		const bank = holding(10, { source: 'bank', slot: 3 });
		const shared = holding(10, { source: 'shared_inventory', slot: 0 });
		const bagB = holding(10, { source: 'character', character: 'B', container: 'bag', bagIndex: 0, slot: 1 });
		const equippedA = holding(10, { source: 'character', character: 'A', container: 'equipped_bag', bagIndex: 2 });
		const bagA = holding(10, { source: 'character', character: 'A', container: 'bag', bagIndex: 0, slot: 4 });
		const expected = [shared, bank, equippedA, bagA, bagB];
		for (const arrival of [[bank, shared, bagB, equippedA, bagA], [bagA, bagB, equippedA, bank, shared], [...expected]]) {
			expect(canonicalHoldingOrder(arrival)).toEqual(expected);
		}
	});

	it('keeps the arrival order of one request when locations tie', () => {
		const first = holding(1, { source: 'materials', category: 5 });
		const second = holding(2, { source: 'materials', category: 5 });
		expect(canonicalHoldingOrder([first, second])).toEqual([first, second]);
	});

	it('gives an unchanged account the same holdings whichever store answers last', async () => {
		const body: Record<string, unknown> = {
			characters: [], 'account/inventory': [{ id: 10, count: 2 }], 'account/bank': [{ id: 10, count: 2 }], 'account/materials': [],
		};
		const capture = async (slow: string): Promise<string[]> => {
			const operation = {
				request: async (path: string) => path === 'tokeninfo'
					? { id: 't', name: 'k', permissions: ['account', 'characters', 'inventories'] }
					: { id: 'acc', name: 'n', world: 1, created: '2020-01-01T00:00:00Z', access: [], commander: false },
				requestDetailed: async (path: string): Promise<HttpResponse> => {
					const raw = path.split('?')[0]!;
					if (raw === slow) await new Promise((resolve) => setTimeout(resolve, 20));
					return { status: 200, headers: {}, body: body[raw] };
				},
			};
			const client = { beginOperation: () => operation };
			const snapshot = await new StorageSnapshotService(client).captureInventoryWithOperation(operation);
			return snapshot.holdings.map((entry) => entry.location.source);
		};
		const bankSlow = await capture('account/bank');
		const inventorySlow = await capture('account/inventory');
		expect(bankSlow).toEqual(['shared_inventory', 'bank']);
		expect(inventorySlow).toEqual(bankSlow);
	});
});
