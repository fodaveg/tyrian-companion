import type { ActiveSessionLeaseHandle } from './coordination-model';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { MAX_MAGIC_FIND, type SessionStartContext } from './session-start-capture';
import {
	SESSION_STATE_VERSION,
	type ActiveSessionState,
	type CompleteSessionState,
	type ErrorSessionState,
	type IdleSessionState,
	type ProvisionalSessionState,
	type RecoverableSessionState,
	type SessionAuthority,
	type SessionCompletionKind,
	type SessionEvent,
	type SessionFailureCode,
	type SessionInProgressState,
	type SessionSnapshotReference,
	type SessionState,
	type SessionTransitionRejection,
	type SessionTransitionResult,
	type StartingSessionState,
	type StoppingSessionState,
} from './session';

const IDS_MAX_LENGTH = 256;
const COMPLETION_KINDS: SessionCompletionKind[] = ['exact', 'estimated', 'contaminated'];
const FAILURE_CODES: SessionFailureCode[] = [
	'lease_lost',
	'snapshot_failed',
	'storage_unavailable',
	'classification_invalid',
	'cancelled',
	'unexpected',
];

export function initialSessionState(): IdleSessionState {
	return { version: SESSION_STATE_VERSION, status: 'idle' };
}

export function sessionAuthorityFromLease(handle: ActiveSessionLeaseHandle): SessionAuthority {
	return {
		machineId: handle.machineId,
		instanceId: handle.instanceId,
		sessionId: handle.sessionId,
		fence: handle.fence,
		acquiredAt: handle.acquiredAt,
	};
}

/** Pure, never-throw transition boundary for persisted or UI-supplied data. */
export function transitionSession(stateValue: unknown, eventValue: unknown): SessionTransitionResult {
	try {
		if (!isSessionState(stateValue)) return rejected(null, 'invalid_state');
		if (!isSessionEvent(eventValue)) return rejected(stateValue, 'invalid_event');
		return transitionValidated(stateValue, eventValue);
	} catch {
		return rejected(isSessionState(stateValue) ? stateValue : null, 'invariant_violation');
	}
}

export function isSessionState(value: unknown): value is SessionState {
	if (!isRecord(value) || value.version !== SESSION_STATE_VERSION || typeof value.status !== 'string') return false;
	switch (value.status) {
		case 'idle':
			return exactKeys(value, ['version', 'status']);
		case 'starting':
			return isStartingState(value);
		case 'active':
			return isActiveState(value);
		case 'stopping':
			return isStoppingState(value);
		case 'provisional':
			return isProvisionalState(value);
		case 'complete':
			return isCompleteState(value);
		case 'error':
			return isErrorState(value);
		default:
			return false;
	}
}

export function isSessionEvent(value: unknown): value is SessionEvent {
	if (!isRecord(value) || typeof value.type !== 'string') return false;
	switch (value.type) {
		case 'request_start':
			return exactKeys(value, ['type', 'authority', 'requestedAt'])
				&& isAuthority(value.authority)
				&& isIsoTimestamp(value.requestedAt)
				&& Date.parse(value.requestedAt) >= value.authority.acquiredAt;
		case 'confirm_start':
			return exactKeys(value, ['type', 'authority', 'baseline', 'startContext'])
				&& isAuthority(value.authority)
				&& isSnapshotReference(value.baseline)
				&& isStartContext(value.startContext)
				&& Date.parse(value.startContext.capturedAt) >= Date.parse(value.baseline.completedAt);
		case 'request_stop':
			return exactKeys(value, ['type', 'authority', 'requestedAt'])
				&& isAuthority(value.authority)
				&& isIsoTimestamp(value.requestedAt);
		case 'confirm_stop':
			return exactKeys(value, ['type', 'authority', 'stoppedAt', 'finalSnapshot'])
				&& isAuthority(value.authority)
				&& isIsoTimestamp(value.stoppedAt)
				&& isSnapshotReference(value.finalSnapshot);
		case 'finalize':
			return exactKeys(value, ['type', 'authority', 'finalizedAt', 'classification'])
				&& isAuthority(value.authority)
				&& isIsoTimestamp(value.finalizedAt)
				&& COMPLETION_KINDS.includes(value.classification as SessionCompletionKind);
		case 'fail':
			return exactKeys(value, ['type', 'authority', 'failedAt', 'code'])
				&& isAuthority(value.authority)
				&& isIsoTimestamp(value.failedAt)
				&& FAILURE_CODES.includes(value.code as SessionFailureCode);
		case 'recover':
			return exactKeys(value, ['type', 'authority', 'recoveredAt'])
				&& isAuthority(value.authority)
				&& isIsoTimestamp(value.recoveredAt)
				&& Date.parse(value.recoveredAt) >= value.authority.acquiredAt;
		case 'reset':
			return exactKeys(value, ['type']);
		default:
			return false;
	}
}

