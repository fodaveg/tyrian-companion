import type { StorageSnapshot } from './storage-snapshot-model';
import type { StorageDelta } from './storage-delta-model';
import {
	BOUNDARY_EVIDENCE_VERSION,
	SESSION_CLASSIFICATION_VERSION,
	type BoundaryCoverage,
	type BoundaryEvidence,
	type BoundaryEvidenceReason,
	type BoundaryItemEvidence,
	type BoundaryQuantityEvidence,
	type DeclaredActivity,
	type SessionClassificationContext,
	type SessionClassificationReason,
	type SessionDeltaClassification,
	type SessionReviewRequest,
	type TradingPostEvent,
} from './contamination-model';

const DECLARED_ACTIVITIES: ReadonlySet<DeclaredActivity> = new Set([
	'open',
	'salvage',
	'consume',
	'craft',
	'tp',
	'vendor',
	'transfer',
	'other',
]);

/** Projects only boundary-sensitive evidence without consulting the network or mutating snapshots. */
export function buildBoundaryEvidence(before: unknown, after: unknown): BoundaryEvidence {
	const reasons: BoundaryEvidenceReason[] = [];
	if (!isSnapshotBoundary(before)) reasons.push({ code: 'invalid_snapshot', snapshot: 'before' });
	if (!isSnapshotBoundary(after)) reasons.push({ code: 'invalid_snapshot', snapshot: 'after' });
	if (!isSnapshotBoundary(before) || !isSnapshotBoundary(after)) {
		return invalidBoundary(before, after, reasons);
	}

	if (before.accountId !== after.accountId) reasons.push({ code: 'account_mismatch', snapshot: 'both' });
	if (before.snapshotId === after.snapshotId) reasons.push({ code: 'snapshot_id_reused', snapshot: 'both' });
	if (!validInterval(before.startedAt, before.completedAt)) {
		reasons.push({ code: 'invalid_window', snapshot: 'before' });
	}
	if (!validInterval(after.startedAt, after.completedAt)) {
		reasons.push({ code: 'invalid_window', snapshot: 'after' });
	}
	if (
		validTimestamp(before.completedAt) &&
		validTimestamp(after.startedAt) &&
		Date.parse(before.completedAt) > Date.parse(after.startedAt)
	) {
		reasons.push({ code: 'overlapping_window', snapshot: 'both' });
	}
	if (reasons.length > 0) return invalidBoundary(before, after, reasons);

	try {
		const beforeDelivery = itemTotals(before, 'commerce_delivery');
		const afterDelivery = itemTotals(after, 'commerce_delivery');
		const beforeCoins = currencyTotal(before, 'delivery', 1);
		const afterCoins = currencyTotal(after, 'delivery', 1);
		const beforeWallet = currencyTotals(before, 'wallet');
		const afterWallet = currencyTotals(after, 'wallet');
		return {
			version: BOUNDARY_EVIDENCE_VERSION,
			status: 'valid',
			accountId: before.accountId,
			beforeSnapshotId: before.snapshotId,
			afterSnapshotId: after.snapshotId,
			window: { from: before.completedAt, to: after.startedAt },
			delivery: {
				coverage: coveragePair(
					before.coverage.sources.commerce_delivery.status,
					after.coverage.sources.commerce_delivery.status,
				),
				items: quantityEvidence(beforeDelivery, afterDelivery),
				coins: { id: 1 as const, ...evidence(beforeCoins, afterCoins) },
			},
			wallet: {
				coverage: coveragePair(
					before.coverage.sources.wallet.status,
					after.coverage.sources.wallet.status,
				),
				currencies: quantityEvidence(beforeWallet, afterWallet),
			},
			reasons: [],
		};
	} catch {
		return invalidBoundary(before, after, [{ code: 'invalid_snapshot', snapshot: 'both' }]);
	}
}

/** Classifies an observed net delta conservatively; evidence always dominates a clean declaration. */
export function classifySessionDelta(delta: unknown, context: unknown): SessionDeltaClassification {
	try {
		const invalidReasons: SessionClassificationReason[] = [];
		if (!isStorageDelta(delta)) invalidReasons.push({ code: 'delta_arithmetic_invalid' });
		if (!isClassificationContext(context)) {
			invalidReasons.push({ code: 'classification_context_invalid' });
		}
		if (!isStorageDelta(delta) || !isClassificationContext(context)) {
			return classification('invalid', 'low', invalidReasons, [{ code: 'repair_boundary_evidence' }]);
		}
		return classifyValidatedSessionDelta(delta, context);
	} catch {
		return classification(
			'invalid',
			'low',
			[{ code: 'classification_context_invalid' }],
			[{ code: 'repair_boundary_evidence' }],
		);
	}
}

