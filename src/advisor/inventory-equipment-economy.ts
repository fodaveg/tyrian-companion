import {
	ECTOPLASM_ITEM_ID,
	evaluateEquipmentSalvageEconomy,
	type EquipmentSalvageEconomyResultV1,
} from '../economy/equipment-salvage-economy';
import { classifyItemLiquidity } from '../economy/item-liquidity';
import { isApprovedApplicableCapability } from './inventory-advisor-contract';
import type {
	InventoryAdvisorEngineInputV1 as EngineInput,
	InventoryKnowledgeEntryV1,
} from './inventory-advisor-classifier-model';
import type { InventoryAdvisorInputV1, InventoryAdvisorPositionV1 } from './inventory-advisor-model';

/**
 * Adapts already captured inventory evidence to the pure equipment economy model.
 * The adapter is data-only and exposes no salvage operation or account capability.
 */
export function evaluateInventoryEquipmentEconomy(
	input: InventoryAdvisorInputV1,
	knowledge: InventoryKnowledgeEntryV1 | undefined,
	itemId: number,
	quantity: number,
	positions: InventoryAdvisorPositionV1[],
	evidenceReady: boolean,
	context: EngineInput['equipmentSalvage'],
): EquipmentSalvageEconomyResultV1 | null {
	if (context === undefined) return null;
	const hasSpecificCapability = [knowledge?.use, knowledge?.open, knowledge?.salvage]
		.some((claim) => claim?.status === 'applicable')
		|| input.rulePack.rules.some((rule) => rule.itemId === itemId
			&& isApprovedApplicableCapability(input.rulePack, rule));
	if (hasSpecificCapability) return null;
	const item = input.catalog.items[String(itemId)];
	if (item === undefined) return { status: 'review', reason: 'catalog_uncertain', ruleId: null };
	const price = input.prices.items.find((entry) => entry.itemId === itemId);
	const ectoplasm = context.prices?.items.find((entry) => entry.itemId === ECTOPLASM_ITEM_ID);
	const catalogEvidence = input.catalog.coverage.items[String(itemId)];
	const catalogComplete = catalogEvidence?.status === 'resolved'
		&& ['network', 'cache_fresh'].includes(catalogEvidence.source)
		&& fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs);
	const priceComplete = evidenceReady && input.prices.status === 'complete'
		&& input.prices.requestedItemIds.includes(itemId)
		&& context.prices?.status === 'complete'
		&& context.prices.requestedItemIds.length === 1
		&& context.prices.requestedItemIds[0] === ECTOPLASM_ITEM_ID
		&& ectoplasm !== undefined
		&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(context.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
		&& input.accountSignals.tradingPostAccess !== 'unknown'
		&& (input.accountSignals.tradingPostAccess !== 'free_to_play' || ectoplasm.whitelisted);
	const liquidity = positions.map((position) => {
		const holding = input.snapshot.holdings[position.holdingIndex];
		return classifyItemLiquidity(holding, item, price === undefined ? 'missing' : 'available');
	});
	const tradingPost = liquidity.length > 0 && liquidity.every((entry) => entry.status === 'ok'
		&& entry.classification.tradingPost.status === 'eligible')
		&& input.accountSignals.tradingPostAccess !== 'unknown'
		&& (input.accountSignals.tradingPostAccess !== 'free_to_play' || price?.whitelisted === true);
	const vendor = liquidity.length > 0 && liquidity.every((entry) => entry.status === 'ok'
		&& entry.classification.vendor.status === 'eligible');
	return evaluateEquipmentSalvageEconomy({
		version: 1,
		asOf: input.asOf,
		item,
		quantity,
		catalogCoverage: catalogComplete ? 'complete' : 'uncertain',
		priceCoverage: priceComplete ? 'complete' : 'uncertain',
		market: {
			instantSellUnitCopper: tradingPost ? price?.bid?.unitCopper ?? null : null,
			listingUnitCopper: tradingPost ? price?.ask?.unitCopper ?? null : null,
			vendorUnitCopper: vendor ? item.vendorValue : null,
		},
		output: {
			itemId: ECTOPLASM_ITEM_ID,
			instantSellUnitCopper: ectoplasm?.bid?.unitCopper ?? null,
			listingUnitCopper: ectoplasm?.ask?.unitCopper ?? null,
		},
		policy: context.policy,
		preferences: context.preferences,
	});
}

function fresh(capturedAt: string, asOf: string, maxAge: number, maxFutureSkew: number): boolean {
	const delta = Date.parse(asOf) - Date.parse(capturedAt);
	return Number.isSafeInteger(delta) && delta <= maxAge && delta >= -maxFutureSkew;
}