function transitionValidated(state: SessionState, event: SessionEvent): SessionTransitionResult {
	switch (event.type) {
		case 'request_start':
			if (containsStartRequest(state, event.authority, event.requestedAt)) return unchanged(state);
			if (state.status !== 'idle') return rejected(state, 'illegal_transition');
			return applied({
				version: SESSION_STATE_VERSION,
				status: 'starting',
				sessionId: event.authority.sessionId,
				authority: clone(event.authority),
				requestedAt: event.requestedAt,
			});

		case 'confirm_start':
			if (containsStartConfirmation(state, event.authority, event.baseline, event.startContext)) return unchanged(state);
			if (state.status !== 'starting') return rejected(state, 'illegal_transition');
			if (!sameAuthority(state.authority, event.authority)) return rejected(state, 'authority_mismatch');
			return applied({
				...clone(state),
				status: 'active',
				baseline: clone(event.baseline),
				startContext: clone(event.startContext),
			});

		case 'request_stop':
			if (containsStopRequest(state, event.authority, event.requestedAt)) return unchanged(state);
			if (state.status !== 'active') return rejected(state, 'illegal_transition');
			if (!sameAuthority(state.authority, event.authority)) return rejected(state, 'authority_mismatch');
			return applied({ ...clone(state), status: 'stopping', stopRequestedAt: event.requestedAt });

		case 'confirm_stop':
			if (containsFinalSnapshot(state, event.authority, event.stoppedAt, event.finalSnapshot)) return unchanged(state);
			if (state.status !== 'stopping') return rejected(state, 'illegal_transition');
			if (!sameAuthority(state.authority, event.authority)) return rejected(state, 'authority_mismatch');
			return applied({
				...clone(state),
				status: 'provisional',
				stoppedAt: event.stoppedAt,
				finalSnapshot: clone(event.finalSnapshot),
			});

		case 'finalize':
			if (state.status === 'complete' && sameAuthority(state.authority, event.authority) && state.finalizedAt === event.finalizedAt && state.classification === event.classification) return unchanged(state);
			if (state.status !== 'provisional') return rejected(state, 'illegal_transition');
			if (!sameAuthority(state.authority, event.authority)) return rejected(state, 'authority_mismatch');
			return applied({
				...clone(state),
				status: 'complete',
				finalizedAt: event.finalizedAt,
				classification: event.classification,
			});

		case 'fail':
			if (state.status === 'error' && sameAuthority(state.failedState.authority, event.authority) && state.failedAt === event.failedAt && state.code === event.code) return unchanged(state);
			if (!isInProgressState(state)) return rejected(state, 'illegal_transition');
			if (!sameAuthority(state.authority, event.authority)) return rejected(state, 'authority_mismatch');
			return applied({
				version: SESSION_STATE_VERSION,
				status: 'error',
				failedAt: event.failedAt,
				code: event.code,
				failedState: clone(state),
			});

		case 'recover': {
			const recoverable = recoverableState(state);
			if (!recoverable) return rejected(state, 'illegal_transition');
			if (sameAuthority(recoverable.authority, event.authority)) return unchanged(state);
			if (!canRecoverAuthority(recoverable.authority, event.authority)) {
				return rejected(state, 'authority_mismatch');
			}
			return applied({
				...clone(recoverable),
				sessionId: event.authority.sessionId,
				authority: clone(event.authority),
			});
		}

		case 'reset':
			if (state.status === 'idle') return unchanged(state);
			if (state.status !== 'complete' && state.status !== 'error') return rejected(state, 'illegal_transition');
			return applied(initialSessionState());
	}
}

