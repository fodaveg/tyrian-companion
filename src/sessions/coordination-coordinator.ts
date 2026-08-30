import {
	COORDINATION_STATE_VERSION,
	type AcquireLeaseResult,
	type ActiveSessionLease,
	type ActiveSessionLeaseHandle,
	type AssertLeaseResult,
	type CoordinationState,
	type ReleaseLeaseResult,
	type RenewLeaseResult,
} from './coordination-model';
import {
	COORDINATION_DB_NAME,
	IndexedDbCoordinationStore,
	type CoordinationStore,
} from './coordination-store';
import type { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';

export interface ActiveSessionLeaseCoordinatorOptions {
	store?: CoordinationStore;
	openStore?: () => Promise<CoordinationStore>;
	indexedDb?: IDBFactory | null;
	databaseName?: string;
	clock?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	machineId?: () => string;
	instanceId?: string;
	leaseTtlMs?: number;
	expiryConfirmDelayMs?: number;
	diagnostics?: LocalDebugPersistenceProbe;
}

type CommonErrorCode = Exclude<Extract<AcquireLeaseResult, { status: 'error' }>['code'], 'fence_overflow'>;

/** Cross-window/process active-session lease with durable fencing and fail-closed storage. */
export class ActiveSessionLeaseCoordinator {
	private readonly instanceId: string;
	private readonly leaseTtlMs: number;
	private readonly expiryConfirmDelayMs: number;
	private readonly clock: () => number;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly machineIdFactory: () => string;
	private readonly openStore: () => Promise<CoordinationStore>;
	private storePromise: Promise<CoordinationStore> | null = null;
	private acquireFlights = new Map<string, Promise<AcquireLeaseResult>>();
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	private lastNow: number | null = null;

	constructor(options: ActiveSessionLeaseCoordinatorOptions = {}) {
		this.instanceId = options.instanceId ?? crypto.randomUUID();
		this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
		this.expiryConfirmDelayMs = options.expiryConfirmDelayMs ?? 250;
		this.clock = options.clock ?? Date.now;
		this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
		this.machineIdFactory = options.machineId ?? (() => crypto.randomUUID());
		this.openStore = options.store
			? async () => options.store as CoordinationStore
			: options.openStore ?? (async () => {
				const factory = options.indexedDb ?? window.indexedDB;
				if (!factory) throw new Error('IndexedDB is unavailable.');
				return IndexedDbCoordinationStore.open(
					factory,
					options.databaseName ?? COORDINATION_DB_NAME,
					undefined,
					options.diagnostics,
				);
			});
	}

	acquire(sessionId: string): Promise<AcquireLeaseResult> {
		if (!validId(this.instanceId) || !validId(sessionId)) {
			return Promise.resolve({ status: 'error', code: 'corrupt' });
		}
		const existing = this.acquireFlights.get(sessionId);
		if (existing) return existing;
		const flight = this.serial(() => this.acquireInternal(sessionId));
		this.acquireFlights.set(sessionId, flight);
		void flight.finally(() => {
			if (this.acquireFlights.get(sessionId) === flight) this.acquireFlights.delete(sessionId);
		});
		return flight;
	}

	renew(handle: ActiveSessionLeaseHandle): Promise<RenewLeaseResult> {
		return this.serial(async () => {
			if (this.disposed) return { status: 'error', code: 'disposed' };
			if (!validId(this.instanceId)) return { status: 'error', code: 'corrupt' };
			if (!validLease(handle)) return { status: 'error', code: 'corrupt' };
			try {
				return await (await this.getStore()).transaction<RenewLeaseResult>((raw) => {
					const now = this.safeNow();
					if (typeof now !== 'number') return { result: { status: 'error', code: now } };
					const state = parseState(raw);
					if (!state) return { result: { status: 'error', code: 'corrupt' } };
					if (now < handle.renewedAt) return { result: { status: 'error', code: 'clock_anomaly' } };
					if (!sameLease(state.lease, handle) || now >= handle.expiresAt) return { result: { status: 'lost' } };
					const expiresAt = safeExpiry(now, this.leaseTtlMs);
					if (!expiresAt) return { result: { status: 'error', code: 'clock_anomaly' } };
					const renewed: ActiveSessionLease = { ...handle, renewedAt: now, expiresAt };
					return { result: { status: 'renewed', handle: renewed }, nextState: { ...state, lease: renewed } };
				});
			} catch { return { status: 'error', code: 'unavailable' }; }
		});
	}

	assertOwned(handle: ActiveSessionLeaseHandle): Promise<AssertLeaseResult> {
		return this.serial(async () => {
			if (this.disposed) return { status: 'error', code: 'disposed' };
			if (!validId(this.instanceId)) return { status: 'error', code: 'corrupt' };
			if (!validLease(handle)) return { status: 'error', code: 'corrupt' };
			try {
				const state = parseState(await (await this.getStore()).read());
				const now = this.safeNow();
				if (typeof now !== 'number') return { status: 'error', code: now };
				if (!state) return { status: 'error', code: 'corrupt' };
				if (now < handle.renewedAt) return { status: 'error', code: 'clock_anomaly' };
				return sameLease(state.lease, handle) && now < handle.expiresAt
					? { status: 'owned' }
					: { status: 'lost' };
			} catch { return { status: 'error', code: 'unavailable' }; }
		});
	}

	release(handle: ActiveSessionLeaseHandle): Promise<ReleaseLeaseResult> {
		return this.serial(async () => {
			if (this.disposed) return { status: 'error', code: 'disposed' };
			if (!validId(this.instanceId)) return { status: 'error', code: 'corrupt' };
			if (!validLease(handle)) return { status: 'error', code: 'corrupt' };
			try {
				return await (await this.getStore()).transaction<ReleaseLeaseResult>((raw) => {
					const now = this.safeNow();
					if (typeof now !== 'number') return { result: { status: 'error', code: now } };
					const state = parseState(raw);
					if (!state) return { result: { status: 'error', code: 'corrupt' } };
					if (now < handle.renewedAt) return { result: { status: 'error', code: 'clock_anomaly' } };
					if (!sameLease(state.lease, handle)) return { result: { status: 'lost' } };
					return { result: { status: 'released' }, nextState: { ...state, lease: null } };
				});
			} catch { return { status: 'error', code: 'unavailable' }; }
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		void this.storePromise?.then((store) => store.close(), () => undefined);
	}

	private async acquireInternal(sessionId: string): Promise<AcquireLeaseResult> {
		if (this.disposed) return { status: 'error', code: 'disposed' };
		if (!validTiming(this.leaseTtlMs, this.expiryConfirmDelayMs)) return { status: 'error', code: 'corrupt' };
		let first: AcquireLeaseResult | { status: 'expired'; lease: ActiveSessionLease };
		try {
			first = await (await this.getStore()).transaction<AcquireLeaseResult | { status: 'expired'; lease: ActiveSessionLease }>((raw) => {
				const now = this.safeNow();
				if (typeof now !== 'number') return { result: { status: 'error', code: now } };
				if (raw === undefined) {
					const machineId = this.machineIdFactory();
					if (!validId(machineId)) return { result: { status: 'error', code: 'corrupt' } };
					const lease = createLease(machineId, this.instanceId, sessionId, 1, now, this.leaseTtlMs);
					if (!lease) return { result: { status: 'error', code: 'clock_anomaly' } };
					return {
						result: { status: 'acquired', handle: lease },
						nextState: { version: COORDINATION_STATE_VERSION, machineId, fenceCounter: 1, lease },
					};
				}
				const state = parseState(raw);
				if (!state) return { result: { status: 'error', code: 'corrupt' } };
				if (state.lease === null) return this.acquireVacant(state, sessionId, now);
				if (now < state.lease.renewedAt) return { result: { status: 'error', code: 'clock_anomaly' } };
				if (
					now < state.lease.expiresAt &&
					state.lease.instanceId === this.instanceId
				) {
					return { result: { status: 'already_owned', handle: structuredClone(state.lease) } };
				}
				if (now < state.lease.expiresAt) return { result: { status: 'busy', ownerExpiresAt: state.lease.expiresAt } };
				return { result: { status: 'expired', lease: structuredClone(state.lease) } };
			});
		} catch { return { status: 'error', code: 'unavailable' }; }
		if (first.status !== 'expired') return first;
		try { await this.sleep(this.expiryConfirmDelayMs); } catch { return { status: 'error', code: 'unavailable' }; }
		try {
			return await (await this.getStore()).transaction<AcquireLeaseResult>((raw) => {
				const confirmedNow = this.safeNow();
				if (typeof confirmedNow !== 'number') return { result: { status: 'error', code: confirmedNow } };
				const state = parseState(raw);
				if (!state) return { result: { status: 'error', code: 'corrupt' } };
				const currentLease = state.lease;
				if (!sameLease(currentLease, first.lease) || currentLease === null || confirmedNow < currentLease.expiresAt) {
					return { result: { status: 'busy', ownerExpiresAt: currentLease?.expiresAt ?? confirmedNow } };
				}
				return this.acquireVacant(state, sessionId, confirmedNow);
			});
		} catch { return { status: 'error', code: 'unavailable' }; }
	}

	private acquireVacant(
		state: CoordinationState,
		sessionId: string,
		now: number,
	): { result: AcquireLeaseResult; nextState?: CoordinationState } {
		if (state.fenceCounter >= Number.MAX_SAFE_INTEGER) return { result: { status: 'error', code: 'fence_overflow' } };
		const lease = createLease(state.machineId, this.instanceId, sessionId, state.fenceCounter + 1, now, this.leaseTtlMs);
		if (!lease) return { result: { status: 'error', code: 'clock_anomaly' } };
		return { result: { status: 'acquired', handle: lease }, nextState: { ...state, fenceCounter: lease.fence, lease } };
	}

	private getStore(): Promise<CoordinationStore> {
		if (this.disposed) return Promise.reject(new Error('Disposed.'));
		this.storePromise ??= this.openStore();
		return this.storePromise;
	}

	private safeNow(): number | CommonErrorCode {
		if (this.disposed) return 'disposed';
		let now: number;
		try { now = this.clock(); } catch { return 'clock_anomaly'; }
		if (!Number.isSafeInteger(now) || now < 0 || (this.lastNow !== null && now < this.lastNow)) return 'clock_anomaly';
		this.lastNow = now;
		return now;
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}
}

function createLease(machineId: string, instanceId: string, sessionId: string, fence: number, now: number, ttl: number): ActiveSessionLease | null {
	if (!validId(machineId) || !validId(instanceId) || !validId(sessionId)) return null;
	const expiresAt = safeExpiry(now, ttl);
	return expiresAt ? { machineId, instanceId, sessionId, fence, acquiredAt: now, renewedAt: now, expiresAt } : null;
}

function safeExpiry(now: number, ttl: number): number | null {
	const expiresAt = now + ttl;
	return Number.isSafeInteger(expiresAt) ? expiresAt : null;
}

function parseState(value: unknown): CoordinationState | null {
	if (!isRecord(value) || Object.keys(value).some((key) => !['version', 'machineId', 'fenceCounter', 'lease'].includes(key)) ||
		value.version !== COORDINATION_STATE_VERSION || !validId(value.machineId) ||
		!Number.isSafeInteger(value.fenceCounter) || (value.fenceCounter as number) < 0 ||
		(value.lease !== null && !validLease(value.lease))) return null;
	if (value.lease !== null && (value.lease.machineId !== value.machineId || value.lease.fence !== value.fenceCounter)) return null;
	return value as unknown as CoordinationState;
}

function validLease(value: unknown): value is ActiveSessionLease {
	return isRecord(value) && Object.keys(value).every((key) => [
		'machineId', 'instanceId', 'sessionId', 'fence', 'acquiredAt', 'renewedAt', 'expiresAt',
	].includes(key)) && validId(value.machineId) && validId(value.instanceId) && validId(value.sessionId) &&
		Number.isSafeInteger(value.fence) && (value.fence as number) > 0 &&
		Number.isSafeInteger(value.acquiredAt) && (value.acquiredAt as number) >= 0 &&
		Number.isSafeInteger(value.renewedAt) && (value.renewedAt as number) >= (value.acquiredAt as number) &&
		Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) > (value.renewedAt as number);
}

function sameLease(left: ActiveSessionLease | null, right: ActiveSessionLease): boolean {
	return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function validTiming(ttl: number, confirm: number): boolean {
	return Number.isSafeInteger(ttl) && ttl > 0 && Number.isSafeInteger(confirm) && confirm >= 0;
}

function validId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
