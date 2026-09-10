import { compareStorageSnapshots } from '../account/storage-delta';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { HttpTransportError } from '../core/http';
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
	RenewLeaseResult,
} from './coordination-model';
import {
	initialSessionState,
	sessionAuthorityFromLease,
	transitionSession,
} from './session-state-machine';
import type {
	SessionEvent,
	SessionFailureCode,
	SessionSnapshotReference,
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
	type PersistedSessionState,
	type SessionRuntimeRecord,
	type SessionRuntimeStore,
} from './session-runtime-store';
import {
	normalizeSessionStartInput,
	SessionStartCaptureError,
	type SessionStartCaptureResult,
	type SessionStartInput,
} from './session-start-capture';
import {
	API_SETTLEMENT_TICK_MS,
	captureSettlement,
	settlementWait,
	type SessionApiSettlement,
	type SessionSettlementWait,
} from './session-api-settlement';

export interface SessionLeaseCoordinator {
	/** Stable for the coordinator's whole lifetime; identifies this plugin instance in diagnostics. */
	readonly instanceId: string;
	acquire(sessionId: string): Promise<AcquireLeaseResult>;
	renew(handle: ActiveSessionLeaseHandle): Promise<RenewLeaseResult>;
	assertOwned(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult>;
	release(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult>;
	dispose(): void;
}

export interface SessionBaselineCapture {
	capture(input: SessionStartInput): Promise<SessionStartCaptureResult>;
	captureFinal?(): Promise<StorageSnapshot>;
}

export interface SessionStartFailure {
	code:
		| 'busy'
		| 'coordination_unavailable'
		| 'invalid_input'
		| 'missing_capability'
		| 'snapshot_failed'
		| 'lease_lost'
		| 'rate_limited'
		| 'unexpected';
	message: string;
}

export interface SessionStopFailure {
	code:
		| 'coordination_unavailable'
		| 'snapshot_failed'
		| 'lease_lost'
		| 'delta_invalid'
		| 'rate_limited'
		| 'unexpected';
	message: string;
}

export type SessionRecoveryState =
	| { status: 'none' }
	| { status: 'available'; state: Exclude<SessionRuntimeRecord['state'], { status: 'complete' }>; message?: string }
	| {
			status: 'busy';
			state: Exclude<SessionRuntimeRecord['state'], { status: 'complete' }>;
			message?: string;
			/** When the current owner's lease naturally clears; drives the UI countdown and re-enable. */
			ownerExpiresAt: number;
	  }
	| { status: 'working'; action: 'recover' | 'discard'; state: Exclude<SessionRuntimeRecord['state'], { status: 'complete' }> }
	/**
	 * `code` is the machine-readable reason (same vocabulary as `SessionRuntimeLoadResult`); `message`
	 * is the human copy already built for it. There is no recoverable `state` here: the record could
	 * not be read at all, so `discard` is the only action, and it does not require one.
	 */
	| { status: 'error'; code: 'corrupt' | 'unavailable'; message: string };

export type SessionRecoveryResult =
	| { status: 'recovered'; state: SessionState }
	| { status: 'discarded' }
	| { status: 'busy' | 'failed'; message: string };

class ManualSessionStartError extends Error {
	constructor(readonly failure: SessionStartFailure) {
		super(failure.message);
		this.name = 'ManualSessionStartError';
	}
}

export type ManualSessionStartResult =
	| { status: 'started'; state: Extract<SessionState, { status: 'active' }> }
	| { status: 'failed'; failure: SessionStartFailure };

export type ManualSessionStopResult =
	| {
			status: 'stopped';
			state: Extract<SessionState, { status: 'provisional' }>;
			delta: StorageDelta;
	  }
	| {
			/** The stop is committed; the final snapshot waits for the Guild Wars 2 cache window. */
			status: 'awaiting_settlement';
			state: Extract<SessionState, { status: 'stopping' }>;
			wait: SessionSettlementWait;
	  }
	| { status: 'failed'; failure: SessionStopFailure };

/**
 * `status` is always `'finalized'` on success: since `permissions.finalize` never comes back
 * `false` anymore (David, 2026-09-09), a review that computed cleanly always finalizes the session
 * in the same step, and the old `'reviewed'` (provisional, unfinalized) outcome is unreachable.
 */
export type SessionContaminationReviewResult =
	| {
			status: 'finalized';
			review: SessionContaminationReview;
			state: Extract<SessionState, { status: 'complete' }>;
	  }
	| { status: 'failed'; message: string };

/** See `takeStartupFinalization()`. */
export interface StartupFinalization {
	sessionId: string;
	delta: StorageDelta;
	review: Extract<SessionContaminationReviewResult, { status: 'finalized' }>;
}

export interface ManualSessionStartServiceOptions {
	now?: () => number;
	sessionId?: () => string;
	setInterval?: (callback: () => void, milliseconds: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	onStateChange?: () => void;
	/**
	 * Called once the grace window elapses so the host can run the same stop pipeline it runs for
	 * an immediate capture. The service captures on its own even without it; the callback exists
	 * because note writing, valuation and detection bookkeeping live outside this class.
	 */
	onSettlementDue?: () => void;
	runtimeStore: SessionRuntimeStore;
	priceCapture?: SessionPriceCapture;
	/**
	 * Resolves the public-catalog type of the session's lost items before contamination review
	 * (H14.1): a loss the catalog types `Container`/`Consumable` is farming input, not
	 * contamination. Absent, or a resolution that misses an id, keeps that loss a conservative real
	 * loss, exactly as before H14.1.
	 */
	farmedLossItemTypeCapture?: SessionItemTypeCapture;
	/** Records a `warn` line when recover/discard finds the saved session's lease owned elsewhere. */
	diagnostics?: LocalDebugActionPort;
}

/** Owns the fenced idle → active workflow and leaves no product session after a failed start. */
export class ManualSessionStartService {
	private state: SessionState = initialSessionState();
	private lastFailure: SessionStartFailure | null = null;
	private currentHandle: ActiveSessionLeaseHandle | null = null;
	private heartbeatHandle: unknown = null;
	private heartbeatFlight: Promise<void> | null = null;
	private settlementHandle: unknown = null;
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
	/**
	 * Set once, right after `initialize()` auto-finalizes a `provisional` record it found already
	 * stopped, and only ever read by `takeStartupFinalization()`, which consumes it: the host needs
	 * this evidence to write the session's note and run the same post-finalize bookkeeping a live
	 * `stop()` triggers, since `initialize()` itself only reclaims the lease and classifies.
	 */
	private startupFinalization: StartupFinalization | null = null;
	private initializationFlight: Promise<void> | null = null;
	private recoveryFlight: Promise<SessionRecoveryResult> | null = null;
	private disposed = false;
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

	constructor(
		private readonly coordinator: SessionLeaseCoordinator,
		private readonly baselineCapture: SessionBaselineCapture,
		options: ManualSessionStartServiceOptions,
	) {
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
		return this.runRecovery('recover');
	}

	discardRecovery(): Promise<SessionRecoveryResult> {
		return this.runRecovery('discard');
	}

	start(input: SessionStartInput): Promise<ManualSessionStartResult> {
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
		return this.runStop(false);
	}

	/**
	 * Captures the final snapshot right now, on explicit human demand. The result is degraded to an
	 * estimate because the snapshot cannot contain what the Guild Wars 2 cache has not published yet.
	 */
	captureFinalNow(): Promise<ManualSessionStopResult> {
		return this.runStop(true);
	}

	/** Countdown of the grace window, or null when no session is waiting for it. */
	getSettlementWait(): SessionSettlementWait | null {
		if (this.state.status !== 'stopping') return null;
		try {
			return settlementWait(this.state.stopRequestedAt, this.safeNow());
		} catch {
			return null;
		}
	}

	/** Declared quality of the captured boundary, or null while there is nothing captured yet. */
	getApiSettlement(): SessionApiSettlement | null {
		if (this.state.status !== 'provisional' && this.state.status !== 'complete') return null;
		return this.stateSettlement(this.state);
	}

	private runStop(force: boolean): Promise<ManualSessionStopResult> {
		if (this.stopFlight) return this.stopFlight;
		const flight = this.stopInternal(force).finally(() => {
			if (this.stopFlight === flight) this.stopFlight = null;
		});
		this.stopFlight = flight;
		return flight;
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
		const flight = this.finalizeStoppedSessionInternal().finally(() => {
			if (this.reviewFlight === flight) this.reviewFlight = null;
		});
		this.reviewFlight = flight;
		return flight;
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
		const loaded = await this.runtimeStore.load();
		if (loaded.status === 'empty') {
			this.recoveryState = { status: 'none' };
		} else if (loaded.status === 'loaded') {
			if (loaded.record.state.status === 'complete') {
				this.state = loaded.record.state;
				this.baselineSnapshot = loaded.record.baselineSnapshot;
				this.finalSnapshot = loaded.record.finalSnapshot;
				this.provisionalDelta = loaded.record.delta;
				this.contaminationReview = loaded.record.review;
				this.priceSnapshot = loaded.record.priceSnapshot;
				this.recoveryState = { status: 'none' };
			} else if (loaded.record.state.status === 'provisional') {
				// A session that already captured its final snapshot never asks a human to review it
				// (David, 2026-09-09): reclaim the lease and finalize through the exact same path a
				// live `stop()` uses, whether Obsidian just started, a previous run closed before
				// finalizing, or today's real incident. Only a failure along the way (lease busy or
				// lost, store unavailable) still falls back to the ordinary "recovery available" state,
				// so a human is never stuck without any way to resolve it.
				await this.autoFinalizeProvisionalRecord(
					loaded.record as SessionRuntimeRecord & { state: Extract<PersistedSessionState, { status: 'provisional' }> },
				);
				return;
			} else {
				this.recoveryRecord = loaded.record;
				this.recoveryState = { status: 'available', state: loaded.record.state };
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

	private async autoFinalizeProvisionalRecord(
		record: SessionRuntimeRecord & { state: Extract<PersistedSessionState, { status: 'provisional' }> },
	): Promise<void> {
		const fallbackToRecoverable = (): void => {
			this.recoveryRecord = record;
			this.recoveryState = { status: 'available', state: record.state };
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

	private runRecovery(action: 'recover' | 'discard'): Promise<SessionRecoveryResult> {
		if (this.recoveryFlight) return this.recoveryFlight;
		const flight = this.recoveryInternal(action).finally(() => {
			if (this.recoveryFlight === flight) this.recoveryFlight = null;
		});
		this.recoveryFlight = flight;
		return flight;
	}

	private async recoveryInternal(action: 'recover' | 'discard'): Promise<SessionRecoveryResult> {
		await this.initialize();
		// The stored record itself could not be read (`recoveryState.status === 'error'`), so there is
		// no `recoveryRecord` and no authority to recover into. Discard is still possible: it does not
		// need to understand the record, only to erase it.
		if (this.recoveryState.status === 'error' && action === 'discard') {
			return this.discardUnreadableRecovery();
		}
		const record = this.recoveryRecord;
		if (this.disposed || !record || this.state.status !== 'idle') {
			return { status: 'failed', message: 'There is no saved session available to recover.' };
		}
		if (record.state.status === 'complete') {
			return { status: 'failed', message: 'The saved session is already complete.' };
		}
		this.recoveryState = { status: 'working', action, state: record.state };
		this.onStateChange();
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
		this.onStateChange();
		// A session recovered mid-wait keeps waiting, and one whose window already elapsed while
		// Obsidian was closed captures now instead of losing the stop the player already requested.
		if (this.state.status === 'stopping') this.armSettlement();
		return { status: 'recovered', state: this.getState() };
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

	private async startInternal(input: SessionStartInput): Promise<ManualSessionStartResult> {
		await this.initialize();
		this.lastFailure = null;
		this.lastStopFailure = null;
		this.provisionalDelta = null;
		this.contaminationReview = null;
		this.priceSnapshot = null;
		this.authorityFailure = null;
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
			const captured = await this.baselineCapture.capture(normalizedInput);
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

	private async stopInternal(force: boolean): Promise<ManualSessionStopResult> {
		this.lastStopFailure = null;
		if (this.disposed) {
			return this.failStop('coordination_unavailable', 'Session coordination is unavailable.');
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
				this.apply({
					type: 'request_stop',
					authority,
					requestedAt: this.timestampAtOrAfter(Date.parse(this.state.baseline.completedAt)),
				});
				await this.persistCurrentState();
			}
			const stopping = this.state;
			if (stopping.status !== 'stopping') {
				return this.failStop('unexpected', 'The session could not enter the stopping state.');
			}
			const wait = settlementWait(stopping.stopRequestedAt, this.safeNow());
			if (wait === null) {
				return this.failStop('unexpected', 'The session stop boundary is unusable.');
			}
			if (!force && wait.status === 'waiting') {
				this.armSettlement();
				this.onStateChange();
				return { status: 'awaiting_settlement', state: structuredClone(stopping), wait };
			}
			this.stopSettlement();
			const finalSnapshot = await this.baselineCapture.captureFinal();
			const finalReference = snapshotReference(finalSnapshot);
			const delta = compareStorageSnapshots(this.baselineSnapshot, finalSnapshot);
			if (delta.status === 'invalid') {
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
			} catch {
				priceSnapshot = unavailableSessionPriceSnapshot(
					stopping.sessionId,
					delta,
					Math.max(this.safeNow(), Date.parse(finalSnapshot.completedAt)),
				);
			}
			if (this.authorityFailure) throw new ManualSessionStartError(this.authorityFailure);
			const owned = await this.safeAssert(this.requireHandle());
			if (owned.status === 'error') {
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
		return captureSettlement(state.stopRequestedAt, state.finalSnapshot.startedAt);
	}

	private apply(event: SessionEvent): void {
		const result = transitionSession(this.state, event);
		if (result.status === 'rejected') throw new Error(`Session transition rejected: ${result.reason}`);
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

	private startHeartbeat(handle: ActiveSessionLeaseHandle): void {
		this.currentHandle = handle;
		this.stopHeartbeat();
		const ttl = handle.expiresAt - handle.renewedAt;
		// No upper cap here: a 10 s ceiling on a 300 s lease (H14.22) would still renew every
		// 10 s and lose the whole point of the longer TTL. `ttl / 3` alone still guarantees at
		// least two renewal attempts before the lease could expire.
		const interval = Math.max(1_000, Math.floor(ttl / 3));
		this.heartbeatHandle = this.scheduleInterval(() => { void this.runHeartbeat(); }, interval);
	}

	private runHeartbeat(): Promise<void> {
		if (this.heartbeatFlight) return this.heartbeatFlight;
		const flight = this.heartbeat().finally(() => {
			if (this.heartbeatFlight === flight) this.heartbeatFlight = null;
		});
		this.heartbeatFlight = flight;
		return flight;
	}

	private async heartbeat(): Promise<void> {
		if (this.disposed || !this.currentHandle) return;
		const observed = this.currentHandle;
		try {
			const result = await this.coordinator.renew(observed);
			if (result.status === 'renewed') {
				if (this.currentHandle?.sessionId === observed.sessionId && this.currentHandle.fence === observed.fence) {
					this.currentHandle = result.handle;
				}
				return;
			}
			const mapped = result.status === 'lost'
				? failure('lease_lost', 'The session lease was lost.')
				: failure('coordination_unavailable', 'Session coordination became unavailable.');
			this.failFromAuthority(mapped);
		} catch {
			const mapped = failure('coordination_unavailable', 'Session coordination became unavailable.');
			this.failFromAuthority(mapped);
		}
	}

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
		} catch { /* the state machine remains fail-closed */ }
	}

	private stopHeartbeat(): void {
		if (this.heartbeatHandle !== null) {
			this.cancelInterval(this.heartbeatHandle);
			this.heartbeatHandle = null;
		}
	}

	/**
	 * Watches the grace window while the session is `stopping`. It re-reads the clock on every tick
	 * instead of counting ticks, so a suspended machine or a reopened vault resolves the wait with
	 * the real elapsed time rather than with how often this callback happened to run.
	 */
	private armSettlement(): void {
		if (this.settlementHandle === null && !this.disposed) {
			this.settlementHandle = this.scheduleInterval(() => this.checkSettlement(), API_SETTLEMENT_TICK_MS);
		}
		this.checkSettlement();
	}

	private stopSettlement(): void {
		if (this.settlementHandle !== null) {
			this.cancelInterval(this.settlementHandle);
			this.settlementHandle = null;
		}
	}

	private checkSettlement(): void {
		if (this.disposed || this.state.status !== 'stopping') {
			this.stopSettlement();
			return;
		}
		const wait = this.getSettlementWait();
		if (wait === null || wait.status === 'waiting') return;
		// A stop already in flight owns the decision; the next tick sees whatever it left behind.
		if (this.stopFlight) return;
		this.stopSettlement();
		// One dispatch per due window. A capture that fails leaves the session `stopping` with its
		// stop failure visible, which is the existing retry path, instead of hammering the API.
		this.onSettlementDue();
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

	private failWithoutLease(code: SessionStartFailure['code'], message: string): ManualSessionStartResult {
		const result = failure(code, message);
		this.lastFailure = result;
		this.onStateChange();
		return { status: 'failed', failure: result };
	}

	private safeNow(): number {
		const value = this.now();
		if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid local clock.');
		return value;
	}

	private timestampAtOrAfter(floor: number): string {
		return new Date(Math.max(this.safeNow(), floor)).toISOString();
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

	private async safeAssert(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult> {
		try { return await this.coordinator.assertOwned(handle); } catch { return { status: 'error', code: 'unavailable' }; }
	}

	private async safeRelease(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult> {
		try { return await this.coordinator.release(handle); } catch { return { status: 'error', code: 'unavailable' }; }
	}
}

function snapshotReference(snapshot: StorageSnapshot): SessionSnapshotReference {
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

function stopFailureFloor(
	state: Extract<SessionState, { status: 'stopping' | 'provisional' }>,
): number {
	return state.status === 'stopping'
		? Date.parse(state.stopRequestedAt)
		: Date.parse(state.finalSnapshot.completedAt);
}

function failure(code: SessionStartFailure['code'], message: string): SessionStartFailure {
	return { code, message };
}

function mapFailure(error: unknown, onUnclassified?: (error: unknown) => void): SessionStartFailure {
	if (error instanceof ManualSessionStartError) return error.failure;
	if (error instanceof SessionStartCaptureError) {
		if (error.code === 'invalid_input') return failure('invalid_input', error.message);
		if (error.code === 'build_scope_missing') return failure('missing_capability', error.message);
		return failure('snapshot_failed', error.message);
	}
	if (error instanceof HttpTransportError && error.status === 429) {
		return failure('rate_limited', 'Guild Wars 2 is rate limiting requests. Try again after the shared cooldown clears.');
	}
	onUnclassified?.(error);
	return failure('unexpected', 'The farming session could not be started.');
}

function mapStopFailure(error: unknown, onUnclassified?: (error: unknown) => void): SessionStopFailure {
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
