import type { InactivityStopProposal } from './inactivity-stop-detector';
import type { RelevantStartProposal } from './relevant-item-start-detector';
import type { DetectionCorrectionCause } from './session-detection-quality';

export const PENDING_PROPOSAL_VERSION = 1 as const;
export const PROPOSAL_RECEIPT_VERSION = 1 as const;

export interface ProposalClaim {
	operationId: string;
	instanceId: string;
	claimedAt: string;
	expiresAt: string;
}

interface PendingProposalBase {
	version: typeof PENDING_PROPOSAL_VERSION;
	proposalId: string;
	accountId: string;
	detectedAt: string;
	enqueuedAt: string;
	staleAt: string;
	expiresAt: string;
	acknowledgedAt: string | null;
	lastSurfacedAt: string | null;
	duplicateCount: number;
	lastObservedAt: string;
	claim: ProposalClaim | null;
}

export type PendingProposal =
	| (PendingProposalBase & {
		phase: 'start';
		binding: { kind: 'idle'; ruleSetId: string; ruleSetVersion: number };
		proposal: RelevantStartProposal;
	})
	| (PendingProposalBase & {
		phase: 'stop';
		binding: { kind: 'session'; sessionId: string; baselineSnapshotId: string };
		proposal: InactivityStopProposal;
	});

export type ProposalReceiptOutcome = 'accepted' | 'dismissed' | 'superseded' | 'expired' | 'invalidated';

export interface ProposalReceipt {
	version: typeof PROPOSAL_RECEIPT_VERSION;
	proposalId: string;
	outcome: ProposalReceiptOutcome;
	resolvedAt: string;
	sessionId: string | null;
	correctionCause: DetectionCorrectionCause | null;
	correctionRecorded: boolean | null;
}

export interface PendingProposalQueueRecord {
	version: 1;
	revision: number;
	proposals: PendingProposal[];
	receipts: ProposalReceipt[];
}

type ProposalIntentFor<T extends PendingProposal> = Pick<T, 'proposalId' | 'accountId' | 'phase' | 'binding'>;
export type PendingProposalIntent = PendingProposal extends infer T
	? T extends PendingProposal ? ProposalIntentFor<T> : never
	: never;

export function proposalIntent(proposal: PendingProposal): PendingProposalIntent {
	const intent = {
		proposalId: proposal.proposalId,
		accountId: proposal.accountId,
		phase: proposal.phase,
		binding: proposal.binding,
	};
	return structuredClone(intent) as PendingProposalIntent;
}

export function sameProposalIntent(proposal: PendingProposal, intent: PendingProposalIntent): boolean {
	return proposal.proposalId === intent.proposalId && proposal.accountId === intent.accountId &&
		proposal.phase === intent.phase && JSON.stringify(proposal.binding) === JSON.stringify(intent.binding);
}

export function isPendingProposal(value: unknown): value is PendingProposal {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'phase', 'proposalId', 'accountId', 'binding', 'proposal', 'detectedAt',
		'enqueuedAt', 'staleAt', 'expiresAt', 'acknowledgedAt', 'lastSurfacedAt',
		'duplicateCount', 'lastObservedAt', 'claim',
	])) return false;
	if (value.version !== 1 || (value.phase !== 'start' && value.phase !== 'stop') ||
		!validId(value.proposalId) || !validId(value.accountId) ||
		!isIso(value.detectedAt) || !isIso(value.enqueuedAt) || !isIso(value.staleAt) ||
		!isIso(value.expiresAt) || !nullableIso(value.acknowledgedAt) || !nullableIso(value.lastSurfacedAt) ||
		!nonNegative(value.duplicateCount) ||
		!isIso(value.lastObservedAt) || !isClaim(value.claim)) return false;
	const enqueued = Date.parse(value.enqueuedAt);
	if (Date.parse(value.detectedAt) > enqueued || Date.parse(value.staleAt) <= enqueued ||
		Date.parse(value.expiresAt) <= Date.parse(value.staleAt) ||
		Date.parse(value.lastObservedAt) < Date.parse(value.detectedAt) ||
		(value.acknowledgedAt !== null && Date.parse(value.acknowledgedAt) < enqueued) ||
		(value.lastSurfacedAt !== null && Date.parse(value.lastSurfacedAt) < enqueued) ||
		(value.acknowledgedAt === null && value.lastSurfacedAt !== null) ||
		(value.claim !== null && Date.parse(value.claim.claimedAt) < enqueued)) return false;
	if (value.phase === 'start') {
		return isRecord(value.binding) && exactKeys(value.binding, ['kind', 'ruleSetId', 'ruleSetVersion']) &&
			value.binding.kind === 'idle' && validId(value.binding.ruleSetId) && positive(value.binding.ruleSetVersion) &&
			isStartProposal(value.proposal) && value.proposalId === value.proposal.proposalId &&
			value.accountId === value.proposal.accountId && value.binding.ruleSetId === value.proposal.ruleSet.id &&
			value.binding.ruleSetVersion === value.proposal.ruleSet.version;
	}
	return isRecord(value.binding) && exactKeys(value.binding, ['kind', 'sessionId', 'baselineSnapshotId']) &&
		value.binding.kind === 'session' && validId(value.binding.sessionId) && validId(value.binding.baselineSnapshotId) &&
		isStopProposal(value.proposal) && value.proposalId === value.proposal.proposalId && value.accountId === value.proposal.accountId;
}

