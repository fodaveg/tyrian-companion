import { buildInventoryAdvisorReservationBalance, createReservationPlan } from '../economy/reservation';
import { createInventoryRecommendationEnvelope } from '../economy/inventory-recommendation-envelope';
import { isApprovedApplicableCapability, isEnabledApplicableRule, isInventoryAdvisorInput, sha256CanonicalValue } from './inventory-advisor-contract';
import { isInventoryAdvisorResultForInput } from './inventory-advisor-result';
import type {
	InventoryAdvisorCoverageV1, InventoryAdvisorInputV1, InventoryAdvisorReasonCode,
	InventoryAdvisorResultV1, InventoryAdvisorPositionV1,
} from './inventory-advisor-model';
import {
	INVENTORY_ADVISOR_ENGINE_VERSION, INVENTORY_KNOWLEDGE_PACK_VERSION,
	type InventoryAdvisorEngineDecisionV1, type InventoryAdvisorEngineInputV1,
	type InventoryAdvisorEngineLineV1, type InventoryAdvisorEngineResultV1,
	type InventoryKnowledgeEntryV1, type InventoryKnowledgePackV1, type InventoryRouteClaimV1,
} from './inventory-advisor-classifier-model';
import { selectInventoryMarketRoute } from './inventory-advisor-market';
import { classifyItemLiquidity } from '../economy/item-liquidity';
import {
	evaluateInventoryContainerEconomy,
	isInventoryContainerEconomyPack,
	isInventoryContainerPriceEvidence,
} from './inventory-container-economy';
import type { InventoryAdvisorEngineInputV1 as EngineInput } from './inventory-advisor-classifier-model';
import { isContainerPersonalValuation, resolveContainerPersonalValuation } from '../economy/container-personal-valuation';
import { isActiveTradingPostOrdersEvidence } from '../account/trading-post-orders-model';
import { materialStorageDepositsFit } from '../economy/material-storage-deposit-validation';
import { isInventoryMarketDepthEvidence } from '../economy/commerce-listings';
import {
	EQUIPMENT_SALVAGE_POLICY_V1_SHA256,
	isEquipmentSalvagePolicy,
	isEquipmentSalvagePreferences,
	type EquipmentSalvageEconomyResultV1,
} from '../economy/equipment-salvage-economy';
import { evaluateInventoryEquipmentEconomy } from './inventory-equipment-economy';

/** Pure H4.15 classifier producing the public H4.13 report and manual envelope. */
export function classifyInventoryAdvisor(value: unknown): InventoryAdvisorResultV1 {
	try {
		if (!isEngineInput(value)) return publicInvalid();
		const engine = classifyInventoryAdvisorEngine(value);
		if (engine.status === 'invalid' || engine.report === null) return publicInvalid();
		const { input } = value;
		const balance = buildInventoryAdvisorReservationBalance(input.snapshot);
		const plan = balance.status === 'ok' ? createReservationPlan({ goals: input.goals, balance: balance.balance }) : { status: 'invalid' as const };
		if (plan.status !== 'ok') return publicInvalid();
		const publicLines = engine.report.lines.map((line) => publicLine(
			line, input, plan.plan, value.equipmentSalvage,
		));
		const lines = publicLines.map((entry) => entry.line);
		const depthComplete = value.marketDepth === undefined || value.marketDepth.status === 'complete';
		const coverage: 'complete' | 'limited' = depthComplete
			&& lines.every((line) => Object.values(line.coverage).every((entry) => entry === 'complete')) ? 'complete' : 'limited';
		const report = {
			version: 1 as const, scope: 'supported_storage_v1' as const, accountId: input.snapshot.accountId,
			snapshotId: input.snapshot.snapshotId, asOf: input.asOf, coverage, lines,
			reasons: uniqueReasons(lines.flatMap((line) => line.reasons)).sort(reasonOrder),
			explanations: publicLines.flatMap((entry) => entry.explanations)
				.sort((left, right) => left.ref.localeCompare(right.ref)), rulePack: input.rulePack,
		};
		const envelope = createInventoryRecommendationEnvelope(report);
		if (envelope === null) return publicInvalid();
		const result: InventoryAdvisorResultV1 = { status: coverage === 'complete' ? 'ready' : 'limited', report, envelope };
		return isInventoryAdvisorResultForInput(
			result, input, value.knowledgePack, value.containerEconomy, value.personalValuation,
			value.activeOrders, value.materialStorageCapacity, value.marketDepth,
			value.equipmentSalvage,
		) ? result : publicInvalid();
	} catch { return publicInvalid(); }
}

/** Internal classification representation preserves route provenance while the public report is assembled. */
function classifyInventoryAdvisorEngine(value: unknown): InventoryAdvisorEngineResultV1 {
	try {
		if (!isEngineInput(value)) return invalid();
		const { input, knowledgePack } = value;
		const balance = buildInventoryAdvisorReservationBalance(input.snapshot);
		const plan = balance.status === 'ok' ? createReservationPlan({ goals: input.goals, balance: balance.balance }) : { status: 'invalid' as const };
		if (plan.status !== 'ok') return invalid();
		const itemIds = ids(input);
		const inputRulesFresh = rulePackFresh(input);
		const knowledgeReady = knowledgeFresh(knowledgePack, input);
		const itemEvidence = new Map(itemIds.map((itemId) => [
			itemId,
			recommendationEvidenceReady(input, plan.plan, itemId),
		]));
		const complete = input.prices.status === 'complete'
			&& (value.marketDepth === undefined || value.marketDepth.status === 'complete')
			&& itemIds.every((itemId) => itemEvidence.get(itemId) === true)
			&& knowledgeReady && input.snapshot.quality === 'stable' && inputRulesFresh;
		const lines = itemIds.map((itemId) => classifyLine(input, knowledgePack, itemId,
			plan.plan.assets.find((asset) => asset.key === `item:${itemId}`)?.protectedAvailable ?? 0,
			itemEvidence.get(itemId) === true, knowledgeReady, value.containerEconomy, value.personalValuation,
			value.materialStorageCapacity, value.marketDepth, value.equipmentSalvage))
			.map((line) => applyActiveOrderPolicy(line, value.activeOrders));
		const report = { version: INVENTORY_ADVISOR_ENGINE_VERSION, scope: 'supported_storage_v1' as const,
			accountId: input.snapshot.accountId, snapshotId: input.snapshot.snapshotId, asOf: input.asOf,
			knowledgePack: { id: knowledgePack.id, version: knowledgePack.version, sha256: knowledgePack.sha256 }, lines };
		return { status: complete ? 'ready' : 'limited', report, envelope: { execution: 'manual_in_game', sideEffects: 'none', requiresUserAction: true } };
	} catch { return invalid(); }
}

