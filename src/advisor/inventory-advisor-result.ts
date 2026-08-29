import {
	isInventoryRecommendationEnvelope,
	type InventoryRecommendationEnvelopeV1,
} from '../economy/inventory-recommendation-envelope';
import {
	isInventoryAdvisorInput,
	isInventoryAdvisorReason,
	isInventoryAdvisorReport,
	isApprovedApplicableCapability,
	isEnabledApplicableRule,
	sha256InventoryAdvisorReport,
} from './inventory-advisor-contract';
import type {
	InventoryAdvisorInputV1,
	InventoryAdvisorExplanationV1,
	InventoryAdvisorLineV1,
	InventoryAdvisorReasonCode,
	InventoryAdvisorResultV1,
	InventoryRecommendationDecisionV1,
} from './inventory-advisor-model';
import { buildInventoryAdvisorReservationBalance, createReservationPlan } from '../economy/reservation';
import { classifyItemLiquidity } from '../economy/item-liquidity';
import { selectInventoryMarketRoute } from './inventory-advisor-market';
import { isInventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import type { InventoryAdvisorEngineInputV1 } from './inventory-advisor-classifier-model';
import { evaluateInventoryContainerEconomy } from './inventory-container-economy';
import type { ContainerPersonalValuationV1 } from '../economy/container-personal-valuation';
import { isActiveTradingPostOrdersEvidence, type ActiveTradingPostOrdersEvidenceV1 } from '../account/trading-post-orders-model';
import { isInventoryMarketDepthEvidence, type InventoryMarketDepthEvidenceV1 } from '../economy/commerce-listings';
import { materialStorageDepositsFit } from '../economy/material-storage-deposit-validation';

export function isInventoryAdvisorResult(value: unknown): value is InventoryAdvisorResultV1 {
	try { return isInventoryAdvisorResultUnsafe(value); } catch { return false; }
}

function isInventoryAdvisorResultUnsafe(value: unknown): value is InventoryAdvisorResultV1 {
	if (!record(value) || typeof value.status !== 'string') return false;
	if (value.status === 'invalid') {
		return keys(value, ['status', 'reasons', 'report', 'envelope'])
			&& Array.isArray(value.reasons) && value.reasons.every(isInventoryAdvisorReason)
			&& value.report === null && value.envelope === null;
	}
	if (!['ready', 'limited', 'blocked'].includes(value.status)
		|| !keys(value, ['status', 'report', 'envelope'])
		|| !isInventoryAdvisorReport(value.report)
		|| !isInventoryRecommendationEnvelope(value.envelope)) return false;
	const report = value.report;
	const envelope = value.envelope;
	if (!materialStorageDepositsFit(report.lines.flatMap((line) => line.decisions))
		|| report.accountId !== envelope.accountId || report.snapshotId !== envelope.snapshotId
		|| sha256InventoryAdvisorReport(report) !== envelope.reportSha256
		|| !sameRulePack(report.rulePack, envelope.rulePack)
		|| canonical(report.lines.flatMap((line) => line.decisions)) !== canonical(envelope.decisions)) return false;
	if (value.status === 'ready') return report.coverage === 'complete';
	if (value.status === 'limited') return report.coverage === 'limited';
	return report.coverage === 'blocked'
		&& envelope.decisions.every((decision) => decision.action === 'keep' || decision.action === 'review');
}

export function isInventoryAdvisorResultForInput(
	value: unknown,
	input: unknown,
	knowledgePack?: unknown,
	containerEconomy?: InventoryAdvisorEngineInputV1['containerEconomy'],
	personalValuation?: ContainerPersonalValuationV1,
	activeOrders?: ActiveTradingPostOrdersEvidenceV1,
	materialStorageCapacity?: InventoryAdvisorEngineInputV1['materialStorageCapacity'],
	marketDepth?: InventoryMarketDepthEvidenceV1,
): value is InventoryAdvisorResultV1 {
	try {
		return isInventoryAdvisorResultForInputUnsafe(
			value, input, knowledgePack, containerEconomy, personalValuation, activeOrders, materialStorageCapacity, marketDepth,
		);
	} catch { return false; }
}

function isInventoryAdvisorResultForInputUnsafe(
	value: unknown,
	input: unknown,
	knowledgePack: unknown,
	containerEconomy: InventoryAdvisorEngineInputV1['containerEconomy'],
	personalValuation: ContainerPersonalValuationV1 | undefined,
	activeOrders: ActiveTradingPostOrdersEvidenceV1 | undefined,
	materialStorageCapacity: InventoryAdvisorEngineInputV1['materialStorageCapacity'],
	marketDepth: InventoryMarketDepthEvidenceV1 | undefined,
): value is InventoryAdvisorResultV1 {
	if (!isInventoryAdvisorInput(input) || !isInventoryAdvisorResult(value)) return false;
	if (activeOrders !== undefined && (!isActiveTradingPostOrdersEvidence(activeOrders)
		|| activeOrders.accountId !== input.snapshot.accountId
		|| !fresh(activeOrders.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
			input.policy.maxFutureSkewMs))) return false;
	if (materialStorageCapacity !== undefined && !validMaterialStorageCapacity(materialStorageCapacity)) return false;
	if (marketDepth !== undefined && (!isInventoryMarketDepthEvidence(marketDepth)
		|| marketDepth.requestedItemIds.length !== input.prices.requestedItemIds.length
		|| !marketDepth.requestedItemIds.every((itemId, index) => itemId === input.prices.requestedItemIds[index])
		|| !fresh(marketDepth.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs))) return false;
	if (input.rulePack.schemaVersion === 2 && (!isInventoryKnowledgePack(knowledgePack)
		|| knowledgePack.sha256 !== input.rulePack.knowledgePackSha256)) return false;
	if (value.status === 'invalid') return true;
	const report = value.report;
	if (report.accountId !== input.snapshot.accountId || report.snapshotId !== input.snapshot.snapshotId
		|| report.asOf !== input.asOf || canonical(report.rulePack) !== canonical(input.rulePack)) return false;
	const balanceResult = buildInventoryAdvisorReservationBalance(input.snapshot);
	if (balanceResult.status !== 'ok') return false;
	const planResult = createReservationPlan({ goals: input.goals, balance: balanceResult.balance });
	if (planResult.status !== 'ok') return false;
	const planAssets = new Map(planResult.plan.assets.map((asset) => [asset.key, asset]));
	const expectedIds = Object.entries(input.snapshot.ownedByItem)
		.filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort((left, right) => left - right);
	if (report.lines.length !== expectedIds.length
		|| report.lines.some((line, index) => line.itemId !== expectedIds[index])) return false;
	for (const line of report.lines) {
		if (activeOrders !== undefined) {
			const buyConflict = activeOrders.endpointCoverage.buy.status === 'complete'
				&& activeOrders.orders.some((order) => order.side === 'buy' && order.itemId === line.itemId);
			const sellConflict = activeOrders.endpointCoverage.sell.status === 'complete'
				&& activeOrders.orders.some((order) => order.side === 'sell' && order.itemId === line.itemId);
			if ((buyConflict && line.decisions.some((decision) => decision.action === 'sell'))
				|| (sellConflict && line.decisions.some((decision) => decision.action === 'list'))) return false;
		}
		if (line.ownedQuantity !== input.snapshot.ownedByItem[String(line.itemId)]
			|| line.availableQuantity !== (input.snapshot.availableByItem[String(line.itemId)] ?? 0)) return false;
		const expectedPositions = input.snapshot.holdings
			.map((holding, holdingIndex) => ({ holding, holdingIndex }))
			.filter(({ holding }) => holding.kind === 'item' && holding.itemId === line.itemId);
		if (line.positions.length !== expectedPositions.length) return false;
		for (let index = 0; index < line.positions.length; index += 1) {
			const position = line.positions[index]!;
			const expected = expectedPositions[index]!;
			if (expected.holding.kind !== 'item' || position.holdingIndex !== expected.holdingIndex
				|| position.ref !== `#/positions/${line.itemId}/${expected.holdingIndex}`
				|| position.quantity !== expected.holding.quantity
				|| position.source !== expected.holding.location.source
				|| position.state !== expected.holding.state) return false;
		}
		const reserved = planAssets.get(`item:${line.itemId}`)?.protectedAvailable ?? 0;
		const planAsset = planAssets.get(`item:${line.itemId}`);
		if (line.reservedQuantity !== reserved) return false;
		let remaining = line.availableQuantity - reserved;
		let expectedException = 0;
		for (const exception of input.keepExceptions.filter((candidate) => candidate.status === 'active'
			&& candidate.itemId === line.itemId)) {
			const requested = exception.quantity.mode === 'all' ? remaining : exception.quantity.value;
			const allocated = Math.min(requested, remaining);
			expectedException += allocated;
			remaining -= allocated;
		}
		if (line.exceptionQuantity !== expectedException) return false;
		const expectedRetained = line.decisions.filter((decision) => decision.action === 'keep')
			.reduce((total, decision) => total + decision.quantity, 0) - reserved - expectedException;
		if (line.retainedQuantity !== expectedRetained) return false;
		const catalogCoverage = input.catalog.coverage.items[String(line.itemId)];
		const catalogComplete = catalogCoverage?.status === 'resolved'
			&& ['network', 'cache_fresh'].includes(catalogCoverage.source)
			&& fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs);
		const depthItem = marketDepth?.items.find((entry) => entry.itemId === line.itemId);
		const pricesComplete = input.prices.requestedItemIds.includes(line.itemId)
			&& (input.prices.items.some((entry) => entry.itemId === line.itemId)
				|| input.prices.missingItemIds.includes(line.itemId))
			&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
				input.policy.maxFutureSkewMs);
		const signalsFresh = fresh(input.accountSignals.capturedAt, input.asOf,
			input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs);
		const signalsComplete = signalsFresh && input.accountSignals.unlockCoverage === 'complete'
			&& input.accountSignals.achievementCoverage === 'complete'
			&& input.accountSignals.tradingPostAccess !== 'unknown';
		const rulesComplete = rulePackFresh(input)
			&& Date.parse(input.asOf) <= Date.parse(input.rulePack.validUntil) + input.policy.maxFutureSkewMs;
		const expectedCoverage = {
			snapshot: snapshotComplete(input.snapshot) ? 'complete' : 'limited',
			inventory: planAsset?.coverage === 'complete' ? 'complete' : planAsset?.coverage === 'limited' ? 'limited' : 'unknown',
			catalog: catalogComplete ? 'complete' : catalogCoverage ? 'limited' : 'unknown',
			prices: pricesComplete ? 'complete'
				: input.prices.status === 'partial' ? 'limited' : 'unknown',
			reservations: planAsset?.coverage === 'complete' ? 'complete' : planAsset?.coverage === 'limited' ? 'limited' : 'unknown',
			accountSignals: signalsComplete ? 'complete' : signalsFresh ? 'limited' : 'unknown',
			rules: rulesComplete ? 'complete' : 'limited',
		};
		if (canonical(line.coverage) !== canonical(expectedCoverage)) return false;
		const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
		const sold = line.decisions.filter((decision) => decision.action === 'sell')
			.reduce((total, decision) => total + decision.quantity, 0);
		const demonstratedBid = depthItem?.coverage === 'complete'
			? depthItem.buys.reduce((total, level) => total + level.quantity, 0)
			: price?.bid?.quantity ?? 0;
		if (!Number.isSafeInteger(demonstratedBid) || sold > demonstratedBid) return false;
		let remainingBid = demonstratedBid;
		for (const decision of line.decisions) {
			const explanation = report.explanations.find((entry) => entry.ref === decision.explanationRef);
			const withheld = withheldEconomicReason(input, knowledgePack as InventoryKnowledgePackV1 | undefined, decision, line.itemId);
			const explained = explanation?.reasonCodes.length === 1
				&& ['economic_comparison_missing', 'economic_activation_pending'].includes(explanation.reasonCodes[0]!)
				? explanation.reasonCodes[0] : null;
			if (input.rulePack.schemaVersion === 2 && withheld !== explained) return false;
			const requiresEconomicReproduction = requiresContainerEconomyReproduction(
				decision, line.itemId, input, knowledgePack as InventoryKnowledgePackV1 | undefined,
			);
			if (requiresEconomicReproduction) {
				if (!validEconomicDecisionAgainstInput(decision, line, input,
					knowledgePack as InventoryKnowledgePackV1 | undefined, containerEconomy,
					personalValuation, report.explanations)) return false;
			} else if (!validDecisionAgainstInput(decision, line, input, reserved, expectedException,
				remainingBid, explanation?.reasonCodes ?? [], materialStorageCapacity, depthItem)) return false;
			if (decision.action === 'sell') remainingBid -= decision.quantity;
		}
	}
	return true;
}

