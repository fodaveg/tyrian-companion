export const characterName = 'Astra / Uno';

export const rosterFixture = [characterName];

export const characterInventoryFixture = {
	name: characterName,
	profession: 'Mesmer',
	bags: [
		{
			id: 1_001,
			size: 20,
			inventory: [
				{
					id: 2_001,
					count: 2,
					binding: 'Character',
					bound_to: characterName,
					skin: 5_001,
					stats: { id: 6_001, attributes: { Power: 100 } },
					charges: 7,
					upgrades: [3_001],
					infusions: [4_001],
					future_field: 'ignored',
				},
				null,
			],
		},
	],
};

export const sharedInventoryFixture = [{ id: 2_002, count: 3 }, null];
export const bankFixture = [{ id: 2_003, count: 4 }, null];
export const materialsFixture = [{ id: 2_004, category: 7, count: 5 }];
export const walletFixture = [{ id: 1, value: 12_345 }];
export const deliveryFixture = { coins: 678, items: [{ id: 2_005, count: 6 }] };

export const completePassFixture = {
	characters: rosterFixture,
	[`characters/${encodeURIComponent(characterName)}/inventory`]: characterInventoryFixture,
	'account/inventory': sharedInventoryFixture,
	'account/bank': bankFixture,
	'account/materials': materialsFixture,
	'account/wallet': walletFixture,
	'commerce/delivery': deliveryFixture,
};
