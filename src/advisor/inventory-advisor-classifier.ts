import { buildReservationBalance, createReservationPlan } from '../economy/reservation';
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

/** Pure H4.15 classifier producing the public H4.13 report and manual envelope. */
export function classifyInventoryAdvisor(value: unknown): InventoryAdvisorResultV1 {
	try {
		if (!isEngineInput(value)) return publicInvalid();
		const engine = classifyInventoryAdvisorEngine(value);
		if (engine.status === 'invalid' || engine.report === null) return publicInvalid();
		const { input } = value;
		const balance = buildReservationBalance(input.snapshot);
		const plan = balance.status === 'ok' ? createReservationPlan({ goals: input.goals, balance: balance.balance }) : { status: 'invalid' as const };
		if (plan.status !== 'ok') return publicInvalid();
		const publicLines = engine.report.lines.map((line) => publicLine(line, input, plan.plan));
		const lines = publicLines.map((entry) => entry.line);
		const coverage: 'complete' | 'limited' = lines.every((line) => Object.values(line.coverage).every((entry) => entry === 'complete')) ? 'complete' : 'limited';
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
		return isInventoryAdvisorResultForInput(result, input, value.knowledgePack) ? result : publicInvalid();
	} catch { return publicInvalid(); }
}

/** Internal classification representation preserves route provenance while the public report is assembled. */
function classifyInventoryAdvisorEngine(value: unknown): InventoryAdvisorEngineResultV1 {
	try {
		if (!isEngineInput(value)) return invalid();
		const { input, knowledgePack } = value;
		const balance = buildReservationBalance(input.snapshot);
		const plan = balance.status === 'ok' ? createReservationPlan({ goals: input.goals, balance: balance.balance }) : { status: 'invalid' as const };
		if (plan.status !== 'ok') return invalid();
		const inputRulesFresh = rulePackFresh(input);
		const complete = evidenceComplete(input, plan.plan) && knowledgeFresh(knowledgePack, input);
		const lines = ids(input).map((itemId) => classifyLine(input, knowledgePack, itemId,
			plan.plan.assets.find((asset) => asset.key === `item:${itemId}`)?.protectedAvailable ?? 0, complete,
			inputRulesFresh ? 'evidence_incomplete' : 'rule_stale'));
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
		return report.lines.every((item) => item.decisions.flatMap((decision) => decision.allocations).reduce((sum, allocation) => sum + allocation.quantity, 0) === item.ownedQuantity);
	} catch { return false; }
}

