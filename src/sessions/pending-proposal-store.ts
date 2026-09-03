import type { PendingProposalQueueRecord } from './pending-proposal-model';
import { openIndexedDb } from '../core/indexed-db-open';
import {
	LocalDebugPersistenceProbe,
	type LocalDebugPersistenceContext,
} from '../core/local-debug-persistence';

export const PROPOSAL_QUEUE_DB_NAME = 'tyrian-companion-confirmation-queue';
export const PROPOSAL_QUEUE_DB_VERSION = 1;
export const PROPOSAL_QUEUE_STORE_NAME = 'queue-v1';
const QUEUE_KEY = 'pending-proposals';

export interface ProposalQueueMutation<T> { result: T; next?: PendingProposalQueueRecord }
export interface PendingProposalStore {
	read(context?: LocalDebugPersistenceContext): Promise<unknown>;
	transaction<T>(mutator: (current: unknown) => ProposalQueueMutation<T>, context?: LocalDebugPersistenceContext): Promise<T>;
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

	constructor(
		private readonly factory: IDBFactory,
		private readonly databaseName = PROPOSAL_QUEUE_DB_NAME,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {}

	async read(context?: LocalDebugPersistenceContext): Promise<unknown> {
		const attempt = this.diagnostics.begin('pending_proposal', 'read', context);
		try {
			const database = await this.open(context);
			const value = await new Promise((resolve, reject) => {
			const transaction = database.transaction(PROPOSAL_QUEUE_STORE_NAME, 'readonly');
			const request = transaction.objectStore(PROPOSAL_QUEUE_STORE_NAME).get(QUEUE_KEY);
			let value: unknown;
			request.onsuccess = () => { value = request.result as unknown; };
			transaction.oncomplete = () => resolve(value);
			transaction.onerror = () => reject(new Error('Could not read confirmation queue.'));
			transaction.onabort = () => reject(new Error('Confirmation queue read was aborted.'));
			});
			attempt.success();
			return value;
		} catch (error) {
			attempt.failure();
			throw error;
		}
	}

	async transaction<T>(
		mutator: (current: unknown) => ProposalQueueMutation<T>,
		context?: LocalDebugPersistenceContext,
	): Promise<T> {
		const attempt = this.diagnostics.begin('pending_proposal', 'transaction', context);
		try {
			const database = await this.open(context);
			const value = await new Promise<T>((resolve, reject) => {
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
			attempt.success();
			return value;
		} catch (error) {
			attempt.failure();
			throw error;
		}
	}

	close(): void {
		const attempt = this.diagnostics.begin('pending_proposal', 'close');
		this.unavailable = true;
		this.database?.close();
		this.database = null;
		attempt.success();
	}

	private async open(context?: LocalDebugPersistenceContext): Promise<IDBDatabase> {
		if (this.unavailable) throw new Error('Confirmation queue is unavailable.');
		if (this.database) return this.database;
		if (this.opening) return this.opening;
		const attempt = this.diagnostics.begin('pending_proposal', 'open', context);
		const opening = openIndexedDb({
			factory: this.factory,
			databaseName: this.databaseName,
			databaseVersion: PROPOSAL_QUEUE_DB_VERSION,
			schema: [{ name: PROPOSAL_QUEUE_STORE_NAME }],
			accept: () => !this.unavailable,
			onVersionChange: () => { this.database = null; this.unavailable = true; },
			toError: (reason) => new Error(reason === 'blocked'
				? 'Confirmation queue upgrade was blocked.'
				: reason === 'refused'
					? 'Confirmation queue was closed while opening.'
					: 'Could not open confirmation queue.'),
		});
		this.opening = opening;
		try {
			const database = await opening;
			this.database = database;
			attempt.success();
			return database;
		} catch (error) {
			attempt.failure();
			throw error;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}
}
