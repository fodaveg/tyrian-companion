import type { StorageSnapshot } from '../account/storage-snapshot-model';
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
	normalizeSessionStartInput,
	SessionStartCaptureError,
	type SessionStartCaptureResult,
	type SessionStartInput,
} from './session-start-capture';

export interface SessionLeaseCoordinator {
	acquire(sessionId: string): Promise<AcquireLeaseResult>;
	renew(handle: ActiveSessionLeaseHandle): Promise<RenewLeaseResult>;
	assertOwned(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult>;
	release(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult>;
	dispose(): void;
}

export interface SessionBaselineCapture {
	capture(input: SessionStartInput): Promise<SessionStartCaptureResult>;
}

export interface SessionStartFailure {
	code:
		| 'busy'
		| 'coordination_unavailable'
		| 'invalid_input'
		| 'missing_capability'
		| 'snapshot_failed'
		| 'lease_lost'
		| 'unexpected';
	message: string;
}

class ManualSessionStartError extends Error {
	constructor(readonly failure: SessionStartFailure) {
		super(failure.message);
		this.name = 'ManualSessionStartError';
	}
}

export type ManualSessionStartResult =
	| { status: 'started'; state: Extract<SessionState, { status: 'active' }> }
	| { status: 'failed'; failure: SessionStartFailure };

export interface ManualSessionStartServiceOptions {
	now?: () => number;
	sessionId?: () => string;
	setInterval?: (callback: () => void, milliseconds: number) => unknown;
	clearInterval?: (handle: unknown) => void;
	onStateChange?: () => void;
}

/** Owns the fenced idle → active workflow and leaves no product session after a failed start. */
export class ManualSessionStartService {
	private state: SessionState = initialSessionState();
	private lastFailure: SessionStartFailure | null = null;
	private currentHandle: ActiveSessionLeaseHandle | null = null;
	private heartbeatHandle: unknown = null;
	private heartbeatFlight: Promise<void> | null = null;
	private authorityFailure: SessionStartFailure | null = null;
	private startFlight: Promise<ManualSessionStartResult> | null = null;
	private disposed = false;
	private readonly now: () => number;
	private readonly sessionId: () => string;
	private readonly scheduleInterval: (callback: () => void, milliseconds: number) => unknown;
	private readonly cancelInterval: (handle: unknown) => void;
	private readonly onStateChange: () => void;

	constructor(
		private readonly coordinator: SessionLeaseCoordinator,
		private readonly baselineCapture: SessionBaselineCapture,
		options: ManualSessionStartServiceOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.sessionId = options.sessionId ?? (() => crypto.randomUUID());
		this.scheduleInterval = options.setInterval ?? ((callback, milliseconds) => window.setInterval(callback, milliseconds));
		this.cancelInterval = options.clearInterval ?? ((handle) => window.clearInterval(handle as number));
		this.onStateChange = options.onStateChange ?? (() => undefined);
	}

	getState(): SessionState {
		return structuredClone(this.state);
	}

	getLastFailure(): SessionStartFailure | null {
		return this.lastFailure === null ? null : { ...this.lastFailure };
	}

	start(input: SessionStartInput): Promise<ManualSessionStartResult> {
		if (this.startFlight) return this.startFlight;
		const flight = this.startInternal(input).finally(() => {
			if (this.startFlight === flight) this.startFlight = null;
		});
		this.startFlight = flight;
		return flight;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.stopHeartbeat();
		await this.heartbeatFlight;
		const handle = this.currentHandle;
		this.currentHandle = null;
		if (handle) {
			try { await this.coordinator.release(handle); } catch { /* best effort during unload */ }
		}
		this.coordinator.dispose();
	}

	private async startInternal(input: SessionStartInput): Promise<ManualSessionStartResult> {
		this.lastFailure = null;
		this.authorityFailure = null;
		if (this.disposed) return this.failWithoutLease('coordination_unavailable', 'Session coordination is unavailable.');
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
			return { status: 'started', state: this.getState() as Extract<SessionState, { status: 'active' }> };
		} catch (error) {
			const mapped = mapFailure(error);
			await this.cleanupFailedStart(mapped, authority);
			return { status: 'failed', failure: mapped };
		}
	}

	private apply(event: SessionEvent): void {
		const result = transitionSession(this.state, event);
		if (result.status === 'rejected') throw new Error(`Session transition rejected: ${result.reason}`);
		this.state = result.state;
		this.onStateChange();
	}

	private startHeartbeat(handle: ActiveSessionLeaseHandle): void {
		this.currentHandle = handle;
		this.stopHeartbeat();
		const ttl = handle.expiresAt - handle.renewedAt;
		const interval = Math.max(1_000, Math.min(10_000, Math.floor(ttl / 3)));
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
			this.authorityFailure = mapped;
			this.stopHeartbeat();
			if (this.state.status === 'active') {
				this.apply({
					type: 'fail',
					authority: this.state.authority,
					failedAt: this.timestampAtOrAfter(Date.parse(this.state.baseline.completedAt)),
					code: mapped.code === 'lease_lost' ? 'lease_lost' : 'storage_unavailable',
				});
			}
		} catch {
			const mapped = failure('coordination_unavailable', 'Session coordination became unavailable.');
			this.authorityFailure = mapped;
			this.stopHeartbeat();
			if (this.state.status === 'active') {
				try {
					this.apply({
						type: 'fail',
						authority: this.state.authority,
						failedAt: this.timestampAtOrAfter(Date.parse(this.state.baseline.completedAt)),
						code: 'storage_unavailable',
					});
				} catch { /* the state machine remains fail-closed */ }
			}
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatHandle !== null) {
			this.cancelInterval(this.heartbeatHandle);
			this.heartbeatHandle = null;
		}
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
		this.lastFailure = failed;
		this.onStateChange();
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

function failure(code: SessionStartFailure['code'], message: string): SessionStartFailure {
	return { code, message };
}

function mapFailure(error: unknown): SessionStartFailure {
	if (error instanceof ManualSessionStartError) return error.failure;
	if (error instanceof SessionStartCaptureError) {
		if (error.code === 'invalid_input') return failure('invalid_input', error.message);
		if (error.code === 'build_scope_missing') return failure('missing_capability', error.message);
		return failure('snapshot_failed', error.message);
	}
	return failure('unexpected', 'The farming session could not be started.');
}
