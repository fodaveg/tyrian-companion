import { createCatalogVendorValue, createTradingPostValueWithPolicy } from './gw2-fees';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { sha256CanonicalValue } from '../core/canonical-sha256';
import type { CommerceListingLevelV1 } from './commerce-listings';

export const EQUIPMENT_SALVAGE_MODEL_VERSION = 1 as const;
export const ECTOPLASM_ITEM_ID = 19_721 as const;
export const EQUIPMENT_SALVAGE_POLICY_V1_SHA256 = 'ed9b87c2d0677620aac71eb9fff96fcbb020e67b7e0a5b24eca4a6329bf38dc0' as const;

export type EquipmentSalvageKit = 'master' | 'mystic' | 'silver_fed';
export type EquipmentSalvageSaleStrategy = 'instant_sell' | 'listing';

export interface EquipmentSalvagePreferencesV1 {
	version: typeof EQUIPMENT_SALVAGE_MODEL_VERSION;
	kit: EquipmentSalvageKit | null;
	saleStrategy: EquipmentSalvageSaleStrategy | null;
	time: null | { secondsPerItem: number; opportunityCostCopperPerHour: number };
}

export interface EquipmentSalvagePolicyV1 {
	version: typeof EQUIPMENT_SALVAGE_MODEL_VERSION;
	id: string;
	publishedAt: string;
	validUntil: string;
	sources: Array<{ id: string; url: string; retrievedAt: string }>;
	outputItemId: typeof ECTOPLASM_ITEM_ID;
	outputSourceIds: string[];
	rules: [
		{
			ruleId: 'rare-equipment-68-ecto-v1';
			rarity: 'Rare';
			minimumLevel: 68;
			expectedOutputMillionths: 900_000;
			sourceIds: string[];
		},
		{
			ruleId: 'exotic-equipment-68-review-v1';
			rarity: 'Exotic';
			minimumLevel: 68;
			expectedOutputMillionths: null;
			sourceIds: string[];
		},
	];
	kits: Array<{
		id: EquipmentSalvageKit;
		costPerUseMicroCopper: number;
		rarerMaterialsBps: 2_500;
		upgradeSalvageBps: 8_000;
		costCoverage: 'complete' | 'excludes_mystic_forge_stones';
		sourceIds: string[];
	}>;
}

export interface EquipmentSalvageEconomyInputV1 {
	version: typeof EQUIPMENT_SALVAGE_MODEL_VERSION;
	asOf: string;
	item: CatalogItem;
	quantity: number;
	catalogCoverage: 'complete' | 'uncertain';
	priceCoverage: 'complete' | 'uncertain';
	market: {
		instantSellUnitCopper: number | null;
		listingUnitCopper: number | null;
		vendorUnitCopper: number | null;
	};
	output: {
		itemId: typeof ECTOPLASM_ITEM_ID;
		instantSellUnitCopper: number | null;
		instantSellLevels: CommerceListingLevelV1[] | null;
		listingUnitCopper: number | null;
	};
	policy: EquipmentSalvagePolicyV1;
	preferences: EquipmentSalvagePreferencesV1;
}

export type EquipmentSalvageReviewReason =
	| 'catalog_uncertain'
	| 'item_type_uncertain'
	| 'item_rarity_uncertain'
	| 'item_level_uncertain'
	| 'no_salvage'
	| 'policy_invalid_or_stale'
	| 'price_uncertain'
	| 'output_price_missing'
	| 'exotic_output_rate_unverified'
	| 'mystic_stone_cost_unmodeled'
	| 'arithmetic_overflow';