function requiresContainerEconomyReproduction(
	decision: InventoryRecommendationDecisionV1,
	itemId: number,
	input: InventoryAdvisorInputV1,
	knowledgePack: InventoryKnowledgePackV1 | undefined,
): boolean {
	if (input.rulePack.schemaVersion !== 2 || !knowledgePack
		|| !['open', 'sell', 'vendor'].includes(decision.action)) return false;
	const claim = knowledgePack.entries.find((entry) => entry.itemId === itemId)?.open;
	if (claim?.status !== 'applicable') return false;
	return input.rulePack.rules.some((rule) => rule.ruleId === claim.ruleId && rule.itemId === itemId
		&& rule.action === 'open' && isEnabledApplicableRule(input.rulePack, rule));
}

function validEconomicDecisionAgainstInput(
	decision: InventoryRecommendationDecisionV1,
	line: InventoryAdvisorLineV1,
	input: InventoryAdvisorInputV1,
	knowledgePack: InventoryKnowledgePackV1 | undefined,
	economy: InventoryAdvisorEngineInputV1['containerEconomy'],
	personalValuation: ContainerPersonalValuationV1 | undefined,
	explanations: InventoryAdvisorExplanationV1[],
): boolean {
	if (!economy || !knowledgePack || input.rulePack.schemaVersion !== 2
		|| !snapshotComplete(input.snapshot)
		|| !['open', 'sell', 'vendor'].includes(decision.action)
		|| economy.pack.model.containerItemId !== line.itemId) return false;
	const economicDecisions = line.decisions.filter((candidate) => !['keep', 'review'].includes(candidate.action));
	if (economicDecisions.length !== 1 || economicDecisions[0] !== decision) return false;
	const availableRefs = new Set(line.positions.filter((position) => position.state === 'loose'
		|| position.state === 'pending_claim').map((position) => position.ref));
	const availableQuantity = (predicate: (candidate: InventoryRecommendationDecisionV1) => boolean): number => line.decisions
		.filter(predicate).flatMap((candidate) => candidate.allocations)
		.filter((allocation) => availableRefs.has(allocation.positionRef))
		.reduce((total, allocation) => total + allocation.quantity, 0);
	const reasonCodes = (candidate: InventoryRecommendationDecisionV1): InventoryAdvisorReasonCode[] => explanations
		.find((explanation) => explanation.ref === candidate.explanationRef)?.reasonCodes ?? [];
	const reserved = availableQuantity((candidate) => reasonCodes(candidate).includes('reserved_for_goal'));
	const exceptionQuantity = availableQuantity((candidate) => reasonCodes(candidate).includes('user_keep_exception'));
	const freeQuantity = availableQuantity((candidate) => candidate === decision);
	const reviewQuantity = availableQuantity((candidate) => candidate !== decision
		&& !reasonCodes(candidate).includes('reserved_for_goal')
		&& !reasonCodes(candidate).includes('user_keep_exception'));
	if (freeQuantity <= 0 || decision.quantity !== freeQuantity
		|| reserved + exceptionQuantity + reviewQuantity + freeQuantity !== line.availableQuantity) return false;
	const item = input.catalog.items[String(line.itemId)];
	if (!item) return false;
	const bagPrice = economy.prices.items.find((entry) => entry.itemId === line.itemId);
	const priceStatus = bagPrice?.bid === null || bagPrice === undefined ? 'missing' : 'available';
	const bindings = decision.allocations.map((allocation) => {
		const position = line.positions.find((candidate) => candidate.ref === allocation.positionRef);
		const holding = position ? input.snapshot.holdings[position.holdingIndex] : undefined;
		const liquidity = classifyItemLiquidity(holding, item, priceStatus);
		return liquidity.status === 'ok' ? liquidity.classification.binding.kind : 'unknown';
	});
	const binding = bindings.length > 0 && bindings.every((entry) => entry === bindings[0]) ? bindings[0]! : 'unknown';
	const result = evaluateInventoryContainerEconomy({
		version: 1,
		asOf: input.asOf,
		accountId: input.snapshot.accountId,
		snapshotId: input.snapshot.snapshotId,
		schemaVersion: input.snapshot.schemaVersion,
		allocation: {
			ownedQuantity: line.ownedQuantity,
			availableQuantity: line.availableQuantity,
			reservedQuantity: reserved,
			exceptionQuantity,
			reviewQuantity,
			freeQuantity,
		},
		container: { itemId: line.itemId, catalogItem: item, binding,
			tradingAccess: input.accountSignals.tradingPostAccess },
		rulePack: input.rulePack,
		knowledgePackSha256: knowledgePack.sha256,
		economyPack: economy.pack,
		prices: economy.prices,
		...(personalValuation === undefined ? {} : { personalValuation }),
	});
	return result.status === 'ready' && result.decision.action === decision.action
		&& result.decision.quantity === decision.quantity && result.decision.ruleId === decision.ruleId;
}

