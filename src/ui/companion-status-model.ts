import type { ConnectionState } from '../account/connection-service';
import type { DetectionMode } from '../core/settings';
import { createTranslator, type Locale } from '../core/i18n';
import { translateRuntime, type RuntimeTranslationKey } from '../core/i18n-runtime-catalog';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { ApiPollSchedulerState } from '../sessions/api-poll-scheduler';
import type { SessionState } from '../sessions/session';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageDeltaStatus } from '../account/storage-delta-model';
import type { SessionClassificationStatus } from '../account/contamination-model';
import type {
	SessionStartFailure,
	SessionStopFailure,
} from '../sessions/manual-session-start-service';
import type {
	DetectionQualityStats,
	SessionDetectionQualitySummary,
} from '../sessions/session-detection-quality';
import type { DetectionQualityRecorderState } from '../sessions/session-detection-quality-recorder';
import type { SessionContaminationReview } from '../sessions/session-contamination-review';
import type { SessionRecoveryState } from '../sessions/manual-session-start-service';
import type { ProposalQueueState } from '../sessions/pending-proposal-service';

export type CompanionStatusTone = 'quiet' | 'active' | 'good' | 'warning' | 'error';

export interface CompanionStatusItem {
	id: 'detection' | 'session' | 'polling' | 'quality';
	label: string;
	value: string;
	detail: string;
	tone: CompanionStatusTone;
}

export interface CompanionStatusProjection {
	locale: Locale;
	connection: { value: string; tone: CompanionStatusTone };
	items: CompanionStatusItem[];
	errors: string[];
	incidentTone: 'warning' | 'error' | null;
	refreshEveryMs: 1_000 | null;
}

export interface CompanionStatusInput {
	/** UI locale only; domain state remains locale-neutral. */
	locale?: Locale;
	now: number;
	connection: ConnectionState;
	session: SessionState;
	detectionMode: DetectionMode;
	detection: AssistedDetectionState;
	qualityState: DetectionQualityRecorderState;
	qualityStats: DetectionQualityStats | null;
	sessionQuality: SessionDetectionQualitySummary | null;
	delta: StorageDelta | null;
	review: SessionContaminationReview | null;
	recovery: SessionRecoveryState;
	startFailure: SessionStartFailure | null;
	stopFailure: SessionStopFailure | null;
	pendingProposals?: ProposalQueueState;
}

/** Pure H5.1 projection used by the note-independent status view. */
export function buildCompanionStatus(input: CompanionStatusInput): CompanionStatusProjection {
	const locale = input.locale ?? 'en';
	const t = (key: RuntimeTranslationKey, params?: Record<string, string | number>) =>
		translateRuntime(createTranslator(locale), key, params);
	const connection = connectionStatus(input.connection, t);
	const detection = detectionStatus(input.detectionMode, input.detection, t);
	const baseSession = sessionStatus(input.session, input.now, t);
	const session = recoverySessionStatus(input.recovery, baseSession, t);
	const polling = pollingStatus(input.detectionMode, input.detection, input.now, t);
	const quality = qualityStatus(input.qualityState, input.qualityStats, input.sessionQuality, input.detection, input.delta, input.review, t);
	const errors = statusErrors(input, t);
	const refreshEveryMs = session.live || polling.live || hasLiveConnectionCountdown(input.connection, input.now)
		? 1_000 : null;
	return {
		locale,
		connection,
		items: [detection.item, session.item, polling.item, quality],
		errors,
		incidentTone: errors.length === 0 ? null : hasErrorIncident(input) ? 'error' : 'warning',
		refreshEveryMs,
	};
}

function recoverySessionStatus(
	recovery: SessionRecoveryState,
	fallback: { item: CompanionStatusItem; live: boolean },
	t: StatusText,
): { item: CompanionStatusItem; live: boolean } {
	if (recovery.status === 'none') return fallback;
	if (recovery.status === 'available') {
		return { item: item('session', t('status.session'), t('status.recoveryAvailable'), t('status.recoveryAvailableDetail'), 'warning'), live: false };
	}
	if (recovery.status === 'busy') {
		return { item: item('session', t('status.session'), t('status.recoveryBlocked'), t('status.recoveryOwner'), 'error'), live: false };
	}
	if (recovery.status === 'working') {
		return { item: item('session', t('status.session'), recovery.action === 'recover' ? t('status.recovering') : t('status.discarding'), t('status.recoveryWorking'), 'active'), live: false };
	}
	if (recovery.status === 'error') {
		return { item: item('session', t('status.session'), t('status.recoveryError'), t('status.operationFailed'), 'error'), live: false };
	}
	return fallback;
}

