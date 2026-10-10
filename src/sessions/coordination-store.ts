import type { CoordinationState } from './coordination-model';
import {
	IndexedDbConnectionLostError,
	indexedDbFailureCode,
	openIndexedDb,
	startIndexedDbTransaction,
	withIndexedDbReopen,
} from '../core/indexed-db-open';
import {
	LocalDebugPersistenceProbe,
	localDebugStorageFailureCode,
	type LocalDebugPersistenceContext,
} from '../core/local-debug-persistence';

export const COORDINATION_DB_NAME = 'tyrian-companion-coordination';
export const COORDINATION_DB_VERSION = 1;
export const COORDINATION_STORE_NAME = 'coordination-v1';
const STATE_KEY = 'active-session-state';

export interface CoordinationTransactionResult<T> {
	result: T;
	nextState?: CoordinationState;
}

export interface CoordinationStore {
	read(context?: LocalDebugPersistenceContext): Promise<unknown>;
	transaction<T>(
		mutator: (current: unknown) => CoordinationTransactionResult<T>,
		context?: LocalDebugPersistenceContext,
	): Promise<T>;
	close(): void;
}

/**
 * Dedicated IndexedDB store. It never falls back to memory.
 *
 * A connection the engine closed, or that no longer starts transactions, is dropped and the same
 * operation opens one more (one reopen per operation). A store built around one fixed connection,
 * without `connect`, has nothing to open again and stays unavailable.
 */
export class IndexedDbCoordinationStore implements CoordinationStore {
	private opening: Promise<IDBDatabase> | null = null;
	/** Set by `close()` and by a real upgrade from another context: neither is followed by a reopen. */
	private closed = false;

	constructor(
		private database: IDBDatabase | null,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
		private readonly connect: ((store: IndexedDbCoordinationStore) => Promise<IDBDatabase>) | null = null,
	) {}

	static async open(
		factory: IDBFactory,
		databaseName = COORDINATION_DB_NAME,
		databaseVersion = COORDINATION_DB_VERSION,
		diagnostics = new LocalDebugPersistenceProbe(),
	): Promise<IndexedDbCoordinationStore> {
		const attempt = diagnostics.begin('coordination', 'open');
		const store = new IndexedDbCoordinationStore(null, diagnostics, async (owner) => await openIndexedDb({
			factory,
			databaseName,
			databaseVersion,
			schema: [{ name: COORDINATION_STORE_NAME }],
			accept: () => !owner.closed,
			onVersionChange: (database, kind) => {
				if (owner.database === database) owner.database = null;
				// A real upgrade is final: the lease schema on disk is no longer this build's.
				if (kind === 'upgrade') owner.closed = true;
			},
			onClose: (database) => { owner.discard(database); },
			toError: (reason) => new Error(reason === 'blocked'
				? 'Coordination storage upgrade was blocked.'
				: 'Could not open coordination storage.'),
		}));
		try {
			await store.connection();
		} catch (error) {
			attempt.failure(indexedDbFailureCode(error), error);
			throw error;
		}
		attempt.success();
		return store;
	}

	async read(context?: LocalDebugPersistenceContext): Promise<unknown> {
		const attempt = this.diagnostics.begin('coordination', 'read', context);
		try {
			const value = await this.run<unknown>((database) => new Promise((resolve, reject) => {
				// A throw here rejects this promise: the executor runs synchronously inside it.
				const transaction = startIndexedDbTransaction(database, COORDINATION_STORE_NAME, 'readonly');
				const request = transaction.objectStore(COORDINATION_STORE_NAME).get(STATE_KEY);
				let read: unknown;
				request.onsuccess = () => { read = request.result as unknown; };
				transaction.oncomplete = () => resolve(read);
				transaction.onerror = () => reject(new CoordinationFailure('Could not read coordination storage.', transaction.error));
				transaction.onabort = () => reject(new CoordinationFailure('Coordination read was aborted.', transaction.error));
			}));
			attempt.success();
			return value;
		} catch (error) {
			throw this.failed(attempt, error);
		}
	}

	async transaction<T>(
		mutator: (current: unknown) => CoordinationTransactionResult<T>,
		context?: LocalDebugPersistenceContext,
	): Promise<T> {
		const attempt = this.diagnostics.begin('coordination', 'transaction', context);
		try {
			const result = await this.run<T>((database) => new Promise((resolve, reject) => {
				// A dead connection throws before the mutator runs, so running it again is safe.
				const transaction = startIndexedDbTransaction(database, COORDINATION_STORE_NAME, 'readwrite');
				const store = transaction.objectStore(COORDINATION_STORE_NAME);
				const request = store.get(STATE_KEY);
				let mutated: T;
				let mutationFailed = false;
				request.onsuccess = () => {
					try {
						const mutation = mutator(request.result as unknown);
						mutated = mutation.result;
						if (mutation.nextState !== undefined) store.put(mutation.nextState, STATE_KEY);
					} catch {
						mutationFailed = true;
						transaction.abort();
					}
				};
				transaction.oncomplete = () => resolve(mutated);
				transaction.onerror = () => reject(new CoordinationFailure('Could not update coordination storage.', transaction.error));
				transaction.onabort = () => reject(new CoordinationFailure(
					mutationFailed ? 'Coordination mutation failed.' : 'Coordination update was aborted.', transaction.error,
				));
			}));
			attempt.success();
			return result;
		} catch (error) {
			throw this.failed(attempt, error);
		}
	}

	close(): void {
		const attempt = this.diagnostics.begin('coordination', 'close');
		this.closed = true;
		this.database?.close();
		this.database = null;
		attempt.success();
	}

	/** One operation on the cached connection, with a single reopen when it died underneath. */
	private async run<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
		return await withIndexedDbReopen({
			open: async () => await this.connection(),
			discard: (database) => { this.discard(database); },
		}, operation);
	}

	private async connection(): Promise<IDBDatabase> {
		if (this.closed) throw new Error('Coordination storage is unavailable.');
		if (this.database) return this.database;
		if (this.opening) return await this.opening;
		if (this.connect === null) throw new Error('Coordination storage is unavailable.');
		const opening = this.connect(this);
		this.opening = opening;
		try {
			const database = await opening;
			this.database = database;
			return database;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}

	/** Forgets a connection the engine closed or that no longer starts transactions. */
	private discard(database: IDBDatabase): void {
		if (this.database === database) this.database = null;
		try { database.close(); } catch { /* Already gone, which is the reason it is being dropped. */ }
	}

	/** Records the one outcome of a failed operation and returns the error its caller sees. */
	private failed(attempt: ReturnType<LocalDebugPersistenceProbe['begin']>, error: unknown): Error {
		if (error instanceof CoordinationFailure) {
			attempt.failure(localDebugStorageFailureCode(error.reason), error.reason);
			return error;
		}
		const reason = error instanceof IndexedDbConnectionLostError ? error.reason : error;
		attempt.failure(localDebugStorageFailureCode(reason), reason);
		return new Error('Coordination storage is unavailable.');
	}
}

/** A transaction that started and did not complete, with the engine's own error kept for diagnostics. */
class CoordinationFailure extends Error {
	constructor(message: string, readonly reason: unknown) {
		super(message);
	}
}
