import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionStartContext } from './session-start-capture';

export const SESSION_STATE_VERSION = 1 as const;

export type SessionStatus =
	| 'idle'
	| 'starting'
	| 'active'
	| 'stopping'
	| 'provisional'
	| 'complete'
	| 'error';

export type ComparableSnapshotQuality = Extract<
	StorageSnapshot['quality'],
	'stable' | 'stable_owned_placement_changed'
>;

/** Stable fencing identity. Lease expiry/renewal remains the coordinator's concern. */
export type SessionAuthority = Pick<
	ActiveSessionLeaseHandle,
	'machineId' | 'instanceId' | 'sessionId' | 'fence' | 'acquiredAt'
>;

export interface SessionSnapshotReference {
	snapshotId: string;
	accountId: string;
	schemaVersion: StorageSnapshot['schemaVersion'];
	startedAt: string;
	completedAt: string;
	quality: ComparableSnapshotQuality;
}

export interface IdleSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'idle';
}

export interface StartingSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'starting';
	sessionId: string;
	authority: SessionAuthority;
	requestedAt: string;
}

/**
 * H18.11: a stretch the session was not observed at all, from the last evidence saved before an
 * interruption (a suspend that outlived the lease, Obsidian closed) to the instant the session came
 * back. It is subtracted from the played duration; the end stays the player's own stop. Nothing
 * says whether the game ran meanwhile, so a session carrying one is declared uncertain.
 */
export interface SessionUnobservedGap {
	from: string;
	to: string;
}

/** Bound on the recorded gaps: a session interrupted more often than this is not worth a finer count. */
export const SESSION_UNOBSERVED_GAPS_MAX = 16;

/**
 * H18.11: milliseconds of the session nobody observed, to subtract from its played duration. Zero
 * for every state without gaps, which is every session recorded before this existed.
 */
export function sessionUnobservedMs(state: { unobservedGaps?: SessionUnobservedGap[] }): number {
	let total = 0;
	for (const gap of state.unobservedGaps ?? []) total += Math.max(0, Date.parse(gap.to) - Date.parse(gap.from));
	return Number.isSafeInteger(total) ? total : 0;
}

export interface ActiveSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'active';
	sessionId: string;
	authority: SessionAuthority;
	requestedAt: string;
	baseline: SessionSnapshotReference;
	startContext: SessionStartContext;
	/** Optional (H18.11): absent on every session that was never interrupted, and on older records. */
	unobservedGaps?: SessionUnobservedGap[];
}

/**
 * Where `stopRequestedAt` came from when it is not the player's own saved request (H18.4). A stop
 * whose request never reached the store is retried from the last evidence saved before the failure
 * (a persisted heartbeat or the saved record itself), never from the moment of the retry, which can
 * come hours later; the end is then uncertain and says so. Absent on an ordinary stop.
 */
export type SessionStopBoundary = 'last_saved_evidence';

export interface StoppingSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'stopping';
	sessionId: string;
	authority: SessionAuthority;
	requestedAt: string;
	baseline: SessionSnapshotReference;
	startContext: SessionStartContext;
	stopRequestedAt: string;
	stopBoundary?: SessionStopBoundary;
	unobservedGaps?: SessionUnobservedGap[];
}

export interface ProvisionalSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'provisional';
	sessionId: string;
	authority: SessionAuthority;
	requestedAt: string;
	baseline: SessionSnapshotReference;
	startContext: SessionStartContext;
	stopRequestedAt: string;
	stopBoundary?: SessionStopBoundary;
	unobservedGaps?: SessionUnobservedGap[];
	stoppedAt: string;
	finalSnapshot: SessionSnapshotReference;
}

export type SessionCompletionKind = 'exact' | 'estimated' | 'contaminated';

export interface CompleteSessionState extends Omit<ProvisionalSessionState, 'status'> {
	status: 'complete';
	finalizedAt: string;
	classification: SessionCompletionKind;
}

export type SessionFailureCode =
	| 'lease_lost'
	| 'snapshot_failed'
	| 'storage_unavailable'
	| 'classification_invalid'
	| 'cancelled'
	| 'unexpected';

export type SessionInProgressState =
	| StartingSessionState
	| ActiveSessionState
	| StoppingSessionState
	| ProvisionalSessionState;

export type RecoverableSessionState =
	| ActiveSessionState
	| StoppingSessionState
	| ProvisionalSessionState;

export interface ErrorSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'error';
	failedAt: string;
	code: SessionFailureCode;
	/** Preserves the last valid state so a later recovery flow has complete evidence. */
	failedState: SessionInProgressState;
}

export type SessionState =
	| IdleSessionState
	| SessionInProgressState
	| CompleteSessionState
	| ErrorSessionState;

export type SessionEvent =
	| { type: 'request_start'; authority: SessionAuthority; requestedAt: string }
	| {
			type: 'confirm_start';
			authority: SessionAuthority;
			baseline: SessionSnapshotReference;
			startContext: SessionStartContext;
	  }
	| { type: 'request_stop'; authority: SessionAuthority; requestedAt: string; stopBoundary?: SessionStopBoundary }
	| {
			type: 'confirm_stop';
			authority: SessionAuthority;
			stoppedAt: string;
			finalSnapshot: SessionSnapshotReference;
	  }
	| {
			type: 'finalize';
			authority: SessionAuthority;
			finalizedAt: string;
			classification: SessionCompletionKind;
	  }
	| { type: 'fail'; authority: SessionAuthority; failedAt: string; code: SessionFailureCode }
	| { type: 'recover'; authority: SessionAuthority; recoveredAt: string }
	/** H18.11: appends one unobserved gap to an active session. */
	| { type: 'record_unobserved_gap'; authority: SessionAuthority; from: string; to: string }
	| { type: 'reset' };

export type SessionTransitionRejection =
	| 'invalid_state'
	| 'invalid_event'
	| 'illegal_transition'
	| 'authority_mismatch'
	| 'invariant_violation';

export type SessionTransitionResult =
	| { status: 'applied' | 'unchanged'; state: SessionState }
	| { status: 'rejected'; state: SessionState | null; reason: SessionTransitionRejection };

export type PlaySession = Exclude<SessionState, IdleSessionState>;

/** Persistence boundary only; no adapter is selected by H3.1. */
export interface SessionRepository {
	list(): Promise<PlaySession[]>;
	save(session: PlaySession): Promise<void>;
}
