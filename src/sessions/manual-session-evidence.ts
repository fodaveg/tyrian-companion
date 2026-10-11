/**
 * Pure reads of a session's own evidence that `ManualSessionStartService` uses to place its
 * boundaries: the reference a snapshot commits as, the last instant saved before a failure, the
 * stretches of a gap no observed play covers and the floor a failed stop may not go below.
 */
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { SessionInProgressState, SessionSnapshotReference, SessionState } from './session';
import type { SessionRuntimeRecord } from './session-runtime-store';
import { SessionStartCaptureError } from './session-start-capture';
import type { ObservedPlayInterval } from './manual-session-start-model';

export function snapshotReference(snapshot: StorageSnapshot): SessionSnapshotReference {
	if (snapshot.quality !== 'stable' && snapshot.quality !== 'stable_owned_placement_changed') {
		throw new SessionStartCaptureError('snapshot_not_stable', 'The baseline snapshot was not stable.');
	}
	return {
		snapshotId: snapshot.snapshotId,
		accountId: snapshot.accountId,
		schemaVersion: snapshot.schemaVersion,
		startedAt: snapshot.startedAt,
		completedAt: snapshot.completedAt,
		quality: snapshot.quality,
	};
}

/**
 * The latest instant known to be saved before a failure (H18.4): the record's own save (unless the
 * saved record is the failure itself) or the last heartbeat this window persisted to the lease.
 * Never later than a stop the player had already asked for in this window, and never earlier than
 * the baseline. It exists so an interrupted stop never takes the retry's clock as its end.
 */
export function lastSavedEvidenceAt(
	record: SessionRuntimeRecord,
	lastHeartbeatAt: number | null,
	failed: Exclude<SessionInProgressState, { status: 'starting' }>,
): number {
	const baselineAt = Date.parse(record.baselineSnapshot.completedAt);
	let at = Math.max(baselineAt, record.state.status === 'error' ? 0 : record.persistedAt, lastHeartbeatAt ?? 0);
	if (failed.status !== 'active') at = Math.min(at, Date.parse(failed.stopRequestedAt));
	return Math.max(at, baselineAt);
}

/**
 * H18.11: the parts of `[from, to]` that no observed play interval covers, in order, each at least
 * a second long (shorter slivers are clock noise between the last save and the presence).
 */
export function uncoveredStretches(from: number, to: number, observed: readonly ObservedPlayInterval[]): Array<[number, number]> {
	const covered = observed
		.filter((interval) => Number.isFinite(interval.fromMs) && Number.isFinite(interval.toMs) && interval.toMs > interval.fromMs)
		.map((interval) => [Math.max(from, interval.fromMs), Math.min(to, interval.toMs)] as [number, number])
		.filter(([start, end]) => end > start)
		.sort((left, right) => left[0] - right[0]);
	const stretches: Array<[number, number]> = [];
	let cursor = from;
	for (const [start, end] of covered) {
		if (start > cursor) stretches.push([cursor, start]);
		cursor = Math.max(cursor, end);
	}
	if (to > cursor) stretches.push([cursor, to]);
	return stretches.filter(([start, end]) => end - start >= 1_000);
}

export function stopFailureFloor(
	state: Extract<SessionState, { status: 'stopping' | 'provisional' }>,
): number {
	return state.status === 'stopping'
		? Date.parse(state.stopRequestedAt)
		: Date.parse(state.finalSnapshot.completedAt);
}
