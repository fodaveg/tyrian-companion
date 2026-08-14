import { isComparableStorageSnapshot } from '../account/storage-delta';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { canonicalJson, sha256CanonicalValue as standardSha256CanonicalValue } from '../core/canonical-sha256';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import {
	isNormalizedCatalogCurrency,
	isNormalizedCatalogItem,
	isNormalizedCatalogMaterial,
} from '../catalog/public-catalog-validators';
import { isReservationGoal } from '../economy/reservation';
import {
	INVENTORY_ADVISOR_POLICY_VERSION,
	INVENTORY_ADVISOR_SCOPE,
	INVENTORY_ADVISOR_VERSION,
	INVENTORY_PRICE_SNAPSHOT_VERSION,
	INVENTORY_RULE_PACK_VERSION,
	type AccountSignalsV1,
	type InventoryAdvisorCoverageV1,
	type InventoryDecisionAllocationV1,
	type InventoryDiscardProofV1,
	type InventoryAdvisorExplanationV1,
	type InventoryAchievementProgressV1,
	type InventoryAdvisorInputV1,
	type InventoryAdvisorLineV1,
	type InventoryAdvisorPolicyV1,
	type InventoryAdvisorPositionV1,
	type InventoryAdvisorReasonCode,
	type InventoryAdvisorReasonV1,
	type InventoryAdvisorReportV1,
	type InventoryAdvisorRulePack,
	type InventoryAdvisorRulePackV1,
	type InventoryAdvisorRulePackV2,
	type InventoryAdvisorRuleV1,
	type InventoryAdvisorRuleV2,
	type InventoryItemPriceV1,
	type InventoryPriceSideV1,
	type InventoryPriceSnapshotV1,
	type InventoryRecommendationAction,
	type InventoryRecommendationDecisionV1,
	type InventoryRuleSourceV1,
	type KeepExceptionV1,
} from './inventory-advisor-model';

const ACTIONS: InventoryRecommendationAction[] = [
	'sell', 'list', 'vendor', 'salvage', 'use', 'open', 'keep', 'review', 'discard_candidate',
];
const REASONS: InventoryAdvisorReasonCode[] = [
	'snapshot_invalid', 'snapshot_scope_limited', 'identity_mismatch', 'catalog_missing',
	'catalog_invalid', 'catalog_stale', 'price_missing', 'price_stale', 'price_partial',
	'binding_unknown', 'tp_access_unknown', 'position_not_actionable', 'reserved_for_goal',
	'user_keep_exception', 'rule_missing', 'rule_stale', 'rule_conflict', 'economic_comparison_missing',
	'economic_activation_pending',
	'unlock_coverage_unknown', 'collection_coverage_unknown', 'already_unlocked', 'no_sell',
	'no_salvage', 'salvage_value_unknown', 'delete_warning', 'alternative_route_exists',
	'discard_not_allowlisted', 'arithmetic_overflow',
];

export function isInventoryAdvisorInput(value: unknown): value is InventoryAdvisorInputV1 {
	return safeGuard(() => isInventoryAdvisorInputUnsafe(value));
}
export function isInventoryPriceSnapshot(value: unknown): value is InventoryPriceSnapshotV1 {
	return safeGuard(() => isInventoryPriceSnapshotUnsafe(value));
}
export function isKeepException(value: unknown): value is KeepExceptionV1 {
	return safeGuard(() => isKeepExceptionUnsafe(value));
}
export function isAccountSignals(value: unknown): value is AccountSignalsV1 {
	return safeGuard(() => isAccountSignalsUnsafe(value));
}
export function isInventoryAdvisorRulePack(value: unknown): value is InventoryAdvisorRulePackV1 {
	return safeGuard(() => isInventoryAdvisorRulePackUnsafe(value));
}
/** Accepts the frozen V1 contract and the explicit V2 curation contract. */
export function isInventoryAdvisorRulePackAny(value: unknown): value is InventoryAdvisorRulePack {
	return safeGuard(() => isInventoryAdvisorRulePackUnsafe(value) || isInventoryAdvisorRulePackV2Unsafe(value));
}
export function isInventoryAdvisorRulePackV2(value: unknown): value is InventoryAdvisorRulePackV2 {
	return safeGuard(() => isInventoryAdvisorRulePackV2Unsafe(value));
}
export function isInventoryAdvisorPolicy(value: unknown): value is InventoryAdvisorPolicyV1 {
	return safeGuard(() => isInventoryAdvisorPolicyUnsafe(value));
}
export function isInventoryAdvisorReport(value: unknown): value is InventoryAdvisorReportV1 {
	return safeGuard(() => isInventoryAdvisorReportUnsafe(value));
}
export function isInventoryAdvisorReason(value: unknown): value is InventoryAdvisorReasonV1 {
	return safeGuard(() => isInventoryAdvisorReasonUnsafe(value));
}

/** Economic decisions require a fresh, resolved catalog record for their item. */
export function validDecisionAgainstInput(input: unknown, decision: unknown): boolean {
	return safeGuard(() => {
		if (!isInventoryAdvisorInputUnsafe(input) || !isDecision(decision)) return false;
		if (!['sell', 'list', 'vendor', 'salvage', 'use', 'open'].includes(decision.action)) return true;
		const coverage = input.catalog.coverage.items[String(decision.itemId)];
		return coverage?.status === 'resolved' && (coverage.source === 'network' || coverage.source === 'cache_fresh');
	});
}

