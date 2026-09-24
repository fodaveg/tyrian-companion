import { describe, expect, it } from 'vitest';

import type { CatalogItem } from '../catalog/public-catalog-model';
import {
	evaluateEquipmentSalvageEconomy,
	isEquipmentSalvagePolicy,
	type EquipmentSalvageEconomyInputV1,
} from './equipment-salvage-economy';
import { EQUIPMENT_SALVAGE_POLICY_V1 } from './models/equipment-salvage-policy';

describe('equipment salvage economy', () => {
	it('recommends Rare salvage only when the ectoplasm lower bound beats every current route', () => {
		const result = evaluateEquipmentSalvageEconomy(fixture());

		expect(result).toMatchObject({
			status: 'ready',
			action: 'salvage',
			economics: {
				ruleId: 'rare-equipment-68-ecto-v1',
				expectedOutputMillionths: 900_000,
				outputStrategy: 'instant_sell',
				outputStrategySource: 'conservative_lower_quote',
				kit: 'master',
				kitSource: 'conservative_master_default',
				timeCostSource: 'excluded_missing_preference',
				excludedOutputs: ['base_materials', 'luck', 'upgrade_returns'],
			},
		});
		if (result.status !== 'ready') throw new Error('Expected a ready result.');
		expect(result.economics.netSalvageMicroCopper).toBe(1_407_120_000);
		expect(result.economics.marketAlternatives).toMatchObject({
			instantSellCopper: 1_360,
			listingCopper: 1_360,
			vendorCopper: 1_000,
			bestAction: 'list',
			bestCopper: 1_360,
		});
	});

	it('keeps the current market route when its demonstrated net value is at least the salvage EV', () => {
		const input = fixture();
		input.market.listingUnitCopper = 1_000;
		expect(evaluateEquipmentSalvageEconomy(input)).toMatchObject({
			status: 'ready', action: 'market', economics: { marketAlternatives: { bestAction: 'list', bestCopper: 1_700 } },
		});
	});

	it('models configured kit, time and output-sale strategy without rounding copper early', () => {
		const input = fixture();
		input.preferences = {
			version: 1,
			kit: 'silver_fed',
			saleStrategy: 'listing',
			time: { secondsPerItem: 2, opportunityCostCopperPerHour: 3_600 },
		};
		const result = evaluateEquipmentSalvageEconomy(input);
		expect(result).toMatchObject({
			status: 'ready',
			economics: {
				outputStrategy: 'listing', outputStrategySource: 'configured',
				kit: 'silver_fed', kitSource: 'configured', kitCostMicroCopper: 120_000_000,
				timeCostMicroCopper: 4_000_000, timeCostSource: 'configured',
			},
		});
	});

	it('fails closed for Exotic because its specific output rate is not attested', () => {
		const input = fixture();
		input.item.rarity = 'Exotic';
		expect(evaluateEquipmentSalvageEconomy(input)).toEqual({
			status: 'review', reason: 'exotic_output_rate_unverified', ruleId: 'exotic-equipment-68-review-v1',
		});
	});

	it.each([
		['NoSalvage', (input: EquipmentSalvageEconomyInputV1) => { input.item.flags.push('NoSalvage'); }, 'no_salvage'],
		['uncertain catalog', (input: EquipmentSalvageEconomyInputV1) => { input.catalogCoverage = 'uncertain'; }, 'catalog_uncertain'],
		['unknown item type', (input: EquipmentSalvageEconomyInputV1) => { input.item.type = 'FutureEquipment'; }, 'item_type_uncertain'],
		['unknown rarity', (input: EquipmentSalvageEconomyInputV1) => { input.item.rarity = 'FutureRarity'; }, 'item_rarity_uncertain'],
		['uncertain prices', (input: EquipmentSalvageEconomyInputV1) => { input.priceCoverage = 'uncertain'; }, 'price_uncertain'],
		['missing output quote', (input: EquipmentSalvageEconomyInputV1) => {
			input.output.instantSellUnitCopper = null; input.output.instantSellLevels = [];
			input.output.listingUnitCopper = null;
		}, 'output_price_missing'],
		['Mystic stone opportunity cost', (input: EquipmentSalvageEconomyInputV1) => { input.preferences.kit = 'mystic'; }, 'mystic_stone_cost_unmodeled'],
	] as const)('returns review for %s', (_label, mutate, reason) => {
		const input = fixture();
		mutate(input);
		expect(evaluateEquipmentSalvageEconomy(input)).toMatchObject({ status: 'review', reason });
	});

	it('recognizes known out-of-scope types, rarities and levels without claiming uncertainty', () => {
		const trophy = fixture(); trophy.item.type = 'Trophy';
		expect(evaluateEquipmentSalvageEconomy(trophy)).toEqual({ status: 'not_applicable', reason: 'known_non_equipment' });
		const fine = fixture(); fine.item.rarity = 'Fine';
		expect(evaluateEquipmentSalvageEconomy(fine)).toEqual({ status: 'not_applicable', reason: 'rarity_out_of_scope' });
		const low = fixture(); low.item.level = 67;
		expect(evaluateEquipmentSalvageEconomy(low)).toEqual({ status: 'not_applicable', reason: 'level_below_68' });
	});

	it('rejects stale, malformed and untraceable policy mutations', () => {
		expect(isEquipmentSalvagePolicy(EQUIPMENT_SALVAGE_POLICY_V1)).toBe(true);
		const missingSource = structuredClone(EQUIPMENT_SALVAGE_POLICY_V1);
		missingSource.rules[0].sourceIds = ['missing'];
		expect(isEquipmentSalvagePolicy(missingSource)).toBe(false);
		const stale = fixture(); stale.asOf = stale.policy.validUntil;
		expect(evaluateEquipmentSalvageEconomy(stale)).toMatchObject({
			status: 'review', reason: 'policy_invalid_or_stale',
		});
	});

	it.each([
		['a one-microcopper Master cost', (policy: EquipmentSalvageEconomyInputV1['policy']) => {
			policy.kits[0]!.costPerUseMicroCopper = 1;
		}],
		['complete Mystic cost coverage', (policy: EquipmentSalvageEconomyInputV1['policy']) => {
			policy.kits[1]!.costCoverage = 'complete';
		}],
		['a changed validity date', (policy: EquipmentSalvageEconomyInputV1['policy']) => {
			policy.validUntil = '2027-02-26T00:00:00.000Z';
		}],
		['a changed source URL', (policy: EquipmentSalvageEconomyInputV1['policy']) => {
			policy.sources[0]!.url = 'https://example.invalid/forged';
		}],
	] as const)('rejects an otherwise well-formed unauthorized policy with %s', (_label, mutate) => {
		const policy = structuredClone(EQUIPMENT_SALVAGE_POLICY_V1);
		mutate(policy);
		expect(isEquipmentSalvagePolicy(policy)).toBe(false);
		expect(evaluateEquipmentSalvageEconomy({ ...fixture(), policy })).toMatchObject({
			status: 'review', reason: 'policy_invalid_or_stale',
		});
	});

	it('consumes demonstrated ectoplasm bid depth instead of extrapolating the best bid', () => {
		const input = fixture();
		input.quantity = 3;
		input.preferences.saleStrategy = 'instant_sell';
		input.output.instantSellLevels = [
			{ unitCopper: 1_000, quantity: 1 },
			{ unitCopper: 900, quantity: 2 },
		];
		const result = evaluateEquipmentSalvageEconomy(input);
		expect(result).toMatchObject({ status: 'ready', economics: {
			outputStrategy: 'instant_sell', grossOutputMicroCopper: 2_150_500_000,
		} });
	});

	it.each([
		['partial', [{ unitCopper: 1_000, quantity: 1 }]],
		['absent', null],
	] as const)('withholds instant-sell salvage EV when ectoplasm depth is %s', (_label, levels) => {
		const input = fixture();
		input.preferences.saleStrategy = 'instant_sell';
		input.output.instantSellLevels = levels === null ? null : levels.map((level) => ({ ...level }));
		expect(evaluateEquipmentSalvageEconomy(input)).toMatchObject({
			status: 'review', reason: 'output_price_missing',
		});
	});

	/* H18.13: `/commerce/prices` and `/commerce/listings` are cached separately;
	 * measured on 24 Sep 2026 at a 1,703 bid against a 1,697 first level. */
	it.each([
		['a relic', { type: 'Relic', rarity: 'Exotic', level: 60 }],
		['a crafting material', { type: 'CraftingMaterial', rarity: 'Rare', level: 0 }],
	] as const)('keeps %s out of salvage regardless of disagreeing ectoplasm quotes', (_label, shape) => {
		const input = divergentEctoplasm(fixture());
		Object.assign(input.item, shape);
		expect(evaluateEquipmentSalvageEconomy(input)).toEqual({ status: 'not_applicable', reason: 'known_non_equipment' });
	});

	it('does not let disagreeing ectoplasm quotes decide Exotic equipment, whose output rate is unattested', () => {
		const input = divergentEctoplasm(fixture());
		input.item.rarity = 'Exotic';
		expect(evaluateEquipmentSalvageEconomy(input)).toEqual({
			status: 'review', reason: 'exotic_output_rate_unverified', ruleId: 'exotic-equipment-68-review-v1',
		});
	});

	it.each([
		['a higher prices bid', (input: EquipmentSalvageEconomyInputV1) => { divergentEctoplasm(input); }],
		['a prices bid without any listed buyer', (input: EquipmentSalvageEconomyInputV1) => {
			input.output.instantSellLevels = [];
		}],
		['listed buyers without a prices bid', (input: EquipmentSalvageEconomyInputV1) => {
			input.output.instantSellUnitCopper = null;
		}],
	] as const)('reports %s as price uncertainty for Rare salvage, not as a stale policy', (_label, mutate) => {
		for (const saleStrategy of [null, 'instant_sell'] as const) {
			const input = fixture();
			input.preferences.saleStrategy = saleStrategy;
			mutate(input);
			expect(evaluateEquipmentSalvageEconomy(input)).toEqual({
				status: 'review', reason: 'price_uncertain', ruleId: 'rare-equipment-68-ecto-v1',
			});
		}
	});

	it('keeps a configured listing strategy independent of the instant-sell disagreement', () => {
		const input = divergentEctoplasm(fixture());
		input.preferences.saleStrategy = 'listing';
		expect(evaluateEquipmentSalvageEconomy(input)).toMatchObject({
			status: 'ready', economics: { outputStrategy: 'listing' },
		});
	});

	it.each([
		['ascending bid levels', (output: EquipmentSalvageEconomyInputV1['output']) => {
			output.instantSellLevels = [{ unitCopper: 1_000, quantity: 1 }, { unitCopper: 1_001, quantity: 1 }];
		}],
		['a non-positive level quantity', (output: EquipmentSalvageEconomyInputV1['output']) => {
			output.instantSellLevels = [{ unitCopper: 1_000, quantity: 0 }];
		}],
		['an unexpected output key', (output: EquipmentSalvageEconomyInputV1['output']) => {
			Object.assign(output, { vendorUnitCopper: 1 });
		}],
		['another output item', (output: EquipmentSalvageEconomyInputV1['output']) => {
			Object.assign(output, { itemId: 19_976 });
		}],
	] as const)('still rejects malformed output evidence with %s for every item type', (_label, mutate) => {
		for (const type of ['Weapon', 'Relic'] as const) {
			const input = fixture();
			input.item.type = type;
			mutate(input.output);
			expect(evaluateEquipmentSalvageEconomy(input)).toEqual({
				status: 'review', reason: 'policy_invalid_or_stale', ruleId: null,
			});
		}
	});
});

