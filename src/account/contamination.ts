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
	type SessionClassificationReasonCode,
	type SessionDeltaClassification,
	type TradingPostEvent,
	type UserDeclaration,
} from './contamination-model';
import { canonicalJson as canonical } from '../core/canonical-sha256';

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

/**
 * The only wallet currencies whose decrease is evidence of *spending*, which is what can inject
 * loot the session did not farm: `1` is Coin, the account's money, and `4` is Gem, which converts
 * both ways with Coin and buys from the store.
 *
 * Every other currency in `/v2/currencies` — keys, vials, volatile magic, karma, reward-track
 * tokens — is a farming INPUT: it goes down precisely because the player opened a chest or bought
 * from a currency vendor while farming, and that is the activity being measured, not a
 * contamination of it. Treating those as external activity is what invalidated a real 54-minute
 * session over a single Exalted Key (`37`) and a single Vial of Chak Acid (`42`).
 */
const MONETARY_WALLET_CURRENCY_IDS: ReadonlySet<number> = new Set([1, 4]);

/**
 * Curated item ids whose loss IS the farming being measured, not contamination: opening a Trick-
 * or-Treat Bag (`36038`) consumes the bag itself, exactly like a spent key or vial. Extend this
 * list only with ids proven to be consumed by opening/using them while farming, never inferred
 * from mutable catalog text. An id absent from here is treated conservatively as a real loss
 * (equipment sold, salvaged or destroyed), which still degrades the reading.
 *
 * H14.1 checked the other four Labyrinth drops the assisted detector already watches alongside
 * the bag (`36041` Piece of Candy Corn, `36059` Plastic Fangs, `36060` Chattering Skull, `36061`
 * Nougat Center; `GET /v2/items?ids=36038,36041,36059,36060,36061`). None of them is a `Container`:
 * `36041` is a `Consumable`, already exempted at classification time by `farmedLossItemIds` below
 * whenever the catalog resolves it, and the other three are `CraftingMaterial`, a real loss like
 * any other crafting reagent. None gets added here.
 */
