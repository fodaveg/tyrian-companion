import {
	buildBoundaryEvidence,
	classifySessionDelta,
	isBoundaryEvidenceShape,
	isSessionDeltaClassification,
	isUserDeclarationShape,
} from '../account/contamination';
import {
	LEGACY_SESSION_CLASSIFICATION_VERSION,
	SESSION_CLASSIFICATION_VERSION,
	type BoundaryEvidence,
	type DeclaredActivity,
	type SessionDeltaClassification,
	type UserDeclaration,
} from '../account/contamination-model';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import {
	isTradingPostHistoryEvidence,
} from '../account/trading-post-evidence';
import {
	SESSION_API_SETTLEMENTS,
	type SessionApiSettlement,
} from './session-api-settlement';

export const SESSION_CONTAMINATION_REVIEW_VERSION = 1 as const;

export const SESSION_ACTIVITY_KEYS = [
	'open',
	'salvage',
	'consume',
	'craft',
	'tpBuy',
	'tpSell',
	'vendorBuy',
	'vendorSell',
	'transfer',
	'other',
] as const;

export type SessionActivityKey = typeof SESSION_ACTIVITY_KEYS[number];

export interface SessionContaminationAnswers {
	certainty: 'confirmed' | 'unsure';
	activities: Record<SessionActivityKey, boolean>;
}

export interface SessionContaminationReview {
	version: typeof SESSION_CONTAMINATION_REVIEW_VERSION;
	reviewedAt: string;
	answers: SessionContaminationAnswers;
	declaration: UserDeclaration;
	boundary: BoundaryEvidence;
	classification: SessionDeltaClassification | LegacySessionDeltaClassification;
	/**
	 * Ids among the session's losses whose public-catalog type resolved to `Container` or
	 * `Consumable` before classification (H14.1). Stored, not recomputed: the classifier is
	 * synchronous and cannot re-resolve the catalog from the persisted review alone, the same
	 * reason `answers`/`declaration` are stored instead of re-derived. Canonically sorted, ids
	 * unique.
	 */
	farmedLossItemIds: number[];
}

export type SessionTradingPostContaminationProposal =
	| {
		status: 'ready';
		requiresHumanReview: true;
		suggestedActivities: Array<'tpBuy' | 'tpSell'>;
		eventCounts: { buys: number; sells: number };
	}
	| {
		status: 'unavailable';
		reason: 'identity_mismatch' | 'window_mismatch' | 'coverage_incomplete' | 'evidence_invalid'
			| 'no_provisional_session' | 'capture_unavailable';
		requiresHumanReview: true;
		suggestedActivities: [];
	};

export interface LegacySessionDeltaClassification extends Omit<SessionDeltaClassification, 'version' | 'permissions'> {
	version: 1;
	permissions: Omit<SessionDeltaClassification['permissions'], 'recommend'> & { recommend: false };
}

export function createSessionContaminationReview(
	before: StorageSnapshot,
	after: StorageSnapshot,
	delta: StorageDelta,
	answers: unknown,
	reviewedAt: string,
	apiSettlement: SessionApiSettlement = 'settled',
	farmedLossItemIds: readonly number[] = [],
): SessionContaminationReview | null {
	if (!isSessionContaminationAnswers(answers) || !isIsoTimestamp(reviewedAt)) return null;
	if (Date.parse(reviewedAt) < Date.parse(after.completedAt)) return null;
	if (!Array.isArray(farmedLossItemIds) || !farmedLossItemIds.every(isPositiveId)) return null;
	const canonicalFarmedLossItemIds = [...new Set(farmedLossItemIds)].sort((left, right) => left - right);
	const boundary = buildBoundaryEvidence(before, after);
	const declaration = declarationFromAnswers(answers);
	const classification = classifySessionDelta(delta, {
		boundary,
		tradingPost: { status: 'unavailable', events: [] },
		declaration,
		boundaryCertainty: 'manual_confirmed',
		apiSettlement,
		farmedLossItemIds: canonicalFarmedLossItemIds,
	});
	if (boundary.status !== 'valid' || classification.status === 'invalid') return null;
	return {
		version: SESSION_CONTAMINATION_REVIEW_VERSION,
		reviewedAt,
		answers: structuredClone(answers),
		declaration: structuredClone(declaration),
		boundary: structuredClone(boundary),
		classification: structuredClone(classification),
		farmedLossItemIds: canonicalFarmedLossItemIds,
	};
}