function classifyValidatedSessionDelta(
	delta: StorageDelta,
	context: SessionClassificationContext,
): SessionDeltaClassification {
	const invalidReasons: SessionClassificationReason[] = [];
	if (delta.status === 'invalid') invalidReasons.push({ code: 'delta_invalid' });
	if (!validDeltaEvidence(delta)) invalidReasons.push({ code: 'delta_arithmetic_invalid' });
	if (!validBoundaryEvidence(context.boundary)) {
		invalidReasons.push({
			code: context.boundary.status === 'invalid' ? 'boundary_invalid' : 'boundary_arithmetic_invalid',
		});
	}
	if (!boundaryMatchesDelta(context.boundary, delta)) {
		invalidReasons.push({ code: 'boundary_delta_mismatch' });
	}
	if (!validTradingPostEvidence(context.tradingPost.events, context.boundary.window)) {
		invalidReasons.push({ code: 'trading_post_evidence_invalid' });
	}
	if (
		!['complete', 'partial', 'unavailable'].includes(context.tradingPost.status) ||
		(context.tradingPost.status === 'unavailable' && context.tradingPost.events.length > 0) ||
		!['manual_confirmed', 'auto_confirmed', 'auto_uncertain'].includes(context.boundaryCertainty) ||
		!validDeclaration(context.declaration)
	) {
		invalidReasons.push({ code: 'classification_context_invalid' });
	}
	if (invalidReasons.length > 0) {
		return classification('invalid', 'low', invalidReasons, [{ code: 'repair_boundary_evidence' }]);
	}

	const contamination: SessionClassificationReason[] = [];
	if (
		context.boundary.delivery.coverage === 'complete_both' &&
		context.boundary.delivery.items.some((item) => item.delta !== 0)
	) {
		contamination.push({ code: 'delivery_items_changed' });
	}
	if (
		context.boundary.delivery.coverage === 'complete_both' &&
		context.boundary.delivery.coins.delta !== 0
	) contamination.push({ code: 'delivery_coins_changed' });
	if (context.tradingPost.events.some((event) => event.kind === 'buy')) {
		contamination.push({ code: 'tp_buy_observed' });
	}
	if (context.tradingPost.events.some((event) => event.kind === 'sell')) {
		contamination.push({ code: 'tp_sell_observed' });
	}
	const walletDeltas = context.boundary.wallet.coverage === 'complete_both'
		? context.boundary.wallet.currencies.map((currency) => currency.delta)
		: [];
	if (walletDeltas.some((change) => change < 0)) contamination.push({ code: 'wallet_decreased' });
	if (delta.warnings.some((warning) => warning.code === 'roster_changed')) {
		contamination.push({ code: 'roster_changed' });
	}
	if (context.declaration.status === 'activities') {
		for (const activity of context.declaration.activities) {
			contamination.push({ code: 'activity_declared', detail: activity });
		}
	}
	if (contamination.length > 0) {
		if (context.declaration.status === 'confirmed_clean') {
			contamination.push({ code: 'clean_declaration_conflicts_with_evidence' });
		}
		return classification(
			'contaminated',
			'high',
			contamination,
			[{ code: 'review_detected_external_activity' }],
		);
	}

	const estimates: SessionClassificationReason[] = [];
	const reviews: SessionReviewRequest[] = [];
	const cleanManualConfirmation =
		context.boundaryCertainty === 'manual_confirmed' &&
		context.declaration.status === 'confirmed_clean';
	const walletIncreaseConfirmedClean =
		walletDeltas.some((change) => change > 0) && cleanManualConfirmation;
	if (walletDeltas.some((change) => change > 0) && !walletIncreaseConfirmedClean) {
		estimates.push({ code: 'wallet_increased_ambiguous' });
		reviews.push({ code: 'review_wallet_increase' });
	}
	if (delta.status !== 'comparable' || delta.surface !== 'core_and_delivery' || delta.currencySurface !== 'wallet_and_delivery') {
		estimates.push({ code: 'delta_limited' });
		reviews.push({ code: 'review_limited_surface' });
	}
	// An unreadable character is incomplete reading, not evidence of external movement:
	// it degrades the session to estimated instead of contaminating or invalidating it.
	if (delta.warnings.some((warning) => warning.code === 'character_unobserved')) {
		estimates.push({ code: 'character_unobserved' });
		reviews.push({ code: 'review_limited_surface' });
	}
	if (context.boundaryCertainty !== 'manual_confirmed') {
		estimates.push({ code: 'boundary_not_manually_confirmed' });
		reviews.push({ code: 'confirm_session_boundaries' });
	}
	if (context.declaration.status !== 'confirmed_clean') {
		estimates.push({ code: 'declaration_not_clean' });
		reviews.push({ code: 'confirm_session_cleanliness' });
	}
	if (estimates.length > 0) {
		return classification(
			'estimated',
			context.boundaryCertainty === 'auto_uncertain' || context.declaration.status === 'absent'
				? 'low'
				: 'medium',
			estimates,
			reviews,
			context.boundaryCertainty === 'manual_confirmed' &&
				context.declaration.status === 'confirmed_clean',
		);
	}

	const exactReasons: SessionClassificationReason[] = walletIncreaseConfirmedClean
		? [{ code: 'wallet_increase_clean_confirmation_used' }]
		: [];
	if (context.tradingPost.status !== 'complete') {
		exactReasons.push({ code: 'trading_post_not_complete_clean_declaration_used' });
	}
	return classification('exact', 'high', exactReasons, []);
}

function classification(
	status: SessionDeltaClassification['status'],
	confidence: SessionDeltaClassification['confidence'],
	reasons: SessionClassificationReason[],
	reviewRequests: SessionReviewRequest[],
	acceptedEstimate = false,
): SessionDeltaClassification {
	return {
		version: SESSION_CLASSIFICATION_VERSION,
		status,
		confidence,
		scope: 'observed_storage_net',
		reasons: canonicalUnique(reasons),
		reviewRequests: canonicalUnique(reviewRequests),
		permissions: classificationPermissions(status, confidence, acceptedEstimate),
	};
}

