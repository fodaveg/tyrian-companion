import { normalizeVaultRelativePath } from '../core/vault-path';
import {
	isContainerRecommendationResult,
	type ContainerRecommendationResult,
} from '../economy/container-recommendation';
import { isHoldPlan, type HoldPlan } from '../economy/hold-intent';
import { isRecommendationEnvelope, type RecommendationEnvelopeV1 } from '../economy/recommendation-envelope';
import type { ReservationPlan, SessionValuationReservationOverlay } from '../economy/reservation-model';
import {
	isReservationPlan,
	isSessionValuationReservationOverlay,
	partitionSessionValuation,
} from '../economy/reservation';
import { isSessionValuation, type SessionValuation } from '../economy/session-valuation';
import { HALLOWEEN_RELEVANT_ITEM_RULE_SET } from './assisted-detection-service';
import { isSessionRuntimeRecord, type SessionRuntimeRecord } from './session-runtime-store';
import {
	isDetectionQualityEvent,
	type DetectionQualityEvent,
	type SessionDetectionQualitySummary,
} from './session-detection-quality';

export const SESSION_NOTE_SCHEMA_VERSION = 2 as const;
const DEFAULT_CONFIG_SEGMENT = `.${'obsidian'}`;
export const SESSION_NOTE_BLOCK_IDS = [
	'summary', 'evidence', 'results', 'economy', 'decision', 'provenance',
] as const;

export type SessionNoteBlockId = typeof SESSION_NOTE_BLOCK_IDS[number];
export type SessionNoteLocale = 'es' | 'en';
export type SessionNoteEvent = 'halloween';
export type SessionNoteEventDeclaration =
	| { event: 'halloween'; source: 'manual_explicit'; declaredAt: string }
	| { event: 'halloween'; source: 'assisted'; accepted: DetectionQualityEvent };

export interface SessionNoteInput {
	runtime: SessionRuntimeRecord;
	valuation: SessionValuation | null;
	reservation: { plan: ReservationPlan; overlay: SessionValuationReservationOverlay } | null;
	hold: HoldPlan | null;
	recommendation: ContainerRecommendationResult | null;
	envelope: RecommendationEnvelopeV1 | null;
	/** Closed provenance; callers must never infer an event from loot, text, date, or an id prefix. */
	eventDeclaration: SessionNoteEventDeclaration | null;
	displayNames: Record<string, string>;
	locale: SessionNoteLocale;
	outputFolder: string;
}

export type OptionalEvidence<T> =
	| { status: 'not_evaluated' }
	| { status: 'invalid' }
	| { status: 'valid'; value: T };

export interface PreparedSessionNote {
	runtime: SessionRuntimeRecord & {
		state: Extract<SessionRuntimeRecord['state'], { status: 'complete' }>;
		finalSnapshot: NonNullable<SessionRuntimeRecord['finalSnapshot']>;
		delta: NonNullable<SessionRuntimeRecord['delta']>;
		review: NonNullable<SessionRuntimeRecord['review']>;
	};
	durationMs: number;
	valuation: OptionalEvidence<SessionValuation>;
	reservation: OptionalEvidence<SessionNoteInput['reservation'] & object>;
	hold: OptionalEvidence<HoldPlan>;
	recommendation: OptionalEvidence<ContainerRecommendationResult>;
	envelope: OptionalEvidence<RecommendationEnvelopeV1>;
	eventDeclaration: SessionNoteEventDeclaration | null;
	displayNames: Record<string, string>;
	locale: SessionNoteLocale;
	outputFolder: string;
}

export type PrepareSessionNoteResult =
	| { status: 'ok'; note: PreparedSessionNote }
	| { status: 'invalid'; reason: 'invalid_runtime' | 'identity_mismatch' | 'unsafe_output_folder' | 'invalid_input' };

/** Validates identity-bearing evidence; malformed optional layers degrade without hiding the session. */
export function prepareSessionNote(value: unknown): PrepareSessionNoteResult {
	try { return prepareSessionNoteUnsafe(value); }
	catch { return { status: 'invalid', reason: 'invalid_input' }; }
}

/** Maps only the accepted, session-bound H3.8 Halloween ruleset; it does not inspect loot or time. */
export function sessionNoteEventDeclarationFromDetectionSummary(
	sessionId: string,
	summary: SessionDetectionQualitySummary | null,
): SessionNoteEventDeclaration | null {
	const start = summary?.start;
	const proposal = start?.startProposal;
	return summary?.sessionId === sessionId && start?.sessionId === sessionId &&
		start.outcome === 'accepted' && start.mode === 'assisted' && start.cause === 'relevant_item_gain' &&
		proposal !== null && proposal !== undefined && isCanonicalHalloweenProposal(proposal) &&
		proposal.proposalId === start.proposalId
		? { event: 'halloween', source: 'assisted', accepted: structuredClone(start) } : null;
}