/**
 * Recomputes the review from its evidence. `apiSettlement` is optional on purpose: a caller that
 * wants to assert *which* settlement produced the review pins it, and a caller that only stores or
 * values the evidence accepts any of them. Persistence deliberately does not pin it, so a record
 * written before the grace window existed keeps validating instead of turning corrupt on upgrade;
 * the session service is the single producer, and it always declares the measured settlement.
 */
export function isSessionContaminationReview(
	value: unknown,
	before: StorageSnapshot,
	after: StorageSnapshot,
	delta: StorageDelta,
	apiSettlement?: SessionApiSettlement,
): value is SessionContaminationReview {
	if (!isRecord(value)) return false;
	const stored = withFarmedLossItemIds(value);
	if (!hasOnlyKeys(stored, [
		'version', 'reviewedAt', 'answers', 'declaration', 'boundary', 'classification', 'farmedLossItemIds',
	])) return false;
	if (stored.version !== SESSION_CONTAMINATION_REVIEW_VERSION || !isIsoTimestamp(stored.reviewedAt)) {
		return false;
	}
	const candidates = apiSettlement === undefined ? SESSION_API_SETTLEMENTS : [apiSettlement];
	return candidates.some((settlement) => matchesRecomputedReview(stored, before, after, delta, settlement));
}

function matchesRecomputedReview(
	value: Record<string, unknown>,
	before: StorageSnapshot,
	after: StorageSnapshot,
	delta: StorageDelta,
	apiSettlement: SessionApiSettlement,
): boolean {
	const expected = createSessionContaminationReview(
		before,
		after,
		delta,
		value.answers,
		value.reviewedAt as string,
		apiSettlement,
		Array.isArray(value.farmedLossItemIds) ? value.farmedLossItemIds as number[] : [],
	);
	if (expected === null) return false;
	if (JSON.stringify(expected) === JSON.stringify(value)) return true;
	if (!isRecord(value.classification) || value.classification.version !== 1) return false;
	const legacy = structuredClone(expected);
	legacy.classification = {
		...legacy.classification,
		version: 1,
		permissions: { ...legacy.classification.permissions, recommend: false },
	};
	return JSON.stringify(legacy) === JSON.stringify(value);
}

/**
 * Validates that a stored value has the SHAPE of a review, without recomputing it from
 * `before`/`after`/`delta`. Unlike `isSessionContaminationReview`, this never changes when the
 * contamination classifier's reason vocabulary or bucketing changes: it only checks that every
 * field is internally consistent, the same way `isSessionDeltaClassification` checks a
 * classification against itself instead of against fresh evidence. A caller that only wants to
 * know whether a persisted review is safe to *display* (not whether it still matches today's
 * classifier) uses this instead.
 */
export function isSessionContaminationReviewShape(value: unknown): value is SessionContaminationReview {
	if (!isRecord(value)) return false;
	const stored = withFarmedLossItemIds(value);
	if (!hasOnlyKeys(stored, [
		'version', 'reviewedAt', 'answers', 'declaration', 'boundary', 'classification', 'farmedLossItemIds',
	])) return false;
	if (stored.version !== SESSION_CONTAMINATION_REVIEW_VERSION || !isIsoTimestamp(stored.reviewedAt)) {
		return false;
	}
	return isSessionContaminationAnswers(stored.answers)
		&& isUserDeclarationShape(stored.declaration)
		&& isBoundaryEvidenceShape(stored.boundary)
		&& isClassificationEnvelopeShape(stored.classification)
		&& isFarmedLossItemIdsShape(stored.farmedLossItemIds);
}

/**
 * Reviews persisted before 0.1.31 carry no `farmedLossItemIds`: the catalog-type exemption did not
 * exist, so every loss had been classified as a non-farming loss, which is exactly what an empty
 * list means today. Reading them as `[]` keeps a stored session recoverable across the upgrade
 * (measured on 9 sep 2026: two `session_recover validation_failed` on a real vault at load).
 */
function withFarmedLossItemIds(value: Record<string, unknown>): Record<string, unknown> {
	return value.farmedLossItemIds === undefined ? { ...value, farmedLossItemIds: [] } : value;
}