/** Makes the `/commerce/prices` bid disagree with the first `/commerce/listings` level. */
function divergentEctoplasm(input: EquipmentSalvageEconomyInputV1): EquipmentSalvageEconomyInputV1 {
	input.output.instantSellLevels = [{ unitCopper: 1_697, quantity: 10_000 }];
	input.output.instantSellUnitCopper = 1_703;
	return input;
}

function fixture(): EquipmentSalvageEconomyInputV1 {
	return {
		version: 1,
		asOf: '2026-08-29T12:00:00.000Z',
		item: item(),
		quantity: 2,
		catalogCoverage: 'complete',
		priceCoverage: 'complete',
		market: { instantSellUnitCopper: 800, listingUnitCopper: 800, vendorUnitCopper: 500 },
		output: {
			itemId: 19_721,
			instantSellUnitCopper: 1_000,
			instantSellLevels: [{ unitCopper: 1_000, quantity: 10_000 }],
			listingUnitCopper: 1_050,
		},
		policy: structuredClone(EQUIPMENT_SALVAGE_POLICY_V1),
		preferences: { version: 1, kit: null, saleStrategy: null, time: null },
	};
}

function item(): CatalogItem {
	return {
		kind: 'item', id: 1, name: 'Rare sword', type: 'Weapon', rarity: 'Rare', level: 80,
		vendorValue: 500, flags: [], gameTypes: [], restrictions: [],
	};
}
