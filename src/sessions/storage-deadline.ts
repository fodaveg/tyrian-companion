/**
 * How long one call to storage may go unanswered before whoever waits for it is told that storage
 * is unavailable.
 *
 * The same ten seconds the diagnostic writer gives its own storage (`LOCAL_DEBUG_WRITE_TIMEOUT_MS`),
 * and the time the live producer waits for an ACK before it starts a new epoch (SPEC-live-loot §3):
 * past it the producer has given the sample up anyway. An IndexedDB call that answers at all answers
 * in milliseconds, so this is never the reason a healthy store is called unavailable.
 */
export const STORAGE_ANSWER_TIMEOUT_MS = 10_000;

export interface StorageDeadlineOptions {
	/** How long one call may go unanswered (`STORAGE_ANSWER_TIMEOUT_MS` when absent). */
	timeoutMs?: number;
	schedule?: (callback: () => void, milliseconds: number) => unknown;
	cancel?: (handle: unknown) => void;
}

/** What a bounded call rejects with when a rejection is how its port says "unavailable". */
export class StorageUnansweredError extends Error {
	constructor() {
		super('Storage did not answer in time.');
		this.name = 'TimeoutError';
	}
}

/**
 * Bounds the wait for one call to storage.
 *
 * 9 Oct 2026: a transaction the engine accepted and never answered (no `complete`, no `error`, no
 * `abort`) held the serial queue of whoever awaited it for the rest of the plugin's life, with no
 * error anywhere, because nothing had been refused.
 *
 * Only the WAIT is bounded. Nothing can cancel a transaction the engine is not answering, so the
 * call stays in course. Its caller is given, in the call's own vocabulary, the answer of a store
 * that is unavailable, and goes on from there inside its own queue: no part of the caller stays
 * suspended on the call. When the real answer arrives, nothing is left to read it.
 *
 * That makes memory safe, not disk: the abandoned call may still WRITE later. Each store refuses
 * such a write by comparing before it writes (the exact lease in the coordination store; session,
 * authority and `persistedAt` in the runtime store), and a caller that is told "unavailable" has
 * to read storage again before it trusts what it holds in memory.
 *
 * A host that cannot arm a timer (no `window`, as in a unit test under Node) gets the call
 * unbounded, exactly as before: the bound must never be the reason a call fails.
 */
export class StorageDeadline {
	private readonly timeoutMs: number;
	private readonly schedule: (callback: () => void, milliseconds: number) => unknown;
	private readonly cancel: (handle: unknown) => void;

	constructor(options: StorageDeadlineOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? STORAGE_ANSWER_TIMEOUT_MS;
		// Wrapped, never stored bare: a browser timer function kept in a field loses its receiver.
		this.schedule = options.schedule ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
		this.cancel = options.cancel ?? ((handle) => { window.clearTimeout(handle as number); });
	}

	/**
	 * `call`'s own answer when it comes in time; otherwise `unanswered()`, which either returns the
	 * value that means "unavailable" for that call or a rejected promise.
	 *
	 * The timer must be a task, never a microtask: that is what guarantees it cannot fire between
	 * the call answering and its caller going on with that answer.
	 */
	async bounded<T>(call: () => Promise<T>, unanswered: () => T | PromiseLike<T>): Promise<T> {
		let expire: () => void = () => undefined;
		const expired = new Promise<T>((resolve) => { expire = () => { resolve(unanswered()); }; });
		let handle: unknown;
		try {
			handle = this.schedule(expire, this.timeoutMs);
		} catch {
			return await call();
		}
		try {
			return await Promise.race([call(), expired]);
		} finally {
			try { this.cancel(handle); } catch { /* A timer that cannot be cancelled fires into a call already answered. */ }
		}
	}
}
