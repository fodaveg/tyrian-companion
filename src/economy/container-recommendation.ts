import {
	LEGACY_SESSION_CLASSIFICATION_VERSION,
} from '../account/contamination-model';
import { isStorageDelta } from '../account/contamination';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { compareStorageSnapshots } from '../account/storage-delta';
import { sha256CanonicalValue } from '../core/canonical-sha256';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import {
	type ContainerMarketQuote,
	type ContainerTradingAccess,
} from './container-expected-value';
import { calculateContainerDispositionKernel } from './container-disposition-kernel';
import { isContainerModel, type ContainerModelV1 } from './container-model';
import { createTradingPostValueWithPolicy } from './gw2-fees';
import type { ReservationGoal, ReservationPlan, SessionValuationReservationOverlay } from './reservation-model';
import {
	buildReservationBalance,
	createReservationPlan,
	isReservationGoal,
	isReservationPlan,
	isSessionValuationReservationOverlay,
	partitionSessionValuation,
} from './reservation';
import type { SessionBindingEvidence } from './session-valuation';
import {
	isSessionContaminationReview,
	type SessionContaminationReview,
} from '../sessions/session-contamination-review';
import {
	evaluateHoldIntents,
	isHoldIntent,
	isHoldPlan,
	type HoldIntentV1,
	type HoldPlan,
} from './hold-intent';
import {
	createRecommendationEnvelope,
	isRecommendationEnvelope,
	type RecommendationDecision,
	type RecommendationEnvelopeV1,
} from './recommendation-envelope';

export const CONTAINER_RECOMMENDATION_VERSION = 1 as const;
const MICRO_COPPER = 1_000_000n;
const BASIS_POINTS = 10_000n;
const DAY_MS = 86_400_000;

export const DEFAULT_CONTAINER_RECOMMENDATION_POLICY: ContainerRecommendationPolicy = {
	version: 1,
	openAdvantageBps: 1_000,
	maxPriceAgeMs: 15 * 60_000,
	maxModelReviewAgeMs: 30 * DAY_MS,
	maxFutureSkewMs: 60_000,
	saleBasis: 'immediate',
};

export interface ContainerRecommendationPolicy {
	version: 1;
	openAdvantageBps: number;
	maxPriceAgeMs: number;
	maxModelReviewAgeMs: number;
	maxFutureSkewMs: number;
	saleBasis: 'immediate';
}

export interface ContainerModelReview {
	version: 1;
	modelId: string;
	modelVersion: number;
	modelFingerprint: string;
	status: 'approved' | 'revoked';
	reviewedAt: string;
	validUntil: string;
	reviewReason: string;
}

export interface ContainerMarketBatch {
	version: 1;
	batchId: string;
	capturedAt: string;
	source: 'gw2-commerce-prices';
	quotes: ContainerMarketQuote[];
}

export interface ContainerRecommendationInput {
	version: 1;
	asOf: string;
	session: {
		sessionId: string;
		beforeSnapshot: StorageSnapshot;
		afterSnapshot: StorageSnapshot;
		delta: StorageDelta;
		review: SessionContaminationReview;
	};
	container: {
		itemId: number;
		catalogItem: CatalogItem;
		binding: SessionBindingEvidence;
		tradingAccess: ContainerTradingAccess;
	};
	reservation: {
		goals: ReservationGoal[];
		overlay: SessionValuationReservationOverlay;
		plan: ReservationPlan;
		sackItemIds: number[];
	};
	hold: { intents: HoldIntentV1[]; plan: HoldPlan };
	model: ContainerModelV1;
	modelReview: ContainerModelReview;
	market: ContainerMarketBatch;
	policy: ContainerRecommendationPolicy;
}

export type ContainerRecommendationReasonCode =
	| 'session_classification_v1'
	| 'session_estimated'
	| 'session_contaminated'
	| 'session_invalid'
	| 'session_not_recommendable'
	| 'reservation_unknown'
	| 'reservation_mismatch'
	| 'hold_intent_active'
	| 'hold_price_unavailable'
	| 'model_unreviewed'
	| 'model_revoked'
	| 'model_review_stale'
	| 'model_review_future'
	| 'model_review_mismatch'
	| 'price_stale'
	| 'price_future'
	| 'price_missing'
	| 'open_ev_partial'
	| 'container_not_sellable'
	| 'binding_unknown'
	| 'trading_access_unknown'
	| 'malformed_input'
	| 'evidence_mismatch'
	| 'arithmetic_overflow'
	| 'model_ev_inconsistent';

export interface ContainerRecommendationReason {
	code: ContainerRecommendationReasonCode;
}

export interface ReservedContainerAllocation {
	goalId: string;
	reason: 'achievement' | 'purchase' | 'personal';
	intendedUse: 'hold' | 'open' | 'consume' | 'exchange';
	quantity: number;
}

export interface HeldContainerAllocation {
	intentId: string;
	state: 'holding' | 'price_unavailable';
	route: 'instant_sell' | 'listing';
	reason: HoldIntentV1['reason'];
	quantity: number;
}