/** V2 economic withholding is derivable only from the exact rule and bound knowledge payload. */
function withheldEconomicReason(
	input: InventoryAdvisorInputV1,
	knowledgePack: InventoryKnowledgePackV1 | undefined,
	decision: InventoryRecommendationDecisionV1,
	itemId: number,
): 'economic_comparison_missing' | 'economic_activation_pending' | null {
	if (input.rulePack.schemaVersion !== 2 || !knowledgePack || decision.action !== 'review' || decision.ruleId !== null) return null;
	if (Date.parse(input.asOf) < Date.parse(input.rulePack.publishedAt) || Date.parse(input.asOf) >= Date.parse(input.rulePack.validUntil)) return null;
	const entry = knowledgePack.entries.find((candidate) => candidate.itemId === itemId);
	if (!entry) return null;
	for (const action of ['use', 'open', 'salvage'] as const) {
		const claim = entry[action];
		if (claim === null) return null;
		const capabilities = input.rulePack.rules.filter((candidate) => candidate.itemId === itemId
			&& candidate.action === action && candidate.status === 'approved' && candidate.capability === 'applicable');
		if (capabilities.length > 1 || (claim.status === 'not_applicable' && capabilities.length > 0)) return null;
		if (claim.status === 'not_applicable') continue;
		if (action === 'salvage' && input.catalog.items[String(itemId)]?.flags.includes('NoSalvage')) return null;
		const rule = capabilities.find((candidate) => candidate.ruleId === claim.ruleId);
		if (!rule) return null;
		if (rule.recommendation.status === 'review_only') return rule.recommendation.reason;
		return null;
	}
	return null;
}