const CURATED_FARMED_LOSS_ITEM_IDS: ReadonlySet<number> = new Set([36_038]);

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
			return classification('invalid', 'low', invalidReasons);
		}
		return classifyValidatedSessionDelta(delta, context);
	} catch {
		return classification('invalid', 'low', [{ code: 'classification_context_invalid' }]);
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
		return classification('invalid', 'low', invalidReasons);
	}

	// No self-reported declaration ever contaminates a session anymore: David decided the plugin
	// trusts the API and nobody has to declare or confirm anything (2026-09-09). `declaration`
	// stays `{ status: 'absent' }` for every session `createSessionContaminationReview` produces;
	// `status: 'contaminated'` and `activity_declared` remain in the vocabulary only so a record
	// persisted before this date still reads back — REGLA firmada 2026-09-08 for what still
	// degrades a reading, updated 2026-09-09 for who decides it.

	// Evidence-based signals of possible external activity. Every one of them is a fact the delta
	// or the Trading Post/delivery history can measure directly, so it brackets the yield into a
	// band instead of discarding it outright; none of them ever contaminates.
	const deliveryItemsChanged = context.boundary.delivery.coverage === 'complete_both' &&
		context.boundary.delivery.items.some((item) => item.delta !== 0);
	const deliveryCoinsChanged = context.boundary.delivery.coverage === 'complete_both' &&
		context.boundary.delivery.coins.delta !== 0;
	const tpBuyObserved = context.tradingPost.events.some((event) => event.kind === 'buy');
	const tpSellObserved = context.tradingPost.events.some((event) => event.kind === 'sell');
	const rosterChanged = delta.warnings.some((warning) => warning.code === 'roster_changed');
	const walletCurrencies = context.boundary.wallet.coverage === 'complete_both'
		? context.boundary.wallet.currencies
		: [];
	const walletDeltas = walletCurrencies.map((currency) => currency.delta);
	const walletDecreased = walletCurrencies.some((currency) =>
		currency.delta < 0 && MONETARY_WALLET_CURRENCY_IDS.has(currency.id));
	const losses = delta.itemChanges.filter((change) => change.delta < 0);
	// H14.1: a loss whose catalog type the caller already resolved as `Container`/`Consumable`
	// (see `farmedLossItemIds` on `SessionClassificationContext`) is farmed input too, exactly like
	// the static curated list. A loss neither list recognizes is treated conservatively as a real
	// loss (equipment sold, salvaged or destroyed, or an id the catalog could not resolve), which
	// still degrades the reading.
	const farmedLossItemIds = new Set(context.farmedLossItemIds ?? []);
	const nonFarmingLoss = losses.some((change) =>
		!CURATED_FARMED_LOSS_ITEM_IDS.has(change.id) && !farmedLossItemIds.has(change.id));

	const reasons: SessionClassificationReason[] = [];
	let degraded = false;
	const push = (code: SessionClassificationReasonCode, degrades = false): void => {
		reasons.push({ code });
		if (degrades) degraded = true;
	};

	// Consuming farming inputs (keys, vials, magic, containers) IS the farming being measured, so
	// none of these degrade the reading; they stay visible as information instead.
	if (walletCurrencies.some((currency) =>
		currency.delta < 0 && !MONETARY_WALLET_CURRENCY_IDS.has(currency.id))) push('consumable_currency_spent');
	if (losses.length > 0) push('item_losses_observed', nonFarmingLoss);

	// Evidence of a bazaar movement or a roster change during the window: real external activity,
	// but nobody has to review it — the delta already brackets it, so it degrades to a band.
	if (deliveryItemsChanged) push('delivery_items_changed', true);
	if (deliveryCoinsChanged) push('delivery_coins_changed', true);
	if (tpBuyObserved) push('tp_buy_observed', true);
	if (tpSellObserved) push('tp_sell_observed', true);
	if (rosterChanged) push('roster_changed', true);
	// An NPC purchase spends coin/gems but is already netted out of «Moneda neta»; it never
	// degrades the reading.
	if (walletDecreased) push('wallet_decreased');

	if (delta.status !== 'comparable' || delta.surface !== 'core_and_delivery' || delta.currencySurface !== 'wallet_and_delivery') {
		push('delta_limited', true);
	}
	// An unreadable character is incomplete reading, not evidence of external movement:
	// it degrades the session to estimated instead of contaminating or invalidating it.
	if (delta.warnings.some((warning) => warning.code === 'character_unobserved')) {
		push('character_unobserved', true);
	}
	// The account reaches the public API through nested caches. A capture that did not wait the
	// documented window cannot have seen the last minutes, and one taken far too late may already
	// include activity from after the session: neither is exact, both remain usable estimates.
	if (context.apiSettlement === 'skipped') push('api_settlement_window_skipped', true);
	if (context.apiSettlement === 'exceeded') push('api_settlement_window_exceeded', true);

	// A wallet increase alone never degrades or contaminates the reading — it stays visible as
	// information; the bazaar/roster signals above already degrade whenever one of them explains it.
	if (walletDeltas.some((change) => change > 0)) push('wallet_increased_ambiguous');

	if (degraded) {
		return classification(
			'estimated',
			context.boundaryCertainty === 'auto_uncertain' ? 'low' : 'medium',
			reasons,
		);
	}

	return classification('exact', 'high', reasons);
}

function classification(
	status: SessionDeltaClassification['status'],
	confidence: SessionDeltaClassification['confidence'],
	reasons: SessionClassificationReason[],
): SessionDeltaClassification {
	return {
		version: SESSION_CLASSIFICATION_VERSION,
		status,
		confidence,
		scope: 'observed_storage_net',
		reasons: canonicalUnique(reasons),
		// Nobody reviews anything anymore (David, 2026-09-09): no classification ever asks for one.
		reviewRequests: [],
		permissions: classificationPermissions(status, confidence),
	};
}

/**
 * Whether the classification says the session consumed its own inputs: containers opened, or a
 * non-monetary currency spent. Consumers read this instead of re-listing the reason codes, so the
 * band and the kernel can never drift apart about what causes it.
 */
export function declaresConsumedInputs(
	value: Pick<SessionDeltaClassification, 'reasons'>,
): boolean {
	return value.reasons.some((reason) => CONSUMED_INPUT_REASONS.has(reason.code));
}