/** Validates the self-contained H2.7 classification envelope. Evidence-bound reviews still recompute it. */
export function isSessionDeltaClassification(value: unknown): value is SessionDeltaClassification {
	if (!isRecord(value) || !hasExactKeys(value, [
		'version', 'status', 'confidence', 'scope', 'reasons', 'reviewRequests', 'permissions',
	])) return false;
	if (value.version !== SESSION_CLASSIFICATION_VERSION ||
		!['exact', 'estimated', 'contaminated', 'invalid'].includes(String(value.status)) ||
		!['high', 'medium', 'low'].includes(String(value.confidence)) ||
		value.scope !== 'observed_storage_net' || !Array.isArray(value.reasons) ||
		!value.reasons.every(isClassificationReason) || !Array.isArray(value.reviewRequests) ||
		!value.reviewRequests.every(isReviewRequest) || !isPermissions(value.permissions)) return false;
	const typed = value as unknown as SessionDeltaClassification;
	if ((typed.status === 'exact' && typed.confidence !== 'high') ||
		(typed.status === 'invalid' && typed.confidence !== 'low') ||
		(typed.status === 'estimated' && typed.confidence === 'high') ||
		(typed.status === 'contaminated' && typed.confidence !== 'high')) return false;
	if (!validClassificationSemantics(typed)) return false;
	if (canonical(typed.reasons) !== canonical([...typed.reasons].sort(compareCanonical)) ||
		canonical(typed.reviewRequests) !== canonical([...typed.reviewRequests].sort(compareCanonical)) ||
		!uniqueCanonical(typed.reasons) || !uniqueCanonical(typed.reviewRequests)) return false;
	const expected = classificationPermissions(typed.status, typed.confidence, isAcceptedEstimate(typed));
	return canonical(typed.permissions) === canonical(expected);
}

function classificationPermissions(
	status: SessionDeltaClassification['status'],
	confidence: SessionDeltaClassification['confidence'],
	acceptedEstimate = false,
): SessionDeltaClassification['permissions'] {
	return {
		finalize: status === 'exact' || status === 'contaminated' || (status === 'estimated' && acceptedEstimate),
		showNet: status !== 'invalid',
		valueNet: status === 'exact' || status === 'estimated',
		grossPerHour: status === 'exact',
		recommend: status === 'exact' && confidence === 'high',
	};
}

const CLASSIFICATION_REASONS = new Set<string>([
	'delta_invalid', 'boundary_invalid', 'boundary_delta_mismatch', 'boundary_arithmetic_invalid',
	'delta_arithmetic_invalid', 'classification_context_invalid', 'trading_post_evidence_invalid',
	'delivery_items_changed', 'delivery_coins_changed', 'tp_buy_observed', 'tp_sell_observed',
	'wallet_decreased', 'wallet_increased_ambiguous', 'wallet_increase_clean_confirmation_used',
	'roster_changed', 'character_unobserved', 'activity_declared',
	'clean_declaration_conflicts_with_evidence', 'delta_limited',
	'boundary_not_manually_confirmed', 'declaration_not_clean',
	'trading_post_not_complete_clean_declaration_used',
]);
const REVIEW_REQUESTS = new Set<string>([
	'repair_boundary_evidence', 'review_detected_external_activity', 'confirm_session_boundaries',
	'confirm_session_cleanliness', 'review_wallet_increase', 'review_limited_surface',
]);
const FATAL_REASONS = new Set<string>([
	'delta_invalid', 'boundary_invalid', 'boundary_delta_mismatch', 'boundary_arithmetic_invalid',
	'delta_arithmetic_invalid', 'classification_context_invalid', 'trading_post_evidence_invalid',
]);
const CONTAMINATING_REASONS = new Set<string>([
	'delivery_items_changed', 'delivery_coins_changed', 'tp_buy_observed', 'tp_sell_observed',
	'wallet_decreased', 'roster_changed', 'activity_declared',
]);
const ESTIMATE_REVIEW = new Map<string, string>([
	['wallet_increased_ambiguous', 'review_wallet_increase'],
	['delta_limited', 'review_limited_surface'],
	['character_unobserved', 'review_limited_surface'],
	['boundary_not_manually_confirmed', 'confirm_session_boundaries'],
	['declaration_not_clean', 'confirm_session_cleanliness'],
]);
const EXACT_INFO_REASONS = new Set<string>([
	'wallet_increase_clean_confirmation_used',
	'trading_post_not_complete_clean_declaration_used',
]);

function validClassificationSemantics(value: SessionDeltaClassification): boolean {
	const codes = value.reasons.map((reason) => reason.code);
	const reviews = value.reviewRequests.map((request) => request.code);
	if (value.status === 'exact') {
		return reviews.length === 0 && codes.every((code) => EXACT_INFO_REASONS.has(code));
	}
	if (value.status === 'invalid') {
		return codes.some((code) => FATAL_REASONS.has(code)) &&
			codes.every((code) => FATAL_REASONS.has(code)) &&
			reviews.length === 1 && reviews[0] === 'repair_boundary_evidence';
	}
	if (value.status === 'contaminated') {
		return codes.some((code) => CONTAMINATING_REASONS.has(code)) &&
			codes.every((code) => CONTAMINATING_REASONS.has(code) || code === 'clean_declaration_conflicts_with_evidence') &&
			reviews.length === 1 && reviews[0] === 'review_detected_external_activity';
	}
	if (codes.length === 0 || !codes.every((code) => ESTIMATE_REVIEW.has(code))) return false;
	const expectedReviews = [...new Set(codes.map((code) => ESTIMATE_REVIEW.get(code)!))]
		.sort((left, right) => canonical({ code: left }).localeCompare(canonical({ code: right })));
	return canonical(reviews) === canonical(expectedReviews);
}

