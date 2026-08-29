import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import {
	calculateContainerDispositionKernel,
	type ContainerDispositionKernelExplanation,
	type ContainerDispositionKernelPolicy,
	type ContainerBindingEvidence,
} from '../economy/container-disposition-kernel';
import { isContainerModel, type ContainerModelV1 } from '../economy/container-model';
import { halloweenTrickOrTreatBagModel } from '../economy/models/halloween-trick-or-treat-bag';
import {
	isContainerPersonalValuation,
	resolveContainerPersonalValuation,
	type ContainerPersonalValuationResolutionV1,
	type ContainerPersonalValuationV1,
} from '../economy/container-personal-valuation';
import {
	isInventoryAdvisorRulePackV2,
	sha256StandardCanonicalValue,
} from './inventory-advisor-contract';
import type {
	InventoryAdvisorRulePackV2,
	InventoryItemPriceV1,
} from './inventory-advisor-model';

export const INVENTORY_CONTAINER_ECONOMY_VERSION = 1 as const;
export const INVENTORY_CONTAINER_PRICE_EVIDENCE_VERSION = 1 as const;

export type InventoryContainerEconomyActivation =
	| { status: 'pending_human_review'; activatedAt: null }
	| { status: 'enabled'; activatedAt: string }
	| { status: 'revoked'; activatedAt: string };

export interface InventoryContainerEconomyPackV1 {
	version: typeof INVENTORY_CONTAINER_ECONOMY_VERSION;
	packId: string;
	publishedAt: string;
	validUntil: string;
	activation: InventoryContainerEconomyActivation;
	rulePack: { id: string; version: number; sha256: string; ruleId: string };
	knowledgePackSha256: string;
	modelFingerprint: string;
	model: ContainerModelV1;
	expectedPriceItemIds: number[];
	policy: ContainerDispositionKernelPolicy;
	sources: Array<{ id: string; url: string; retrievedAt: string }>;
	sha256: string;
}

/** Fresh sibling batch captured by the same explicit Refresh as H4.14. */
export interface InventoryContainerPriceEvidenceV1 {
	version: typeof INVENTORY_CONTAINER_PRICE_EVIDENCE_VERSION;
	accountId: string;
	snapshotId: string;
	schemaVersion: string;
	capturedAt: string;
	source: 'gw2-commerce-prices';
	requestedItemIds: number[];
	status: 'complete' | 'partial' | 'unavailable';
	items: InventoryItemPriceV1[];
	missingItemIds: number[];
}

export interface InventoryContainerEconomyInputV1 {
	version: typeof INVENTORY_CONTAINER_ECONOMY_VERSION;
	asOf: string;
	accountId: string;
	snapshotId: string;
	schemaVersion: string;
	allocation: {
		ownedQuantity: number;
		availableQuantity: number;
		reservedQuantity: number;
		exceptionQuantity: number;
		reviewQuantity: number;
		freeQuantity: number;
	};
	container: {
		itemId: number;
		catalogItem: CatalogItem;
		binding: ContainerBindingEvidence;
		tradingAccess: 'full' | 'free_to_play' | 'unknown';
	};
	rulePack: InventoryAdvisorRulePackV2;
	knowledgePackSha256: string;
	economyPack: InventoryContainerEconomyPackV1;
	prices: InventoryContainerPriceEvidenceV1;
	/** User-owned overlay. It is never included in the economy pack or model fingerprint. */
	personalValuation?: ContainerPersonalValuationV1;
}

export type InventoryContainerEconomyReviewReason =
	| 'activation_pending'
	| 'activation_revoked'
	| 'activation_expired'
	| 'rule_incoherent'
	| 'model_incoherent'
	| 'allocation_incoherent'
	| 'binding_unknown'
	| 'trading_access_unknown'
	| 'price_partial'
	| 'price_stale'
	| 'price_future'
	| 'price_missing'
	| 'price_incoherent'
	| 'open_ev_partial'
	| 'container_not_sellable'
	| 'personal_valuation_incoherent'
	| 'arithmetic_overflow';

export interface InventoryContainerEconomyDecisionV1 {
	action: 'open' | 'sell' | 'vendor';
	quantity: number;
	ruleId: string | null;
}