export interface ContainerDispositionRecommendation {
	version: typeof CONTAINER_RECOMMENDATION_VERSION;
	sessionId: string;
	accountId: string;
	afterSnapshotId: string;
	itemId: number;
	allocations: {
		reserved: ReservedContainerAllocation[];
		held: HeldContainerAllocation[];
		freeQuantity: number;
	};
	economicDecision: null | {
		action: 'open' | 'sell';
		quantity: number;
		sellRoute: 'instant_sell' | 'vendor';
	};
	explanation: null | {
		sellNow: {
			route: 'instant_sell' | 'vendor';
			unitCopper: number;
			grossCopper: number;
			listingFeeCopper: number;
			exchangeFeeCopper: number;
			totalFeesCopper: number;
			netCopper: number;
		};
		open: {
			evPerContainerMicroCopper: number;
			totalExpectedMicroCopper: string;
			coverage: 'complete';
			modelId: string;
			modelVersion: number;
			sampleContainers: number;
			excludedSampleUnits: number;
			rareTreatment: ContainerModelV1['uncertainty']['rareDropTreatment'];
		};
		threshold: {
			marginBps: number;
			requiredOpenMicroCopper: string;
		};
		comparison: {
			differenceMicroCopper: string;
			advantageBps: number | null;
			rule: 'open_at_or_above_threshold';
		};
		freshness: {
			asOf: string;
			priceCapturedAt: string;
			priceAgeMs: number;
			modelReviewedAt: string;
			modelReviewAgeMs: number;
		};
		caveats: string[];
	};
	reasons: ContainerRecommendationReason[];
}

export type ContainerRecommendationResult =
	| { status: 'ready'; recommendation: ContainerDispositionRecommendation; envelope: RecommendationEnvelopeV1 }
	| { status: 'reserved_only'; recommendation: ContainerDispositionRecommendation; envelope: RecommendationEnvelopeV1 }
	| { status: 'blocked'; reasons: ContainerRecommendationReason[];
		recommendation: ContainerDispositionRecommendation | null; envelope: RecommendationEnvelopeV1 }
	| { status: 'invalid'; reasons: ContainerRecommendationReason[]; recommendation: null;
		envelope: RecommendationEnvelopeV1 };

/** Authoritative runtime guard for persisted or cross-module H4.10 results. */
export function isContainerRecommendationResult(value: unknown): value is ContainerRecommendationResult {
	try {
		if (!isRecord(value) || !['ready', 'reserved_only', 'blocked', 'invalid'].includes(String(value.status)) ||
			!isRecommendationEnvelope(value.envelope)) return false;
		const status = value.status as ContainerRecommendationResult['status'];
		const keys = status === 'blocked' || status === 'invalid'
			? ['status', 'reasons', 'recommendation', 'envelope']
			: ['status', 'recommendation', 'envelope'];
		if (!exactKeys(value, keys)) return false;
		if (status === 'invalid') {
			return value.recommendation === null && isRecommendationReasons(value.reasons) && value.reasons.length > 0 &&
				canonical(value.envelope) === canonical(emptyRecommendationEnvelope());
		}
		if (status === 'blocked' && value.recommendation === null) {
			return isRecommendationReasons(value.reasons) && value.reasons.length > 0 &&
				canonical(value.envelope) === canonical(emptyRecommendationEnvelope());
		}
		if (!isDispositionRecommendation(value.recommendation, status)) return false;
		if (status === 'blocked' && (!isRecommendationReasons(value.reasons) ||
			value.reasons.length === 0 || canonical(value.reasons) !== canonical(value.recommendation.reasons))) return false;
		return canonical(value.envelope) === canonical(envelopeForRecommendation(value.recommendation, status));
	} catch {
		return false;
	}
}

/** Pure H4.10 decision engine. It never performs a market, account, persistence or item operation. */
export function recommendContainerDisposition(inputValue: unknown): ContainerRecommendationResult {
	try {
		if (!isInputShell(inputValue)) return invalid('malformed_input');
		const input = inputValue;
		const identity = validateIdentity(input);
		if (identity !== null) return invalid(identity);
		const reservation = reservationEvidence(input);
		if (reservation.status === 'invalid') return invalid(reservation.reason);
		if (reservation.status === 'blocked') return blocked(reservation.reason);
		const { freeQuantity: reservationFree, reserved, gainedQuantity } = reservation;
		// Fully reserved gains need no temporal market evidence and cannot produce an action.
		if (reservationFree === 0) {
			const recommendation = baseRecommendation(input, reserved, [], 0, null, null, []);
			return {
				status: 'reserved_only',
				recommendation,
				envelope: envelopeForRecommendation(recommendation, 'reserved_only'),
			};
		}
		// Holds interpret market quotes, so their batch must be fresh before they can consume the free pool.
		const freshnessReason = validateMarketFreshness(input);
		if (freshnessReason !== null) {
			return blockedWithReservation(input, reserved, [], reservationFree, freshnessReason, []);
		}
		const hold = holdEvidence(input);
		if (hold.status === 'invalid') return invalid(hold.reason);
		const { freeQuantity, held, reasons: holdReasons } = hold;
		// A fresh hold that consumes the remaining pool cannot produce an economic action.
		if (freeQuantity === 0) {
			const recommendation = baseRecommendation(input, reserved, held, freeQuantity, null, null, holdReasons);
			return {
				status: 'reserved_only',
				recommendation,
				envelope: envelopeForRecommendation(recommendation, 'reserved_only'),
			};
		}
		if (gainedQuantity < reservationFree || reservationFree < freeQuantity) return invalid('evidence_mismatch');

		const session = validateSessionClassification(input);
		if (session.status === 'invalid') return invalid(session.reason);
		if (session.status === 'blocked') return blockedWithReservation(input, reserved, held, freeQuantity, session.reason, holdReasons);
		const reviewReason = validateModelReview(input);
		if (reviewReason !== null) return blockedWithReservation(input, reserved, held, freeQuantity, reviewReason, holdReasons);

		const economics = calculateEconomics(input, freeQuantity);
		if (economics.status !== 'ok') {
			return economics.status === 'invalid' ? invalid(economics.reason)
				: blockedWithReservation(input, reserved, held, freeQuantity, economics.reason, holdReasons);
		}
		const recommendation = baseRecommendation(
			input,
			reserved,
			held,
			freeQuantity,
			economics.decision,
			economics.explanation,
			holdReasons,
		);
		return {
			status: 'ready',
			recommendation,
			envelope: envelopeForRecommendation(recommendation, 'ready'),
		};
	} catch {
		return invalid('arithmetic_overflow');
	}
}