function isAcceptedEstimate(value: SessionDeltaClassification): boolean {
	if (value.status !== 'estimated') return false;
	const codes = new Set(value.reasons.map((reason) => reason.code));
	return value.confidence === 'medium' && codes.has('delta_limited') &&
		!codes.has('boundary_not_manually_confirmed') && !codes.has('declaration_not_clean') &&
		!codes.has('wallet_increased_ambiguous');
}

function isClassificationReason(value: unknown): boolean {
	if (!isRecord(value) || !CLASSIFICATION_REASONS.has(String(value.code))) return false;
	if (value.code === 'activity_declared') {
		return hasExactKeys(value, ['code', 'detail']) && DECLARED_ACTIVITIES.has(value.detail as DeclaredActivity);
	}
	return hasExactKeys(value, ['code']);
}

function isReviewRequest(value: unknown): boolean {
	return isRecord(value) && hasExactKeys(value, ['code']) && REVIEW_REQUESTS.has(String(value.code));
}

function isPermissions(value: unknown): value is SessionDeltaClassification['permissions'] {
	return isRecord(value) && hasExactKeys(value, ['finalize', 'showNet', 'valueNet', 'grossPerHour', 'recommend']) &&
		Object.values(value).every((entry) => typeof entry === 'boolean');
}

function compareCanonical(left: unknown, right: unknown): number {
	return canonical(left).localeCompare(canonical(right));
}

function uniqueCanonical(values: unknown[]): boolean {
	return new Set(values.map(canonical)).size === values.length;
}

export function isStorageDelta(value: unknown): value is StorageDelta {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'version', 'status', 'accountId', 'beforeSnapshotId', 'afterSnapshotId', 'window',
		'surface', 'currencySurface', 'reasons', 'warnings', 'itemChanges', 'currencyChanges',
		'availabilityChanges', 'compositionChanges',
	])) return false;
	if (
		value.version !== 1 ||
		!['comparable', 'limited', 'invalid'].includes(String(value.status)) ||
		!nullableString(value.accountId) ||
		!nullableString(value.beforeSnapshotId) ||
		!nullableString(value.afterSnapshotId) ||
		!validDeltaWindow(value.window) ||
		!['core_and_delivery', 'core_only', null].includes(value.surface as never) ||
		!['wallet_and_delivery', 'wallet_only', 'unavailable', null].includes(value.currencySurface as never) ||
		!Array.isArray(value.reasons) || !value.reasons.every(isDeltaReason) ||
		!Array.isArray(value.warnings) || !value.warnings.every(isDeltaWarning) ||
		!Array.isArray(value.itemChanges) || !value.itemChanges.every(isQuantityChange) ||
		!Array.isArray(value.currencyChanges) || !value.currencyChanges.every(isQuantityChange) ||
		!Array.isArray(value.availabilityChanges) || !value.availabilityChanges.every(isQuantityChange) ||
		!isOrderedQuantityChanges(value.itemChanges) ||
		!isOrderedQuantityChanges(value.currencyChanges) ||
		!isOrderedQuantityChanges(value.availabilityChanges) ||
		!Array.isArray(value.compositionChanges) || !value.compositionChanges.every(isCompositionChange) ||
		!isOrderedCompositionChanges(value.compositionChanges)
	) return false;
	if (value.status === 'invalid') {
		return value.window === null && value.surface === null && value.currencySurface === null &&
			value.itemChanges.length === 0 && value.currencyChanges.length === 0 &&
			value.availabilityChanges.length === 0 && value.compositionChanges.length === 0;
	}
	if (
		typeof value.accountId !== 'string' ||
		typeof value.beforeSnapshotId !== 'string' ||
		typeof value.afterSnapshotId !== 'string' ||
		value.beforeSnapshotId === value.afterSnapshotId ||
		value.window === null || value.surface === null || value.currencySurface === null
	) return false;
	const full = value.surface === 'core_and_delivery' && value.currencySurface === 'wallet_and_delivery';
	if (value.status === 'comparable') return full;
	// A full surface can still be limited, but only when the delta states which
	// characters it had to drop; anything else keeps the surface/status invariant.
	return !full || value.warnings.some(
		(warning) => isRecord(warning) && warning.code === 'character_unobserved',
	);
}

function isClassificationContext(value: unknown): value is SessionClassificationContext {
	return isRecord(value) && hasOnlyKeys(value, [
		'boundary', 'tradingPost', 'declaration', 'boundaryCertainty',
	]) && isBoundaryEvidenceShape(value.boundary) && isTradingPostEvidence(value.tradingPost) &&
		isDeclaration(value.declaration) &&
		['manual_confirmed', 'auto_confirmed', 'auto_uncertain'].includes(String(value.boundaryCertainty));
}