function isInventoryAdvisorInputUnsafe(value: unknown): value is InventoryAdvisorInputV1 {
	if (!record(value) || !keys(value, [
		'version', 'asOf', 'snapshot', 'catalog', 'prices', 'goals', 'keepExceptions',
		'accountSignals', 'rulePack', 'policy',
	]) || value.version !== INVENTORY_ADVISOR_VERSION || !iso(value.asOf)
		|| !isComparableStorageSnapshot(value.snapshot) || !isCatalogResolution(value.catalog)
		|| !isInventoryPriceSnapshot(value.prices) || !Array.isArray(value.goals)
		|| !value.goals.every(isReservationGoal) || !unique(value.goals.map((goal) => goal.goalId))
		|| !Array.isArray(value.keepExceptions) || !value.keepExceptions.every(isKeepException)
		|| !isAccountSignals(value.accountSignals) || !isInventoryAdvisorRulePackAny(value.rulePack)
		|| !isInventoryAdvisorPolicy(value.policy)) return false;
	const snapshot = value.snapshot;
	const catalog = value.catalog;
	const prices = value.prices;
	const signals = value.accountSignals;
	const availableItemIds = Object.entries(snapshot.availableByItem)
		.filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort(numberOrder);
	const ownedItemIds = Object.entries(snapshot.ownedByItem)
		.filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort(numberOrder);
	const catalogItemIds = Object.keys(catalog.coverage.items).map(Number).sort(numberOrder);
	return snapshot.accountId === prices.accountId
		&& fresh(snapshot.completedAt, value.asOf, value.policy.maxSnapshotAgeMs, value.policy.maxFutureSkewMs)
		&& snapshot.accountId === signals.accountId
		&& snapshot.snapshotId === catalog.snapshotId
		&& snapshot.snapshotId === prices.snapshotId
		&& catalog.schemaVersion === snapshot.schemaVersion
		&& prices.schemaVersion === snapshot.schemaVersion
		&& sameNumbers(prices.requestedItemIds, availableItemIds)
		&& catalogItemIds.every(positive) && sameNumbers(catalogItemIds, ownedItemIds)
		&& unique(value.keepExceptions.map((exception) => exception.exceptionId))
		&& strictlySorted(value.keepExceptions, keepExceptionOrder)
		&& jsonRoundTrip(value);
}

function isInventoryPriceSnapshotUnsafe(value: unknown): value is InventoryPriceSnapshotV1 {
	if (!record(value) || !keys(value, [
		'version', 'accountId', 'snapshotId', 'capturedAt', 'source', 'schemaVersion',
		'requestedItemIds', 'status', 'items', 'missingItemIds',
	]) || value.version !== INVENTORY_PRICE_SNAPSHOT_VERSION || !text(value.accountId)
		|| !text(value.snapshotId) || !iso(value.capturedAt) || value.source !== 'gw2-commerce-prices'
		|| value.schemaVersion !== PINNED_SCHEMA || !idArray(value.requestedItemIds)
		|| !['complete', 'partial', 'unavailable'].includes(String(value.status))
		|| !Array.isArray(value.items) || !value.items.every(isItemPrice)
		|| !strictlySorted(value.items, (left, right) => left.itemId - right.itemId)
		|| !idArray(value.missingItemIds)) return false;
	const itemIds = value.items.map((item) => item.itemId);
	if (!sameNumbers(value.requestedItemIds, [...itemIds, ...value.missingItemIds].sort(numberOrder))) return false;
	const complete = value.missingItemIds.length === 0;
	if (value.status === 'complete' && !complete) return false;
	if (value.status === 'unavailable' && value.items.length !== 0) return false;
	if (value.status === 'partial' && (value.items.length === 0 || value.missingItemIds.length === 0)) return false;
	return jsonRoundTrip(value);
}

function isKeepExceptionUnsafe(value: unknown): value is KeepExceptionV1 {
	if (!record(value) || !keys(value, [
		'version', 'exceptionId', 'itemId', 'status', 'basis', 'quantity', 'reason',
	]) || value.version !== INVENTORY_ADVISOR_VERSION || !identifier(value.exceptionId)
		|| !positive(value.itemId) || !['active', 'paused'].includes(String(value.status))
		|| !['owned', 'available'].includes(String(value.basis))
		|| !['user_keep', 'build', 'gift', 'collection', 'custom'].includes(String(value.reason))
		|| !record(value.quantity)) return false;
	return value.quantity.mode === 'all'
		? keys(value.quantity, ['mode'])
		: value.quantity.mode === 'minimum' && keys(value.quantity, ['mode', 'value'])
			&& positive(value.quantity.value);
}