export interface EquipmentSalvageEconomicsV1 {
	ruleId: string;
	quantity: number;
	expectedOutputMillionths: number;
	outputItemId: typeof ECTOPLASM_ITEM_ID;
	outputStrategy: EquipmentSalvageSaleStrategy;
	outputStrategySource: 'configured' | 'conservative_lower_quote';
	grossOutputMicroCopper: number;
	kit: EquipmentSalvageKit;
	kitSource: 'configured' | 'conservative_master_default';
	kitCostMicroCopper: number;
	timeCostMicroCopper: number;
	timeCostSource: 'configured' | 'excluded_missing_preference';
	netSalvageMicroCopper: number;
	marketAlternatives: {
		instantSellCopper: number | null;
		listingCopper: number | null;
		vendorCopper: number | null;
		bestAction: 'sell' | 'list' | 'vendor' | null;
		bestCopper: number | null;
	};
	excludedOutputs: ['base_materials', 'luck', 'upgrade_returns'];
	sourceIds: string[];
}

export type EquipmentSalvageEconomyResultV1 =
	| { status: 'not_applicable'; reason: 'known_non_equipment' | 'rarity_out_of_scope' | 'level_below_68' }
	| { status: 'review'; reason: EquipmentSalvageReviewReason; ruleId: string | null }
	| { status: 'ready'; action: 'salvage' | 'market'; economics: EquipmentSalvageEconomicsV1 };

const EQUIPMENT_TYPES = new Set(['Armor', 'Back', 'Trinket', 'Weapon']);
const NON_EQUIPMENT_TYPES = new Set([
	'Bag', 'Consumable', 'Container', 'CraftingMaterial', 'Gathering', 'Gizmo', 'JadeTechModule',
	'Key', 'MiniPet', 'PowerCore', 'Relic', 'Tool', 'Trait', 'Trophy', 'UpgradeComponent',
]);
const KNOWN_RARITIES = new Set(['Junk', 'Basic', 'Fine', 'Masterwork', 'Rare', 'Exotic', 'Ascended', 'Legendary']);

/**
 * Compares a deliberately incomplete salvage lower bound with current liquid routes.
 * It never treats omitted base materials, luck, upgrades or Exotic-only outputs as zero-value evidence.
 */
export function evaluateEquipmentSalvageEconomy(value: unknown): EquipmentSalvageEconomyResultV1 {
	try {
		if (!isInput(value)) return { status: 'review', reason: 'policy_invalid_or_stale', ruleId: null };
		const { item, policy, preferences, quantity } = value;
		if (value.catalogCoverage !== 'complete') return review('catalog_uncertain');
		if (!EQUIPMENT_TYPES.has(item.type)) {
			return NON_EQUIPMENT_TYPES.has(item.type)
				? { status: 'not_applicable', reason: 'known_non_equipment' }
				: review('item_type_uncertain');
		}
		if (!KNOWN_RARITIES.has(item.rarity)) return review('item_rarity_uncertain');
		if (item.rarity !== 'Rare' && item.rarity !== 'Exotic') {
			return { status: 'not_applicable', reason: 'rarity_out_of_scope' };
		}
		if (!Number.isSafeInteger(item.level) || item.level < 0) return review('item_level_uncertain');
		if (item.level < 68) return { status: 'not_applicable', reason: 'level_below_68' };
		const rule = policy.rules.find((candidate) => candidate.rarity === item.rarity);
		if (rule === undefined) return review('policy_invalid_or_stale');
		if (item.flags.includes('NoSalvage')) return review('no_salvage', rule.ruleId);
		if (item.rarity === 'Exotic' || rule.expectedOutputMillionths === null) {
			return review('exotic_output_rate_unverified', rule.ruleId);
		}
		if (value.priceCoverage !== 'complete') return review('price_uncertain', rule.ruleId);

		const outputRoute = selectOutputRoute(
			value.output, preferences.saleStrategy, rule.expectedOutputMillionths * quantity,
		);
		if (outputRoute.status !== 'ready') return review(outputRoute.reason, rule.ruleId);
		const kit = preferences.kit ?? 'master';
		const kitModel = policy.kits.find((candidate) => candidate.id === kit);
		if (kitModel === undefined) return review('policy_invalid_or_stale', rule.ruleId);
		if (kitModel.costCoverage !== 'complete') return review('mystic_stone_cost_unmodeled', rule.ruleId);

		const grossOutput = outputRoute.grossOutputMicroCopper;
		const kitCost = safeBigInt(BigInt(kitModel.costPerUseMicroCopper) * BigInt(quantity));
		const timeCost = timeCostMicroCopper(preferences.time, quantity);
		if (kitCost === null || timeCost === null) {
			return review('arithmetic_overflow', rule.ruleId);
		}
		const netSalvage = grossOutput - kitCost - timeCost;
		if (!Number.isSafeInteger(netSalvage)) return review('arithmetic_overflow', rule.ruleId);
		const alternatives = marketAlternatives(value.market, item, quantity);
		if (alternatives === null) return review('arithmetic_overflow', rule.ruleId);
		const bestMarketMicroCopper = alternatives.bestCopper === null ? null : alternatives.bestCopper * 1_000_000;
		const action = bestMarketMicroCopper === null || netSalvage > bestMarketMicroCopper ? 'salvage' : 'market';
		return {
			status: 'ready',
			action,
			economics: {
				ruleId: rule.ruleId,
				quantity,
				expectedOutputMillionths: rule.expectedOutputMillionths,
				outputItemId: policy.outputItemId,
				outputStrategy: outputRoute.strategy,
				outputStrategySource: preferences.saleStrategy === null ? 'conservative_lower_quote' : 'configured',
				grossOutputMicroCopper: grossOutput,
				kit,
				kitSource: preferences.kit === null ? 'conservative_master_default' : 'configured',
				kitCostMicroCopper: kitCost,
				timeCostMicroCopper: timeCost,
				timeCostSource: preferences.time === null ? 'excluded_missing_preference' : 'configured',
				netSalvageMicroCopper: netSalvage,
				marketAlternatives: alternatives,
				excludedOutputs: ['base_materials', 'luck', 'upgrade_returns'],
				sourceIds: [...new Set([...policy.outputSourceIds, ...rule.sourceIds, ...kitModel.sourceIds])].sort(),
			},
		};
	} catch {
		return { status: 'review', reason: 'policy_invalid_or_stale', ruleId: null };
	}
}

