import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import type { SessionInProgressState, SessionState } from './session';
import type { SessionRuntimeRecord } from './session-runtime-store';
import { API_SETTLEMENT_TICK_MS, type SessionSettlementWait } from './session-api-settlement';
import {
	SESSION_AUTO_RETRY_DELAYS_MS,
	SESSION_DISPATCH_GUARD_MS,
	type ManualSessionStopResult,
	type RecoveryMode,
	type SessionContaminationReviewResult,
	type SessionRecoveryResult,
	type SessionRecoveryState,
	type SessionStopFailure,
} from './manual-session-start-model';

/**
 * What the lifecycle watch reads and calls on the `ManualSessionStartService` it belongs to. Every
 * member is a function, so the watch always sees the service's current state and flights, never a
 * copy taken when it was built.
 */
export interface ManualSessionWatchPort {
	disposed(): boolean;
	state(): SessionState;
	stopFlight(): Promise<ManualSessionStopResult> | null;
	reviewFlight(): Promise<SessionContaminationReviewResult> | null;
	reclaimFlight(): Promise<SessionStopFailure | null> | null;
	recoveryFlight(): Promise<SessionRecoveryResult> | null;
	recoveryRecord(): SessionRuntimeRecord | null;
	recoveryState(): SessionRecoveryState;
	diagnostics(): LocalDebugActionPort | null;
	scheduleInterval(callback: () => void, milliseconds: number): unknown;
	cancelInterval(handle: unknown): void;
	safeNowOr(fallback: number): number;
	getSettlementWait(): SessionSettlementWait | null;
	onSettlementDue(): void;
	onAutoRecovered(): void;
	reclaimableError(): Exclude<SessionInProgressState, { status: 'starting' }> | null;
	reclaim(): Promise<SessionStopFailure | null>;
	runRecovery(action: 'recover' | 'discard', mode: RecoveryMode): Promise<SessionRecoveryResult>;
	continueRecoveredSession(deferred: boolean): void;
}

/**
 * The one lifecycle tick of a manual session (H18.7): the settlement wait of a `stopping` session
 * and the automatic, backed-off retries of whatever a failure interrupted. It owns the interval and
 * the retry schedule; what to retry, and the retry itself, stay with the service (`port`). Its
 * members keep the names and bodies they had on the service, which reads `autoRetryAt` through it.
 */
export class ManualSessionWatch {
	private settlementHandle: unknown = null;
	/** Earliest instant the lifecycle watch may retry on its own; null when nothing waits for it. */
	autoRetryAt: number | null = null;
	private autoRetryAttempts = 0;

	constructor(private readonly port: ManualSessionWatchPort) {}

	// The service's own members under their own names, read through the port on every use.
	private get disposed(): boolean { return this.port.disposed(); }
	private get state(): SessionState { return this.port.state(); }
	private get stopFlight(): Promise<ManualSessionStopResult> | null { return this.port.stopFlight(); }
	private get reviewFlight(): Promise<SessionContaminationReviewResult> | null { return this.port.reviewFlight(); }
	private get reclaimFlight(): Promise<SessionStopFailure | null> | null { return this.port.reclaimFlight(); }
	private get recoveryFlight(): Promise<SessionRecoveryResult> | null { return this.port.recoveryFlight(); }
	private get recoveryRecord(): SessionRuntimeRecord | null { return this.port.recoveryRecord(); }
	private get recoveryState(): SessionRecoveryState { return this.port.recoveryState(); }
	private get diagnostics(): LocalDebugActionPort | null { return this.port.diagnostics(); }
	private scheduleInterval(callback: () => void, milliseconds: number): unknown { return this.port.scheduleInterval(callback, milliseconds); }
	private cancelInterval(handle: unknown): void { this.port.cancelInterval(handle); }
	private safeNowOr(fallback: number): number { return this.port.safeNowOr(fallback); }
	private getSettlementWait(): SessionSettlementWait | null { return this.port.getSettlementWait(); }
	private onSettlementDue(): void { this.port.onSettlementDue(); }
	private onAutoRecovered(): void { this.port.onAutoRecovered(); }
	private reclaimableError(): Exclude<SessionInProgressState, { status: 'starting' }> | null { return this.port.reclaimableError(); }
	private reclaim(): Promise<SessionStopFailure | null> { return this.port.reclaim(); }
	private runRecovery(action: 'recover' | 'discard', mode: RecoveryMode): Promise<SessionRecoveryResult> { return this.port.runRecovery(action, mode); }
	private continueRecoveredSession(deferred: boolean): void { this.port.continueRecoveredSession(deferred); }

