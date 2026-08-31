import type { DetectionCorrectionCause, DetectionEvidenceQuality, DetectionPhase } from './session-detection-quality';

export const PILOT_METRICS_VERSION = 1 as const;
export const PILOT_PLATFORMS = ['linux_steam_proton', 'macos_crossover', 'windows_beta'] as const;
export const PILOT_METRICS_MAX_OBSERVATIONS = 10_000;
export const PILOT_RECOVERY_KINDS = ['forced_restart', 'organic'] as const;
export const PILOT_SILENT_LOSS_REVIEWS = ['unreviewed', 'none_observed', 'observed'] as const;

export type PilotPlatform = typeof PILOT_PLATFORMS[number];
export type PilotJournalHealth = 'ready' | 'unavailable' | 'inconsistent' | 'full';
export type PilotRecoveryKind = typeof PILOT_RECOVERY_KINDS[number];
export type PilotSilentLossReview = typeof PILOT_SILENT_LOSS_REVIEWS[number];
export type PilotProposalMode = 'assisted';

export interface PilotBoundaryWindowV1 {
	from: string;
	to: string;
	uncertaintyMs: number;
}

/** Device-local pilot profile. Version strings are strata, never account identity. */
export interface PilotEnvironmentV1 {
	version: typeof PILOT_METRICS_VERSION;
	platform: PilotPlatform;
	platformVersion: string;
	obsidianVersion: string;
	tyrianVersion: string;
}

export interface PilotProposalTerminalV1 {
	status: 'decided' | 'excluded';
	decidedAt: string;
	decision: 'dismissed' | 'accepted' | null;
	effectiveResult: 'dismissed' | 'accepted_workflow_succeeded' | 'accepted_workflow_failed' | null;
	correctionCause: DetectionCorrectionCause | null;
	/** Explicit human adjudication only. Null is not inferred from detector or click time. */
	humanBoundaryAt: string | null;
	/** Operational closure outside human review; published separately from accuracy and coverage. */
	exclusionReason: 'expired' | 'superseded' | 'invalidated' | null;
}

export interface PilotProposalObservationV1 {
	version: typeof PILOT_METRICS_VERSION;
	kind: 'proposal';
	/** Domain-separated SHA-256 pseudonym. It is stable, but is not anonymization. */
	proposalRef: string;
	phase: DetectionPhase;
	mode: PilotProposalMode;
	reviewPresentedAt: string;
	window: PilotBoundaryWindowV1;
	/** Null only for legacy queued proposals that predate the generation-time snapshot. */
	pollingIntervalMs: number | null;
	evidenceQuality: DetectionEvidenceQuality;
	environment: PilotEnvironmentV1;
	terminal: PilotProposalTerminalV1 | null;
}

export interface PilotSessionObservationV1 {
	version: typeof PILOT_METRICS_VERSION;
	kind: 'session';
	/** Local pseudonym used only for idempotency; detail exports omit it. */
	sessionRef: string;
	startedAt: string;
	completedAt: string | null;
	environment: PilotEnvironmentV1;
}

export interface PilotRecoveryObservationV1 {
	version: typeof PILOT_METRICS_VERSION;
	kind: 'recovery';
	/** Local pseudonym used only for idempotency; detail exports omit it. */
	recoveryRef: string;
	presentedAt: string;
	/** Explicit human classification only; never inferred from runtime state. */
	recoveryKind: PilotRecoveryKind | null;
	terminal: { outcome: 'succeeded' | 'failed' | 'discarded'; recordedAt: string } | null;
	environment: PilotEnvironmentV1;
}

export type PilotObservationV1 =
	| PilotProposalObservationV1
	| PilotSessionObservationV1
	| PilotRecoveryObservationV1;

export interface PilotJournalSnapshotV1 {
	version: typeof PILOT_METRICS_VERSION;
	profile: PilotEnvironmentV1;
	/** Monotonic token for the exact profile and evidence sample in this snapshot. */
	sampleRevision: number;
	verification: PilotVerificationV1 | null;
	observations: PilotObservationV1[];
}

