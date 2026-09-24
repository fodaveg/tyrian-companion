import { describe, expect, it } from 'vitest';

import {
	bankFixture,
	characterInventoryFixture,
	characterName,
	deliveryFixture,
	materialsFixture,
	sharedInventoryFixture,
	walletFixture,
} from './__fixtures__/storage';
import { InvalidSnapshotPayloadError } from './storage-snapshot-model';
import {
	parseCharacterBagFreeSlots,
	parseCharacterInventory,
	parseContainerFreeSlots,
	parseDelivery,
	parseMaterials,
	parseSlotArray,
	parseWallet,
} from './storage-snapshot-parsers';

describe('storage snapshot parsers', () => {
	it('normalizes bags, roots, embedded children, binding, and item metadata', () => {
		const holdings = parseCharacterInventory(characterInventoryFixture, characterName);

		expect(holdings).toHaveLength(4);
		expect(holdings[0]).toMatchObject({
			itemId: 1_001,
			quantity: 1,
			state: 'equipped_container',
			location: { container: 'equipped_bag', character: characterName },
		});
		expect(holdings[1]).toMatchObject({
			itemId: 2_001,
			quantity: 2,
			state: 'loose',
			metadata: {
				binding: 'Character',
				boundTo: characterName,
				skin: 5_001,
				statsId: 6_001,
				statsAttributes: { Power: 100 },
				charges: 7,
			},
		});
		expect(holdings.slice(2)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					itemId: 3_001,
					quantity: 1,
					state: 'embedded_upgrade',
					parentItemId: 2_001,
					embeddedKind: 'upgrade',
				}),
				expect.objectContaining({
					itemId: 4_001,
					quantity: 1,
					state: 'embedded_infusion',
					parentItemId: 2_001,
					embeddedKind: 'infusion',
				}),
			]),
		);
	});

	it('normalizes account storage, materials, wallet, and delivery namespaces', () => {
		expect(parseSlotArray(sharedInventoryFixture, 'shared_inventory')[0]?.location).toEqual({
			source: 'shared_inventory',
			slot: 0,
		});
		expect(parseSlotArray(bankFixture, 'bank')[0]?.location).toEqual({ source: 'bank', slot: 0 });
		expect(parseMaterials(materialsFixture)[0]?.location).toEqual({
			source: 'materials',
			category: 7,
		});
		expect(parseWallet(walletFixture)).toEqual([
			{ kind: 'currency', namespace: 'wallet', currencyId: 1, quantity: 12_345 },
		]);
		expect(parseDelivery(deliveryFixture)).toMatchObject({
			holdings: [{ itemId: 2_005, quantity: 6, location: { source: 'commerce_delivery' } }],
			currencies: [{ namespace: 'delivery', currencyId: 1, quantity: 678 }],
		});
	});

	it.each([
		['zero id', [{ id: 0, count: 1 }]],
		['negative id', [{ id: -1, count: 1 }]],
		['unsafe id', [{ id: Number.MAX_SAFE_INTEGER + 1, count: 1 }]],
		['negative quantity', [{ id: 1, count: -1 }]],
		['fractional quantity', [{ id: 1, count: 1.5 }]],
		['unsafe quantity', [{ id: 1, count: Number.MAX_SAFE_INTEGER + 1 }]],
		['zero skin id', [{ id: 1, count: 1, skin: 0 }]],
	])('rejects %s', (_label, payload) => {
		expect(() => parseSlotArray(payload, 'bank')).toThrow(InvalidSnapshotPayloadError);
	});

	it('omits zero quantities and ignores unknown fields', () => {
		expect(parseSlotArray([{ id: 42, count: 0, future: { nested: true } }], 'bank')).toEqual([]);
		expect(parseWallet([{ id: 1, value: 0 }])).toEqual([]);
		expect(parseDelivery({ coins: 0, items: [] }).currencies).toEqual([]);
	});

	it('preserves future binding values instead of invalidating the source', () => {
		expect(parseSlotArray([{ id: 42, count: 1, binding: 'FutureBinding' }], 'bank')).toMatchObject([
			{ metadata: { binding: 'FutureBinding' } },
		]);
	});

	describe('free slot parsers (H18.15)', () => {
		it('counts a flat account store free slots from its own array length, nulls included', () => {
			expect(parseContainerFreeSlots(sharedInventoryFixture, 'shared_inventory')).toEqual({
				total: 2,
				free: 1,
			});
			expect(parseContainerFreeSlots(bankFixture, 'bank')).toEqual({ total: 2, free: 1 });
		});

		it('counts every slot as occupied when the store has no empty holes', () => {
			expect(parseContainerFreeSlots([{ id: 1, count: 1 }, { id: 2, count: 1 }], 'bank')).toEqual({
				total: 2,
				free: 0,
			});
		});

		it('rejects a non-array container', () => {
			expect(() => parseContainerFreeSlots({ not: 'an array' }, 'bank')).toThrow(InvalidSnapshotPayloadError);
		});

		it("reads a bag's real capacity from its own size, never from the inventory array length", () => {
			expect(parseCharacterBagFreeSlots(characterInventoryFixture, characterName)).toEqual([
				{ character: characterName, bagIndex: 0, bagItemId: 1_001, total: 20, free: 19 },
			]);
		});

		it('skips an empty equipped bag slot without throwing', () => {
			expect(parseCharacterBagFreeSlots({
				name: characterName,
				bags: [null, { id: 1_002, size: 4, inventory: [null, null, null, null] }],
			}, characterName)).toEqual([
				{ character: characterName, bagIndex: 1, bagItemId: 1_002, total: 4, free: 4 },
			]);
		});

		it('reports a bag with impossible occupancy as unknown instead of inventing or crashing', () => {
			expect(parseCharacterBagFreeSlots({
				name: characterName,
				bags: [{ id: 1_003, size: 1, inventory: [{ id: 2, count: 1 }, { id: 3, count: 1 }] }],
			}, characterName)).toEqual([]);
		});

		it('reports a bag missing its size field as unknown, matching a pre-H18.15 fixture', () => {
			expect(parseCharacterBagFreeSlots({
				name: characterName,
				bags: [{ id: 1_004, inventory: [null] }],
			}, characterName)).toEqual([]);
		});
	});
});
