/**
 * The durable confirmation queue (H5.3), one IndexedDB database per vault since DU-03.
 *
 * Every vault open with the plugin in one Obsidian shares the origin and so the whole IndexedDB. Until DU-03 they
 * shared ONE queue, `tyrian-companion-confirmation-queue`, and each vault reconciled it against its own session: a
 * vault that was idle, or had no account connected, invalidated the stop proposal of the session another vault was
 * running. Each vault now has `<name>:<vaultId>`, with the same `vaultId` the session, coordination and pilot metrics
 * databases receive.
 *
 * The common queue an earlier release wrote is never migrated in place and never deleted. Nothing in a proposal says
 * which vault queued it, so a vault whose own queue was never written starts from a COPY of the pending proposals the
 * common queue holds (without claims, which belong to operations of the earlier queue, and without receipts, which
 * record decisions taken there). Every vault gets the same copy, once, and its own reconcile then keeps what fits its
 * session and invalidates the rest in its copy only: the stop proposal stays with the vault running that session, a
 * start proposal with every idle vault of that account, exactly as each vault's own detection would have queued it.
 * Proposals expire in 24 hours, so the copies are a short transition. Without `IDBFactory.databases()` nothing is
 * adopted, as in `session-storage-scope.ts`: checking for the common queue must not create it.
 */
import { normalizeProposalQueueRecord, type PendingProposalQueueRecord } from './pending-proposal-model';
import { openIndexedDb } from '../core/indexed-db-open';
import {
	LocalDebugPersistenceProbe,
	localDebugStorageFailureCode,
	type LocalDebugPersistenceContext,
} from '../core/local-debug-persistence';

export const PROPOSAL_QUEUE_DB_NAME = 'tyrian-companion-confirmation-queue';
export const PROPOSAL_QUEUE_DB_VERSION = 1;
export const PROPOSAL_QUEUE_STORE_NAME = 'queue-v1';
const QUEUE_KEY = 'pending-proposals';

/** DU-03: one vault's queue, `<name>:<vaultId>`, like the session and pilot metrics databases. */
export function vaultProposalQueueDatabaseName(vaultId: string): string {
	if (vaultId.length === 0) throw new Error('A vault id is required to scope the confirmation queue.');
	return `${PROPOSAL_QUEUE_DB_NAME}:${vaultId}`;
}

/**
 * DU-03: what a vault adopts from the common queue: its pending proposals with no claim, no receipts, revision 0.
 * Nothing (`undefined`) when there is no record, it is not a queue this release can read, or no proposal is pending.
 */
export function adoptedProposalQueue(raw: unknown): PendingProposalQueueRecord | undefined {
	if (raw === undefined) return undefined;
	const record = normalizeProposalQueueRecord(raw);
	if (record === null || record.proposals.length === 0) return undefined;
	return { version: 1, revision: 0, proposals: record.proposals.map((proposal) => ({ ...proposal, claim: null })), receipts: [] };
}

export interface ProposalQueueMutation<T> { result: T; next?: PendingProposalQueueRecord }
export interface PendingProposalStore {
	read(context?: LocalDebugPersistenceContext): Promise<unknown>;
	transaction<T>(mutator: (current: unknown) => ProposalQueueMutation<T>, context?: LocalDebugPersistenceContext): Promise<T>;
	close(): void;
}