export function sha256InventoryKnowledgePack(pack: InventoryKnowledgePackV1): string {
	const { sha256: _ignored, ...content } = pack;
	return sha256CanonicalValue(content);
}

export function isInventoryKnowledgePack(value: unknown): value is InventoryKnowledgePackV1 {
	try {
		if (!record(value) || !keys(value, ['schemaVersion', 'id', 'version', 'publishedAt', 'reviewedAt', 'validUntil', 'sha256', 'sources', 'entries'])
			|| value.schemaVersion !== INVENTORY_KNOWLEDGE_PACK_VERSION || !id(value.id) || !positive(value.version) || !iso(value.publishedAt) || !iso(value.reviewedAt) || !iso(value.validUntil)
			|| Date.parse(value.publishedAt) > Date.parse(value.reviewedAt) || Date.parse(value.reviewedAt) >= Date.parse(value.validUntil)
			|| !sha(value.sha256) || !Array.isArray(value.sources) || !value.sources.every(source)
			|| !Array.isArray(value.entries) || !value.entries.every(entry)) return false;
		const pack = value as unknown as InventoryKnowledgePackV1;
		const sourceIds = pack.sources.map((entry) => entry.id);
		return sorted(pack.sources, (left, right) => left.id.localeCompare(right.id)) && unique(sourceIds)
			&& sorted(pack.entries, (left, right) => left.itemId - right.itemId)
			&& pack.entries.every((entry) => claimsReferenceSources(entry, sourceIds))
			&& pack.entries.every(distinctNotApplicableAssertions)
			&& pack.sources.every((entry) => Date.parse(entry.retrievedAt) <= Date.parse(pack.reviewedAt))
			&& pack.sha256 === sha256InventoryKnowledgePack(pack) && json(pack);
	} catch { return false; }
}

export function isInventoryAdvisorEngineResult(value: unknown): value is InventoryAdvisorEngineResultV1 {
	try {
		if (!record(value) || !['ready', 'limited', 'blocked', 'invalid'].includes(String(value.status))) return false;
		if (value.status === 'invalid') return keys(value, ['status', 'report', 'envelope']) && value.report === null && value.envelope === null;
		if (!keys(value, ['status', 'report', 'envelope']) || !record(value.report) || !record(value.envelope)
			|| value.envelope.execution !== 'manual_in_game' || value.envelope.sideEffects !== 'none' || value.envelope.requiresUserAction !== true) return false;
		const report = value.report;
		if (!keys(report, ['version', 'scope', 'accountId', 'snapshotId', 'asOf', 'knowledgePack', 'lines']) || report.version !== 1 || report.scope !== 'supported_storage_v1'
			|| !Array.isArray(report.lines) || !report.lines.every(line) || !sorted(report.lines, (a, b) => a.itemId - b.itemId)) return false;
		return materialStorageDepositsFit(report.lines.flatMap((item) => item.decisions))
			&& report.lines.every((item) => item.decisions.flatMap((decision) => decision.allocations)
				.reduce((sum, allocation) => sum + allocation.quantity, 0) === item.ownedQuantity);
	} catch { return false; }
}