function isAccountSignalsUnsafe(value: unknown): value is AccountSignalsV1 {
	if (!record(value) || !keys(value, [
		'version', 'source', 'accountId', 'capturedAt', 'schemaVersion', 'tradingPostAccess', 'endpointCoverage', 'unlockCoverage',
		'unlockedRecipes', 'unlockedSkins', 'unlockedMinis', 'achievementCoverage',
		'completedAchievementBits', 'achievementProgress',
	]) || value.version !== INVENTORY_ADVISOR_VERSION || value.source !== 'gw2-account-api' || !text(value.accountId)
		|| !iso(value.capturedAt) || value.schemaVersion !== PINNED_SCHEMA
		|| !['full', 'free_to_play', 'unknown'].includes(String(value.tradingPostAccess))
		|| !endpointCoverage(value.endpointCoverage) || !coverageEvidence(value.unlockCoverage) || !coverageEvidence(value.achievementCoverage)) return false;
	const unlocks = [value.unlockedRecipes, value.unlockedSkins, value.unlockedMinis];
	if (!unlocks.every((ids) => ids === null || idArray(ids))) return false;
	const signalsCapturedAt = value.capturedAt;
	if (value.endpointCoverage.account.status !== 'complete' || Object.values(value.endpointCoverage)
		.some((endpoint) => endpoint.capturedAt !== null && Date.parse(endpoint.capturedAt) > Date.parse(signalsCapturedAt))) return false;
	const endpointUnlocks = [value.endpointCoverage.recipes, value.endpointCoverage.skins, value.endpointCoverage.minis];
	if (endpointUnlocks.some((endpoint, index) => (endpoint.status === 'complete') !== (unlocks[index] !== null))) return false;
	if (value.unlockCoverage !== aggregateCoverage(endpointUnlocks) || (value.unlockCoverage === 'complete' && unlocks.some((ids) => ids === null))
		|| (value.unlockCoverage === 'unavailable' && unlocks.some((ids) => ids !== null))) return false;
	if (value.completedAchievementBits !== null
		&& !achievementBits(value.completedAchievementBits as Record<string, number[]>)) return false;
	if (value.achievementProgress !== null && (!Array.isArray(value.achievementProgress)
		|| !value.achievementProgress.every(isAchievementProgress)
		|| !strictlySorted(value.achievementProgress, (left, right) => left.achievementId - right.achievementId))) return false;
	if (value.completedAchievementBits !== null && value.achievementProgress !== null) {
		const progress = value.achievementProgress;
		const expectedBits = Object.fromEntries(progress.filter((entry) => entry.bits !== null)
			.map((entry) => [String(entry.achievementId), entry.bits]));
		if (canonical(value.completedAchievementBits) !== canonical(expectedBits)) return false;
	}
	if ((value.endpointCoverage.achievements.status === 'complete') !== (value.completedAchievementBits !== null && value.achievementProgress !== null)
		|| value.achievementCoverage !== aggregateCoverage([value.endpointCoverage.achievements])
		|| (value.achievementCoverage === 'complete' && (value.completedAchievementBits === null || value.achievementProgress === null))
		|| (value.achievementCoverage === 'unavailable' && (value.completedAchievementBits !== null || value.achievementProgress !== null))) return false;
	return jsonRoundTrip(value);
}

function isInventoryAdvisorRulePackUnsafe(value: unknown): value is InventoryAdvisorRulePackV1 {
	if (!record(value) || !keys(value, [
		'schemaVersion', 'id', 'version', 'publishedAt', 'reviewedAt', 'validUntil',
		'sha256', 'sources', 'rules',
	]) || value.schemaVersion !== INVENTORY_RULE_PACK_VERSION || !identifier(value.id)
		|| !positive(value.version) || !iso(value.publishedAt) || !iso(value.reviewedAt)
		|| !iso(value.validUntil) || Date.parse(value.publishedAt) > Date.parse(value.reviewedAt)
		|| Date.parse(value.reviewedAt) >= Date.parse(value.validUntil) || !sha(value.sha256)
		|| !Array.isArray(value.sources) || !value.sources.every(isRuleSource)
		|| !unique(value.sources.map((source) => source.id))
		|| !strictlySorted(value.sources, (left, right) => left.id.localeCompare(right.id))
		|| !Array.isArray(value.rules) || !value.rules.every(isRule)
		|| !unique(value.rules.map((rule) => rule.ruleId))
		|| !strictlySorted(value.rules, ruleOrder)
		|| !value.rules.every((rule) => rule.sourceIds.every((sourceId) => (value.sources as InventoryRuleSourceV1[])
			.some((source) => source.id === sourceId)))) return false;
	return value.sha256 === sha256InventoryRulePack(value as unknown as InventoryAdvisorRulePackV1)
		&& jsonRoundTrip(value);
}

function isInventoryAdvisorRulePackV2Unsafe(value: unknown): value is InventoryAdvisorRulePackV2 {
	if (!record(value) || !keys(value, [
		'schemaVersion', 'id', 'version', 'publishedAt', 'reviewedAt', 'reviewStatus', 'validUntil',
		'knowledgePackSha256', 'sha256', 'sources', 'rules',
	]) || value.schemaVersion !== 2 || !identifier(value.id) || !positive(value.version)
		|| !iso(value.publishedAt) || !iso(value.validUntil) || Date.parse(value.publishedAt) >= Date.parse(value.validUntil)
		|| !sha(value.knowledgePackSha256) || !sha(value.sha256) || !Array.isArray(value.sources) || !value.sources.every(isRuleSource)
		|| !unique(value.sources.map((source) => source.id))
		|| !strictlySorted(value.sources, (left, right) => left.id.localeCompare(right.id))
		|| !Array.isArray(value.rules) || !value.rules.every(isRuleV2)
		|| !unique(value.rules.map((rule) => rule.ruleId)) || !strictlySorted(value.rules, ruleOrder)
		|| !value.rules.every((rule) => rule.sourceIds.every((sourceId) => (value.sources as InventoryRuleSourceV1[])
			.some((source) => source.id === sourceId)))) return false;
	if ((value.reviewStatus === 'pending_human_review' && value.reviewedAt !== null)
		|| (value.reviewStatus === 'human_reviewed' && (!iso(value.reviewedAt)
			|| Date.parse(value.publishedAt) > Date.parse(value.reviewedAt)
			|| Date.parse(value.reviewedAt) >= Date.parse(value.validUntil)))) return false;
	return (value.reviewStatus === 'pending_human_review' || value.reviewStatus === 'human_reviewed')
		&& value.sha256 === sha256InventoryRulePack(value as unknown as InventoryAdvisorRulePackV2)
		&& jsonRoundTrip(value);
}