function isStartingState(value: Record<string, unknown>): value is Record<string, unknown> & StartingSessionState {
	return exactKeys(value, ['version', 'status', 'sessionId', 'authority', 'requestedAt'])
		&& validId(value.sessionId)
		&& isAuthority(value.authority)
		&& value.sessionId === value.authority.sessionId
		&& isIsoTimestamp(value.requestedAt)
		&& Date.parse(value.requestedAt) >= value.authority.acquiredAt;
}

function isActiveState(value: Record<string, unknown>): value is Record<string, unknown> & ActiveSessionState {
	return exactKeys(value, ['version', 'status', 'sessionId', 'authority', 'requestedAt', 'baseline', 'startContext'])
		&& validSessionBase(value)
		&& isSnapshotReference(value.baseline)
		&& isStartContext(value.startContext)
		&& Date.parse(value.requestedAt as string) <= Date.parse(value.baseline.startedAt)
		&& Date.parse(value.startContext.capturedAt) >= Date.parse(value.baseline.completedAt);
}

function isStoppingState(value: Record<string, unknown>): value is Record<string, unknown> & StoppingSessionState {
	return exactKeys(value, ['version', 'status', 'sessionId', 'authority', 'requestedAt', 'baseline', 'startContext', 'stopRequestedAt'])
		&& validSessionBase(value)
		&& isSnapshotReference(value.baseline)
		&& isStartContext(value.startContext)
		&& isIsoTimestamp(value.stopRequestedAt)
		&& Date.parse(value.requestedAt as string) <= Date.parse(value.baseline.startedAt)
		&& Date.parse(value.startContext.capturedAt) >= Date.parse(value.baseline.completedAt)
		&& Date.parse(value.stopRequestedAt) >= Date.parse(value.baseline.completedAt);
}

function isProvisionalState(value: Record<string, unknown>): value is Record<string, unknown> & ProvisionalSessionState {
	return exactKeys(value, ['version', 'status', 'sessionId', 'authority', 'requestedAt', 'baseline', 'startContext', 'stopRequestedAt', 'stoppedAt', 'finalSnapshot'])
		&& validProvisionalFields(value);
}

function isCompleteState(value: Record<string, unknown>): value is Record<string, unknown> & CompleteSessionState {
	return exactKeys(value, ['version', 'status', 'sessionId', 'authority', 'requestedAt', 'baseline', 'startContext', 'stopRequestedAt', 'stoppedAt', 'finalSnapshot', 'finalizedAt', 'classification'])
		&& validProvisionalFields(value)
		&& isIsoTimestamp(value.finalizedAt)
		&& Date.parse(value.finalizedAt) >= Date.parse((value.finalSnapshot as SessionSnapshotReference).completedAt)
		&& COMPLETION_KINDS.includes(value.classification as SessionCompletionKind);
}

function isErrorState(value: Record<string, unknown>): value is Record<string, unknown> & ErrorSessionState {
	return exactKeys(value, ['version', 'status', 'failedAt', 'code', 'failedState'])
		&& isIsoTimestamp(value.failedAt)
		&& FAILURE_CODES.includes(value.code as SessionFailureCode)
		&& isInProgressState(value.failedState)
		&& Date.parse(value.failedAt) >= Date.parse(stateAnchor(value.failedState));
}

function validSessionBase(value: Record<string, unknown>): boolean {
	return validId(value.sessionId)
		&& isAuthority(value.authority)
		&& value.sessionId === value.authority.sessionId
		&& isIsoTimestamp(value.requestedAt);
}

