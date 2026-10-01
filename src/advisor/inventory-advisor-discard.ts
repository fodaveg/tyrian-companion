import { canonicalJson as canonical } from '../core/canonical-sha256';
import { jsonRoundTrip as json } from '../core/json-round-trip';
import { classifyItemLiquidity } from '../economy/item-liquidity';
import { createInventoryRecommendationEnvelope, isInventoryRecommendationEnvelope } from '../economy/inventory-recommendation-envelope';
import { isApprovedApplicableCapability, isEnabledApplicableRule, isInventoryAdvisorReport, sha256CanonicalValue, sha256InventoryAdvisorReport } from './inventory-advisor-contract';
import { classifyInventoryAdvisorDiagnosed, isInventoryKnowledgePack } from './inventory-advisor-classifier';
import {
	createInventoryAdvisorAnalysisContext,
	isInventoryAdvisorResultForAnalysis,
	type InventoryAdvisorAnalysisContext,
} from './inventory-advisor-result';
import { isInventoryContainerEconomyPack, isInventoryContainerPriceEvidence } from './inventory-container-economy';
import type { InventoryAdvisorLineV1, InventoryAdvisorReportV1, InventoryRecommendationDecisionV1 } from './inventory-advisor-model';
import type { InventoryAdvisorEngineInputV1, InventoryRouteClaimV1 } from './inventory-advisor-classifier-model';
import { isContainerPersonalValuation, resolveContainerPersonalValuation } from '../economy/container-personal-valuation';
import { isInventoryMarketDepthEvidence } from '../economy/commerce-listings';
import {
	INVENTORY_DISCARD_ALLOWLIST_VERSION,
	type InventoryDiscardAllowlistInputV1,
	type InventoryDiscardAllowlistProofV1,
	type InventoryDiscardAllowlistResultV1,
} from './inventory-advisor-discard-model';

/**
 * Applies a strictly review-only discard allowlist to a canonically reproduced H4.15 result.
 * It is deliberately a sibling result: no inventory capture, network access, persistence, or execution occurs here.
 */
export function applyInventoryDiscardAllowlist(value: unknown): InventoryDiscardAllowlistResultV1 {
	return applyInventoryDiscardAllowlistDiagnosed(value).result;
}

/**
 * The same allowlist plus, when it comes out `invalid`, a stable snake_case code for the exit taken
 * (a closed list, never a value of the account). It changes neither what is invalid nor the result.
 *
 * The reproduction of the producer and the two contract checks below all work on the same input
 * object, so they share one analysis context: `shared` when the caller already holds the context
 * of that very object, a new one otherwise.
 */