function isInventoryAdvisorPolicyUnsafe(value: unknown): value is InventoryAdvisorPolicyV1 {
	return record(value) && keys(value, [
		'version', 'maxSnapshotAgeMs', 'maxPriceAgeMs', 'maxCatalogAgeMs', 'maxAccountSignalsAgeMs', 'maxRulePackAgeMs',
		'maxFutureSkewMs', 'listingMinimumAdvantageBps',
	]) && value.version === INVENTORY_ADVISOR_POLICY_VERSION
		&& bounded(value.maxSnapshotAgeMs, 60_000, 30 * 86_400_000)
		&& bounded(value.maxPriceAgeMs, 60_000, 86_400_000)
		&& bounded(value.maxCatalogAgeMs, 60_000, 30 * 86_400_000)
		&& bounded(value.maxAccountSignalsAgeMs, 60_000, 30 * 86_400_000)
		&& bounded(value.maxRulePackAgeMs, 86_400_000, 366 * 86_400_000)
		&& bounded(value.maxFutureSkewMs, 0, 15 * 60_000)
		&& bounded(value.listingMinimumAdvantageBps, 0, 10_000);
}

function isInventoryAdvisorReportUnsafe(value: unknown): value is InventoryAdvisorReportV1 {
	if (!record(value) || !keys(value, [
		'version', 'scope', 'accountId', 'snapshotId', 'asOf', 'coverage', 'lines',
		'reasons', 'explanations', 'rulePack',
	]) || value.version !== INVENTORY_ADVISOR_VERSION || value.scope !== INVENTORY_ADVISOR_SCOPE
		|| !text(value.accountId) || !text(value.snapshotId) || !iso(value.asOf)
		|| !['complete', 'limited', 'blocked'].includes(String(value.coverage))
		|| !Array.isArray(value.lines) || !value.lines.every(isLine)
		|| !strictlySorted(value.lines, (left, right) => left.itemId - right.itemId)
		|| !Array.isArray(value.reasons) || !value.reasons.every(isInventoryAdvisorReason)
		|| !strictlySorted(value.reasons, reasonOrder)
		|| !Array.isArray(value.explanations) || !value.explanations.every(isExplanation)
		|| !strictlySorted(value.explanations, (left, right) => left.ref.localeCompare(right.ref))
		|| !isInventoryAdvisorRulePackAny(value.rulePack)) return false;
	const allPositions = value.lines.flatMap((line) => line.positions.map((position) => position.ref));
	const allDecisions = value.lines.flatMap((line) => line.decisions);
	const allExplanationRefs = value.explanations.map((explanation) => explanation.ref);
	if (!unique(allPositions) || !unique(allExplanationRefs)
		|| allDecisions.length !== value.explanations.length) return false;
	const explanations = new Map(value.explanations.map((explanation) => [explanation.ref, explanation]));
	for (const decision of allDecisions) {
		const explanation = explanations.get(decision.explanationRef);
		if (!explanation || explanation.itemId !== decision.itemId || explanation.action !== decision.action
			|| explanation.ruleId !== decision.ruleId) return false;
		const rulePack = value.rulePack;
		if (decision.ruleId !== null && !rulePack.rules.some((rule) => isEnabledApplicableRule(rulePack, rule)
			&& rule.ruleId === decision.ruleId && rule.itemId === decision.itemId && rule.action === decision.action)) return false;
		if (decision.action === 'discard_candidate'
			&& decision.discardProof?.rulePackSha256 !== value.rulePack.sha256) return false;
	}
	for (const line of value.lines) {
		const lineExplanations = line.decisions.map((decision) => explanations.get(decision.explanationRef)!);
		if (lineExplanations.some((explanation) => explanation.reasonCodes.some((code) => !line.reasons.some((reason) => reason.code === code)))
			|| line.reasons.some((reason) => !lineExplanations.some((explanation) => explanation.reasonCodes.includes(reason.code)))) return false;
	}
	if (value.coverage === 'complete' && value.lines.some((line) => !coverageComplete(line.coverage))) return false;
	return jsonRoundTrip(value);
}

export function sha256InventoryAdvisorReport(report: InventoryAdvisorReportV1): string {
	return legacySha256(canonical(report));
}

/** Legacy V1 fingerprint retained for persisted evidence and recommendation envelopes. */
export function sha256CanonicalValue(value: unknown): string {
	return legacySha256(canonical(value));
}

/** Standard SHA-256 is reserved for V2 contracts introduced without legacy artifacts. */
export function sha256StandardCanonicalValue(value: unknown): string {
	return standardSha256CanonicalValue(value);
}

export function sha256InventoryRulePack(rulePack: InventoryAdvisorRulePack): string {
	const { sha256: _ignored, ...content } = rulePack;
	return rulePack.schemaVersion === 2 ? standardSha256CanonicalValue(content) : legacySha256(canonical(content));
}