function validProvisionalFields(value: Record<string, unknown>): boolean {
	if (!validSessionBase(value)
		|| !isSnapshotReference(value.baseline)
		|| !isStartContext(value.startContext)
		|| !isIsoTimestamp(value.stopRequestedAt)
		|| !isIsoTimestamp(value.stoppedAt)
		|| !isSnapshotReference(value.finalSnapshot)) return false;
	return Date.parse(value.requestedAt as string) <= Date.parse(value.baseline.startedAt)
		&& Date.parse(value.startContext.capturedAt) >= Date.parse(value.baseline.completedAt)
		&& Date.parse(value.stopRequestedAt) >= Date.parse(value.baseline.completedAt)
		&& Date.parse(value.stoppedAt) >= Date.parse(value.stopRequestedAt)
		&& Date.parse(value.stoppedAt) <= Date.parse(value.finalSnapshot.startedAt)
		&& value.baseline.snapshotId !== value.finalSnapshot.snapshotId
		&& value.baseline.accountId === value.finalSnapshot.accountId
		&& value.baseline.schemaVersion === value.finalSnapshot.schemaVersion
		&& Date.parse(value.baseline.completedAt) <= Date.parse(value.finalSnapshot.startedAt);
}

function isInProgressState(value: unknown): value is SessionInProgressState {
	if (!isRecord(value)) return false;
	return value.status === 'starting'
		? isStartingState(value)
		: value.status === 'active'
			? isActiveState(value)
			: value.status === 'stopping'
				? isStoppingState(value)
				: value.status === 'provisional' && isProvisionalState(value);
}

function recoverableState(state: SessionState): RecoverableSessionState | null {
	if (state.status === 'active' || state.status === 'stopping' || state.status === 'provisional') {
		return state;
	}
	if (state.status !== 'error') return null;
	return state.failedState.status === 'active'
		|| state.failedState.status === 'stopping'
		|| state.failedState.status === 'provisional'
		? state.failedState
		: null;
}

function isAuthority(value: unknown): value is SessionAuthority {
	return isRecord(value)
		&& exactKeys(value, ['machineId', 'instanceId', 'sessionId', 'fence', 'acquiredAt'])
		&& validId(value.machineId)
		&& validId(value.instanceId)
		&& validId(value.sessionId)
		&& Number.isSafeInteger(value.fence)
		&& (value.fence as number) > 0
		&& Number.isSafeInteger(value.acquiredAt)
		&& (value.acquiredAt as number) >= 0;
}

function isSnapshotReference(value: unknown): value is SessionSnapshotReference {
	if (!isRecord(value) || !exactKeys(value, ['snapshotId', 'accountId', 'schemaVersion', 'startedAt', 'completedAt', 'quality'])) return false;
	return validId(value.snapshotId)
		&& validId(value.accountId)
		&& value.schemaVersion === PINNED_SCHEMA
		&& isIsoTimestamp(value.startedAt)
		&& isIsoTimestamp(value.completedAt)
		&& Date.parse(value.startedAt) <= Date.parse(value.completedAt)
		&& (value.quality === 'stable' || value.quality === 'stable_owned_placement_changed');
}

function isStartContext(value: unknown): value is SessionStartContext {
	if (!isRecord(value)
		|| !exactKeys(value, ['characterName', 'magicFind', 'build', 'capturedAt'])
		|| !validId(value.characterName)
		|| !isIsoTimestamp(value.capturedAt)
		|| !isRecord(value.magicFind)
		|| !exactKeys(value.magicFind, ['value', 'source'])
		|| value.magicFind.source !== 'manual'
		|| !Number.isSafeInteger(value.magicFind.value)
		|| (value.magicFind.value as number) < 0
		|| (value.magicFind.value as number) > MAX_MAGIC_FIND
		|| !isRecord(value.build)
		|| !exactKeys(value.build, ['tab', 'name', 'profession', 'specializations', 'skills', 'aquaticSkills'])
		|| !positiveInteger(value.build.tab)
		|| typeof value.build.name !== 'string'
		|| typeof value.build.profession !== 'string'
		|| value.build.profession.length === 0
		|| !Array.isArray(value.build.specializations)
		|| value.build.specializations.length !== 3
		|| !value.build.specializations.every(isBuildSpecialization)
		|| !isBuildSkills(value.build.skills)
		|| !isBuildSkills(value.build.aquaticSkills)) return false;
	return true;
}

function isBuildSpecialization(value: unknown): boolean {
	return isRecord(value)
		&& exactKeys(value, ['id', 'traits'])
		&& nullablePositiveInteger(value.id)
		&& Array.isArray(value.traits)
		&& value.traits.every(nullablePositiveInteger);
}