function classifyLine(input: InventoryAdvisorInputV1, pack: InventoryKnowledgePackV1, itemId: number, reserved: number,
	evidenceReady: boolean, curatedKnowledgeReady: boolean, economy: EngineInput['containerEconomy'],
	personalValuation: EngineInput['personalValuation'],
	materialStorageCapacity: EngineInput['materialStorageCapacity'],
	marketDepth: EngineInput['marketDepth'],
	equipmentSalvage: EngineInput['equipmentSalvage']): InventoryAdvisorEngineLineV1 {
	const positions = input.snapshot.holdings.map((holding, holdingIndex) => ({ holding, holdingIndex })).filter((entry) => entry.holding.kind === 'item' && entry.holding.itemId === itemId)
		.map(({ holding, holdingIndex }) => ({ ref: `#/positions/${itemId}/${holdingIndex}`, holdingIndex, itemId, quantity: holding.quantity, source: holding.location.source, state: holding.state }));
	const remaining = new Map(positions.map((position) => [position.ref, position.quantity]));
	const decisions: InventoryAdvisorEngineDecisionV1[] = [];
	const add = (action: InventoryAdvisorEngineDecisionV1['action'], position: InventoryAdvisorPositionV1, quantity: number,
		reason: string, ruleId: string | null = null,
		materialStorage?: InventoryAdvisorEngineDecisionV1['materialStorage']): void => {
		if (quantity <= 0) return; remaining.set(position.ref, (remaining.get(position.ref) ?? 0) - quantity);
		decisions.push({ action, itemId, quantity, allocations: [{ positionRef: position.ref, quantity }], reason, ruleId,
			...(materialStorage === undefined ? {} : { materialStorage }) });
	};
	let reserveLeft = reserved;
	for (const position of positions.filter((position) => position.state === 'loose' || position.state === 'pending_claim')) {
		const quantity = Math.min(reserveLeft, remaining.get(position.ref) ?? 0);
		add('keep', position, quantity, 'reserved_for_goal'); reserveLeft -= quantity;
	}
	for (const exception of input.keepExceptions.filter((entry) => entry.status === 'active' && entry.itemId === itemId)) {
		let needed = exception.quantity.mode === 'all' ? Number.MAX_SAFE_INTEGER : exception.quantity.value;
		for (const position of positions) {
			if (exception.basis === 'available' && position.state !== 'loose' && position.state !== 'pending_claim') continue;
			const quantity = Math.min(needed, remaining.get(position.ref) ?? 0);
			add('keep', position, quantity, 'user_keep_exception'); needed -= quantity;
		}
	}
	const knowledge = pack.entries.find((entry) => entry.itemId === itemId);
	for (const position of positions) {
		const quantity = remaining.get(position.ref) ?? 0;
		if (quantity > 0 && position.state !== 'loose') add('review', position, quantity, 'position_not_actionable');
	}
	const deposit = materialDepositContext(input, itemId, positions, materialStorageCapacity);
	if (deposit !== null) {
		let space = deposit.spaceBefore;
		for (const position of positions.filter((candidate) => candidate.state === 'loose'
			&& (candidate.source === 'character' || candidate.source === 'shared_inventory'))) {
			const quantity = Math.min(space, remaining.get(position.ref) ?? 0);
			add('deposit_material', position, quantity, 'material_storage_space_available', null, deposit);
			space -= quantity;
			if (space === 0) break;
		}
	}
	const freePositions = positions.filter((position) => position.state === 'loose' && (remaining.get(position.ref) ?? 0) > 0);
	const freeQuantity = freePositions.reduce((total, position) => total + (remaining.get(position.ref) ?? 0), 0);
	if (freeQuantity === 0) return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
		ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	if (input.snapshot.quality !== 'stable' && equipmentSalvage !== undefined
		&& isPotentialEquipmentSalvageItem(input, itemId)) {
		for (const position of freePositions) add('review', position, remaining.get(position.ref) ?? 0, 'evidence_incomplete');
		return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	}
	const salvage = categorySalvageRoute(input, knowledge, itemId, freeQuantity, freePositions, evidenceReady,
		equipmentSalvage);
	if (salvage !== null && salvage.action !== 'market') {
		if (salvage.action === 'salvage') {
			const allocations = freePositions.map((position) => ({
				positionRef: position.ref, quantity: remaining.get(position.ref) ?? 0,
			}));
			for (const allocation of allocations) remaining.set(allocation.positionRef, 0);
			decisions.push({ action: 'salvage', itemId, quantity: freeQuantity, allocations,
				reason: salvage.reason, ruleId: salvage.ruleId });
		} else for (const position of freePositions) add('review', position, remaining.get(position.ref) ?? 0,
			salvage.reason, salvage.ruleId);
		return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	}
	const route = chooseRoute(input, knowledge, itemId);
	const routeEvidenceReady = evidenceReady && (route.action === 'market' || curatedKnowledgeReady);
	if (route.action === 'review' || !routeEvidenceReady) {
		for (const position of freePositions) add('review', position, remaining.get(position.ref) ?? 0,
			route.action === 'review' ? route.reason : 'evidence_incomplete');
		return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	}
	if (input.snapshot.quality !== 'stable'
		&& (route.action === 'economy' || route.action === 'use' || route.action === 'open' || route.action === 'salvage')) {
		for (const position of freePositions) add('review', position, remaining.get(position.ref) ?? 0, 'evidence_incomplete');
		return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	}
	if (route.action === 'economy') {
		const availableRefs = new Set(positions.filter((position) => position.state === 'loose'
			|| position.state === 'pending_claim').map((position) => position.ref));
		const availableAllocated = (predicate: (decision: InventoryAdvisorEngineDecisionV1) => boolean): number => decisions
			.filter(predicate).flatMap((decision) => decision.allocations)
			.filter((allocation) => availableRefs.has(allocation.positionRef))
			.reduce((total, allocation) => total + allocation.quantity, 0);
		const economic = containerEconomyDecision(input, economy, personalValuation, itemId, freeQuantity,
			availableAllocated((decision) => decision.reason === 'reserved_for_goal'),
			availableAllocated((decision) => decision.reason === 'user_keep_exception'),
			availableAllocated((decision) => decision.action === 'review'), freePositions, pack.sha256);
		if (economic.action === 'review') {
			for (const position of freePositions) add('review', position, remaining.get(position.ref) ?? 0, economic.reason);
		} else {
			const allocations = freePositions.map((position) => ({
				positionRef: position.ref,
				quantity: remaining.get(position.ref) ?? 0,
			}));
			for (const allocation of allocations) remaining.set(allocation.positionRef, 0);
			decisions.push({ action: economic.action, itemId, quantity: freeQuantity, allocations,
				reason: economic.reason, ruleId: economic.ruleId });
		}
		return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	}
	if (route.action === 'use' || route.action === 'open' || route.action === 'salvage') {
		for (const position of freePositions) add(route.action, position, remaining.get(position.ref) ?? 0, route.reason, route.ruleId);
		return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	}
	const itemMarketDepth = marketDepth?.items.find((entry) => entry.itemId === itemId);
	if (itemMarketDepth?.coverage === 'complete') {
		const market = marketAction(input, freePositions[0]!, freeQuantity, itemId, true, evidenceReady,
			itemMarketDepth);
		const allocations = freePositions.map((position) => ({
			positionRef: position.ref, quantity: remaining.get(position.ref) ?? 0,
		}));
		for (const allocation of allocations) remaining.set(allocation.positionRef, 0);
		decisions.push({ action: market.action, itemId, quantity: freeQuantity, allocations,
			reason: market.reason, ruleId: null });
		return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`,
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
	}
	let bidRemaining = input.prices.items.find((entry) => entry.itemId === itemId)?.bid?.quantity ?? 0;
	for (const position of freePositions) {
		const quantity = remaining.get(position.ref) ?? 0; if (quantity === 0) continue;
		const sellable = Math.min(quantity, bidRemaining);
		if (sellable > 0) {
			const market = marketAction(input, position, sellable, itemId, true, evidenceReady);
			add(market.action, position, sellable, market.reason);
			if (market.action === 'sell') bidRemaining -= sellable;
		}
		const excess = quantity - sellable;
		if (excess > 0) { const market = marketAction(input, position, excess, itemId, false, evidenceReady); add(market.action, position, excess, market.reason); }
	}
	return { itemId, name: input.catalog.items[String(itemId)]?.name ?? `Item ${itemId}`, ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0, positions, decisions };
}

function publicLine(
	engine: InventoryAdvisorEngineLineV1,
	input: InventoryAdvisorInputV1,
	plan: { assets: Array<{ key: string; coverage: string }> },
	equipmentSalvage: EngineInput['equipmentSalvage'],
) {
	const asset = plan.assets.find((entry) => entry.key === `item:${engine.itemId}`);
	const coverage = publicCoverage(input, engine.itemId, asset?.coverage ?? 'unknown');
	const sources = engine.decisions.map((source, index) => ({ source, decision: {
		action: source.action, itemId: source.itemId, quantity: source.quantity,
		allocations: source.allocations, explanationRef: `#/explanations/${engine.itemId}/${index}`,
		ruleId: source.ruleId, safety: 'manual_only' as const, discardProof: null,
		...(source.materialStorage === undefined ? {} : { materialStorage: structuredClone(source.materialStorage) }),
		...(source.action !== 'salvage' || source.reason !== 'curated_salvage_economy'
			|| equipmentSalvage === undefined ? {} : { salvageProof: {
				item: {
					itemId: source.itemId,
					rarity: 'Rare' as const,
					level: input.catalog.items[String(source.itemId)]!.level,
				},
				catalog: {
					snapshotId: input.catalog.snapshotId,
					itemRef: `#/items/${source.itemId}`,
				},
				policy: {
					id: equipmentSalvage.policy.id,
					version: equipmentSalvage.policy.version,
					sha256: EQUIPMENT_SALVAGE_POLICY_V1_SHA256,
				},
				rule: {
					ruleId: 'rare-equipment-68-ecto-v1' as const,
					minimumLevel: 68 as const,
					expectedOutputMillionths: 900_000 as const,
				},
			} }),
	} })).sort((left, right) => left.decision.action.localeCompare(right.decision.action)
		|| left.decision.explanationRef.localeCompare(right.decision.explanationRef));
	const decisions = sources.map((entry) => entry.decision);
	const lineReasons = uniqueReasons(sources.map(({ source, decision }) => ({
		code: reasonFor(source.reason), itemId: engine.itemId, goalId: null, ruleId: decision.ruleId,
	}))).sort(reasonOrder);
	const reservedQuantity = engine.decisions.filter((decision) => decision.reason === 'reserved_for_goal').reduce((total, decision) => total + decision.quantity, 0);
	const exceptionQuantity = engine.decisions.filter((decision) => decision.reason === 'user_keep_exception').reduce((total, decision) => total + decision.quantity, 0);
	const retainedQuantity = engine.decisions.filter((decision) => decision.action === 'keep'
		&& !['reserved_for_goal', 'user_keep_exception'].includes(decision.reason)).reduce((total, decision) => total + decision.quantity, 0);
	const actionedQuantity = decisions.filter((decision) => !['keep', 'review'].includes(decision.action)).reduce((total, decision) => total + decision.quantity, 0);
	const unclassifiedQuantity = decisions.filter((decision) => decision.action === 'review').reduce((total, decision) => total + decision.quantity, 0);
	return { line: {
		itemId: engine.itemId, name: engine.name, ownedQuantity: engine.ownedQuantity,
		availableQuantity: input.snapshot.availableByItem[String(engine.itemId)] ?? 0, positions: engine.positions,
		coverage, reservedQuantity, exceptionQuantity, retainedQuantity, actionedQuantity, unclassifiedQuantity,
		decisions, reasons: lineReasons,
	}, explanations: sources.map(({ source, decision }) => ({
		ref: decision.explanationRef, itemId: decision.itemId, action: decision.action,
		reasonCodes: [reasonFor(source.reason)], evidenceRefs: ['#/evidence/inventory'], ruleId: decision.ruleId,
	})) };
}