function holdEvidence(input: ContainerRecommendationInput):
	| { status: 'ok'; freeQuantity: number; held: HeldContainerAllocation[]; reasons: ContainerRecommendationReason[] }
	| { status: 'invalid'; reason: ContainerRecommendationReasonCode } {
	const freeQuantityByItem: Record<string, number> = {};
	for (const line of input.reservation.overlay.lines) {
		if (line.liquidationEligible === null || line.openEligible === null) continue;
		freeQuantityByItem[String(line.itemId)] = Math.min(line.gainedQuantity, line.liquidationEligible, line.openEligible);
	}
	const result = evaluateHoldIntents({
		version: 1,
		asOf: input.asOf,
		accountId: input.session.afterSnapshot.accountId,
		snapshotId: input.session.afterSnapshot.snapshotId,
		sessionId: input.session.sessionId,
		freeQuantityByItem,
		intents: input.hold.intents,
		market: input.market,
	});
	if (result.status !== 'ok' || canonical(result.plan) !== canonical(input.hold.plan)) {
		return { status: 'invalid', reason: 'evidence_mismatch' };
	}
	const item = result.plan.items.find((entry) => entry.itemId === input.container.itemId);
	const held = result.plan.allocations.filter((entry) => entry.itemId === input.container.itemId && entry.allocatedQuantity > 0)
		.map((entry) => ({
			intentId: entry.intentId,
			state: entry.state as 'holding' | 'price_unavailable',
			route: entry.projectedTargetNet.route,
			reason: structuredClone(entry.reason),
			quantity: entry.allocatedQuantity,
		}));
	const reasons = [...new Set(held.map((entry) => entry.state === 'price_unavailable'
		? 'hold_price_unavailable' as const : 'hold_intent_active' as const))]
		.map((code) => ({ code }));
	return { status: 'ok', freeQuantity: item?.remainingFreeQuantity ?? 0, held, reasons };
}

function reservationEvidence(input: ContainerRecommendationInput):
	| { status: 'ok'; freeQuantity: number; gainedQuantity: number; reserved: ReservedContainerAllocation[] }
	| { status: 'blocked'; reason: ContainerRecommendationReasonCode }
	| { status: 'invalid'; reason: ContainerRecommendationReasonCode } {
	const { overlay, plan } = input.reservation;
	if (!isReservationPlan(plan) || !isSessionValuationReservationOverlay(overlay)) {
		return { status: 'invalid', reason: 'malformed_input' };
	}
	const balance = buildReservationBalance(input.session.afterSnapshot);
	if (balance.status !== 'ok') return { status: 'invalid', reason: 'evidence_mismatch' };
	const recomputedPlan = createReservationPlan({ goals: input.reservation.goals, balance: balance.balance });
	if (recomputedPlan.status !== 'ok' || canonical(recomputedPlan.plan) !== canonical(plan)) {
		return { status: 'invalid', reason: 'evidence_mismatch' };
	}
	const recomputed = partitionSessionValuation({
		valuation: overlay.valuation,
		delta: input.session.delta,
		plan,
		sackItemIds: input.reservation.sackItemIds,
	});
	if (recomputed.status !== 'ok' || canonical(recomputed.overlay) !== canonical(overlay)) {
		return { status: 'invalid', reason: 'evidence_mismatch' };
	}
	if (plan.accountId !== overlay.accountId || plan.snapshotId !== overlay.snapshotId) {
		return { status: 'blocked', reason: 'reservation_mismatch' };
	}
	const line = overlay.lines.find((entry) => entry.itemId === input.container.itemId);
	const asset = plan.assets.find((entry) => entry.key === `item:${String(input.container.itemId)}`);
	if (!line || !asset || asset.namespace !== 'item') {
		return { status: 'blocked', reason: 'reservation_mismatch' };
	}
	if (asset.coverage === 'unknown' || line.liquidationEligible === null || line.openEligible === null ||
		asset.allowances.liquidate === null || asset.allowances.open === null) {
		return { status: 'blocked', reason: 'reservation_unknown' };
	}
	const expectedLiquidate = Math.min(line.gainedQuantity, asset.allowances.liquidate);
	const expectedOpen = Math.min(line.gainedQuantity, asset.allowances.open);
	if (line.liquidationEligible !== expectedLiquidate || line.openEligible !== expectedOpen ||
		line.protectedFromLiquidation !== line.gainedQuantity - expectedLiquidate) {
		return { status: 'invalid', reason: 'evidence_mismatch' };
	}
	const freeQuantity = Math.min(line.gainedQuantity, line.liquidationEligible, line.openEligible);
	const reservedQuantity = line.gainedQuantity - freeQuantity;
	let remaining = reservedQuantity;
	const reserved: ReservedContainerAllocation[] = [];
	for (const allocation of asset.allocations) {
		if (remaining === 0) break;
		if (allocation.intendedUse === 'spend') return { status: 'invalid', reason: 'evidence_mismatch' };
		const quantity = Math.min(remaining, allocation.protectedAvailable);
		if (quantity > 0) reserved.push({
			goalId: allocation.goalId,
			reason: allocation.reason,
			intendedUse: allocation.intendedUse,
			quantity,
		});
		remaining -= quantity;
	}
	if (remaining !== 0 || freeQuantity + reserved.reduce((sum, entry) => sum + entry.quantity, 0) !== line.gainedQuantity) {
		return { status: 'invalid', reason: 'evidence_mismatch' };
	}
	return { status: 'ok', freeQuantity, gainedQuantity: line.gainedQuantity, reserved };
}