function connectionStatus(state: ConnectionState, t: StatusText): CompanionStatusProjection['connection'] {
	if (state.status === 'connected') return { value: t('status.connected'), tone: 'good' };
	if (state.status === 'warning') return { value: t('status.attention'), tone: 'warning' };
	if (state.status === 'checking') return { value: t('status.checking'), tone: 'active' };
	if (state.status === 'error') return { value: t('status.offline'), tone: 'error' };
	return { value: t('status.notChecked'), tone: 'quiet' };
}

function detectionStatus(
	mode: DetectionMode,
	state: AssistedDetectionState,
	t: StatusText,
): { item: CompanionStatusItem } {
	if (mode === 'off') return { item: item('detection', t('status.detection'), t('status.off'), t('status.enableDetection'), 'quiet') };
	const values: Record<AssistedDetectionState['status'], Pick<CompanionStatusItem, 'value' | 'detail' | 'tone'>> = {
		disarmed: { value: t('status.disarmed'), detail: t('status.noPolling'), tone: 'quiet' },
		arming: { value: t('status.arming'), detail: t('status.capturingBaseline'), tone: 'active' },
		armed: { value: t('status.armed'), detail: t('status.watchingSignals'), tone: 'good' },
		start_proposed: { value: t('status.startProposed'), detail: t('status.waitingReview'), tone: 'warning' },
		stop_proposed: { value: t('status.stopProposed'), detail: t('status.waitingReview'), tone: 'warning' },
		error: { value: t('status.error'), detail: t('status.detectionStopped'), tone: 'error' },
	};
	const value = values[state.status];
	return { item: item('detection', t('status.detection'), value.value, value.detail, value.tone) };
}

type StatusText = (key: RuntimeTranslationKey, params?: Record<string, string | number>) => string;

export function localizedDeltaStatus(status: StorageDeltaStatus, t: StatusText): string {
	const keys: Record<StorageDeltaStatus, RuntimeTranslationKey> = {
		comparable: 'enum.delta.comparable', limited: 'enum.delta.limited', invalid: 'enum.delta.invalid',
	};
	return t(keys[status]);
}

/** Translates the closed evidence-coverage value before it reaches the status UI. */
export function localizedCoverageStatus(
	status: 'complete' | 'limited' | 'unknown',
	t: StatusText,
): string {
	const keys: Record<'complete' | 'limited' | 'unknown', RuntimeTranslationKey> = {
		complete: 'enum.coverage.complete', limited: 'enum.coverage.limited', unknown: 'enum.coverage.unknown',
	};
	return t(keys[status]);
}

export function localizedClassificationStatus(status: SessionClassificationStatus, t: StatusText): string {
	const keys: Record<SessionClassificationStatus, RuntimeTranslationKey> = {
		exact: 'enum.classification.exact', estimated: 'enum.classification.estimated',
		contaminated: 'enum.classification.contaminated', invalid: 'enum.classification.invalid',
	};
	return t(keys[status]);
}

export function localizedConfidence(status: 'high' | 'medium' | 'low', t: StatusText): string {
	const keys: Record<'high' | 'medium' | 'low', RuntimeTranslationKey> = {
		high: 'enum.confidence.high', medium: 'enum.confidence.medium', low: 'enum.confidence.low',
	};
	return t(keys[status]);
}

/** Every session phase that already holds a baseline, and therefore a measurable duration. */
type MeasuredSessionState = Extract<
	SessionState,
	{ status: 'active' | 'stopping' | 'provisional' | 'complete' }
>;

/**
 * Instant the played window closes, which is the only end this projection is allowed to measure
 * against.
 *
 * The durable note bills `stoppedAt − baseline.completedAt` through `sessionPlayedDurationMs`,
 * never the instant the final snapshot managed to read the account: the API settlement window
 * holds those up to ten minutes apart on purpose. Closing the window on the capture instead
 * would make this card announce seventy minutes for the hour the note publishes, so both
 * surfaces close it on the same human boundary. `companion-status-played-duration.test.ts`
 * compares the two and goes red if they ever drift apart again.
 */