function applyInventoryDiscardAllowlistDiagnosed(
	value: unknown,
	shared?: InventoryAdvisorAnalysisContext,
): { result: InventoryDiscardAllowlistResultV1; cause: string | null } {
	const failed = (cause: string): { result: InventoryDiscardAllowlistResultV1; cause: string } => ({ result: invalid(), cause });
	try {
		if (!isInput(value)) return failed('discard_input_shape');
		// A pair this module classified itself (see `classifyInventoryAdvisorVerified`) is not reproduced:
		// the producer result in it is the classifier's own answer to the frozen engine input beside it,
		// already checked against the result contract with this same context.
		const classified = CLASSIFIED_ANALYSES.get(value);
		const analysis = classified ?? (shared !== undefined && shared.input === value.engineInput.input
			? shared : createInventoryAdvisorAnalysisContext(value.engineInput.input));
		if (classified === undefined) {
			const reproduced = classifyInventoryAdvisorDiagnosed(value.engineInput, analysis).result;
			if (!isInventoryAdvisorResultForAnalysis(value.producerResult, analysis, value.engineInput.knowledgePack,
				value.engineInput.containerEconomy, value.engineInput.personalValuation, value.engineInput.activeOrders,
				value.engineInput.materialStorageCapacity, value.engineInput.marketDepth, value.engineInput.equipmentSalvage)) {
				return failed('discard_producer_contract_invalid');
			}
			if (canonical(reproduced) !== canonical(value.producerResult)) return failed('discard_producer_not_reproduced');
		}
		if (value.producerResult.status === 'invalid' || value.producerResult.report === null || value.producerResult.envelope === null) {
			return failed('discard_producer_invalid');
		}
		const producerResultSha256 = sha256CanonicalValue(value.producerResult);
		const report = clone(value.producerResult.report);
		const proofs: InventoryDiscardAllowlistProofV1[] = [];
		if (value.producerResult.status === 'ready') {
			for (const line of report.lines) {
				if (!lineEligible(value.engineInput, line)) continue;
				line.decisions = line.decisions.map((decision) => {
					const proof = allowlistProof(value.engineInput, line, decision, producerResultSha256);
					if (proof === null) return decision;
					proofs.push(proof);
					line.retainedQuantity -= decision.quantity;
					line.actionedQuantity += decision.quantity;
					return {
						...decision,
						action: 'discard_candidate' as const,
						ruleId: proof.discardRuleId,
						safety: 'irreversible_review_only' as const,
						discardProof: {
							rulePackSha256: value.engineInput.input.rulePack.sha256,
							catalogSource: value.engineInput.input.catalog.coverage.items[String(line.itemId)]!.source as 'network' | 'cache_fresh',
							tradingPost: 'unavailable' as const, vendor: 'unavailable' as const,
							salvage: 'no_salvage' as const, use: 'not_applicable' as const, open: 'not_applicable' as const,
							unlocks: 'complete' as const, collections: 'complete' as const, deleteWarning: false as const,
						},
					};
				});
			}
			for (const explanation of report.explanations) {
				const proof = proofs.find((entry) => entry.explanationRef === explanation.ref);
				if (proof) {
					explanation.action = 'discard_candidate';
					explanation.ruleId = proof.discardRuleId;
					explanation.reasonCodes = ['discard_not_allowlisted'];
					explanation.evidenceRefs = ['#/evidence/discard-allowlist'];
				}
			}
			for (const line of report.lines) {
				if (line.decisions.some((decision) => decision.action === 'discard_candidate')) {
					line.reasons = line.reasons.filter((reason) => reason.code !== 'no_sell');
					line.reasons.push({ code: 'discard_not_allowlisted', itemId: line.itemId, goalId: null,
						ruleId: line.decisions.find((decision) => decision.action === 'discard_candidate')!.ruleId });
					line.reasons.sort(reasonOrder);
				}
			}
			report.reasons = uniqueReasons(report.lines.flatMap((line) => line.reasons)).sort(reasonOrder);
		}
		const envelope = createInventoryRecommendationEnvelope(report);
		if (envelope === null) return failed('discard_envelope_invalid');
		const result: InventoryDiscardAllowlistResultV1 = {
			version: INVENTORY_DISCARD_ALLOWLIST_VERSION, status: value.producerResult.status,
			producerResultSha256, report, envelope, proofs: proofs.sort((left, right) => left.itemId - right.itemId || left.explanationRef.localeCompare(right.explanationRef)),
		};
		const publicResult = { status: result.status, report: result.report, envelope: result.envelope };
		return isInventoryAdvisorResultForAnalysis(publicResult, analysis, value.engineInput.knowledgePack,
			value.engineInput.containerEconomy, value.engineInput.personalValuation, value.engineInput.activeOrders,
			value.engineInput.materialStorageCapacity, value.engineInput.marketDepth, value.engineInput.equipmentSalvage)
			&& isInventoryDiscardAllowlistResultShape(result) ? { result, cause: null } : failed('discard_result_contract_invalid');
	} catch { return failed('discard_threw'); }
}

/**
 * One analysis this module's own flow produced, and so does not reproduce to believe: the engine
 * input, the producer result, the discard result and, through its analysis context, the reservation
 * plan and the position index.
 *
 * What proves it is the identity of the object in the two registries below and nothing else: not a
 * field, not a type, not a hash a caller can recompute. Nothing exported records an object it was
 * given. `classifyInventoryAdvisorVerified` records the pair it builds from its OWN copy of the
 * engine input, frozen in depth before the classifier reads it, with the result the classifier
 * returned for that copy; `applyInventoryDiscardAllowlistVerified` records the source it builds from
 * such a pair. Both are frozen in depth, so what was recorded cannot be altered afterwards, and the
 * caller's own objects are never frozen nor read again: changing them later changes nothing here.
 * An object that merely looks like one of these (a copy, a clone, a proxy) is in neither registry
 * and goes through the public route, which reproduces everything as before.
 */
