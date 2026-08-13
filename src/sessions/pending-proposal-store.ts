import type { PendingProposalQueueRecord } from './pending-proposal-model';

export const PROPOSAL_QUEUE_DB_NAME = 'tyrian-companion-confirmation-queue';
export const PROPOSAL_QUEUE_DB_VERSION = 1;
export const PROPOSAL_QUEUE_STORE_NAME = 'queue-v1';
const QUEUE_KEY = 'pending-proposals';

export interface ProposalQueueMutation<T> { result: T; next?: PendingProposalQueueRecord }
export interface PendingProposalStore {
	read(): Promise<unknown>;
	transaction<T>(mutator: (current: unknown) => ProposalQueueMutation<T>): Promise<T>;
	close(): void;
}

export class MemoryPendingProposalStore implements PendingProposalStore {
	private value: unknown;
	constructor(initial?: unknown) { this.value = initial === undefined ? undefined : structuredClone(initial); }
	async read(): Promise<unknown> { return structuredClone(this.value); }
	async transaction<T>(mutator: (current: unknown) => ProposalQueueMutation<T>): Promise<T> {
		const mutation = mutator(structuredClone(this.value));
		if (mutation.next) this.value = structuredClone(mutation.next);
		return mutation.result;
	}
	close(): void {}
}

export class IndexedDbPendingProposalStore implements PendingProposalStore {
	private database: IDBDatabase | null = null;
	private opening: Promise<IDBDatabase> | null = null;
	private unavailable = false;

	constructor(private readonly factory: IDBFactory, private readonly databaseName = PROPOSAL_QUEUE_DB_NAME) {}

	async read(): Promise<unknown> {
		const database = await this.open();
		return await new Promise((resolve, reject) => {
			const transaction = database.transaction(PROPOSAL_QUEUE_STORE_NAME, 'readonly');
			const request = transaction.objectStore(PROPOSAL_QUEUE_STORE_NAME).get(QUEUE_KEY);
			let value: unknown;
			request.onsuccess = () => { value = request.result as unknown; };
			transaction.oncomplete = () => resolve(value);
			transaction.onerror = () => reject(new Error('Could not read confirmation queue.'));
			transaction.onabort = () => reject(new Error('Confirmation queue read was aborted.'));
		});
	}

	async transaction<T>(mutator: (current: unknown) => ProposalQueueMutation<T>): Promise<T> {
		const database = await this.open();
		return await new Promise((resolve, reject) => {
			const transaction = database.transaction(PROPOSAL_QUEUE_STORE_NAME, 'readwrite');
			const store = transaction.objectStore(PROPOSAL_QUEUE_STORE_NAME);
			const request = store.get(QUEUE_KEY);
			let result!: T;
			let mutationFailed = false;
			request.onsuccess = () => {
				try {
					const mutation = mutator(request.result as unknown);
					result = mutation.result;
					if (mutation.next) store.put(structuredClone(mutation.next), QUEUE_KEY);
				} catch {
					mutationFailed = true;
					transaction.abort();
				}
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(new Error('Could not update confirmation queue.'));
			transaction.onabort = () => reject(new Error(mutationFailed ? 'Confirmation queue mutation failed.' : 'Confirmation queue update was aborted.'));
		});
	}

	close(): void {
		this.unavailable = true;
		this.database?.close();
		this.database = null;
	}

	private async open(): Promise<IDBDatabase> {
		if (this.unavailable) throw new Error('Confirmation queue is unavailable.');
		if (this.database) return this.database;
		if (this.opening) return this.opening;
		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			const request = this.factory.open(this.databaseName, PROPOSAL_QUEUE_DB_VERSION);
			let settled = false;
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(PROPOSAL_QUEUE_STORE_NAME)) request.result.createObjectStore(PROPOSAL_QUEUE_STORE_NAME);
			};
			request.onerror = () => fail('Could not open confirmation queue.');
			request.onblocked = () => fail('Confirmation queue upgrade was blocked.');
			request.onsuccess = () => {
				if (settled) { request.result.close(); return; }
				if (this.unavailable) { request.result.close(); fail('Confirmation queue was closed while opening.'); return; }
				settled = true;
				this.database = request.result;
				request.result.onversionchange = () => { request.result.close(); this.database = null; this.unavailable = true; };
				resolve(request.result);
			};
			function fail(message: string): void { if (!settled) reject(new Error(message)); settled = true; }
		});
		this.opening = opening;
		try { return await opening; } finally { if (this.opening === opening) this.opening = null; }
	}
}