function validDecisionAgainstInput(
	decision: InventoryRecommendationDecisionV1,
	line: InventoryAdvisorLineV1,
	input: InventoryAdvisorInputV1,
	reserved: number,
	exceptionQuantity: number,
	remainingBid: number,
	reasonCodes: InventoryAdvisorReasonCode[],
	materialStorageCapacity: InventoryAdvisorEngineInputV1['materialStorageCapacity'],
	marketDepth: InventoryMarketDepthEvidenceV1['items'][number] | undefined,
): boolean {
	if (decision.action === 'keep' || decision.action === 'review') return true;
	const item = input.catalog.items[String(line.itemId)];
	const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
	const catalogCoverage = input.catalog.coverage.items[String(line.itemId)];
	if (!item || catalogCoverage?.status !== 'resolved' || !['network', 'cache_fresh'].includes(catalogCoverage.source)
		|| !fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs,
		input.policy.maxFutureSkewMs)) return false;
	const holdings = decision.allocations.map((allocation) => input.snapshot.holdings[allocationPositionIndex(allocation.positionRef)]);
	if (holdings.some((holding) => holding?.kind !== 'item')) return false;
	if (decision.action === 'deposit_material') {
		return validMaterialDeposit(decision, line, input, holdings, reasonCodes, materialStorageCapacity);
	}
	if (decision.action === 'discard_candidate') {
		return validDiscardAgainstInput(decision, line, input, reserved, exceptionQuantity);
	}
	if (decision.action === 'sell' || decision.action === 'list') {
		if (!price || !input.prices.requestedItemIds.includes(line.itemId)
			|| !fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
			|| input.accountSignals.tradingPostAccess === 'unknown'
			|| (input.accountSignals.tradingPostAccess === 'free_to_play' && !price.whitelisted)) return false;
		const side = decision.action === 'sell' ? price.bid : price.ask;
		if ((marketDepth === undefined && side === null) || !holdings.every((holding) => {
			const result = classifyItemLiquidity(holding, item, 'available');
			return result.status === 'ok' && result.classification.tradingPost.status === 'eligible';
		})) return false;
		const holding = holdings[0];
		if (!holding || holding.kind !== 'item') return false;
		const selection = selectInventoryMarketRoute({ holding, item, price, marketDepth,
			tradingPostAccess: input.accountSignals.tradingPostAccess, quantity: decision.quantity,
			allowSell: remainingBid >= decision.quantity, listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps });
		return selection.action === decision.action && reasonCodes.length === 1 && reasonCodes[0] === selection.reason;
	}
	if (decision.action === 'vendor') {
		if (!input.prices.requestedItemIds.includes(line.itemId)
			|| (!price && !input.prices.missingItemIds.includes(line.itemId))
			|| !fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
				input.policy.maxFutureSkewMs)) return false;
		if (!holdings.every((holding) => {
			const result = classifyItemLiquidity(holding, item, 'unavailable');
			return result.status === 'ok' && result.classification.vendor.status === 'eligible';
		})) return false;
		const holding = holdings[0];
		if (!holding || holding.kind !== 'item') return false;
		const selection = selectInventoryMarketRoute({ holding, item, price, marketDepth,
			tradingPostAccess: input.accountSignals.tradingPostAccess, quantity: decision.quantity,
			allowSell: remainingBid >= decision.quantity, listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps });
		return selection.action === 'vendor' && reasonCodes.length === 1 && reasonCodes[0] === selection.reason;
	}
	if (!snapshotComplete(input.snapshot) || !rulePackFresh(input)) return false;
	const matchingRules = input.rulePack.rules.filter((rule) => rule.ruleId === decision.ruleId
		&& rule.itemId === line.itemId && rule.action === decision.action
		&& isEnabledApplicableRule(input.rulePack, rule));
	if (matchingRules.length !== 1) return false;
	if (decision.action === 'salvage') return !item.flags.includes('NoSalvage');
	if (decision.action === 'use') {
		return fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs,
			input.policy.maxFutureSkewMs) && input.accountSignals.unlockCoverage === 'complete'
			&& input.accountSignals.achievementCoverage === 'complete';
	}
	return decision.action === 'open';
}

