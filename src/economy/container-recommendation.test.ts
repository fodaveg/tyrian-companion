import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { compareStorageSnapshots } from '../account/storage-delta';
import { afterSnapshot, looseHolding, storageDeltaSnapshot } from '../account/__fixtures__/storage-delta';
import { createSessionContaminationReview } from '../sessions/session-contamination-review';
import type { CatalogItem } from '../catalog/public-catalog-model';
import {
	DEFAULT_CONTAINER_RECOMMENDATION_POLICY,
	containerModelFingerprint,
	isContainerRecommendationResult,
	recommendContainerDisposition,
	type ContainerRecommendationInput,
} from './container-recommendation';
import { calculateContainerDispositionKernel } from './container-disposition-kernel';
import type { ContainerModelV1 } from './container-model';
import { evaluateHoldIntents, type HoldIntentV1 } from './hold-intent';
import { isRecommendationEnvelope } from './recommendation-envelope';
import { buildReservationBalance, createReservationPlan } from './reservation';
import type { ReservationGoal, ReservationPlan, SessionValuationReservationOverlay } from './reservation-model';
import type { SessionValuation } from './session-valuation';

const ITEM_ID = 999;
const AS_OF = '2026-08-13T10:00:00.000Z';

describe('recommendContainerDisposition', () => {
	it('fingerprints canonical model content with SHA-256', () => {
		const model = modelFor(100, false);
		const expected = createHash('sha256').update(canonicalForTest(model)).digest('hex');
		expect(containerModelFingerprint(model)).toBe(expected);
		expect(containerModelFingerprint({ ...model, title: 'Changed' })).not.toBe(expected);
	});
	it('opens exactly at the configured BigInt threshold and sells one microcopper below it', () => {
		const threshold = input({ modelEvMicro: 102_300_000 });
		expect(ready(threshold).economicDecision).toMatchObject({ action: 'open', quantity: 1 });
		expect(ready(threshold).explanation?.threshold.requiredOpenMicroCopper).toBe('102300000');
		expect(ready(input({ modelEvMicro: 102_299_999 })).economicDecision?.action).toBe('sell');
	});

	it.each([0, 800, 1_000, 10_000])('applies a %i bps policy without floating-point comparison', (margin) => {
		const value = input({ modelEvMicro: 93_000_000, marginBps: margin });
		const result = ready(value);
		const required = BigInt(result.explanation!.threshold.requiredOpenMicroCopper);
		const expected = (93_000_000n * BigInt(10_000 + margin) + 9_999n) / 10_000n;
		expect(required).toBe(expected);
		expect(result.economicDecision?.action).toBe(margin === 0 ? 'open' : 'sell');
	});

	it.each([1, 250])('recalculates the 5%% and 10%% fees over the free stack of %i', (quantity) => {
		const result = ready(input({ gainedQuantity: quantity, finalQuantity: quantity, modelEvMicro: 1 }));
		expect(result.explanation?.sellNow).toMatchObject({
			grossCopper: 110 * quantity,
		});
		const sell = result.explanation!.sellNow;
		expect(sell.netCopper).toBe(sell.grossCopper - sell.listingFeeCopper - sell.exchangeFeeCopper);
		expect(result.economicDecision).toMatchObject({ action: 'sell', quantity });
	});

	it('uses an eligible vendor value as the immediate floor', () => {
		const result = ready(input({ vendorValue: 200, modelEvMicro: 1 }));
		expect(result.economicDecision).toMatchObject({ action: 'sell', sellRoute: 'vendor' });
		expect(result.explanation?.sellNow).toMatchObject({ route: 'vendor', netCopper: 200, totalFeesCopper: 0 });
	});

	it.each([
		{ intendedUse: 'hold' as const, target: 6 },
		{ intendedUse: 'exchange' as const, target: 6 },
		{ intendedUse: 'open' as const, target: 6 },
	])('protects $intendedUse reservations before economics', ({ intendedUse, target }) => {
		const value = input({ gainedQuantity: 10, finalQuantity: 10, reservedTarget: target, intendedUse });
		const result = ready(value);
		expect(result.allocations.freeQuantity).toBe(4);
		expect(result.allocations.reserved).toEqual([{
			goalId: 'goal-a', reason: 'personal', intendedUse, quantity: 6,
		}]);
		expect(result.economicDecision?.quantity).toBe(4);
	});

	it('invalidates a malformed classification instead of treating it as an observed invalid session', () => {
		const value = input();
		value.session.review.classification = { version: 2, status: 'exact' } as never;
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }], recommendation: null,
		});
	});

	it('returns reserved_only before inspecting a legacy session or stale market', () => {
		const value = input({ gainedQuantity: 10, finalQuantity: 10, reservedTarget: 10 });
		value.session.review.classification = { ...value.session.review.classification, version: 1,
			permissions: { ...value.session.review.classification.permissions, recommend: false } } as never;
		value.market.capturedAt = '2020-01-01T00:00:00.000Z';
		const result = recommendContainerDisposition(value);
		expect(result.status).toBe('reserved_only');
		if (result.status === 'reserved_only') {
			expect(result.recommendation.economicDecision).toBeNull();
			expect(result.recommendation.allocations.freeQuantity).toBe(0);
		}
	});

	it('never lets fully reserved quantity bypass malformed H3.9 review evidence', () => {
		const value = input({ gainedQuantity: 10, finalQuantity: 10, reservedTarget: 10 });
		value.session.review = {} as never;
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }], recommendation: null,
		});
	});

	it('caps the session allocation by the gained quantity when older excess is unreserved', () => {
		const result = ready(input({ gainedQuantity: 30, finalQuantity: 120, reservedTarget: 100 }));
		expect(result.allocations).toMatchObject({ freeQuantity: 20, reserved: [{ quantity: 10 }] });
	});

	it('rejects a transplanted classification or overlay even when its standalone shell is valid', () => {
		const reviewTransplant = input();
		const donor = input({ reviewKind: 'estimated' }).session.review;
		reviewTransplant.session.review.classification = donor.classification;
		expect(recommendContainerDisposition(reviewTransplant)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }],
		});
		const overlayTransplant = input({ gainedQuantity: 2, finalQuantity: 2 });
		overlayTransplant.reservation.overlay = input().reservation.overlay;
		expect(recommendContainerDisposition(overlayTransplant)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }],
		});
	});

	it('validates identity before reserved_only can bypass inconsistent evidence', () => {
		const value = input({ gainedQuantity: 10, finalQuantity: 10, reservedTarget: 10 });
		value.session.delta.afterSnapshotId = 'transplanted';
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }], recommendation: null,
		});
	});

	it('rejects a valid-looking delta that was not recomputed from the supplied snapshots', () => {
		const value = input();
		value.session.afterSnapshot.holdings[1]!.quantity = 2;
		value.session.afterSnapshot.ownedByItem[String(ITEM_ID)] = 2;
		value.session.afterSnapshot.availableByItem[String(ITEM_ID)] = 2;
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }],
		});
	});

	it('blocks a structurally valid reservation that belongs to another snapshot', () => {
		const value = input();
		value.reservation.plan.snapshotId = 'other';
		expect(recommendContainerDisposition(value)).toMatchObject({ status: 'invalid', reasons: [{ code: 'evidence_mismatch' }] });
	});

	it('rejects a plan not reproduced from the supplied goals and final snapshot balance', () => {
		const changedGoal = input({ reservedTarget: 1 });
		changedGoal.reservation.goals[0]!.requirements[0]!.targetQuantity = 2;
		expect(recommendContainerDisposition(changedGoal)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }],
		});
		const changedCapture = input();
		changedCapture.reservation.plan.capturedAt = '2026-08-13T09:00:02.000Z';
		expect(recommendContainerDisposition(changedCapture)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }],
		});
	});

	it.each([
		['legacy' as const, 'session_classification_v1'],
		['estimated' as const, 'session_estimated'],
		['contaminated' as const, 'session_contaminated'],
	] as const)('blocks an authentic %s review', (reviewKind, reason) => {
		const value = input({ reviewKind });
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'blocked', reasons: [{ code: reason }],
			recommendation: { economicDecision: null, allocations: { freeQuantity: 1 } },
		});
	});

	it('binds approval to canonical model content and rejects impossible review chronology', () => {
		const mutated = input();
		mutated.model.title = 'Same version, different model';
		expect(recommendContainerDisposition(mutated)).toMatchObject({
			status: 'blocked', reasons: [{ code: 'model_review_mismatch' }],
		});
		const chronology = input();
		chronology.model.source.retrievedAt = '2026-08-13T09:00:00.000Z';
		chronology.modelReview.modelFingerprint = containerModelFingerprint(chronology.model)!;
		chronology.modelReview.reviewedAt = '2026-08-13T08:59:59.999Z';
		expect(recommendContainerDisposition(chronology)).toMatchObject({
			status: 'blocked', reasons: [{ code: 'model_review_future' }],
		});
	});

	it('requires final snapshot completion no later than review and review no later than asOf', () => {
		const tooLate = input();
		tooLate.asOf = '2026-08-13T09:00:01.500Z';
		expect(recommendContainerDisposition(tooLate)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }],
		});
		const beforeFinal = input();
		beforeFinal.session.review.reviewedAt = '2026-08-13T09:00:00.999Z';
		expect(recommendContainerDisposition(beforeFinal)).toMatchObject({ status: 'invalid' });
	});

	it('invalidates account, snapshot, session, catalog and model identity mismatches', () => {
		for (const mutate of [
			(value: ContainerRecommendationInput) => { value.session.afterSnapshot.accountId = 'other'; },
			(value: ContainerRecommendationInput) => { value.session.afterSnapshot.snapshotId = 'other'; },
			(value: ContainerRecommendationInput) => { value.session.sessionId = 'other'; },
			(value: ContainerRecommendationInput) => { value.container.catalogItem.id = 1; },
			(value: ContainerRecommendationInput) => { value.model.containerItemId = 1; },
		]) {
			const value = input();
			mutate(value);
			expect(recommendContainerDisposition(value)).toMatchObject({ status: 'invalid' });
		}
	});

	it.each([
		[(value: ContainerRecommendationInput) => { value.modelReview.status = 'revoked'; }, 'model_revoked'],
		[(value: ContainerRecommendationInput) => { value.modelReview.modelVersion += 1; }, 'model_review_mismatch'],
		[(value: ContainerRecommendationInput) => { value.modelReview.reviewedAt = '2026-08-13T10:00:01.000Z'; }, 'model_review_future'],
		[(value: ContainerRecommendationInput) => { value.modelReview.validUntil = '2026-08-13T09:59:59.999Z'; }, 'model_review_stale'],
	] as const)('blocks invalid review attestation %#', (mutate, reason) => {
		const value = input();
		mutate(value);
		expect(recommendContainerDisposition(value)).toMatchObject({ status: 'blocked', reasons: [{ code: reason }] });
	});

	it('accepts the price TTL boundary and blocks one millisecond later or beyond future skew', () => {
		const boundary = input();
		boundary.market.capturedAt = new Date(Date.parse(AS_OF) - boundary.policy.maxPriceAgeMs).toISOString();
		expect(recommendContainerDisposition(boundary).status).toBe('ready');
		const stale = structuredClone(boundary);
		stale.market.capturedAt = new Date(Date.parse(stale.market.capturedAt) - 1).toISOString();
		expect(recommendContainerDisposition(stale)).toMatchObject({ status: 'blocked', reasons: [{ code: 'price_stale' }] });
		const future = input();
		future.market.capturedAt = new Date(Date.parse(AS_OF) + future.policy.maxFutureSkewMs + 1).toISOString();
		expect(recommendContainerDisposition(future)).toMatchObject({ status: 'blocked', reasons: [{ code: 'price_future' }] });
	});

	it.each([
		['price_stale' as const, (value: ContainerRecommendationInput) =>
			new Date(Date.parse(AS_OF) - value.policy.maxPriceAgeMs - 1).toISOString()],
		['price_future' as const, (value: ContainerRecommendationInput) =>
			new Date(Date.parse(AS_OF) + value.policy.maxFutureSkewMs + 1).toISOString()],
	])('blocks %s market evidence before a hold can consume all free quantity', (reason, capturedAt) => {
		const value = withHold(input({ gainedQuantity: 5, finalQuantity: 5 }), [holdIntent({ quantity: 5 })]);
		value.market.capturedAt = capturedAt(value);
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'blocked',
			reasons: [{ code: reason }],
			recommendation: { allocations: { held: [], freeQuantity: 5 }, economicDecision: null },
		});
	});

	it.each([
		(value: ContainerRecommendationInput) =>
			new Date(Date.parse(AS_OF) - value.policy.maxPriceAgeMs).toISOString(),
		(value: ContainerRecommendationInput) =>
			new Date(Date.parse(AS_OF) + value.policy.maxFutureSkewMs).toISOString(),
	])('allows a fully consuming hold at an exact market freshness boundary %#', (capturedAt) => {
		const value = withHold(input({ gainedQuantity: 5, finalQuantity: 5 }), [holdIntent({ quantity: 5 })]);
		value.market.capturedAt = capturedAt(value);
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'reserved_only',
			recommendation: { allocations: { held: [{ quantity: 5 }], freeQuantity: 0 } },
		});
	});

	it('rejects duplicate quotes from the supposedly atomic market batch', () => {
		const value = input();
		value.market.quotes.push({ ...value.market.quotes[0]! });
		expect(recommendContainerDisposition(value)).toMatchObject({ status: 'invalid', reasons: [{ code: 'malformed_input' }] });
	});

	it('blocks incomplete instant EV while allowing an incomplete informational listing route', () => {
		const value = input({ marketOutcome: true });
		value.market.quotes.find((quote) => quote.itemId === 1)!.bidUnitCopper = null;
		expect(recommendContainerDisposition(value)).toMatchObject({ status: 'blocked', reasons: [{ code: 'open_ev_partial' }] });
		const listingOnlyMissing = input({ marketOutcome: true });
		listingOnlyMissing.market.quotes.find((quote) => quote.itemId === 1)!.askUnitCopper = null;
		const readyWithCaveat = ready(listingOnlyMissing);
		expect(readyWithCaveat.explanation?.caveats).toContain('listing_route_partial');
	});

	it('degrades explicitly when order-book depth is missing, partial or exhausted', () => {
		const missing = input({ marketOutcome: true });
		missing.market.depth = null;
		expect(recommendContainerDisposition(missing)).toMatchObject({
			status: 'blocked', reasons: [{ code: 'market_depth_missing' }],
		});
		const partial = input({ marketOutcome: true });
		partial.market.depth!.items.find((entry) => entry.itemId === 1)!.coverage = 'unavailable';
		partial.market.depth!.items.find((entry) => entry.itemId === 1)!.buys = [];
		partial.market.depth!.items.find((entry) => entry.itemId === 1)!.sells = [];
		partial.market.depth!.status = 'partial';
		expect(recommendContainerDisposition(partial)).toMatchObject({
			status: 'blocked', reasons: [{ code: 'market_depth_partial' }],
		});
		const exhausted = input({ marketOutcome: true, gainedQuantity: 5, finalQuantity: 5 });
		exhausted.market.depth!.items.find((entry) => entry.itemId === 1)!.buys[0]!.quantity = 4;
		expect(recommendContainerDisposition(exhausted)).toMatchObject({
			status: 'blocked', reasons: [{ code: 'market_depth_partial' }],
		});
	});

	it('keeps the extracted kernel equivalent to the H4.10 economic result', () => {
		const value = input({ marketOutcome: true, gainedQuantity: 3, finalQuantity: 3 });
		value.market.quotes.find((quote) => quote.itemId === 1)!.askUnitCopper = null;
		const recommendation = ready(value);
		const kernel = calculateContainerDispositionKernel({
			version: 1,
			asOf: value.asOf,
			quantity: recommendation.allocations.freeQuantity,
			container: value.container,
			model: value.model,
			market: value.market,
			policy: {
				version: value.policy.version,
				openAdvantageBps: value.policy.openAdvantageBps,
				maxPriceAgeMs: value.policy.maxPriceAgeMs,
				maxFutureSkewMs: value.policy.maxFutureSkewMs,
				saleBasis: value.policy.saleBasis,
			},
		});
		expect(kernel.status).toBe('ready');
		if (kernel.status !== 'ready' || recommendation.explanation === null) return;
		expect(recommendation.economicDecision).toEqual(kernel.decision);
		const { modelReviewedAt: _reviewedAt, modelReviewAgeMs: _reviewAge, ...kernelFreshness } =
			recommendation.explanation.freshness;
		expect({ ...recommendation.explanation, freshness: kernelFreshness }).toEqual(kernel.explanation);
	});

	it.each([
		['full', false, 'ready'],
		['free_to_play', false, 'blocked'],
		['unknown', false, 'blocked'],
		['free_to_play', true, 'ready'],
		['unknown', true, 'ready'],
	] as const)('applies %s access to whitelisted=%s', (access, whitelisted, status) => {
		const value = input({ vendorValue: 0 });
		value.container.tradingAccess = access;
		value.market.quotes.find((quote) => quote.itemId === ITEM_ID)!.whitelisted = whitelisted;
		expect(recommendContainerDisposition(value).status).toBe(status);
	});

	it('blocks unknown binding and a container with no realizable sale route', () => {
		const unknown = input();
		unknown.container.binding = 'unknown';
		expect(recommendContainerDisposition(unknown)).toMatchObject({ status: 'blocked', reasons: [{ code: 'binding_unknown' }] });
		const closed = input({ vendorValue: 0 });
		closed.container.binding = 'account_bound';
		expect(recommendContainerDisposition(closed)).toMatchObject({ status: 'blocked', reasons: [{ code: 'container_not_sellable' }] });
	});

	it('retains reservation provenance without any economic action when later evidence blocks', () => {
		const value = input({ gainedQuantity: 10, finalQuantity: 10, reservedTarget: 6 });
		value.session.review.classification = { ...value.session.review.classification, version: 1,
			permissions: { ...value.session.review.classification.permissions, recommend: false } } as never;
		const result = recommendContainerDisposition(value);
		expect(result).toMatchObject({
			status: 'blocked',
			recommendation: {
				economicDecision: null,
				allocations: { freeQuantity: 4, reserved: [{ goalId: 'goal-a', quantity: 6 }] },
				reasons: [{ code: 'session_classification_v1' }],
			},
		});
	});

	it('subtracts active holds after reservations and preserves user provenance', () => {
		const value = withHold(input({ gainedQuantity: 10, finalQuantity: 10, reservedTarget: 2 }), [
			holdIntent({ quantity: 4 }),
		]);
		const result = ready(value);
		expect(result.allocations).toEqual({
			reserved: [{ goalId: 'goal-a', reason: 'personal', intendedUse: 'hold', quantity: 2 }],
			held: [{
				intentId: 'intent-a', state: 'holding',
				route: 'instant_sell',
				reason: { category: 'market_target', note: 'Wait for the target.' }, quantity: 4,
			}],
			freeQuantity: 4,
		});
		expect(result.economicDecision?.quantity).toBe(4);
		expect(result.reasons).toEqual([{ code: 'hold_intent_active' }]);
	});

	it('emits a manual envelope that partitions reserved, held and economic quantities', () => {
		const value = withHold(input({ gainedQuantity: 10, finalQuantity: 10, reservedTarget: 2 }), [
			holdIntent({ quantity: 4 }),
		]);
		const result = recommendContainerDisposition(value);
		expect(result.status).toBe('ready');
		expect(result.envelope).toEqual({
			version: 1,
			kind: 'recommendation',
			execution: 'manual_in_game',
			sideEffects: 'none',
			requiresUserAction: true,
			decisions: [
				{ action: 'reserve', itemId: ITEM_ID, quantity: 2,
					explanationRef: '#/recommendation/allocations/reserved/0' },
				{ action: 'hold', itemId: ITEM_ID, quantity: 4, route: 'instant_sell',
					explanationRef: '#/recommendation/allocations/held/0' },
				{ action: 'sell', itemId: ITEM_ID, quantity: 4, route: 'instant_sell',
					explanationRef: '#/recommendation/explanation' },
			],
		});
		expect(isRecommendationEnvelope(result.envelope)).toBe(true);
		expect(result.envelope.decisions.reduce((sum, decision) => sum + decision.quantity, 0)).toBe(10);
	});

	it('validates the complete result graph and its envelope relations', () => {
		const result = recommendContainerDisposition(input());
		const outputs = [
			result,
			recommendContainerDisposition(input({ gainedQuantity: 5, finalQuantity: 5, reservedTarget: 5 })),
			recommendContainerDisposition(input({ reviewKind: 'estimated' })),
			recommendContainerDisposition(null),
		];
		expect(outputs.map((entry) => entry.status)).toEqual(['ready', 'reserved_only', 'blocked', 'invalid']);
		expect(outputs.every(isContainerRecommendationResult)).toBe(true);
		if (result.recommendation === null || result.recommendation.explanation === null) throw new Error('Expected ready fixture.');
		const mutations: Array<(candidate: typeof result) => void> = [
			(candidate) => { candidate.recommendation!.explanation!.sellNow.netCopper += 1; },
			(candidate) => { candidate.recommendation!.explanation!.threshold.requiredOpenMicroCopper = '1'; },
			(candidate) => { candidate.recommendation!.explanation!.comparison.differenceMicroCopper = '1'; },
			(candidate) => { candidate.recommendation!.explanation!.comparison.advantageBps = null; },
			(candidate) => { candidate.recommendation!.economicDecision!.action =
				candidate.recommendation!.economicDecision!.action === 'open' ? 'sell' : 'open'; },
			(candidate) => { candidate.recommendation!.explanation!.freshness.priceAgeMs += 1; },
			(candidate) => { candidate.recommendation!.explanation!.freshness.modelReviewAgeMs += 1; },
			(candidate) => { candidate.recommendation!.explanation!.freshness.priceCapturedAt =
				new Date(Date.parse(candidate.recommendation!.explanation!.freshness.priceCapturedAt) - 1).toISOString(); },
			(candidate) => { candidate.recommendation!.explanation!.threshold.requiredOpenMicroCopper = '01'; },
			(candidate) => { candidate.recommendation!.explanation!.open.totalExpectedMicroCopper = '9'.repeat(65); },
		];
		for (const mutate of mutations) {
			const candidate = structuredClone(result);
			mutate(candidate);
			expect(isContainerRecommendationResult(candidate)).toBe(false);
		}
		const reason = structuredClone(result) as unknown as { recommendation: { reasons: unknown[] } };
		reason.recommendation.reasons.push({ code: 'invented_reason' });
		expect(isContainerRecommendationResult(reason)).toBe(false);
		const envelope = structuredClone(result);
		envelope.envelope.decisions = [];
		expect(isContainerRecommendationResult(envelope)).toBe(false);
	});

	it('never adds an economic decision for fully reserved or held quantities', () => {
		const reserved = recommendContainerDisposition(input({ gainedQuantity: 5, finalQuantity: 5, reservedTarget: 5 }));
		expect(reserved.status).toBe('reserved_only');
		expect(reserved.envelope.decisions).toEqual([{
			action: 'reserve', itemId: ITEM_ID, quantity: 5,
			explanationRef: '#/recommendation/allocations/reserved/0',
		}]);
		const held = recommendContainerDisposition(withHold(
			input({ gainedQuantity: 5, finalQuantity: 5 }), [holdIntent({ quantity: 5 })],
		));
		expect(held.status).toBe('reserved_only');
		expect(held.envelope.decisions).toEqual([{
			action: 'hold', itemId: ITEM_ID, quantity: 5, route: 'instant_sell',
			explanationRef: '#/recommendation/allocations/held/0',
		}]);
	});

	it('keeps blocked and invalid results as data-only manual envelopes', () => {
		const blockedResult = recommendContainerDisposition(input({ reviewKind: 'estimated' }));
		expect(blockedResult).toMatchObject({
			status: 'blocked',
			envelope: { execution: 'manual_in_game', sideEffects: 'none', decisions: [{
				action: 'review', itemId: ITEM_ID, quantity: 1, explanationRef: '#/recommendation/reasons',
			}] },
		});
		const invalidResult = recommendContainerDisposition(null);
		expect(invalidResult).toMatchObject({
			status: 'invalid', recommendation: null,
			envelope: { execution: 'manual_in_game', sideEffects: 'none', decisions: [] },
		});
		for (const result of [blockedResult, invalidResult]) {
			expect(isRecommendationEnvelope(result.envelope)).toBe(true);
			expect(JSON.parse(JSON.stringify(result.envelope))).toEqual(result.envelope);
		}
	});

	it('does not mutate deeply frozen evidence or perform network I/O while producing an envelope', () => {
		const value = deepFreeze(input());
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		try {
			const result = recommendContainerDisposition(value);
			expect(result.status).toBe('ready');
			expect(isRecommendationEnvelope(result.envelope)).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('protects unavailable-price holds but releases target-reached, expired and cancelled intents', () => {
		const unavailable = input({ gainedQuantity: 5, finalQuantity: 5 });
		unavailable.market.quotes[0]!.askUnitCopper = null;
		withHold(unavailable, [holdIntent({ quantity: 5, target: { route: 'listing', unitGrossCopper: 200 } })]);
		const protectedResult = recommendContainerDisposition(unavailable);
		expect(protectedResult).toMatchObject({
			status: 'reserved_only',
			recommendation: {
				allocations: { held: [{ state: 'price_unavailable', quantity: 5 }], freeQuantity: 0 },
				economicDecision: null,
				reasons: [{ code: 'hold_price_unavailable' }],
			},
		});

		for (const intent of [
			holdIntent({ target: { route: 'instant_sell', unitGrossCopper: 100 } }),
			holdIntent({ deadlineAt: AS_OF }),
			holdIntent({ status: 'cancelled' }),
		]) {
			const result = ready(withHold(input({ gainedQuantity: 5, finalQuantity: 5 }), [intent]));
			expect(result.allocations).toMatchObject({ held: [], freeQuantity: 5 });
			expect(result.economicDecision?.quantity).toBe(5);
		}
	});

	it('rejects a transplanted or malformed hold plan even when all quantity would be protected', () => {
		const target = withHold(input({ gainedQuantity: 5, finalQuantity: 5 }), [holdIntent({ quantity: 5 })]);
		target.hold.plan = withHold(input({ gainedQuantity: 4, finalQuantity: 4 }), [holdIntent({ quantity: 4 })]).hold.plan;
		expect(recommendContainerDisposition(target)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }], recommendation: null,
		});
		const malformed = withHold(input({ gainedQuantity: 5, finalQuantity: 5 }), [holdIntent({ quantity: 5 })]);
		malformed.hold.plan = {} as never;
		expect(recommendContainerDisposition(malformed)).toMatchObject({ status: 'invalid', recommendation: null });
	});

	it('rejects catalog binding flags that contradict explicit unbound evidence', () => {
		const value = input();
		value.container.catalogItem.flags = ['AccountBound'];
		expect(recommendContainerDisposition(value)).toMatchObject({
			status: 'invalid', reasons: [{ code: 'evidence_mismatch' }], recommendation: null,
		});
	});

	it('keeps excluded rare outcomes visible in the numeric explanation', () => {
		const value = input();
		value.model.sample.observations += 1;
		value.model.excluded = [{ category: 'Rare', sampleUnits: 1, reason: 'super_rare_jackpot', items: [] }];
		value.model.uncertainty.rareDropTreatment = 'excluded';
		value.modelReview.modelFingerprint = containerModelFingerprint(value.model)!;
		const result = ready(value);
		expect(result.explanation?.open).toMatchObject({ excludedSampleUnits: 1, rareTreatment: 'excluded' });
		expect(result.explanation?.caveats).toContain('excluded_outcomes_not_valued');
	});

	it('does not let an excluded jackpot change EV or the resulting decision', () => {
		const baseline = ready(input({ modelEvMicro: 102_300_000 }));
		const withJackpot = input({ modelEvMicro: 102_300_000 });
		withJackpot.model.sample.observations += 50;
		withJackpot.model.excluded = [{
			category: 'Unpriced jackpot', sampleUnits: 50, reason: 'super_rare_jackpot', items: [],
		}];
		withJackpot.model.uncertainty.rareDropTreatment = 'excluded';
		withJackpot.modelReview.modelFingerprint = containerModelFingerprint(withJackpot.model)!;

		const result = ready(withJackpot);

		expect(result.explanation?.open.evPerContainerMicroCopper)
			.toBe(baseline.explanation?.open.evPerContainerMicroCopper);
		expect(result.economicDecision).toEqual(baseline.economicDecision);
	});

	it('fails closed on malformed input and arithmetic overflow', () => {
		expect(recommendContainerDisposition(null)).toMatchObject({ status: 'invalid' });
		const overflow = input({ gainedQuantity: 2, finalQuantity: 2, vendorValue: 0 });
		overflow.market.quotes.find((quote) => quote.itemId === ITEM_ID)!.bidUnitCopper = Number.MAX_SAFE_INTEGER;
		overflow.market.depth!.items.find((entry) => entry.itemId === ITEM_ID)!.buys[0]!.unitCopper = Number.MAX_SAFE_INTEGER;
		expect(recommendContainerDisposition(overflow)).toMatchObject({ status: 'invalid', reasons: [{ code: 'arithmetic_overflow' }] });
	});

	it('is invariant to quote order and does not mutate evidence', () => {
		const value = input({ marketOutcome: true });
		const before = structuredClone(value);
		const forward = recommendContainerDisposition(value);
		const reversed = structuredClone(value);
		reversed.market.quotes.reverse();
		expect(recommendContainerDisposition(reversed)).toEqual(forward);
		expect(value).toEqual(before);
	});
});

