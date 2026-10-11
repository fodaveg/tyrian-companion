import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { HttpTransportError } from '../core/http';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import type { SessionPriceCapture, SessionPriceSnapshot } from '../economy/session-price-snapshot';
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
	SessionInProgressState,
	SessionState,
} from './session';
import {
	createSessionContaminationReview,
	type SessionContaminationReview,
} from './session-contamination-review';
import type { SessionItemTypeCapture } from './session-item-type-capture';
import {
	createSessionRuntimeRecord,
	recoverableState,
	type SessionRuntimeRecord,
	type SessionRuntimeStore,
	type SessionSummaryReceipt,
} from './session-runtime-store';
import { SessionStartCaptureError, type SessionStartInput } from './session-start-capture';
import {
	captureSettlement,
	settlementWait,
	settlementWindowMs,
	type SessionApiSettlement,
	type SessionSettlementWait,
} from './session-api-settlement';
import {
	isAbandonableStopFailure,
	SESSION_AUTO_RETRY_DELAYS_MS,
	SESSION_EVIDENCE_SAVE_INTERVAL_MS,
	type ManualSessionStartResult,
	type ManualSessionStartServiceOptions,
	type ManualSessionStopResult,
	type ObservedPlayInterval,
	type RecoveryMode,
	type SessionAbandonResult,
	type SessionBaselineCapture,
	type SessionContaminationReviewResult,
	type SessionLeaseCoordinator,
	type SessionRecoveryResult,
	type SessionRecoveryState,
	type SessionStartFailure,
	type SessionStopFailure,
	type StartupFinalization,
} from './manual-session-start-model';
import { failure, ManualSessionStartError, SessionTransitionRejectedError } from './manual-session-start-failure';
import { ManualSessionWatch } from './manual-session-watch';
import { ManualSessionHeartbeat } from './manual-session-runtime-heartbeat';
import { ManualSessionTransitions } from './manual-session-runtime-transitions';

// DE-07: the vocabulary moved to `manual-session-start-model.ts`; its consumers keep importing it from here.
export {
	isAbandonableStopFailure,
	SESSION_AUTO_RETRY_DELAYS_MS,
	SESSION_EVIDENCE_SAVE_INTERVAL_MS,
	type ManualSessionStartServiceOptions,
	type ManualSessionStopResult,
	type ObservedPlayInterval,
	type SessionLeaseCoordinator,
	type SessionRecoveryState,
	type SessionStartFailure,
	type SessionStopFailure,
};

/** Owns the fenced idle → active workflow and leaves no product session after a failed start. */
export class ManualSessionStartService {
	private state: SessionState = initialSessionState();
	/** The last start that failed, kept by `ManualSessionTransitions` (its only writer). */
	private get lastFailure(): SessionStartFailure | null { return this.transitions.lastFailure; }
	private currentHandle: ActiveSessionLeaseHandle | null = null;
	/** The renewal in flight, kept by `ManualSessionHeartbeat`; awaited before a session changes hands. */
	private get heartbeatFlight(): Promise<void> | null { return this.leaseHeartbeat.heartbeatFlight; }
	private authorityFailure: SessionStartFailure | null = null;
	private startFlight: Promise<ManualSessionStartResult> | null = null;
	private stopFlight: Promise<ManualSessionStopResult> | null = null;
	private reviewFlight: Promise<SessionContaminationReviewResult> | null = null;
	private baselineSnapshot: StorageSnapshot | null = null;
	private finalSnapshot: StorageSnapshot | null = null;
	private provisionalDelta: StorageDelta | null = null;
	private lastStopFailure: SessionStopFailure | null = null;
	private contaminationReview: SessionContaminationReview | null = null;
	private priceSnapshot: SessionPriceSnapshot | null = null;
	private recoveryState: SessionRecoveryState = { status: 'none' };
	private recoveryRecord: SessionRuntimeRecord | null = null;
	private preservedLegacyRecords: SessionRuntimeRecord[] = [];
	private legacyMigrationFlight: Promise<boolean> | null = null;
	/**
	 * Set once, right after `initialize()` auto-finalizes a `provisional` record it found already
	 * stopped, and only ever read by `takeStartupFinalization()`, which consumes it: the host needs
	 * this evidence to write the session's note and run the same post-finalize bookkeeping a live
	 * `stop()` triggers, since `initialize()` itself only reclaims the lease and classifies.
	 */
	private startupFinalization: StartupFinalization | null = null;
	private initializationFlight: Promise<void> | null = null;
	private recoveryFlight: Promise<SessionRecoveryResult> | null = null;
	private reclaimFlight: Promise<SessionStopFailure | null> | null = null;
	private abandonFlight: Promise<SessionAbandonResult> | null = null;
	/** Earliest instant the lifecycle watch may retry on its own; kept by `ManualSessionWatch`. */
	private get autoRetryAt(): number | null { return this.watch.autoRetryAt; }
	private set autoRetryAt(at: number | null) { this.watch.autoRetryAt = at; }
	/** Proof that the completed session's summary reached the vault (H18.8); see `markCompletedSummarySaved`. */
	private summaryReceipt: SessionSummaryReceipt | null = null;
	private disposed = false;
	private readonly automaticAccountCapture: boolean;
	private readonly now: () => number;
	private readonly sessionId: () => string;
	private readonly scheduleInterval: (callback: () => void, milliseconds: number) => unknown;
	private readonly cancelInterval: (handle: unknown) => void;
	private readonly onStateChange: () => void;
	private readonly onSettlementDue: () => void;
	private readonly runtimeStore: SessionRuntimeStore;
	private readonly priceCapture: SessionPriceCapture | null;
	private readonly farmedLossItemTypeCapture: SessionItemTypeCapture | null;
	private readonly diagnostics: LocalDebugActionPort | null;
	private readonly onAutoRecovered: () => void;
	/** The wait the final capture needs: the slowest endpoint it reads (H18.11). */
	private readonly settlementWindowMs: number;
	private readonly observedPlayIntervals: () => readonly ObservedPlayInterval[];
	/** The settlement wait and the automatic retries (H18.7), over this service's own state. */
	private readonly watch: ManualSessionWatch;
	/** The lease renewal and the periodic evidence save of an active session, over this service's own state. */
	private readonly leaseHeartbeat: ManualSessionHeartbeat;
	/** The start, stop, recovery and reclaim of a session, over this service's own state. */
	private readonly transitions: ManualSessionTransitions;
	/** Last instant the active record was re-saved as evidence (H18.11); kept by `ManualSessionHeartbeat`. */
	private get lastEvidenceSavedAt(): number { return this.leaseHeartbeat.lastEvidenceSavedAt; }
	private set lastEvidenceSavedAt(at: number) { this.leaseHeartbeat.lastEvidenceSavedAt = at; }