function isBoundaryEvidenceShape(value: unknown): value is BoundaryEvidence {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'version', 'status', 'accountId', 'beforeSnapshotId', 'afterSnapshotId', 'window',
		'delivery', 'wallet', 'reasons',
	])) return false;
	const deliveryCoins = isRecord(value.delivery) ? value.delivery.coins : null;
	if (
		value.version !== BOUNDARY_EVIDENCE_VERSION ||
		!['valid', 'invalid'].includes(String(value.status)) ||
		!nullableString(value.accountId) ||
		!nullableString(value.beforeSnapshotId) ||
		!nullableString(value.afterSnapshotId) ||
		!validDeltaWindow(value.window) ||
		!isRecord(value.delivery) || !hasOnlyKeys(value.delivery, ['coverage', 'items', 'coins']) ||
		!validCoverage(value.delivery.coverage) ||
		!Array.isArray(value.delivery.items) || !value.delivery.items.every(isBoundaryItemEvidence) ||
		!isBoundaryItemEvidence(deliveryCoins) || deliveryCoins.id !== 1 ||
		!isRecord(value.wallet) || !hasOnlyKeys(value.wallet, ['coverage', 'currencies']) ||
		!validCoverage(value.wallet.coverage) ||
		!Array.isArray(value.wallet.currencies) || !value.wallet.currencies.every(isBoundaryItemEvidence) ||
		!Array.isArray(value.reasons) || !value.reasons.every(isBoundaryReason)
	) return false;
	return value.status === 'valid'
		? typeof value.accountId === 'string' && typeof value.beforeSnapshotId === 'string' &&
			typeof value.afterSnapshotId === 'string' && value.beforeSnapshotId !== value.afterSnapshotId &&
			value.window !== null && value.reasons.length === 0
		: value.reasons.length > 0;
}

function isTradingPostEvidence(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'events']) ||
		!['complete', 'partial', 'unavailable'].includes(String(value.status)) ||
		!Array.isArray(value.events) || !value.events.every(isTradingPostEvent)) return false;
	return value.status !== 'unavailable' || value.events.length === 0;
}

function isTradingPostEvent(value: unknown): boolean {
	return isRecord(value) && hasOnlyKeys(value, [
		'kind', 'itemId', 'quantity', 'coins', 'occurredAt',
	]) && (value.kind === 'buy' || value.kind === 'sell') &&
		isPositiveId(value.itemId) && isPositiveQuantity(value.quantity) &&
		isNonNegativeSafeInteger(value.coins) && typeof value.occurredAt === 'string';
}

function isDeclaration(value: unknown): boolean {
	if (!isRecord(value) || typeof value.status !== 'string') return false;
	if (value.status === 'activities') {
		return hasOnlyKeys(value, ['status', 'activities']) && Array.isArray(value.activities) &&
			value.activities.length > 0 && value.activities.every((activity) =>
				typeof activity === 'string' && DECLARED_ACTIVITIES.has(activity as DeclaredActivity),
			);
	}
	return ['confirmed_clean', 'unsure', 'absent'].includes(value.status) && hasOnlyKeys(value, ['status']);
}

function isBoundaryItemEvidence(value: unknown): value is BoundaryItemEvidence {
	return isRecord(value) && hasOnlyKeys(value, ['id', 'before', 'after', 'delta']) &&
		isPositiveId(value.id) && isNonNegativeSafeInteger(value.before) &&
		isNonNegativeSafeInteger(value.after) && Number.isSafeInteger(value.delta);
}

function isBoundaryReason(value: unknown): boolean {
	return isRecord(value) && hasOnlyKeys(value, ['code', 'snapshot']) &&
		['invalid_snapshot', 'account_mismatch', 'snapshot_id_reused', 'invalid_window', 'overlapping_window'].includes(String(value.code)) &&
		(value.snapshot === undefined || value.snapshot === 'before' || value.snapshot === 'after' || value.snapshot === 'both');
}

function isDeltaReason(value: unknown): boolean {
	return isRecord(value) && hasOnlyKeys(value, ['code', 'snapshot', 'detail']) &&
		[
			'invalid_snapshot', 'account_mismatch', 'schema_mismatch', 'snapshot_id_reused',
			'invalid_window', 'overlapping_window', 'unsupported_quality', 'core_coverage_incomplete',
			'character_coverage_incomplete', 'aggregate_invariant_failed', 'delivery_excluded',
		].includes(String(value.code)) &&
		(value.snapshot === undefined || value.snapshot === 'before' || value.snapshot === 'after' || value.snapshot === 'both') &&
		(value.detail === undefined || typeof value.detail === 'string');
}

function isDeltaWarning(value: unknown): boolean {
	return isRecord(value) && hasOnlyKeys(value, ['code', 'before', 'after']) &&
		[
			'delivery_coverage_asymmetric', 'wallet_unobserved', 'wallet_coverage_asymmetric',
			'placement_changed_during_capture', 'roster_changed', 'character_unobserved',
			'surface_excludes_equipment_mail_guild_and_active_tp', 'net_only_gross_turnover_unknown',
		].includes(String(value.code)) &&
		(value.before === undefined || typeof value.before === 'string') &&
		(value.after === undefined || typeof value.after === 'string');
}

function isQuantityChange(value: unknown): boolean {
	return isRecord(value) && hasOnlyKeys(value, ['id', 'before', 'after', 'delta']) &&
		isPositiveId(value.id) && isNonNegativeSafeInteger(value.before) &&
		isNonNegativeSafeInteger(value.after) && Number.isSafeInteger(value.delta) &&
		value.delta !== 0 && value.after - value.before === value.delta;
}

function isOrderedQuantityChanges(values: unknown[]): boolean {
	let previousId = 0;
	return values.every((value) => {
		if (!isRecord(value) || !isPositiveId(value.id) || value.id <= previousId) return false;
		previousId = value.id;
		return true;
	});
}