export interface InventoryAdvisorVerifiedAnalysis {
	readonly input: InventoryAdvisorEngineInputV1['input'];
	readonly result: InventoryDiscardAllowlistResultV1;
	readonly discardContext: InventoryDiscardAllowlistInputV1;
}

/** Pairs `{ engineInput, producerResult }` classified here, with the context of their frozen input. */
const CLASSIFIED_ANALYSES = new WeakMap<object, InventoryAdvisorAnalysisContext>();
/** Sources `{ input, result, discardContext }` completed here from one of those pairs. */
const VERIFIED_ANALYSES = new WeakMap<object, InventoryAdvisorAnalysisContext>();

/**
 * First stage of the internal flow: classifies a private frozen copy of `value` once and returns the
 * pair the discard stage consumes without classifying again. The answer is the one
 * `classifyInventoryAdvisor` gives for the same value. A value that is not a plain data tree is not
 * copied: it gets the public classification and a pair that is not recorded.
 */
export function classifyInventoryAdvisorVerified(value: InventoryAdvisorEngineInputV1): InventoryDiscardAllowlistInputV1 {
	const engineInput = frozenCopy(value);
	// Nothing to copy either in a value that is no object at all (`null` copies to `null`): the public answer, not recorded.
	if (typeof engineInput !== 'object' || engineInput === null) {
		return { engineInput: value, producerResult: classifyInventoryAdvisorDiagnosed(value).result };
	}
	const analysis = createInventoryAdvisorAnalysisContext(engineInput.input);
	// Its own copy as well: whatever the classifier put in its result, nothing outside this pair is frozen with it.
	const producerResult = freezeDeep(structuredClone(classifyInventoryAdvisorDiagnosed(engineInput, analysis).result));
	const classified = Object.freeze({ engineInput, producerResult });
	// An invalid classification is not recorded: every later stage then names its cause as the public route does.
	if (producerResult.status !== 'invalid') CLASSIFIED_ANALYSES.set(classified, analysis);
	return classified;
}

/**
 * Second stage of the internal flow: applies the allowlist to a pair `classifyInventoryAdvisorVerified`
 * returned and gives back the complete source a presentation consumes without reproducing it. The
 * result is the one `applyInventoryDiscardAllowlist` gives for the same pair. Any other value gets
 * exactly that public allowlist, reproduction included, and a source that is not recorded.
 */
export function applyInventoryDiscardAllowlistVerified(classified: InventoryDiscardAllowlistInputV1): InventoryAdvisorVerifiedAnalysis {
	const analysis = CLASSIFIED_ANALYSES.get(classified);
	const outcome = applyInventoryDiscardAllowlistDiagnosed(classified);
	if (analysis === undefined || outcome.result.status === 'invalid') {
		return { input: engineInputInput(classified), result: outcome.result, discardContext: classified };
	}
	const source = Object.freeze({
		input: classified.engineInput.input, result: freezeDeep(structuredClone(outcome.result)), discardContext: classified,
	});
	VERIFIED_ANALYSES.set(source, analysis);
	return source;
}

/**
 * `classified.engineInput.input` for a value the second stage does not record, which may be anything
 * a caller passed: a value with no engine input to read it from (not an object, or without one) has
 * none, and the source built from it says so instead of throwing where the public allowlist answers.
 */
function engineInputInput(classified: unknown): InventoryAdvisorEngineInputV1['input'] {
	const engineInput: unknown = typeof classified === 'object' && classified !== null
		? (classified as { engineInput?: unknown }).engineInput : undefined;
	return (typeof engineInput === 'object' && engineInput !== null
		? (engineInput as { input?: unknown }).input : undefined) as InventoryAdvisorEngineInputV1['input'];
}

/**
 * The analysis context of `source` when `source` is the very object this module's flow completed,
 * undefined for anything else. The context is frozen and reads the recorded copy of the input, so
 * handing it out gives nothing to alter.
 */
export function inventoryAdvisorVerifiedAnalysisContext(source: unknown): InventoryAdvisorAnalysisContext | undefined {
	return typeof source === 'object' && source !== null ? VERIFIED_ANALYSES.get(source) : undefined;
}

/**
 * A private copy of `value`, frozen in depth, or undefined when `value` is not a tree of plain data
 * (primitives, arrays and plain objects with enumerable data properties only). Only such a tree is
 * copied faithfully: a class instance would lose its prototype, a getter would become a value and a
 * non-enumerable property would be gone, and the copy could then pass a contract the original does
 * not, or the other way round.
 */