	constructor(
		private readonly coordinator: SessionLeaseCoordinator,
		private readonly baselineCapture: SessionBaselineCapture,
		options: ManualSessionStartServiceOptions,
	) {
		this.automaticAccountCapture = options.automaticAccountCapture !== false;
		this.now = options.now ?? Date.now;
		this.sessionId = options.sessionId ?? (() => crypto.randomUUID());
		this.scheduleInterval = options.setInterval ?? ((callback, milliseconds) => window.setInterval(callback, milliseconds));
		this.cancelInterval = options.clearInterval ?? ((handle) => window.clearInterval(handle as number));
		this.onStateChange = options.onStateChange ?? (() => undefined);
		this.onSettlementDue = options.onSettlementDue ?? (() => { void this.stop(); });
		this.runtimeStore = options.runtimeStore;
		this.priceCapture = options.priceCapture ?? null;
		this.farmedLossItemTypeCapture = options.farmedLossItemTypeCapture ?? null;
		this.diagnostics = options.diagnostics ?? null;
		this.onAutoRecovered = options.onAutoRecovered ?? (() => undefined);
		this.settlementWindowMs = settlementWindowMs(options.settlementWindowByEndpointMs);
		this.observedPlayIntervals = options.observedPlayIntervals ?? (() => []);
		this.watch = new ManualSessionWatch({
			disposed: () => this.disposed,
			state: () => this.state,
			stopFlight: () => this.stopFlight,
			reviewFlight: () => this.reviewFlight,
			reclaimFlight: () => this.reclaimFlight,
			recoveryFlight: () => this.recoveryFlight,
			recoveryRecord: () => this.recoveryRecord,
			recoveryState: () => this.recoveryState,
			diagnostics: () => this.diagnostics,
			scheduleInterval: (callback, milliseconds) => this.scheduleInterval(callback, milliseconds),
			cancelInterval: (handle) => { this.cancelInterval(handle); },
			safeNowOr: (fallback) => this.safeNowOr(fallback),
			getSettlementWait: () => this.getSettlementWait(),
			onSettlementDue: () => { this.onSettlementDue(); },
			onAutoRecovered: () => { this.onAutoRecovered(); },
			reclaimableError: () => this.reclaimableError(),
			reclaim: () => this.reclaim(),
			runRecovery: (action, mode) => this.runRecovery(action, mode),
			continueRecoveredSession: (deferred) => { this.continueRecoveredSession(deferred); },
		});
		this.leaseHeartbeat = new ManualSessionHeartbeat({
			disposed: () => this.disposed,
			state: () => this.state,
			baselineSnapshot: () => this.baselineSnapshot,
			stopFlight: () => this.stopFlight,
			currentHandle: () => this.currentHandle,
			setCurrentHandle: (handle) => { this.currentHandle = handle; },
			coordinator: () => this.coordinator,
			runtimeStore: () => this.runtimeStore,
			diagnostics: () => this.diagnostics,
			scheduleInterval: (callback, milliseconds) => this.scheduleInterval(callback, milliseconds),
			cancelInterval: (handle) => { this.cancelInterval(handle); },
			safeNowOr: (fallback) => this.safeNowOr(fallback),
			logAuthorityFailure: (action, reason) => { this.logAuthorityFailure(action, reason); },
			failFromAuthority: (mapped) => { this.failFromAuthority(mapped); },
		});
		this.transitions = new ManualSessionTransitions({
			disposed: () => this.disposed,
			state: () => this.state,
			setState: (state) => { this.state = state; },
			baselineSnapshot: () => this.baselineSnapshot,
			setBaselineSnapshot: (snapshot) => { this.baselineSnapshot = snapshot; },
			setFinalSnapshot: (snapshot) => { this.finalSnapshot = snapshot; },
			provisionalDelta: () => this.provisionalDelta,
			setProvisionalDelta: (delta) => { this.provisionalDelta = delta; },
			setContaminationReview: (review) => { this.contaminationReview = review; },
			setPriceSnapshot: (snapshot) => { this.priceSnapshot = snapshot; },
			currentHandle: () => this.currentHandle,
			setCurrentHandle: (handle) => { this.currentHandle = handle; },
			authorityFailure: () => this.authorityFailure,
			setAuthorityFailure: (failed) => { this.authorityFailure = failed; },
			setLastStopFailure: (failed) => { this.lastStopFailure = failed; },
			setLastEvidenceSavedAt: (at) => { this.lastEvidenceSavedAt = at; },
			recoveryState: () => this.recoveryState,
			setRecoveryState: (state) => { this.recoveryState = state; },
			recoveryRecord: () => this.recoveryRecord,
			setRecoveryRecord: (record) => { this.recoveryRecord = record; },
			setStartupFinalization: (finalization) => { this.startupFinalization = finalization; },
			heartbeatFlight: () => this.heartbeatFlight,
			coordinator: () => this.coordinator,
			baselineCapture: () => this.baselineCapture,
			runtimeStore: () => this.runtimeStore,
			priceCapture: () => this.priceCapture,
			diagnostics: () => this.diagnostics,
			settlementWindowMs: () => this.settlementWindowMs,
			sessionId: () => this.sessionId(),
			observedPlayIntervals: () => this.observedPlayIntervals(),
			onStateChange: () => { this.onStateChange(); },
			onAutoRecovered: () => { this.onAutoRecovered(); },
			initialize: () => this.initialize(),
			getState: () => this.getState(),
			getCompletedSummaryReceipt: () => this.getCompletedSummaryReceipt(),
			resetCompletedSession: () => this.resetCompletedSession(),
			safeNow: () => this.safeNow(),
			safeNowOr: (fallback) => this.safeNowOr(fallback),
			timestampAtOrAfter: (floor) => this.timestampAtOrAfter(floor),
			safeTimestampAtOrAfter: (floor) => this.safeTimestampAtOrAfter(floor),
			requireHandle: () => this.requireHandle(),
			safeAcquire: (sessionId) => this.safeAcquire(sessionId),
			safeAssert: (handle) => this.safeAssert(handle),
			safeRelease: (handle) => this.safeRelease(handle),
			apply: (event) => { this.apply(event); },
			persistCurrentState: (ownershipChecked) => this.persistCurrentState(ownershipChecked),
			startHeartbeat: (handle) => { this.startHeartbeat(handle); },
			stopHeartbeat: () => { this.stopHeartbeat(); },
			armSettlement: () => { this.armSettlement(); },
			stopSettlement: () => { this.stopSettlement(); },
			scheduleAutoRetry: () => { this.scheduleAutoRetry(); },
			clearAutoRetry: () => { this.clearAutoRetry(); },
			reclaim: () => this.reclaim(),
			reclaimableError: () => this.reclaimableError(),
			finalizeStoppedSession: () => this.finalizeStoppedSession(),
			continueRecoveredSession: (deferred) => { this.continueRecoveredSession(deferred); },
			logUnmappedFailure: (action, error) => { this.logUnmappedFailure(action, error); },
			logAuthorityFailure: (action, reason) => { this.logAuthorityFailure(action, reason); },
		});
	}