function publicCoverage(input: InventoryAdvisorInputV1, itemId: number, reservation: string): InventoryAdvisorCoverageV1 {
	const catalogCoverage = input.catalog.coverage.items[String(itemId)];
	const catalog = catalogCoverage?.status === 'resolved' && ['network', 'cache_fresh'].includes(catalogCoverage.source)
		&& fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs);
	const prices = input.prices.requestedItemIds.includes(itemId)
		&& (input.prices.items.some((entry) => entry.itemId === itemId)
			|| input.prices.missingItemIds.includes(itemId))
		&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs);
	const signalsFresh = fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs);
	const signals = signalsFresh && input.accountSignals.unlockCoverage === 'complete' && input.accountSignals.achievementCoverage === 'complete' && input.accountSignals.tradingPostAccess !== 'unknown';
	const rules = rulePackFresh(input);
	const snapshot = input.snapshot.quality === 'stable' && inventorySnapshotCoverageComplete(input);
	return {
		snapshot: snapshot ? 'complete' : 'limited', inventory: reservation === 'complete' ? 'complete' : reservation === 'limited' ? 'limited' : 'unknown',
		catalog: catalog ? 'complete' : catalogCoverage ? 'limited' : 'unknown', prices: prices ? 'complete'
			: input.prices.status === 'partial' ? 'limited' : 'unknown',
		reservations: reservation === 'complete' ? 'complete' : reservation === 'limited' ? 'limited' : 'unknown', accountSignals: signals ? 'complete' : signalsFresh ? 'limited' : 'unknown', rules: rules ? 'complete' : 'limited',
	};
}