function validMaterialDeposit(
	decision: InventoryRecommendationDecisionV1,
	line: InventoryAdvisorLineV1,
	input: InventoryAdvisorInputV1,
	holdings: Array<InventoryAdvisorInputV1['snapshot']['holdings'][number] | undefined>,
	reasonCodes: InventoryAdvisorReasonCode[],
	capacity: InventoryAdvisorEngineInputV1['materialStorageCapacity'],
): boolean {
	if (capacity === undefined || decision.materialStorage === undefined
		|| decision.materialStorage.capacity !== capacity.quantity
		|| decision.materialStorage.capacitySource !== capacity.source
		|| reasonCodes.length !== 1 || reasonCodes[0] !== 'material_storage_space_available'
		|| input.snapshot.quality !== 'stable' || input.snapshot.coverage.sources.materials.status !== 'complete'
		|| !holdings.every((holding) => holding?.kind === 'item' && holding.state === 'loose'
			&& (holding.location.source === 'character' || holding.location.source === 'shared_inventory'))) return false;
	const categories = Object.values(input.catalog.materials).filter((category) => category.items.includes(line.itemId));
	if (categories.length !== 1) return false;
	const categoryCoverage = input.catalog.coverage.materials[String(categories[0]!.id)];
	if (categoryCoverage?.status !== 'resolved' || !['network', 'cache_fresh'].includes(categoryCoverage.source)) return false;
	const storedQuantity = input.snapshot.holdings.filter((holding) => holding.kind === 'item'
		&& holding.itemId === line.itemId && holding.location.source === 'materials')
		.reduce((total, holding) => total + holding.quantity, 0);
	const space = Math.max(0, capacity.quantity - storedQuantity);
	const totalDeposited = line.decisions.filter((candidate) => candidate.action === 'deposit_material')
		.reduce((total, candidate) => total + candidate.quantity, 0);
	return decision.materialStorage.storedQuantity === storedQuantity
		&& decision.materialStorage.spaceBefore === space
		&& totalDeposited > 0 && totalDeposited <= space;
}

