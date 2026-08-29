import {
	ECTOPLASM_ITEM_ID,
	type EquipmentSalvagePolicyV1,
} from '../equipment-salvage-economy';

const RETRIEVED_AT = '2026-08-29T00:00:00.000Z';

/** Immutable H9.16 source pack. The Exotic rule deliberately carries no invented output rate. */
export const EQUIPMENT_SALVAGE_POLICY_V1: Readonly<EquipmentSalvagePolicyV1> = Object.freeze({
	version: 1,
	id: 'tc.equipment-salvage.rare-exotic-68-v1',
	publishedAt: RETRIEVED_AT,
	validUntil: '2027-02-25T00:00:00.000Z',
	sources: [
		{
			id: 'gw2-api-ecto-19721',
			url: 'https://api.guildwars2.com/v2/items/19721?lang=en',
			retrievedAt: RETRIEVED_AT,
		},
		{
			id: 'gw2-wiki-ecto-yield',
			url: 'https://wiki.guildwars2.com/wiki/Ectoplasm',
			retrievedAt: RETRIEVED_AT,
		},
		{
			id: 'gw2-wiki-exotic-equipment-2060139',
			url: 'https://wiki.guildwars2.com/index.php?title=Exotic_equipment&oldid=2060139',
			retrievedAt: RETRIEVED_AT,
		},
		{
			id: 'gw2-wiki-salvage-3166722',
			url: 'https://wiki.guildwars2.com/index.php?title=Salvage&oldid=3166722#Salvaging_results',
			retrievedAt: RETRIEVED_AT,
		},
		{
			id: 'gw2-wiki-salvage-kit-3121384',
			url: 'https://wiki.guildwars2.com/index.php?title=Salvage_kit&oldid=3121384',
			retrievedAt: RETRIEVED_AT,
		},
	],
	outputItemId: ECTOPLASM_ITEM_ID,
	outputSourceIds: ['gw2-api-ecto-19721'],
	rules: [
		{
			ruleId: 'rare-equipment-68-ecto-v1',
			rarity: 'Rare',
			minimumLevel: 68,
			expectedOutputMillionths: 900_000,
			sourceIds: ['gw2-wiki-ecto-yield', 'gw2-wiki-salvage-3166722'],
		},
		{
			ruleId: 'exotic-equipment-68-review-v1',
			rarity: 'Exotic',
			minimumLevel: 68,
			expectedOutputMillionths: null,
			sourceIds: ['gw2-wiki-exotic-equipment-2060139', 'gw2-wiki-salvage-3166722'],
		},
	],
	kits: [
		{
			id: 'master', costPerUseMicroCopper: 61_440_000, rarerMaterialsBps: 2_500,
			upgradeSalvageBps: 8_000, costCoverage: 'complete',
			sourceIds: ['gw2-wiki-salvage-kit-3121384'],
		},
		{
			id: 'mystic', costPerUseMicroCopper: 10_496_000, rarerMaterialsBps: 2_500,
			upgradeSalvageBps: 8_000, costCoverage: 'excludes_mystic_forge_stones',
			sourceIds: ['gw2-wiki-salvage-kit-3121384'],
		},
		{
			id: 'silver_fed', costPerUseMicroCopper: 60_000_000, rarerMaterialsBps: 2_500,
			upgradeSalvageBps: 8_000, costCoverage: 'complete',
			sourceIds: ['gw2-wiki-salvage-kit-3121384'],
		},
	],
} satisfies EquipmentSalvagePolicyV1);