export interface InventoryContainerPersonalEconomyV1 {
	valuation: ContainerPersonalValuationResolutionV1;
	/** Available only when all ten explicit non-liquid outcomes have manual values. */
	openEvPerContainerMicroCopper: number | null;
	totalExpectedMicroCopper: string | null;
	decision: InventoryContainerEconomyDecisionV1 | null;
	comparison: {
		differenceMicroCopper: string;
		advantageBps: number | null;
		rule: 'open_at_or_above_threshold';
	} | null;
}

export type InventoryContainerEconomyResult =
	| {
		status: 'ready';
		/** Primary recommendation: personal only with complete coverage, liquid-only otherwise. */
		decision: InventoryContainerEconomyDecisionV1;
		recommendationBasis: 'liquid_only' | 'personal';
		liquidOnly: {
			decision: InventoryContainerEconomyDecisionV1;
			explanation: ContainerDispositionKernelExplanation;
		};
		personal: InventoryContainerPersonalEconomyV1;
		/** Backwards-compatible alias for the unchanged liquid-only explanation. */
		explanation: ContainerDispositionKernelExplanation;
	}
	| { status: 'review'; reason: InventoryContainerEconomyReviewReason }
	| { status: 'invalid'; reason: 'malformed_input' };

/**
 * Contextual H4.19 guard around the session-independent H4.10 kernel. Every
 * identity, allocation, activation and freshness fact is reproduced here.
 */
export function evaluateInventoryContainerEconomy(value: unknown): InventoryContainerEconomyResult {
	try {
		if (!isInput(value)) return { status: 'invalid', reason: 'malformed_input' };
		const input = value;
		const allocation = input.allocation;
		if (allocation.reservedQuantity + allocation.exceptionQuantity + allocation.reviewQuantity
			+ allocation.freeQuantity !== allocation.availableQuantity
			|| allocation.availableQuantity > allocation.ownedQuantity) {
			return review('allocation_incoherent');
		}
		const pack = input.economyPack;
		if (pack.activation.status === 'pending_human_review') return review('activation_pending');
		if (pack.activation.status === 'revoked') return review('activation_revoked');
		if (Date.parse(input.asOf) < Date.parse(pack.activation.activatedAt)
			|| Date.parse(input.asOf) < Date.parse(pack.publishedAt)
			|| Date.parse(input.asOf) >= Date.parse(pack.validUntil)) return review('activation_expired');
		if (!ruleBinding(input)) return review('rule_incoherent');
		if (!modelBinding(pack)) return review('model_incoherent');
		if (!priceBinding(input)) return review(input.prices.status === 'complete'
			? 'price_incoherent' : 'price_partial');
		const age = Date.parse(input.asOf) - Date.parse(input.prices.capturedAt);
		if (age < -pack.policy.maxFutureSkewMs) return review('price_future');
		if (age > pack.policy.maxPriceAgeMs) return review('price_stale');
		const quoteById = new Map(input.prices.items.map((item) => [item.itemId, item]));
		if (pack.expectedPriceItemIds.some((itemId) => quoteById.get(itemId)?.bid === null)) {
			return review('price_missing');
		}
		const containerQuote = quoteById.get(input.container.itemId);
		if (!containerQuote?.bid || containerQuote.bid.quantity < allocation.freeQuantity) {
			return review('price_partial');
		}
		const kernel = calculateContainerDispositionKernel({
			version: 1,
			asOf: input.asOf,
			quantity: allocation.freeQuantity,
			container: input.container,
			model: pack.model,
			market: {
				version: 1,
				batchId: `${input.snapshotId}:${input.prices.capturedAt}`,
				capturedAt: input.prices.capturedAt,
				source: input.prices.source,
				quotes: input.prices.items.map((item) => ({
					itemId: item.itemId,
					whitelisted: item.whitelisted,
					bidUnitCopper: item.bid?.unitCopper ?? null,
					askUnitCopper: item.ask?.unitCopper ?? null,
				})),
			},
			policy: pack.policy,
		});
		if (kernel.status === 'invalid') return review(kernel.reason === 'arithmetic_overflow'
			? 'arithmetic_overflow' : 'model_incoherent');
		if (kernel.status === 'review') return review(kernelReason(kernel.reason));
		const liquidDecision: InventoryContainerEconomyDecisionV1 = {
			action: kernel.decision.action === 'open' ? 'open'
				: kernel.decision.sellRoute === 'vendor' ? 'vendor' : 'sell',
			quantity: kernel.decision.quantity,
			ruleId: kernel.decision.action === 'open' ? pack.rulePack.ruleId : null,
		};
		const personal = personalEconomy(
			pack.model,
			input.personalValuation ?? { version: 1, values: [] },
			kernel.explanation,
			allocation.freeQuantity,
			pack.rulePack.ruleId,
		);
		if (personal.status === 'invalid') return review(personal.reason);
		const primary = personal.value.decision ?? liquidDecision;
		return {
			status: 'ready',
			decision: primary,
			recommendationBasis: personal.value.decision === null ? 'liquid_only' : 'personal',
			liquidOnly: { decision: liquidDecision, explanation: kernel.explanation },
			personal: personal.value,
			explanation: kernel.explanation,
		};
	} catch {
		return { status: 'invalid', reason: 'malformed_input' };
	}
}