function validateIdentity(input: ContainerRecommendationInput): ContainerRecommendationReasonCode | null {
	const { session, container, reservation, model } = input;
	const recomputedDelta = compareStorageSnapshots(session.beforeSnapshot, session.afterSnapshot);
	if (recomputedDelta.status === 'invalid' || canonical(recomputedDelta) !== canonical(session.delta)) {
		return 'evidence_mismatch';
	}
	if (!isSessionContaminationReview(
		session.review,
		session.beforeSnapshot,
		session.afterSnapshot,
		session.delta,
	)) return 'evidence_mismatch';
	const reviewAt = Date.parse(session.review.reviewedAt);
	if (reviewAt < Date.parse(session.afterSnapshot.completedAt) || reviewAt > Date.parse(input.asOf)) {
		return 'evidence_mismatch';
	}
	if (!isStorageDelta(session.delta) || session.delta.accountId !== session.beforeSnapshot.accountId ||
		session.delta.accountId !== session.afterSnapshot.accountId ||
		session.delta.beforeSnapshotId !== session.beforeSnapshot.snapshotId ||
		session.delta.afterSnapshotId !== session.afterSnapshot.snapshotId ||
		reservation.plan.accountId !== session.afterSnapshot.accountId || reservation.plan.snapshotId !== session.afterSnapshot.snapshotId ||
		reservation.overlay.accountId !== session.afterSnapshot.accountId || reservation.overlay.snapshotId !== session.afterSnapshot.snapshotId ||
		reservation.overlay.valuation.sessionId !== session.sessionId || container.catalogItem.id !== container.itemId ||
		model.containerItemId !== container.itemId) return 'evidence_mismatch';
	if (container.binding === 'unbound' &&
		(container.catalogItem.flags.includes('AccountBound') ||
			container.catalogItem.flags.includes('SoulbindOnAcquire'))) return 'evidence_mismatch';
	return null;
}

function validateSessionClassification(input: ContainerRecommendationInput):
	| { status: 'ok' }
	| { status: 'blocked' | 'invalid'; reason: ContainerRecommendationReasonCode } {
	const value = input.session.review.classification;
	if (value.version === LEGACY_SESSION_CLASSIFICATION_VERSION) {
		return { status: 'blocked', reason: 'session_classification_v1' };
	}
	if (value.status === 'estimated') return { status: 'blocked', reason: 'session_estimated' };
	if (value.status === 'contaminated') return { status: 'blocked', reason: 'session_contaminated' };
	if (value.status === 'invalid') return { status: 'blocked', reason: 'session_invalid' };
	return value.status === 'exact' && value.confidence === 'high' && value.permissions.recommend
		? { status: 'ok' }
		: { status: 'blocked', reason: 'session_not_recommendable' };
}

function validateModelReview(input: ContainerRecommendationInput): ContainerRecommendationReasonCode | null {
	const { model, modelReview, policy } = input;
	if (modelReview.modelId !== model.modelId || modelReview.modelVersion !== model.modelVersion) {
		return 'model_review_mismatch';
	}
	if (modelReview.modelFingerprint !== containerModelFingerprint(model)) return 'model_review_mismatch';
	if (modelReview.status === 'revoked') return 'model_revoked';
	const asOf = Date.parse(input.asOf);
	const reviewedAt = Date.parse(modelReview.reviewedAt);
	const validUntil = Date.parse(modelReview.validUntil);
	const modelEvidenceAt = Math.max(
		Date.parse(model.createdAt),
		Date.parse(model.source.retrievedAt),
		model.source.publishedAt === null ? 0 : Date.parse(model.source.publishedAt),
	);
	if (reviewedAt < modelEvidenceAt || reviewedAt > asOf || validUntil < reviewedAt) return 'model_review_future';
	if (asOf > validUntil || asOf - reviewedAt > policy.maxModelReviewAgeMs) return 'model_review_stale';
	return null;
}

function validateMarketFreshness(input: ContainerRecommendationInput): ContainerRecommendationReasonCode | null {
	const asOf = Date.parse(input.asOf);
	const capturedAt = Date.parse(input.market.capturedAt);
	if (capturedAt - asOf > input.policy.maxFutureSkewMs) return 'price_future';
	if (asOf - capturedAt > input.policy.maxPriceAgeMs) return 'price_stale';
	return null;
}