	getState(): SessionState {
		return structuredClone(this.state);
	}

	getLastFailure(): SessionStartFailure | null {
		return this.lastFailure === null ? null : { ...this.lastFailure };
	}

	getLastStopFailure(): SessionStopFailure | null {
		return this.lastStopFailure === null ? null : { ...this.lastStopFailure };
	}

	/**
	 * H18.36: when the watch will retry a stalled stopping/provisional session on its own (the
	 * same `autoRetryAt` `checkSettlement` already arms with backoff), or null with nothing
	 * scheduled. The card's own meta line (boceto lámina 2.3) reads this instead of a generic
	 * "Reconciliando…" that never said when.
	 */
	getAutoRetryAt(): number | null {
		return this.autoRetryAt;
	}

	getProvisionalDelta(): StorageDelta | null {
		return this.provisionalDelta === null ? null : structuredClone(this.provisionalDelta);
	}

	getContaminationReview(): SessionContaminationReview | null {
		return this.contaminationReview === null ? null : structuredClone(this.contaminationReview);
	}

	getPriceSnapshot(): SessionPriceSnapshot | null {
		return this.priceSnapshot === null ? null : structuredClone(this.priceSnapshot);
	}

	/** Returns the committed baseline solely so the live observer can share the session boundary. */
	getBaselineSnapshot(): StorageSnapshot | null {
		return this.baselineSnapshot === null ? null : structuredClone(this.baselineSnapshot);
	}

	async getCompletedRuntimeRecord(): Promise<SessionRuntimeRecord | null> {
		if (this.state.status !== 'complete') return null;
		const loaded = await this.runtimeStore.load();
		if (loaded.status !== 'loaded' || loaded.record.state.status !== 'complete' ||
			loaded.record.state.sessionId !== this.state.sessionId) return null;
		return structuredClone(loaded.record);
	}

	getRecoveryState(): SessionRecoveryState {
		return structuredClone(this.recoveryState);
	}
	getPreservedLegacyRuntime(): SessionRuntimeRecord | null { return this.preservedLegacyRecords.length === 0 ? null : structuredClone(this.preservedLegacyRecords[0]!); }
	async readPreservedLegacyRuntime() {
		const runtime = this.getPreservedLegacyRuntime(); if (runtime === null) return null;
		const state = runtime.state.status === 'error' ? runtime.state.failedState : runtime.state;
		const archive = await this.runtimeStore.readLegacyRuntimeArchive?.(state.sessionId);
		return archive === null || archive === undefined ? null : {archive,runtime};
	}

	/** A source migration transfers evidence locally; it never resumes or recaptures the API session. */
	async preserveLegacyForLiveMigration(): Promise<boolean> {
		if (this.legacyMigrationFlight !== null) return await this.legacyMigrationFlight;
		const flight = this.performLegacyMigration(); this.legacyMigrationFlight = flight;
		try { return await flight; }
		finally { if (this.legacyMigrationFlight === flight) this.legacyMigrationFlight = null; }
	}
	private async performLegacyMigration(): Promise<boolean> {
		if (this.automaticAccountCapture || this.runtimeStore.archiveLegacyRuntime === undefined) return false;
		await this.initializationFlight; await this.startFlight; await this.stopFlight; await this.recoveryFlight;
		await this.reviewFlight; await this.reclaimFlight; await this.abandonFlight; await this.heartbeatFlight;
		const record = this.recoveryRecord;
		if (record === null) return this.getPreservedLegacyRuntime() !== null || this.state.status === 'idle';
		const sessionId = record.state.status === 'error' ? record.state.failedState.sessionId : record.state.sessionId;
		const acquired = await this.coordinator.acquire(sessionId);
		if ((acquired.status !== 'acquired' && acquired.status !== 'already_owned') || acquired.handle.sessionId !== sessionId) return false;
		this.currentHandle = acquired.handle;
		// A failed attempt must not leave the old session's lease taken for its whole TTL.
		const releaseUnused = async (): Promise<false> => {
			this.currentHandle = null;
			try { await this.coordinator.release(acquired.handle); } catch { /* best effort; the lease expires on its own */ }
			return false;
		};
		if ((await this.coordinator.assertOwned(acquired.handle)).status !== 'owned') return await releaseUnused();
		if (!await this.runtimeStore.archiveLegacyRuntime(sessionAuthorityFromLease(acquired.handle))) return await releaseUnused();
		this.preservedLegacyRecords.unshift(record); this.recoveryRecord = null;
		await this.coordinator.release(acquired.handle); this.currentHandle = null;
		// Preserved evidence is read through `getPreservedLegacyRuntime()`, never offered as a recovery.
		this.recoveryState = {status:'none'};
		this.onStateChange(); return true;
	}

	/** The proof that the completed session's summary is in the vault, or null while it is not. */
	getCompletedSummaryReceipt(): SessionSummaryReceipt | null {
		if (this.state.status !== 'complete' || this.summaryReceipt?.sessionId !== this.state.sessionId) return null;
		return structuredClone(this.summaryReceipt);
	}

	/**
	 * Records that the completed session's summary reached the vault at `path` (H18.8). From then on
	 * the next `start()` releases the completed record on its own: no scan of every note to find it
	 * again, and no rewrite of a note the player may have moved or edited since. The proof holds for
	 * this window even when the local store rejects it (the note itself is the durable copy); the
	 * result says whether it also survives a restart.
	 */
	async markCompletedSummarySaved(path: string): Promise<boolean> {
		if (this.state.status !== 'complete' || path.length === 0) return false;
		const receipt: SessionSummaryReceipt = {
			version: 1, sessionId: this.state.sessionId, path, savedAt: Math.max(0, this.safeNowOr(Date.now())),
		};
		this.summaryReceipt = receipt;
		// The store's own contract answers `false` instead of throwing, like every other write here.
		return await this.runtimeStore.saveSummaryReceipt?.(receipt) ?? false;
	}