/** Test seed (DE-09): in-memory double of the IndexedDB store; only the proposal queue tests build it. */
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
	/** DU-03: this store's own record is known to exist, or the common queue had nothing to adopt; it is never read again. */
	private adoptionSettled = false;

	/**
	 * `adoptFrom` names the common queue of an earlier release (DU-03) that this queue adopts a copy of while its own
	 * record was never written; null, the default, adopts nothing.
	 */
	constructor(
		private readonly factory: IDBFactory,
		private readonly databaseName = PROPOSAL_QUEUE_DB_NAME,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
		private readonly adoptFrom: string | null = null,
	) {}

	async read(context?: LocalDebugPersistenceContext): Promise<unknown> {
		const attempt = this.diagnostics.begin('pending_proposal', 'read', context);
		try {
			const database = await this.open(context);
			const seed = await this.adoptionSeed(database);
			const own = await readQueueRecord(database);
			attempt.success();
			return own === undefined && seed !== undefined ? structuredClone(seed) : own;
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
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
			// Read before the transaction (it cannot wait for another database), used only if the own record is still absent in it.
			const seed = await this.adoptionSeed(database);
			let ownRecordExists = false;
			const value = await new Promise<T>((resolve, reject) => {
			const transaction = database.transaction(PROPOSAL_QUEUE_STORE_NAME, 'readwrite');
			const store = transaction.objectStore(PROPOSAL_QUEUE_STORE_NAME);
			const request = store.get(QUEUE_KEY);
			let result!: T;
			let mutationFailed = false;
			request.onsuccess = () => {
				try {
					const own = request.result as unknown;
					const adopting = own === undefined && seed !== undefined;
					const mutation = mutator(adopting ? structuredClone(seed) : own);
					result = mutation.result;
					// An adoption is written even by a mutation that writes nothing, so it happens once.
					const next = mutation.next ?? (adopting ? seed : undefined);
					if (next) store.put(structuredClone(next), QUEUE_KEY);
					ownRecordExists = own !== undefined || next !== undefined;
				} catch {
					mutationFailed = true;
					transaction.abort();
				}
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(new Error('Could not update confirmation queue.'));
			transaction.onabort = () => reject(new Error(mutationFailed ? 'Confirmation queue mutation failed.' : 'Confirmation queue update was aborted.'));
			});
			if (ownRecordExists) this.adoptionSettled = true;
			attempt.success();
			return value;
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
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

	/**
	 * DU-03: what this queue starts from while its own record was never written: the adopted copy of the common queue,
	 * or nothing. Once the own record exists, or the common queue was read and holds nothing to adopt, it answers nothing
	 * without reading anything. A failure to read the common
	 * queue rejects, so the operation fails and nothing is written that would make the adoption impossible later.
	 */
	private async adoptionSeed(database: IDBDatabase): Promise<PendingProposalQueueRecord | undefined> {
		if (this.adoptFrom === null || this.adoptionSettled) return undefined;
		if (await readQueueRecord(database) !== undefined) {
			this.adoptionSettled = true;
			return undefined;
		}
		const seed = adoptedProposalQueue(await this.readCommonQueue(this.adoptFrom));
		// Nothing pending there (or no common queue, or none this release can read): there is nothing to adopt later
		// either, so later reads do not look again.
		if (seed === undefined) this.adoptionSettled = true;
		return seed;
	}

	/** The common queue's record, or undefined when it does not exist; opening it only after listing never creates it. */
	private async readCommonQueue(name: string): Promise<unknown> {
		// The DOM typings declare it, but an injected factory may still predate it.
		const listDatabases = (this.factory as Partial<Pick<IDBFactory, 'databases'>>).databases;
		if (typeof listDatabases !== 'function') return undefined;
		if (!(await listDatabases.call(this.factory)).some((info) => info.name === name)) return undefined;
		const database = await openIndexedDb({
			factory: this.factory,
			databaseName: name,
			databaseVersion: PROPOSAL_QUEUE_DB_VERSION,
			schema: [{ name: PROPOSAL_QUEUE_STORE_NAME }],
			onVersionChange: 'close',
			toError: (reason) => new Error(reason === 'blocked'
				? 'The earlier confirmation queue was blocked.'
				: 'Could not open the earlier confirmation queue.'),
		});
		try {
			return await readQueueRecord(database);
		} finally {
			database.close();
		}
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
			attempt.failure(localDebugStorageFailureCode(error), error);
			throw error;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}
}

/** The queue record of `database`, in a read-only transaction of its own. */
function readQueueRecord(database: IDBDatabase): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(PROPOSAL_QUEUE_STORE_NAME, 'readonly');
		const request = transaction.objectStore(PROPOSAL_QUEUE_STORE_NAME).get(QUEUE_KEY);
		let value: unknown;
		request.onsuccess = () => { value = request.result as unknown; };
		transaction.oncomplete = () => resolve(value);
		transaction.onerror = () => reject(new Error('Could not read confirmation queue.'));
		transaction.onabort = () => reject(new Error('Confirmation queue read was aborted.'));
	});
}