export function isProposalReceipt(value: unknown): value is ProposalReceipt {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'proposalId', 'outcome', 'resolvedAt', 'sessionId', 'correctionCause', 'correctionRecorded',
	])) return false;
	if (value.version !== 1 || !validId(value.proposalId) || !isIso(value.resolvedAt) ||
		(value.sessionId !== null && !validId(value.sessionId)) ||
		!['accepted', 'dismissed', 'superseded', 'expired', 'invalidated'].includes(value.outcome as string)) return false;
	if (value.outcome === 'dismissed') {
		return typeof value.correctionCause === 'string' &&
			['not_farming', 'still_farming', 'temporary_pause', 'unrelated_account_activity', 'other'].includes(value.correctionCause) &&
			typeof value.correctionRecorded === 'boolean';
	}
	return value.correctionCause === null && value.correctionRecorded === null &&
		(value.outcome === 'accepted' ? validId(value.sessionId) : value.sessionId === null);
}

export function normalizeProposalQueueRecord(value: unknown): PendingProposalQueueRecord | null {
	if (!isRecord(value) || !exactKeys(value, ['version', 'revision', 'proposals', 'receipts']) || value.version !== 1 ||
		!nonNegative(value.revision) ||
		!Array.isArray(value.proposals) || !value.proposals.every(isPendingProposal) ||
		!Array.isArray(value.receipts) || !value.receipts.every(isProposalReceipt)) return null;
	const proposals = value.proposals;
	const receipts = value.receipts;
	if (new Set(proposals.map((entry) => entry.proposalId)).size !== proposals.length ||
		new Set(receipts.map((entry) => entry.proposalId)).size !== receipts.length ||
		proposals.some((entry, index) => index > 0 && comparePendingProposals(proposals[index - 1]!, entry) >= 0)) return null;
	return structuredClone(value) as unknown as PendingProposalQueueRecord;
}

export function comparePendingProposals(a: PendingProposal, b: PendingProposal): number {
	return a.detectedAt.localeCompare(b.detectedAt) || a.proposalId.localeCompare(b.proposalId);
}

function isClaim(value: unknown): value is ProposalClaim | null {
	return value === null || (isRecord(value) && exactKeys(value, ['operationId', 'instanceId', 'claimedAt', 'expiresAt']) &&
		validId(value.operationId) && validId(value.instanceId) && isIso(value.claimedAt) && isIso(value.expiresAt) &&
		Date.parse(value.expiresAt) > Date.parse(value.claimedAt));
}

export function isRelevantStartProposal(value: unknown): value is RelevantStartProposal {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'proposalId', 'accountId', 'ruleSet', 'possibleStart', 'evidenceQuality',
		'confirmedAt', 'firstSignal', 'confirmationSignal',
	]) || value.version !== 1 || !validId(value.proposalId) || !validId(value.accountId) ||
		!isRecord(value.ruleSet) || !validId(value.ruleSet.id) || !positive(value.ruleSet.version) ||
		!isWindow(value.possibleStart) || !isIso(value.confirmedAt) ||
		(value.evidenceQuality !== 'complete' && value.evidenceQuality !== 'limited') ||
		!isRelevantSignal(value.firstSignal) || !isRelevantSignal(value.confirmationSignal)) return false;
	return value.possibleStart.uncertaintyMs ===
		Date.parse(value.possibleStart.to) - Date.parse(value.possibleStart.from) &&
		value.possibleStart.from === value.firstSignal.window.from &&
		value.possibleStart.to === value.firstSignal.window.to &&
		value.confirmedAt === value.confirmationSignal.window.to &&
		value.accountId === value.firstSignal.accountId && value.accountId === value.confirmationSignal.accountId &&
		value.firstSignal.afterSnapshotId === value.confirmationSignal.beforeSnapshotId;
}

