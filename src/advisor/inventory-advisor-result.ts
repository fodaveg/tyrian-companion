import { canonicalJson as canonical } from '../core/canonical-sha256';
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
	validDecisionAgainstValidatedInput as validPublicDecisionAgainstInput,
} from './inventory-advisor-contract';
import type {
	InventoryAdvisorInputV1,
	InventoryAdvisorExplanationV1,
	InventoryAdvisorLineV1,
	InventoryAdvisorReasonCode,
	InventoryAdvisorResultV1,
	InventoryRecommendationDecisionV1,
} from './inventory-advisor-model';
import {
	buildInventoryAdvisorReservationBalance,
	createReservationPlan,
	type ReservationBalanceResult,
	type ReservationPlanResult,
} from '../economy/reservation';
import type { ReservationPlanAsset } from '../economy/reservation-model';
import { classifyItemLiquidity } from '../economy/item-liquidity';
import { selectInventoryMarketRoute } from './inventory-advisor-market';
import { isInventoryKnowledgePack } from './inventory-advisor-classifier';
import { evaluateInventoryEquipmentEconomy } from './inventory-equipment-economy';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import type { InventoryAdvisorEngineInputV1 } from './inventory-advisor-classifier-model';
import { evaluateInventoryContainerEconomy, isInventoryContainerPriceEvidence } from './inventory-container-economy';
import type { ContainerPersonalValuationV1 } from '../economy/container-personal-valuation';
import { isActiveTradingPostOrdersEvidence, type ActiveTradingPostOrdersEvidenceV1 } from '../account/trading-post-orders-model';
import { isInventoryMarketDepthEvidence, type InventoryMarketDepthEvidenceV1 } from '../economy/commerce-listings';
import {
	isMaterialStorageCapacity,
	materialStorageDepositsFit,
	observedMaterialStorageMinimumMatches,
} from '../economy/material-storage-deposit-validation';
import { isEquipmentSalvagePolicy, isEquipmentSalvagePreferences } from '../economy/equipment-salvage-economy';

/** One holding of an object together with its index in `snapshot.holdings`, which its position ref carries. */
export interface InventoryAdvisorHoldingPosition {
	holding: InventoryAdvisorInputV1['snapshot']['holdings'][number];
	holdingIndex: number;
}

/**
 * What one analysis derives from its input and every stage of it needs again: the reservation
 * balance and plan, and where each object sits in the inventory.
 *
 * It belongs to the exact `input` object it was created with and lives as long as the entry point
 * that created it. Nothing is keyed by snapshot and nothing outlives the call, so a change of goals
 * between two analyses of the same snapshot can never meet the plan of the first. Each derivation
 * is built on first use, at the point its consumer used to build it, and its consumers ask only
 * after they have validated `input` themselves.
 *
 * A context cannot be altered by whoever holds it: it is frozen, its methods answer from state
 * only this module reaches, and the plan, the assets and the position lists they return are
 * frozen, so the same answer is served again. The holdings inside a position entry are the
 * caller's own objects and stay as mutable as the rest of `input`.
 *
 * Known limit: a derivation is made once and not made again. A caller that changes `input` after
 * the context derived its plan or its index gets the plan and the index of the input as it was,
 * checked against the input as it is. A context is good for one synchronous analysis of an input
 * nobody changes meanwhile, which is how every stage of this module's own flow uses it; closing
 * this would take a private copy of the input per context and a comparison with it on every use.
 */
export interface InventoryAdvisorAnalysisContext {
	readonly input: unknown;
	/** The balance and, when the balance is valid, the plan of `input.goals` over it. Frozen. */
	reservation(): { balance: ReservationBalanceResult; plan: ReservationPlanResult | { status: 'invalid' } };
	/** The plan asset under `key`; undefined when there is none or the plan is not valid. Frozen. */
	planAsset(key: string): ReservationPlanAsset | undefined;
	/** Every holding of `itemId`, in inventory order: one pass over the inventory serves all objects. Frozen list. */
	positions(itemId: number): readonly InventoryAdvisorHoldingPosition[];
}

/**
 * Contexts this module created: a verifier never takes a plan or an index it did not derive here.
 * Membership is by identity, so a copy, a proxy or an object that inherits from a context is not one.
 */