function isCompositionChange(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'id', 'before', 'after']) ||
		!isPositiveId(value.id) || !Array.isArray(value.before) || !Array.isArray(value.after) ||
		value.before.length === 0 || value.after.length === 0 ||
		canonical(value.before) === canonical(value.after) ||
		!isCanonicalOrder(value.before) || !isCanonicalOrder(value.after)) return false;
	if (value.kind === 'currency') {
		return value.before.every(isCurrencyCompositionPart) && value.after.every(isCurrencyCompositionPart) &&
			(!value.before.some(isDeliveryCurrencyCompositionPart) &&
				!value.after.some(isDeliveryCurrencyCompositionPart) || value.id === 1) &&
			hasConservedQuantity(value.before, value.after);
	}
	if (value.kind === 'item') {
		return value.before.every(isItemCompositionPart) && value.after.every(isItemCompositionPart) &&
			hasConservedQuantity(value.before, value.after);
	}
	return false;
}

function isOrderedCompositionChanges(values: unknown[]): boolean {
	return values.every((value, index) => {
		if (!isRecord(value) || (value.kind !== 'item' && value.kind !== 'currency') || !isPositiveId(value.id)) {
			return false;
		}
		if (index === 0) return true;
		const previous = values[index - 1];
		if (!isRecord(previous) || (previous.kind !== 'item' && previous.kind !== 'currency') || !isPositiveId(previous.id)) {
			return false;
		}
		return previous.kind.localeCompare(value.kind) < 0 ||
			(previous.kind === value.kind && previous.id < value.id);
	});
}

function isCanonicalOrder(values: unknown[]): boolean {
	return values.every((value, index) => index === 0 ||
		canonical(values[index - 1]).localeCompare(canonical(value)) <= 0);
}

function hasConservedQuantity(before: unknown[], after: unknown[]): boolean {
	const beforeTotal = compositionQuantity(before);
	const afterTotal = compositionQuantity(after);
	return beforeTotal !== null && beforeTotal === afterTotal;
}

function compositionQuantity(values: unknown[]): number | null {
	let total = 0;
	for (const value of values) {
		if (!isRecord(value) || !isPositiveQuantity(value.quantity)) return null;
		total += value.quantity;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}

function isCurrencyCompositionPart(value: unknown): boolean {
	return isRecord(value) && hasOnlyKeys(value, ['quantity', 'namespace']) &&
		isPositiveQuantity(value.quantity) && (value.namespace === 'wallet' || value.namespace === 'delivery');
}

function isDeliveryCurrencyCompositionPart(value: unknown): boolean {
	return isRecord(value) && value.namespace === 'delivery';
}

function isItemCompositionPart(value: unknown): boolean {
	if (!(isRecord(value) && hasOnlyKeys(value, [
		'quantity', 'state', 'location', 'metadata', 'parentItemId', 'embeddedKind',
	]) && isPositiveQuantity(value.quantity) &&
		['loose', 'equipped_container', 'embedded_upgrade', 'embedded_infusion', 'pending_claim'].includes(String(value.state)) &&
		isItemLocation(value.location) && isItemMetadata(value.metadata) &&
		(value.parentItemId === undefined || isPositiveId(value.parentItemId)) &&
		(value.embeddedKind === undefined || value.embeddedKind === 'upgrade' || value.embeddedKind === 'infusion'))) return false;
	const embedded = value.state === 'embedded_upgrade' || value.state === 'embedded_infusion';
	if (embedded) {
		return value.quantity === 1 && isPositiveId(value.parentItemId) &&
			(value.state === 'embedded_upgrade' ? value.embeddedKind === 'upgrade' : value.embeddedKind === 'infusion') &&
			!isEquippedBagLocation(value.location);
	}
	if (value.parentItemId !== undefined || value.embeddedKind !== undefined) return false;
	const source = (value.location as { source: string }).source;
	if (value.state === 'equipped_container') {
		return value.quantity === 1 && isEquippedBagLocation(value.location);
	}
	if (value.state === 'pending_claim') return source === 'commerce_delivery';
	return value.state === 'loose' && source !== 'commerce_delivery' && !isEquippedBagLocation(value.location);
}

function isEquippedBagLocation(value: unknown): boolean {
	return isRecord(value) && value.source === 'character' && value.container === 'equipped_bag';
}

function isItemLocation(value: unknown): boolean {
	if (!isRecord(value) || typeof value.source !== 'string') return false;
	switch (value.source) {
		case 'character':
			return typeof value.character === 'string' && value.character.length > 0 &&
				isNonNegativeSafeInteger(value.bagIndex) &&
				(value.container === 'equipped_bag'
					? hasOnlyKeys(value, ['source', 'character', 'container', 'bagIndex'])
					: value.container === 'bag' && isNonNegativeSafeInteger(value.slot) &&
						hasOnlyKeys(value, ['source', 'character', 'container', 'bagIndex', 'slot']));
		case 'shared_inventory':
		case 'bank':
		case 'commerce_delivery':
			return isNonNegativeSafeInteger(value.slot) && hasOnlyKeys(value, ['source', 'slot']);
		case 'materials':
			return isPositiveId(value.category) && hasOnlyKeys(value, ['source', 'category']);
		default:
			return false;
	}
}

function isItemMetadata(value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'binding', 'boundTo', 'skin', 'statsId', 'statsAttributes', 'charges',
	])) return false;
	return (value.binding === undefined || (typeof value.binding === 'string' && value.binding.length > 0)) &&
		(value.boundTo === undefined || typeof value.boundTo === 'string') &&
		(value.skin === undefined || isPositiveId(value.skin)) &&
		(value.statsId === undefined || isPositiveId(value.statsId)) &&
		(value.charges === undefined || isNonNegativeSafeInteger(value.charges)) &&
		(value.statsAttributes === undefined || (
			isRecord(value.statsAttributes) && Object.values(value.statsAttributes).every(
				(amount) => typeof amount === 'number' && Number.isFinite(amount),
			)
		));
}