export interface PilotVerificationV1 {
	version: typeof PILOT_METRICS_VERSION;
	silentLosses: PilotSilentLossReview;
	reviewedAt: string;
	/** Exact local environment whose current sample was reviewed. */
	environment: PilotEnvironmentV1;
	/** The exact sample revision adjudicated by the human. */
	sampleRevision: number;
}

export function createPilotEnvironment(input: Omit<PilotEnvironmentV1, 'version'>): PilotEnvironmentV1 | null {
	const candidate: PilotEnvironmentV1 = { version: PILOT_METRICS_VERSION, ...input };
	return isPilotEnvironment(candidate) ? candidate : null;
}

export function isPilotEnvironment(value: unknown): value is PilotEnvironmentV1 {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'platform', 'platformVersion', 'obsidianVersion', 'tyrianVersion',
	])) return false;
	return value.version === PILOT_METRICS_VERSION &&
		PILOT_PLATFORMS.includes(value.platform as PilotPlatform) &&
		validPlatformVersion(value.platformVersion) && validVersion(value.obsidianVersion) && validVersion(value.tyrianVersion);
}

export function isPilotVerification(value: unknown): value is PilotVerificationV1 {
	return isRecord(value) && exactKeys(value, ['version', 'silentLosses', 'reviewedAt', 'environment', 'sampleRevision']) &&
		value.version === PILOT_METRICS_VERSION &&
		PILOT_SILENT_LOSS_REVIEWS.includes(value.silentLosses as PilotSilentLossReview) && isIso(value.reviewedAt) &&
		isPilotEnvironment(value.environment) && isSampleRevision(value.sampleRevision);
}

/** Released schema compatibility: an old review is readable but never trusted for a revised sample. */
export function isLegacyPilotVerification(value: unknown): boolean {
	return isRecord(value) && exactKeys(value, ['version', 'silentLosses', 'reviewedAt', 'environment']) &&
		value.version === PILOT_METRICS_VERSION &&
		PILOT_SILENT_LOSS_REVIEWS.includes(value.silentLosses as PilotSilentLossReview) && isIso(value.reviewedAt) &&
		isPilotEnvironment(value.environment);
}

export function isSampleRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPilotObservation(value: unknown): value is PilotObservationV1 {
	if (!isRecord(value) || value.version !== PILOT_METRICS_VERSION || !isPilotEnvironment(value.environment)) return false;
	if (value.kind === 'proposal') return isProposal(value);
	if (value.kind === 'session') return isSession(value);
	if (value.kind === 'recovery') return isRecovery(value);
	return false;
}

export async function pilotProposalRef(proposalId: string): Promise<string> {
	return await domainHash('tyrian-pilot-proposal-v1', proposalId);
}

export async function pilotSessionRef(sessionId: string): Promise<string> {
	return await domainHash('tyrian-pilot-session-v1', sessionId);
}

export async function pilotRecoveryRef(localId: string): Promise<string> {
	return await domainHash('tyrian-pilot-recovery-v1', localId);
}

export function pilotObservationKey(observation: PilotObservationV1): string {
	if (observation.kind === 'proposal') return `proposal:${observation.proposalRef}`;
	if (observation.kind === 'session') return `session:${observation.sessionRef}`;
	return `recovery:${observation.recoveryRef}`;
}

function isProposal(value: Record<string, unknown>): value is Record<string, unknown> & PilotProposalObservationV1 {
	if (!exactKeys(value, [
		'version', 'kind', 'proposalRef', 'phase', 'mode', 'reviewPresentedAt', 'window',
		'pollingIntervalMs', 'evidenceQuality', 'environment', 'terminal',
	]) || !sha256Ref(value.proposalRef) || (value.phase !== 'start' && value.phase !== 'stop') ||
		value.mode !== 'assisted' || !isIso(value.reviewPresentedAt) || !isWindow(value.window) ||
		(value.pollingIntervalMs !== null &&
			(!Number.isSafeInteger(value.pollingIntervalMs) || (value.pollingIntervalMs as number) <= 0)) ||
		(value.evidenceQuality !== 'complete' && value.evidenceQuality !== 'limited')) return false;
	return value.terminal === null || isProposalTerminal(value.terminal, value);
}