function validMaterialStorageCapacity(value: NonNullable<InventoryAdvisorEngineInputV1['materialStorageCapacity']>): boolean {
	return Number.isSafeInteger(value.quantity) && value.quantity >= 250 && value.quantity <= 3000
		&& value.quantity % 250 === 0
		&& (value.source === 'configured' || (value.source === 'minimum_guaranteed' && value.quantity === 250));
}

function allocationPositionIndex(ref: string): number {
	const value = Number(ref.slice(ref.lastIndexOf('/') + 1));
	return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function validDiscardAgainstInput(
	decision: InventoryRecommendationDecisionV1,
	line: InventoryAdvisorLineV1,
	input: InventoryAdvisorInputV1,
	reserved: number,
	exceptionQuantity: number,
): boolean {
	const item = input.catalog.items[String(line.itemId)];
	const coverage = input.catalog.coverage.items[String(line.itemId)];
	const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
	const proof = decision.discardProof;
	if (!item || !coverage || !proof || reserved !== 0 || exceptionQuantity !== 0
		|| input.prices.status !== 'complete' || !price || price.bid !== null || price.ask !== null
		|| input.accountSignals.tradingPostAccess === 'unknown'
		|| input.accountSignals.unlockCoverage !== 'complete'
		|| input.accountSignals.achievementCoverage !== 'complete'
		|| !item.flags.includes('NoSalvage') || item.flags.includes('DeleteWarning')
		|| (item.vendorValue > 0 && !item.flags.includes('NoSell'))
		|| coverage.status !== 'resolved' || !['network', 'cache_fresh'].includes(coverage.source)
		|| proof.catalogSource !== coverage.source || proof.rulePackSha256 !== input.rulePack.sha256
		|| input.rulePack.rules.some((rule) => rule.itemId === line.itemId && isApprovedApplicableCapability(input.rulePack, rule)
			&& (rule.action === 'use' || rule.action === 'open'))) return false;
	return fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs,
			input.policy.maxFutureSkewMs)
		&& rulePackFresh(input);
}

