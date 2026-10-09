import { IDBFactory } from 'fake-indexeddb';

/**
 * A fake IndexedDB that remembers every connection it handed out, so a test can kill one the way
 * an engine does (7 Oct 2026: WebKitGTK stopped answering a plugin whose JavaScript kept running)
 * and then count whether its owner opened another.
 */
export interface TrackedIndexedDb {
	factory: IDBFactory;
	/** Every connection opened through `factory`, in order, including the ones closed since. */
	connections: IDBDatabase[];
	/** While true, every open fails as the engine's would with the storage process gone. */
	down: boolean;
	/** While true, the engine takes every open and every transaction and answers none: see `hangStorage`. */
	hung: boolean;
}

export function trackedIndexedDb(): TrackedIndexedDb {
	const factory = new IDBFactory();
	const tracked: TrackedIndexedDb = { factory, connections: [], down: false, hung: false };
	const open = factory.open.bind(factory);
	factory.open = (name: string, version?: number) => {
		if (tracked.hung) return unanswered<IDBOpenDBRequest>();
		if (tracked.down) return refusedOpen();
		const request = open(name, version);
		request.addEventListener('success', () => {
			const database = request.result;
			tracked.connections.push(database);
			const start = database.transaction.bind(database);
			database.transaction = (...parameters: Parameters<IDBDatabase['transaction']>) => tracked.hung
				? unanswered<IDBTransaction>() : start(...parameters);
		});
		return request;
	};
	return tracked;
}

/**
 * The engine stops answering without dying (9 Oct 2026, the probe of the audit: a transaction that
 * fires no event). From now on every open and every transaction is accepted and then nothing: no
 * `complete`, no `error`, no `abort`, and nothing it was asked to write is applied. Whoever waits for
 * one of them waits for ever, which neither `killStorage` nor an abort produces: both answer.
 */
export function hangStorage(tracked: TrackedIndexedDb): void {
	tracked.hung = true;
}

/** The engine answers again. What it was asked while hung stays unanswered: those transactions are gone. */
export function resumeStorage(tracked: TrackedIndexedDb): void {
	tracked.hung = false;
}

/** The connection is closed without its owner being told: its next `transaction()` throws. */
export function closeUnderneath(database: IDBDatabase): void {
	database.close();
}

/** The engine's own `close` event, alone: the handle still looks open to whoever ignores the event. */
export function emitEngineClose(database: IDBDatabase): void {
	database.onclose?.call(database, new Event('close'));
}

/** Kills every connection opened so far and refuses new ones until `revive`. */
export function killStorage(tracked: TrackedIndexedDb): void {
	tracked.down = true;
	for (const database of tracked.connections) closeUnderneath(database);
}

export function reviveStorage(tracked: TrackedIndexedDb): void {
	tracked.down = false;
}

/**
 * The engine dies between applying a commit and saying so: the next read-write transaction on
 * `databaseName` commits for real, its owner is told `abort` instead of `complete`, and from that
 * instant storage is dead as after `killStorage`. What the owner was told and what is on disk
 * disagree, which `killStorage` alone never produces: it refuses before anything is written.
 */
export function killStorageAfterNextCommit(tracked: TrackedIndexedDb, databaseName: string): void {
	let armed = true;
	for (const database of tracked.connections) {
		if (database.name !== databaseName) continue;
		const start = database.transaction.bind(database);
		database.transaction = (...parameters: Parameters<IDBDatabase['transaction']>) => {
			const transaction = start(...parameters);
			if (!armed || parameters[1] !== 'readwrite') return transaction;
			armed = false;
			// fake-indexeddb reads `oncomplete` when the commit is done: by then the data is on disk.
			Object.defineProperty(transaction, 'oncomplete', { configurable: true, set: () => undefined, get: () => () => {
				killStorage(tracked);
				transaction.onabort?.call(transaction, new Event('abort'));
			} });
			return transaction;
		};
	}
}

/**
 * The engine applies the next read-write transaction on `databaseName` and does not say so: its
 * owner gets no event until the function returned here is called, and then gets the `complete` it
 * was owed. In between, disk is ahead of what the owner knows and the owner is still waiting.
 */
export function holdNextCommitAnswer(tracked: TrackedIndexedDb, databaseName: string): () => void {
	let armed = true;
	let owed: (() => void) | null = null;
	for (const database of tracked.connections) {
		if (database.name !== databaseName) continue;
		const start = database.transaction.bind(database);
		database.transaction = (...parameters: Parameters<IDBDatabase['transaction']>) => {
			const transaction = start(...parameters);
			if (!armed || parameters[1] !== 'readwrite') return transaction;
			armed = false;
			let told: IDBTransaction['oncomplete'] = null;
			// fake-indexeddb reads `oncomplete` when the commit is done: by then the data is on disk.
			Object.defineProperty(transaction, 'oncomplete', { configurable: true,
				set: (handler: IDBTransaction['oncomplete']) => { told = handler; },
				get: () => () => { owed = () => { told?.call(transaction, new Event('complete')); }; } });
			return transaction;
		};
	}
	return () => { owed?.(); owed = null; };
}

/**
 * A factory whose every transaction aborts WITHOUT an `error` event, as a commit the engine
 * refuses or a connection it closes mid-transaction does. Event-faithful by hand, because
 * fake-indexeddb always pairs its aborts with an error.
 */
export function abortingIndexedDb(): IDBFactory {
	const database = {
		objectStoreNames: { contains: () => true },
		transaction: () => {
			const request = { result: undefined };
			const transaction: Partial<IDBTransaction> = {
				error: null,
				objectStore: () => ({ get: () => request, put: () => request, delete: () => request, getAllKeys: () => request }) as unknown as IDBObjectStore,
			};
			queueMicrotask(() => { transaction.onabort?.call(transaction as IDBTransaction, new Event('abort')); });
			return transaction as IDBTransaction;
		},
		close: () => undefined,
	} as unknown as IDBDatabase;
	return {
		open: () => {
			const request = { result: database, error: null } as unknown as IDBOpenDBRequest;
			queueMicrotask(() => { request.onsuccess?.call(request, new Event('success')); });
			return request;
		},
	} as unknown as IDBFactory;
}

/**
 * `rejected`/`resolved`, or `pending` when the promise has still not settled many turns later. The
 * fakes here settle on microtasks, so a bounded number of them tells a hung promise from a slow one
 * without a timer.
 */
export async function settlement(promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
	let state = 'pending' as 'resolved' | 'rejected' | 'pending';
	void promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
	for (let turn = 0; turn < 64 && state === 'pending'; turn += 1) await Promise.resolve();
	return state;
}

/**
 * An engine object nobody is behind: any member is the same thing again, any call returns it, and a
 * handler set on it is dropped. Stands for a request, a transaction, its stores, indexes and cursors
 * alike, so a whole operation can be issued on it and none of it ever answers. `then` is absent on
 * purpose: something that awaits it by mistake must not take it for a promise that never settles.
 */
function unanswered<T>(): T {
	const nobody: unknown = new Proxy(() => undefined, {
		get: (_target, key) => key === 'then' ? undefined : nobody,
		set: () => true,
		apply: () => nobody,
	});
	return nobody as T;
}

/** An open request that only ever fires `error`, on the next microtask as a real one would. */
function refusedOpen(): IDBOpenDBRequest {
	const request = { error: new DOMException('The storage process is gone.', 'UnknownError'), result: undefined } as unknown as IDBOpenDBRequest;
	queueMicrotask(() => { request.onerror?.call(request, new Event('error')); });
	return request;
}
