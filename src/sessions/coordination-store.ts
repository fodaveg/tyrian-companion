import type { CoordinationState } from './coordination-model';
import { openIndexedDb } from '../core/indexed-db-open';
import {
	LocalDebugPersistenceProbe,
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

/** Dedicated IndexedDB store. It never falls back to memory. */
export class IndexedDbCoordinationStore implements CoordinationStore {
	constructor(
		private readonly database: IDBDatabase,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {}

	static async open(
		factory: IDBFactory,
		databaseName = COORDINATION_DB_NAME,
		databaseVersion = COORDINATION_DB_VERSION,
		diagnostics = new LocalDebugPersistenceProbe(),
	): Promise<IndexedDbCoordinationStore> {
		const attempt = diagnostics.begin('coordination', 'open');
		let database: IDBDatabase;
		try {
			database = await openIndexedDb({
				factory,
				databaseName,
				databaseVersion,
				schema: [{ name: COORDINATION_STORE_NAME }],
				onVersionChange: 'close',
				toError: (reason) => new Error(reason === 'blocked'
					? 'Coordination storage upgrade was blocked.'
					: 'Could not open coordination storage.'),
			});
		} catch (error) {
			attempt.failure();
			throw error;
		}
		attempt.success();
		return new IndexedDbCoordinationStore(database, diagnostics);
	}

	read(context?: LocalDebugPersistenceContext): Promise<unknown> {
		const attempt = this.diagnostics.begin('coordination', 'read', context);
		return new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = this.database.transaction(COORDINATION_STORE_NAME, 'readonly');
			} catch {
				attempt.failure(); reject(new Error('Coordination storage is unavailable.'));
				return;
			}
			const request = transaction.objectStore(COORDINATION_STORE_NAME).get(STATE_KEY);
			let value: unknown;
			request.onsuccess = () => { value = request.result as unknown; };
			transaction.oncomplete = () => { attempt.success(); resolve(value); };
			transaction.onerror = () => { attempt.failure(); reject(new Error('Could not read coordination storage.')); };
			transaction.onabort = () => { attempt.failure(); reject(new Error('Coordination read was aborted.')); };
		});
	}

	transaction<T>(
		mutator: (current: unknown) => CoordinationTransactionResult<T>,
		context?: LocalDebugPersistenceContext,
	): Promise<T> {
		const attempt = this.diagnostics.begin('coordination', 'transaction', context);
		return new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = this.database.transaction(COORDINATION_STORE_NAME, 'readwrite');
			} catch {
				attempt.failure(); reject(new Error('Coordination storage is unavailable.'));
				return;
			}
			const store = transaction.objectStore(COORDINATION_STORE_NAME);
			const request = store.get(STATE_KEY);
			let result: T;
			let mutationFailed = false;
			request.onsuccess = () => {
				try {
					const mutation = mutator(request.result as unknown);
					result = mutation.result;
					if (mutation.nextState !== undefined) store.put(mutation.nextState, STATE_KEY);
				} catch {
					mutationFailed = true;
					transaction.abort();
				}
			};
			transaction.oncomplete = () => { attempt.success(); resolve(result); };
			transaction.onerror = () => { attempt.failure(); reject(new Error('Could not update coordination storage.')); };
			transaction.onabort = () => { attempt.failure(); reject(new Error(
				mutationFailed ? 'Coordination mutation failed.' : 'Coordination update was aborted.',
			)); };
		});
	}

	close(): void {
		const attempt = this.diagnostics.begin('coordination', 'close');
		this.database.close();
		attempt.success();
	}
}