function validDeltaWindow(value: unknown): value is { from: string; to: string } | null {
	return value === null || (
		isRecord(value) && hasOnlyKeys(value, ['from', 'to']) &&
		typeof value.from === 'string' && typeof value.to === 'string' && validInterval(value.from, value.to)
	);
}

function nullableString(value: unknown): value is string | null {
	return value === null || (typeof value === 'string' && value.length > 0);
}

function validBoundaryEvidence(boundary: BoundaryEvidence): boolean {
	if (
		boundary.version !== BOUNDARY_EVIDENCE_VERSION ||
		boundary.status !== 'valid' ||
		boundary.accountId === null ||
		boundary.beforeSnapshotId === null ||
		boundary.afterSnapshotId === null ||
		boundary.window === null ||
		boundary.reasons.length !== 0 ||
		!validInterval(boundary.window.from, boundary.window.to) ||
		!validCoverage(boundary.delivery.coverage) ||
		!validCoverage(boundary.wallet.coverage) ||
		boundary.delivery.coins.id !== 1 ||
		!validEvidence(boundary.delivery.coins)
	) return false;
	return [...boundary.delivery.items, ...boundary.wallet.currencies].every(
		(entry) => isPositiveId(entry.id) && validEvidence(entry),
	) &&
		boundary.delivery.coins.before >= 0 &&
		boundary.delivery.coins.after >= 0 &&
		uniqueSortedIds(boundary.delivery.items) &&
		uniqueSortedIds(boundary.wallet.currencies);
}

function boundaryMatchesDelta(boundary: BoundaryEvidence, delta: StorageDelta): boolean {
	return (
		boundary.status === 'valid' &&
		boundary.accountId === delta.accountId &&
		boundary.beforeSnapshotId === delta.beforeSnapshotId &&
		boundary.afterSnapshotId === delta.afterSnapshotId &&
		canonical(boundary.window) === canonical(delta.window) &&
		boundarySurfacesMatchDelta(boundary, delta)
	);
}

function boundarySurfacesMatchDelta(boundary: BoundaryEvidence, delta: StorageDelta): boolean {
	const deliveryComplete = boundary.delivery.coverage === 'complete_both';
	const walletComplete = boundary.wallet.coverage === 'complete_both';
	const itemSurfaceMatches =
		(delta.surface === 'core_and_delivery' && deliveryComplete) ||
		(delta.surface === 'core_only' && !deliveryComplete) ||
		delta.surface === null;
	const currencySurfaceMatches =
		(delta.currencySurface === 'wallet_and_delivery' && walletComplete && deliveryComplete) ||
		(delta.currencySurface === 'wallet_only' && walletComplete && !deliveryComplete) ||
		(delta.currencySurface === 'unavailable' && !walletComplete) ||
		delta.currencySurface === null;
	return itemSurfaceMatches && currencySurfaceMatches;
}

function validDeltaEvidence(delta: StorageDelta): boolean {
	if (
		delta.version !== 1 ||
		!['comparable', 'limited', 'invalid'].includes(delta.status) ||
		!Array.isArray(delta.itemChanges) ||
		!Array.isArray(delta.currencyChanges) ||
		!Array.isArray(delta.availabilityChanges)
	) return false;
	return [delta.itemChanges, delta.currencyChanges, delta.availabilityChanges].every(
		(changes) => changes.every((change, index) =>
			isPositiveId(change.id) &&
			isNonNegativeSafeInteger(change.before) &&
			isNonNegativeSafeInteger(change.after) &&
			Number.isSafeInteger(change.delta) &&
			change.delta !== 0 &&
			change.after - change.before === change.delta &&
			(index === 0 || changes[index - 1]!.id < change.id),
		),
	);
}

function validTradingPostEvidence(
	events: TradingPostEvent[],
	window: BoundaryEvidence['window'],
): boolean {
	if (!Array.isArray(events) || window === null) return false;
	const from = Date.parse(window.from);
	const to = Date.parse(window.to);
	return events.every((event) => {
		const occurredAt = Date.parse(event.occurredAt);
		return (
			(event.kind === 'buy' || event.kind === 'sell') &&
			isPositiveId(event.itemId) &&
			isPositiveQuantity(event.quantity) &&
			isNonNegativeSafeInteger(event.coins) &&
			Number.isFinite(occurredAt) &&
			occurredAt >= from &&
			occurredAt <= to
		);
	});
}

function validDeclaration(declaration: SessionClassificationContext['declaration']): boolean {
	return declaration.status !== 'activities' || (
		Array.isArray(declaration.activities) &&
		declaration.activities.length > 0 &&
		declaration.activities.every((activity) => DECLARED_ACTIVITIES.has(activity))
	);
}