function calculateEconomics(
	input: ContainerRecommendationInput,
	quantity: number,
): { status: 'ok'; decision: NonNullable<ContainerDispositionRecommendation['economicDecision']>;
	explanation: NonNullable<ContainerDispositionRecommendation['explanation']> } |
	{ status: 'blocked' | 'invalid'; reason: ContainerRecommendationReasonCode } {
	const modelAge = Date.parse(input.asOf) - Date.parse(input.modelReview.reviewedAt);
	const result = calculateContainerDispositionKernel({
		version: 1,
		asOf: input.asOf,
		quantity,
		container: input.container,
		model: input.model,
		market: input.market,
		policy: {
			version: input.policy.version,
			openAdvantageBps: input.policy.openAdvantageBps,
			maxPriceAgeMs: input.policy.maxPriceAgeMs,
			maxFutureSkewMs: input.policy.maxFutureSkewMs,
			saleBasis: input.policy.saleBasis,
		},
	});
	if (result.status !== 'ready') {
		return { status: result.status === 'invalid' ? 'invalid' : 'blocked', reason: result.reason };
	}
	return {
		status: 'ok',
		decision: result.decision,
		explanation: {
			...result.explanation,
			freshness: {
				...result.explanation.freshness,
				modelReviewedAt: input.modelReview.reviewedAt,
				modelReviewAgeMs: modelAge,
			},
		},
	};
}

function baseRecommendation(
	input: ContainerRecommendationInput,
	reserved: ReservedContainerAllocation[],
	held: HeldContainerAllocation[],
	freeQuantity: number,
	economicDecision: ContainerDispositionRecommendation['economicDecision'],
	explanation: ContainerDispositionRecommendation['explanation'],
	reasons: ContainerRecommendationReason[],
): ContainerDispositionRecommendation {
	return {
		version: CONTAINER_RECOMMENDATION_VERSION,
		sessionId: input.session.sessionId,
		accountId: input.session.afterSnapshot.accountId,
		afterSnapshotId: input.session.afterSnapshot.snapshotId,
		itemId: input.container.itemId,
		allocations: { reserved, held, freeQuantity },
		economicDecision,
		explanation,
		reasons: canonicalReasons(reasons),
	};
}

function isDispositionRecommendation(
	value: unknown,
	status: 'ready' | 'reserved_only' | 'blocked',
): value is ContainerDispositionRecommendation {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'sessionId', 'accountId', 'afterSnapshotId', 'itemId', 'allocations',
		'economicDecision', 'explanation', 'reasons',
	]) || value.version !== CONTAINER_RECOMMENDATION_VERSION || !trimmed(value.sessionId, 256) ||
		!trimmed(value.accountId, 256) || !trimmed(value.afterSnapshotId, 256) || !positive(value.itemId) ||
		!isRecommendationAllocations(value.allocations) || !isRecommendationReasons(value.reasons)) return false;
	if (status !== 'ready') return value.economicDecision === null && value.explanation === null;
	if (!isEconomicDecision(value.economicDecision, value.allocations.freeQuantity) ||
		!isEconomicExplanation(value.explanation, value.economicDecision)) return false;
	return value.economicDecision.quantity === value.allocations.freeQuantity;
}

function isRecommendationAllocations(value: unknown): value is ContainerDispositionRecommendation['allocations'] {
	if (!isRecord(value) || !exactKeys(value, ['reserved', 'held', 'freeQuantity']) ||
		!Array.isArray(value.reserved) || !Array.isArray(value.held) || !nonNegative(value.freeQuantity)) return false;
	const reserved: unknown[] = value.reserved;
	const held: unknown[] = value.held;
	if (!reserved.every((entry): entry is ReservedContainerAllocation => isRecord(entry) && exactKeys(entry, [
		'goalId', 'reason', 'intendedUse', 'quantity',
	]) && trimmed(entry.goalId, 256) && ['achievement', 'purchase', 'personal'].includes(String(entry.reason)) &&
		['hold', 'open', 'consume', 'exchange'].includes(String(entry.intendedUse)) && positive(entry.quantity))) return false;
	if (!held.every((entry): entry is HeldContainerAllocation => isRecord(entry) && exactKeys(entry, [
		'intentId', 'state', 'route', 'reason', 'quantity',
	]) && trimmed(entry.intentId, 256) && ['holding', 'price_unavailable'].includes(String(entry.state)) &&
		['instant_sell', 'listing'].includes(String(entry.route)) && isRecord(entry.reason) &&
		exactKeys(entry.reason, ['category', 'note']) &&
		['seasonal_rebound', 'market_target', 'personal'].includes(String(entry.reason.category)) &&
		trimmed(entry.reason.note, 1_024) && positive(entry.quantity))) return false;
	const quantities = [value.freeQuantity, ...reserved.map((entry) => entry.quantity),
		...held.map((entry) => entry.quantity)];
	return safeSum(quantities) !== null &&
		new Set(reserved.map((entry) => entry.goalId)).size === reserved.length &&
		new Set(held.map((entry) => entry.intentId)).size === held.length;
}