function frozenCopy<T>(value: T): T | undefined {
	try { return plainTree(value, new Set()) ? freezeDeep(structuredClone(value)) : undefined; } catch { return undefined; }
}

function plainTree(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number'
		|| typeof value === 'boolean') return true;
	if (typeof value !== 'object' || ancestors.has(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
	if (Object.getOwnPropertySymbols(value).length !== 0) return false;
	ancestors.add(value);
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		// The length of an array is its own and never enumerable; a structured clone rebuilds it.
		if (key === 'length' && Array.isArray(value)) continue;
		// A property that is not enumerable is read by whoever asks for it and left behind by a
		// structured clone: the copy would not be the input the public route classifies.
		if (!('value' in descriptor) || descriptor.enumerable !== true || !plainTree(descriptor.value, ancestors)) return false;
	}
	ancestors.delete(value);
	return true;
}

function freezeDeep<T>(value: T): T {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
	return value;
}

/**
 * Why a contextual advisor source (the producer's engine input and result plus the discard sibling
 * result) fails to be shown, as one stable snake_case code; null when nothing in it is wrong. The
 * presentation calls it only on an already-invalid path, so its extra reproduction costs nothing on
 * the normal one.
 */
export function inventoryAdvisorContextualInvalidCause(
	context: unknown,
	result: unknown,
): string | null {
	try {
		if (!isInput(context)) return 'discard_input_shape';
		if (!record(result) || result.version !== INVENTORY_DISCARD_ALLOWLIST_VERSION) return 'discard_result_version';
		const expected = applyInventoryDiscardAllowlistDiagnosed(context);
		if (expected.cause === 'discard_producer_invalid') {
			return classifyInventoryAdvisorDiagnosed(context.engineInput).cause ?? 'classifier_invalid_not_reproduced';
		}
		if (expected.cause !== null) return expected.cause;
		return canonical(result) === canonical(expected.result) ? null : 'discard_result_differs';
	} catch { return 'discard_diagnosis_threw'; }
}

/**
 * Validates the persisted sibling result against the exact reproduced producer result.
 * `shared` only spares deriving the plan and the position index again when the caller already
 * holds the analysis context of `input.engineInput.input`; the reproduction itself is complete.
 */
export function isInventoryDiscardAllowlistResultForInput(
	value: unknown,
	input: unknown,
	shared?: InventoryAdvisorAnalysisContext,
): value is InventoryDiscardAllowlistResultV1 {
	try {
		if (!isInput(input) || !record(value) || value.version !== INVENTORY_DISCARD_ALLOWLIST_VERSION) return false;
		const expected = applyInventoryDiscardAllowlistDiagnosed(input, shared).result;
		return canonical(value) === canonical(expected);
	} catch { return false; }
}

/** Structural precondition only; contextual authorization is intentionally exported solely above. */
function isInventoryDiscardAllowlistResultShape(value: unknown): value is InventoryDiscardAllowlistResultV1 {
	try {
		if (!record(value) || value.version !== INVENTORY_DISCARD_ALLOWLIST_VERSION) return false;
		if (value.status === 'invalid') return keys(value, ['version', 'status', 'producerResultSha256', 'report', 'envelope', 'proofs'])
			&& value.producerResultSha256 === null && value.report === null && value.envelope === null
			&& Array.isArray(value.proofs) && value.proofs.length === 0;
		if (!keys(value, ['version', 'status', 'producerResultSha256', 'report', 'envelope', 'proofs'])
			|| !['ready', 'limited', 'blocked'].includes(String(value.status)) || !sha(value.producerResultSha256)
			|| !report(value.report) || !isInventoryRecommendationEnvelope(value.envelope)
			|| !Array.isArray(value.proofs) || !value.proofs.every(isProof) || !sortedProofs(value.proofs)
			|| value.envelope.reportSha256 !== sha256InventoryAdvisorReport(value.report)
			|| value.envelope.execution !== 'manual_in_game' || value.envelope.sideEffects !== 'none'
			|| value.envelope.requiresUserAction !== true || !json(value)) return false;
		const reportValue = value.report;
		const envelope = value.envelope;
		const proofs = value.proofs;
		const discard = reportValue.lines.flatMap((line) => line.decisions.filter((decision) => decision.action === 'discard_candidate'));
		const explanations = new Map(reportValue.explanations.map((entry) => [entry.ref, entry]));
		return proofs.every((proof) => new Set([proof.assertionIds.use, proof.assertionIds.open, proof.assertionIds.salvage]).size === 3)
			&& discard.length === value.proofs.length
			&& new Set(proofs.map((proof) => proof.explanationRef)).size === proofs.length
			&& envelope.accountId === reportValue.accountId && envelope.snapshotId === reportValue.snapshotId
			&& canonical(envelope.rulePack) === canonical({ id: reportValue.rulePack.id, version: reportValue.rulePack.version, sha256: reportValue.rulePack.sha256 })
			&& canonical(envelope.decisions) === canonical(reportValue.lines.flatMap((line) => line.decisions))
			&& discard.every((decision) => {
				const proof = proofs.find((entry) => entry.explanationRef === decision.explanationRef);
				const explanation = explanations.get(decision.explanationRef);
				const rule = reportValue.rulePack.rules.find((entry) => entry.ruleId === decision.ruleId);
				return proof !== undefined && proof.itemId === decision.itemId && proof.discardRuleId === decision.ruleId
					&& proof.producerResultSha256 === value.producerResultSha256 && explanation?.action === 'discard_candidate'
					&& explanation.ruleId === decision.ruleId && rule !== undefined
					&& canonical(proof.discardRuleSourceIds) === canonical(rule.sourceIds);
			});
	} catch { return false; }
}