function input(options: {
	gainedQuantity?: number;
	finalQuantity?: number;
	reservedTarget?: number;
	intendedUse?: 'hold' | 'open' | 'consume' | 'exchange';
	modelEvMicro?: number;
	marginBps?: number;
	vendorValue?: number;
	marketOutcome?: boolean;
	reviewKind?: 'exact' | 'legacy' | 'estimated' | 'contaminated';
} = {}): ContainerRecommendationInput {
	const gainedQuantity = options.gainedQuantity ?? 1;
	const finalQuantity = options.finalQuantity ?? gainedQuantity;
	const goals = goalsFor(options.reservedTarget ?? 0, options.intendedUse ?? 'hold');
	const beforeQuantity = finalQuantity - gainedQuantity;
	const beforeSnapshot = storageDeltaSnapshot({ holdings: [
		looseHolding(100, 2, { source: 'bank', slot: 0 }),
		...(beforeQuantity > 0 ? [looseHolding(ITEM_ID, beforeQuantity, { source: 'bank', slot: 1 })] : []),
	] });
	const after = afterSnapshot({ holdings: [
		looseHolding(100, 2, { source: 'bank', slot: 0 }),
		looseHolding(ITEM_ID, finalQuantity, { source: 'bank', slot: 1 }),
	] });
	const delta = compareStorageSnapshots(beforeSnapshot, after);
	if (delta.status === 'invalid') throw new Error('Invalid delta fixture.');
	const plan = planFor(after, goals);
	const overlay = overlayFor(plan, gainedQuantity);
	const model = modelFor(options.modelEvMicro ?? 1, options.marketOutcome ?? false);
	const activities = {
			open: false, salvage: false, consume: false, craft: false, tpBuy: false, tpSell: false,
			vendorBuy: false, vendorSell: false, transfer: false, other: false,
	};
	if (options.reviewKind === 'contaminated') activities.open = true;
	const review = createSessionContaminationReview(beforeSnapshot, after, delta, {
		certainty: options.reviewKind === 'estimated' ? 'unsure' : 'confirmed', activities,
	}, '2026-08-13T09:00:02.000Z');
	if (!review) throw new Error('Invalid review fixture.');
	if (options.reviewKind === 'legacy') review.classification = {
		...review.classification, version: 1,
		permissions: { ...review.classification.permissions, recommend: false },
	} as never;
	const market = {
		version: 1 as const, batchId: 'batch-1', capturedAt: AS_OF, source: 'gw2-commerce-prices' as const,
		quotes: [
			{ itemId: ITEM_ID, whitelisted: true, bidUnitCopper: 110, askUnitCopper: 120 },
			...(options.marketOutcome ? [{ itemId: 1, whitelisted: true, bidUnitCopper: 110, askUnitCopper: 120 }] : []),
		],
		depth: {
			version: 1 as const,
			capturedAt: AS_OF,
			source: 'gw2-commerce-listings' as const,
			requestedItemIds: [
				...(options.marketOutcome ? [1] : []), ITEM_ID,
			].sort((left, right) => left - right),
			status: 'complete' as const,
			items: [
				...(options.marketOutcome ? [{
					itemId: 1, coverage: 'complete' as const,
					buys: [{ unitCopper: 110, quantity: 1_000 }],
					sells: [{ unitCopper: 120, quantity: 1_000 }],
				}] : []),
				{
					itemId: ITEM_ID, coverage: 'complete' as const,
					buys: [{ unitCopper: 110, quantity: 1_000 }],
					sells: [{ unitCopper: 120, quantity: 1_000 }],
				},
			].sort((left, right) => left.itemId - right.itemId),
		},
	};
	const hold = evaluateHoldIntents({
		version: 1,
		asOf: AS_OF,
		accountId: after.accountId,
		snapshotId: after.snapshotId,
		sessionId: 'session-1',
		freeQuantityByItem: { [String(ITEM_ID)]: Math.min(
			gainedQuantity,
			overlay.lines[0]!.liquidationEligible ?? 0,
			overlay.lines[0]!.openEligible ?? 0,
		) },
		intents: [],
		market: holdMarket(market),
	});
	if (hold.status !== 'ok') throw new Error('Invalid hold fixture.');
	return {
		version: 1,
		asOf: AS_OF,
		session: {
			sessionId: 'session-1', beforeSnapshot, afterSnapshot: after, delta, review,
		},
		container: {
			itemId: ITEM_ID,
			catalogItem: item(options.vendorValue ?? 1),
			binding: 'unbound',
			tradingAccess: 'full',
		},
		reservation: { goals, overlay, plan, sackItemIds: [] },
		hold: { intents: [], plan: hold.plan },
		model,
		modelReview: {
			version: 1, modelId: model.modelId, modelVersion: model.modelVersion,
			modelFingerprint: containerModelFingerprint(model)!, status: 'approved',
			reviewedAt: '2026-08-12T10:00:00.000Z', validUntil: '2026-09-12T10:00:00.000Z',
			reviewReason: 'Reviewed sample and exclusions.',
		},
		market,
		policy: { ...DEFAULT_CONTAINER_RECOMMENDATION_POLICY, openAdvantageBps: options.marginBps ?? 1_000 },
	};
}