	private async loadSummaryReceipt(): Promise<SessionSummaryReceipt | null> {
		return await this.runtimeStore.loadSummaryReceipt?.() ?? null;
	}

	/**
	 * The machine woke up or the network came back (H18.7): renew the lease now instead of on the next
	 * heartbeat, and let any automatic retry that was waiting run on the next tick instead of after its
	 * backoff.
	 */
	notifyWake(): void {
		if (this.disposed) return;
		if (this.currentHandle) void this.runHeartbeat();
		if (this.autoRetryAt !== null) {
			this.autoRetryAt = this.safeNowOr(0);
			this.armWatch();
		}
	}

	/**
	 * Consumes the evidence of an auto-finalization `initialize()` just performed, if any: a
	 * `provisional` record found already stopped (Obsidian restart, recovery after close) gets
	 * classified and finalized on its own, but never gets its note written or its pilot metrics/
	 * Halloween bookkeeping run — that lives in the host, the same as after a live `stop()`. Returns
	 * `null` on every call after the first for a given finalization, and always after a `complete`
	 * record loaded as-is (nothing to finish).
	 */
	takeStartupFinalization(): StartupFinalization | null {
		const value = this.startupFinalization;
		this.startupFinalization = null;
		return value;
	}

	initialize(): Promise<void> {
		if (this.initializationFlight) return this.initializationFlight;
		const flight = this.initializeInternal().finally(() => {
			if (this.initializationFlight === flight) this.initializationFlight = null;
		});
		this.initializationFlight = flight;
		return flight;
	}

	recover(): Promise<SessionRecoveryResult> {
		if (!this.automaticAccountCapture) return Promise.resolve({ status: 'failed', message: 'Saved API evidence remains preserved. Account recapture is disabled.' });
		return this.runRecovery('recover');
	}

	discardRecovery(): Promise<SessionRecoveryResult> {
		if (!this.automaticAccountCapture && this.preservedLegacyRecords.length > 0) return Promise.resolve({status:'failed',message:'Preserved API evidence is read-only and cannot clear the Nexus runtime.'});
		return this.runRecovery('discard');
	}

	start(input: SessionStartInput): Promise<ManualSessionStartResult> {
		if (!this.automaticAccountCapture) return Promise.resolve({ status: 'failed', failure: { code: 'missing_capability', message: 'New sessions use the connected Nexus inventory source.' } });
		if (this.startFlight) return this.startFlight;
		const flight = this.startInternal(input).finally(() => {
			if (this.startFlight === flight) this.startFlight = null;
		});
		this.startFlight = flight;
		return flight;
	}

	/**
	 * Commits the stop and captures the final snapshot only once the grace window has elapsed.
	 * While it has not, the session stays `stopping` and the result says how long is left.
	 */
	stop(): Promise<ManualSessionStopResult> {
		if (!this.automaticAccountCapture) return Promise.resolve({ status: 'failed', failure: { code: 'unexpected', message: 'Saved API evidence remains preserved without account recapture.' } });
		return this.runStop(false);
	}

	/**
	 * H18.26: the same stop, but an `active` session ends at `endAtMs` (the last evidence the game
	 * was there, from the in-game presence) instead of at this call, which can come ten minutes of
	 * grace later. Clamped to the baseline and to now; a session already stopping keeps its end.
	 */
	stopAt(endAtMs: number): Promise<ManualSessionStopResult> {
		if (!this.automaticAccountCapture) return this.stop();
		return this.runStop(false, endAtMs);
	}

	/**
	 * Captures the final snapshot right now, on explicit human demand. The result is degraded to an
	 * estimate because the snapshot cannot contain what the Guild Wars 2 cache has not published yet.
	 */
	captureFinalNow(): Promise<ManualSessionStopResult> {
		if (!this.automaticAccountCapture) return this.stop();
		return this.runStop(true);
	}

	/** Countdown of the grace window, or null when no session is waiting for it. */
	getSettlementWait(): SessionSettlementWait | null {
		if (this.state.status !== 'stopping') return null;
		try {
			return settlementWait(this.state.stopRequestedAt, this.safeNow(), this.settlementWindowMs);
		} catch {
			return null;
		}
	}

	/** Declared quality of the captured boundary, or null while there is nothing captured yet. */
	getApiSettlement(): SessionApiSettlement | null {
		if (this.state.status !== 'provisional' && this.state.status !== 'complete') return null;
		return this.stateSettlement(this.state);
	}

	private runStop(force: boolean, endAtMs: number | null = null): Promise<ManualSessionStopResult> {
		if (this.stopFlight) return this.stopFlight;
		const flight = this.stopAndScheduleRetry(force, endAtMs).finally(() => {
			if (this.stopFlight === flight) this.stopFlight = null;
		});
		this.stopFlight = flight;
		return flight;
	}

	private async stopAndScheduleRetry(force: boolean, endAtMs: number | null): Promise<ManualSessionStopResult> {
		const result = await this.stopInternal(force, endAtMs);
		this.afterStopAttempt(result);
		return result;
	}

	/**
	 * A failed final capture used to leave the session `stopping` with nothing scheduled to try again
	 * (H18.7): the network gone for the ten-minute wait meant a session that never finished unless the
	 * player found a button. Any failure that leaves something to finish (still `stopping`, or an
	 * authority failure this window may still take back) now schedules the next attempt itself.
	 */
	private afterStopAttempt(result: ManualSessionStopResult): void {
		if (this.disposed) return;
		if (result.status !== 'failed') {
			// A resumed result only hands the capture back for another finalize; whether that one
			// saves decides the backoff (see `finalizeStoppedSession`), so it must not reset it here.
			if (result.status !== 'stopped' || result.resumed !== true) this.clearAutoRetry();
			return;
		}
		// A key changed to another account (H18.12) gives the same answer on every retry: the backoff
		// used to repeat it every five minutes, forever. The failure stays declared on the session and
		// only the visible retry (or the next reload) tries again.
		if (result.failure.code === 'account_changed') {
			this.clearAutoRetry();
			return;
		}
		if (this.state.status === 'stopping' || this.reclaimableError() !== null) this.scheduleAutoRetry();
	}

	/**
	 * Computes the automatic contamination review and finalizes the session in the same step
	 * (`provisional` → `complete`): nobody declares or confirms anything anymore (David,
	 * 2026-09-09), so there is no answer to wait for. Also the single recovery path for a
	 * `provisional` record found already stopped (a previous run that stopped before this could
	 * run, or a plain restart): `initializeInternal` calls this the same way a fresh `stop()` does.
	 */
	finalizeStoppedSession(): Promise<SessionContaminationReviewResult> {
		if (this.reviewFlight) return this.reviewFlight;
		const flight = this.finalizeAndScheduleRetry().finally(() => {
			if (this.reviewFlight === flight) this.reviewFlight = null;
		});
		this.reviewFlight = flight;
		return flight;
	}

