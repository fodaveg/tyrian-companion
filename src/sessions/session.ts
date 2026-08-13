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

export interface ActiveSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'active';
	sessionId: string;
	authority: SessionAuthority;
	requestedAt: string;
	baseline: SessionSnapshotReference;
	startContext: SessionStartContext;
}

export interface StoppingSessionState {
	version: typeof SESSION_STATE_VERSION;
	status: 'stopping';
	sessionId: string;
	authority: SessionAuthority;
	requestedAt: string;
	baseline: SessionSnapshotReference;
	startContext: SessionStartContext;
	stopRequestedAt: string;
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
	| { type: 'request_stop'; authority: SessionAuthority; requestedAt: string }
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