function isInput(value: unknown): value is InventoryDiscardAllowlistInputV1 {
	if (!record(value) || !keys(value, ['engineInput', 'producerResult']) || !record(value.engineInput)
		|| !isInventoryKnowledgePack(value.engineInput.knowledgePack)) return false;
	const actual = Object.keys(value.engineInput);
	if (!['input', 'knowledgePack'].every((key) => actual.includes(key))
		|| !actual.every((key) => [
			'activeOrders', 'containerEconomy', 'equipmentSalvage', 'input', 'knowledgePack', 'marketDepth',
			'materialStorageCapacity', 'personalValuation',
		].includes(key))) return false;
	if (value.engineInput.containerEconomy === undefined) return value.engineInput.personalValuation === undefined;
	return record(value.engineInput.containerEconomy)
		&& keys(value.engineInput.containerEconomy, ['pack', 'prices', 'marketDepth'])
		&& isInventoryContainerEconomyPack(value.engineInput.containerEconomy.pack)
		&& isInventoryContainerPriceEvidence(value.engineInput.containerEconomy.prices)
		&& (value.engineInput.containerEconomy.marketDepth === null
			|| isInventoryMarketDepthEvidence(value.engineInput.containerEconomy.marketDepth))
		&& (value.engineInput.personalValuation === undefined
			|| (isContainerPersonalValuation(value.engineInput.personalValuation)
				&& resolveContainerPersonalValuation(
					value.engineInput.containerEconomy.pack.model, value.engineInput.personalValuation,
				).status === 'ok'));
}