function withHold(value: ContainerRecommendationInput, intents: HoldIntentV1[]): ContainerRecommendationInput {
	const freeQuantityByItem = Object.fromEntries(value.reservation.overlay.lines.map((line) => [
		String(line.itemId),
		Math.min(line.gainedQuantity, line.liquidationEligible ?? 0, line.openEligible ?? 0),
	]));
	const result = evaluateHoldIntents({
		version: 1,
		asOf: value.asOf,
		accountId: value.session.afterSnapshot.accountId,
		snapshotId: value.session.afterSnapshot.snapshotId,
		sessionId: value.session.sessionId,
		freeQuantityByItem,
		intents,
		market: holdMarket(value.market),
	});
	if (result.status !== 'ok') throw new Error(`Invalid hold fixture: ${result.reason}`);
	value.hold = { intents, plan: result.plan };
	return value;
}

function holdMarket(market: ContainerRecommendationInput['market']) {
	return {
		version: market.version,
		batchId: market.batchId,
		capturedAt: market.capturedAt,
		source: market.source,
		quotes: market.quotes,
	};
}

function holdIntent(overrides: Partial<HoldIntentV1> = {}): HoldIntentV1 {
	return {
		version: 1,
		intentId: 'intent-a',
		accountId: 'account-anonymous',
		itemId: ITEM_ID,
		quantity: 2,
		target: { route: 'instant_sell', unitGrossCopper: 200 },
		reason: { category: 'market_target', note: 'Wait for the target.' },
		createdAt: '2026-08-13T09:00:00.000Z',
		deadlineAt: '2026-08-13T11:00:00.000Z',
		status: 'active',
		origin: 'user',
		...overrides,
	};
}

