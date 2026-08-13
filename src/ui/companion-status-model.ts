import type { ConnectionState } from '../account/connection-service';
import type { DetectionMode } from '../core/settings';
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { ApiPollSchedulerState } from '../sessions/api-poll-scheduler';
import type { SessionState } from '../sessions/session';
import type { StorageDelta } from '../account/storage-delta-model';
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

export type CompanionStatusTone = 'quiet' | 'active' | 'good' | 'warning' | 'error';

export interface CompanionStatusItem {
	id: 'detection' | 'session' | 'polling' | 'quality';
	label: string;
	value: string;
	detail: string;
	tone: CompanionStatusTone;
}

export interface CompanionRailItem extends Omit<CompanionStatusItem, 'id'> {
	id: CompanionStatusItem['id'] | 'account';
}

export interface CompanionStatusProjection {
	connection: { value: string; tone: CompanionStatusTone };
	items: CompanionStatusItem[];
	primaryAction: 'start' | 'stop' | 'review' | 'clear' | 'recover' | 'none';
	errors: string[];
	incidentTone: 'warning' | 'error' | null;
	surfaceTone: CompanionStatusTone;
	refreshEveryMs: 1_000 | null;
}

export interface CompanionStatusInput {
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
}

/** Pure H5.1 projection used by the note-independent status view. */
export function buildCompanionStatus(input: CompanionStatusInput): CompanionStatusProjection {
	const connection = connectionStatus(input.connection);
	const detection = detectionStatus(input.detectionMode, input.detection);
	const baseSession = sessionStatus(input.session, input.now);
	const session = recoverySessionStatus(input.recovery, baseSession);
	const polling = pollingStatus(input.detectionMode, input.detection, input.now);
	const quality = qualityStatus(input.qualityState, input.qualityStats, input.sessionQuality, input.detection, input.delta, input.review);
	const errors = statusErrors(input);
	const refreshEveryMs = session.live || polling.live || hasLiveConnectionCountdown(input.connection, input.now)
		? 1_000 : null;
	return {
		connection,
		items: [detection.item, session.item, polling.item, quality],
		primaryAction: primaryAction(input.session, input.recovery),
		errors,
		incidentTone: errors.length === 0 ? null : hasErrorIncident(input) ? 'error' : 'warning',
		surfaceTone: errors.length > 0 && hasErrorIncident(input) ? 'error' : strongestTone([detection.item, session.item, polling.item, quality]),
		refreshEveryMs,
	};
}

/** The visible rail is deliberately limited to three operational signals plus account. */
export function visibleRailItems(projection: CompanionStatusProjection): CompanionRailItem[] {
	const items: CompanionRailItem[] = [];
	for (const id of ['detection', 'polling', 'quality'] as const) {
		const status = projection.items.find((item) => item.id === id);
		if (status) items.push({ ...status });
	}
	items.push({
		id: 'account',
		label: 'Account',
		value: projection.connection.value,
		detail: 'Connection and key details below.',
		tone: projection.connection.tone,
	});
	return items;
}

function recoverySessionStatus(
	recovery: SessionRecoveryState,
	fallback: { item: CompanionStatusItem; live: boolean },
): { item: CompanionStatusItem; live: boolean } {
	if (recovery.status === 'none') return fallback;
	if (recovery.status === 'available') {
		return { item: item('session', 'Session', 'Recovery available', 'A saved farming session needs a decision.', 'warning'), live: false };
	}
	if (recovery.status === 'busy') {
		return { item: item('session', 'Session', 'Recovery blocked', recovery.message ?? 'Another window owns the saved session.', 'error'), live: false };
	}
	if (recovery.status === 'working') {
		return { item: item('session', 'Session', recovery.action === 'recover' ? 'Recovering' : 'Discarding', 'Working with the saved session…', 'active'), live: false };
	}
	if (recovery.status === 'error') {
		return { item: item('session', 'Session', 'Recovery error', recovery.message, 'error'), live: false };
	}
	return fallback;
}

function primaryAction(
	session: SessionState,
	recovery: SessionRecoveryState,
): CompanionStatusProjection['primaryAction'] {
	if (recovery.status === 'available') return 'recover';
	if (recovery.status !== 'none') return 'none';
	if (session.status === 'idle') return 'start';
	if (session.status === 'active') return 'stop';
	if (session.status === 'provisional') return 'review';
	if (session.status === 'complete') return 'clear';
	return 'none';
}