export function isEquipmentSalvagePolicy(value: unknown): value is EquipmentSalvagePolicyV1 {
	if (!record(value) || !exactKeys(value, ['version', 'id', 'publishedAt', 'validUntil', 'sources', 'outputItemId', 'outputSourceIds', 'rules', 'kits'])
		|| value.version !== 1 || !identifier(value.id) || !iso(value.publishedAt) || !iso(value.validUntil)
		|| Date.parse(value.publishedAt) >= Date.parse(value.validUntil) || value.outputItemId !== ECTOPLASM_ITEM_ID
		|| !Array.isArray(value.sources) || !value.sources.every(source) || !sortedUnique(value.sources.map((entry) => entry.id))
		|| !stringList(value.outputSourceIds) || !sortedUnique(value.outputSourceIds)
		|| !Array.isArray(value.rules) || value.rules.length !== 2 || !value.rules.every(rule)
		|| !Array.isArray(value.kits) || value.kits.length !== 3 || !value.kits.every(kit)) return false;
	const policy = value as unknown as EquipmentSalvagePolicyV1;
	const sourceIds = policy.sources.map((entry) => entry.id);
	return policy.sources.every((entry) => Date.parse(entry.retrievedAt) <= Date.parse(policy.publishedAt))
		&& policy.outputSourceIds.length > 0
		&& policy.outputSourceIds.every((sourceId) => sourceIds.includes(sourceId))
		&& policy.rules.map((entry) => entry.rarity).join(',') === 'Rare,Exotic'
		&& policy.kits.map((entry) => entry.id).join(',') === 'master,mystic,silver_fed'
		&& [...policy.rules, ...policy.kits].every((entry) => entry.sourceIds.every((sourceId) => sourceIds.includes(sourceId)))
		&& sha256CanonicalValue(policy) === EQUIPMENT_SALVAGE_POLICY_V1_SHA256;
}

