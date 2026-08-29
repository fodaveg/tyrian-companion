import { buildBoundaryEvidence, classifySessionDelta } from '../account/contamination';
import type {
	BoundaryEvidence,
	DeclaredActivity,
	SessionDeltaClassification,
	UserDeclaration,
} from '../account/contamination-model';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import {
	isTradingPostHistoryEvidence,
} from '../account/trading-post-evidence';

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
): SessionContaminationReview | null {
	if (!isSessionContaminationAnswers(answers) || !isIsoTimestamp(reviewedAt)) return null;
	if (Date.parse(reviewedAt) < Date.parse(after.completedAt)) return null;
	const boundary = buildBoundaryEvidence(before, after);
	const declaration = declarationFromAnswers(answers);
	const classification = classifySessionDelta(delta, {
		boundary,
		tradingPost: { status: 'unavailable', events: [] },
		declaration,
		boundaryCertainty: 'manual_confirmed',
	});
	if (boundary.status !== 'valid' || classification.status === 'invalid') return null;
	return {
		version: SESSION_CONTAMINATION_REVIEW_VERSION,
		reviewedAt,
		answers: structuredClone(answers),
		declaration: structuredClone(declaration),
		boundary: structuredClone(boundary),
		classification: structuredClone(classification),
	};
}

export function isSessionContaminationReview(
	value: unknown,
	before: StorageSnapshot,
	after: StorageSnapshot,
	delta: StorageDelta,
): value is SessionContaminationReview {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'version', 'reviewedAt', 'answers', 'declaration', 'boundary', 'classification',
	])) return false;
	if (value.version !== SESSION_CONTAMINATION_REVIEW_VERSION || !isIsoTimestamp(value.reviewedAt)) {
		return false;
	}
	const expected = createSessionContaminationReview(before, after, delta, value.answers, value.reviewedAt);
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