const ANALYSIS_CONTEXTS = new WeakSet<InventoryAdvisorAnalysisContext>();

const NO_POSITIONS: readonly InventoryAdvisorHoldingPosition[] = Object.freeze([]);

/** Creates the context of one analysis of `input`. It derives nothing until a stage asks. */
export function createInventoryAdvisorAnalysisContext(input: unknown): InventoryAdvisorAnalysisContext {
	const validated = input as InventoryAdvisorInputV1;
	let reservation: ReturnType<InventoryAdvisorAnalysisContext['reservation']> | undefined;
	let planAssets: Map<string, ReservationPlanAsset> | undefined;
	let positionsByItemId: Map<number, readonly InventoryAdvisorHoldingPosition[]> | undefined;
	// The three derivations call each other here, never through the object handed out below.
	const reservationOf: InventoryAdvisorAnalysisContext['reservation'] = () => {
		if (reservation === undefined) {
			const balance = buildInventoryAdvisorReservationBalance(validated.snapshot);
			const plan = balance.status === 'ok'
				? createReservationPlan({ goals: validated.goals, balance: balance.balance })
				: { status: 'invalid' as const };
			reservation = freezeDeep({ balance, plan });
		}
		return reservation;
	};
	const planAssetOf: InventoryAdvisorAnalysisContext['planAsset'] = (key) => {
		if (planAssets === undefined) {
			const { plan } = reservationOf();
			planAssets = new Map(plan.status === 'ok' ? plan.plan.assets.map((asset) => [asset.key, asset]) : []);
		}
		return planAssets.get(key);
	};
	const positionsOf: InventoryAdvisorAnalysisContext['positions'] = (itemId) => {
		if (positionsByItemId === undefined) {
			const index = new Map<number, InventoryAdvisorHoldingPosition[]>();
			validated.snapshot.holdings.forEach((holding, holdingIndex) => {
				if (holding.kind !== 'item') return;
				// The entry is frozen, the holding is not: it belongs to the caller's input.
				const entry = Object.freeze({ holding, holdingIndex });
				const entries = index.get(holding.itemId);
				if (entries === undefined) index.set(holding.itemId, [entry]);
				else entries.push(entry);
			});
			for (const entries of index.values()) Object.freeze(entries);
			positionsByItemId = index;
		}
		return positionsByItemId.get(itemId) ?? NO_POSITIONS;
	};
	const context: InventoryAdvisorAnalysisContext = Object.freeze({
		input, reservation: reservationOf, planAsset: planAssetOf, positions: positionsOf,
	});
	ANALYSIS_CONTEXTS.add(context);
	return context;
}

/** Freezes a value this module has just built, and everything it holds, so that it can be handed out and served again. */
function freezeDeep<T>(value: T): T {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
	return value;
}

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
	equipmentSalvage?: InventoryAdvisorEngineInputV1['equipmentSalvage'],
): value is InventoryAdvisorResultV1 {
	try {
		return isInventoryAdvisorResultForInputUnsafe(
			value, createInventoryAdvisorAnalysisContext(input), knowledgePack, containerEconomy, personalValuation,
			activeOrders, materialStorageCapacity, marketDepth, equipmentSalvage,
		);
	} catch { return false; }
}

/**
 * The same verification as `isInventoryAdvisorResultForInput`, against `context.input`, for a stage
 * that already holds the context of its analysis: it checks everything the public verifier checks
 * and only shares the reservation plan and the position index instead of deriving them again.
 * A context this module did not create is refused.
 */
export function isInventoryAdvisorResultForAnalysis(
	value: unknown,
	context: InventoryAdvisorAnalysisContext,
	knowledgePack?: unknown,
	containerEconomy?: InventoryAdvisorEngineInputV1['containerEconomy'],
	personalValuation?: ContainerPersonalValuationV1,
	activeOrders?: ActiveTradingPostOrdersEvidenceV1,
	materialStorageCapacity?: InventoryAdvisorEngineInputV1['materialStorageCapacity'],
	marketDepth?: InventoryMarketDepthEvidenceV1,
	equipmentSalvage?: InventoryAdvisorEngineInputV1['equipmentSalvage'],
): value is InventoryAdvisorResultV1 {
	try {
		if (!ANALYSIS_CONTEXTS.has(context)) return false;
		return isInventoryAdvisorResultForInputUnsafe(
			value, context, knowledgePack, containerEconomy, personalValuation, activeOrders, materialStorageCapacity,
			marketDepth, equipmentSalvage,
		);
	} catch { return false; }
}