function isLine(value: unknown): value is InventoryAdvisorLineV1 {
	if (!record(value) || !keys(value, [
		'itemId', 'name', 'ownedQuantity', 'availableQuantity', 'positions', 'coverage',
		'reservedQuantity', 'exceptionQuantity', 'retainedQuantity', 'actionedQuantity', 'unclassifiedQuantity',
		'decisions', 'reasons',
	]) || !positive(value.itemId) || !text(value.name) || !nonNegative(value.ownedQuantity)
		|| !nonNegative(value.availableQuantity) || value.availableQuantity > value.ownedQuantity
		|| !Array.isArray(value.positions) || !value.positions.every(isPosition)
		|| !strictlySorted(value.positions, (left, right) => left.holdingIndex - right.holdingIndex)
		|| !isCoverage(value.coverage) || !nonNegative(value.reservedQuantity)
		|| !nonNegative(value.exceptionQuantity) || !nonNegative(value.retainedQuantity) || !nonNegative(value.actionedQuantity)
		|| !nonNegative(value.unclassifiedQuantity) || !Array.isArray(value.decisions)
		|| !value.decisions.every(isDecision) || !strictlySorted(value.decisions, decisionOrder)
		|| !Array.isArray(value.reasons) || !value.reasons.every(isInventoryAdvisorReason)
		|| !strictlySorted(value.reasons, reasonOrder)) return false;
	if (value.positions.some((position) => position.itemId !== value.itemId)
		|| sum(value.positions.map((position) => position.quantity)) !== value.ownedQuantity
		|| sum([value.reservedQuantity, value.exceptionQuantity, value.retainedQuantity, value.actionedQuantity,
			value.unclassifiedQuantity]) !== value.ownedQuantity
		|| value.decisions.some((decision) => decision.itemId !== value.itemId)) return false;
	const positions = new Map(value.positions.map((position) => [position.ref, position]));
	const allocatedByPosition = new Map<string, number>();
	let kept = 0;
	let actioned = 0;
	let reviewed = 0;
	for (const decision of value.decisions) {
		const selected = decision.allocations.map((allocation) => positions.get(allocation.positionRef));
		if (selected.some((position) => position === undefined)
			|| sum(decision.allocations.map((allocation) => allocation.quantity)) !== decision.quantity) return false;
		for (const allocation of decision.allocations) {
			const position = positions.get(allocation.positionRef)!;
			const allocated = sum([allocatedByPosition.get(allocation.positionRef) ?? 0, allocation.quantity]);
			if (!Number.isSafeInteger(allocated) || allocated > position.quantity) return false;
			allocatedByPosition.set(allocation.positionRef, allocated);
		}
		if (decision.action === 'keep') kept += decision.quantity;
		else if (decision.action === 'review') reviewed += decision.quantity;
		else {
			actioned += decision.quantity;
			if (selected.some((position) => position!.state !== 'loose')) return false;
			if (!coverageComplete(value.coverage)) return false;
		}
	}
	return [...positions.values()].every((position) => allocatedByPosition.get(position.ref) === position.quantity)
		&& kept === value.reservedQuantity + value.exceptionQuantity + value.retainedQuantity
		&& actioned === value.actionedQuantity && reviewed === value.unclassifiedQuantity;
}

function isPosition(value: unknown): value is InventoryAdvisorPositionV1 {
	return record(value) && keys(value, ['ref', 'holdingIndex', 'itemId', 'quantity', 'source', 'state'])
		&& nonNegative(value.holdingIndex) && positive(value.itemId) && positive(value.quantity)
		&& value.ref === `#/positions/${value.itemId}/${value.holdingIndex}`
		&& ['character', 'shared_inventory', 'bank', 'materials', 'commerce_delivery'].includes(String(value.source))
		&& ['loose', 'equipped_container', 'embedded_upgrade', 'embedded_infusion', 'pending_claim']
			.includes(String(value.state));
}

function isCoverage(value: unknown): value is InventoryAdvisorCoverageV1 {
	return record(value) && keys(value, [
		'snapshot', 'inventory', 'catalog', 'prices', 'reservations', 'accountSignals', 'rules',
	]) && Object.values(value).every((entry) => ['complete', 'limited', 'unknown'].includes(String(entry)));
}

function coverageComplete(value: InventoryAdvisorCoverageV1): boolean {
	return Object.values(value).every((entry) => entry === 'complete');
}

function isDecision(value: unknown): value is InventoryRecommendationDecisionV1 {
	if (!record(value) || !keys(value, [
		'action', 'itemId', 'quantity', 'allocations', 'explanationRef', 'ruleId', 'safety', 'discardProof',
	]) || !ACTIONS.includes(value.action as InventoryRecommendationAction) || !positive(value.itemId)
		|| !positive(value.quantity) || !Array.isArray(value.allocations) || value.allocations.length === 0
		|| !value.allocations.every(isDecisionAllocation)
		|| !strictlySorted(value.allocations, (left, right) => left.positionRef.localeCompare(right.positionRef))
		|| !internalRef(value.explanationRef) || (value.ruleId !== null && !identifier(value.ruleId))) return false;
	const curated = ['salvage', 'use', 'open', 'discard_candidate'].includes(String(value.action));
	return curated === (value.ruleId !== null) && (value.action === 'discard_candidate'
		? value.safety === 'irreversible_review_only' && isDiscardProof(value.discardProof)
		: value.safety === 'manual_only' && value.discardProof === null);
}

function isDecisionAllocation(value: unknown): value is InventoryDecisionAllocationV1 {
	return record(value) && keys(value, ['positionRef', 'quantity'])
		&& internalRef(value.positionRef) && positive(value.quantity);
}

function isDiscardProof(value: unknown): value is InventoryDiscardProofV1 {
	return record(value) && keys(value, [
		'rulePackSha256', 'catalogSource', 'tradingPost', 'vendor', 'salvage', 'use', 'open',
		'unlocks', 'collections', 'deleteWarning',
	]) && sha(value.rulePackSha256) && ['network', 'cache_fresh'].includes(String(value.catalogSource))
		&& value.tradingPost === 'unavailable' && value.vendor === 'unavailable'
		&& value.salvage === 'no_salvage' && value.use === 'not_applicable'
		&& value.open === 'not_applicable' && value.unlocks === 'complete'
		&& value.collections === 'complete' && value.deleteWarning === false;
}

function isExplanation(value: unknown): value is InventoryAdvisorExplanationV1 {
	return record(value) && keys(value, [
		'ref', 'itemId', 'action', 'reasonCodes', 'evidenceRefs', 'ruleId',
	]) && internalRef(value.ref) && positive(value.itemId)
		&& ACTIONS.includes(value.action as InventoryRecommendationAction)
		&& Array.isArray(value.reasonCodes) && value.reasonCodes.every(reasonCode)
		&& sortedStrings(value.reasonCodes) && Array.isArray(value.evidenceRefs)
		&& value.evidenceRefs.every(internalRef) && sortedStrings(value.evidenceRefs)
		&& (value.ruleId === null || identifier(value.ruleId));
}