function connectionStatus(state: ConnectionState): CompanionStatusProjection['connection'] {
	if (state.status === 'connected') return { value: 'Connected', tone: 'good' };
	if (state.status === 'warning') return { value: 'Attention', tone: 'warning' };
	if (state.status === 'checking') return { value: 'Checking', tone: 'active' };
	if (state.status === 'error') return { value: 'Offline', tone: 'error' };
	return { value: 'Not checked', tone: 'quiet' };
}

function detectionStatus(
	mode: DetectionMode,
	state: AssistedDetectionState,
): { item: CompanionStatusItem } {
	if (mode === 'off') return { item: item('detection', 'Detection', 'Off', 'Enable assisted detection in settings.', 'quiet') };
	const values: Record<AssistedDetectionState['status'], Pick<CompanionStatusItem, 'value' | 'detail' | 'tone'>> = {
		disarmed: { value: 'Disarmed', detail: 'No account polling is running.', tone: 'quiet' },
		arming: { value: 'Arming', detail: 'Capturing a stable baseline.', tone: 'active' },
		armed: { value: 'Armed', detail: 'Watching for a start or stop signal.', tone: 'good' },
		start_proposed: { value: 'Start proposed', detail: 'Waiting for your review.', tone: 'warning' },
		stop_proposed: { value: 'Stop proposed', detail: 'Waiting for your review.', tone: 'warning' },
		error: { value: 'Error', detail: 'Detection stopped.', tone: 'error' },
	};
	const value = values[state.status];
	return { item: item('detection', 'Detection', value.value, value.detail, value.tone) };
}

function sessionStatus(
	state: SessionState,
	now: number,
): { item: CompanionStatusItem; live: boolean } {
	if (state.status === 'idle') {
		return { item: item('session', 'Session', 'Idle', 'No farming session is active.', 'quiet'), live: false };
	}
	if (state.status === 'starting') {
		return { item: item('session', 'Session', 'Starting', 'Capturing the baseline and build.', 'active'), live: false };
	}
	if (state.status === 'error') {
		const observed = state.failedState;
		const duration = 'baseline' in observed
			? formatElapsed(safeElapsed(Date.parse(observed.baseline.completedAt), Date.parse(state.failedAt)))
			: null;
		return {
			item: item('session', 'Session', 'Error', duration ? `${duration} observed before the error.` : sessionFailureLabel(state.code), 'error'),
			live: false,
		};
	}
	const startedAt = Date.parse(state.baseline.completedAt);
	const live = state.status === 'active' || state.status === 'stopping';
	const endedAt = state.status === 'provisional' || state.status === 'complete'
		? Date.parse(state.finalSnapshot.completedAt) : now;
	const elapsed = elapsedOrNull(startedAt, endedAt);
	const duration = elapsed === null ? '—' : formatElapsed(elapsed);
	if (state.status === 'active') {
		return { item: item('session', 'Session', 'Active', `${duration} · ${state.startContext.characterName}`, 'good'), live };
	}
	if (state.status === 'stopping') {
		return { item: item('session', 'Session', 'Stopping', `${duration} · capturing final snapshot`, 'active'), live };
	}
	if (state.status === 'provisional') {
		return { item: item('session', 'Session', 'Review needed', `${duration} · final snapshot captured`, 'warning'), live };
	}
	return { item: item('session', 'Session', 'Complete', `${duration} · ${state.classification}`, 'good'), live };
}

function pollingStatus(
	mode: DetectionMode,
	detection: AssistedDetectionState,
	now: number,
): { item: CompanionStatusItem; live: boolean } {
	if (mode === 'off') return { item: item('polling', 'Polling', 'Off', 'Disabled in settings.', 'quiet'), live: false };
	if (detection.status === 'disarmed') {
		return { item: item('polling', 'Polling', 'Stopped', 'Arm detection to begin.', 'quiet'), live: false };
	}
	if (detection.status === 'arming') {
		return { item: item('polling', 'Polling', 'Waiting', 'Starts after the baseline.', 'active'), live: false };
	}
	if (detection.status === 'error') {
		return { item: item('polling', 'Polling', 'Stopped', 'Detection needs attention.', 'error'), live: false };
	}
	if (detection.status === 'start_proposed' || detection.status === 'stop_proposed') {
		return { item: item('polling', 'Polling', 'Paused', appendLastSnapshot('Review the current proposal.', detection.lastSnapshotAt, now), 'warning'), live: false };
	}
	return schedulerStatus(detection.scheduler, detection.lastSnapshotAt, now);
}