function modelFor(evMicro: number, marketOutcome: boolean): ContainerModelV1 {
	const sampleUnits = marketOutcome ? 1 : evMicro;
	const containersOpened = marketOutcome ? 1 : 1_000_000;
	return {
		schemaVersion: 1, modelId: 'test-container', modelVersion: 1, containerItemId: ITEM_ID,
		title: 'Test container',
		source: { name: 'Fixture', url: 'https://example.com/model', publishedAt: null, retrievedAt: '2026-08-11T10:00:00.000Z' },
		sample: { containersOpened, observations: sampleUnits, observedFrom: null, observedUntil: null },
		outcomes: marketOutcome
			? [{ key: 'item:1', namespace: 'item', id: 1, label: 'Market item', sampleUnits,
				expectedUnitsMillionths: 1_000_000, valuationPolicy: 'liquid_market' }]
			: [{ key: 'currency:1', namespace: 'currency', id: 1, label: 'Coin', sampleUnits,
				expectedUnitsMillionths: evMicro, valuationPolicy: 'direct_currency' }],
		excluded: [],
		uncertainty: { method: 'sample_only', confidenceBasisPoints: null, rareDropTreatment: 'observed_only', notes: [] },
		createdAt: '2026-08-11T10:00:00.000Z',
	};
}