function isInventoryAdvisorReasonUnsafe(value: unknown): value is InventoryAdvisorReasonV1 {
	return record(value) && keys(value, ['code', 'itemId', 'goalId', 'ruleId'])
		&& reasonCode(value.code) && (value.itemId === null || positive(value.itemId))
		&& (value.goalId === null || identifier(value.goalId))
		&& (value.ruleId === null || identifier(value.ruleId));
}

function isItemPrice(value: unknown): value is InventoryItemPriceV1 {
	return record(value) && keys(value, ['itemId', 'whitelisted', 'bid', 'ask'])
		&& positive(value.itemId) && typeof value.whitelisted === 'boolean'
		&& (value.bid === null || isPriceSide(value.bid)) && (value.ask === null || isPriceSide(value.ask));
}

function isPriceSide(value: unknown): value is InventoryPriceSideV1 {
	return record(value) && keys(value, ['unitCopper', 'quantity'])
		&& positive(value.unitCopper) && positive(value.quantity);
}

function isRuleSource(value: unknown): value is InventoryRuleSourceV1 {
	return record(value) && keys(value, ['id', 'url', 'retrievedAt'])
		&& identifier(value.id) && httpsUrl(value.url) && iso(value.retrievedAt);
}

function isRule(value: unknown): value is InventoryAdvisorRuleV1 {
	if (!record(value) || !keys(value, ['ruleId', 'itemId', 'action', 'status', 'assertion', 'reason', 'sourceIds'])
		|| !identifier(value.ruleId) || !positive(value.itemId)
		|| !['salvage', 'use', 'open', 'discard_candidate'].includes(String(value.action))
		|| !['approved', 'revoked'].includes(String(value.status)) || !['applicable', 'not_applicable'].includes(String(value.assertion))
		|| !Array.isArray(value.sourceIds) || value.sourceIds.length === 0 || !value.sourceIds.every(identifier)
		|| !sortedStrings(value.sourceIds)) return false;
	const reasons: Record<InventoryAdvisorRuleV1['action'], InventoryAdvisorRuleV1['reason']> = {
		salvage: 'curated_salvage', use: 'curated_use', open: 'curated_open',
		discard_candidate: 'curated_discard_review',
	};
	return value.reason === reasons[value.action as InventoryAdvisorRuleV1['action']]
		&& (value.action !== 'discard_candidate' || value.assertion === 'applicable');
}

function isRuleV2(value: unknown): value is InventoryAdvisorRuleV2 {
	if (!record(value) || !keys(value, ['ruleId', 'itemId', 'action', 'status', 'capability', 'recommendation', 'reason', 'sourceIds'])
		|| !identifier(value.ruleId) || !positive(value.itemId)
		|| !['salvage', 'use', 'open', 'discard_candidate'].includes(String(value.action))
		|| !['approved', 'revoked'].includes(String(value.status)) || value.capability !== 'applicable'
		|| !isRecommendationGate(value.recommendation) || !Array.isArray(value.sourceIds)
		|| value.sourceIds.length === 0 || !value.sourceIds.every(identifier) || !sortedStrings(value.sourceIds)) return false;
	const reasons: Record<InventoryAdvisorRuleV2['action'], InventoryAdvisorRuleV2['reason']> = {
		salvage: 'curated_salvage', use: 'curated_use', open: 'curated_open',
		discard_candidate: 'curated_discard_review',
	};
	return value.reason === reasons[value.action as InventoryAdvisorRuleV2['action']]
		&& (value.action !== 'discard_candidate' || value.recommendation.status === 'enabled');
}

function isRecommendationGate(value: unknown): value is InventoryAdvisorRuleV2['recommendation'] {
	return record(value) && ((keys(value, ['status']) && value.status === 'enabled')
		|| (keys(value, ['status', 'reason']) && value.status === 'review_only'
			&& (value.reason === 'economic_comparison_missing' || value.reason === 'economic_activation_pending')));
}

export function isEnabledApplicableRule(
	pack: InventoryAdvisorRulePack,
	rule: InventoryAdvisorRuleV1 | InventoryAdvisorRuleV2,
): boolean {
	if (rule.status !== 'approved') return false;
	if (pack.schemaVersion === 1) return 'assertion' in rule && rule.assertion === 'applicable';
	return 'capability' in rule && rule.capability === 'applicable'
		&& pack.reviewStatus === 'human_reviewed' && pack.reviewedAt !== null
		&& rule.recommendation.status === 'enabled';
}

/** Capability is distinct from a human-authorized recommendation in V2. */
export function isApprovedApplicableCapability(
	pack: InventoryAdvisorRulePack,
	rule: InventoryAdvisorRuleV1 | InventoryAdvisorRuleV2,
): boolean {
	return rule.status === 'approved' && (pack.schemaVersion === 1
		? 'assertion' in rule && rule.assertion === 'applicable'
		: 'capability' in rule && rule.capability === 'applicable');
}