function schedulerStatus(
	state: ApiPollSchedulerState,
	lastSnapshotAt: string | null,
	now: number,
): { item: CompanionStatusItem; live: boolean } {
	const interval = state.intervalMs === null ? 'No interval' : `Every ${formatCompactDuration(state.intervalMs)}`;
	if (state.status === 'scheduled') {
		const next = state.nextRunAt === null ? interval : `Next in ${formatCompactDuration(Math.max(0, state.nextRunAt - now))}`;
		return { item: item('polling', 'Polling', 'Scheduled', appendLastSnapshot(`${interval} · ${next}`, lastSnapshotAt, now), 'good'), live: state.nextRunAt !== null };
	}
	if (state.status === 'polling') return { item: item('polling', 'Polling', 'Checking now', appendLastSnapshot(interval, lastSnapshotAt, now), 'active'), live: true };
	if (state.status === 'paused_offline') return { item: item('polling', 'Polling', 'Offline', appendLastSnapshot(`${interval} · resumes online`, lastSnapshotAt, now), 'warning'), live: false };
	if (state.status === 'paused_sleep') return { item: item('polling', 'Polling', 'Resuming', appendLastSnapshot(`${interval} · device woke up`, lastSnapshotAt, now), 'warning'), live: true };
	if (state.status === 'backoff') {
		const retry = state.nextRunAt === null ? 'Retry pending' : `Retry in ${formatCompactDuration(Math.max(0, state.nextRunAt - now))}`;
		return { item: item('polling', 'Polling', 'Backing off', appendLastSnapshot(`${retry} · ${String(state.consecutiveFailures)} failures`, lastSnapshotAt, now), 'warning'), live: state.nextRunAt !== null };
	}
	if (state.status === 'fatal') return { item: item('polling', 'Polling', 'Failed', 'Disarm and try again.', 'error'), live: false };
	if (state.status === 'disposed') return { item: item('polling', 'Polling', 'Unavailable', 'Polling service is closed.', 'error'), live: false };
	return { item: item('polling', 'Polling', 'Idle', interval, 'quiet'), live: false };
}

function qualityStatus(
	state: DetectionQualityRecorderState,
	stats: DetectionQualityStats | null,
	session: SessionDetectionQualitySummary | null,
	detection: AssistedDetectionState,
	delta: StorageDelta | null,
	review: SessionContaminationReview | null,
): CompanionStatusItem {
	if (review) {
		if (review.classification.status === 'invalid') return item('quality', 'Quality', 'Unavailable', 'The session review is invalid.', 'error');
		const complete = review.classification.status === 'exact';
		return item('quality', 'Quality', complete ? 'Complete' : 'Limited', `Reviewed · ${review.classification.status}`, complete ? 'good' : 'warning');
	}
	if (delta) {
		if (delta.status === 'invalid') return item('quality', 'Quality', 'Unavailable', 'The storage comparison is invalid.', 'error');
		return item('quality', 'Quality', delta.status === 'comparable' ? 'Complete' : 'Limited', `Storage comparison · ${delta.status}`, delta.status === 'comparable' ? 'good' : 'warning');
	}
	const proposalQuality = currentEvidenceQuality(detection);
	if (proposalQuality !== null) {
		return item('quality', 'Quality', proposalQuality === 'complete' ? 'Complete' : 'Limited',
			proposalQuality === 'complete' ? 'Current proposal has complete evidence.' : 'Current proposal has incomplete evidence.',
			proposalQuality === 'complete' ? 'good' : 'warning');
	}
	if (session) {
		const recordedQuality = sessionEvidenceQuality(session);
		return item(
			'quality',
			'Quality',
			recordedQuality === null ? detectionModeLabel(session.mode) : recordedQuality === 'complete' ? 'Complete' : 'Limited',
			`${formatCompactDuration(session.totalUncertaintyMs)} uncertainty · ${String(session.correctedFalsePositives.length)} corrections`,
			recordedQuality === 'limited' || session.mode === 'incomplete' ? 'warning' : 'good',
		);
	}
	if (state.status === 'loading') return item('quality', 'Quality', 'Loading', 'Reading local measurements.', 'active');
	if (state.status === 'unavailable') return item('quality', 'Quality', 'Unavailable', 'Session controls still work.', 'error');
	if (!stats || (stats.acceptedBoundaries === 0 && stats.correctedFalsePositives === 0)) {
		return item('quality', 'Quality', 'No sample', 'No measurements recorded yet.', 'quiet');
	}
	return item(
		'quality',
		'Quality',
		`${String(stats.acceptedBoundaries)} boundaries`,
		`${String(stats.correctedFalsePositives)} corrected proposals`,
		'good',
	);
}