function isProposalTerminal(value: unknown, proposal: Record<string, unknown>): value is PilotProposalTerminalV1 {
	if (!isRecord(value) || !exactKeys(value, [
		'status', 'decidedAt', 'decision', 'effectiveResult', 'correctionCause', 'humanBoundaryAt', 'exclusionReason',
	]) || (value.status !== 'decided' && value.status !== 'excluded') || !isIso(value.decidedAt) ||
		!isIso(proposal.reviewPresentedAt) || Date.parse(value.decidedAt) < Date.parse(proposal.reviewPresentedAt) ||
		(value.humanBoundaryAt !== null && !isIso(value.humanBoundaryAt))) return false;
	if (value.status === 'excluded') {
		return value.decision === null && value.effectiveResult === null && value.correctionCause === null &&
			value.humanBoundaryAt === null &&
			['expired', 'superseded', 'invalidated'].includes(value.exclusionReason as string);
	}
	if (value.exclusionReason !== null) return false;
	if (value.decision === 'dismissed') {
		return value.effectiveResult === 'dismissed' && typeof value.correctionCause === 'string' &&
			allowedCause(proposal.phase, value.correctionCause);
	}
	return value.decision === 'accepted' &&
		(value.effectiveResult === 'accepted_workflow_succeeded' || value.effectiveResult === 'accepted_workflow_failed') &&
		value.correctionCause === null;
}

function allowedCause(phase: unknown, cause: string): boolean {
	return phase === 'start'
		? ['not_farming', 'unrelated_account_activity', 'other'].includes(cause)
		: phase === 'stop' && ['still_farming', 'temporary_pause', 'unrelated_account_activity', 'other'].includes(cause);
}

function isSession(value: Record<string, unknown>): value is Record<string, unknown> & PilotSessionObservationV1 {
	return exactKeys(value, ['version', 'kind', 'sessionRef', 'startedAt', 'completedAt', 'environment']) &&
		sha256Ref(value.sessionRef) && isIso(value.startedAt) &&
		(value.completedAt === null || (isIso(value.completedAt) &&
			Date.parse(value.completedAt) >= Date.parse(value.startedAt)));
}

function isRecovery(value: Record<string, unknown>): value is Record<string, unknown> & PilotRecoveryObservationV1 {
	if (!exactKeys(value, ['version', 'kind', 'recoveryRef', 'presentedAt', 'recoveryKind', 'terminal', 'environment']) ||
		!sha256Ref(value.recoveryRef) || !isIso(value.presentedAt)) return false;
	if (value.recoveryKind !== null && !PILOT_RECOVERY_KINDS.includes(value.recoveryKind as PilotRecoveryKind)) return false;
	if (value.terminal === null) return true;
	return isRecord(value.terminal) && exactKeys(value.terminal, ['outcome', 'recordedAt']) &&
		['succeeded', 'failed', 'discarded'].includes(value.terminal.outcome as string) &&
		isIso(value.terminal.recordedAt) &&
		Date.parse(value.terminal.recordedAt) >= Date.parse(value.presentedAt);
}

function isWindow(value: unknown): value is PilotBoundaryWindowV1 {
	return isRecord(value) && exactKeys(value, ['from', 'to', 'uncertaintyMs']) && isIso(value.from) && isIso(value.to) &&
		Number.isSafeInteger(value.uncertaintyMs) && (value.uncertaintyMs as number) >= 0 &&
		Date.parse(value.to) >= Date.parse(value.from) &&
		value.uncertaintyMs === Date.parse(value.to) - Date.parse(value.from);
}

function validPlatformVersion(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 32 &&
		/^[A-Za-z0-9]+(?:[._+-][A-Za-z0-9]+)*$/u.test(value);
}

function validVersion(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._+ -]*$/u.test(value);
}

function sha256Ref(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

async function domainHash(domain: string, value: string): Promise<string> {
	if (value.length === 0 || value.length > 512) throw new Error('Pilot metric identifier is invalid.');
	const bytes = new TextEncoder().encode(`${domain}\0${value}`);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isIso(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