function allowlistProof(engineInput: InventoryDiscardAllowlistInputV1['engineInput'], line: InventoryAdvisorLineV1, decision: InventoryRecommendationDecisionV1, producerResultSha256: string): InventoryDiscardAllowlistProofV1 | null {
	const { input, knowledgePack } = engineInput;
	if (decision.action !== 'keep' || decision.ruleId !== null) return null;
	const item = input.catalog.items[String(line.itemId)];
	const coverage = input.catalog.coverage.items[String(line.itemId)];
	const price = input.prices.items.find((entry) => entry.itemId === line.itemId);
	if (!item || !coverage || coverage.status !== 'resolved' || !['network', 'cache_fresh'].includes(coverage.source)
		|| !item.flags.includes('NoSell') || !item.flags.includes('NoSalvage') || item.flags.includes('DeleteWarning')
		|| input.prices.status !== 'complete' || !price || price.bid !== null || price.ask !== null
		|| !completeSignals(input) || !freshEvidence(input)
		|| decision.allocations.some((allocation) => line.positions.find((position) => position.ref === allocation.positionRef)?.state !== 'loose')) return null;
	const holdings = decision.allocations.map((allocation) => input.snapshot.holdings[allocationIndex(allocation.positionRef)]);
	if (holdings.some((holding) => holding?.kind !== 'item')) return null;
	const liquidity = holdings.map((holding) => classifyItemLiquidity(holding, item, 'available'));
	if (liquidity.some((entry) => entry.status !== 'ok' || entry.classification.binding.kind === 'unknown'
		|| entry.classification.vendor.status !== 'excluded')) return null;
	const tradingPostUnavailable = liquidity.every((entry) => entry.status === 'ok' && (
		(entry.classification.tradingPost.status === 'excluded' && ['account_bound', 'character_bound'].includes(entry.classification.tradingPost.reason))
		|| (entry.classification.tradingPost.status === 'eligible' && input.accountSignals.tradingPostAccess === 'free_to_play' && price.whitelisted === false)
	));
	if (!tradingPostUnavailable) return null;
	const knowledge = knowledgePack.entries.find((entry) => entry.itemId === line.itemId);
	if (!knowledge) return null;
	const use = knowledge.use; const open = knowledge.open; const salvage = knowledge.salvage;
	if (!isExplicitNotApplicable(use) || !isExplicitNotApplicable(open) || !isExplicitNotApplicable(salvage)
		|| input.rulePack.rules.some((rule) => rule.itemId === line.itemId && isApprovedApplicableCapability(input.rulePack, rule)
			&& ['use', 'open', 'salvage'].includes(rule.action))) return null;
	const discardRules = input.rulePack.rules.filter((rule) => rule.itemId === line.itemId && rule.action === 'discard_candidate'
		&& isEnabledApplicableRule(input.rulePack, rule) && rule.reason === 'curated_discard_review');
	if (discardRules.length !== 1) return null;
	const discard = discardRules[0]!;
	return {
		itemId: line.itemId, explanationRef: decision.explanationRef, producerResultSha256,
		discardRuleId: discard.ruleId, discardRuleSourceIds: [...discard.sourceIds],
		assertionIds: { use: use.assertionId, open: open.assertionId, salvage: salvage.assertionId },
		assertionSourceIds: { use: [...use.sourceIds], open: [...open.sourceIds], salvage: [...salvage.sourceIds] },
	};
}

function isExplicitNotApplicable(value: InventoryRouteClaimV1 | null): value is Extract<InventoryRouteClaimV1, { status: 'not_applicable' }> {
	return value !== null && value.status === 'not_applicable' && identifier(value.assertionId)
		&& sortedNonEmpty(value.sourceIds);
}

function completeSignals(input: InventoryDiscardAllowlistInputV1['engineInput']['input']): boolean {
	const signals = input.accountSignals;
	return signals.unlockCoverage === 'complete' && signals.achievementCoverage === 'complete'
		&& signals.unlockedRecipes !== null && signals.unlockedSkins !== null && signals.unlockedMinis !== null
		&& signals.achievementProgress !== null && signals.completedAchievementBits !== null
		&& Object.values(signals.endpointCoverage).every((entry) => entry.status === 'complete'
			&& entry.capturedAt !== null && fresh(entry.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs));
}

function freshEvidence(input: InventoryDiscardAllowlistInputV1['engineInput']['input']): boolean {
	return fresh(input.snapshot.completedAt, input.asOf, input.policy.maxSnapshotAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.catalog.resolvedAt, input.asOf, input.policy.maxCatalogAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.prices.capturedAt, input.asOf, input.policy.maxPriceAgeMs, input.policy.maxFutureSkewMs)
		&& fresh(input.accountSignals.capturedAt, input.asOf, input.policy.maxAccountSignalsAgeMs, input.policy.maxFutureSkewMs)
		&& rulePackFresh(input)
		&& input.rulePack.sources.every((source) => fresh(source.retrievedAt, input.asOf, input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs)
			&& input.rulePack.reviewedAt !== null && Date.parse(source.retrievedAt) <= Date.parse(input.rulePack.reviewedAt));
}

function rulePackFresh(input: InventoryDiscardAllowlistInputV1['engineInput']['input']): boolean {
	const pack = input.rulePack;
	return (pack.schemaVersion === 1 || (pack.reviewStatus === 'human_reviewed' && pack.reviewedAt !== null))
		&& pack.reviewedAt !== null && fresh(pack.reviewedAt, input.asOf, input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs)
		&& (pack.schemaVersion === 2 ? Date.parse(input.asOf) < Date.parse(pack.validUntil)
			: Date.parse(input.asOf) <= Date.parse(pack.validUntil) + input.policy.maxFutureSkewMs);
}

