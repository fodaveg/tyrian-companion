/**
 * The vocabulary of `ManualSessionStartService`: its ports, its options, the results and failures
 * its public calls answer and the delays it waits on. Types and constants only; the service still
 * re-exports what its consumers import from it.
 */
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import type { SessionPriceCapture } from '../economy/session-price-snapshot';
import type {
	AcquireLeaseResult,
	ActiveSessionLeaseHandle,
	AssertLeaseResult,
	ReleaseLeaseResult,
	RenewLeaseResult,
} from './coordination-model';
import { SESSION_ABANDON_REASONS, type SessionAbandonReason, type SessionState } from './session';
import type { SessionContaminationReview } from './session-contamination-review';
import type { SessionItemTypeCapture } from './session-item-type-capture';
import type { SessionRuntimeRecord, SessionRuntimeStore } from './session-runtime-store';
import type { SessionStartCaptureResult, SessionStartInput } from './session-start-capture';
import type { SessionSettlementWait, SettlementEndpoint } from './session-api-settlement';

export interface SessionLeaseCoordinator {
	/** Identifies this plugin instance in diagnostics; stable from its first lease on (before it, an instance may lose its life-lock mark once). */
	readonly instanceId: string;
	/**
	 * `leaseTtlMs`, on both, is how long the lease lasts from that call; the coordinator's own (five minutes, H14.22)
	 * when absent, which is what this service uses and derives its heartbeat from. The live session names its own
	 * (`LIVE_SESSION_LEASE_TTL_MS`, the same five minutes today, and why it is not shorter).
	 */
	acquire(sessionId: string, leaseTtlMs?: number): Promise<AcquireLeaseResult>;
	renew(handle: ActiveSessionLeaseHandle, leaseTtlMs?: number): Promise<RenewLeaseResult>;
	assertOwned(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult>;
	release(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult>;
	dispose(): void;
}

export interface SessionBaselineCapture {
	capture(input: SessionStartInput, startedNotBefore?: number): Promise<SessionStartCaptureResult>;
	captureFinal?(startedNotBefore?: number): Promise<StorageSnapshot>;
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
		/**
		 * The final snapshot belongs to another account than the baseline: the API key was changed
		 * to a different account mid-session (H18.12). Retrying with that key reads the same account
		 * again, so this one is never retried on its own; only the visible retry tries again.
		 */
		| 'account_changed'
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

export type ManualSessionStartResult =
	| { status: 'started'; state: Extract<SessionState, { status: 'active' }> }
	| { status: 'failed'; failure: SessionStartFailure };

/**
 * Delays between the automatic attempts that finish what a failure interrupted (H18.7): a final
 * capture that failed (network gone during the wait), a lease that expired while the machine slept,
 * a saved session found at startup that another window still held. The last delay repeats: nothing
 * here gives up on its own, and a click on the visible retry always goes straight through.
 */
export const SESSION_AUTO_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 30_000, 60_000, 120_000, 300_000]);

/**
 * How long the watch waits before dispatching a due capture or finalize again when the host never
 * got as far as calling back into the service; a real failure schedules its own backoff instead.
 */
export const SESSION_DISPATCH_GUARD_MS = 60_000;

/** Who asked for a recovery: a click, `initialize()`, or the automatic retry of the watch. */
export type RecoveryMode = 'manual' | 'startup' | 'watch';

export type ManualSessionStopResult =
	| {
			status: 'stopped';
			state: Extract<SessionState, { status: 'provisional' }>;
			delta: StorageDelta;
			/**
			 * Present only when the final snapshot had already been captured and reported by an earlier
			 * attempt (a retry after the finalize or its save failed): the host finalizes again but must
			 * not repeat the capture-time bookkeeping.
			 */
			resumed?: true;
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
/**
 * Stop failures a session may be abandoned from: the ones no retry fixes by itself, because the
 * two snapshots can never be compared (the key now reads another account, or the final snapshot
 * disagrees with the baseline). Network, rate limit, lease and coordination failures retry on
 * their own and end in a real result, so they never offer the way out.
 */
const ABANDONABLE_STOP_FAILURES: readonly SessionAbandonReason[] = SESSION_ABANDON_REASONS;

export function isAbandonableStopFailure(code: SessionStopFailure['code']): code is SessionAbandonReason {
	return (ABANDONABLE_STOP_FAILURES as readonly string[]).includes(code);
}

export type SessionAbandonResult =
	| { status: 'abandoned'; state: Extract<SessionState, { status: 'abandoned' }> }
	| { status: 'failed'; message: string };

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
	/** Legacy evidence may be restored locally without any automatic authenticated recapture. */
	automaticAccountCapture?: boolean;
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
	/**
	 * Called after the service took a session back on its own, from a timer rather than from a call
	 * the host made (H18.7: a lease lost while the machine slept, a saved session another window held
	 * at startup). The host resumes what it runs around a live session, such as the loot poll.
	 */
	onAutoRecovered?: () => void;
	/**
	 * H18.11: the settlement wait per endpoint the final capture reads. Absent, or an unusable
	 * value, keeps that endpoint at the documented ten-minute ceiling; nothing is measured yet
	 * (`API_SETTLEMENT_WINDOW_BY_ENDPOINT_MS`).
	 */
	settlementWindowByEndpointMs?: Partial<Record<SettlementEndpoint, number>>;
	/**
	 * H18.11: the stretches the game was seen being played (the in-game presence), as epoch
	 * milliseconds. Absent, or empty, means nothing observed the game. A gap covered by one of them
	 * was play, so only the part none of them covers is subtracted from the session.
	 */
	observedPlayIntervals?: () => readonly ObservedPlayInterval[];
}

/** H18.11: one stretch the in-game presence saw the game running, `toMs` included. */
export interface ObservedPlayInterval {
	fromMs: number;
	toMs: number;
}

/**
 * H18.11: how often an active session re-saves its record while the lease heartbeat runs, so
 * `persistedAt` stays the last instant Obsidian saw the session alive. A suspend or a closed
 * Obsidian stops these saves, and that last one is where the unobserved gap starts.
 */
export const SESSION_EVIDENCE_SAVE_INTERVAL_MS = 60_000;