/**
 * Validates the self-contained classification envelope by FORM only: types, enums, known reason/
 * review codes, canonical ordering. It deliberately does not cross-check reasons against status or
 * permissions against status/confidence (that used to live in `validClassificationSemantics`): two
 * independently maintained vocabularies drifting apart is exactly what corrupted a real save on
 * 2026-09-09 (`ESTIMATE_REVIEW` vs. the classifier). A record persisted by a version before that
 * date — non-empty `reviewRequests`, `permissions.finalize: false`, even `status: 'contaminated'` —
 * still has to read back; only `isSessionContaminationReview` decides whether it still recomputes.
 */
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
	return canonical(typed.reasons) === canonical([...typed.reasons].sort(compareCanonical)) &&
		canonical(typed.reviewRequests) === canonical([...typed.reviewRequests].sort(compareCanonical)) &&
		uniqueCanonical(typed.reasons) && uniqueCanonical(typed.reviewRequests);
}

function classificationPermissions(
	status: SessionDeltaClassification['status'],
	confidence: SessionDeltaClassification['confidence'],
): SessionDeltaClassification['permissions'] {
	return {
		// Nothing blocks finalization anymore (David, 2026-09-09): the plugin trusts the API and
		// saves whatever it read, even an `invalid` technical failure.
		finalize: true,
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
	'wallet_decreased', 'consumable_currency_spent', 'wallet_increased_ambiguous',
	'wallet_increase_clean_confirmation_used',
	'roster_changed', 'character_unobserved', 'activity_declared', 'open_activity_declared',
	'item_losses_observed', 'delta_limited',
	'boundary_not_manually_confirmed', 'api_settlement_window_skipped',
	'api_settlement_window_exceeded', 'declaration_not_clean',
	'trading_post_not_complete_clean_declaration_used',
]);
const REVIEW_REQUESTS = new Set<string>([
	'repair_boundary_evidence', 'review_detected_external_activity', 'confirm_session_boundaries',
	'confirm_session_cleanliness', 'review_wallet_increase', 'review_limited_surface',
	'review_consumed_inputs',
]);
/**
 * Reason codes a classification says the session consumed its own inputs: containers opened, or a
 * non-monetary currency spent. `open_activity_declared` no longer generates going forward (there is
 * no declaration left to read it from) but stays here so a record persisted before 2026-09-09 keeps
 * being recognized by `declaresConsumedInputs`.
 */
const CONSUMED_INPUT_REASONS = new Set<string>([
	'consumable_currency_spent', 'open_activity_declared', 'item_losses_observed',
]);

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
		'boundary', 'tradingPost', 'declaration', 'boundaryCertainty', 'apiSettlement', 'farmedLossItemIds',
	]) && isBoundaryEvidenceShape(value.boundary) && isTradingPostEvidence(value.tradingPost) &&
		isDeclaration(value.declaration) &&
		['manual_confirmed', 'auto_confirmed', 'auto_uncertain'].includes(String(value.boundaryCertainty)) &&
		isApiSettlement(value.apiSettlement) &&
		isFarmedLossItemIds(value.farmedLossItemIds);
}

/** Absent is legal: only a session stop boundary can declare how long the capture waited. */
function isApiSettlement(value: unknown): boolean {
	return value === undefined
		|| (typeof value === 'string' && ['settled', 'skipped', 'exceeded'].includes(value));
}

/** Absent is legal: only the async session-review flow resolves catalog types before classifying. */
function isFarmedLossItemIds(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every(isPositiveId));
}

/**
 * Structural-only counterpart to `buildBoundaryEvidence`: it validates that a stored value could
 * have been produced by it, without recomputing it from `before`/`after` snapshots. A caller that
 * only has the persisted evidence (no snapshots at hand) still needs to know it is not garbage.
 */
export function isBoundaryEvidenceShape(value: unknown): value is BoundaryEvidence {
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

function isDeclaration(value: unknown): value is UserDeclaration {
	if (!isRecord(value) || typeof value.status !== 'string') return false;
	if (value.status === 'activities') {
		return hasOnlyKeys(value, ['status', 'activities']) && Array.isArray(value.activities) &&
			value.activities.length > 0 && value.activities.every((activity) =>
				typeof activity === 'string' && DECLARED_ACTIVITIES.has(activity as DeclaredActivity),
			);
	}
	return ['confirmed_clean', 'unsure', 'absent'].includes(value.status) && hasOnlyKeys(value, ['status']);
}

/** Exported alias for callers outside this module: same structural check, without the network. */
export function isUserDeclarationShape(value: unknown): value is UserDeclaration {
	return isDeclaration(value);
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