export function isEquipmentSalvagePreferences(value: unknown): value is EquipmentSalvagePreferencesV1 {
	return record(value) && exactKeys(value, ['version', 'kit', 'saleStrategy', 'time']) && value.version === 1
		&& (value.kit === null || (typeof value.kit === 'string'
			&& ['master', 'mystic', 'silver_fed'].includes(value.kit)))
		&& (value.saleStrategy === null || value.saleStrategy === 'instant_sell' || value.saleStrategy === 'listing')
		&& (value.time === null || (record(value.time) && exactKeys(value.time, ['secondsPerItem', 'opportunityCostCopperPerHour'])
			&& nonNegative(value.time.secondsPerItem) && nonNegative(value.time.opportunityCostCopperPerHour)
			&& value.time.secondsPerItem <= 3_600 && value.time.opportunityCostCopperPerHour <= 100_000_000));
}

function isInput(value: unknown): value is EquipmentSalvageEconomyInputV1 {
	if (!record(value) || !exactKeys(value, ['version', 'asOf', 'item', 'quantity', 'catalogCoverage', 'priceCoverage', 'market', 'output', 'policy', 'preferences'])
		|| value.version !== 1 || !iso(value.asOf) || !catalogItem(value.item) || !positive(value.quantity)
		|| !['complete', 'uncertain'].includes(String(value.catalogCoverage))
		|| !['complete', 'uncertain'].includes(String(value.priceCoverage))
		|| !quotes(value.market, ['instantSellUnitCopper', 'listingUnitCopper', 'vendorUnitCopper'])
		|| !salvageOutput(value.output)
		|| value.output.itemId !== ECTOPLASM_ITEM_ID || !isEquipmentSalvagePolicy(value.policy)
		|| !isEquipmentSalvagePreferences(value.preferences)) return false;
	return Date.parse(value.asOf) >= Date.parse(value.policy.publishedAt)
		&& Date.parse(value.asOf) < Date.parse(value.policy.validUntil);
}

function marketAlternatives(
	market: EquipmentSalvageEconomyInputV1['market'],
	item: CatalogItem,
	quantity: number,
): EquipmentSalvageEconomicsV1['marketAlternatives'] | null {
	if (market.vendorUnitCopper !== null && market.vendorUnitCopper !== item.vendorValue) return null;
	const instant = market.instantSellUnitCopper === null ? null
		: createTradingPostValueWithPolicy('instant_sell', market.instantSellUnitCopper, quantity);
	const listing = market.listingUnitCopper === null ? null
		: createTradingPostValueWithPolicy('listing', market.listingUnitCopper, quantity);
	const vendor = market.vendorUnitCopper === null ? null : createCatalogVendorValue(item, quantity);
	if (instant?.status === 'invalid' || listing?.status === 'invalid' || vendor?.status === 'invalid') return null;
	const candidates = [
		instant?.status === 'ok' ? { action: 'sell' as const, copper: instant.value.netCopper } : null,
		listing?.status === 'ok' ? { action: 'list' as const, copper: listing.value.netCopper } : null,
		vendor?.status === 'ok' ? { action: 'vendor' as const, copper: vendor.value.netCopper } : null,
	].filter((entry): entry is NonNullable<typeof entry> => entry !== null)
		.sort((left, right) => right.copper - left.copper || left.action.localeCompare(right.action));
	return {
		instantSellCopper: instant?.status === 'ok' ? instant.value.netCopper : null,
		listingCopper: listing?.status === 'ok' ? listing.value.netCopper : null,
		vendorCopper: vendor?.status === 'ok' ? vendor.value.netCopper : null,
		bestAction: candidates[0]?.action ?? null,
		bestCopper: candidates[0]?.copper ?? null,
	};
}