/** Structural-only counterpart for the persisted, catalog-resolved ids: unique and canonically sorted. */
function isFarmedLossItemIdsShape(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(isPositiveId)
		&& value.every((id, index) => index === 0 || (value[index - 1] as number) < id);
}

function isPositiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Accepts either the current classification envelope or the legacy v1 downgrade produced by
 * `matchesRecomputedReview` (same fields, `version: 1`, `permissions.recommend` forced `false`).
 * Both directions of that downgrade are tried, because a shape check cannot know which value the
 * downgrade started from without recomputing it.
 */
function isClassificationEnvelopeShape(
	value: unknown,
): value is SessionDeltaClassification | LegacySessionDeltaClassification {
	if (isSessionDeltaClassification(value)) return true;
	if (!isRecord(value) || value.version !== LEGACY_SESSION_CLASSIFICATION_VERSION
		|| !isRecord(value.permissions) || value.permissions.recommend !== false) return false;
	const upgraded = { ...value, version: SESSION_CLASSIFICATION_VERSION, permissions: { ...value.permissions, recommend: true } };
	if (isSessionDeltaClassification(upgraded)) return true;
	return isSessionDeltaClassification({ ...upgraded, permissions: { ...upgraded.permissions, recommend: false } });
}

export function isSessionContaminationAnswers(value: unknown): value is SessionContaminationAnswers {
	if (!isRecord(value) || !hasOnlyKeys(value, ['certainty', 'activities'])) return false;
	if (value.certainty !== 'confirmed' && value.certainty !== 'unsure') return false;
	const activities = value.activities;
	if (!isRecord(activities) || !hasOnlyKeys(activities, SESSION_ACTIVITY_KEYS)) return false;
	return SESSION_ACTIVITY_KEYS.every((key) => typeof activities[key] === 'boolean');
}

/**
 * Projects complete history into review suggestions only. It never changes the
 * user's answers or feeds events directly into session classification.
 */
export function proposeTradingPostContamination(
	evidence: unknown,
	expectedAccountId: string,
	expectedWindow: { from: string; to: string },
): SessionTradingPostContaminationProposal {
	if (!isTradingPostHistoryEvidence(evidence)) return unavailableProposal('evidence_invalid');
	if (evidence.accountId !== expectedAccountId) return unavailableProposal('identity_mismatch');
	if (evidence.window.from !== expectedWindow.from || evidence.window.to !== expectedWindow.to) {
		return unavailableProposal('window_mismatch');
	}
	if (evidence.status !== 'complete') return unavailableProposal('coverage_incomplete');
	const buys = evidence.events.filter((event) => event.kind === 'buy').length;
	const sells = evidence.events.filter((event) => event.kind === 'sell').length;
	return {
		status: 'ready',
		requiresHumanReview: true,
		suggestedActivities: [
			...(buys > 0 ? ['tpBuy' as const] : []),
			...(sells > 0 ? ['tpSell' as const] : []),
		],
		eventCounts: { buys, sells },
	};
}

function unavailableProposal(
	reason: Extract<SessionTradingPostContaminationProposal, { status: 'unavailable' }>['reason'],
): SessionTradingPostContaminationProposal {
	return { status: 'unavailable', reason, requiresHumanReview: true, suggestedActivities: [] };
}

function declarationFromAnswers(answers: SessionContaminationAnswers): UserDeclaration {
	const activities: DeclaredActivity[] = [];
	if (answers.activities.open) activities.push('open');
	if (answers.activities.salvage) activities.push('salvage');
	if (answers.activities.consume) activities.push('consume');
	if (answers.activities.craft) activities.push('craft');
	if (answers.activities.tpBuy || answers.activities.tpSell) activities.push('tp');
	if (answers.activities.vendorBuy || answers.activities.vendorSell) activities.push('vendor');
	if (answers.activities.transfer) activities.push('transfer');
	if (answers.activities.other) activities.push('other');
	if (activities.length > 0) return { status: 'activities', activities };
	return answers.certainty === 'confirmed' ? { status: 'confirmed_clean' } : { status: 'unsure' };
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === 'string'
		&& Number.isFinite(Date.parse(value))
		&& new Date(Date.parse(value)).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