function classifyLine(input: InventoryAdvisorInputV1, pack: InventoryKnowledgePackV1, itemId: number, reserved: number, evidenceReady: boolean, incompleteReason: string): InventoryAdvisorEngineLineV1 {
	const positions = input.snapshot.holdings.map((holding, holdingIndex) => ({ holding, holdingIndex })).filter((entry) => entry.holding.kind === 'item' && entry.holding.itemId === itemId)
		.map(({ holding, holdingIndex }) => ({ ref: `#/positions/${itemId}/${holdingIndex}`, holdingIndex, itemId, quantity: holding.quantity, source: holding.location.source, state: holding.state }));
	const remaining = new Map(positions.map((position) => [position.ref, position.quantity]));
	const decisions: InventoryAdvisorEngineDecisionV1[] = [];
	const add = (action: InventoryAdvisorEngineDecisionV1['action'], position: InventoryAdvisorPositionV1, quantity: number, reason: string, ruleId: string | null = null): void => {
		if (quantity <= 0) return; remaining.set(position.ref, (remaining.get(position.ref) ?? 0) - quantity);
		decisions.push({ action, itemId, quantity, allocations: [{ positionRef: position.ref, quantity }], reason, ruleId });
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
	let bidRemaining = input.prices.items.find((entry) => entry.itemId === itemId)?.bid?.quantity ?? 0;
	for (const position of positions) {
		const quantity = remaining.get(position.ref) ?? 0; if (quantity === 0) continue;
		if (position.state !== 'loose') { add('review', position, quantity, 'position_not_actionable'); continue; }
		const route = chooseRoute(input, knowledge, itemId, quantity);
		if (route.action === 'review' || !evidenceReady) { add('review', position, quantity, route.action === 'review' ? route.reason : incompleteReason); continue; }
		if (route.action === 'use' || route.action === 'open' || route.action === 'salvage') { add(route.action, position, quantity, route.reason, route.ruleId); continue; }
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

function publicLine(engine: InventoryAdvisorEngineLineV1, input: InventoryAdvisorInputV1, plan: { assets: Array<{ key: string; coverage: string }> }) {
	const asset = plan.assets.find((entry) => entry.key === `item:${engine.itemId}`);
	const coverage = publicCoverage(input, engine.itemId, asset?.coverage ?? 'unknown');
	const sources = engine.decisions.map((source, index) => ({ source, decision: {
		action: source.action, itemId: source.itemId, quantity: source.quantity,
		allocations: source.allocations, explanationRef: `#/explanations/${engine.itemId}/${index}`,
		ruleId: source.ruleId, safety: 'manual_only' as const, discardProof: null,
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
	const prices = input.prices.status === 'complete' && fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs);
	const signalsFresh = fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs);
	const signals = signalsFresh && input.accountSignals.unlockCoverage === 'complete' && input.accountSignals.achievementCoverage === 'complete' && input.accountSignals.tradingPostAccess !== 'unknown';
	const rules = rulePackFresh(input);
	const snapshot = input.snapshot.quality === 'stable' && Object.values(input.snapshot.coverage.sources).every((entry) => entry.status === 'complete');
	return {
		snapshot: snapshot ? 'complete' : 'limited', inventory: reservation === 'complete' ? 'complete' : reservation === 'limited' ? 'limited' : 'unknown',
		catalog: catalog ? 'complete' : catalogCoverage ? 'limited' : 'unknown', prices: prices ? 'complete' : input.prices.status === 'partial' ? 'limited' : 'unknown',
		reservations: reservation === 'complete' ? 'complete' : reservation === 'limited' ? 'limited' : 'unknown', accountSignals: signals ? 'complete' : signalsFresh ? 'limited' : 'unknown', rules: rules ? 'complete' : 'limited',
	};
}

function reasonFor(value: string): InventoryAdvisorReasonCode {
	const reasons: Record<string, InventoryAdvisorReasonCode> = {
		alternative_route_exists: 'alternative_route_exists', no_sell: 'no_sell',
		reserved_for_goal: 'reserved_for_goal', user_keep_exception: 'user_keep_exception', position_not_actionable: 'position_not_actionable',
		knowledge_missing: 'rule_missing', rule_missing: 'rule_missing', rule_conflict: 'rule_conflict', rule_stale: 'rule_stale', evidence_incomplete: 'price_partial', no_salvage: 'no_salvage',
		economic_comparison_missing: 'economic_comparison_missing',
		tp_access_unknown: 'tp_access_unknown', catalog_invalid: 'catalog_invalid', vendor_best_value: 'alternative_route_exists',
		instant_sell_best_value: 'alternative_route_exists', listing_advantage_met: 'alternative_route_exists', listing_only_route: 'alternative_route_exists', no_supported_route: 'no_sell',
		curated_use: 'alternative_route_exists', curated_open: 'alternative_route_exists', curated_salvage: 'alternative_route_exists',
	};
	return reasons[value] ?? 'snapshot_invalid';
}
function reasonOrder(left: { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }, right: { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }): number { return (left.itemId ?? -1) - (right.itemId ?? -1) || left.code.localeCompare(right.code) || (left.goalId ?? '').localeCompare(right.goalId ?? '') || (left.ruleId ?? '').localeCompare(right.ruleId ?? ''); }
function uniqueReasons<T extends { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }>(reasons: T[]): T[] { const seen = new Set<string>(); return reasons.filter((reason) => { const key = `${reason.itemId ?? ''}:${reason.code}:${reason.goalId ?? ''}:${reason.ruleId ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function publicInvalid(): InventoryAdvisorResultV1 { return { status: 'invalid', reasons: [{ code: 'snapshot_invalid', itemId: null, goalId: null, ruleId: null }], report: null, envelope: null }; }

function chooseRoute(input: InventoryAdvisorInputV1, knowledge: InventoryKnowledgeEntryV1 | undefined, itemId: number, quantity: number): { action: 'use' | 'open' | 'salvage' | 'review' | 'market'; reason: string; ruleId: string | null } {
	if (!rulePackUsableForCapability(input)) return { action: 'review', reason: 'rule_stale', ruleId: null };
	for (const action of ['use', 'open', 'salvage'] as const) {
		const claim = knowledge?.[action] ?? null;
		if (claim === null) return { action: 'review', reason: 'knowledge_missing', ruleId: null };
		const capabilities = input.rulePack.rules.filter((entry) => entry.itemId === itemId && entry.action === action && isApprovedApplicableCapability(input.rulePack, entry));
		if (capabilities.length > 1 || (claim.status === 'not_applicable' && capabilities.length > 0)) {
			return { action: 'review', reason: 'rule_conflict', ruleId: null };
		}
		if (claim.status === 'not_applicable') continue;
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
		return { action, reason: `curated_${action}`, ruleId: claim.ruleId };
	}
	return { action: 'market', reason: 'market', ruleId: null };
}

function marketAction(input: InventoryAdvisorInputV1, position: InventoryAdvisorPositionV1, quantity: number, itemId: number, allowSell: boolean, evidenceReady: boolean): { action: 'sell' | 'list' | 'vendor' | 'keep' | 'review'; reason: string } {
	if (!evidenceReady) return { action: 'review', reason: 'evidence_incomplete' };
	const holding = input.snapshot.holdings[position.holdingIndex]!; const item = input.catalog.items[String(itemId)]!; const price = input.prices.items.find((entry) => entry.itemId === itemId);
	const selection = selectInventoryMarketRoute({ holding, item, price,
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
function evidenceComplete(input: InventoryAdvisorInputV1, plan: { coverage: string }): boolean {
	const catalog = Object.values(input.catalog.coverage.items).every((entry) => entry.status === 'resolved'
		&& (entry.source === 'network' || entry.source === 'cache_fresh'));
	return input.prices.status === 'complete' && catalog && input.snapshot.quality === 'stable'
		&& Object.values(input.snapshot.coverage.sources).every((entry) => entry.status === 'complete')
		&& plan.coverage === 'complete' && input.accountSignals.unlockCoverage === 'complete'
		&& input.accountSignals.achievementCoverage === 'complete'
		&& Object.values(input.accountSignals.endpointCoverage).every((entry) => entry.status === 'complete')
		&& fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs)
		&& rulePackFresh(input);
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
function isEngineInput(value: unknown): value is InventoryAdvisorEngineInputV1 { return record(value) && keys(value, ['input', 'knowledgePack']) && isInventoryAdvisorInput(value.input) && isInventoryKnowledgePack(value.knowledgePack); }
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
function decision(value: unknown): value is InventoryAdvisorEngineDecisionV1 { return record(value) && keys(value, ['action', 'itemId', 'quantity', 'allocations', 'reason', 'ruleId']) && ['sell', 'list', 'vendor', 'salvage', 'use', 'open', 'keep', 'review'].includes(String(value.action)) && positive(value.itemId) && positive(value.quantity) && Array.isArray(value.allocations) && value.allocations.every((allocation) => record(allocation) && keys(allocation, ['positionRef', 'quantity']) && typeof allocation.positionRef === 'string' && positive(allocation.quantity)) && typeof value.reason === 'string' && (value.ruleId === null || id(value.ruleId)); }
function source(value: unknown): boolean { return record(value) && keys(value, ['id', 'url', 'retrievedAt']) && id(value.id) && typeof value.url === 'string' && value.url.startsWith('https://') && iso(value.retrievedAt); }
function record(value: unknown): value is Record<string, unknown> { try { return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); } catch { return false; } }
function keys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sortedExpected = [...expected].sort(); return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function fresh(capturedAt: string, asOf: string, maxAge: number, maxFutureSkew: number): boolean { const delta = Date.parse(asOf) - Date.parse(capturedAt); return Number.isSafeInteger(delta) && delta <= maxAge && delta >= -maxFutureSkew; }
function sorted<T>(values: T[], compare: (left: T, right: T) => number): boolean { return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0); }
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function json(value: unknown): boolean { try { return JSON.stringify(value) !== undefined; } catch { return false; } }