function isEconomicDecision(value: unknown, freeQuantity: number): value is NonNullable<ContainerDispositionRecommendation['economicDecision']> {
	return isRecord(value) && exactKeys(value, ['action', 'quantity', 'sellRoute']) &&
		(value.action === 'open' || value.action === 'sell') && positive(value.quantity) &&
		value.quantity === freeQuantity && (value.sellRoute === 'instant_sell' || value.sellRoute === 'vendor');
}

function isEconomicExplanation(
	value: unknown,
	decision: NonNullable<ContainerDispositionRecommendation['economicDecision']>,
): value is NonNullable<ContainerDispositionRecommendation['explanation']> {
	const quantity = decision.quantity;
	if (!isRecord(value) || !exactKeys(value, [
		'sellNow', 'open', 'threshold', 'comparison', 'freshness', 'caveats',
	]) || !isSellNow(value.sellNow, quantity) || !isRecord(value.open) || !exactKeys(value.open, [
		'evPerContainerMicroCopper', 'totalExpectedMicroCopper', 'coverage', 'modelId', 'modelVersion',
		'sampleContainers', 'excludedSampleUnits', 'rareTreatment',
	]) || !nonNegative(value.open.evPerContainerMicroCopper) || !decimal(value.open.totalExpectedMicroCopper) ||
		value.open.coverage !== 'complete' || !trimmed(value.open.modelId, 128) || !positive(value.open.modelVersion) ||
		!positive(value.open.sampleContainers) || !nonNegative(value.open.excludedSampleUnits) ||
		!['excluded', 'observed_only', 'bounded'].includes(String(value.open.rareTreatment)) ||
		BigInt(value.open.totalExpectedMicroCopper) !== BigInt(value.open.evPerContainerMicroCopper) * BigInt(quantity)) return false;
	if (!isRecord(value.threshold) || !exactKeys(value.threshold, ['marginBps', 'requiredOpenMicroCopper']) ||
		!integerRange(value.threshold.marginBps, 0, 10_000) || !decimal(value.threshold.requiredOpenMicroCopper) ||
		!isRecord(value.comparison) || !exactKeys(value.comparison, ['differenceMicroCopper', 'advantageBps', 'rule']) ||
		!signedDecimal(value.comparison.differenceMicroCopper) ||
		!(value.comparison.advantageBps === null || Number.isSafeInteger(value.comparison.advantageBps)) ||
		value.comparison.rule !== 'open_at_or_above_threshold' || !isRecord(value.freshness) ||
		!exactKeys(value.freshness, ['asOf', 'priceCapturedAt', 'priceAgeMs', 'modelReviewedAt', 'modelReviewAgeMs']) ||
		!iso(value.freshness.asOf) || !iso(value.freshness.priceCapturedAt) || !nonNegative(value.freshness.priceAgeMs) ||
		!iso(value.freshness.modelReviewedAt) || !nonNegative(value.freshness.modelReviewAgeMs) ||
		!Array.isArray(value.caveats) || !value.caveats.every((entry) => trimmed(entry, 256))) return false;
	const asOf = Date.parse(value.freshness.asOf);
	const priceCapturedAt = Date.parse(value.freshness.priceCapturedAt);
	const modelReviewedAt = Date.parse(value.freshness.modelReviewedAt);
	const openTotal = BigInt(value.open.totalExpectedMicroCopper);
	const sellMicro = BigInt(value.sellNow.netCopper) * MICRO_COPPER;
	const thresholdNumerator = sellMicro * (BASIS_POINTS + BigInt(value.threshold.marginBps));
	const requiredOpen = divideRoundUp(thresholdNumerator, BASIS_POINTS);
	const expectedDifference = openTotal - requiredOpen;
	const expectedAdvantage = sellMicro === 0n ? null
		: safeBigIntNumber((openTotal - sellMicro) * BASIS_POINTS / sellMicro);
	const expectedAction = openTotal * BASIS_POINTS >= thresholdNumerator ? 'open' : 'sell';
	if (value.threshold.requiredOpenMicroCopper !== requiredOpen.toString() ||
		value.comparison.differenceMicroCopper !== expectedDifference.toString() ||
		value.comparison.advantageBps !== expectedAdvantage || decision.action !== expectedAction ||
		value.freshness.priceAgeMs !== Math.max(0, asOf - priceCapturedAt) ||
		modelReviewedAt > asOf || value.freshness.modelReviewAgeMs !== asOf - modelReviewedAt) return false;
	const caveats = value.caveats;
	return caveats.every((entry, index) => index === 0 || caveats[index - 1]!.localeCompare(entry) < 0);
}

function isSellNow(
	value: unknown,
	quantity: number,
): value is NonNullable<ContainerDispositionRecommendation['explanation']>['sellNow'] {
	if (!isRecord(value) || !exactKeys(value, [
		'route', 'unitCopper', 'grossCopper', 'listingFeeCopper', 'exchangeFeeCopper', 'totalFeesCopper', 'netCopper',
	]) || !['instant_sell', 'vendor'].includes(String(value.route)) || !nonNegative(value.unitCopper) ||
		!nonNegative(value.grossCopper) || !nonNegative(value.listingFeeCopper) || !nonNegative(value.exchangeFeeCopper) ||
		!nonNegative(value.totalFeesCopper) || !nonNegative(value.netCopper)) return false;
	const gross = safeProduct(value.unitCopper, quantity);
	const fees = safeSum([value.listingFeeCopper, value.exchangeFeeCopper]);
	if (gross === null || fees === null || value.grossCopper !== gross || value.totalFeesCopper !== fees ||
		value.netCopper !== gross - fees) return false;
	if (value.route === 'vendor') return fees === 0;
	const expected = createTradingPostValueWithPolicy('instant_sell', value.unitCopper, quantity);
	return expected.status === 'ok' && expected.value.grossCopper === value.grossCopper &&
		expected.value.listingFeeCopper === value.listingFeeCopper &&
		expected.value.exchangeFeeCopper === value.exchangeFeeCopper &&
		expected.value.totalFeesCopper === value.totalFeesCopper && expected.value.netCopper === value.netCopper;
}