function playedUntil(state: MeasuredSessionState, now: number): number {
	if (state.status === 'active') return now;
	// `confirm_stop` records `stoppedAt` as the stop *request*, so both names read the same instant.
	return Date.parse(state.status === 'stopping' ? state.stopRequestedAt : state.stoppedAt);
}

function sessionStatus(
	state: SessionState,
	now: number,
	t: StatusText,
): { item: CompanionStatusItem; live: boolean } {
	if (state.status === 'idle') {
		return { item: item('session', t('status.session'), t('status.idle'), t('status.noActiveSession'), 'quiet'), live: false };
	}
	if (state.status === 'starting') {
		return { item: item('session', t('status.session'), t('status.starting'), t('status.capturingBuild'), 'active'), live: false };
	}
	if (state.status === 'error') {
		const observed = state.failedState;
		const duration = 'baseline' in observed
			? formatElapsed(safeElapsed(Date.parse(observed.baseline.completedAt), Date.parse(state.failedAt)))
			: null;
		return {
			item: item('session', t('status.session'), t('status.error'), duration ? t('status.observedBeforeError', { duration }) : sessionFailureLabel(state.code, t), 'error'),
			live: false,
		};
	}
	// A stopping session keeps ticking even though its duration below is already frozen: the
	// settlement countdown beside it is what the second still repaints.
	const live = state.status === 'active' || state.status === 'stopping';
	const elapsed = elapsedOrNull(Date.parse(state.baseline.completedAt), playedUntil(state, now));
	const duration = elapsed === null ? '—' : formatElapsed(elapsed);
	if (state.status === 'active') {
		return { item: item('session', t('status.session'), t('status.active'), t('status.activeDetail', { duration, character: state.startContext.characterName }), 'good'), live };
	}
	if (state.status === 'stopping') {
		return { item: item('session', t('status.session'), t('status.stopping'), t('status.stoppingDetail', { duration }), 'active'), live };
	}
	if (state.status === 'provisional') {
		return { item: item('session', t('status.session'), t('status.reviewNeeded'), t('status.reviewDetail', { duration }), 'warning'), live };
	}
	return {
		item: item('session', t('status.session'), t('status.complete'), t('status.completeDetail', {
			duration,
			classification: localizedClassificationStatus(state.classification, t),
		}), 'good'),
		live,
	};
}

function pollingStatus(
	mode: DetectionMode,
	detection: AssistedDetectionState,
	now: number,
	t: StatusText,
): { item: CompanionStatusItem; live: boolean } {
	if (mode === 'off') return { item: item('polling', t('status.polling'), t('status.off'), t('status.enableDetection'), 'quiet'), live: false };
	if (detection.status === 'disarmed') {
		return { item: item('polling', t('status.polling'), t('status.stopped'), t('status.armToBegin'), 'quiet'), live: false };
	}
	if (detection.status === 'arming') {
		return { item: item('polling', t('status.polling'), t('status.waiting'), t('status.startsAfterBaseline'), 'active'), live: false };
	}
	if (detection.status === 'error') {
		return { item: item('polling', t('status.polling'), t('status.stopped'), t('status.detectionAttention'), 'error'), live: false };
	}
	if (detection.status === 'start_proposed' || detection.status === 'stop_proposed') {
		return { item: item('polling', t('status.polling'), t('status.paused'), appendLastSnapshot(t('status.reviewProposal'), detection.lastSnapshotAt, now, t), 'warning'), live: false };
	}
	return schedulerStatus(detection.scheduler, detection.lastSnapshotAt, now, t);
}