export function isCatalogResolution(value: unknown): value is CatalogResolution {
	if (!record(value) || !keys(value, [
		'snapshotId', 'locale', 'schemaVersion', 'resolvedAt', 'items', 'currencies', 'materials',
		'warnings', 'coverage',
	]) || !text(value.snapshotId) || !['es', 'en'].includes(String(value.locale))
		|| value.schemaVersion !== PINNED_SCHEMA || !iso(value.resolvedAt)
		|| !record(value.items) || !Object.values(value.items).every(isNormalizedCatalogItem)
		|| !record(value.currencies) || !Object.values(value.currencies).every(isNormalizedCatalogCurrency)
		|| !record(value.materials) || !Object.values(value.materials).every(isNormalizedCatalogMaterial)
		|| !catalogEntityKeys(value.items) || !catalogEntityKeys(value.currencies)
		|| !catalogEntityKeys(value.materials) || !Array.isArray(value.warnings)
		|| !value.warnings.every(isCatalogWarning)
		|| !strictlySorted(value.warnings as CatalogResolution['warnings'], catalogWarningOrder)
		|| !record(value.coverage)) return false;
	if (!keys(value.coverage, ['items', 'currencies', 'materials']) || !record(value.coverage.items)
		|| !record(value.coverage.currencies) || !record(value.coverage.materials)) return false;
	return [value.coverage.items, value.coverage.currencies, value.coverage.materials]
		.every((entries) => Object.values(entries).every(isCatalogCoverage))
		&& catalogCoverageEntities(value.items, value.coverage.items)
		&& catalogCoverageEntities(value.currencies, value.coverage.currencies)
		&& catalogCoverageEntities(value.materials, value.coverage.materials)
		&& jsonRoundTrip(value);
}

function catalogEntityKeys(values: Record<string, unknown>): boolean {
	return Object.entries(values).every(([key, entity]) => record(entity) && positive(entity.id)
		&& (key === String(entity.id) || key.endsWith(`:${entity.id}`)));
}

/** A resolved coverage entry proves exactly one entity at the same snapshot reference. */
function catalogCoverageEntities(entities: Record<string, unknown>, coverage: Record<string, unknown>): boolean {
	for (const [key, entry] of Object.entries(coverage)) {
		if (!record(entry)) return false;
		const entity = entities[key];
		if (entry.status === 'resolved') {
			const id = Number(key.slice(key.lastIndexOf(':') + 1));
			if (!record(entity) || !positive(id) || entity.id !== id) return false;
		} else if (entity !== undefined) return false;
	}
	return Object.keys(entities).every((key) => record(coverage[key]) && coverage[key].status === 'resolved');
}

function isCatalogCoverage(value: unknown): boolean {
	if (!record(value) || !['resolved', 'missing', 'invalid', 'malformed', 'unavailable']
		.includes(String(value.status)) || !['network', 'cache_fresh', 'cache_negative', 'cache_stale']
		.includes(String(value.source))) return false;
	const allowed = ['not_found', 'partial_response', 'missing_response', 'duplicate_conflict',
		'malformed_entry', 'request_failed'];
	return value.reason === undefined
		? keys(value, ['status', 'source'])
		: keys(value, ['status', 'source', 'reason']) && typeof value.reason === 'string'
			&& allowed.includes(value.reason);
}

function isCatalogWarning(value: unknown): boolean {
	return record(value) && keys(value, [
		'code', 'kind', ...(value.id === undefined ? [] : ['id']),
		...(value.relatedId === undefined ? [] : ['relatedId']),
	]) && ['unexpected_id', 'duplicate_identical', 'duplicate_conflict', 'malformed_entry',
		'missing_response', 'material_membership_mismatch'].includes(String(value.code))
		&& ['items', 'currencies', 'materials'].includes(String(value.kind))
		&& (value.id === undefined || positive(value.id))
		&& (value.relatedId === undefined || positive(value.relatedId));
}

function catalogWarningOrder(left: CatalogResolution['warnings'][number], right: CatalogResolution['warnings'][number]): number {
	return canonical([left.kind, left.id ?? 0, left.relatedId ?? 0, left.code]).localeCompare(
		canonical([right.kind, right.id ?? 0, right.relatedId ?? 0, right.code]),
	);
}

function achievementBits(value: Record<string, number[]>): boolean {
	return Object.entries(value).every(([key, ids]) => positive(Number(key)) && bitArray(ids));
}

function isAchievementProgress(value: unknown): value is InventoryAchievementProgressV1 {
	return record(value) && keys(value, ['achievementId', 'done', 'current', 'max', 'repeated', 'bits'])
		&& positive(value.achievementId) && typeof value.done === 'boolean'
		&& nullableNonNegative(value.current) && nullableNonNegative(value.max) && nullableNonNegative(value.repeated)
		&& (value.current === null || value.current === undefined || value.max === null || value.max === undefined || value.current <= value.max)
		&& (value.bits === null || bitArray(value.bits));
}

function endpointCoverage(value: unknown): value is AccountSignalsV1['endpointCoverage'] {
	return record(value) && keys(value, ['account', 'recipes', 'skins', 'minis', 'achievements'])
		&& Object.values(value).every(isEndpointEvidence);
}

function isEndpointEvidence(value: unknown): boolean {
	if (!record(value) || !keys(value, ['status', 'capturedAt', 'reason']) || !['complete', 'missing_scope', 'url_restricted', 'unavailable', 'invalid'].includes(String(value.status))) return false;
	if (value.status === 'complete') return iso(value.capturedAt) && value.reason === null;
	if (value.status === 'missing_scope') return value.capturedAt === null && value.reason === 'missing_scope';
	if (value.status === 'url_restricted') return value.capturedAt === null && value.reason === 'url_restricted';
	if (value.status === 'unavailable') return value.capturedAt === null && value.reason === 'request_failed';
	return value.status === 'invalid' && value.capturedAt === null && value.reason === 'invalid_payload';
}

function aggregateCoverage(entries: Array<AccountSignalsV1['endpointCoverage']['recipes']>): AccountSignalsV1['unlockCoverage'] {
	return entries.every((entry) => entry.status === 'complete') ? 'complete'
		: entries.every((entry) => entry.status !== 'complete') ? 'unavailable' : 'partial';
}