const RECOMMENDATION_REASON_CODES = new Set<ContainerRecommendationReasonCode>([
	'session_classification_v1', 'session_estimated', 'session_contaminated', 'session_invalid',
	'session_not_recommendable', 'reservation_unknown', 'reservation_mismatch', 'hold_intent_active',
	'hold_price_unavailable', 'model_unreviewed', 'model_revoked', 'model_review_stale', 'model_review_future',
	'model_review_mismatch', 'price_stale', 'price_future', 'price_missing', 'open_ev_partial',
	'container_not_sellable', 'binding_unknown', 'trading_access_unknown', 'malformed_input',
	'evidence_mismatch', 'arithmetic_overflow', 'model_ev_inconsistent',
]);

function isRecommendationReasons(value: unknown): value is ContainerRecommendationReason[] {
	return Array.isArray(value) && value.every((reason, index) => isRecord(reason) && exactKeys(reason, ['code']) &&
		RECOMMENDATION_REASON_CODES.has(reason.code as ContainerRecommendationReasonCode) &&
		(index === 0 || String((value[index - 1] as ContainerRecommendationReason).code).localeCompare(String(reason.code)) < 0));
}

function isInputShell(value: unknown): value is ContainerRecommendationInput {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'asOf', 'session', 'container', 'reservation', 'hold', 'model', 'modelReview', 'market', 'policy',
	]) || value.version !== 1 || !iso(value.asOf) || !isSessionShell(value.session) ||
		!isContainerShell(value.container) || !isReservationShell(value.reservation) || !isHoldShell(value.hold) ||
		!isContainerModel(value.model) || !isModelReview(value.modelReview) ||
		!isMarket(value.market) || !isPolicy(value.policy)) return false;
	return true;
}

function isHoldShell(value: unknown): value is ContainerRecommendationInput['hold'] {
	return isRecord(value) && exactKeys(value, ['intents', 'plan']) && Array.isArray(value.intents) &&
		value.intents.every(isHoldIntent) && isHoldPlan(value.plan);
}

function isSessionShell(value: unknown): value is ContainerRecommendationInput['session'] {
	return isRecord(value) && exactKeys(value, ['sessionId', 'beforeSnapshot', 'afterSnapshot', 'delta', 'review']) &&
		trimmed(value.sessionId, 256) && isRecord(value.beforeSnapshot) && isRecord(value.afterSnapshot) &&
		isRecord(value.delta) && isRecord(value.review);
}

function isContainerShell(value: unknown): value is ContainerRecommendationInput['container'] {
	return isRecord(value) && exactKeys(value, ['itemId', 'catalogItem', 'binding', 'tradingAccess']) &&
		positive(value.itemId) && isNormalizedCatalogItem(value.catalogItem) &&
		['unbound', 'account_bound', 'character_bound', 'unknown'].includes(String(value.binding)) &&
		['full', 'free_to_play', 'unknown'].includes(String(value.tradingAccess));
}

function isReservationShell(value: unknown): value is ContainerRecommendationInput['reservation'] {
	if (!isRecord(value) || !exactKeys(value, ['goals', 'overlay', 'plan', 'sackItemIds']) ||
		!Array.isArray(value.goals) || !value.goals.every(isReservationGoal) || !Array.isArray(value.sackItemIds)) return false;
	const ids = value.sackItemIds as unknown[];
	return ids.every((id, index) => positive(id) && (index === 0 || (ids[index - 1] as number) < id));
}

function isModelReview(value: unknown): value is ContainerModelReview {
	return isRecord(value) && exactKeys(value, [
		'version', 'modelId', 'modelVersion', 'modelFingerprint', 'status', 'reviewedAt', 'validUntil', 'reviewReason',
	]) && value.version === 1 && trimmed(value.modelId, 128) && positive(value.modelVersion) &&
		isSha256(value.modelFingerprint) &&
		(value.status === 'approved' || value.status === 'revoked') && iso(value.reviewedAt) &&
		iso(value.validUntil) && trimmed(value.reviewReason, 1_024);
}

function isMarket(value: unknown): value is ContainerMarketBatch {
	if (!isRecord(value) || !exactKeys(value, ['version', 'batchId', 'capturedAt', 'source', 'quotes']) ||
		value.version !== 1 || !trimmed(value.batchId, 256) || !iso(value.capturedAt) ||
		value.source !== 'gw2-commerce-prices' || !Array.isArray(value.quotes) ||
		!value.quotes.every(isQuote)) return false;
	return new Set(value.quotes.map((quote) => quote.itemId)).size === value.quotes.length;
}