function lineEligible(engineInput: InventoryDiscardAllowlistInputV1['engineInput'], line: InventoryAdvisorLineV1): boolean {
	const { input, knowledgePack } = engineInput;
	if (line.reservedQuantity !== 0 || line.exceptionQuantity !== 0 || !line.reasons.some((reason) => reason.code === 'no_sell')
		|| !line.decisions.every((decision) => decision.action === 'keep' && decision.ruleId === null)
		|| line.decisions.reduce((sum, decision) => sum + decision.quantity, 0) !== line.retainedQuantity) return false;
	const knowledge = knowledgePack.entries.find((entry) => entry.itemId === line.itemId);
	if (!knowledge || !isExplicitNotApplicable(knowledge.use) || !isExplicitNotApplicable(knowledge.open) || !isExplicitNotApplicable(knowledge.salvage)) return false;
	const assertionIds = [knowledge.use.assertionId, knowledge.open.assertionId, knowledge.salvage.assertionId];
	return new Set(assertionIds).size === assertionIds.length
		&& knowledgePack.sources.every((source) => fresh(source.retrievedAt, input.asOf, input.policy.maxRulePackAgeMs, input.policy.maxFutureSkewMs)
			&& Date.parse(source.retrievedAt) <= Date.parse(knowledgePack.reviewedAt));
}

function fresh(value: string, asOf: string, maximumAgeMs: number, skewMs: number): boolean {
	const capturedAt = Date.parse(value); const current = Date.parse(asOf);
	return Number.isFinite(capturedAt) && Number.isFinite(current) && capturedAt <= current + skewMs && current - capturedAt <= maximumAgeMs;
}
function allocationIndex(ref: string): number { const index = Number(ref.slice(ref.lastIndexOf('/') + 1)); return Number.isSafeInteger(index) && index >= 0 ? index : -1; }
function invalid(): InventoryDiscardAllowlistResultV1 { return { version: INVENTORY_DISCARD_ALLOWLIST_VERSION, status: 'invalid', producerResultSha256: null, report: null, envelope: null, proofs: [] }; }
function isProof(value: unknown): value is InventoryDiscardAllowlistProofV1 { return record(value) && keys(value, ['itemId', 'explanationRef', 'producerResultSha256', 'discardRuleId', 'discardRuleSourceIds', 'assertionIds', 'assertionSourceIds']) && positive(value.itemId) && ref(value.explanationRef) && sha(value.producerResultSha256) && identifier(value.discardRuleId) && sortedNonEmpty(value.discardRuleSourceIds) && record(value.assertionIds) && keys(value.assertionIds, ['use', 'open', 'salvage']) && Object.values(value.assertionIds).every(identifier) && record(value.assertionSourceIds) && keys(value.assertionSourceIds, ['use', 'open', 'salvage']) && Object.values(value.assertionSourceIds).every(sortedNonEmpty); }
function sortedProofs(values: InventoryDiscardAllowlistProofV1[]): boolean { return values.every((value, index) => index === 0 || values[index - 1]!.itemId < value.itemId || (values[index - 1]!.itemId === value.itemId && values[index - 1]!.explanationRef < value.explanationRef)); }
function report(value: unknown): value is InventoryAdvisorReportV1 { return isInventoryAdvisorReport(value); }
function uniqueReasons<T extends { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }>(values: T[]): T[] { const seen = new Set<string>(); return values.filter((value) => { const key = `${value.itemId ?? ''}:${value.code}:${value.goalId ?? ''}:${value.ruleId ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function reasonOrder(left: { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }, right: { itemId: number | null; code: string; goalId: string | null; ruleId: string | null }): number { return (left.itemId ?? -1) - (right.itemId ?? -1) || left.code.localeCompare(right.code) || (left.goalId ?? '').localeCompare(right.goalId ?? '') || (left.ruleId ?? '').localeCompare(right.ruleId ?? ''); }
function record(value: unknown): value is Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const prototype: unknown = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function keys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((entry, index) => entry === sorted[index]); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
function ref(value: unknown): value is string { return typeof value === 'string' && /^#(?:\/[A-Za-z0-9._~-]+)+$/u.test(value); }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function sortedNonEmpty(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(identifier) && value.every((entry, index) => index === 0 || value[index - 1]! < entry); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