function isInventoryAdvisorResultForInputUnsafe(
	value: unknown,
	context: InventoryAdvisorAnalysisContext,
	knowledgePack: unknown,
	containerEconomy: InventoryAdvisorEngineInputV1['containerEconomy'],
	personalValuation: ContainerPersonalValuationV1 | undefined,
	activeOrders: ActiveTradingPostOrdersEvidenceV1 | undefined,
	materialStorageCapacity: InventoryAdvisorEngineInputV1['materialStorageCapacity'],
	marketDepth: InventoryMarketDepthEvidenceV1 | undefined,
	equipmentSalvage: InventoryAdvisorEngineInputV1['equipmentSalvage'],
): value is InventoryAdvisorResultV1 {
	const input = context.input;
	if (!isInventoryAdvisorInput(input) || !isInventoryAdvisorResult(value)) return false;
	if (activeOrders !== undefined && (!isActiveTradingPostOrdersEvidence(activeOrders)
		|| activeOrders.accountId !== input.snapshot.accountId
		|| !fresh(activeOrders.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
			input.policy.maxFutureSkewMs))) return false;
	if (materialStorageCapacity !== undefined && (!validMaterialStorageCapacity(materialStorageCapacity)
		|| !observedMaterialStorageMinimumMatches(materialStorageCapacity, input.snapshot))) return false;
	if (equipmentSalvage !== undefined && (!isEquipmentSalvageContext(equipmentSalvage))) return false;
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
	if (marketDepth !== undefined && marketDepth.status !== 'complete'
		&& (value.status !== 'limited' || report.coverage !== 'limited')) return false;
	const { balance: balanceResult, plan: planResult } = context.reservation();
	if (balanceResult.status !== 'ok') return false;
	if (planResult.status !== 'ok') return false;
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
		const expectedPositions = context.positions(line.itemId);
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
		const reserved = context.planAsset(`item:${line.itemId}`)?.protectedAvailable ?? 0;
		const planAsset = context.planAsset(`item:${line.itemId}`);
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
		// One figure for the whole line, taken before any decision is checked. The public order puts
		// `list` ahead of `sell`, so a count that ran along the decisions met the surplus of a stack while
		// the sale of that same stack had not been discounted yet, and demanded `sell` for it.
		const unsoldBid = demonstratedBid - sold;
		const lineExplanations = line.decisions
			.map((decision) => report.explanations.find((entry) => entry.ref === decision.explanationRef));
		let priceRouteCuts: Map<string, PriceRouteCut[]> | undefined;
		for (const [decisionIndex, decision] of line.decisions.entries()) {
			const explanation = lineExplanations[decisionIndex];
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
				continue;
			}
			const validWith = (allowSell: boolean): boolean => validDecisionAgainstInput(decision, line, input, reserved,
				expectedException, allowSell, explanation?.reasonCodes ?? [], materialStorageCapacity, depthItem,
				knowledgePack as InventoryKnowledgePackV1 | undefined, equipmentSalvage, expectedPositions);
			// A sale is the instant route by definition; anything else had it open only if the unsold bid
			// still absorbs all of it.
			const allowSell = decision.action === 'sell' || unsoldBid >= decision.quantity;
			if (depthItem?.coverage === 'complete'
				|| (decision.action !== 'sell' && decision.action !== 'list' && decision.action !== 'vendor')) {
				if (!validWith(allowSell)) return false;
				continue;
			}
			// Prices route. A decision that is one of the cuts the classifier makes of its position is
			// reproduced with the instant sale as that cut had it, and each cut answers for one decision.
			priceRouteCuts ??= priceRouteCutsOfLine(line, lineExplanations, input, price, depthItem, demonstratedBid);
			const cut = decision.allocations.length !== 1 ? undefined
				: priceRouteCuts.get(decision.allocations[0]!.positionRef)?.find((candidate) => !candidate.claimed
					&& candidate.quantity === decision.quantity && validWith(candidate.allowSell));
			if (cut !== undefined) {
				cut.claimed = true;
				continue;
			}
			// Any other shape (one decision over several positions, a result classified with complete depth
			// and verified without it) answers to the unsold bid of the line, and is refused when it was
			// routed without a bid that the route would have sold: the classifier offers the bid first.
			if (!allowSell && unsoldBid > 0 && instantRouteSells(decision, line.itemId, input, price, depthItem, unsoldBid)) return false;
			if (!validWith(allowSell)) return false;
		}
	}
	return true;
}