function isBuildSkills(value: unknown): boolean {
	return isRecord(value)
		&& exactKeys(value, ['heal', 'utilities', 'elite'])
		&& nullablePositiveInteger(value.heal)
		&& Array.isArray(value.utilities)
		&& value.utilities.length === 3
		&& value.utilities.every(nullablePositiveInteger)
		&& nullablePositiveInteger(value.elite);
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nullablePositiveInteger(value: unknown): value is number | null {
	return value === null || positiveInteger(value);
}

function stateAnchor(state: SessionInProgressState): string {
	switch (state.status) {
		case 'starting': return state.requestedAt;
		case 'active': return state.baseline.completedAt;
		case 'stopping': return state.stopRequestedAt;
		case 'provisional': return state.finalSnapshot.completedAt;
	}
}

function sameAuthority(left: SessionAuthority, right: SessionAuthority): boolean {
	return left.machineId === right.machineId
		&& left.instanceId === right.instanceId
		&& left.sessionId === right.sessionId
		&& left.fence === right.fence
		&& left.acquiredAt === right.acquiredAt;
}

function canRecoverAuthority(previous: SessionAuthority, next: SessionAuthority): boolean {
	return previous.machineId === next.machineId
		&& previous.sessionId === next.sessionId
		&& next.fence > previous.fence
		&& next.acquiredAt >= previous.acquiredAt;
}

function sameSnapshot(left: SessionSnapshotReference, right: SessionSnapshotReference): boolean {
	return left.snapshotId === right.snapshotId
		&& left.accountId === right.accountId
		&& left.schemaVersion === right.schemaVersion
		&& left.startedAt === right.startedAt
		&& left.completedAt === right.completedAt
		&& left.quality === right.quality;
}

function sameStartContext(left: unknown, right: unknown): boolean {
	return isStartContext(left)
		&& isStartContext(right)
		&& JSON.stringify(left) === JSON.stringify(right);
}

function containsStartRequest(state: SessionState, authority: SessionAuthority, requestedAt: string): boolean {
	const observed = state.status === 'error' ? state.failedState : state;
	return observed.status !== 'idle'
		&& sameAuthority(observed.authority, authority)
		&& observed.requestedAt === requestedAt;
}

function containsStartConfirmation(
	state: SessionState,
	authority: SessionAuthority,
	baseline: SessionSnapshotReference,
	startContext: SessionStartContext,
): boolean {
	const observed = state.status === 'error' ? state.failedState : state;
	return observed.status !== 'idle'
		&& observed.status !== 'starting'
		&& sameAuthority(observed.authority, authority)
		&& sameSnapshot(observed.baseline, baseline)
		&& sameStartContext(observed.startContext, startContext);
}

function containsStopRequest(state: SessionState, authority: SessionAuthority, requestedAt: string): boolean {
	const observed = state.status === 'error' ? state.failedState : state;
	return (observed.status === 'stopping' || observed.status === 'provisional' || observed.status === 'complete')
		&& sameAuthority(observed.authority, authority)
		&& observed.stopRequestedAt === requestedAt;
}

function containsFinalSnapshot(
	state: SessionState,
	authority: SessionAuthority,
	stoppedAt: string,
	finalSnapshot: SessionSnapshotReference,
): boolean {
	const observed = state.status === 'error' ? state.failedState : state;
	return (observed.status === 'provisional' || observed.status === 'complete')
		&& sameAuthority(observed.authority, authority)
		&& observed.stoppedAt === stoppedAt
		&& sameSnapshot(observed.finalSnapshot, finalSnapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function validId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= IDS_MAX_LENGTH;
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function applied(state: SessionState): SessionTransitionResult {
	return isSessionState(state)
		? { status: 'applied', state }
		: rejected(null, 'invariant_violation');
}

function unchanged(state: SessionState): SessionTransitionResult {
	return { status: 'unchanged', state };
}

function rejected(state: SessionState | null, reason: SessionTransitionRejection): SessionTransitionResult {
	return { status: 'rejected', state, reason };
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