export function isInventoryContainerEconomyPack(value: unknown): value is InventoryContainerEconomyPackV1 {
	try {
		if (!record(value) || !exactKeys(value, [
			'version', 'packId', 'publishedAt', 'validUntil', 'activation', 'rulePack', 'knowledgePackSha256',
			'modelFingerprint', 'model', 'expectedPriceItemIds', 'policy', 'sources', 'sha256',
		]) || value.version !== INVENTORY_CONTAINER_ECONOMY_VERSION || !identifier(value.packId)
			|| !iso(value.publishedAt) || !iso(value.validUntil)
			|| Date.parse(value.publishedAt) >= Date.parse(value.validUntil)
			|| !activation(value.activation, value.publishedAt, value.validUntil)
			|| !record(value.rulePack) || !exactKeys(value.rulePack, ['id', 'version', 'sha256', 'ruleId'])
			|| !identifier(value.rulePack.id) || !positive(value.rulePack.version)
			|| !sha(value.rulePack.sha256) || !identifier(value.rulePack.ruleId)
			|| !sha(value.knowledgePackSha256) || !sha(value.modelFingerprint)
			|| !isContainerModel(value.model) || !Array.isArray(value.expectedPriceItemIds)
			|| !value.expectedPriceItemIds.every(positive) || !strictNumbers(value.expectedPriceItemIds)
			|| !kernelPolicy(value.policy) || !Array.isArray(value.sources) || value.sources.length === 0
			|| !value.sources.every(source) || !sha(value.sha256)) return false;
		const pack = value as unknown as InventoryContainerEconomyPackV1;
		const sourceIds = new Set(pack.sources.map((entry) => entry.id));
		const expected = economicPriceIds(pack.model);
		return strictSources(pack.sources) && sourceIds.size === pack.sources.length
			&& sameNumbers(pack.expectedPriceItemIds, expected)
			&& pack.modelFingerprint === sha256StandardCanonicalValue(pack.model)
			&& pack.sources.every((entry) => Date.parse(entry.retrievedAt) <= Date.parse(pack.publishedAt))
			&& pack.sha256 === sha256InventoryContainerEconomyPack(pack);
	} catch { return false; }
}

export function sha256InventoryContainerEconomyPack(pack: InventoryContainerEconomyPackV1): string {
	const { sha256: _ignored, ...content } = pack;
	return sha256StandardCanonicalValue(content);
}

export function isInventoryContainerPriceEvidence(value: unknown): value is InventoryContainerPriceEvidenceV1 {
	try {
		if (!record(value) || !exactKeys(value, [
			'version', 'accountId', 'snapshotId', 'schemaVersion', 'capturedAt', 'source', 'requestedItemIds',
			'status', 'items', 'missingItemIds',
		]) || value.version !== INVENTORY_CONTAINER_PRICE_EVIDENCE_VERSION || !text(value.accountId, 256)
			|| !text(value.snapshotId, 256) || !text(value.schemaVersion, 256) || !iso(value.capturedAt)
			|| value.source !== 'gw2-commerce-prices' || !Array.isArray(value.requestedItemIds)
			|| !value.requestedItemIds.every(positive) || !strictNumbers(value.requestedItemIds)
			|| !['complete', 'partial', 'unavailable'].includes(String(value.status)) || !Array.isArray(value.items)
			|| !value.items.every(priceItem) || !Array.isArray(value.missingItemIds)
			|| !value.missingItemIds.every(positive) || !strictNumbers(value.missingItemIds)) return false;
		const evidence = value as unknown as InventoryContainerPriceEvidenceV1;
		const observed = [...evidence.items.map((item) => item.itemId), ...evidence.missingItemIds]
			.sort((left, right) => left - right);
		return sameNumbers(observed, evidence.requestedItemIds)
			&& (evidence.status === 'complete' ? evidence.missingItemIds.length === 0
				: evidence.status === 'unavailable' ? evidence.items.length === 0 && evidence.missingItemIds.length > 0
					: evidence.items.length > 0 && evidence.missingItemIds.length > 0);
	} catch { return false; }
}