	/**
	 * Watches the grace window while the session is `stopping`. It re-reads the clock on every tick
	 * instead of counting ticks, so a suspended machine or a reopened vault resolves the wait with
	 * the real elapsed time rather than with how often this callback happened to run.
	 */
	armSettlement(): void {
		this.armWatch();
		this.checkSettlement();
	}

	/** Starts the one lifecycle tick (settlement wait and automatic retries) without checking now. */
	armWatch(): void {
		if (this.settlementHandle === null && !this.disposed) {
			this.settlementHandle = this.scheduleInterval(() => this.checkSettlement(), API_SETTLEMENT_TICK_MS);
		}
	}

	stopSettlement(): void {
		if (this.settlementHandle !== null) {
			this.cancelInterval(this.settlementHandle);
			this.settlementHandle = null;
		}
	}

	/**
	 * The lifecycle tick. Besides the settlement wait it now finishes, on its own and with backoff
	 * (H18.7), whatever a failure interrupted: a final capture (`stopping`), a finalize or its save
	 * (`provisional`), a lost authority (`error`) or a saved session another window held at startup
	 * (`idle` with a recovery record). The interval stops once there is nothing left to watch.
	 */
	private checkSettlement(): void {
		if (this.disposed) {
			this.stopSettlement();
			return;
		}
		if (this.state.status === 'stopping') {
			this.checkSettlementDue();
			return;
		}
		if (this.autoRetryAt === null) {
			this.stopSettlement();
			return;
		}
		if (this.safeNowOr(0) < this.autoRetryAt) return;
		if (this.state.status === 'provisional') {
			if (this.stopFlight || this.reviewFlight) return;
			this.autoRetryAt = this.safeNowOr(0) + SESSION_DISPATCH_GUARD_MS;
			this.onSettlementDue();
		} else if (this.reclaimableError() !== null) {
			if (this.stopFlight || this.reclaimFlight) return;
			this.autoRetryAt = null;
			void this.runAutoRetry('reclaim');
		} else if (
			this.state.status === 'idle' && this.recoveryRecord !== null
			&& (this.recoveryState.status === 'available' || this.recoveryState.status === 'busy')
		) {
			if (this.recoveryFlight) return;
			this.autoRetryAt = null;
			void this.runAutoRetry('recover');
		} else {
			this.clearAutoRetry();
			this.stopSettlement();
		}
	}

	private checkSettlementDue(): void {
		const wait = this.getSettlementWait();
		if (wait === null || wait.status === 'waiting') return;
		// A stop already in flight owns the decision; the next tick sees whatever it left behind.
		if (this.stopFlight) return;
		const now = this.safeNowOr(0);
		if (this.autoRetryAt !== null && now < this.autoRetryAt) return;
		// One dispatch per attempt. A failed capture schedules the next one with backoff
		// (`afterStopAttempt`); the guard only covers a host that never got to call `stop()`.
		this.autoRetryAt = now + SESSION_DISPATCH_GUARD_MS;
		this.onSettlementDue();
	}

	scheduleAutoRetry(at?: number): void {
		if (this.disposed) return;
		const delays = SESSION_AUTO_RETRY_DELAYS_MS;
		const delay = delays[Math.min(this.autoRetryAttempts, delays.length - 1)] ?? 0;
		this.autoRetryAttempts += 1;
		this.autoRetryAt = at ?? this.safeNowOr(Date.now()) + delay;
		this.armWatch();
	}

	clearAutoRetry(): void {
		this.autoRetryAt = null;
		this.autoRetryAttempts = 0;
	}

	/**
	 * The watch's only detached call. A throw here (an invalid local clock, a store that throws
	 * instead of answering) is logged and turned into the next scheduled attempt, never lost.
	 */
	private async runAutoRetry(kind: 'reclaim' | 'recover'): Promise<void> {
		try {
			if (kind === 'recover') {
				await this.runRecovery('recover', 'watch');
				return;
			}
			const failed = await this.reclaim();
			if (this.disposed) return;
			if (failed !== null) {
				if (this.reclaimableError() !== null) this.scheduleAutoRetry();
				return;
			}
			this.onAutoRecovered();
			this.continueRecoveredSession(false);
		} catch (error) {
			this.diagnostics?.event({
				component: 'session', action: kind === 'recover' ? 'session_recover' : 'session_heartbeat',
				level: 'error', phase: 'failure', code: 'unknown_failure', state: 'auto_retry',
				details: unmappedErrorLogDetails(error),
			});
			this.scheduleAutoRetry();
		}
	}
}