function rulePackFresh(input: InventoryAdvisorInputV1): boolean {
	const pack = input.rulePack;
	return (pack.schemaVersion === 1 || (pack.reviewStatus === 'human_reviewed' && pack.reviewedAt !== null))
		&& pack.reviewedAt !== null && fresh(pack.reviewedAt, input.asOf, input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs)
		&& (pack.schemaVersion === 2 ? Date.parse(input.asOf) < Date.parse(pack.validUntil)
			: Date.parse(input.asOf) <= Date.parse(pack.validUntil) + input.policy.maxFutureSkewMs);
}

function fresh(evidenceAt: string, asOf: string, maxAgeMs: number, maxFutureSkewMs: number): boolean {
	const evidence = Date.parse(evidenceAt);
	const now = Date.parse(asOf);
	return evidence <= now + maxFutureSkewMs && now - evidence <= maxAgeMs;
}

function snapshotComplete(snapshot: InventoryAdvisorInputV1['snapshot']): boolean {
	return snapshot.quality === 'stable'
		&& snapshot.coverage.sources.characters.status === 'complete'
		&& snapshot.coverage.sources.shared_inventory.status === 'complete';
}

function sameRulePack(
	left: { id: string; version: number; sha256: string },
	right: InventoryRecommendationEnvelopeV1['rulePack'],
): boolean {
	return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}

function record(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value) as unknown;
		return prototype === Object.prototype || prototype === null;
	} catch { return false; }
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (record(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}