type HalloweenContainerEconomyBinding = {
	rulePack: { id: string; version: number; sha256: string; ruleId: string };
	knowledgePackSha256: string;
};

/** Pending candidate retained for fail-closed tests and future review workflows. */
export function pendingHalloweenContainerEconomyPack(
	binding: HalloweenContainerEconomyBinding,
): InventoryContainerEconomyPackV1 {
	return halloweenContainerEconomyPack(binding, { status: 'pending_human_review', activatedAt: null });
}

/** Human-reviewed built-in pack. Decisions remain manual and evidence-gated. */
export function enabledHalloweenContainerEconomyPack(
	binding: HalloweenContainerEconomyBinding,
	activatedAt: string,
): InventoryContainerEconomyPackV1 {
	return halloweenContainerEconomyPack(binding, { status: 'enabled', activatedAt });
}

function halloweenContainerEconomyPack(
	binding: HalloweenContainerEconomyBinding,
	activation: InventoryContainerEconomyActivation,
): InventoryContainerEconomyPackV1 {
	const model = halloweenTrickOrTreatBagModel();
	const candidate: InventoryContainerEconomyPackV1 = {
		version: 1,
		packId: 'tc.inventory-container-economy.halloween-v1',
		publishedAt: '2026-08-14T20:30:00.000Z',
		validUntil: '2026-11-12T18:04:33.000Z',
		activation: structuredClone(activation),
		rulePack: structuredClone(binding.rulePack),
		knowledgePackSha256: binding.knowledgePackSha256,
		modelFingerprint: sha256StandardCanonicalValue(model),
		model,
		expectedPriceItemIds: economicPriceIds(model),
		policy: {
			version: 1,
			openAdvantageBps: 1_000,
			maxPriceAgeMs: 15 * 60_000,
			maxFutureSkewMs: 60_000,
			saleBasis: 'immediate',
		},
		sources: [{
			id: 'gw2-wiki-tot-bag-research-3161313',
			url: 'https://wiki.guildwars2.com/index.php?title=Trick-or-Treat_Bag/research&oldid=3161313',
			retrievedAt: '2026-08-14T20:30:00.000Z',
		}],
		sha256: '',
	};
	candidate.sha256 = sha256InventoryContainerEconomyPack(candidate);
	if (!isInventoryContainerEconomyPack(candidate)) throw new Error('Invalid container economy pack.');
	return structuredClone(candidate);
}

function isInput(value: unknown): value is InventoryContainerEconomyInputV1 {
	return record(value) && exactOptionalKeys(value, [
		'version', 'asOf', 'accountId', 'snapshotId', 'schemaVersion', 'allocation', 'container', 'rulePack',
		'knowledgePackSha256', 'economyPack', 'prices',
	], ['personalValuation']) && value.version === 1 && iso(value.asOf) && text(value.accountId, 256) && text(value.snapshotId, 256)
		&& text(value.schemaVersion, 256)
		&& allocation(value.allocation) && container(value.container) && isInventoryAdvisorRulePackV2(value.rulePack)
		&& sha(value.knowledgePackSha256) && isInventoryContainerEconomyPack(value.economyPack)
		&& isInventoryContainerPriceEvidence(value.prices)
		&& (value.personalValuation === undefined || isContainerPersonalValuation(value.personalValuation));
}