function coverageEvidence(value: unknown): value is AccountSignalsV1['unlockCoverage'] {
	return ['complete', 'partial', 'unavailable'].includes(String(value));
}
function nullableNonNegative(value: unknown): boolean { return value === null || nonNegative(value); }
function bitArray(value: unknown): value is number[] { return Array.isArray(value) && value.every(nonNegative) && value.every((entry, index) => index === 0 || value[index - 1]! < entry); }
function fresh(evidenceAt: string, asOf: string, maxAgeMs: number, maxFutureSkewMs: number): boolean {
	const evidence = Date.parse(evidenceAt);
	const now = Date.parse(asOf);
	return evidence <= now + maxFutureSkewMs && now - evidence <= maxAgeMs;
}

function reasonCode(value: unknown): value is InventoryAdvisorReasonCode {
	return REASONS.includes(value as InventoryAdvisorReasonCode);
}

function keepExceptionOrder(left: KeepExceptionV1, right: KeepExceptionV1): number {
	return left.itemId - right.itemId || left.exceptionId.localeCompare(right.exceptionId);
}

function ruleOrder(left: Pick<InventoryAdvisorRuleV1, 'itemId' | 'action' | 'ruleId'>, right: Pick<InventoryAdvisorRuleV1, 'itemId' | 'action' | 'ruleId'>): number {
	return left.itemId - right.itemId || left.action.localeCompare(right.action)
		|| left.ruleId.localeCompare(right.ruleId);
}

function reasonOrder(left: InventoryAdvisorReasonV1, right: InventoryAdvisorReasonV1): number {
	return (left.itemId ?? -1) - (right.itemId ?? -1) || left.code.localeCompare(right.code)
		|| (left.goalId ?? '').localeCompare(right.goalId ?? '')
		|| (left.ruleId ?? '').localeCompare(right.ruleId ?? '');
}

function decisionOrder(left: InventoryRecommendationDecisionV1, right: InventoryRecommendationDecisionV1): number {
	return left.action.localeCompare(right.action) || left.explanationRef.localeCompare(right.explanationRef);
}

function sum(values: number[]): number {
	let total = 0;
	for (const value of values) {
		if (!nonNegative(value) || total > Number.MAX_SAFE_INTEGER - value) return Number.NaN;
		total += value;
	}
	return total;
}

function numberOrder(left: number, right: number): number { return left - right; }
function sameNumbers(left: number[], right: number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
function idArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(positive)
		&& value.every((entry, index) => index === 0 || value[index - 1]! < entry);
}
function sortedStrings(value: string[]): boolean {
	return value.every((entry, index) => index === 0 || value[index - 1]! < entry);
}
function strictlySorted<T>(value: T[], compare: (left: T, right: T) => number): boolean {
	return value.every((entry, index) => index === 0 || compare(value[index - 1]!, entry) < 0);
}
function unique(values: string[]): boolean { return new Set(values).size === values.length; }
function bounded(value: unknown, minimum: number, maximum: number): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function identifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
function text(value: unknown): value is string {
	return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256;
}
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function iso(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function httpsUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 512) return false;
	try { return new URL(value).protocol === 'https:'; } catch { return false; }
}
function internalRef(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 256 && /^#(?:\/[A-Za-z0-9._~-]+)+$/u.test(value);
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
function jsonRoundTrip(value: unknown): boolean {
	try { return canonical(JSON.parse(JSON.stringify(value))) === canonical(value); } catch { return false; }
}
function safeGuard(check: () => boolean): boolean {
	try { return check(); } catch { return false; }
}
function canonical(value: unknown): string {
	return canonicalJson(value);
}

/**
 * Historical V1 digest retained byte-for-byte for existing local reports and
 * envelopes. It is intentionally not a general SHA-256 API; new V2 payloads
 * use sha256StandardCanonicalValue above.
 */
function legacySha256(message: string): string {
	const words: number[] = [];
	const encoded = new TextEncoder().encode(message);
	const bitLength = encoded.length * 8;
	for (let index = 0; index < encoded.length; index += 1) {
		words[index >> 2] = (words[index >> 2] ?? 0) | encoded[index]! << (24 - (index % 4) * 8);
	}
	words[encoded.length >> 2] = (words[encoded.length >> 2] ?? 0) | 0x80 << (24 - (encoded.length % 4) * 8);
	words[((encoded.length + 8 >> 6) + 1) * 16 - 1] = bitLength;
	const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
		0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const constants: number[] = [];
	let candidate = 2;
	while (constants.length < 64) {
		let prime = true;
		for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) {
			if (candidate % divisor === 0) { prime = false; break; }
		}
		if (prime) constants.push((Math.pow(candidate, 1 / 3) * 0x100000000) | 0);
		candidate += 1;
	}
	for (let offset = 0; offset < words.length; offset += 16) {
		const schedule = words.slice(offset, offset + 16);
		for (let index = 16; index < 64; index += 1) {
			const first = schedule[index - 15]!; const second = schedule[index - 2]!;
			schedule[index] = (schedule[index - 16]! + (rotate(first, 7) ^ rotate(first, 18) ^ first >>> 3)
				+ schedule[index - 7]! + (rotate(second, 17) ^ rotate(second, 19) ^ second >>> 10)) | 0;
		}
		let [a, b, c, d, e, f, g, h] = hash;
		for (let index = 0; index < 64; index += 1) {
			const temporary1 = (h! + (rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25))
				+ (e! & f! ^ ~e! & g!) + constants[index]! + schedule[index]!) | 0;
			const temporary2 = ((rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22)) + (a! & b! ^ a! & c! ^ b! & c!)) | 0;
			h = g; g = f; f = e; e = (d! + temporary1) | 0; d = c; c = b; b = a; a = (temporary1 + temporary2) | 0;
		}
		const next = [a!, b!, c!, d!, e!, f!, g!, h!];
		for (let index = 0; index < 8; index += 1) hash[index] = (hash[index]! + next[index]!) | 0;
	}
	return hash.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}
function rotate(value: number, count: number): number { return value >>> count | value << (32 - count); }