function isQuote(value: unknown): value is ContainerMarketQuote {
	return isRecord(value) && exactKeys(value, ['itemId', 'whitelisted', 'bidUnitCopper', 'askUnitCopper']) &&
		positive(value.itemId) && typeof value.whitelisted === 'boolean' &&
		(value.bidUnitCopper === null || positive(value.bidUnitCopper)) &&
		(value.askUnitCopper === null || positive(value.askUnitCopper));
}

function isPolicy(value: unknown): value is ContainerRecommendationPolicy {
	return isRecord(value) && exactKeys(value, [
		'version', 'openAdvantageBps', 'maxPriceAgeMs', 'maxModelReviewAgeMs', 'maxFutureSkewMs', 'saleBasis',
	]) && value.version === 1 && nonNegative(value.openAdvantageBps) && value.openAdvantageBps <= 10_000 &&
		integerRange(value.maxPriceAgeMs, 60_000, DAY_MS) &&
		integerRange(value.maxModelReviewAgeMs, 1, 366 * DAY_MS) &&
		integerRange(value.maxFutureSkewMs, 0, 15 * 60_000) && value.saleBasis === 'immediate';
}

/** Stable SHA-256 fingerprint of the complete validated H4.6 model payload. */
export function containerModelFingerprint(value: unknown): string | null {
	return isContainerModel(value) ? sha256CanonicalValue(value) : null;
}

function isSha256(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (isRecord(value)) return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}

function invalid(reason: ContainerRecommendationReasonCode): ContainerRecommendationResult {
	return { status: 'invalid', reasons: canonicalReasons([{ code: reason }]), recommendation: null,
		envelope: emptyRecommendationEnvelope() };
}

function blocked(reason: ContainerRecommendationReasonCode): ContainerRecommendationResult {
	return { status: 'blocked', reasons: canonicalReasons([{ code: reason }]), recommendation: null,
		envelope: emptyRecommendationEnvelope() };
}

function blockedWithReservation(
	input: ContainerRecommendationInput,
	reserved: ReservedContainerAllocation[],
	held: HeldContainerAllocation[],
	freeQuantity: number,
	reason: ContainerRecommendationReasonCode,
	holdReasons: ContainerRecommendationReason[],
): ContainerRecommendationResult {
	const reasons = canonicalReasons([{ code: reason }, ...holdReasons]);
	const recommendation = baseRecommendation(input, reserved, held, freeQuantity, null, null, reasons);
	return {
		status: 'blocked',
		reasons,
		recommendation,
		envelope: envelopeForRecommendation(recommendation, 'blocked'),
	};
}

function envelopeForRecommendation(
	recommendation: ContainerDispositionRecommendation,
	status: 'ready' | 'reserved_only' | 'blocked',
): RecommendationEnvelopeV1 {
	const decisions: RecommendationDecision[] = [
		...recommendation.allocations.reserved.map((_, index) => ({
			action: 'reserve' as const,
			itemId: recommendation.itemId,
			quantity: recommendation.allocations.reserved[index]!.quantity,
			explanationRef: `#/recommendation/allocations/reserved/${String(index)}`,
		})),
		...recommendation.allocations.held.map((allocation, index) => ({
			action: 'hold' as const,
			itemId: recommendation.itemId,
			quantity: allocation.quantity,
			route: allocation.route,
			explanationRef: `#/recommendation/allocations/held/${String(index)}`,
		})),
	];
	if (status === 'ready' && recommendation.economicDecision !== null) {
		decisions.push({
			action: recommendation.economicDecision.action,
			itemId: recommendation.itemId,
			quantity: recommendation.economicDecision.quantity,
			...(recommendation.economicDecision.action === 'sell'
				? { route: recommendation.economicDecision.sellRoute } : {}),
			explanationRef: '#/recommendation/explanation',
		});
	} else if (status === 'blocked' && recommendation.allocations.freeQuantity > 0) {
		decisions.push({
			action: 'review',
			itemId: recommendation.itemId,
			quantity: recommendation.allocations.freeQuantity,
			explanationRef: '#/recommendation/reasons',
		});
	}
	const envelope = createRecommendationEnvelope(decisions);
	if (envelope === null) throw new Error('Invalid recommendation envelope.');
	return envelope;
}

function emptyRecommendationEnvelope(): RecommendationEnvelopeV1 {
	const envelope = createRecommendationEnvelope([]);
	if (envelope === null) throw new Error('Invalid empty recommendation envelope.');
	return envelope;
}

function canonicalReasons(reasons: ContainerRecommendationReason[]): ContainerRecommendationReason[] {
	return [...new Map(reasons.map((reason) => [reason.code, reason])).values()]
		.sort((left, right) => left.code.localeCompare(right.code));
}

function divideRoundUp(numerator: bigint, divisor: bigint): bigint {
	return (numerator + divisor - 1n) / divisor;
}

function safeBigIntNumber(value: bigint): number | null {
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : null;
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function trimmed(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
}

function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function decimal(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d*)$/u.test(value);
}

function signedDecimal(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 65 && /^(?:0|-?[1-9]\d*)$/u.test(value);
}

function safeSum(values: number[]): number | null {
	const result = values.reduce((sum, value) => sum + value, 0);
	return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function safeProduct(left: number, right: number): number | null {
	const result = left * right;
	return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function integerRange(value: unknown, minimum: number, maximum: number): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
