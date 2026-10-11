import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import {
	unavailableSessionPriceSnapshot,
	type SessionPriceCapture,
	type SessionPriceSnapshot,
} from '../economy/session-price-snapshot';
import type {
	AcquireLeaseResult,
	ActiveSessionLeaseHandle,
	AssertLeaseResult,
	ReleaseLeaseResult,
} from './coordination-model';
import {
	initialSessionState,
	sessionAuthorityFromLease,
	transitionSession,
} from './session-state-machine';
import type {
	SessionEvent,
	SessionFailureCode,
	SessionInProgressState,
	SessionState,
} from './session';
import type { SessionContaminationReview } from './session-contamination-review';
import {
	createSessionRuntimeRecord,
	recoverableState,
	type SessionRuntimeRecord,
	type SessionRuntimeStore,
	type SessionSummaryReceipt,
} from './session-runtime-store';
import { normalizeSessionStartInput, type SessionStartInput } from './session-start-capture';
import { settlementWait } from './session-api-settlement';
import type {
	ManualSessionStartResult,
	ManualSessionStopResult,
	ObservedPlayInterval,
	RecoveryMode,
	SessionBaselineCapture,
	SessionContaminationReviewResult,
	SessionLeaseCoordinator,
	SessionRecoveryResult,
	SessionRecoveryState,
	SessionStartFailure,
	SessionStopFailure,
	StartupFinalization,
} from './manual-session-start-model';
import { failure, ManualSessionStartError } from './manual-session-start-failure';
import { lastSavedEvidenceAt, snapshotReference, stopFailureFloor, uncoveredStretches } from './manual-session-evidence';
// The two failure mappers stay in the service: they read `HttpTransportError`, and only the reviewed
// service may import `core/http` (security-boundary). They are called, never evaluated at load.
import { mapFailure, mapStopFailure } from './manual-session-start-service';

/**
 * What the start, stop, recovery and reclaim of a manual session read, write and call on the
 * `ManualSessionStartService` they belong to. Every member is a function, so the transitions always
 * see the service's current state and evidence, never a copy taken when they were built. The service
 * owns every field shared with its other flows (`abandon`, `finalizeStoppedSession`, `initialize`,
 * the heartbeat and the watch); the transitions write them only through the `set…` members here.
 */