function statusErrors(input: CompanionStatusInput): string[] {
	const errors: string[] = [];
	if (input.recovery.status === 'available') {
		errors.push(`Recovery: ${input.recovery.message ?? 'A saved farming session needs a decision.'}`);
	}
	if (input.recovery.status === 'error') errors.push(`Recovery: ${input.recovery.message}`);
	if (input.recovery.status === 'busy') errors.push(`Recovery: ${input.recovery.message ?? 'Another window owns the saved session.'}`);
	if (input.session.status === 'error') errors.push(`Session: ${sessionFailureLabel(input.session.code)}`);
	if (input.startFailure) errors.push(`Start: ${input.startFailure.message}`);
	if (input.stopFailure) errors.push(`Stop: ${input.stopFailure.message}`);
	if (sessionHasClockIncident(input.session, input.now)) errors.push('Session: the recorded clock window is invalid.');
	if (input.review?.classification.status === 'invalid' || input.delta?.status === 'invalid') errors.push('Quality: the captured evidence is invalid.');
	if (input.detectionMode !== 'off' && input.detection.status === 'error') errors.push(`Detection: ${input.detection.message}`);
	if (input.detectionMode !== 'off' && input.detection.scheduler.status === 'fatal') errors.push('Polling stopped after a fatal account response.');
	if (input.connection.status === 'error') errors.push(`Connection: ${input.connection.message}`);
	if (input.connection.status === 'warning') errors.push(`Connection: ${input.connection.message}`);
	if ((input.connection.status === 'warning' || input.connection.status === 'error') && hasLiveConnectionCountdown(input.connection, input.now)) errors.push('Connection: retry cooldown is active.');
	if (input.qualityState.status === 'unavailable') errors.push(`Quality: ${input.qualityState.message}`);
	if ((input.connection.status === 'connected' || input.connection.status === 'warning') && input.connection.details.missingRecommendedScopes.length > 0) {
		errors.push(`Account: ${String(input.connection.details.missingRecommendedScopes.length)} future permissions are missing.`);
	}
	return [...new Set(errors)];
}

function hasErrorIncident(input: CompanionStatusInput): boolean {
	return input.recovery.status === 'error'
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

function appendLastSnapshot(detail: string, lastSnapshotAt: string | null, now: number): string {
	if (lastSnapshotAt === null) return `${detail} · No snapshot yet`;
	return `${detail} · Last snapshot ${formatCompactDuration(safeElapsed(Date.parse(lastSnapshotAt), now))} ago`;
}

function strongestTone(items: readonly CompanionStatusItem[]): CompanionStatusTone {
	const rank: Record<CompanionStatusTone, number> = { quiet: 0, good: 1, active: 2, warning: 3, error: 4 };
	return items.reduce<CompanionStatusTone>((strongest, status) =>
		rank[status.tone] > rank[strongest] ? status.tone : strongest, 'quiet');
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

function sessionFailureLabel(code: Extract<SessionState, { status: 'error' }>['code']): string {
	const labels: Record<typeof code, string> = {
		lease_lost: 'Session authority was lost.',
		snapshot_failed: 'The account snapshot failed.',
		storage_unavailable: 'Local session storage is unavailable.',
		classification_invalid: 'The session evidence is invalid.',
		cancelled: 'The session was cancelled.',
		unexpected: 'The session stopped unexpectedly.',
	};
	return labels[code];
}

function detectionModeLabel(mode: SessionDetectionQualitySummary['mode']): string {
	const labels: Record<typeof mode, string> = {
		manual: 'Manual',
		assisted: 'Assisted',
		mixed: 'Mixed',
		incomplete: 'Incomplete',
	};
	return labels[mode];
}

function safeElapsed(start: number, end: number): number {
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(end - start));
}

function elapsedOrNull(start: number, end: number): number | null {
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(end - start));
}

function sessionHasClockIncident(state: SessionState, now: number): boolean {
	if (state.status === 'idle' || state.status === 'starting') return false;
	const observed = state.status === 'error' ? state.failedState : state;
	if (!('baseline' in observed)) return false;
	const end = observed.status === 'provisional'
		? Date.parse(observed.finalSnapshot.completedAt)
		: state.status === 'complete'
			? Date.parse(state.finalSnapshot.completedAt)
			: state.status === 'error' ? Date.parse(state.failedAt) : now;
	return elapsedOrNull(Date.parse(observed.baseline.completedAt), end) === null;
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