function schedulerStatus(
	state: ApiPollSchedulerState,
	lastSnapshotAt: string | null,
	now: number,
	t: StatusText,
): { item: CompanionStatusItem; live: boolean } {
	const interval = state.intervalMs === null ? t('status.noInterval') : t('status.every', { duration: formatCompactDuration(state.intervalMs) });
	if (state.status === 'scheduled') {
		const next = state.nextRunAt === null ? interval : t('status.nextIn', { duration: formatCompactDuration(Math.max(0, state.nextRunAt - now)) });
		return { item: item('polling', t('status.polling'), t('status.scheduled'), appendLastSnapshot(`${interval} · ${next}`, lastSnapshotAt, now, t), 'good'), live: state.nextRunAt !== null };
	}
	if (state.status === 'polling') return { item: item('polling', t('status.polling'), t('status.checkingNow'), appendLastSnapshot(interval, lastSnapshotAt, now, t), 'active'), live: true };
	if (state.status === 'paused_offline') return { item: item('polling', t('status.polling'), t('status.offline'), appendLastSnapshot(`${interval} · ${t('status.resumesOnline')}`, lastSnapshotAt, now, t), 'warning'), live: false };
	if (state.status === 'paused_sleep') return { item: item('polling', t('status.polling'), t('status.resuming'), appendLastSnapshot(`${interval} · ${t('status.deviceWoke')}`, lastSnapshotAt, now, t), 'warning'), live: true };
	if (state.status === 'backoff') {
		const retry = state.nextRunAt === null ? t('status.retryPending') : t('status.retryIn', { duration: formatCompactDuration(Math.max(0, state.nextRunAt - now)) });
		return { item: item('polling', t('status.polling'), t('status.backingOff'), appendLastSnapshot(`${retry} · ${t('status.failures', { count: state.consecutiveFailures })}`, lastSnapshotAt, now, t), 'warning'), live: state.nextRunAt !== null };
	}
	if (state.status === 'fatal') return { item: item('polling', t('status.polling'), t('status.failed'), t('status.disarmTryAgain'), 'error'), live: false };
	if (state.status === 'disposed') return { item: item('polling', t('status.polling'), t('status.unavailable'), t('status.pollingClosed'), 'error'), live: false };
	return { item: item('polling', t('status.polling'), t('status.idle'), interval, 'quiet'), live: false };
}

function qualityStatus(
	state: DetectionQualityRecorderState,
	stats: DetectionQualityStats | null,
	session: SessionDetectionQualitySummary | null,
	detection: AssistedDetectionState,
	delta: StorageDelta | null,
	review: SessionContaminationReview | null,
	t: StatusText,
): CompanionStatusItem {
	if (review) {
		if (review.classification.status === 'invalid') return item('quality', t('status.quality'), t('status.unavailable'), t('status.invalidReview'), 'error');
		const complete = review.classification.status === 'exact';
		return item('quality', t('status.quality'), complete ? t('status.complete') : t('status.limited'), t('status.reviewed', { status: localizedClassificationStatus(review.classification.status, t) }), complete ? 'good' : 'warning');
	}
	if (delta) {
		if (delta.status === 'invalid') return item('quality', t('status.quality'), t('status.unavailable'), t('status.invalidStorage'), 'error');
		return item('quality', t('status.quality'), delta.status === 'comparable' ? t('status.complete') : t('status.limited'), t('status.storageComparison', { status: localizedDeltaStatus(delta.status, t) }), delta.status === 'comparable' ? 'good' : 'warning');
	}
	const proposalQuality = currentEvidenceQuality(detection);
	if (proposalQuality !== null) {
		return item('quality', t('status.quality'), localizedCoverageStatus(proposalQuality, t),
			proposalQuality === 'complete' ? t('status.completeEvidence') : t('status.incompleteEvidence'),
			proposalQuality === 'complete' ? 'good' : 'warning');
	}
	if (session) {
		const recordedQuality = sessionEvidenceQuality(session);
		return item(
			'quality',
			t('status.quality'),
			recordedQuality === null ? detectionModeLabel(session.mode, t) : recordedQuality === 'complete' ? t('status.complete') : t('status.limited'),
			t('status.qualityDetail', { duration: formatCompactDuration(session.totalUncertaintyMs), count: session.correctedFalsePositives.length }),
			recordedQuality === 'limited' || session.mode === 'incomplete' ? 'warning' : 'good',
		);
	}
	if (state.status === 'loading') return item('quality', t('status.quality'), t('status.loading'), t('status.readingMeasurements'), 'active');
	if (state.status === 'unavailable') return item('quality', t('status.quality'), t('status.unavailable'), t('status.sessionControlsWork'), 'error');
	if (!stats || (stats.acceptedBoundaries === 0 && stats.correctedFalsePositives === 0)) {
		return item('quality', t('status.quality'), t('status.noSample'), t('status.noMeasurements'), 'quiet');
	}
	return item(
		'quality',
		t('status.quality'),
		t('status.boundaries', { count: stats.acceptedBoundaries }),
		t('status.corrected', { count: stats.correctedFalsePositives }),
		'good',
	);
}