	/**
	 * A finalize that could not be saved leaves the session `provisional` with its lease held
	 * (H18.4): the watch tries again through the host, so the result is never left half-saved.
	 */
	private async finalizeAndScheduleRetry(): Promise<SessionContaminationReviewResult> {
		const result = await this.finalizeStoppedSessionInternal();
		if (!this.disposed) {
			if (result.status === 'finalized') this.clearAutoRetry();
			else if (this.state.status === 'provisional') this.scheduleAutoRetry();
		}
		return result;
	}

	/**
	 * Whether the player may abandon the session now: it is `stopping` and its last stop failed in
	 * a way no retry fixes on its own (`ABANDONABLE_STOP_FAILURES`). Every other failure (network,
	 * rate limit, a lost lease, coordination) retries by itself and ends in a real result.
	 */
	canAbandon(): boolean {
		const code = this.lastStopFailure?.code;
		return this.state.status === 'stopping' && !this.disposed && this.stopFlight === null
			&& code !== undefined && isAbandonableStopFailure(code);
	}

	/**
	 * Ends a stopping session the player gave up on (David, 2026-09-24): after the key changed to
	 * another account (H18.12) the stop could only fail forever. The session ends `abandoned`, with
	 * no final snapshot, no delta and no loot; its saved record is cleared and its lease released,
	 * so the next session starts without anything to clear first. Only under the lease this window
	 * still owns: a session another window took keeps going there.
	 */
	abandon(): Promise<SessionAbandonResult> {
		if (this.abandonFlight) return this.abandonFlight;
		const flight = this.abandonInternal().finally(() => {
			if (this.abandonFlight === flight) this.abandonFlight = null;
		});
		this.abandonFlight = flight;
		return flight;
	}

	private async abandonInternal(): Promise<SessionAbandonResult> {
		const code = this.lastStopFailure?.code;
		if (!this.canAbandon() || this.state.status !== 'stopping' || code === undefined || !isAbandonableStopFailure(code)) {
			return { status: 'failed', message: 'Only a stop that cannot finish on its own can be abandoned.' };
		}
		const handle = this.currentHandle;
		if (!handle) return { status: 'failed', message: 'The session lease was lost.' };
		const owned = await this.safeAssert(handle);
		if (owned.status !== 'owned') {
			return { status: 'failed', message: owned.status === 'lost'
				? 'Another Obsidian window owns this farming session.'
				: 'Session coordination is unavailable.' };
		}
		const stopping = this.state;
		const abandoned = transitionSession(stopping, {
			type: 'abandon',
			authority: stopping.authority,
			abandonedAt: this.safeTimestampAtOrAfter(Date.parse(stopping.stopRequestedAt)),
			reason: code,
		});
		if (abandoned.status === 'rejected' || abandoned.state?.status !== 'abandoned') {
			return { status: 'failed', message: 'The session could not be abandoned.' };
		}
		const cleared = await this.runtimeStore.clear(stopping.authority);
		if (cleared.status !== 'cleared') {
			return { status: 'failed', message: 'The saved farming session could not be released safely.' };
		}
		this.stopHeartbeat();
		this.stopSettlement();
		this.clearAutoRetry();
		this.currentHandle = null;
		await this.safeRelease(handle);
		this.state = abandoned.state;
		this.lastStopFailure = null;
		this.baselineSnapshot = null;
		this.finalSnapshot = null;
		this.provisionalDelta = null;
		this.contaminationReview = null;
		this.priceSnapshot = null;
		this.onStateChange();
		return { status: 'abandoned', state: this.getState() as Extract<SessionState, { status: 'abandoned' }> };
	}

	async resetCompletedSession(): Promise<boolean> {
		if (this.state.status !== 'complete') return false;
		const cleared = await this.runtimeStore.clear(this.state.authority);
		if (cleared.status !== 'cleared') return false;
		const reset = transitionSession(this.state, { type: 'reset' });
		if (reset.status === 'rejected') return false;
		this.state = reset.state;
		this.baselineSnapshot = null;
		this.finalSnapshot = null;
		this.provisionalDelta = null;
		this.contaminationReview = null;
		this.priceSnapshot = null;
		this.summaryReceipt = null;
		this.onStateChange();
		return true;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.stopHeartbeat();
		this.stopSettlement();
		await this.heartbeatFlight;
		const handle = this.currentHandle;
		this.currentHandle = null;
		if (handle) {
			try { await this.coordinator.release(handle); } catch { /* best effort during unload */ }
		}
		this.coordinator.dispose();
		this.runtimeStore.close();
	}