const isStartProposal = isRelevantStartProposal;

function isStopProposal(value: unknown): value is InactivityStopProposal {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'proposalId', 'accountId', 'thresholdMs', 'possibleStop', 'quietSince', 'quietDurationMs',
		'detectedAt', 'evidenceQuality', 'lastGainSample', 'firstQuietSample', 'confirmationSample',
	]) || value.version !== 1 || !validId(value.proposalId) || !validId(value.accountId) ||
		!positive(value.thresholdMs) || !isWindow(value.possibleStop) || !isIso(value.quietSince) ||
		!positive(value.quietDurationMs) || !isIso(value.detectedAt) ||
		(value.evidenceQuality !== 'complete' && value.evidenceQuality !== 'limited') ||
		(value.lastGainSample !== null && !isInactivitySample(value.lastGainSample)) ||
		!isInactivitySample(value.firstQuietSample) || !isInactivitySample(value.confirmationSample)) return false;
	return value.possibleStop.uncertaintyMs ===
		Date.parse(value.possibleStop.to) - Date.parse(value.possibleStop.from) &&
		value.accountId === value.firstQuietSample.accountId && value.accountId === value.confirmationSample.accountId &&
		(value.lastGainSample === null || value.accountId === value.lastGainSample.accountId) &&
		value.quietSince === value.firstQuietSample.window.from &&
		value.detectedAt === value.confirmationSample.window.to &&
		value.quietDurationMs === Date.parse(value.detectedAt) - Date.parse(value.quietSince) &&
		value.quietDurationMs >= value.thresholdMs;
}

function isRelevantSignal(value: unknown): value is RelevantStartProposal['firstSignal'] {
	if (!isRecord(value) || !exactKeys(value, [
		'accountId', 'beforeSnapshotId', 'afterSnapshotId', 'window', 'deltaStatus', 'gains',
	]) || !validId(value.accountId) || !validId(value.beforeSnapshotId) || !validId(value.afterSnapshotId) ||
		value.beforeSnapshotId === value.afterSnapshotId || !isBoundaryWindow(value.window) ||
		(value.deltaStatus !== 'comparable' && value.deltaStatus !== 'limited') ||
		!Array.isArray(value.gains) || value.gains.length === 0) return false;
	let previous = 0;
	for (const gain of value.gains) {
		if (!isRecord(gain) || !exactKeys(gain, ['itemId', 'quantity']) || !positive(gain.itemId) ||
			!positive(gain.quantity) || gain.itemId <= previous) return false;
		previous = gain.itemId;
	}
	return true;
}

function isInactivitySample(value: unknown): value is InactivityStopProposal['firstQuietSample'] {
	return isRecord(value) && exactKeys(value, [
		'accountId', 'beforeSnapshotId', 'afterSnapshotId', 'window', 'relevantGainQuantity', 'evidenceQuality',
	]) && validId(value.accountId) && validId(value.beforeSnapshotId) && validId(value.afterSnapshotId) &&
		value.beforeSnapshotId !== value.afterSnapshotId && isBoundaryWindow(value.window) &&
		nonNegative(value.relevantGainQuantity) &&
		(value.evidenceQuality === 'complete' || value.evidenceQuality === 'limited');
}

function isBoundaryWindow(value: unknown): value is { from: string; to: string } {
	return isRecord(value) && exactKeys(value, ['from', 'to']) && isIso(value.from) && isIso(value.to) &&
		Date.parse(value.from) < Date.parse(value.to);
}

function isWindow(value: unknown): value is { from: string; to: string; uncertaintyMs: number } {
	return isRecord(value) && exactKeys(value, ['from', 'to', 'uncertaintyMs']) && isIso(value.from) && isIso(value.to) &&
		nonNegative(value.uncertaintyMs) && Date.parse(value.from) < Date.parse(value.to);
}

function nullableIso(value: unknown): value is string | null { return value === null || isIso(value); }
function isIso(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