function statusErrors(input: CompanionStatusInput, t: StatusText): string[] {
	const errors: string[] = [];
	if (input.pendingProposals?.status === 'unavailable') errors.push(t('status.confirmationsIncident', { detail: t('status.unavailable') }));
	if (input.pendingProposals?.status === 'ready' && input.pendingProposals.pendingCount > 0) {
		errors.push(t('status.confirmationsIncident', {
			detail: t(input.pendingProposals.pendingCount === 1 ? 'status.pendingProposal' : 'status.pendingProposals', { count: input.pendingProposals.pendingCount }),
		}));
	}
	if (input.recovery.status === 'available') {
		errors.push(t('status.recoveryIncident', { detail: t('status.recoveryAvailableDetail') }));
	}
	if (input.recovery.status === 'error') errors.push(t('status.recoveryIncident', { detail: t('status.operationFailed') }));
	if (input.recovery.status === 'busy') errors.push(t('status.recoveryIncident', { detail: t('status.recoveryOwner') }));
	if (input.session.status === 'error') errors.push(t('status.sessionIncident', { detail: sessionFailureLabel(input.session.code, t) }));
	if (input.startFailure) errors.push(t('status.startIncident', { detail: startFailureLabel(input.startFailure.code, t) }));
	if (input.stopFailure) errors.push(t('status.stopIncident', { detail: stopFailureLabel(input.stopFailure.code, t) }));
	if (sessionHasClockIncident(input.session, input.now)) errors.push(t('status.sessionIncident', { detail: t('status.clockInvalid') }));
	if (input.review?.classification.status === 'invalid' || input.delta?.status === 'invalid') errors.push(t('status.qualityIncident', { detail: t('status.capturedEvidenceInvalid') }));
	if (input.detectionMode !== 'off' && input.detection.status === 'error') errors.push(t('status.detectionIncident', { detail: t('status.detectionStopped') }));
	if (input.detectionMode !== 'off' && input.detection.scheduler.status === 'fatal') errors.push(t('status.pollingFatal'));
	if (input.connection.status === 'error') errors.push(t('status.connectionIncident', { detail: connectionFailureLabel(input.connection.code, t) }));
	if (input.connection.status === 'warning') errors.push(t('status.connectionIncident', { detail: t('status.attention') }));
	if ((input.connection.status === 'warning' || input.connection.status === 'error') && hasLiveConnectionCountdown(input.connection, input.now)) errors.push(t('status.connectionIncident', { detail: t('status.cooldownActive') }));
	if (input.qualityState.status === 'unavailable') errors.push(t('status.qualityIncident', { detail: t('status.unavailable') }));
	if ((input.connection.status === 'connected' || input.connection.status === 'warning') && input.connection.details.missingRecommendedScopes.length > 0) {
		errors.push(t('status.accountIncident', { detail: t('status.futurePermissionsMissing', { count: input.connection.details.missingRecommendedScopes.length }) }));
	}
	return [...new Set(errors)];
}

/** Keeps open-ended connection failures closed instead of exposing transport messages. */
function connectionFailureLabel(_code: string, t: StatusText): string {
	return t('status.operationFailed');
}

/** Exhaustive translation-key contract for every failure returned by manual start. */
const START_FAILURE_LABELS = {
	busy: 'status.startFailure.busy',
	coordination_unavailable: 'status.startFailure.coordination_unavailable',
	invalid_input: 'status.startFailure.invalid_input',
	missing_capability: 'status.startFailure.missing_capability',
	snapshot_failed: 'status.startFailure.snapshot_failed',
	lease_lost: 'status.startFailure.lease_lost',
	rate_limited: 'status.startFailure.rate_limited',
	unexpected: 'status.startFailure.unexpected',
} satisfies Record<SessionStartFailure['code'], RuntimeTranslationKey>;

/** Exhaustive translation-key contract for every failure returned by manual stop. */
const STOP_FAILURE_LABELS = {
	coordination_unavailable: 'status.stopFailure.coordination_unavailable',
	snapshot_failed: 'status.stopFailure.snapshot_failed',
	lease_lost: 'status.stopFailure.lease_lost',
	delta_invalid: 'status.stopFailure.delta_invalid',
	rate_limited: 'status.stopFailure.rate_limited',
	unexpected: 'status.stopFailure.unexpected',
} satisfies Record<SessionStopFailure['code'], RuntimeTranslationKey>;

/** Maps every closed start failure to safe, actionable surface copy. */
function startFailureLabel(code: SessionStartFailure['code'], t: StatusText): string {
	return t(START_FAILURE_LABELS[code]);
}

/** Maps every closed stop failure to safe, actionable surface copy. */
function stopFailureLabel(code: SessionStopFailure['code'], t: StatusText): string {
	return t(STOP_FAILURE_LABELS[code]);
}