	private async initializeInternal(): Promise<void> {
		if (this.disposed || this.recoveryRecord || this.state.status !== 'idle') return;
		if (!this.automaticAccountCapture && this.runtimeStore.listLegacyRuntimeArchives) {
			// Same contract as `load()` below: a store that is down is a recovery state, never a rejection
			// that keeps the whole plugin from starting.
			try { this.preservedLegacyRecords = await this.runtimeStore.listLegacyRuntimeArchives(); }
			catch (error) {
				const corrupt = error instanceof Error && error.message === 'Preserved API runtime is corrupt.';
				this.recoveryState = {
					status: 'error',
					code: corrupt ? 'corrupt' : 'unavailable',
					message: corrupt
						? 'The preserved API runtime is corrupt and was left untouched.'
						: 'Session recovery storage is unavailable.',
				};
				this.onStateChange();
				return;
			}
		}
		const loaded = await this.runtimeStore.load();
		if (loaded.status === 'empty' || loaded.status === 'live') {
			// Archived API evidence is read through `getPreservedLegacyRuntime()`; announcing it as a
			// recovery would offer an action that can never succeed (recapture is disabled, discard is read-only).
			this.recoveryState = { status: 'none' };
		} else if (loaded.status === 'loaded') {
			if (loaded.record.state.status === 'complete') {
				if (!this.automaticAccountCapture) this.recoveryRecord = loaded.record;
				this.state = loaded.record.state;
				this.baselineSnapshot = loaded.record.baselineSnapshot;
				this.finalSnapshot = loaded.record.finalSnapshot;
				this.provisionalDelta = loaded.record.delta;
				this.contaminationReview = loaded.record.review;
				this.priceSnapshot = loaded.record.priceSnapshot;
				this.recoveryState = { status: 'none' };
				const receipt = await this.loadSummaryReceipt();
				this.summaryReceipt = receipt?.sessionId === loaded.record.state.sessionId ? receipt : null;
			} else if (this.automaticAccountCapture === false) {
				this.recoveryRecord = loaded.record;
				this.recoveryState = { status: 'available', state: loaded.record.state };
			} else if (recoverableState(loaded.record.state).status === 'provisional') {
				// A session that already captured its final snapshot never asks a human to review it
				// (David, 2026-09-09): reclaim the lease and finalize through the exact same path a
				// live `stop()` uses, whether Obsidian just started, a previous run closed before
				// finalizing, or today's real incident. Only a failure along the way (lease busy or
				// lost, store unavailable) still falls back to the ordinary "recovery available" state,
				// so a human is never stuck without any way to resolve it.
				// A failure saved while provisional (H18.4: the lease lost between the capture and the
				// finalize) takes the same path: the recover transition unwraps it.
				await this.autoFinalizeProvisionalRecord(loaded.record);
				return;
			} else {
				// `active`, `stopping` or a failure saved from either (H18.7): reopening Obsidian used to
				// stop here and wait for someone to press "Recover". It now takes the session back on its
				// own through the same fenced path; only a lease another window still holds, or storage
				// that is down, leaves the recovery state visible, and the watch retries those by itself.
				this.recoveryRecord = loaded.record;
				this.recoveryState = { status: 'available', state: loaded.record.state };
				await this.recoverSavedRecord('recover', 'startup');
				return;
			}
		} else {
			this.recoveryState = {
				status: 'error',
				code: loaded.code,
				message: loaded.code === 'corrupt'
					? 'The saved farming session is corrupt and was left untouched.'
					: 'Session recovery storage is unavailable.',
			};
		}
		this.onStateChange();
	}

	private autoFinalizeProvisionalRecord(record: SessionRuntimeRecord): Promise<void> { return this.transitions.autoFinalizeProvisionalRecord(record); }

	private runRecovery(
		action: 'recover' | 'discard',
		mode: RecoveryMode = 'manual',
	): Promise<SessionRecoveryResult> {
		if (this.recoveryFlight) return this.recoveryFlight;
		const flight = this.recoveryInternal(action, mode).finally(() => {
			if (this.recoveryFlight === flight) this.recoveryFlight = null;
		});
		this.recoveryFlight = flight;
		return flight;
	}

	private async recoveryInternal(action: 'recover' | 'discard', mode: RecoveryMode): Promise<SessionRecoveryResult> {
		await this.initialize();
		// The stored record itself could not be read (`recoveryState.status === 'error'`), so there is
		// no `recoveryRecord` and no authority to recover into. Discard is still possible: it does not
		// need to understand the record, only to erase it.
		if (this.recoveryState.status === 'error' && action === 'discard') {
			return this.discardUnreadableRecovery();
		}
		return await this.recoverSavedRecord(action, mode);
	}

	private async recoverSavedRecord(action: 'recover' | 'discard', mode: RecoveryMode): Promise<SessionRecoveryResult> {
		const result = await this.recoverRecordInternal(action, mode);
		if (action === 'recover' && result.status !== 'recovered' && this.recoveryRecord !== null
			&& this.state.status === 'idle' && !this.disposed) {
			this.scheduleAutoRetry(this.recoveryState.status === 'busy' ? this.recoveryState.ownerExpiresAt + 1_000 : undefined);
		}
		return result;
	}

	private recoverRecordInternal(action: 'recover' | 'discard', mode: RecoveryMode): Promise<SessionRecoveryResult> { return this.transitions.recoverRecordInternal(action, mode); }

	/** What a session taken back needs next: its capture (`stopping`) or its finalize (`provisional`). */
	private continueRecoveredSession(deferred: boolean): void {
		if (this.state.status === 'stopping') {
			if (deferred) this.armWatch();
			else this.armSettlement();
		} else if (this.state.status === 'provisional') {
			// Finalizing writes the note, which is the host's job: the watch hands it over on its next
			// tick instead of calling into the host from inside this flow.
			this.autoRetryAt = this.safeNowOr(0);
			this.armWatch();
		}
	}

	/**
	 * Escape hatch for a stored record that never loaded at all (`recoveryState.status === 'error'`).
	 * There is no lease to acquire and no authority to check: the record cannot say who owns it, so
	 * it forces the key gone the same way any other machine-local user could reach for the file
	 * system if this were a plain file. It is deliberately not lease-guarded; a record this broken is
	 * not safely resumable by any window, this one included.
	 */
	private async discardUnreadableRecovery(): Promise<SessionRecoveryResult> {
		if (this.disposed || this.state.status !== 'idle') {
			return { status: 'failed', message: 'There is no saved session available to recover.' };
		}
		const cleared = await this.runtimeStore.forceClear();
		if (cleared.status !== 'cleared') {
			const message = 'The saved session could not be discarded safely.';
			this.recoveryState = { status: 'error', code: 'unavailable', message };
			this.onStateChange();
			return { status: 'failed', message };
		}
		this.recoveryRecord = null;
		this.recoveryState = { status: 'none' };
		this.onStateChange();
		return { status: 'discarded' };
	}

	private startInternal(input: SessionStartInput): Promise<ManualSessionStartResult> { return this.transitions.startInternal(input); }

	private stopInternal(force: boolean, endAtMs: number | null = null): Promise<ManualSessionStopResult> { return this.transitions.stopInternal(force, endAtMs); }