/** One slice of a position as the classifier cuts it on the prices route. */
interface PriceRouteCut {
	quantity: number;
	/** Whether the instant sale was open to this slice: only to the part the bid still absorbed. */
	allowSell: boolean;
	claimed: boolean;
}

/**
 * The cuts the classifier makes of one line on the prices route (no complete depth for the object),
 * by position ref. It walks the positions in inventory order with one bid for the whole object: of
 * what a position has left for the market, the part the remaining bid absorbs is one slice routed
 * with the instant sale open, the rest a second slice routed without it, and only a slice the route
 * actually sells spends bid (also when an active buy order then withholds that sale for review).
 * What a position has left is its quantity minus what the line set aside before the market route:
 * reservations, keep exceptions, material deposits and positions it cannot act on.
 */
function priceRouteCutsOfLine(
	line: InventoryAdvisorLineV1,
	explanations: ReadonlyArray<InventoryAdvisorExplanationV1 | undefined>,
	input: InventoryAdvisorInputV1,
	price: InventoryAdvisorInputV1['prices']['items'][number] | undefined,
	marketDepth: InventoryMarketDepthEvidenceV1['items'][number] | undefined,
	demonstratedBid: number,
): Map<string, PriceRouteCut[]> {
	const cuts = new Map<string, PriceRouteCut[]>();
	const item = input.catalog.items[String(line.itemId)];
	if (!item) return cuts;
	const setAside = new Map<string, number>();
	line.decisions.forEach((decision, index) => {
		if (decision.action !== 'deposit_material' && explanations[index]?.reasonCodes.some((code) => code === 'reserved_for_goal'
			|| code === 'user_keep_exception' || code === 'position_not_actionable') !== true) return;
		for (const allocation of decision.allocations) {
			setAside.set(allocation.positionRef, (setAside.get(allocation.positionRef) ?? 0) + allocation.quantity);
		}
	});
	let remainingBid = demonstratedBid;
	for (const position of line.positions) {
		const holding = input.snapshot.holdings[position.holdingIndex];
		const quantity = position.quantity - (setAside.get(position.ref) ?? 0);
		if (position.state !== 'loose' || holding?.kind !== 'item' || quantity <= 0) continue;
		const absorbed = Math.min(quantity, remainingBid);
		const positionCuts: PriceRouteCut[] = [];
		if (absorbed > 0) {
			positionCuts.push({ quantity: absorbed, allowSell: true, claimed: false });
			if (selectInventoryMarketRoute({ holding, item, price, marketDepth,
				tradingPostAccess: input.accountSignals.tradingPostAccess, quantity: absorbed, allowSell: true,
				listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps }).action === 'sell') remainingBid -= absorbed;
		}
		if (quantity > absorbed) positionCuts.push({ quantity: quantity - absorbed, allowSell: false, claimed: false });
		cuts.set(position.ref, positionCuts);
	}
	return cuts;
}