function selectOutputRoute(
	output: EquipmentSalvageEconomyInputV1['output'],
	strategy: EquipmentSalvageSaleStrategy | null,
	expectedOutputMicroQuantity: number,
): { status: 'ready'; strategy: EquipmentSalvageSaleStrategy; grossOutputMicroCopper: number }
	| { status: 'review'; reason: 'output_price_missing' | 'arithmetic_overflow' } {
	const instant = instantSellOutputValue(output, expectedOutputMicroQuantity);
	const listing = listingOutputValue(output.listingUnitCopper, expectedOutputMicroQuantity);
	if (strategy !== null) {
		const selected = strategy === 'instant_sell' ? instant : listing;
		return selected.status === 'ready' ? { ...selected, strategy } : selected;
	}
	if (output.instantSellUnitCopper !== null && instant.status === 'review') return instant;
	const candidates = [
		instant.status === 'ready' ? { ...instant, strategy: 'instant_sell' as const } : null,
		listing.status === 'ready' ? { ...listing, strategy: 'listing' as const } : null,
	].filter((entry): entry is NonNullable<typeof entry> => entry !== null)
		.sort((left, right) => left.grossOutputMicroCopper - right.grossOutputMicroCopper
			|| left.strategy.localeCompare(right.strategy));
	if (candidates[0] !== undefined) return candidates[0];
	return (instant.status === 'review' && instant.reason === 'arithmetic_overflow')
		|| (listing.status === 'review' && listing.reason === 'arithmetic_overflow')
		? { status: 'review', reason: 'arithmetic_overflow' }
		: { status: 'review', reason: 'output_price_missing' };
}

function instantSellOutputValue(
	output: EquipmentSalvageEconomyInputV1['output'],
	expectedOutputMicroQuantity: number,
): { status: 'ready'; grossOutputMicroCopper: number }
	| { status: 'review'; reason: 'output_price_missing' | 'arithmetic_overflow' } {
	if (output.instantSellUnitCopper === null) return { status: 'review', reason: 'output_price_missing' };
	if (output.instantSellLevels === null) return { status: 'review', reason: 'output_price_missing' };
	let remaining = BigInt(expectedOutputMicroQuantity);
	let total = 0n;
	for (const level of output.instantSellLevels) {
		const value = createTradingPostValueWithPolicy('instant_sell', level.unitCopper, 1);
		if (value.status !== 'ok') return { status: 'review', reason: 'arithmetic_overflow' };
		const take = remaining < BigInt(level.quantity) * 1_000_000n
			? remaining : BigInt(level.quantity) * 1_000_000n;
		total += BigInt(value.value.netCopper) * take;
		remaining -= take;
		if (remaining === 0n) break;
	}
	if (remaining > 0n) return { status: 'review', reason: 'output_price_missing' };
	const grossOutputMicroCopper = safeBigInt(total);
	return grossOutputMicroCopper === null ? { status: 'review', reason: 'arithmetic_overflow' }
		: { status: 'ready', grossOutputMicroCopper };
}

function listingOutputValue(
	unitCopper: number | null,
	expectedOutputMicroQuantity: number,
): { status: 'ready'; grossOutputMicroCopper: number }
	| { status: 'review'; reason: 'output_price_missing' | 'arithmetic_overflow' } {
	if (unitCopper === null) return { status: 'review', reason: 'output_price_missing' };
	const value = createTradingPostValueWithPolicy('listing', unitCopper, 1);
	if (value.status !== 'ok') return { status: 'review', reason: 'arithmetic_overflow' };
	const grossOutputMicroCopper = safeBigInt(BigInt(value.value.netCopper) * BigInt(expectedOutputMicroQuantity));
	return grossOutputMicroCopper === null ? { status: 'review', reason: 'arithmetic_overflow' }
		: { status: 'ready', grossOutputMicroCopper };
}

function timeCostMicroCopper(time: EquipmentSalvagePreferencesV1['time'], quantity: number): number | null {
	if (time === null) return 0;
	return safeBigInt(BigInt(time.secondsPerItem) * BigInt(time.opportunityCostCopperPerHour)
		* BigInt(quantity) * 1_000_000n / 3_600n);
}

function review(reason: EquipmentSalvageReviewReason, ruleId: string | null = null): EquipmentSalvageEconomyResultV1 {
	return { status: 'review', reason, ruleId };
}