	private async finalizeStoppedSessionInternal(): Promise<SessionContaminationReviewResult> {
		if (
			this.disposed
			|| this.state.status !== 'provisional'
			|| !this.baselineSnapshot
			|| !this.finalSnapshot
			|| !this.provisionalDelta
			|| !this.currentHandle
		) return { status: 'failed', message: 'There is no provisional session ready to finalize.' };
		const previousReviewFloor = this.contaminationReview
			? Date.parse(this.contaminationReview.reviewedAt) + 1
			: 0;
		const reviewedAt = this.safeTimestampAtOrAfter(Math.max(
			Date.parse(this.state.finalSnapshot.completedAt),
			previousReviewFloor,
		));
		const farmedLossItemIds = await this.resolveFarmedLossItemIds(this.provisionalDelta);
		const review = createSessionContaminationReview(
			this.baselineSnapshot,
			this.finalSnapshot,
			this.provisionalDelta,
			reviewedAt,
			this.stateSettlement(this.state),
			farmedLossItemIds,
		);
		if (!review) return { status: 'failed', message: 'The contamination review is invalid.' };
		const owned = await this.safeAssert(this.currentHandle);
		if (owned.status !== 'owned') {
			return { status: 'failed', message: owned.status === 'lost'
				? 'The session lease was lost before the review could be saved.'
				: 'Session coordination is unavailable.' };
		}
		const reviewedRecord = createSessionRuntimeRecord(
			this.state,
			this.baselineSnapshot,
			this.finalSnapshot,
			this.provisionalDelta,
			this.safeNow(),
			review,
			this.priceSnapshot,
		);
		if (!reviewedRecord || (await this.runtimeStore.save(reviewedRecord)).status !== 'saved') {
			return { status: 'failed', message: 'The contamination review could not be persisted safely.' };
		}
		this.contaminationReview = structuredClone(review);
		// `permissions.finalize` is always `true` now (David, 2026-09-09): every review that
		// computes cleanly finalizes the session in this same call, so there is no `'reviewed'`
		// (unfinalized) outcome left to return.
		const finalizedAt = this.safeTimestampAtOrAfter(Date.parse(review.reviewedAt));
		const transition = transitionSession(this.state, {
			type: 'finalize',
			authority: this.state.authority,
			finalizedAt,
			classification: review.classification.status,
		});
		if (transition.status === 'rejected' || transition.state.status !== 'complete') {
			return { status: 'failed', message: 'The reviewed session could not be finalized.' };
		}
		const completeRecord = createSessionRuntimeRecord(
			transition.state,
			this.baselineSnapshot,
			this.finalSnapshot,
			this.provisionalDelta,
			this.safeNow(),
			review,
			this.priceSnapshot,
		);
		if (!completeRecord || (await this.runtimeStore.save(completeRecord)).status !== 'saved') {
			return { status: 'failed', message: 'The finalized session could not be persisted safely.' };
		}
		this.state = transition.state;
		this.stopHeartbeat();
		const handle = this.currentHandle;
		this.currentHandle = null;
		if (handle) await this.safeRelease(handle);
		this.onStateChange();
		return { status: 'finalized', review: structuredClone(review), state: this.getState() as Extract<SessionState, { status: 'complete' }> };
	}

	/**
	 * Resolves, before classification, which of THIS delta's losses are farming input rather than
	 * contamination (H14.1): a catalog `Container`/`Consumable`. Only the lost ids are ever asked
	 * about, and a missing capture or a failed resolution leaves every loss unresolved, which
	 * `classifySessionDelta` already treats conservatively as a real loss.
	 */
	private async resolveFarmedLossItemIds(delta: StorageDelta): Promise<number[]> {
		if (this.farmedLossItemTypeCapture === null || delta.status === 'invalid') return [];
		const lossItemIds = delta.itemChanges.filter((change) => change.delta < 0).map((change) => change.id);
		if (lossItemIds.length === 0) return [];
		try {
			const types = await this.farmedLossItemTypeCapture.capture(lossItemIds);
			return lossItemIds.filter((id) => {
				const type = types.get(id);
				return type === 'Container' || type === 'Consumable';
			});
		} catch {
			return [];
		}
	}

	/**
	 * Reads the settlement back out of the session's own evidence: the instant the player asked to
	 * stop and the instant the final capture started reading. Because both are already persisted,
	 * the quality of the measurement survives a restart without a new stored field.
	 */
	private stateSettlement(
		state: Extract<SessionState, { status: 'provisional' | 'complete' }>,
	): SessionApiSettlement {
		return captureSettlement(state.stopRequestedAt, state.finalSnapshot.startedAt, this.settlementWindowMs);
	}

	private apply(event: SessionEvent): void {
		const result = transitionSession(this.state, event);
		if (result.status === 'rejected') throw new SessionTransitionRejectedError(result.reason);
		this.state = result.state;
		this.onStateChange();
	}

	private async persistCurrentState(ownershipChecked = false): Promise<void> {
		if (!this.baselineSnapshot) {
			throw new ManualSessionStartError(failure(
				'coordination_unavailable',
				'The farming session evidence is incomplete.',
			));
		}
		if (!ownershipChecked) {
			const owned = await this.safeAssert(this.requireHandle());
			if (owned.status !== 'owned') {
				throw new ManualSessionStartError(failure(
					owned.status === 'lost' ? 'lease_lost' : 'coordination_unavailable',
					owned.status === 'lost'
						? 'The session lease was lost before recovery evidence could be committed.'
						: 'Session coordination is unavailable.',
				));
			}
		}
		const record = createSessionRuntimeRecord(
			this.state,
			this.baselineSnapshot,
			this.finalSnapshot,
			this.provisionalDelta,
			this.safeNow(),
			this.contaminationReview,
			this.priceSnapshot,
		);
		if (!record) {
			throw new ManualSessionStartError(failure(
				'coordination_unavailable',
				'The farming session evidence could not be validated for recovery.',
			));
		}
		const persisted = await this.runtimeStore.save(record);
		if (persisted.status === 'saved') return;
		throw new ManualSessionStartError(failure(
			persisted.status === 'stale' ? 'lease_lost' : 'coordination_unavailable',
			persisted.status === 'stale'
				? 'A newer session owner rejected this stale write.'
				: 'Session recovery storage is unavailable.',
		));
	}

	private startHeartbeat(handle: ActiveSessionLeaseHandle): void { this.leaseHeartbeat.startHeartbeat(handle); }

	private runHeartbeat(): Promise<void> { return this.leaseHeartbeat.runHeartbeat(); }

	private failFromAuthority(mapped: SessionStartFailure): void {
		this.authorityFailure = mapped;
		this.stopHeartbeat();
		if (
			this.state.status !== 'active'
			&& this.state.status !== 'stopping'
			&& this.state.status !== 'provisional'
		) return;
		const floor = this.state.status === 'active'
			? Date.parse(this.state.baseline.completedAt)
			: this.state.status === 'stopping'
				? Date.parse(this.state.stopRequestedAt)
				: Date.parse(this.state.finalSnapshot.completedAt);
		try {
			this.apply({
				type: 'fail',
				authority: this.state.authority,
				failedAt: this.safeTimestampAtOrAfter(floor),
				code: mapped.code === 'lease_lost' ? 'lease_lost' : 'storage_unavailable',
			});
			void this.persistCurrentState().catch(() => undefined);
			// A 300 s lease expires while the machine sleeps (H18.7), which is not another window
			// taking the session: the watch tries to take it back on its own, through the fence.
			this.scheduleAutoRetry();
		} catch { /* the state machine remains fail-closed */ }
	}