function personalEconomy(
	model: ContainerModelV1,
	overlay: ContainerPersonalValuationV1,
	liquid: ContainerDispositionKernelExplanation,
	quantity: number,
	openRuleId: string,
): { status: 'ok'; value: InventoryContainerPersonalEconomyV1 }
	| { status: 'invalid'; reason: 'personal_valuation_incoherent' | 'arithmetic_overflow' } {
	const resolved = resolveContainerPersonalValuation(model, overlay);
	if (resolved.status === 'invalid') return {
		status: 'invalid',
		reason: resolved.reason === 'arithmetic_overflow' ? 'arithmetic_overflow' : 'personal_valuation_incoherent',
	};
	const base: InventoryContainerPersonalEconomyV1 = {
		valuation: resolved.value,
		openEvPerContainerMicroCopper: null,
		totalExpectedMicroCopper: null,
		decision: null,
		comparison: null,
	};
	if (resolved.value.coverage !== 'complete' || resolved.value.totalAdjustment === null) {
		return { status: 'ok', value: base };
	}
	const perContainer = BigInt(liquid.open.evPerContainerMicroCopper)
		+ BigInt(resolved.value.totalAdjustment);
	const openTotal = perContainer * BigInt(quantity);
	if (!safeNonNegativeBigInt(perContainer) || !safeNonNegativeBigInt(openTotal)) {
		return { status: 'invalid', reason: 'arithmetic_overflow' };
	}
	const requiredOpen = BigInt(liquid.threshold.requiredOpenMicroCopper);
	const sellMicro = BigInt(liquid.sellNow.netCopper) * 1_000_000n;
	const opens = openTotal >= requiredOpen;
	const advantage = sellMicro === 0n ? null
		: safeSignedBigIntNumber((openTotal - sellMicro) * 10_000n / sellMicro);
	const decision: InventoryContainerEconomyDecisionV1 = {
		action: opens ? 'open' : liquid.sellNow.route === 'vendor' ? 'vendor' : 'sell',
		quantity,
		ruleId: opens ? openRuleId : null,
	};
	return {
		status: 'ok',
		value: {
			...base,
			openEvPerContainerMicroCopper: Number(perContainer),
			totalExpectedMicroCopper: openTotal.toString(),
			decision,
			comparison: {
				differenceMicroCopper: (openTotal - requiredOpen).toString(),
				advantageBps: advantage,
				rule: 'open_at_or_above_threshold',
			},
		},
	};
}