/** Whether the prices route, with the instant sale open, sells `quantity` units of the decision's first position. */
function instantRouteSells(
	decision: InventoryRecommendationDecisionV1,
	itemId: number,
	input: InventoryAdvisorInputV1,
	price: InventoryAdvisorInputV1['prices']['items'][number] | undefined,
	marketDepth: InventoryMarketDepthEvidenceV1['items'][number] | undefined,
	quantity: number,
): boolean {
	const item = input.catalog.items[String(itemId)];
	const first = decision.allocations[0];
	const holding = first === undefined ? undefined : input.snapshot.holdings[allocationPositionIndex(first.positionRef)];
	return item !== undefined && holding?.kind === 'item' && selectInventoryMarketRoute({ holding, item, price, marketDepth,
		tradingPostAccess: input.accountSignals.tradingPostAccess, quantity, allowSell: true,
		listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps }).action === 'sell';
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
		marketDepth: economy.marketDepth,
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
	allowSell: boolean,
	reasonCodes: InventoryAdvisorReasonCode[],
	materialStorageCapacity: InventoryAdvisorEngineInputV1['materialStorageCapacity'],
	marketDepth: InventoryMarketDepthEvidenceV1['items'][number] | undefined,
	knowledgePack: InventoryKnowledgePackV1 | undefined,
	equipmentSalvage: InventoryAdvisorEngineInputV1['equipmentSalvage'],
	itemPositions: readonly InventoryAdvisorHoldingPosition[],
): boolean {
	if (decision.action === 'keep' || decision.action === 'review') return true;
	if (!validPublicDecisionAgainstInput(input, decision)) return false;
	const item = input.catalog.items[String(line.itemId)];
	const price = input.prices.items.find((candidate) => candidate.itemId === line.itemId);
	const catalogCoverage = input.catalog.coverage.items[String(line.itemId)];
	if (!item || catalogCoverage?.status !== 'resolved' || !['network', 'cache_fresh'].includes(catalogCoverage.source)
		|| !fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs,
		input.policy.maxFutureSkewMs)) return false;
	const holdings = decision.allocations.map((allocation) => input.snapshot.holdings[allocationPositionIndex(allocation.positionRef)]);
	if (holdings.some((holding) => holding?.kind !== 'item')) return false;
	if (decision.action === 'deposit_material') {
		return validMaterialDeposit(decision, line, input, holdings, reasonCodes, materialStorageCapacity, itemPositions);
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
			allowSell, listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps });
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
			allowSell, listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps });
		return selection.action === 'vendor' && reasonCodes.length === 1 && reasonCodes[0] === selection.reason;
	}
	if (decision.action === 'salvage' && equipmentSalvage !== undefined && knowledgePack !== undefined) {
		const evaluation = evaluateInventoryEquipmentEconomy(
			input, knowledgePack.entries.find((entry) => entry.itemId === line.itemId), line.itemId,
			decision.quantity, line.positions.filter((position) => decision.allocations
				.some((allocation) => allocation.positionRef === position.ref)),
			Object.values(line.coverage).every((entry) => entry === 'complete'), equipmentSalvage,
		);
		if (evaluation?.status === 'ready' && evaluation.action === 'salvage') {
			return decision.ruleId === evaluation.economics.ruleId && reasonCodes.length === 1
				&& reasonCodes[0] === 'alternative_route_exists';
		}
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
	itemPositions: readonly InventoryAdvisorHoldingPosition[],
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
	const storedQuantity = itemPositions.filter(({ holding }) => holding.location.source === 'materials')
		.reduce((total, { holding }) => total + holding.quantity, 0);
	const space = Math.max(0, capacity.quantity - storedQuantity);
	const totalDeposited = line.decisions.filter((candidate) => candidate.action === 'deposit_material')
		.reduce((total, candidate) => total + candidate.quantity, 0);
	return decision.materialStorage.storedQuantity === storedQuantity
		&& decision.materialStorage.spaceBefore === space
		&& totalDeposited > 0 && totalDeposited <= space;
}

function validMaterialStorageCapacity(value: NonNullable<InventoryAdvisorEngineInputV1['materialStorageCapacity']>): boolean {
	return isMaterialStorageCapacity(value.quantity, value.source);
}

function isEquipmentSalvageContext(value: NonNullable<InventoryAdvisorEngineInputV1['equipmentSalvage']>): boolean {
	return isEquipmentSalvagePolicy(value.policy) && isEquipmentSalvagePreferences(value.preferences)
		&& (value.prices === null || isInventoryContainerPriceEvidence(value.prices))
		&& (value.marketDepth === null || (isInventoryMarketDepthEvidence(value.marketDepth)
			&& value.marketDepth.requestedItemIds.length === 1
			&& value.marketDepth.requestedItemIds[0] === value.policy.outputItemId));
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