function goalsFor(target: number, intendedUse: 'hold' | 'open' | 'consume' | 'exchange'): ReservationGoal[] {
	return target === 0 ? [] : [{
		schemaVersion: 1, goalId: 'goal-a', title: 'Goal A', status: 'active', priority: 10, reason: 'personal',
		requirements: [{ key: `item:${ITEM_ID}`, namespace: 'item', id: ITEM_ID, targetQuantity: target,
			creditedQuantity: 0, basis: 'available', intendedUse }],
	}];
}


function planFor(snapshot: ReturnType<typeof afterSnapshot>, goals: ReservationGoal[]): ReservationPlan {
	const derived = buildReservationBalance(snapshot);
	if (derived.status !== 'ok') throw new Error(derived.reason);
	const result = createReservationPlan({
		goals,
		balance: derived.balance,
	});
	if (result.status !== 'ok') throw new Error(result.reason);
	return result.plan;
}

function overlayFor(plan: ReservationPlan, gainedQuantity: number): SessionValuationReservationOverlay {
	const asset = plan.assets.find((entry) => entry.key === `item:${ITEM_ID}`)!;
	const liquidationEligible = Math.min(gainedQuantity, asset.allowances.liquidate!);
	const valuation = valuationFor(gainedQuantity);
	return {
		schemaVersion: 1, accountId: plan.accountId, snapshotId: plan.snapshotId, sackItemIds: [], valuation,
		lines: [{
			itemId: ITEM_ID, gainedQuantity,
			protectedFromLiquidation: gainedQuantity - liquidationEligible,
			liquidationEligible,
			openEligible: Math.min(gainedQuantity, asset.allowances.open!),
			consumeEligible: Math.min(gainedQuantity, asset.allowances.consume!),
			exchangeEligible: Math.min(gainedQuantity, asset.allowances.exchange!),
		}],
	};
}