function prepareSessionNoteUnsafe(value: unknown): PrepareSessionNoteResult {
	if (!isRecord(value) || !exactKeys(value, [
		'runtime', 'valuation', 'reservation', 'hold', 'recommendation', 'envelope',
		'eventDeclaration', 'displayNames', 'locale', 'outputFolder',
	])) return { status: 'invalid', reason: 'invalid_input' };
	if (!isSessionRuntimeRecord(value.runtime) || value.runtime.state.status !== 'complete' ||
		value.runtime.finalSnapshot === null || value.runtime.delta === null || value.runtime.review === null) {
		return { status: 'invalid', reason: 'invalid_runtime' };
	}
	const runtime = value.runtime as PreparedSessionNote['runtime'];
	if (runtime.review.classification.status !== runtime.state.classification) {
		return { status: 'invalid', reason: 'invalid_runtime' };
	}
	const durationMs = Date.parse(runtime.state.finalSnapshot.completedAt) - Date.parse(runtime.state.baseline.completedAt);
	if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return { status: 'invalid', reason: 'invalid_runtime' };
	if ((value.locale !== 'es' && value.locale !== 'en') || !validDisplayNames(value.displayNames)) {
		return { status: 'invalid', reason: 'invalid_input' };
	}
	const eventDeclaration = normalizeEventDeclaration(value.eventDeclaration, runtime);
	if (value.eventDeclaration !== null && eventDeclaration === null) return { status: 'invalid', reason: 'invalid_input' };
	const outputFolder = normalizeSessionOutputFolder(value.outputFolder);
	if (outputFolder === null) return { status: 'invalid', reason: 'unsafe_output_folder' };

	const identity = identityMismatch(value, runtime);
	if (identity) return { status: 'invalid', reason: 'identity_mismatch' };
	const reservation = optionalReservation(value.reservation, value.valuation, runtime);
	const valuation = optionalValuation(value.valuation, reservation, runtime, durationMs);
	const hold = optional(value.hold, isHoldPlan);
	let recommendation = optionalRecommendation(value.recommendation);
	const envelope = optional(value.envelope, isRecommendationEnvelope);
	if (recommendation.status === 'valid' && (envelope.status !== 'valid' ||
		canonical(recommendation.value.envelope) !== canonical(envelope.value))) {
		recommendation = { status: 'invalid' };
	}
	return {
		status: 'ok',
		note: {
			runtime: structuredClone(runtime), durationMs, valuation, reservation, hold,
			recommendation, envelope, eventDeclaration, displayNames: structuredClone(value.displayNames),
			locale: value.locale, outputFolder,
		},
	};
}

function normalizeEventDeclaration(
	value: unknown,
	runtime: PreparedSessionNote['runtime'],
): SessionNoteEventDeclaration | null {
	if (value === null) return null;
	if (!isRecord(value) || value.event !== 'halloween' ||
		(value.source !== 'manual_explicit' && value.source !== 'assisted')) return null;
	if (value.source === 'manual_explicit') {
		if (!exactKeys(value, ['event', 'source', 'declaredAt']) || !isIso(value.declaredAt)) return null;
		const declared = Date.parse(value.declaredAt);
		if (declared < Date.parse(runtime.state.baseline.completedAt) ||
			declared > Date.parse(runtime.state.finalSnapshot.completedAt)) return null;
		return structuredClone(value) as SessionNoteEventDeclaration;
	}
	if (!exactKeys(value, ['event', 'source', 'accepted']) || !isDetectionQualityEvent(value.accepted)) return null;
	const accepted = value.accepted;
	const proposal = accepted.startProposal;
	if (accepted.phase !== 'start' || accepted.outcome !== 'accepted' || accepted.mode !== 'assisted' ||
		accepted.cause !== 'relevant_item_gain' || accepted.sessionId !== runtime.state.sessionId ||
		proposal === null || proposal === undefined || proposal.proposalId !== accepted.proposalId ||
		proposal.accountId !== runtime.finalSnapshot.accountId || !isCanonicalHalloweenProposal(proposal)) return null;
	return { event: 'halloween', source: 'assisted', accepted: structuredClone(accepted) };
}

function isCanonicalHalloweenProposal(proposal: NonNullable<DetectionQualityEvent['startProposal']>): boolean {
	return proposal.ruleSet.id === HALLOWEEN_RELEVANT_ITEM_RULE_SET.id &&
		proposal.ruleSet.version === HALLOWEEN_RELEVANT_ITEM_RULE_SET.version &&
		proposal.firstSignal.gains.every((gain) => HALLOWEEN_RELEVANT_ITEM_RULE_SET.itemIds.includes(gain.itemId)) &&
		proposal.confirmationSignal.gains.every((gain) => HALLOWEEN_RELEVANT_ITEM_RULE_SET.itemIds.includes(gain.itemId)) &&
		proposal.proposalId === `relevant-start:${proposal.ruleSet.id}:${String(proposal.ruleSet.version)}:${proposal.firstSignal.beforeSnapshotId}:${proposal.confirmationSignal.afterSnapshotId}`;
}