function hasErrorIncident(input: CompanionStatusInput): boolean {
	return input.pendingProposals?.status === 'unavailable'
		|| input.recovery.status === 'error'
		|| input.recovery.status === 'busy'
		|| input.session.status === 'error'
		|| input.startFailure !== null
		|| input.stopFailure !== null
		|| sessionHasClockIncident(input.session, input.now)
		|| input.review?.classification.status === 'invalid'
		|| input.delta?.status === 'invalid'
		|| (input.detectionMode !== 'off' && input.detection.status === 'error')
		|| (input.detectionMode !== 'off' && input.detection.scheduler.status === 'fatal')
		|| input.connection.status === 'error'
		|| input.qualityState.status === 'unavailable';
}

function hasLiveConnectionCountdown(state: ConnectionState, now: number): boolean {
	return (state.status === 'warning' || state.status === 'error') && state.retryAt !== null && state.retryAt > now;
}

function currentEvidenceQuality(state: AssistedDetectionState): 'complete' | 'limited' | null {
	if (state.status === 'start_proposed' || state.status === 'stop_proposed') {
		return state.proposal.evidenceQuality;
	}
	return null;
}

function sessionEvidenceQuality(summary: SessionDetectionQualitySummary): 'complete' | 'limited' | null {
	const evidence = [summary.start?.evidenceQuality, summary.stop?.evidenceQuality]
		.filter((quality): quality is 'complete' | 'limited' => quality !== null && quality !== undefined);
	if (evidence.includes('limited')) return 'limited';
	return evidence.includes('complete') ? 'complete' : null;
}

function appendLastSnapshot(detail: string, lastSnapshotAt: string | null, now: number, t: StatusText): string {
	if (lastSnapshotAt === null) return `${detail} · ${t('status.noSnapshot')}`;
	return `${detail} · ${t('status.lastSnapshot', { duration: formatCompactDuration(safeElapsed(Date.parse(lastSnapshotAt), now)) })}`;
}

function item(
	id: CompanionStatusItem['id'],
	label: string,
	value: string,
	detail: string,
	tone: CompanionStatusTone,
): CompanionStatusItem {
	return { id, label, value, detail, tone };
}

function sessionFailureLabel(code: Extract<SessionState, { status: 'error' }>['code'], t: StatusText): string {
	const labels: Record<typeof code, RuntimeTranslationKey> = {
		lease_lost: 'status.failure.lease_lost', snapshot_failed: 'status.failure.snapshot_failed',
		storage_unavailable: 'status.failure.storage_unavailable', classification_invalid: 'status.failure.classification_invalid',
		cancelled: 'status.failure.cancelled', unexpected: 'status.failure.unexpected',
	};
	return t(labels[code]);
}

function detectionModeLabel(mode: SessionDetectionQualitySummary['mode'], t: StatusText): string {
	const labels: Record<typeof mode, RuntimeTranslationKey> = {
		manual: 'detection.mode.manual', assisted: 'detection.mode.assisted', mixed: 'detection.mode.mixed', incomplete: 'detection.mode.incomplete',
	};
	return t(labels[mode]);
}

function safeElapsed(start: number, end: number): number {
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(end - start));
}

function elapsedOrNull(start: number, end: number): number | null {
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(end - start));
}

/**
 * Raises the incident on the same pair the card prints, so a boundary the projection cannot read
 * can never show up as a silent «—» with no warning beside it.
 */
function sessionHasClockIncident(state: SessionState, now: number): boolean {
	if (state.status === 'idle' || state.status === 'starting') return false;
	if (state.status !== 'error') {
		return elapsedOrNull(Date.parse(state.baseline.completedAt), playedUntil(state, now)) === null;
	}
	const failed = state.failedState;
	if (!('baseline' in failed)) return false;
	// A failed session declares the *observed* time before the error, so its check keeps that pair.
	const end = failed.status === 'provisional'
		? Date.parse(failed.finalSnapshot.completedAt) : Date.parse(state.failedAt);
	return elapsedOrNull(Date.parse(failed.baseline.completedAt), end) === null;
}

export function formatElapsed(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor(totalSeconds % 3_600 / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatCompactDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.ceil(durationMs / 1_000));
	if (seconds < 60) return `${String(seconds)}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${String(minutes)}m`;
	return `${String(Math.ceil(minutes / 60))}h`;
}