function valuationFor(quantity: number): SessionValuation {
	const gross = quantity;
	return {
		version: 1, sessionId: 'session-1', priceCapturedAt: AS_OF, priceSource: 'gw2-commerce-prices',
		coverage: 'complete', durationMs: 3_599_000,
		lines: [{
			itemId: ITEM_ID, quantity, binding: 'unbound', instantSell: null,
			instantSellDepthCoverage: 'not_applicable', listing: null,
			vendor: { version: 1, kind: 'vendor', priceSource: 'vendor_value', liquidity: 'immediate',
				quantity, unitCopper: 1, grossCopper: gross, netCopper: gross },
			immediateBestCopper: gross, listingBestCopper: gross, nonLiquid: false, reason: null,
		}],
		totals: { itemImmediateCopper: gross, itemListingCopper: gross, coinNetCopper: 0,
			observedImmediateCopper: gross, observedListingCopper: gross,
			nonLiquidItemKinds: 0, nonLiquidQuantity: 0 },
		rates: { sacks: 0, sacksPerHourMilli: 0, immediateCopperPerHour: gross,
			listingCopperPerHour: gross },
		warnings: [],
	};
}

function item(vendorValue: number): CatalogItem {
	return {
		kind: 'item', id: ITEM_ID, name: 'Test container', type: 'Container', rarity: 'Basic', level: 0,
		vendorValue, flags: [], gameTypes: [], restrictions: [],
	};
}

function ready(value: ContainerRecommendationInput) {
	const result = recommendContainerDisposition(value);
	if (result.status !== 'ready') throw new Error(`Expected ready, got ${JSON.stringify(result)}.`);
	return result.recommendation;
}

function canonicalForTest(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
	if (typeof value === 'object' && value !== null) return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonicalForTest(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}