export interface ManualSessionTransitionsPort {
	disposed(): boolean;
	state(): SessionState;
	setState(state: SessionState): void;
	baselineSnapshot(): StorageSnapshot | null;
	setBaselineSnapshot(snapshot: StorageSnapshot | null): void;
	setFinalSnapshot(snapshot: StorageSnapshot | null): void;
	provisionalDelta(): StorageDelta | null;
	setProvisionalDelta(delta: StorageDelta | null): void;
	setContaminationReview(review: SessionContaminationReview | null): void;
	setPriceSnapshot(snapshot: SessionPriceSnapshot | null): void;
	currentHandle(): ActiveSessionLeaseHandle | null;
	setCurrentHandle(handle: ActiveSessionLeaseHandle | null): void;
	authorityFailure(): SessionStartFailure | null;
	setAuthorityFailure(failed: SessionStartFailure | null): void;
	setLastStopFailure(failed: SessionStopFailure | null): void;
	setLastEvidenceSavedAt(at: number): void;
	recoveryState(): SessionRecoveryState;
	setRecoveryState(state: SessionRecoveryState): void;
	recoveryRecord(): SessionRuntimeRecord | null;
	setRecoveryRecord(record: SessionRuntimeRecord | null): void;
	setStartupFinalization(finalization: StartupFinalization | null): void;
	heartbeatFlight(): Promise<void> | null;
	coordinator(): SessionLeaseCoordinator;
	baselineCapture(): SessionBaselineCapture;
	runtimeStore(): SessionRuntimeStore;
	priceCapture(): SessionPriceCapture | null;
	diagnostics(): LocalDebugActionPort | null;
	settlementWindowMs(): number;
	sessionId(): string;
	observedPlayIntervals(): readonly ObservedPlayInterval[];
	onStateChange(): void;
	onAutoRecovered(): void;
	initialize(): Promise<void>;
	getState(): SessionState;
	getCompletedSummaryReceipt(): SessionSummaryReceipt | null;
	resetCompletedSession(): Promise<boolean>;
	safeNow(): number;
	safeNowOr(fallback: number): number;
	timestampAtOrAfter(floor: number): string;
	safeTimestampAtOrAfter(floor: number): string;
	requireHandle(): ActiveSessionLeaseHandle;
	safeAcquire(sessionId: string): Promise<AcquireLeaseResult>;
	safeAssert(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult>;
	safeRelease(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult>;
	apply(event: SessionEvent): void;
	persistCurrentState(ownershipChecked?: boolean): Promise<void>;
	startHeartbeat(handle: ActiveSessionLeaseHandle): void;
	stopHeartbeat(): void;
	armSettlement(): void;
	stopSettlement(): void;
	scheduleAutoRetry(): void;
	clearAutoRetry(): void;
	reclaim(): Promise<SessionStopFailure | null>;
	reclaimableError(): Exclude<SessionInProgressState, { status: 'starting' }> | null;
	finalizeStoppedSession(): Promise<SessionContaminationReviewResult>;
	continueRecoveredSession(deferred: boolean): void;
	logUnmappedFailure(action: 'session_start' | 'session_finish', error: unknown): void;
	logAuthorityFailure(action: 'session_heartbeat' | 'session_finish', reason: 'lease_lost' | 'clock_anomaly' | 'coordination_unavailable'): void;
}

/**
 * The fenced transitions of a manual session (DE-07): the start (idle → active, and the cleanup of
 * a start that failed), the stop (active → stopping → provisional, H18.26), the recovery of a saved
 * record (H18.7), the startup finalize of a `provisional` one, and the reclaim of a session in
 * `error` (H18.4/H18.11). It owns only what nothing else writes: the last start failure and the
 * evidence instant the latest reclaim recovered from. Every other field is the service's, read and
 * written through the port. Its members keep the names and bodies they had on the service.
 */
export class ManualSessionTransitions {
	lastFailure: SessionStartFailure | null = null;
	/** Last evidence saved before the failure the latest reclaim recovered from; see `lastSavedEvidenceAt`. */
	private reclaimedEvidenceAt: number | null = null;

	constructor(private readonly port: ManualSessionTransitionsPort) {}

	// The service's own members under their own names, read and written through the port.
	private get disposed(): boolean { return this.port.disposed(); }
	private get state(): SessionState { return this.port.state(); }
	private set state(state: SessionState) { this.port.setState(state); }
	private get baselineSnapshot(): StorageSnapshot | null { return this.port.baselineSnapshot(); }
	private set baselineSnapshot(snapshot: StorageSnapshot | null) { this.port.setBaselineSnapshot(snapshot); }
	private set finalSnapshot(snapshot: StorageSnapshot | null) { this.port.setFinalSnapshot(snapshot); }
	private get provisionalDelta(): StorageDelta | null { return this.port.provisionalDelta(); }
	private set provisionalDelta(delta: StorageDelta | null) { this.port.setProvisionalDelta(delta); }
	private set contaminationReview(review: SessionContaminationReview | null) { this.port.setContaminationReview(review); }
	private set priceSnapshot(snapshot: SessionPriceSnapshot | null) { this.port.setPriceSnapshot(snapshot); }
	private get currentHandle(): ActiveSessionLeaseHandle | null { return this.port.currentHandle(); }
	private set currentHandle(handle: ActiveSessionLeaseHandle | null) { this.port.setCurrentHandle(handle); }
	private get authorityFailure(): SessionStartFailure | null { return this.port.authorityFailure(); }
	private set authorityFailure(failed: SessionStartFailure | null) { this.port.setAuthorityFailure(failed); }
	private set lastStopFailure(failed: SessionStopFailure | null) { this.port.setLastStopFailure(failed); }
	private set lastEvidenceSavedAt(at: number) { this.port.setLastEvidenceSavedAt(at); }
	private get recoveryState(): SessionRecoveryState { return this.port.recoveryState(); }
	private set recoveryState(state: SessionRecoveryState) { this.port.setRecoveryState(state); }
	private get recoveryRecord(): SessionRuntimeRecord | null { return this.port.recoveryRecord(); }
	private set recoveryRecord(record: SessionRuntimeRecord | null) { this.port.setRecoveryRecord(record); }
	private set startupFinalization(finalization: StartupFinalization | null) { this.port.setStartupFinalization(finalization); }
	private get heartbeatFlight(): Promise<void> | null { return this.port.heartbeatFlight(); }
	private get coordinator(): SessionLeaseCoordinator { return this.port.coordinator(); }
	private get baselineCapture(): SessionBaselineCapture { return this.port.baselineCapture(); }
	private get runtimeStore(): SessionRuntimeStore { return this.port.runtimeStore(); }
	private get priceCapture(): SessionPriceCapture | null { return this.port.priceCapture(); }
	private get diagnostics(): LocalDebugActionPort | null { return this.port.diagnostics(); }
	private get settlementWindowMs(): number { return this.port.settlementWindowMs(); }
	private sessionId(): string { return this.port.sessionId(); }
	private observedPlayIntervals(): readonly ObservedPlayInterval[] { return this.port.observedPlayIntervals(); }
	private onStateChange(): void { this.port.onStateChange(); }
	private onAutoRecovered(): void { this.port.onAutoRecovered(); }
	private initialize(): Promise<void> { return this.port.initialize(); }
	private getState(): SessionState { return this.port.getState(); }
	private getCompletedSummaryReceipt(): SessionSummaryReceipt | null { return this.port.getCompletedSummaryReceipt(); }
	private resetCompletedSession(): Promise<boolean> { return this.port.resetCompletedSession(); }
	private safeNow(): number { return this.port.safeNow(); }
	private safeNowOr(fallback: number): number { return this.port.safeNowOr(fallback); }
	private timestampAtOrAfter(floor: number): string { return this.port.timestampAtOrAfter(floor); }
	private safeTimestampAtOrAfter(floor: number): string { return this.port.safeTimestampAtOrAfter(floor); }
	private requireHandle(): ActiveSessionLeaseHandle { return this.port.requireHandle(); }
	private safeAcquire(sessionId: string): Promise<AcquireLeaseResult> { return this.port.safeAcquire(sessionId); }
	private safeAssert(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult> { return this.port.safeAssert(handle); }
	private safeRelease(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult> { return this.port.safeRelease(handle); }
	private apply(event: SessionEvent): void { this.port.apply(event); }
	private persistCurrentState(ownershipChecked?: boolean): Promise<void> { return this.port.persistCurrentState(ownershipChecked); }
	private startHeartbeat(handle: ActiveSessionLeaseHandle): void { this.port.startHeartbeat(handle); }
	private stopHeartbeat(): void { this.port.stopHeartbeat(); }
	private armSettlement(): void { this.port.armSettlement(); }
	private stopSettlement(): void { this.port.stopSettlement(); }
	private scheduleAutoRetry(): void { this.port.scheduleAutoRetry(); }
	private clearAutoRetry(): void { this.port.clearAutoRetry(); }
	private reclaim(): Promise<SessionStopFailure | null> { return this.port.reclaim(); }
	private reclaimableError(): Exclude<SessionInProgressState, { status: 'starting' }> | null { return this.port.reclaimableError(); }
	private finalizeStoppedSession(): Promise<SessionContaminationReviewResult> { return this.port.finalizeStoppedSession(); }
	private continueRecoveredSession(deferred: boolean): void { this.port.continueRecoveredSession(deferred); }
	private logUnmappedFailure(action: 'session_start' | 'session_finish', error: unknown): void { this.port.logUnmappedFailure(action, error); }
	private logAuthorityFailure(action: 'session_heartbeat' | 'session_finish', reason: 'lease_lost' | 'clock_anomaly' | 'coordination_unavailable'): void { this.port.logAuthorityFailure(action, reason); }

	async autoFinalizeProvisionalRecord(record: SessionRuntimeRecord): Promise<void> {
		if (record.state.status === 'complete') return;
		const recordState = record.state;
		const fallbackToRecoverable = (): void => {
			this.recoveryRecord = record;
			this.recoveryState = { status: 'available', state: recordState };
			// Nobody has to press "Recover" for it either (H18.7): the watch retries on its own.
			if (!this.disposed) this.scheduleAutoRetry();
			this.onStateChange();
		};
		if (this.disposed || this.state.status !== 'idle') {
			fallbackToRecoverable();
			return;
		}
		const persisted = recoverableState(record.state);
		const acquisition = await this.safeAcquire(persisted.sessionId);
		if (acquisition.status === 'busy' || acquisition.status === 'error') {
			fallbackToRecoverable();
			return;
		}
		const handle = acquisition.handle;
		if (handle.sessionId !== persisted.sessionId) {
			await this.safeRelease(handle);
			fallbackToRecoverable();
			return;
		}
		const authority = sessionAuthorityFromLease(handle);
		const owned = await this.safeAssert(handle);
		if (owned.status !== 'owned') {
			await this.safeRelease(handle);
			fallbackToRecoverable();
			return;
		}
		const transition = transitionSession(record.state, {
			type: 'recover',
			authority,
			recoveredAt: this.timestampAtOrAfter(authority.acquiredAt),
		});
		if (transition.status === 'rejected') {
			await this.safeRelease(handle);
			fallbackToRecoverable();
			return;
		}
		const recoveredRecord = createSessionRuntimeRecord(
			transition.state,
			record.baselineSnapshot,
			record.finalSnapshot,
			record.delta,
			this.safeNow(),
			record.review,
			record.priceSnapshot,
		);
		if (!recoveredRecord || (await this.runtimeStore.save(recoveredRecord)).status !== 'saved') {
			await this.safeRelease(handle);
			fallbackToRecoverable();
			return;
		}
		this.state = transition.state;
		this.baselineSnapshot = structuredClone(record.baselineSnapshot);
		this.finalSnapshot = record.finalSnapshot === null ? null : structuredClone(record.finalSnapshot);
		this.provisionalDelta = record.delta === null ? null : structuredClone(record.delta);
		this.contaminationReview = record.review === null ? null : structuredClone(record.review);
		this.priceSnapshot = record.priceSnapshot === null ? null : structuredClone(record.priceSnapshot);
		this.currentHandle = handle;
		this.authorityFailure = null;
		this.recoveryRecord = null;
		this.recoveryState = { status: 'none' };
		this.startHeartbeat(handle);
		this.onStateChange();
		// A failure here (store unavailable) leaves the session `provisional` with its lease held,
		// exactly as a live `stop()` would: the next `finalizeStoppedSession()` call — the app's own
		// retry, or the next restart through this same path — tries again from the same evidence.
		const delta = this.provisionalDelta;
		const result = await this.finalizeStoppedSession();
		if (result.status === 'finalized' && delta) {
			this.startupFinalization = { sessionId: result.state.sessionId, delta, review: result };
		}
	}

	/**
	 * The fenced recover/discard of the saved record. `mode` only changes what happens around it:
	 * `manual` is a click (visible "working" state), `startup` runs inside `initialize()` (the host
	 * is not wired yet, so nothing is dispatched to it synchronously) and `watch` is the automatic
	 * retry (the host hears about a success through `onAutoRecovered`). A recover that cannot happen
	 * yet schedules its own retry: at the other owner's lease expiry, or after the usual backoff.
	 */
	async recoverRecordInternal(action: 'recover' | 'discard', mode: RecoveryMode): Promise<SessionRecoveryResult> {
		const record = this.recoveryRecord;
		if (this.disposed || !record || this.state.status !== 'idle') {
			return { status: 'failed', message: 'There is no saved session available to recover.' };
		}
		if (record.state.status === 'complete') {
			return { status: 'failed', message: 'The saved session is already complete.' };
		}
		if (mode === 'manual') {
			this.recoveryState = { status: 'working', action, state: record.state };
			this.onStateChange();
		}
		const persisted = recoverableState(record.state);
		const acquisition = await this.safeAcquire(persisted.sessionId);
		if (acquisition.status === 'busy') {
			const message = 'Another Obsidian window still owns this farming session.';
			this.logRecoveryBusy(action, acquisition.ownerExpiresAt, acquisition.ownerInstanceId, acquisition.ownerMachineId);
			this.recoveryState = {
				status: 'busy', state: record.state, message, ownerExpiresAt: acquisition.ownerExpiresAt,
			};
			this.onStateChange();
			return { status: 'busy', message };
		}
		if (acquisition.status === 'error') {
			const message = 'Session coordination is unavailable, so the saved session was left untouched.';
			this.recoveryState = { status: 'available', state: record.state, message };
			this.onStateChange();
			return { status: 'failed', message };
		}
		const handle = acquisition.handle;
		if (handle.sessionId !== persisted.sessionId) {
			await this.safeRelease(handle);
			const message = 'A different farming session is already owned by this Obsidian window.';
			this.logRecoveryBusy(action, handle.expiresAt, handle.instanceId, handle.machineId);
			this.recoveryState = { status: 'busy', state: record.state, message, ownerExpiresAt: handle.expiresAt };
			this.onStateChange();
			return { status: 'busy', message };
		}
		const authority = sessionAuthorityFromLease(handle);
		const owned = await this.safeAssert(handle);
		if (owned.status !== 'owned') {
			await this.safeRelease(handle);
			const message = 'The recovered session lease was lost before it could be committed.';
			this.recoveryState = { status: 'available', state: record.state, message };
			this.onStateChange();
			return { status: 'failed', message };
		}
		if (action === 'discard') {
			const cleared = await this.runtimeStore.clear(authority);
			await this.safeRelease(handle);
			if (cleared.status !== 'cleared') {
				const message = 'The saved session could not be discarded safely.';
				this.recoveryState = { status: 'available', state: record.state, message };
				this.onStateChange();
				return { status: 'failed', message };
			}
			this.recoveryRecord = null;
			this.recoveryState = { status: 'none' };
			this.onStateChange();
			return { status: 'discarded' };
		}

		const transition = transitionSession(record.state, {
			type: 'recover',
			authority,
			recoveredAt: this.timestampAtOrAfter(authority.acquiredAt),
		});
		if (transition.status === 'rejected') {
			await this.safeRelease(handle);
			const message = 'The saved session authority could not be recovered safely.';
			this.recoveryState = { status: 'available', state: record.state, message };
			this.onStateChange();
			return { status: 'failed', message };
		}
		const recoveredRecord = createSessionRuntimeRecord(
			transition.state,
			record.baselineSnapshot,
			record.finalSnapshot,
			record.delta,
			this.safeNow(),
			record.review,
			record.priceSnapshot,
		);
		if (!recoveredRecord || (await this.runtimeStore.save(recoveredRecord)).status !== 'saved') {
			await this.safeRelease(handle);
			const message = 'The recovered authority could not be persisted safely.';
			this.recoveryState = { status: 'available', state: record.state, message };
			this.onStateChange();
			return { status: 'failed', message };
		}
		this.state = transition.state;
		this.baselineSnapshot = structuredClone(record.baselineSnapshot);
		this.finalSnapshot = record.finalSnapshot === null ? null : structuredClone(record.finalSnapshot);
		this.provisionalDelta = record.delta === null ? null : structuredClone(record.delta);
		this.contaminationReview = record.review === null ? null : structuredClone(record.review);
		this.priceSnapshot = record.priceSnapshot === null ? null : structuredClone(record.priceSnapshot);
		this.currentHandle = handle;
		this.authorityFailure = null;
		this.recoveryRecord = null;
		this.recoveryState = { status: 'none' };
		this.startHeartbeat(handle);
		// H18.11: a session found `active` on disk ran through a gap nothing observed (Obsidian
		// closed, or a window that died). It goes on and still ends at the player's stop, but the
		// gap from the last evidence the record saved to now is recorded and subtracted. Only an
		// `active` record carries that evidence: a saved failure's timestamps come from after the gap,
		// so that case keeps counting it, as before.
		if (transition.state.status === 'active' && record.state.status === 'active') {
			await this.recordUnobservedGap(lastSavedEvidenceAt(record, null, persisted));
		}
		this.clearAutoRetry();
		this.onStateChange();
		// A session recovered mid-wait keeps waiting, and one whose window already elapsed while
		// Obsidian was closed captures now instead of losing the stop the player already requested.
		// At startup the capture waits for the watch's first tick: the host is still being wired.
		this.continueRecoveredSession(mode === 'startup');
		if (mode === 'watch') this.onAutoRecovered();
		return { status: 'recovered', state: this.getState() };
	}

	async startInternal(input: SessionStartInput): Promise<ManualSessionStartResult> {
		await this.initialize();
		// The next session no longer needs the previous one cleared by hand (H18.8), but its result
		// is only released once its summary is proven saved in the vault: otherwise it stays, whole.
		if (this.state.status === 'complete' && !this.disposed) {
			if (this.getCompletedSummaryReceipt() === null) {
				return this.failWithoutLease('busy', 'The finished session summary is not saved yet, so it was kept.');
			}
			if (!await this.resetCompletedSession()) {
				return this.failWithoutLease('coordination_unavailable', 'The finished session could not be released safely.');
			}
		}
		// An abandoned session already released its lease and its record: nothing is left to keep.
		if (this.state.status === 'abandoned') {
			const reset = transitionSession(this.state, { type: 'reset' });
			if (reset.status !== 'rejected') this.state = reset.state;
		}
		this.lastFailure = null;
		this.lastStopFailure = null;
		this.provisionalDelta = null;
		this.contaminationReview = null;
		this.priceSnapshot = null;
		this.authorityFailure = null;
		this.lastEvidenceSavedAt = 0;
		if (this.disposed) return this.failWithoutLease('coordination_unavailable', 'Session coordination is unavailable.');
		if (this.recoveryState.status !== 'none') {
			return this.failWithoutLease('busy', 'Recover or discard the saved farming session first.');
		}
		if (this.state.status !== 'idle') {
			return this.failWithoutLease('busy', 'A farming session is already in progress.');
		}
		let normalizedInput: SessionStartInput;
		try {
			normalizedInput = normalizeSessionStartInput(input);
		} catch (error) {
			const mapped = mapFailure(error);
			return this.failWithoutLease(mapped.code, mapped.message);
		}

		const requestedSessionId = this.sessionId();
		let acquisition = await this.safeAcquire(requestedSessionId);
		if (acquisition.status === 'already_owned' && acquisition.handle.sessionId !== requestedSessionId) {
			const released = await this.safeRelease(acquisition.handle);
			if (released.status !== 'released') {
				return this.failWithoutLease('coordination_unavailable', 'A previous session lease could not be cleared.');
			}
			acquisition = await this.safeAcquire(requestedSessionId);
		}
		if (acquisition.status === 'busy') {
			return this.failWithoutLease('busy', 'Another Obsidian window is starting or tracking a session.');
		}
		if (acquisition.status === 'error') {
			return this.failWithoutLease('coordination_unavailable', 'Session coordination is unavailable.');
		}

		this.currentHandle = acquisition.handle;
		const authority = sessionAuthorityFromLease(acquisition.handle);
		try {
			const requestedAt = this.timestampAtOrAfter(authority.acquiredAt);
			this.apply({ type: 'request_start', authority, requestedAt });
			this.startHeartbeat(acquisition.handle);
			// The baseline must start after the request (`requestedAt <= baseline.startedAt`, checked by
			// the state machine): a capture another flow already had in flight is never adopted.
			const captured = await this.baselineCapture.capture(normalizedInput, Date.parse(requestedAt));
			if (this.authorityFailure) throw new ManualSessionStartError(this.authorityFailure);
			const owned = await this.safeAssert(this.requireHandle());
			if (owned.status === 'error') {
				throw new ManualSessionStartError(
					failure('coordination_unavailable', 'Session coordination became unavailable.'),
				);
			}
			if (owned.status === 'lost') {
				throw new ManualSessionStartError(
					failure('lease_lost', 'The session lease was lost before the baseline could be committed.'),
				);
			}
			this.apply({
				type: 'confirm_start',
				authority,
				baseline: snapshotReference(captured.snapshot),
				startContext: captured.context,
			});
			this.baselineSnapshot = structuredClone(captured.snapshot);
			await this.persistCurrentState(true);
			return { status: 'started', state: this.getState() as Extract<SessionState, { status: 'active' }> };
		} catch (error) {
			const mapped = mapFailure(error, (raw) => { this.logUnmappedFailure('session_start', raw); });
			await this.cleanupFailedStart(mapped, authority);
			return { status: 'failed', failure: mapped };
		}
	}

	async stopInternal(force: boolean, endAtMs: number | null = null): Promise<ManualSessionStopResult> {
		this.lastStopFailure = null;
		if (this.disposed) {
			return this.failStop('coordination_unavailable', 'Session coordination is unavailable.');
		}
		// "Retry" from `error` used to answer `unexpected` every time (H18.4). It now takes the
		// session back through the lease first, exactly like a restart would, and only then goes on
		// from the phase the store actually holds; a window that lost the race stays in `error`.
		if (this.state.status === 'error') {
			const reclaimFailure = await this.reclaim();
			if (reclaimFailure !== null) return this.failStop(reclaimFailure.code, reclaimFailure.message);
			// Taken back as `active`: no stop request ever reached the store, and this retry may come
			// hours after the failure. The end is the last evidence saved before it, marked uncertain,
			// never the moment of the retry.
			// (Re-read on purpose: `reclaim()` replaced the state the narrowing above still assumes.)
			const reclaimedStatus: SessionState['status'] = (this.state as SessionState).status;
			if (reclaimedStatus === 'active' && this.reclaimedEvidenceAt !== null) {
				const stopFailure = await this.requestStopFromSavedEvidence(this.reclaimedEvidenceAt);
				if (stopFailure !== null) return this.failStop(stopFailure.code, stopFailure.message);
			}
		}
		if (this.state.status === 'provisional') {
			// The final snapshot is already committed: hand it back so the host finalizes again.
			if (!this.provisionalDelta) return this.failStop('unexpected', 'The session final evidence is unavailable.');
			return {
				status: 'stopped',
				state: this.getState() as Extract<SessionState, { status: 'provisional' }>,
				delta: structuredClone(this.provisionalDelta),
				resumed: true,
			};
		}
		if (this.state.status !== 'active' && this.state.status !== 'stopping') {
			return this.failStop('unexpected', 'There is no active farming session to stop.');
		}
		if (!this.baselineSnapshot || !this.baselineCapture.captureFinal) {
			return this.failStop('unexpected', 'The session baseline is unavailable.');
		}

		const authority = this.state.authority;
		try {
			if (this.state.status === 'active') {
				const baselineAt = Date.parse(this.state.baseline.completedAt);
				// H18.26: an end the in-game presence observed wins; it is evidence, not a guess.
				const observedEnd = endAtMs !== null && Number.isSafeInteger(endAtMs)
					? new Date(Math.max(baselineAt, Math.min(endAtMs, this.safeNow()))).toISOString()
					: null;
				// H18.11: otherwise the end is the player's stop, even after a gap; the gap itself is
				// already recorded on the session and subtracted from its duration.
				this.apply({
					type: 'request_stop',
					authority,
					requestedAt: observedEnd ?? this.timestampAtOrAfter(baselineAt),
				});
				await this.persistCurrentState();
			}
			const stopping = this.state;
			if (stopping.status !== 'stopping') {
				return this.failStop('unexpected', 'The session could not enter the stopping state.');
			}
			const wait = settlementWait(stopping.stopRequestedAt, this.safeNow(), this.settlementWindowMs);
			if (wait === null) {
				return this.failStop('unexpected', 'The session stop boundary is unusable.');
			}
			if (!force && wait.status === 'waiting') {
				this.armSettlement();
				this.onStateChange();
				return { status: 'awaiting_settlement', state: structuredClone(stopping), wait };
			}
			this.stopSettlement();
			// The final snapshot must start at or after the stop request (`stoppedAt <= finalSnapshot.startedAt`):
			// a capture another flow (the detection poll) already had in flight is never adopted.
			const finalSnapshot = await this.baselineCapture.captureFinal(Date.parse(stopping.stopRequestedAt));
			const finalReference = snapshotReference(finalSnapshot);
			const delta = compareStorageSnapshots(this.baselineSnapshot, finalSnapshot);
			if (delta.status === 'invalid') {
				if (delta.reasons.some((reason) => reason.code === 'account_mismatch')) {
					return this.failStop(
						'account_changed',
						'The API key now belongs to another account than the one this session started with.',
					);
				}
				return this.failStop(
					'delta_invalid',
					'The final account snapshot could not be compared with the session baseline.',
				);
			}
			let priceSnapshot: SessionPriceSnapshot;
			try {
				priceSnapshot = this.priceCapture
					? await this.priceCapture.capture(stopping.sessionId, delta)
					: unavailableSessionPriceSnapshot(
						stopping.sessionId,
						delta,
						Math.max(this.safeNow(), Date.parse(finalSnapshot.completedAt)),
					);
			} catch (error) {
				// H15.8 (2026-09-10 audit): the stop still succeeds with a degraded valuation, but
				// until now nothing recorded that the degradation happened at all, or why.
				this.diagnostics?.event({
					component: 'session', action: 'session_finish', level: 'error', phase: 'failure',
					code: 'unavailable', state: 'price_capture', details: unmappedErrorLogDetails(error),
				});
				priceSnapshot = unavailableSessionPriceSnapshot(
					stopping.sessionId,
					delta,
					Math.max(this.safeNow(), Date.parse(finalSnapshot.completedAt)),
				);
			}
			if (this.authorityFailure) throw new ManualSessionStartError(this.authorityFailure);
			const owned = await this.safeAssert(this.requireHandle());
			if (owned.status === 'error') {
				this.logAuthorityFailure('session_finish', owned.code === 'clock_anomaly' ? 'clock_anomaly' : 'coordination_unavailable');
				throw new ManualSessionStartError(
					failure('coordination_unavailable', 'Session coordination became unavailable.'),
				);
			}
			if (owned.status === 'lost') {
				throw new ManualSessionStartError(
					failure('lease_lost', 'The session lease was lost before the final snapshot could be committed.'),
				);
			}
			this.apply({
				type: 'confirm_stop',
				authority,
				stoppedAt: stopping.stopRequestedAt,
				finalSnapshot: finalReference,
			});
			this.finalSnapshot = structuredClone(finalSnapshot);
			this.provisionalDelta = structuredClone(delta);
			this.priceSnapshot = structuredClone(priceSnapshot);
			await this.persistCurrentState(true);
			return {
				status: 'stopped',
				state: this.getState() as Extract<SessionState, { status: 'provisional' }>,
				delta: structuredClone(delta),
			};
		} catch (error) {
			const mapped = mapStopFailure(error, (raw) => { this.logUnmappedFailure('session_finish', raw); });
			if (mapped.code === 'lease_lost' || mapped.code === 'coordination_unavailable') {
				this.stopHeartbeat();
				try {
					const failedState = this.getState();
					if (failedState.status === 'stopping' || failedState.status === 'provisional') {
						const failedAtFloor = stopFailureFloor(failedState);
						this.apply({
							type: 'fail',
							authority,
							failedAt: this.safeTimestampAtOrAfter(failedAtFloor),
							code: mapped.code === 'lease_lost' ? 'lease_lost' : 'storage_unavailable',
						});
					}
				} catch { /* preserve the last valid state if the terminal transition is rejected */ }
			}
			return this.failStop(mapped.code, mapped.message);
		}
	}

	/**
	 * Takes a session in `error` back (H18.4/H18.7) without trusting anything this window still
	 * remembers: the saved record is the source of truth and the lease is acquired again under a
	 * new fence, exactly like a restart. The store only accepts the recovered record if its evidence
	 * is the one already saved, so an older writer can never overwrite a newer one; a live owner
	 * elsewhere keeps the session; and a session another window already finished is adopted as it
	 * is instead of being finished a second, different time.
	 */
	async reclaimInternal(): Promise<SessionStopFailure | null> {
		const failed = this.reclaimableError();
		if (this.disposed) return { code: 'coordination_unavailable', message: 'Session coordination is unavailable.' };
		if (failed === null) {
			return this.state.status === 'error'
				? { code: 'unexpected', message: 'There is no farming session to take back.' }
				: null;
		}
		const sessionId = failed.sessionId;
		this.stopHeartbeat();
		await this.heartbeatFlight;
		const stale = this.currentHandle;
		this.currentHandle = null;
		this.reclaimedEvidenceAt = null;
		// Whatever this window still holds is released first, so the lease is issued again under a
		// newer fence rather than reused: a lease that expired while asleep simply comes back vacant.
		if (stale) await this.safeRelease(stale);
		const loaded = await this.runtimeStore.load();
		if (loaded.status === 'error') {
			return { code: 'coordination_unavailable', message: 'Session recovery storage is unavailable.' };
		}
		if (loaded.status === 'empty' || loaded.status === 'live') {
			return { code: 'lease_lost', message: 'The saved farming session no longer exists.' };
		}
		const record = loaded.record;
		const storedSessionId = record.state.status === 'complete'
			? record.state.sessionId
			: recoverableState(record.state).sessionId;
		if (storedSessionId !== sessionId) {
			return { code: 'lease_lost', message: 'Another farming session replaced this one.' };
		}
		if (record.state.status === 'complete') {
			this.adoptRecord(record);
			this.clearAutoRetry();
			this.onStateChange();
			return { code: 'lease_lost', message: 'Another Obsidian window already finished this farming session.' };
		}
		let acquisition = await this.safeAcquire(sessionId);
		if (acquisition.status === 'already_owned') {
			const released = await this.safeRelease(acquisition.handle);
			if (released.status === 'error') {
				return { code: 'coordination_unavailable', message: 'Session coordination is unavailable.' };
			}
			acquisition = await this.safeAcquire(sessionId);
		}
		if (acquisition.status === 'busy' || acquisition.status === 'already_owned') {
			return { code: 'lease_lost', message: 'Another Obsidian window owns this farming session.' };
		}
		if (acquisition.status === 'error') {
			return { code: 'coordination_unavailable', message: 'Session coordination is unavailable.' };
		}
		const handle = acquisition.handle;
		if (handle.sessionId !== sessionId) {
			await this.safeRelease(handle);
			return { code: 'lease_lost', message: 'Another farming session owns the lease.' };
		}
		const owned = await this.safeAssert(handle);
		if (owned.status !== 'owned') {
			await this.safeRelease(handle);
			return owned.status === 'lost'
				? { code: 'lease_lost', message: 'The session lease was lost before it could be taken back.' }
				: { code: 'coordination_unavailable', message: 'Session coordination is unavailable.' };
		}
		const authority = sessionAuthorityFromLease(handle);
		const transition = transitionSession(record.state, {
			type: 'recover',
			authority,
			recoveredAt: this.timestampAtOrAfter(authority.acquiredAt),
		});
		const recoveredState = transition.state;
		if (transition.status === 'rejected' || recoveredState === null || recoveredState.status === 'error'
			|| recoveredState.status === 'idle' || recoveredState.status === 'starting' || recoveredState.status === 'complete'
			|| recoveredState.status === 'abandoned') {
			await this.safeRelease(handle);
			return { code: 'unexpected', message: 'The saved session authority could not be taken back safely.' };
		}
		const recoveredRecord = createSessionRuntimeRecord(
			recoveredState,
			record.baselineSnapshot,
			record.finalSnapshot,
			record.delta,
			this.safeNow(),
			record.review,
			record.priceSnapshot,
		);
		const saved = recoveredRecord === null ? null : await this.runtimeStore.save(recoveredRecord);
		if (saved?.status !== 'saved') {
			await this.safeRelease(handle);
			return saved?.status === 'stale'
				? { code: 'lease_lost', message: 'A newer session owner rejected this stale write.' }
				: { code: 'coordination_unavailable', message: 'Session recovery storage is unavailable.' };
		}
		this.adoptRecord({ ...record, state: recoveredState });
		this.currentHandle = handle;
		this.authorityFailure = null;
		this.clearAutoRetry();
		this.startHeartbeat(handle);
		this.reclaimedEvidenceAt = lastSavedEvidenceAt(record, stale?.renewedAt ?? null, failed);
		// H18.11: an active session that failed while active (a suspend that outlived the lease)
		// goes on as it was; the stretch from the last evidence before the failure to now is recorded
		// as unobserved and subtracted from its duration, and the end stays the player's stop.
		if (recoveredState.status === 'active' && failed.status === 'active' && (stale !== null || record.state.status === 'active')) {
			await this.recordUnobservedGap(this.reclaimedEvidenceAt);
		}
		this.onStateChange();
		// The player had asked to stop, but the request never reached the store: the saved record
		// came back `active`. Resuming it would forget the stop, and stopping "now" would count
		// every hour since the failure as play (H18.4); the stop is re-requested at the last saved
		// evidence instead, and marked uncertain.
		if (recoveredState.status === 'active' && failed.status !== 'active') {
			return await this.requestStopFromSavedEvidence(this.reclaimedEvidenceAt);
		}
		return null;
	}

	/**
	 * Requests the stop of an `active` session at `evidenceAt`, the last evidence saved before a
	 * failure, and marks the boundary `last_saved_evidence` (H18.4). Used only when a stop has to
	 * be retried without its original request on disk; the retry's own clock never becomes the end.
	 * A write refused here leaves the session in `error` with that same stop in memory, so the next
	 * attempt re-requests it instead of resuming the session.
	 */
	private async requestStopFromSavedEvidence(evidenceAt: number): Promise<SessionStopFailure | null> {
		if (this.state.status !== 'active' || !this.baselineSnapshot) return null;
		const authority = this.state.authority;
		const requested = transitionSession(this.state, {
			type: 'request_stop',
			authority,
			requestedAt: new Date(Math.max(evidenceAt, Date.parse(this.state.baseline.completedAt))).toISOString(),
			stopBoundary: 'last_saved_evidence',
		});
		const stopping = requested.state;
		if (requested.status === 'rejected' || stopping?.status !== 'stopping') {
			return { code: 'unexpected', message: 'The interrupted stop could not be requested again.' };
		}
		const record = createSessionRuntimeRecord(
			stopping, this.baselineSnapshot, null, null, this.safeNowOr(evidenceAt), null, null,
		);
		const saved = record === null ? null : await this.runtimeStore.save(record);
		if (saved?.status !== 'saved') {
			this.stopHeartbeat();
			const failedTransition = transitionSession(stopping, {
				type: 'fail',
				authority,
				failedAt: this.safeTimestampAtOrAfter(Date.parse(stopping.stopRequestedAt)),
				code: saved?.status === 'stale' ? 'lease_lost' : 'storage_unavailable',
			});
			if (failedTransition.status !== 'rejected' && failedTransition.state !== null) this.state = failedTransition.state;
			this.onStateChange();
			return saved?.status === 'stale'
				? { code: 'lease_lost', message: 'A newer session owner rejected this stale write.' }
				: { code: 'coordination_unavailable', message: 'Session recovery storage is unavailable.' };
		}
		this.state = stopping;
		this.onStateChange();
		return null;
	}

	/**
	 * H18.11: records, on the `active` session just taken back, the stretch from `evidenceAt` (the
	 * last evidence saved before the interruption) to now as unobserved, minus whatever part the
	 * in-game presence saw being played. The end of the session is not touched: it stays the
	 * player's own stop, and the gap is subtracted from the duration instead. A write the store
	 * refuses keeps the gap in this window's state, which the stop request then persists anyway.
	 */
	private async recordUnobservedGap(evidenceAt: number): Promise<void> {
		if (this.state.status !== 'active' || !this.baselineSnapshot) return;
		const now = this.safeNowOr(evidenceAt);
		const from = Math.max(evidenceAt, Date.parse(this.state.baseline.completedAt));
		for (const [gapFrom, gapTo] of uncoveredStretches(from, now, this.observedPlayIntervals())) {
			if (this.state.status !== 'active') return;
			const recorded = transitionSession(this.state, {
				type: 'record_unobserved_gap',
				authority: this.state.authority,
				from: new Date(gapFrom).toISOString(),
				to: new Date(gapTo).toISOString(),
			});
			// Past the bound the session simply keeps counting the rest: never a failure.
			if (recorded.status === 'rejected' || recorded.state?.status !== 'active') return;
			this.state = recorded.state;
		}
		const record = createSessionRuntimeRecord(this.state, this.baselineSnapshot, null, null, now, null, null);
		const saved = record === null ? null : await this.runtimeStore.save(record);
		if (saved?.status !== 'saved') {
			this.diagnostics?.event({
				component: 'session', action: 'session_recover', level: 'warn', phase: 'failure',
				code: 'unavailable', state: 'unobserved_gap', details: { code: saved?.status ?? 'invalid' },
			});
		}
	}

	/** Replaces this window's memory of the session with a saved record, evidence included. */
	private adoptRecord(record: SessionRuntimeRecord): void {
		this.state = structuredClone(record.state);
		this.baselineSnapshot = structuredClone(record.baselineSnapshot);
		this.finalSnapshot = record.finalSnapshot === null ? null : structuredClone(record.finalSnapshot);
		this.provisionalDelta = record.delta === null ? null : structuredClone(record.delta);
		this.contaminationReview = record.review === null ? null : structuredClone(record.review);
		this.priceSnapshot = record.priceSnapshot === null ? null : structuredClone(record.priceSnapshot);
	}

	private async cleanupFailedStart(failed: SessionStartFailure, authority: ReturnType<typeof sessionAuthorityFromLease>): Promise<void> {
		this.stopHeartbeat();
		await this.heartbeatFlight;
		const failedAt = this.safeTimestampAtOrAfter(
			this.state.status === 'starting' ? Date.parse(this.state.requestedAt) : authority.acquiredAt,
		);
		try {
			if (this.state.status === 'starting') {
			const code: SessionFailureCode = failed.code === 'lease_lost'
				? 'lease_lost'
				: failed.code === 'coordination_unavailable'
					? 'storage_unavailable'
					: 'snapshot_failed';
				this.apply({ type: 'fail', authority, failedAt, code });
			}
		} catch { /* lease cleanup and idle reset still take precedence */ }
		const handle = this.currentHandle;
		this.currentHandle = null;
		if (handle) {
			const released = await this.safeRelease(handle);
			if (released.status === 'error') await this.safeRelease(handle);
		}
		try {
			if (this.state.status === 'error') this.apply({ type: 'reset' });
		} catch { /* force the failed-start terminal below */ }
		if (this.state.status !== 'idle') this.state = initialSessionState();
		this.baselineSnapshot = null;
		this.finalSnapshot = null;
		this.provisionalDelta = null;
		this.contaminationReview = null;
		this.priceSnapshot = null;
		this.lastFailure = failed;
		this.onStateChange();
	}

	private failStop(code: SessionStopFailure['code'], message: string): ManualSessionStopResult {
		const result = { code, message } satisfies SessionStopFailure;
		this.lastStopFailure = result;
		this.onStateChange();
		return { status: 'failed', failure: result };
	}

	/**
	 * Every pre-lease start rejection (disposed, recovery pending, already in progress, lease busy,
	 * coordination down) went through here with a useful `SessionStartFailure.code` for the player
	 * but 0 lines in the debug log (H15.26, 2026-09-10 audit): nothing distinguished a genuinely busy
	 * lease from the coordinator having thrown underneath `safeAcquire`/`safeRelease`. `details.code`
	 * carries that `SessionStartFailure` code; never the free-text `message`.
	 */
	private failWithoutLease(code: SessionStartFailure['code'], message: string): ManualSessionStartResult {
		const result = failure(code, message);
		this.lastFailure = result;
		this.diagnostics?.event({
			component: 'session', action: 'session_start', level: 'error', phase: 'failure',
			code: code === 'busy' ? 'precondition_failed' : 'unavailable',
			details: { code },
		});
		this.onStateChange();
		return { status: 'failed', failure: result };
	}

	/**
	 * The only local trace of a blocked recover/discard: without it, "Recuperación bloqueada" leaves
	 * no line in the debug log at all, and the player cannot tell a live contender from a stuck lease.
	 */
	private logRecoveryBusy(
		action: 'recover' | 'discard',
		ownerExpiresAt: number,
		ownerInstanceId: string,
		ownerMachineId: string,
	): void {
		this.diagnostics?.event({
			component: 'session',
			action: action === 'recover' ? 'session_recover' : 'session_discard',
			level: 'warn',
			phase: 'skip',
			code: 'precondition_failed',
			details: {
				reason: 'lease_owned_elsewhere',
				ownerExpiresAt,
				ownerInstanceId,
				ownerMachineId,
				selfInstanceId: this.coordinator.instanceId,
			},
		});
	}
}