/** Strict vault-relative path validation for generated session notes. */
export function normalizeSessionOutputFolder(value: unknown): string | null {
	return normalizeVaultRelativePath(value, {
		forbiddenSegments: [DEFAULT_CONFIG_SEGMENT],
		maxPathLength: 128,
	});
}

function identityMismatch(value: Record<string, unknown>, runtime: PreparedSessionNote['runtime']): boolean {
	const sessionId = runtime.state.sessionId;
	const accountId = runtime.finalSnapshot.accountId;
	const snapshotId = runtime.finalSnapshot.snapshotId;
	if (isRecord(value.valuation) && typeof value.valuation.sessionId === 'string' && value.valuation.sessionId !== sessionId) return true;
	if (isRecord(value.reservation)) {
		for (const child of [value.reservation.plan, value.reservation.overlay]) {
			if (isRecord(child) && ((typeof child.accountId === 'string' && child.accountId !== accountId) ||
				(typeof child.snapshotId === 'string' && child.snapshotId !== snapshotId))) return true;
		}
	}
	if (isRecord(value.hold) && ((typeof value.hold.accountId === 'string' && value.hold.accountId !== accountId) ||
		(typeof value.hold.snapshotId === 'string' && value.hold.snapshotId !== snapshotId) ||
		(typeof value.hold.sessionId === 'string' && value.hold.sessionId !== sessionId))) return true;
	if (isRecord(value.recommendation) && isRecord(value.recommendation.recommendation)) {
		const recommendation = value.recommendation.recommendation;
		if ((typeof recommendation.sessionId === 'string' && recommendation.sessionId !== sessionId) ||
			(typeof recommendation.accountId === 'string' && recommendation.accountId !== accountId) ||
			(typeof recommendation.afterSnapshotId === 'string' && recommendation.afterSnapshotId !== snapshotId)) return true;
	}
	return false;
}

function optionalValuation(
	value: unknown,
	reservation: PreparedSessionNote['reservation'],
	runtime: PreparedSessionNote['runtime'],
	durationMs: number,
): OptionalEvidence<SessionValuation> {
	if (value === null) return { status: 'not_evaluated' };
	const sackItemIds = reservation.status === 'valid' ? reservation.value.overlay.sackItemIds : [];
	if (!isSessionValuation(value, runtime.delta, sackItemIds) || value.durationMs !== durationMs ||
		value.priceCapturedAt !== runtime.priceSnapshot?.capturedAt || value.priceSource !== runtime.priceSnapshot?.source) {
		return { status: 'invalid' };
	}
	return { status: 'valid', value: structuredClone(value) };
}

function optionalReservation(
	value: unknown,
	valuation: unknown,
	runtime: PreparedSessionNote['runtime'],
): PreparedSessionNote['reservation'] {
	if (value === null) return { status: 'not_evaluated' };
	if (!isRecord(value) || !exactKeys(value, ['plan', 'overlay']) || !isReservationPlan(value.plan) ||
		!isSessionValuationReservationOverlay(value.overlay) || canonical(value.overlay.valuation) !== canonical(valuation) ||
		value.plan.accountId !== runtime.finalSnapshot.accountId || value.plan.snapshotId !== runtime.finalSnapshot.snapshotId ||
		value.overlay.accountId !== value.plan.accountId || value.overlay.snapshotId !== value.plan.snapshotId) {
		return { status: 'invalid' };
	}
	const recomputed = partitionSessionValuation({
		valuation: value.overlay.valuation,
		delta: runtime.delta,
		plan: value.plan,
		sackItemIds: value.overlay.sackItemIds,
	});
	if (recomputed.status !== 'ok' || canonical(recomputed.overlay) !== canonical(value.overlay)) {
		return { status: 'invalid' };
	}
	return { status: 'valid', value: { plan: structuredClone(value.plan), overlay: structuredClone(value.overlay) } };
}

function optionalRecommendation(value: unknown): OptionalEvidence<ContainerRecommendationResult> {
	if (value === null) return { status: 'not_evaluated' };
	return isContainerRecommendationResult(value)
		? { status: 'valid', value: structuredClone(value) }
		: { status: 'invalid' };
}

function optional<T>(value: unknown, validator: (candidate: unknown) => candidate is T): OptionalEvidence<T> {
	if (value === null) return { status: 'not_evaluated' };
	return validator(value) ? { status: 'valid', value: structuredClone(value) } : { status: 'invalid' };
}

function validDisplayNames(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.entries(value).every(([key, name]) =>
		/^(?:item|currency):[1-9]\d*$/u.test(key) && typeof name === 'string' && name.length <= 256);
}

export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (isRecord(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