function reasonFor(value: string): InventoryAdvisorReasonCode {
	const reasons: Record<string, InventoryAdvisorReasonCode> = {
		alternative_route_exists: 'alternative_route_exists', no_sell: 'no_sell',
		reserved_for_goal: 'reserved_for_goal', user_keep_exception: 'user_keep_exception', position_not_actionable: 'position_not_actionable',
		knowledge_missing: 'rule_missing', rule_missing: 'rule_missing', rule_conflict: 'rule_conflict', rule_stale: 'rule_stale', evidence_incomplete: 'price_partial', no_salvage: 'no_salvage',
		economic_comparison_missing: 'economic_comparison_missing',
		economic_activation_pending: 'economic_activation_pending',
		price_partial: 'price_partial', price_stale: 'price_stale', price_missing: 'price_missing',
		binding_unknown: 'binding_unknown', arithmetic_overflow: 'arithmetic_overflow',
		tp_access_unknown: 'tp_access_unknown', catalog_invalid: 'catalog_invalid', vendor_best_value: 'alternative_route_exists',
		instant_sell_best_value: 'alternative_route_exists', listing_advantage_met: 'alternative_route_exists', listing_only_route: 'alternative_route_exists', no_supported_route: 'no_sell',
		curated_use: 'alternative_route_exists', curated_open: 'alternative_route_exists', curated_salvage: 'alternative_route_exists',
		curated_salvage_economy: 'alternative_route_exists',
		salvage_exotic_rate_unverified: 'salvage_exotic_rate_unverified',
		salvage_mystic_cost_unmodeled: 'salvage_mystic_cost_unmodeled',
		salvage_item_evidence_uncertain: 'salvage_item_evidence_uncertain',
		active_buy_order: 'alternative_route_exists', active_sell_order: 'alternative_route_exists',
		material_storage_space_available: 'material_storage_space_available',
	};
	return reasons[value] ?? 'snapshot_invalid';
}
function reasonOrder(left: { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }, right: { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }): number { return (left.itemId ?? -1) - (right.itemId ?? -1) || left.code.localeCompare(right.code) || (left.goalId ?? '').localeCompare(right.goalId ?? '') || (left.ruleId ?? '').localeCompare(right.ruleId ?? ''); }
function uniqueReasons<T extends { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }>(reasons: T[]): T[] { const seen = new Set<string>(); return reasons.filter((reason) => { const key = `${reason.itemId ?? ''}:${reason.code}:${reason.goalId ?? ''}:${reason.ruleId ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function publicInvalid(): InventoryAdvisorResultV1 { return { status: 'invalid', reasons: [{ code: 'snapshot_invalid', itemId: null, goalId: null, ruleId: null }], report: null, envelope: null }; }

function materialDepositContext(
	input: InventoryAdvisorInputV1,
	itemId: number,
	positions: InventoryAdvisorPositionV1[],
	capacity: EngineInput['materialStorageCapacity'],
): NonNullable<InventoryAdvisorEngineDecisionV1['materialStorage']> | null {
	if (capacity === undefined || input.snapshot.quality !== 'stable'
		|| input.snapshot.coverage.sources.materials.status !== 'complete') return null;
	const itemCoverage = input.catalog.coverage.items[String(itemId)];
	if (itemCoverage?.status !== 'resolved' || !['network', 'cache_fresh'].includes(itemCoverage.source)
		|| !fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs)) return null;
	const categories = Object.values(input.catalog.materials).filter((category) => category.items.includes(itemId));
	if (categories.length !== 1) return null;
	const categoryCoverage = input.catalog.coverage.materials[String(categories[0]!.id)];
	if (categoryCoverage?.status !== 'resolved' || !['network', 'cache_fresh'].includes(categoryCoverage.source)) return null;
	const storedQuantity = positions.filter((position) => position.source === 'materials')
		.reduce((total, position) => total + position.quantity, 0);
	const spaceBefore = Math.max(0, capacity.quantity - storedQuantity);
	return spaceBefore === 0 ? null : {
		capacity: capacity.quantity,
		capacitySource: capacity.source,
		storedQuantity,
		spaceBefore,
	};
}

function categorySalvageRoute(
	input: InventoryAdvisorInputV1,
	knowledge: InventoryKnowledgeEntryV1 | undefined,
	itemId: number,
	quantity: number,
	positions: InventoryAdvisorPositionV1[],
	evidenceReady: boolean,
	context: EngineInput['equipmentSalvage'],
): { action: 'salvage' | 'review' | 'market'; reason: string; ruleId: string | null } | null {
	const evaluation = evaluateInventoryEquipmentEconomy(
		input, knowledge, itemId, quantity, positions, evidenceReady, context,
	);
	return evaluation === null ? null : salvageRouteFromEvaluation(evaluation);
}

function salvageRouteFromEvaluation(
	evaluation: EquipmentSalvageEconomyResultV1,
): { action: 'salvage' | 'review' | 'market'; reason: string; ruleId: string | null } | null {
	if (evaluation.status === 'not_applicable') return null;
	if (evaluation.status === 'ready') return evaluation.action === 'salvage'
		? { action: 'salvage', reason: 'curated_salvage_economy', ruleId: evaluation.economics.ruleId }
		: { action: 'market', reason: 'market', ruleId: null };
	const reasons: Record<string, string> = {
		catalog_uncertain: 'salvage_item_evidence_uncertain',
		item_type_uncertain: 'salvage_item_evidence_uncertain',
		item_rarity_uncertain: 'salvage_item_evidence_uncertain',
		item_level_uncertain: 'salvage_item_evidence_uncertain',
		no_salvage: 'no_salvage',
		policy_invalid_or_stale: 'rule_stale',
		price_uncertain: 'price_partial',
		output_price_missing: 'salvage_value_unknown',
		exotic_output_rate_unverified: 'salvage_exotic_rate_unverified',
		mystic_stone_cost_unmodeled: 'salvage_mystic_cost_unmodeled',
		arithmetic_overflow: 'arithmetic_overflow',
	};
	return { action: 'review', reason: reasons[evaluation.reason] ?? 'rule_conflict', ruleId: null };
}

function isPotentialEquipmentSalvageItem(input: InventoryAdvisorInputV1, itemId: number): boolean {
	const item = input.catalog.items[String(itemId)];
	return item !== undefined && ['Armor', 'Back', 'Trinket', 'Weapon'].includes(item.type)
		&& (item.rarity === 'Rare' || item.rarity === 'Exotic') && item.level >= 68;
}

function chooseRoute(input: InventoryAdvisorInputV1, knowledge: InventoryKnowledgeEntryV1 | undefined, itemId: number): { action: 'use' | 'open' | 'salvage' | 'review' | 'market' | 'economy'; reason: string; ruleId: string | null } {
	/* An absent curated entry withholds irreversible/use/open/salvage advice. It
	 * may fall through to the independently reproduced liquid route only when
	 * the rule pack has no applicable curated capability for this item. */
	if (knowledge === undefined) {
		const curatedCapability = input.rulePack.rules.some((entry) => entry.itemId === itemId
			&& isApprovedApplicableCapability(input.rulePack, entry));
		return curatedCapability
			? { action: 'review', reason: 'rule_missing', ruleId: null }
			: { action: 'market', reason: 'market', ruleId: null };
	}
	for (const action of ['use', 'open', 'salvage'] as const) {
		const claim = knowledge?.[action] ?? null;
		if (claim === null) return { action: 'review', reason: 'knowledge_missing', ruleId: null };
		const capabilities = input.rulePack.rules.filter((entry) => entry.itemId === itemId && entry.action === action && isApprovedApplicableCapability(input.rulePack, entry));
		if (capabilities.length > 1 || (claim.status === 'not_applicable' && capabilities.length > 0)) {
			return { action: 'review', reason: 'rule_conflict', ruleId: null };
		}
		if (claim.status === 'not_applicable') continue;
		if (!rulePackUsableForCapability(input)) {
			return { action: 'review', reason: 'rule_stale', ruleId: null };
		}
		if (action === 'salvage' && input.catalog.items[String(itemId)]?.flags.includes('NoSalvage')) {
			return { action: 'review', reason: 'no_salvage', ruleId: null };
		}
		const rule = input.rulePack.rules.find((entry) => entry.ruleId === claim.ruleId && entry.itemId === itemId && entry.action === action && isApprovedApplicableCapability(input.rulePack, entry));
		if (!rule) return { action: 'review', reason: 'rule_missing', ruleId: null };
		if (!isEnabledApplicableRule(input.rulePack, rule)) {
			return { action: 'review', reason: input.rulePack.schemaVersion === 2 && 'recommendation' in rule && rule.recommendation.status === 'review_only'
				? rule.recommendation.reason : 'rule_stale', ruleId: null };
		}
		if (action === 'use' && claim.target && unlocked(input, claim)) continue;
		if (action === 'open' && input.rulePack.schemaVersion === 2) {
			return { action: 'economy', reason: 'economic_comparison', ruleId: claim.ruleId };
		}
		return { action, reason: `curated_${action}`, ruleId: claim.ruleId };
	}
	return { action: 'market', reason: 'market', ruleId: null };
}

function containerEconomyDecision(
	input: InventoryAdvisorInputV1,
	economy: EngineInput['containerEconomy'],
	personalValuation: EngineInput['personalValuation'],
	itemId: number,
	freeQuantity: number,
	reservedQuantity: number,
	exceptionQuantity: number,
	reviewQuantity: number,
	positions: InventoryAdvisorPositionV1[],
	knowledgePackSha256: string,
): { action: 'open' | 'sell' | 'vendor'; reason: string; ruleId: string | null }
	| { action: 'review'; reason: string; ruleId: null } {
	if (economy === undefined) return { action: 'review', reason: 'price_partial', ruleId: null };
	const catalogItem = input.catalog.items[String(itemId)];
	if (!catalogItem) return { action: 'review', reason: 'catalog_invalid', ruleId: null };
	const bagPrice = economy.prices.items.find((entry) => entry.itemId === itemId);
	const priceStatus = bagPrice?.bid === null || bagPrice === undefined ? 'missing' : 'available';
	const bindings = positions.map((position) => {
		const holding = input.snapshot.holdings[position.holdingIndex];
		const liquidity = classifyItemLiquidity(holding, catalogItem, priceStatus);
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
			ownedQuantity: input.snapshot.ownedByItem[String(itemId)] ?? 0,
			availableQuantity: input.snapshot.availableByItem[String(itemId)] ?? 0,
			reservedQuantity,
			exceptionQuantity,
			reviewQuantity,
			freeQuantity,
		},
		container: {
			itemId,
			catalogItem,
			binding,
			tradingAccess: input.accountSignals.tradingPostAccess,
		},
		rulePack: input.rulePack,
		knowledgePackSha256,
		economyPack: economy.pack,
		prices: economy.prices,
		marketDepth: economy.marketDepth,
		...(personalValuation === undefined ? {} : { personalValuation }),
	});
	if (result.status !== 'ready') return { action: 'review', reason: result.status === 'invalid'
		? 'rule_conflict' : economyReason(result.reason), ruleId: null };
	return {
		action: result.decision.action,
		reason: result.decision.action === 'open' ? 'curated_open'
			: result.decision.action === 'vendor' ? 'vendor_best_value' : 'instant_sell_best_value',
		ruleId: result.decision.ruleId,
	};
}

function economyReason(reason: string): string {
	const reasons: Record<string, string> = {
		activation_pending: 'economic_activation_pending', activation_revoked: 'rule_stale',
		activation_expired: 'rule_stale', rule_incoherent: 'rule_conflict', model_incoherent: 'rule_conflict',
		allocation_incoherent: 'rule_conflict', binding_unknown: 'binding_unknown',
		trading_access_unknown: 'tp_access_unknown', price_partial: 'price_partial', price_stale: 'price_stale',
		price_future: 'price_stale', price_missing: 'price_missing', price_incoherent: 'price_partial',
		market_depth_missing: 'price_partial', market_depth_partial: 'price_partial',
		market_depth_stale: 'price_stale', market_depth_future: 'price_stale',
		open_ev_partial: 'price_partial', container_not_sellable: 'no_sell',
		personal_valuation_incoherent: 'rule_conflict', arithmetic_overflow: 'arithmetic_overflow',
	};
	return reasons[reason] ?? 'rule_conflict';
}

function marketAction(input: InventoryAdvisorInputV1, position: InventoryAdvisorPositionV1, quantity: number, itemId: number, allowSell: boolean, evidenceReady: boolean,
	marketDepth?: NonNullable<EngineInput['marketDepth']>['items'][number]): { action: 'sell' | 'list' | 'vendor' | 'keep' | 'review'; reason: string } {
	if (!evidenceReady) return { action: 'review', reason: 'evidence_incomplete' };
	const holding = input.snapshot.holdings[position.holdingIndex]!; const item = input.catalog.items[String(itemId)]!; const price = input.prices.items.find((entry) => entry.itemId === itemId);
	const selection = selectInventoryMarketRoute({ holding, item, price, marketDepth,
		tradingPostAccess: input.accountSignals.tradingPostAccess, quantity, allowSell,
		listingMinimumAdvantageBps: input.policy.listingMinimumAdvantageBps });
	return { action: selection.action, reason: selection.reason };
}
function unlocked(input: InventoryAdvisorInputV1, claim: Extract<InventoryRouteClaimV1, { status: 'applicable' }>): boolean {
	if (!claim.target) return false;
	if (claim.target.kind === 'recipe') return input.accountSignals.unlockedRecipes?.includes(claim.target.id) ?? false;
	if (claim.target.kind === 'skin') return input.accountSignals.unlockedSkins?.includes(claim.target.id) ?? false;
	if (claim.target.kind === 'mini') return input.accountSignals.unlockedMinis?.includes(claim.target.id) ?? false;
	if (claim.target.kind === 'achievement') { const target = claim.target; const progress = input.accountSignals.achievementProgress?.find((entry) => entry.achievementId === target.achievementId); return progress?.done === true || (target.bit !== null && progress?.bits?.includes(target.bit) === true); }
	return false;
}
function recommendationEvidenceReady(
	input: InventoryAdvisorInputV1,
	plan: { coverage: string },
	itemId: number,
): boolean {
	const catalogEntry = input.catalog.coverage.items[String(itemId)];
	const catalog = catalogEntry?.status === 'resolved'
		&& (catalogEntry.source === 'network' || catalogEntry.source === 'cache_fresh');
	const priceAccounted = input.prices.requestedItemIds.includes(itemId)
		&& (input.prices.items.some((entry) => entry.itemId === itemId)
			|| input.prices.missingItemIds.includes(itemId));
	return priceAccounted && catalog && inventorySnapshotCoverageComplete(input)
		&& ['stable', 'stable_owned_placement_changed', 'unstable'].includes(input.snapshot.quality)
		&& plan.coverage === 'complete' && input.accountSignals.unlockCoverage === 'complete'
		&& input.accountSignals.achievementCoverage === 'complete'
		&& Object.values(input.accountSignals.endpointCoverage).every((entry) => entry.status === 'complete')
		&& fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs);
}
function inventorySnapshotCoverageComplete(input: InventoryAdvisorInputV1): boolean {
	return input.snapshot.coverage.sources.characters.status === 'complete'
		&& input.snapshot.coverage.sources.shared_inventory.status === 'complete';
}
function rulePackFresh(input: InventoryAdvisorInputV1): boolean {
	const pack = input.rulePack;
	return (pack.schemaVersion === 1 || (pack.reviewStatus === 'human_reviewed' && pack.reviewedAt !== null))
		&& pack.reviewedAt !== null && fresh(pack.reviewedAt, input.asOf, input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs)
		&& (pack.schemaVersion === 2 ? Date.parse(input.asOf) < Date.parse(pack.validUntil)
			: Date.parse(input.asOf) <= Date.parse(pack.validUntil) + input.policy.maxFutureSkewMs);
}
/** Pending V2 review may explain a withheld capability, but never after its exact expiry. */
function rulePackUsableForCapability(input: InventoryAdvisorInputV1): boolean {
	const pack = input.rulePack;
	return pack.schemaVersion === 2
		? Date.parse(input.asOf) >= Date.parse(pack.publishedAt) && Date.parse(input.asOf) < Date.parse(pack.validUntil)
		: rulePackFresh(input);
}
function knowledgeFresh(pack: InventoryKnowledgePackV1, input: InventoryAdvisorInputV1): boolean { return fresh(pack.reviewedAt, input.asOf, input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs) && Date.parse(pack.publishedAt) <= Date.parse(pack.reviewedAt) && Date.parse(input.asOf) <= Date.parse(pack.validUntil) + input.policy.maxFutureSkewMs; }
function isEngineInput(value: unknown): value is InventoryAdvisorEngineInputV1 {
	if (!record(value) || !optionalKeys(value, ['input', 'knowledgePack'], [
		'containerEconomy', 'personalValuation', 'activeOrders', 'materialStorageCapacity', 'marketDepth', 'equipmentSalvage',
	])
		|| !isInventoryAdvisorInput(value.input) || !isInventoryKnowledgePack(value.knowledgePack)) return false;
	const input = value.input;
	if (value.equipmentSalvage !== undefined && (!record(value.equipmentSalvage)
		|| !keys(value.equipmentSalvage, ['policy', 'preferences', 'prices', 'marketDepth'])
		|| !isEquipmentSalvagePolicy(value.equipmentSalvage.policy)
		|| !isEquipmentSalvagePreferences(value.equipmentSalvage.preferences)
		|| (value.equipmentSalvage.prices !== null
			&& (!isInventoryContainerPriceEvidence(value.equipmentSalvage.prices)
				|| value.equipmentSalvage.prices.accountId !== input.snapshot.accountId
				|| value.equipmentSalvage.prices.snapshotId !== input.snapshot.snapshotId
				|| !fresh(value.equipmentSalvage.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
					input.policy.maxFutureSkewMs)))
		|| (value.equipmentSalvage.marketDepth !== null
			&& (!isInventoryMarketDepthEvidence(value.equipmentSalvage.marketDepth)
				|| value.equipmentSalvage.marketDepth.requestedItemIds.length !== 1
				|| value.equipmentSalvage.marketDepth.requestedItemIds[0] !== value.equipmentSalvage.policy.outputItemId
				|| !fresh(value.equipmentSalvage.marketDepth.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
					input.policy.maxFutureSkewMs))))) return false;
	if (value.materialStorageCapacity !== undefined && (!record(value.materialStorageCapacity)
		|| !keys(value.materialStorageCapacity, ['quantity', 'source'])
		|| !materialCapacity(value.materialStorageCapacity.quantity)
		|| !['configured', 'minimum_guaranteed'].includes(String(value.materialStorageCapacity.source))
		|| (value.materialStorageCapacity.source === 'minimum_guaranteed'
			&& value.materialStorageCapacity.quantity !== 250))) return false;
	if (value.activeOrders !== undefined && (!isActiveTradingPostOrdersEvidence(value.activeOrders)
		|| value.activeOrders.accountId !== input.snapshot.accountId
		|| !fresh(value.activeOrders.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
			input.policy.maxFutureSkewMs))) return false;
	if (value.marketDepth !== undefined && (!isInventoryMarketDepthEvidence(value.marketDepth)
		|| value.marketDepth.requestedItemIds.length !== input.prices.requestedItemIds.length
		|| !value.marketDepth.requestedItemIds.every((itemId, index) => itemId === input.prices.requestedItemIds[index])
		|| !fresh(value.marketDepth.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
			input.policy.maxFutureSkewMs))) return false;
	const economy = value.containerEconomy;
	if (economy !== undefined && (!record(economy) || !keys(economy, ['pack', 'prices', 'marketDepth'])
		|| !isInventoryContainerEconomyPack(economy.pack)
		|| !isInventoryContainerPriceEvidence(economy.prices)
		|| (economy.marketDepth !== null && (!isInventoryMarketDepthEvidence(economy.marketDepth)
			|| !fresh(economy.marketDepth.capturedAt, input.asOf, input.policy.maxPriceAgeMs,
				input.policy.maxFutureSkewMs))))) return false;
	if (value.personalValuation === undefined) return true;
	if (economy === undefined || !isContainerPersonalValuation(value.personalValuation)) return false;
	const validatedEconomy = economy as NonNullable<EngineInput['containerEconomy']>;
	return resolveContainerPersonalValuation(validatedEconomy.pack.model, value.personalValuation).status === 'ok';
}

function applyActiveOrderPolicy(
	line: InventoryAdvisorEngineLineV1,
	activeOrders: InventoryAdvisorEngineInputV1['activeOrders'],
): InventoryAdvisorEngineLineV1 {
	if (activeOrders === undefined) return line;
	return {
		...line,
		decisions: line.decisions.map((decision) => {
			const side = decision.action === 'sell' ? 'buy' : decision.action === 'list' ? 'sell' : null;
			if (side === null) return decision;
			const coverage = activeOrders.endpointCoverage[side];
			if (coverage.status !== 'complete') return decision;
			if (!activeOrders.orders.some((order) => order.side === side && order.itemId === line.itemId)) {
				return decision;
			}
			return { ...decision, action: 'review' as const,
				reason: side === 'buy' ? 'active_buy_order' : 'active_sell_order', ruleId: null };
		}),
	};
}
function ids(input: InventoryAdvisorInputV1): number[] { return Object.entries(input.snapshot.ownedByItem).filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort((a, b) => a - b); }
function invalid(): InventoryAdvisorEngineResultV1 { return { status: 'invalid', report: null, envelope: null }; }
function entry(value: unknown): value is InventoryKnowledgeEntryV1 { return record(value) && keys(value, ['itemId', 'use', 'open', 'salvage']) && positive(value.itemId) && claim(value.use, 'use') && claim(value.open, 'open') && claim(value.salvage, 'salvage'); }
function claim(value: unknown, action: 'use' | 'open' | 'salvage'): value is InventoryRouteClaimV1 | null { if (value === null) return true; if (!record(value) || !Array.isArray(value.sourceIds) || value.sourceIds.length === 0 || !value.sourceIds.every(id) || !sorted(value.sourceIds, (a, b) => a.localeCompare(b))) return false; if (value.status === 'not_applicable') return keys(value, ['status', 'assertionId', 'sourceIds']) && id(value.assertionId); return value.status === 'applicable' && keys(value, action === 'use' && value.target !== undefined ? ['status', 'ruleId', 'sourceIds', 'target'] : ['status', 'ruleId', 'sourceIds']) && id(value.ruleId) && (action !== 'use' || value.target === undefined || target(value.target)); }
function claimsReferenceSources(entry: InventoryKnowledgeEntryV1, sources: string[]): boolean { return [entry.use, entry.open, entry.salvage].every((claim) => claim === null || claim.sourceIds.every((sourceId) => sources.includes(sourceId))); }
function distinctNotApplicableAssertions(entry: InventoryKnowledgeEntryV1): boolean { const claims = [entry.use, entry.open, entry.salvage].filter((claim): claim is Extract<InventoryRouteClaimV1, { status: 'not_applicable' }> => claim?.status === 'not_applicable'); return new Set(claims.map((claim) => claim.assertionId)).size === claims.length; }
function target(value: unknown): boolean { return record(value) && ((value.kind === 'generic_consumable' && keys(value, ['kind'])) || ((value.kind === 'recipe' || value.kind === 'skin' || value.kind === 'mini') && keys(value, ['kind', 'id']) && positive(value.id)) || (value.kind === 'achievement' && keys(value, ['kind', 'achievementId', 'bit']) && positive(value.achievementId) && (value.bit === null || nonNegative(value.bit)))); }
function line(value: unknown): value is InventoryAdvisorEngineLineV1 {
	if (!record(value) || !keys(value, ['itemId', 'name', 'ownedQuantity', 'positions', 'decisions']) || !positive(value.itemId) || typeof value.name !== 'string' || !positive(value.ownedQuantity) || !Array.isArray(value.positions) || !Array.isArray(value.decisions) || !value.decisions.every(decision)) return false;
	const positions = value.positions as InventoryAdvisorPositionV1[];
	const decisions = value.decisions;
	if (!positions.every(position) || !sorted(positions, (left, right) => left.holdingIndex - right.holdingIndex)) return false;
	const totals = new Map(positions.map((position) => [position.ref, 0]));
	for (const item of decisions) for (const allocation of item.allocations) {
		if (!totals.has(allocation.positionRef)) return false;
		totals.set(allocation.positionRef, totals.get(allocation.positionRef)! + allocation.quantity);
	}
	return positions.every((position) => totals.get(position.ref) === position.quantity) && positions.reduce((sum, position) => sum + position.quantity, 0) === value.ownedQuantity;
}
function position(value: unknown): value is InventoryAdvisorPositionV1 { return record(value) && keys(value, ['ref', 'holdingIndex', 'itemId', 'quantity', 'source', 'state']) && typeof value.ref === 'string' && nonNegative(value.holdingIndex) && positive(value.itemId) && positive(value.quantity) && value.ref === `#/positions/${value.itemId}/${value.holdingIndex}` && ['character', 'shared_inventory', 'bank', 'materials', 'commerce_delivery'].includes(String(value.source)) && ['loose', 'equipped_container', 'embedded_upgrade', 'embedded_infusion', 'pending_claim'].includes(String(value.state)); }
function decision(value: unknown): value is InventoryAdvisorEngineDecisionV1 {
	if (!record(value) || !optionalKeys(value, ['action', 'itemId', 'quantity', 'allocations', 'reason', 'ruleId'], ['materialStorage'])
		|| !['sell', 'list', 'vendor', 'salvage', 'use', 'open', 'deposit_material', 'keep', 'review'].includes(String(value.action))
		|| !positive(value.itemId) || !positive(value.quantity) || !Array.isArray(value.allocations)
		|| !value.allocations.every((allocation) => record(allocation) && keys(allocation, ['positionRef', 'quantity'])
			&& typeof allocation.positionRef === 'string' && positive(allocation.quantity))
		|| typeof value.reason !== 'string' || (value.ruleId !== null && !id(value.ruleId))) return false;
	return value.action === 'deposit_material' ? materialStorageContext(value.materialStorage) : value.materialStorage === undefined;
}
function source(value: unknown): boolean { return record(value) && keys(value, ['id', 'url', 'retrievedAt']) && id(value.id) && typeof value.url === 'string' && value.url.startsWith('https://') && iso(value.retrievedAt); }
function record(value: unknown): value is Record<string, unknown> { try { return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); } catch { return false; } }
function keys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sortedExpected = [...expected].sort(); return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]); }
function optionalKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean { const actual = Object.keys(value); return required.every((key) => actual.includes(key)) && actual.every((key) => required.includes(key) || optional.includes(key)); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function materialCapacity(value: unknown): value is number {
	return positive(value) && value >= 250 && value <= 3000 && value % 250 === 0;
}
function materialStorageContext(value: unknown): boolean {
	return record(value) && keys(value, ['capacity', 'capacitySource', 'storedQuantity', 'spaceBefore'])
		&& materialCapacity(value.capacity)
		&& ['configured', 'minimum_guaranteed'].includes(String(value.capacitySource))
		&& (value.capacitySource !== 'minimum_guaranteed' || value.capacity === 250)
		&& nonNegative(value.storedQuantity) && nonNegative(value.spaceBefore)
		&& value.spaceBefore === Math.max(0, value.capacity - value.storedQuantity);
}
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function fresh(capturedAt: string, asOf: string, maxAge: number, maxFutureSkew: number): boolean { const delta = Date.parse(asOf) - Date.parse(capturedAt); return Number.isSafeInteger(delta) && delta <= maxAge && delta >= -maxFutureSkew; }
function sorted<T>(values: T[], compare: (left: T, right: T) => number): boolean { return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0); }
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function json(value: unknown): boolean { try { return JSON.stringify(value) !== undefined; } catch { return false; } }