function invalidBoundary(
	before: unknown,
	after: unknown,
	reasons: BoundaryEvidenceReason[],
): BoundaryEvidence {
	return {
		version: BOUNDARY_EVIDENCE_VERSION,
		status: 'invalid',
		accountId: sharedString(before, after, 'accountId'),
		beforeSnapshotId: stringField(before, 'snapshotId'),
		afterSnapshotId: stringField(after, 'snapshotId'),
		window: null,
		delivery: { coverage: 'missing_both', items: [], coins: { id: 1 as const, ...evidence(0, 0) } },
		wallet: { coverage: 'missing_both', currencies: [] },
		reasons: canonicalUnique(reasons),
	};
}

function isSnapshotBoundary(value: unknown): value is StorageSnapshot {
	return (
		isRecord(value) &&
		typeof value.snapshotId === 'string' && value.snapshotId.length > 0 &&
		typeof value.accountId === 'string' && value.accountId.length > 0 &&
		typeof value.startedAt === 'string' &&
		typeof value.completedAt === 'string' &&
		Array.isArray(value.holdings) && value.holdings.every(validBoundaryHolding) &&
		Array.isArray(value.currencies) && value.currencies.every(validBoundaryCurrency) &&
		isRecord(value.coverage) && isRecord(value.coverage.sources) &&
		isCoverageStatus(value.coverage.sources.wallet) &&
		isCoverageStatus(value.coverage.sources.commerce_delivery)
	);
}

function validBoundaryHolding(value: unknown): boolean {
	return isRecord(value) && value.kind === 'item' && isPositiveId(value.itemId) &&
		isPositiveQuantity(value.quantity) && isRecord(value.location) &&
		typeof value.location.source === 'string';
}

function validBoundaryCurrency(value: unknown): boolean {
	return isRecord(value) && value.kind === 'currency' &&
		(value.namespace === 'wallet' || value.namespace === 'delivery') &&
		isPositiveId(value.currencyId) &&
		(value.namespace !== 'delivery' || value.currencyId === 1) &&
		isPositiveQuantity(value.quantity);
}

function isCoverageStatus(value: unknown): boolean {
	return isRecord(value) && ['complete', 'partial', 'skipped'].includes(String(value.status));
}

function coveragePair(before: string, after: string): BoundaryCoverage {
	const beforeComplete = before === 'complete';
	const afterComplete = after === 'complete';
	return beforeComplete && afterComplete
		? 'complete_both'
		: beforeComplete === afterComplete
			? 'missing_both'
			: 'asymmetric';
}

function itemTotals(snapshot: StorageSnapshot, source: 'commerce_delivery'): Map<number, number> {
	const totals = new Map<number, number>();
	for (const holding of snapshot.holdings) {
		if (holding.location.source === source) add(totals, holding.itemId, holding.quantity);
	}
	return totals;
}

function currencyTotals(snapshot: StorageSnapshot, namespace: 'wallet'): Map<number, number> {
	const totals = new Map<number, number>();
	for (const currency of snapshot.currencies) {
		if (currency.namespace === namespace) add(totals, currency.currencyId, currency.quantity);
	}
	return totals;
}

function currencyTotal(snapshot: StorageSnapshot, namespace: 'delivery', id: number): number {
	return snapshot.currencies
		.filter((currency) => currency.namespace === namespace && currency.currencyId === id)
		.reduce((total, currency) => safeAdd(total, currency.quantity), 0);
}

function quantityEvidence(before: Map<number, number>, after: Map<number, number>): BoundaryItemEvidence[] {
	return [...new Set([...before.keys(), ...after.keys()])]
		.sort((left, right) => left - right)
		.map((id) => ({ id, ...evidence(before.get(id) ?? 0, after.get(id) ?? 0) }));
}

function evidence(before: number, after: number): BoundaryQuantityEvidence {
	return { before, after, delta: safeSubtract(after, before) };
}

function validEvidence(value: BoundaryQuantityEvidence): boolean {
	return isNonNegativeSafeInteger(value.before) && isNonNegativeSafeInteger(value.after) &&
		Number.isSafeInteger(value.delta) && value.after - value.before === value.delta;
}

function uniqueSortedIds(values: BoundaryItemEvidence[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]!.id < value.id);
}

function add(target: Map<number, number>, id: number, quantity: number): void {
	target.set(id, safeAdd(target.get(id) ?? 0, quantity));
}

function safeAdd(left: number, right: number): number {
	const value = left + right;
	if (!Number.isSafeInteger(value)) throw new Error('Unsafe boundary aggregate.');
	return value;
}

function safeSubtract(right: number, left: number): number {
	const value = right - left;
	if (!Number.isSafeInteger(value)) throw new Error('Unsafe boundary delta.');
	return value;
}

function validInterval(from: string, to: string): boolean {
	return validTimestamp(from) && validTimestamp(to) && Date.parse(from) <= Date.parse(to);
}

function validTimestamp(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function isPositiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPositiveQuantity(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCoverage(value: unknown): value is BoundaryCoverage {
	return ['complete_both', 'missing_both', 'asymmetric'].includes(String(value));
}

function canonicalUnique<T>(values: T[]): T[] {
	const unique = new Map(values.map((value) => [canonical(value), value]));
	return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function stringField(value: unknown, field: string): string | null {
	return isRecord(value) && typeof value[field] === 'string' ? value[field] : null;
}

function sharedString(before: unknown, after: unknown, field: string): string | null {
	const left = stringField(before, field);
	return left !== null && left === stringField(after, field) ? left : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(value).every((key) => allowedSet.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index]);
}