function safeBigInt(value: bigint): number | null {
	return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function catalogItem(value: unknown): value is CatalogItem {
	return record(value) && value.kind === 'item' && positive(value.id) && typeof value.name === 'string'
		&& typeof value.type === 'string' && typeof value.rarity === 'string' && nonNegative(value.level)
		&& nonNegative(value.vendorValue) && Array.isArray(value.flags) && value.flags.every((entry) => typeof entry === 'string');
}

function source(value: unknown): value is EquipmentSalvagePolicyV1['sources'][number] {
	return record(value) && exactKeys(value, ['id', 'url', 'retrievedAt']) && identifier(value.id)
		&& typeof value.url === 'string' && value.url.startsWith('https://') && iso(value.retrievedAt);
}

function rule(value: unknown): boolean {
	return record(value) && exactKeys(value, ['ruleId', 'rarity', 'minimumLevel', 'expectedOutputMillionths', 'sourceIds'])
		&& (value.ruleId === 'rare-equipment-68-ecto-v1' || value.ruleId === 'exotic-equipment-68-review-v1')
		&& (value.rarity === 'Rare' || value.rarity === 'Exotic') && value.minimumLevel === 68
		&& (value.rarity === 'Rare' ? value.expectedOutputMillionths === 900_000 : value.expectedOutputMillionths === null)
		&& Array.isArray(value.sourceIds) && value.sourceIds.length > 0
		&& value.sourceIds.every((entry) => typeof entry === 'string') && sortedUnique(value.sourceIds);
}

function kit(value: unknown): boolean {
	return record(value) && exactKeys(value, ['id', 'costPerUseMicroCopper', 'rarerMaterialsBps', 'upgradeSalvageBps', 'costCoverage', 'sourceIds'])
		&& typeof value.id === 'string' && ['master', 'mystic', 'silver_fed'].includes(value.id)
		&& positive(value.costPerUseMicroCopper)
		&& value.rarerMaterialsBps === 2_500 && value.upgradeSalvageBps === 8_000
		&& (value.costCoverage === 'complete' || (value.id === 'mystic' && value.costCoverage === 'excludes_mystic_forge_stones'))
		&& Array.isArray(value.sourceIds) && value.sourceIds.length > 0
		&& value.sourceIds.every((entry) => typeof entry === 'string') && sortedUnique(value.sourceIds);
}

function quotes(value: unknown, expected: string[]): value is Record<string, number | null> {
	return record(value) && exactKeys(value, expected)
		&& expected.filter((key) => key !== 'itemId').every((key) => value[key] === null || positive(value[key]));
}

function salvageOutput(value: unknown): value is EquipmentSalvageEconomyInputV1['output'] {
	if (!record(value) || !exactKeys(value, [
		'itemId', 'instantSellUnitCopper', 'instantSellLevels', 'listingUnitCopper',
	]) || value.itemId !== ECTOPLASM_ITEM_ID
		|| (value.instantSellUnitCopper !== null && !positive(value.instantSellUnitCopper))
		|| (value.listingUnitCopper !== null && !positive(value.listingUnitCopper))
		|| (value.instantSellLevels !== null && (!Array.isArray(value.instantSellLevels)
			|| !value.instantSellLevels.every((level) => record(level) && exactKeys(level, ['unitCopper', 'quantity'])
				&& positive(level.unitCopper) && positive(level.quantity))))) return false;
	if (value.instantSellLevels === null) return true;
	const levels = value.instantSellLevels as CommerceListingLevelV1[];
	if (!levels.every((level, index) => index === 0 || levels[index - 1]!.unitCopper > level.unitCopper)) return false;
	return levels.length === 0 ? value.instantSellUnitCopper === null
		: value.instantSellUnitCopper === levels[0]!.unitCopper;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sortedUnique(values: string[]): boolean {
	return values.every((entry, index) => index === 0 || values[index - 1]!.localeCompare(entry) < 0);
}
