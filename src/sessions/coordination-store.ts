import type { CoordinationState } from './coordination-model';

export const COORDINATION_DB_NAME = 'tyrian-companion-coordination';
export const COORDINATION_DB_VERSION = 1;
export const COORDINATION_STORE_NAME = 'coordination-v1';
const STATE_KEY = 'active-session-state';

export interface CoordinationTransactionResult<T> {
	result: T;
	nextState?: CoordinationState;
}

export interface CoordinationStore {
	read(): Promise<unknown>;
	transaction<T>(
		mutator: (current: unknown) => CoordinationTransactionResult<T>,
	): Promise<T>;
	close(): void;
}

/** Dedicated IndexedDB store. It never falls back to memory. */
export class IndexedDbCoordinationStore implements CoordinationStore {
	constructor(private readonly database: IDBDatabase) {}

	static open(
		factory: IDBFactory,
		databaseName = COORDINATION_DB_NAME,
		databaseVersion = COORDINATION_DB_VERSION,
	): Promise<IndexedDbCoordinationStore> {
		return new Promise((resolve, reject) => {
			const request = factory.open(databaseName, databaseVersion);
			let settled = false;
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(COORDINATION_STORE_NAME)) {
					request.result.createObjectStore(COORDINATION_STORE_NAME);
				}
			};
			request.onerror = () => settleError('Could not open coordination storage.');
			request.onblocked = () => settleError('Coordination storage upgrade was blocked.');
			request.onsuccess = () => {
				if (settled) {
					request.result.close();
					return;
				}
				settled = true;
				request.result.onversionchange = () => request.result.close();
				resolve(new IndexedDbCoordinationStore(request.result));
			};

			function settleError(message: string): void {
				if (!settled) reject(new Error(message));
				settled = true;
			}
		});
	}

	read(): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = this.database.transaction(COORDINATION_STORE_NAME, 'readonly');
			} catch {
				reject(new Error('Coordination storage is unavailable.'));
				return;
			}
			const request = transaction.objectStore(COORDINATION_STORE_NAME).get(STATE_KEY);
			let value: unknown;
			request.onsuccess = () => { value = request.result as unknown; };
			transaction.oncomplete = () => resolve(value);
			transaction.onerror = () => reject(new Error('Could not read coordination storage.'));
			transaction.onabort = () => reject(new Error('Coordination read was aborted.'));
		});
	}

	transaction<T>(
		mutator: (current: unknown) => CoordinationTransactionResult<T>,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = this.database.transaction(COORDINATION_STORE_NAME, 'readwrite');
			} catch {
				reject(new Error('Coordination storage is unavailable.'));
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
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(new Error('Could not update coordination storage.'));
			transaction.onabort = () => reject(new Error(
				mutationFailed ? 'Coordination mutation failed.' : 'Coordination update was aborted.',
			));
		});
	}

	close(): void {
		this.database.close();
	}
}
