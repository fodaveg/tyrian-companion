import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import type { ActiveSessionLeaseHandle } from './coordination-model';
import type { SessionState } from './session';
import { createSessionRuntimeRecord, type SessionRuntimeStore } from './session-runtime-store';
import {
	SESSION_EVIDENCE_SAVE_INTERVAL_MS,
	type ManualSessionStopResult,
	type SessionLeaseCoordinator,
	type SessionStartFailure,
} from './manual-session-start-model';
import { failure } from './manual-session-start-failure';

/**
 * What the lease heartbeat reads, writes and calls on the `ManualSessionStartService` it belongs to.
 * Every member is a function, so the heartbeat always sees the service's current handle, state and
 * evidence, never a copy taken when it was built; `setCurrentHandle` writes the service's own.
 */
export interface ManualSessionHeartbeatPort {
	disposed(): boolean;
	state(): SessionState;
	baselineSnapshot(): StorageSnapshot | null;
	stopFlight(): Promise<ManualSessionStopResult> | null;
	currentHandle(): ActiveSessionLeaseHandle | null;
	setCurrentHandle(handle: ActiveSessionLeaseHandle | null): void;
	coordinator(): SessionLeaseCoordinator;
	runtimeStore(): SessionRuntimeStore;
	diagnostics(): LocalDebugActionPort | null;
	scheduleInterval(callback: () => void, milliseconds: number): unknown;
	cancelInterval(handle: unknown): void;
	safeNowOr(fallback: number): number;
	logAuthorityFailure(action: 'session_heartbeat' | 'session_finish', reason: 'lease_lost' | 'clock_anomaly' | 'coordination_unavailable'): void;
	failFromAuthority(mapped: SessionStartFailure): void;
}

/**
 * The lease heartbeat of a manual session: it renews the lease a third of its TTL at a time and,
 * from each renewal, re-saves the active record as evidence (H18.11). It owns the interval, the
 * renewal in flight and the last evidence save; a renewal that fails hands the failure back to the
 * service (`failFromAuthority`). Its members keep the names and bodies they had on the service.
 */
export class ManualSessionHeartbeat {
	private heartbeatHandle: unknown = null;
	heartbeatFlight: Promise<void> | null = null;
	/** Last instant the active record was re-saved as evidence (H18.11); 0 before the first. */
	lastEvidenceSavedAt = 0;

	constructor(private readonly port: ManualSessionHeartbeatPort) {}

	// The service's own members under their own names, read (and the handle written) through the port.
	private get disposed(): boolean { return this.port.disposed(); }
	private get state(): SessionState { return this.port.state(); }
	private get baselineSnapshot(): StorageSnapshot | null { return this.port.baselineSnapshot(); }
	private get stopFlight(): Promise<ManualSessionStopResult> | null { return this.port.stopFlight(); }
	private get currentHandle(): ActiveSessionLeaseHandle | null { return this.port.currentHandle(); }
	private set currentHandle(handle: ActiveSessionLeaseHandle | null) { this.port.setCurrentHandle(handle); }
	private get coordinator(): SessionLeaseCoordinator { return this.port.coordinator(); }
	private get runtimeStore(): SessionRuntimeStore { return this.port.runtimeStore(); }
	private get diagnostics(): LocalDebugActionPort | null { return this.port.diagnostics(); }
	private scheduleInterval(callback: () => void, milliseconds: number): unknown { return this.port.scheduleInterval(callback, milliseconds); }
	private cancelInterval(handle: unknown): void { this.port.cancelInterval(handle); }
	private safeNowOr(fallback: number): number { return this.port.safeNowOr(fallback); }
	private logAuthorityFailure(action: 'session_heartbeat' | 'session_finish', reason: 'lease_lost' | 'clock_anomaly' | 'coordination_unavailable'): void { this.port.logAuthorityFailure(action, reason); }
	private failFromAuthority(mapped: SessionStartFailure): void { this.port.failFromAuthority(mapped); }

	startHeartbeat(handle: ActiveSessionLeaseHandle): void {
		this.currentHandle = handle;
		this.stopHeartbeat();
		// Every caller (start, recover, the startup finalize, reclaim) reaches here after an await
		// that `dispose()` may have outlived: a disposed service never registers the interval again.
		if (this.disposed) return;
		const ttl = handle.expiresAt - handle.renewedAt;
		// No upper cap here: a 10 s ceiling on a 300 s lease (H14.22) would still renew every
		// 10 s and lose the whole point of the longer TTL. `ttl / 3` alone still guarantees at
		// least two renewal attempts before the lease could expire.
		const interval = Math.max(1_000, Math.floor(ttl / 3));
		this.heartbeatHandle = this.scheduleInterval(() => { void this.runHeartbeat(); }, interval);
	}

	runHeartbeat(): Promise<void> {
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
				// Detached on purpose: an IndexedDB write must never delay or fail the lease renewal.
				void this.saveActiveEvidence();
				return;
			}
			const reason = result.status === 'lost'
				? 'lease_lost'
				: result.code === 'clock_anomaly' ? 'clock_anomaly' : 'coordination_unavailable';
			this.logAuthorityFailure('session_heartbeat', reason);
			const mapped = reason === 'lease_lost'
				? failure('lease_lost', 'The session lease was lost.')
				: failure('coordination_unavailable', 'Session coordination became unavailable.');
			this.failFromAuthority(mapped);
		} catch {
			this.logAuthorityFailure('session_heartbeat', 'coordination_unavailable');
			const mapped = failure('coordination_unavailable', 'Session coordination became unavailable.');
			this.failFromAuthority(mapped);
		}
	}

	stopHeartbeat(): void {
		if (this.heartbeatHandle !== null) {
			this.cancelInterval(this.heartbeatHandle);
			this.heartbeatHandle = null;
		}
	}

	/**
	 * H18.11: re-saves the active record once per `SESSION_EVIDENCE_SAVE_INTERVAL_MS` from the
	 * heartbeat, so its `persistedAt` is the last instant this window saw the session alive. It
	 * never touches the lease or the session state: a refused or failed write only means the
	 * evidence stays older, and is recorded instead of failing the session.
	 */
	private async saveActiveEvidence(): Promise<void> {
		if (this.state.status !== 'active' || !this.baselineSnapshot || this.stopFlight) return;
		const now = this.safeNowOr(-1);
		if (now < 0 || now - this.lastEvidenceSavedAt < SESSION_EVIDENCE_SAVE_INTERVAL_MS) return;
		// Claimed before the write, so a heartbeat that lands meanwhile does not issue a second one.
		const previous = this.lastEvidenceSavedAt;
		this.lastEvidenceSavedAt = now;
		try {
			const record = createSessionRuntimeRecord(this.state, this.baselineSnapshot, null, null, now, null, null);
			const saved = record === null ? null : await this.runtimeStore.save(record);
			if (saved?.status !== 'saved' && this.lastEvidenceSavedAt === now) this.lastEvidenceSavedAt = previous;
		} catch (error) {
			if (this.lastEvidenceSavedAt === now) this.lastEvidenceSavedAt = previous;
			this.diagnostics?.event({
				component: 'session', action: 'session_heartbeat', level: 'warn', phase: 'failure',
				code: 'unavailable', state: 'evidence_save', details: unmappedErrorLogDetails(error),
			});
		}
	}
}
