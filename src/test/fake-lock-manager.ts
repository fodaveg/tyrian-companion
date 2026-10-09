/**
 * A Web Locks manager in memory (`navigator.locks`), for what the session lease does with it: one
 * exclusive lock held for as long as its owner lives, and `ifAvailable` requests that only ask.
 *
 * `FakeLocks` is the registry every context of one storage shares; each `context()` is one document's
 * `navigator.locks`. A context that `die()`s is a document or a process that is gone without having run
 * anything of its own: the engine frees what it held, and none of its callbacks is heard of again. That
 * is the one thing a test could not do with a coordinator alone, since letting go of the lock the right
 * way is `dispose()`.
 *
 * Node 22 has no `navigator.locks`, and the coordinator never reads a global: it is only ever handed one of these.
 */
import type { SessionLifeLocks } from '../sessions/coordination-coordinator';

export interface FakeLockContext extends SessionLifeLocks {
	/** The context ends holding whatever it holds: its locks are freed and its pending requests dropped. */
	die(): void;
}

export interface FakeLocks {
	/** One more context of the same storage, with the locks every other one sees. */
	context(): FakeLockContext;
	/** The names held right now, sorted. */
	held(): string[];
	/**
	 * How an `ifAvailable` request is answered. `honest` is the API. `always free` grants it whoever holds
	 * the name (a manager whose contexts do not really share their locks). `always held` hands the callback
	 * `null` whether anybody holds it or not. `unanswered` never settles, `rejects` settles with an error and
	 * `throws` does not even return.
	 */
	ifAvailable: 'honest' | 'always free' | 'always held' | 'unanswered' | 'rejects' | 'throws';
	/** While false, a request that waits for its lock is never granted it. */
	grants: boolean;
	/**
	 * How a request that waits for its lock (no `ifAvailable`) is taken. `honest` is the API; `throws` does not
	 * even return and `rejects` settles with an error, both before anything is granted; `null` calls back at
	 * once with no lock and holds nothing. With `always held`, that is a manager that answers everything with `null`.
	 */
	waiting: 'honest' | 'throws' | 'rejects' | 'null';
}

type Granted<T> = (lock: Lock | null) => T;
interface Holder { readonly context: object }
interface Waiter { readonly name: string; readonly context: object; readonly grant: () => void }

export function fakeLocks(): FakeLocks {
	const holders = new Map<string, Holder>();
	let waiting: Waiter[] = [];
	const lock = (name: string): Lock => ({ name, mode: 'exclusive' });
	const grantNext = (name: string): void => {
		if (!world.grants || holders.has(name)) return;
		const next = waiting.find((waiter) => waiter.name === name);
		if (!next) return;
		waiting = waiting.filter((waiter) => waiter !== next);
		next.grant();
	};
	/** The callback runs a turn later, as the API's does, and the request settles with what it returned. */
	const answer = async <T>(callback: Granted<T>, granted: Lock | null): Promise<T> => {
		await Promise.resolve();
		return await callback(granted);
	};
	/** Holds `name` for `context` while `callback` runs, and frees it when what the callback returned settles. */
	const hold = async <T>(name: string, context: object, callback: Granted<T>): Promise<T> => {
		const holder: Holder = { context };
		holders.set(name, holder);
		try {
			return await answer(callback, lock(name));
		} finally {
			// Only its own hold: a context that died already lost it, and somebody else may have it now.
			if (holders.get(name) === holder) {
				holders.delete(name);
				grantNext(name);
			}
		}
	};
	const world: FakeLocks = {
		ifAvailable: 'honest',
		grants: true,
		waiting: 'honest',
		held: () => [...holders.keys()].sort(),
		context: () => {
			const context: FakeLockContext = {
				request: <T>(name: string, second: LockOptions | Granted<T>, third?: Granted<T>): Promise<T> => {
					const callback = typeof second === 'function' ? second : third;
					if (!callback) return Promise.reject(new TypeError('A lock request needs a callback.'));
					if (typeof second !== 'function' && second.ifAvailable === true) {
						if (world.ifAvailable === 'throws') throw new Error('The lock manager is not there.');
						if (world.ifAvailable === 'rejects') return Promise.reject(new Error('The lock manager refused.'));
						if (world.ifAvailable === 'unanswered') return new Promise<T>(() => undefined);
						// Granted over whoever holds it, and that holder keeps what it has.
						if (world.ifAvailable === 'always free') return answer(callback, lock(name));
						return world.ifAvailable === 'always held' || holders.has(name) ? answer(callback, null) : hold(name, context, callback);
					}
					if (world.waiting === 'throws') throw new Error('The lock manager is not there.');
					if (world.waiting === 'rejects') return Promise.reject(new Error('The lock manager refused.'));
					if (world.waiting === 'null') return answer(callback, null);
					if (world.grants && !holders.has(name)) return hold(name, context, callback);
					return new Promise<T>((resolve) => {
						waiting.push({ name, context, grant: () => { resolve(hold(name, context, callback)); } });
					});
				},
				die: () => {
					waiting = waiting.filter((waiter) => waiter.context !== context);
					for (const [name, holder] of [...holders]) {
						if (holder.context !== context) continue;
						holders.delete(name);
						grantNext(name);
					}
				},
			};
			return context;
		},
	};
	return world;
}