function safeNonNegativeBigInt(value: bigint): boolean {
	return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

function safeSignedBigIntNumber(value: bigint): number | null {
	return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
		? Number(value) : null;
}

function ruleBinding(input: InventoryContainerEconomyInputV1): boolean {
	const activationAt = input.economyPack.activation.activatedAt;
	if (input.rulePack.reviewStatus !== 'human_reviewed' || input.rulePack.reviewedAt === null
		|| activationAt === null || Date.parse(activationAt) < Date.parse(input.rulePack.reviewedAt)) return false;
	const binding = input.economyPack.rulePack;
	const rules = input.rulePack.rules.filter((rule) => rule.ruleId === binding.ruleId
		&& rule.itemId === input.container.itemId && rule.action === 'open');
	return input.rulePack.id === binding.id && input.rulePack.version === binding.version
		&& input.rulePack.sha256 === binding.sha256
		&& input.knowledgePackSha256 === input.rulePack.knowledgePackSha256
		&& input.knowledgePackSha256 === input.economyPack.knowledgePackSha256
		&& rules.length === 1 && rules[0]?.status === 'approved'
		&& rules[0].capability === 'applicable' && rules[0].recommendation.status === 'enabled';
}

function modelBinding(pack: InventoryContainerEconomyPackV1): boolean {
	return pack.model.containerItemId > 0
		&& pack.modelFingerprint === sha256StandardCanonicalValue(pack.model)
		&& sameNumbers(pack.expectedPriceItemIds, economicPriceIds(pack.model));
}

function priceBinding(input: InventoryContainerEconomyInputV1): boolean {
	return input.prices.accountId === input.accountId && input.prices.snapshotId === input.snapshotId
		&& input.prices.schemaVersion === input.schemaVersion
		&& input.prices.status === 'complete' && input.prices.missingItemIds.length === 0
		&& sameNumbers(input.prices.requestedItemIds, input.economyPack.expectedPriceItemIds)
		&& sameNumbers(input.prices.items.map((item) => item.itemId), input.economyPack.expectedPriceItemIds);
}

function economicPriceIds(model: ContainerModelV1): number[] {
	return [model.containerItemId, ...model.outcomes.filter((outcome) => outcome.valuationPolicy === 'liquid_market'
		&& outcome.sampleUnits > 0).map((outcome) => outcome.id)].sort((left, right) => left - right);
}

function kernelReason(reason: string): InventoryContainerEconomyReviewReason {
	const known: InventoryContainerEconomyReviewReason[] = [
		'binding_unknown', 'trading_access_unknown', 'price_stale', 'price_future', 'price_missing',
		'open_ev_partial', 'container_not_sellable', 'arithmetic_overflow',
	];
	return known.includes(reason as InventoryContainerEconomyReviewReason)
		? reason as InventoryContainerEconomyReviewReason : 'model_incoherent';
}

function activation(value: unknown, publishedAt: string, validUntil: string): value is InventoryContainerEconomyActivation {
	if (!record(value) || !['pending_human_review', 'enabled', 'revoked'].includes(String(value.status))) return false;
	if (value.status === 'pending_human_review') return exactKeys(value, ['status', 'activatedAt']) && value.activatedAt === null;
	return exactKeys(value, ['status', 'activatedAt']) && iso(value.activatedAt)
		&& Date.parse(value.activatedAt) >= Date.parse(publishedAt) && Date.parse(value.activatedAt) < Date.parse(validUntil);
}

function allocation(value: unknown): value is InventoryContainerEconomyInputV1['allocation'] {
	return record(value) && exactKeys(value, ['ownedQuantity', 'availableQuantity', 'reservedQuantity', 'exceptionQuantity', 'reviewQuantity', 'freeQuantity'])
		&& nonNegative(value.ownedQuantity) && nonNegative(value.availableQuantity)
		&& nonNegative(value.reservedQuantity) && nonNegative(value.exceptionQuantity)
		&& nonNegative(value.reviewQuantity)
		&& positive(value.freeQuantity);
}

function container(value: unknown): value is InventoryContainerEconomyInputV1['container'] {
	return record(value) && exactKeys(value, ['itemId', 'catalogItem', 'binding', 'tradingAccess'])
		&& positive(value.itemId) && isNormalizedCatalogItem(value.catalogItem) && value.catalogItem.id === value.itemId
		&& ['unbound', 'account_bound', 'character_bound', 'unknown'].includes(String(value.binding))
		&& ['full', 'free_to_play', 'unknown'].includes(String(value.tradingAccess));
}

function kernelPolicy(value: unknown): value is ContainerDispositionKernelPolicy {
	return record(value) && exactKeys(value, ['version', 'openAdvantageBps', 'maxPriceAgeMs', 'maxFutureSkewMs', 'saleBasis'])
		&& value.version === 1 && value.openAdvantageBps === 1_000 && value.maxPriceAgeMs === 15 * 60_000
		&& value.maxFutureSkewMs === 60_000 && value.saleBasis === 'immediate';
}

function source(value: unknown): boolean {
	return record(value) && exactKeys(value, ['id', 'url', 'retrievedAt']) && identifier(value.id)
		&& typeof value.url === 'string' && /^https?:\/\//u.test(value.url) && iso(value.retrievedAt);
}

function priceItem(value: unknown): value is InventoryItemPriceV1 {
	return record(value) && exactKeys(value, ['itemId', 'whitelisted', 'bid', 'ask']) && positive(value.itemId)
		&& typeof value.whitelisted === 'boolean' && priceSide(value.bid) && priceSide(value.ask);
}

function priceSide(value: unknown): boolean {
	return value === null || (record(value) && exactKeys(value, ['unitCopper', 'quantity'])
		&& positive(value.unitCopper) && positive(value.quantity));
}

function strictNumbers(values: number[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function strictSources(values: Array<{ id: string }>): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]!.id.localeCompare(value.id) < 0);
}

function sameNumbers(left: number[], right: number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function review(reason: InventoryContainerEconomyReviewReason): InventoryContainerEconomyResult {
	return { status: 'review', reason };
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function sha(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function text(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function exactOptionalKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
	const keys = Object.keys(value);
	return required.every((key) => keys.includes(key))
		&& keys.every((key) => required.includes(key) || optional.includes(key));
}
