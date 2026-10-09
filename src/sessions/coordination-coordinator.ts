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
import { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';
import { StorageDeadline, StorageUnansweredError } from './storage-deadline';

export interface ActiveSessionLeaseCoordinatorOptions {
	store?: CoordinationStore;
	openStore?: () => Promise<CoordinationStore>;
	indexedDb?: IDBFactory | null;
	/**
	 * A name, or how to find it out when the store is first opened: each vault's lease lives in
	 * its own database (H18.12), and which one is only known once `SessionStorageScope` decided.
	 */
	databaseName?: string | (() => Promise<string>);
	clock?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	machineId?: () => string;
	instanceId?: string;
	leaseTtlMs?: number;
	expiryConfirmDelayMs?: number;
	diagnostics?: LocalDebugPersistenceProbe;
	/** How long the store may take to open or to answer one call (`STORAGE_ANSWER_TIMEOUT_MS` when absent). */
	storageTimeoutMs?: number;
	/** One-shot timer for that wait (the host's own when absent). A host that cannot arm one waits without bound. */
	schedule?: (callback: () => void, milliseconds: number) => unknown;
	cancel?: (handle: unknown) => void;
	/**
	 * The Web Locks manager (`navigator.locks`) of the SAME storage the store's IndexedDB belongs to: every
	 * context that can read the lease has to see this one's lock, or a live owner would be taken for dead.
	 * Absent or `null`, nothing here changes: no lock is asked for, no owner is ever shown to be gone, and a
	 * lease is only taken once it ran out. Never read from a global: only the host knows which manager that is.
	 */
	locks?: SessionLifeLocks | null;
	/** How long one answer of `locks` is waited for (`LIFE_LOCK_ANSWER_TIMEOUT_MS` when absent), on the same timer as the store's. */
	lockTimeoutMs?: number;
}

/** What the coordinator uses of the Web Locks API. */
export type SessionLifeLocks = Pick<LockManager, 'request'>;

/**
 * How long one answer of the lock manager is waited for. It is memory of the engine, not storage: an
 * answer that comes at all comes at once, and one that does not come proves nothing.
 */
export const LIFE_LOCK_ANSWER_TIMEOUT_MS = 1_000;

/**
 * Starts the `instanceId` of an owner that holds its life lock, and is how whoever finds its lease knows
 * there is a lock to ask about. It is part of what is stored: a build that reads `wl1:` has to keep
 * meaning this by it. It goes in the id, not in a field of its own, because a build before it rejects a
 * lease with a key it does not know as corrupt (`validLease`), and an id is opaque to it.
 */
const LIFE_MARK = 'wl1:';
const LIFE_LOCK_PREFIX = 'tyrian-companion-lease:';

/**
 * How long an owner must have gone without renewing before a free lock is believed about it: three
 * beats of the live session (`LIVE_SOURCE_STALE_MS`, 5 s), which renews on every one.
 *
 * A free lock alone is only as good as the premise that every context reading the lease sees that
 * lock. Where it fails (two processes over one data directory in an engine that keeps its locks per
 * process: measured, each one took the other's session on every beat) an owner that is alive and
 * beating has renewed within these 15 s, so it is left alone exactly as before there were locks. A
 * host that really died stops renewing, and whoever comes back sooner than this waits out the rest.
 *
 * It does not cover an owner that is alive, unseen AND silent for this long: a live session whose
 * timers a hidden host holds back to one a minute, or the manual session, which renews every 100 s.
 */
export const DEAD_OWNER_SILENCE_MS = 15_000;

type CommonErrorCode = Exclude<Extract<AcquireLeaseResult, { status: 'error' }>['code'], 'fence_overflow'>;
/**
 * What the first transaction of an acquisition found that the second one may take: a lease that ran out, or
 * one whose owner may be shown to be gone, with how long ago it last renewed by the clock that judged it.
 */
type TakeableLease = { status: 'expired'; lease: ActiveSessionLease } | { status: 'held'; lease: ActiveSessionLease; silentMs: number };

/**
 * Cross-window/process active-session lease with durable fencing and fail-closed storage.
 *
 * No operation waits on the store without bound (9 Oct 2026): an open or a call the engine does not
 * answer in time is answered `unavailable`, like one it refused, and the queue goes on to the next
 * operation. The operation that waited ends there, inside the queue, so nothing of it is left to run
 * when the engine answers after all. What such a late answer may have WRITTEN is a lease this
 * instance was never told about: every operation compares the exact stored lease before it writes,
 * so a handle the late write changed is answered `lost`, and a lease it took is found `already_owned`
 * by the next acquisition of the same session or runs out on its own.
 *
 * An owner that died is not waited for until its lease runs out (9 Oct 2026), where the host hands over
 * its lock manager (`locks`). The instance holds one Web Lock for as long as it lives, named after its
 * `instanceId`, and that id says so (`LIFE_MARK`). The engine frees the lock when the document or the
 * process is gone, however it went, with no timer of ours involved. Whoever finds a lease that has not
 * run out, whose owner carries the mark, whose lock is free and which has not been renewed for
 * `DEAD_OWNER_SILENCE_MS`, takes it the way an expired one is taken: a pause, then the exact lease
 * compared again and the fence raised by one.
 *
 * Three rules bound it, and none is traded for a faster recovery:
 * - no lease is written under a marked id unless that instance's lock was granted AND the manager,
 *   asked, answered that it is held. An instance that cannot show both writes an unmarked id;
 * - an owner without the mark is never taken before its lease runs out, and neither is a marked one
 *   whose lock is not shown to be free: a probe that is held, late, missing or throwing answers `busy`,
 *   which is what every acquisition answered before this;
 * - nor is one that renewed within `DEAD_OWNER_SILENCE_MS`, free lock or not: that is what keeps two
 *   live owners that cannot see each other's locks from taking each other's lease on every beat.
 *
 * `renew`, `assertOwned` and `release` know nothing of locks: the lease lasts what it lasted.
 */
export class ActiveSessionLeaseCoordinator {
	private readonly baseInstanceId: string;
	private readonly locks: SessionLifeLocks | null;
	private readonly lockDeadline: StorageDeadline;
	/**
	 * `none`: no lock manager, as before. `pending`: the lock is asked for and nothing is decided.
	 * `proven`: granted and seen held; the id carries the mark. `unmarked`: it could not be shown, the
	 * lock was let go and the id carries no mark. The last two are final, decided before the first lease is written.
	 */
	private life: 'none' | 'pending' | 'proven' | 'unmarked' = 'none';
	private lifeGranted: Promise<boolean> = Promise.resolve(false);
	private lifeSettled: Promise<void> | null = null;
	/**
	 * Where what this instance decided about locks is recorded, so it can be read off a real client: what it
	 * is (once) and each lease it took or declined to take from an owner whose lock it found free. Outcomes
	 * and reasons only: never an id, a session or a time.
	 */
	private readonly diagnostics: LocalDebugPersistenceProbe;
	private lifeReported = false;
	/** The last refusal recorded, so that an owner refused on every beat is recorded once per lease and reason. */
	private lastRefusal: string | null = null;
	private letLifeLockGo: () => void = () => undefined;
	private readonly leaseTtlMs: number;
	private readonly expiryConfirmDelayMs: number;
	private readonly clock: () => number;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly machineIdFactory: () => string;
	private readonly openStore: () => Promise<CoordinationStore>;
	private readonly deadline: StorageDeadline;
	private storePromise: Promise<CoordinationStore> | null = null;
	private acquireFlights = new Map<string, Promise<AcquireLeaseResult>>();
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	private lastNow: number | null = null;

	constructor(options: ActiveSessionLeaseCoordinatorOptions = {}) {
		this.baseInstanceId = options.instanceId ?? crypto.randomUUID();
		this.diagnostics = options.diagnostics ?? new LocalDebugPersistenceProbe();
		this.locks = options.locks ?? null;
		this.lockDeadline = new StorageDeadline({
			timeoutMs: options.lockTimeoutMs ?? LIFE_LOCK_ANSWER_TIMEOUT_MS, schedule: options.schedule, cancel: options.cancel,
		});
		// An id that is not valid is refused before anything else, as it always was; one that would not
		// fit with the mark in front stays unmarked.
		if (this.locks !== null && validId(this.baseInstanceId) && validId(LIFE_MARK + this.baseInstanceId)) {
			this.life = 'pending';
			this.requestLifeLock(this.locks, lifeLockName(LIFE_MARK + this.baseInstanceId));
		}
		// H14.22 (8 sep 2026): a 10 s heartbeat wrote to IndexedDB every 10 s for the whole
		// session (1,440 writes in 4 h). 300 s trades a 5 min recovery window for a 30x drop
		// in write volume; see `ManualSessionStartService.startHeartbeat`, whose own interval
		// formula derives from this TTL. Since F7 that window is only waited out when the owner
		// cannot be shown to be gone (no lock manager, or an owner without the mark).
		this.leaseTtlMs = options.leaseTtlMs ?? 300_000;
		this.expiryConfirmDelayMs = options.expiryConfirmDelayMs ?? 250;
		this.clock = options.clock ?? Date.now;
		this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
		this.machineIdFactory = options.machineId ?? (() => crypto.randomUUID());
		this.deadline = new StorageDeadline({ timeoutMs: options.storageTimeoutMs, schedule: options.schedule, cancel: options.cancel });
		const open = options.store
			? async () => options.store as CoordinationStore
			: options.openStore ?? (async () => {
				const factory = options.indexedDb ?? window.indexedDB;
				if (!factory) throw new Error('IndexedDB is unavailable.');
				const databaseName = typeof options.databaseName === 'function'
					? await options.databaseName()
					: options.databaseName ?? COORDINATION_DB_NAME;
				return IndexedDbCoordinationStore.open(
					factory,
					databaseName,
					undefined,
					options.diagnostics,
				);
			});
		this.openStore = async () => this.answeredInTime(await open());
	}

	/**
	 * Public so a caller that observes `busy` can log which instance is asking, not only which owns it.
	 *
	 * With a lock manager it carries the mark from the start and for good, except for an instance whose
	 * lock could not be shown to be held: that one loses the mark once, before its first lease is written.
	 */
	get instanceId(): string {
		return this.life === 'pending' || this.life === 'proven' ? LIFE_MARK + this.baseInstanceId : this.baseInstanceId;
	}

	/**
	 * `leaseTtlMs` is how long the lease lasts when this call grants one; the coordinator's own when
	 * absent. It is the caller's to choose because it follows the caller's heartbeat: a lease has to
	 * outlive the longest the caller may really go without beating (a timer a hidden host holds
	 * back, not the interval it was asked for), and whoever comes back after its owner died waits
	 * it out. It changes nothing about WHAT is leased: there is one lease, whatever its length, and
	 * an acquisition in flight for the same session is joined as it is.
	 */
	acquire(sessionId: string, leaseTtlMs: number = this.leaseTtlMs): Promise<AcquireLeaseResult> {
		if (!validId(this.instanceId) || !validId(sessionId)) {
			return Promise.resolve({ status: 'error', code: 'corrupt' });
		}
		const existing = this.acquireFlights.get(sessionId);
		if (existing) return existing;
		const flight = this.serial(() => this.acquireInternal(sessionId, leaseTtlMs));
		this.acquireFlights.set(sessionId, flight);
		void flight.finally(() => {
			if (this.acquireFlights.get(sessionId) === flight) this.acquireFlights.delete(sessionId);
		});
		return flight;
	}

	/** `leaseTtlMs` is how long the lease lasts from this renewal on; the coordinator's own when absent (see `acquire`). */
	renew(handle: ActiveSessionLeaseHandle, leaseTtlMs: number = this.leaseTtlMs): Promise<RenewLeaseResult> {
		return this.serial(async () => {
			if (this.disposed) return { status: 'error', code: 'disposed' };
			if (!validId(this.instanceId)) return { status: 'error', code: 'corrupt' };
			if (!validLease(handle) || !validTiming(leaseTtlMs, this.expiryConfirmDelayMs)) return { status: 'error', code: 'corrupt' };
			try {
				return await (await this.getStore()).transaction<RenewLeaseResult>((raw) => {
					const now = this.safeNow();
					if (typeof now !== 'number') return { result: { status: 'error', code: now } };
					const state = parseState(raw);
					if (!state) return { result: { status: 'error', code: 'corrupt' } };
					if (now < handle.renewedAt) return { result: { status: 'error', code: 'clock_anomaly' } };
					if (!sameLease(state.lease, handle) || now >= handle.expiresAt) return { result: { status: 'lost' } };
					const expiresAt = safeExpiry(now, leaseTtlMs);
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
		// The lock goes after whatever is still in the queue: an operation in course may yet write under
		// this instance's id, and everything queued behind it answers `disposed` without writing. A lease
		// this instance leaves behind without releasing it is then anybody's after 15 s of silence, not five minutes.
		void this.queue.then(() => { this.letLifeLockGo(); });
	}

	private async acquireInternal(sessionId: string, leaseTtlMs: number): Promise<AcquireLeaseResult> {
		if (this.disposed) return { status: 'error', code: 'disposed' };
		if (!validTiming(leaseTtlMs, this.expiryConfirmDelayMs)) return { status: 'error', code: 'corrupt' };
		// Before the first lease is written, and before the store is even opened: whether this instance's id
		// carries the mark. Without a lock manager there is nothing to decide and nothing is waited for.
		if (this.life === 'pending') await this.settleLife();
		else if (!this.lifeReported) this.reportLifeAbsent();
		// Disposed of while the lock was being waited for: said as what it is, not as a store that is down.
		if (this.disposed) return { status: 'error', code: 'disposed' };
		// The mark is only ever written by an instance whose lock was shown to be held. An id that was
		// handed in already looking marked would be taken for one that died the moment anybody asked.
		if (this.life !== 'proven' && hasLifeMark(this.instanceId)) return { status: 'error', code: 'corrupt' };
		let first: AcquireLeaseResult | TakeableLease;
		try {
			first = await (await this.getStore()).transaction<AcquireLeaseResult | TakeableLease>((raw) => {
				const now = this.safeNow();
				if (typeof now !== 'number') return { result: { status: 'error', code: now } };
				if (raw === undefined) {
					const machineId = this.machineIdFactory();
					if (!validId(machineId)) return { result: { status: 'error', code: 'corrupt' } };
					const lease = createLease(machineId, this.instanceId, sessionId, 1, now, leaseTtlMs);
					if (!lease) return { result: { status: 'error', code: 'clock_anomaly' } };
					return {
						result: { status: 'acquired', handle: lease },
						nextState: { version: COORDINATION_STATE_VERSION, machineId, fenceCounter: 1, lease },
					};
				}
				const state = parseState(raw);
				if (!state) return { result: { status: 'error', code: 'corrupt' } };
				if (state.lease === null) return this.acquireVacant(state, sessionId, now, leaseTtlMs);
				if (now < state.lease.renewedAt) return { result: { status: 'error', code: 'clock_anomaly' } };
				if (
					now < state.lease.expiresAt &&
					state.lease.instanceId === this.instanceId
				) {
					return { result: { status: 'already_owned', handle: structuredClone(state.lease) } };
				}
				if (now < state.lease.expiresAt) {
					// Somebody else's and not run out. Its owner can only be asked about when it says it holds a
					// lock, and only by an instance whose own lock showed that the manager answers truthfully.
					if (this.life === 'proven' && hasLifeMark(state.lease.instanceId)) {
						// The same `now` that has just said the lease has not run out says how long its owner has been silent.
						return { result: { status: 'held', lease: structuredClone(state.lease), silentMs: now - state.lease.renewedAt } };
					}
					return { result: busyUnder(state.lease) };
				}
				return { result: { status: 'expired', lease: structuredClone(state.lease) } };
			});
		} catch { return { status: 'error', code: 'unavailable' }; }
		if (first.status !== 'expired' && first.status !== 'held') return first;
		const observed = first.lease;
		// Outside any transaction, and not about the store at all. Only «free», said in time, takes this
		// further; held, no answer, a late one or an error leave the owner where it is until its lease runs out.
		const ownerGone = first.status === 'held';
		if (first.status === 'held') {
			const lock = await this.lifeLockState(lifeLockName(observed.instanceId));
			// Held is the ordinary case of another window that is alive, and whoever asked already records it.
			if (lock === 'held') return busyUnder(observed);
			if (lock === null) { this.reportRefusal(observed, 'unavailable', 'owner_lock_unanswered'); return busyUnder(observed); }
			// Free, and still not enough: an owner that renewed this recently is taken for alive whatever the
			// manager says of its lock (`DEAD_OWNER_SILENCE_MS`). The next attempt asks again. Recorded, because
			// seen again and again it is what two live owners that cannot see each other's locks look like.
			if (first.silentMs < DEAD_OWNER_SILENCE_MS) {
				this.reportRefusal(observed, 'precondition_failed', 'owner_renewed_recently', String(DEAD_OWNER_SILENCE_MS - first.silentMs));
				return busyUnder(observed);
			}
		}
		const taking = ownerGone ? this.diagnostics.begin('coordination', 'recover') : null;
		const taken = await this.confirmAndTake(sessionId, leaseTtlMs, observed, ownerGone);
		if (taken.status === 'acquired') taking?.success('ok', { result: 'taken', reason: 'owner_lock_free' });
		// The lease was not the one observed any more: somebody, perhaps the owner shown to be gone, wrote in the pause.
		else if (taken.status === 'busy') taking?.skip('precondition_failed', { result: 'refused', reason: 'lease_changed_in_confirmation' });
		else taking?.failure(taken.status === 'error' && taken.code === 'unavailable' ? 'unavailable' : 'precondition_failed');
		return taken;
	}

	/** The pause and the second transaction of an acquisition that found a lease it may take. */
	private async confirmAndTake(sessionId: string, leaseTtlMs: number, observed: ActiveSessionLease, ownerGone: boolean): Promise<AcquireLeaseResult> {
		try { await this.sleep(this.expiryConfirmDelayMs); } catch { return { status: 'error', code: 'unavailable' }; }
		try {
			return await (await this.getStore()).transaction<AcquireLeaseResult>((raw) => {
				const confirmedNow = this.safeNow();
				if (typeof confirmedNow !== 'number') return { result: { status: 'error', code: confirmedNow } };
				const state = parseState(raw);
				if (!state) return { result: { status: 'error', code: 'corrupt' } };
				const currentLease = state.lease;
				// The exact lease, in both cases: one its owner renewed meanwhile is not the one that was
				// observed. Having run out is asked only of the lease that was found run out; the one whose
				// owner is gone is taken while it still has time left, which is the whole point.
				if (!sameLease(currentLease, observed) || currentLease === null || (!ownerGone && confirmedNow < currentLease.expiresAt)) {
					return {
						result: {
							status: 'busy',
							ownerExpiresAt: currentLease?.expiresAt ?? confirmedNow,
							ownerInstanceId: currentLease?.instanceId ?? 'unknown',
							ownerMachineId: currentLease?.machineId ?? 'unknown',
						},
					};
				}
				return this.acquireVacant(state, sessionId, confirmedNow, leaseTtlMs);
			});
		} catch { return { status: 'error', code: 'unavailable' }; }
	}

	private acquireVacant(
		state: CoordinationState,
		sessionId: string,
		now: number,
		leaseTtlMs: number,
	): { result: AcquireLeaseResult; nextState?: CoordinationState } {
		if (state.fenceCounter >= Number.MAX_SAFE_INTEGER) return { result: { status: 'error', code: 'fence_overflow' } };
		const lease = createLease(state.machineId, this.instanceId, sessionId, state.fenceCounter + 1, now, leaseTtlMs);
		if (!lease) return { result: { status: 'error', code: 'clock_anomaly' } };
		return { result: { status: 'acquired', handle: lease }, nextState: { ...state, fenceCounter: lease.fence, lease } };
	}

	/**
	 * Asks for this instance's lock and keeps it until `letLifeLockGo`. Nothing is waited for here, and
	 * nothing is thrown: a manager that fails to take the request only leaves the instance unmarked, never
	 * unbuilt. The first acquisition waits, bounded, for `lifeGranted`.
	 */
	private requestLifeLock(locks: SessionLifeLocks, name: string): void {
		let answer: (granted: boolean) => void = () => undefined;
		this.lifeGranted = new Promise<boolean>((resolve) => { answer = resolve; });
		const held = new Promise<void>((resolve) => { this.letLifeLockGo = resolve; });
		try {
			// Called on the manager itself, never through a reference to `request` kept apart from it.
			// Held for as long as `held` is pending. Granted after it was given up (the wait ran out, or the
			// instance was disposed of), `held` is already settled and returning it lets the lock go at once.
			// A callback handed no lock was granted nothing. It cannot be left to the question asked afterwards:
			// a manager that answers everything with `null` would say «held» there too, of a lock nobody has.
			const request: unknown = locks.request(name, (lock) => {
				if (lock === null) { answer(false); return undefined; }
				answer(true);
				return held;
			});
			// A request that ends without having been granted is a lock nobody holds, whatever ended it.
			void Promise.resolve(request).then(() => { answer(false); }, () => { answer(false); });
		} catch { answer(false); }
	}

	/**
	 * Decides, once, whether this instance's id carries the mark: its lock granted in time, and the manager
	 * answering that the lock is held when asked the way a contender asks. A manager that calls it free has
	 * just offered the same exclusive lock twice, so nothing it says is believed: the lock is let go, the id
	 * loses the mark, and this instance neither claims to be watchable nor asks about anybody else.
	 */
	private settleLife(): Promise<void> {
		this.lifeSettled ??= (async () => {
			if (this.life !== 'pending') return;
			const attempt = this.diagnostics.begin('coordination', 'open');
			this.lifeReported = true;
			const granted = await this.lockAnswer(() => this.lifeGranted) === true;
			if (granted && await this.lifeLockState(lifeLockName(this.instanceId)) === 'held') {
				this.life = 'proven';
				attempt.success('ok', { state: 'life_lock_proven' });
				return;
			}
			this.life = 'unmarked';
			this.letLifeLockGo();
			attempt.skip('unavailable', { state: 'life_lock_unmarked', reason: granted ? 'lock_not_seen_held' : 'lock_not_granted' });
		})();
		return this.lifeSettled;
	}

	/** What an instance that never asked for a lock is, recorded once: there was no manager, or its id could not carry the mark. */
	private reportLifeAbsent(): void {
		this.lifeReported = true;
		this.diagnostics.begin('coordination', 'open').skip('skipped', { state: 'life_lock_absent' });
	}

	/** A lease left with its owner although that owner's lock was not shown to be held; once per lease and reason. */
	private reportRefusal(observed: ActiveSessionLease, code: 'unavailable' | 'precondition_failed', reason: string, retryAfterMs?: string): void {
		const refusal = `${reason}/${observed.instanceId}/${String(observed.fence)}`;
		if (this.lastRefusal === refusal) return;
		this.lastRefusal = refusal;
		this.diagnostics.begin('coordination', 'recover').skip(code, { result: 'refused', reason, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
	}

	/** What the manager says of `name`, when it says it in time: `null` is every other outcome, and proves nothing. */
	private async lifeLockState(name: string): Promise<'held' | 'free' | null> {
		const locks = this.locks;
		if (locks === null) return null;
		const available = await this.lockAnswer(async (): Promise<unknown> => await locks.request(name, { ifAvailable: true }, (lock) => lock !== null));
		return available === true ? 'free' : available === false ? 'held' : null;
	}

	/** One answer of the lock manager with its wait bounded; `null` when it is late or fails. */
	private async lockAnswer<T>(call: () => Promise<T>): Promise<T | null> {
		try { return await this.lockDeadline.bounded<T | null>(call, () => null); } catch { return null; }
	}

	private getStore(): Promise<CoordinationStore> {
		if (this.disposed) return Promise.reject(new Error('Disposed.'));
		if (this.storePromise === null) {
			const opening = this.openStore();
			this.storePromise = opening;
			// A failed open is not kept: the next lease operation makes its own single attempt
			// instead of answering `unavailable` for the rest of the plugin's life.
			opening.catch(() => { if (this.storePromise === opening) this.storePromise = null; });
		}
		const opening = this.storePromise;
		// Nor is an open that does not answer: whoever waited for it is told so, the next operation
		// opens again, and the store that arrives after that is closed instead of leaked.
		return this.deadline.bounded(() => opening, () => {
			if (this.storePromise === opening) {
				this.storePromise = null;
				void opening.then((store) => store.close(), () => undefined);
			}
			return Promise.reject(new StorageUnansweredError());
		});
	}

	/** The store with the wait for each of its answers bounded: one it does not answer in time rejects, as one it refused. */
	private answeredInTime(store: CoordinationStore): CoordinationStore {
		const unanswered = (): Promise<never> => Promise.reject(new StorageUnansweredError());
		return {
			read: (context) => this.deadline.bounded(() => store.read(context), unanswered),
			transaction: (mutator, context) => this.deadline.bounded(() => store.transaction(mutator, context), unanswered),
			close: () => { store.close(); },
		};
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

function busyUnder(lease: ActiveSessionLease): Extract<AcquireLeaseResult, { status: 'busy' }> {
	return { status: 'busy', ownerExpiresAt: lease.expiresAt, ownerInstanceId: lease.instanceId, ownerMachineId: lease.machineId };
}

function hasLifeMark(instanceId: string): boolean {
	return instanceId.startsWith(LIFE_MARK);
}

function lifeLockName(instanceId: string): string {
	return LIFE_LOCK_PREFIX + instanceId;
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