	private stopHeartbeat(): void { this.leaseHeartbeat.stopHeartbeat(); }

	private armSettlement(): void { this.watch.armSettlement(); }

	private armWatch(): void { this.watch.armWatch(); }

	private stopSettlement(): void { this.watch.stopSettlement(); }

	private scheduleAutoRetry(at?: number): void { this.watch.scheduleAutoRetry(at); }

	private clearAutoRetry(): void { this.watch.clearAutoRetry(); }

	/** The phase an `error` can be taken back into, or null when there is nothing to take back. */
	private reclaimableError(): Exclude<SessionInProgressState, { status: 'starting' }> | null {
		if (this.state.status !== 'error') return null;
		const failed = this.state.failedState;
		return failed.status === 'starting' ? null : failed;
	}

	private reclaim(): Promise<SessionStopFailure | null> {
		if (this.reclaimFlight) return this.reclaimFlight;
		const flight = this.reclaimInternal().finally(() => {
			if (this.reclaimFlight === flight) this.reclaimFlight = null;
		});
		this.reclaimFlight = flight;
		return flight;
	}

	private reclaimInternal(): Promise<SessionStopFailure | null> { return this.transitions.reclaimInternal(); }

	private safeNow(): number {
		const value = this.now();
		if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid local clock.');
		return value;
	}

	private timestampAtOrAfter(floor: number): string {
		return new Date(Math.max(this.safeNow(), floor)).toISOString();
	}

	private safeNowOr(fallback: number): number {
		try { return this.safeNow(); } catch { return fallback; }
	}

	private safeTimestampAtOrAfter(floor: number): string {
		try { return this.timestampAtOrAfter(floor); } catch {
			return new Date(Math.max(Date.now(), floor)).toISOString();
		}
	}

	private requireHandle(): ActiveSessionLeaseHandle {
		if (!this.currentHandle) {
			throw new ManualSessionStartError(failure('lease_lost', 'The session lease was lost.'));
		}
		return this.currentHandle;
	}

	private async safeAcquire(sessionId: string): Promise<AcquireLeaseResult> {
		try { return await this.coordinator.acquire(sessionId); } catch { return { status: 'error', code: 'unavailable' }; }
	}

	/**
	 * The only local trace of a start/stop failure `mapFailure`/`mapStopFailure` could not classify:
	 * without it, an `unexpected` (start) or the generic `snapshot_failed` (stop) result leaves the
	 * debug log with nothing to tell a network `TypeError` apart from a rejected state transition or
	 * an `AbortError` (2026-09-10 incident). Structured only, per the contract: the error's class and
	 * any HTTP status or machine code it carries, never its message or stack.
	 */
	private logUnmappedFailure(action: 'session_start' | 'session_finish', error: unknown): void {
		this.diagnostics?.event({
			component: 'session',
			action,
			level: 'error',
			phase: 'failure',
			code: 'unknown_failure',
			details: unmappedErrorLogDetails(error),
		});
	}

	/**
	 * The only local trace of WHY the heartbeat or a live stop declared the session's authority
	 * lost (H15.8, 2026-09-10 audit): both `heartbeat()`'s renew failure and `stopInternal`'s owned
	 * check collapse every coordinator code into the same fixed `coordination_unavailable`/
	 * `lease_lost` copy for the player, so a clock rolled back and a genuinely contested lease used
	 * to look identical here too. `reason` carries the coordinator's own code (`lease_lost`,
	 * `clock_anomaly`, or the generic `coordination_unavailable`); the top-level `code` only has to
	 * pick the closest fit from the closed local-debug vocabulary.
	 */
	private logAuthorityFailure(
		action: 'session_heartbeat' | 'session_finish',
		reason: 'lease_lost' | 'clock_anomaly' | 'coordination_unavailable',
	): void {
		this.diagnostics?.event({
			component: 'session',
			action,
			level: 'error',
			phase: 'failure',
			code: reason === 'lease_lost' ? 'precondition_failed' : reason === 'clock_anomaly' ? 'internal_failure' : 'unavailable',
			details: { code: reason },
		});
	}

	private async safeAssert(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult> {
		try { return await this.coordinator.assertOwned(handle); } catch { return { status: 'error', code: 'unavailable' }; }
	}

	private async safeRelease(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult> {
		try { return await this.coordinator.release(handle); } catch { return { status: 'error', code: 'unavailable' }; }
	}
}

export function mapFailure(error: unknown, onUnclassified?: (error: unknown) => void): SessionStartFailure {
	if (error instanceof ManualSessionStartError) return error.failure;
	if (error instanceof SessionStartCaptureError) {
		if (error.code === 'invalid_input') return failure('invalid_input', error.message);
		if (error.code === 'build_scope_missing') return failure('missing_capability', error.message);
		return failure('snapshot_failed', error.message);
	}
	if (error instanceof HttpTransportError) {
		if (error.status === 429) {
			return failure('rate_limited', 'Guild Wars 2 is rate limiting requests. Try again after the shared cooldown clears.');
		}
		// H15.24 (2026-09-10 audit): a 401/403 without the required scope and a network-level
		// failure both used to fall through to the generic `unexpected`, which sent the player to
		// "check the connection and try again" instead of the copy that names the actual problem
		// (`status.startFailure.missing_capability`/`snapshot_failed`, `companion-status-model.ts`).
		if (error.kind === 'http' && (error.status === 401 || error.status === 403)) {
			return failure('missing_capability', 'The API key does not have the required permission scope.');
		}
		if (error.kind === 'timeout' || error.kind === 'network') {
			return failure('snapshot_failed', 'The baseline could not be captured. Check the connection and start again.');
		}
	}
	onUnclassified?.(error);
	return failure('unexpected', 'The farming session could not be started.');
}

export function mapStopFailure(error: unknown, onUnclassified?: (error: unknown) => void): SessionStopFailure {
	if (error instanceof ManualSessionStartError) {
		if (error.failure.code === 'lease_lost') return { code: 'lease_lost', message: error.message };
		if (error.failure.code === 'coordination_unavailable') {
			return { code: 'coordination_unavailable', message: error.message };
		}
	}
	if (error instanceof SessionStartCaptureError) {
		return { code: 'snapshot_failed', message: error.message };
	}
	if (error instanceof HttpTransportError && error.status === 429) {
		return {
			code: 'rate_limited',
			message: 'Guild Wars 2 is rate limiting requests. Try again after the shared cooldown clears.',
		};
	}
	onUnclassified?.(error);
	return {
		code: 'snapshot_failed',
		message: 'The final account snapshot could not be captured. You can retry without losing the session baseline.',
	};
}
