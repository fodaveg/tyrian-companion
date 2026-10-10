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
import {
	IndexedDbUnavailableError,
	ReopeningIndexedDbConnection,
	indexedDbFailureCode,
	isIndexedDbUnavailable,
	openIndexedDb,
	startIndexedDbTransaction,
} from '../core/indexed-db-open';
import {
	LocalDebugPersistenceProbe,
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

/**
 * GR-05 F1: what an operation meets because this store's own `close()` ended the queue (an open the close turned down,
 * or no connection to open any more). The caller gets it as before; the diagnostic records a cancellation, because an
 * orderly unload is not a storage failure. A real upgrade from another context still fails as it did.
 */
export class ProposalQueueClosedError extends Error {}

/**
 * A connection the engine dropped, or that a `versionchange` other than an upgrade released, is replaced on the next
 * operation (DU-05); `close()` and a real upgrade end the queue for good.
 */
export class IndexedDbPendingProposalStore implements PendingProposalStore {
	private readonly connection: ReopeningIndexedDbConnection;
	/** Set by `close()`: from then on, what the closed connection refuses is a cancellation (GR-05 F1). */
	private closed = false;
	/** The diagnostic context of the operation that is opening, if one is; an open is recorded under it. */
	private openingContext: LocalDebugPersistenceContext | undefined;
	/** DU-03: this store's own record is known to exist, or the common queue had nothing to adopt; it is never read again. */
	private adoptionSettled = false;

	/**
	 * `adoptFrom` names the common queue of an earlier release (DU-03) that this queue adopts a copy of while its own
	 * record was never written; null, the default, adopts nothing.
	 */
	constructor(
		private readonly factory: IDBFactory,
		databaseName = PROPOSAL_QUEUE_DB_NAME,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
		private readonly adoptFrom: string | null = null,
	) {
		this.connection = new ReopeningIndexedDbConnection(async (hooks) => {
			const attempt = this.diagnostics.begin('pending_proposal', 'open', this.openingContext);
			try {
				const database = await openIndexedDb({
					factory: this.factory,
					databaseName,
					databaseVersion: PROPOSAL_QUEUE_DB_VERSION,
					schema: [{ name: PROPOSAL_QUEUE_STORE_NAME }],
					...hooks,
					toError: (reason) => reason === 'refused'
						? this.closedError('Confirmation queue was closed while opening.')
						: new Error(reason === 'blocked' ? 'Confirmation queue upgrade was blocked.' : 'Could not open confirmation queue.'),
				});
				attempt.success();
				return database;
			} catch (error) {
				if (error instanceof ProposalQueueClosedError) attempt.skip('cancelled');
				else attempt.failure(indexedDbFailureCode(error), error);
				throw error;
			}
		}, () => this.closedError('Confirmation queue is unavailable.'));
	}

	async read(context?: LocalDebugPersistenceContext): Promise<unknown> {
		const attempt = this.diagnostics.begin('pending_proposal', 'read', context);
		try {
			const value = await this.run(context, async (database) => {
				const seed = await this.adoptionSeed(database);
				const own = await readQueueRecord(database);
				return own === undefined && seed !== undefined ? structuredClone(seed) : own;
			});
			attempt.success();
			return value;
		} catch (error) {
			if (error instanceof ProposalQueueClosedError) attempt.skip('cancelled');
			else attempt.failure(indexedDbFailureCode(error), error);
			throw error;
		}
	}

	async transaction<T>(
		mutator: (current: unknown) => ProposalQueueMutation<T>,
		context?: LocalDebugPersistenceContext,
	): Promise<T> {
		const attempt = this.diagnostics.begin('pending_proposal', 'transaction', context);
		try {
			let ownRecordExists = false;
			const value = await this.run(context, async (database) => {
				// Read before the transaction (it cannot wait for another database), used only if the own record is still absent in it.
				const seed = await this.adoptionSeed(database);
				return await new Promise<T>((resolve, reject) => {
					// A dead connection throws here, before the mutator ran, so running all of it again is safe.
					const transaction = startIndexedDbTransaction(database, PROPOSAL_QUEUE_STORE_NAME, 'readwrite');
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
			});
			if (ownRecordExists) this.adoptionSettled = true;
			attempt.success();
			return value;
		} catch (error) {
			if (error instanceof ProposalQueueClosedError) attempt.skip('cancelled');
			else attempt.failure(indexedDbFailureCode(error), error);
			throw error;
		}
	}

	close(): void {
		const attempt = this.diagnostics.begin('pending_proposal', 'close');
		this.closed = true;
		this.connection.close();
		attempt.success();
	}

	/** The error of a connection that is gone: a cancellation once `close()` ran, the plain error otherwise (a real upgrade). */
	private closedError(message: string): Error {
		return this.closed ? new ProposalQueueClosedError(message) : new Error(message);
	}

	/**
	 * One operation on the cached connection, replacing a dead one once (DU-05). An open it causes is recorded under
	 * `context`; a second dead connection is this operation's failure, reported as the queue being unavailable.
	 */
	private async run<T>(context: LocalDebugPersistenceContext | undefined, operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
		this.openingContext = context;
		try {
			return await this.connection.run(operation);
		} catch (error) {
			// Both ways `withIndexedDbReopen` gives up are the queue being unavailable; the reason stays for the diagnostic code.
			throw isIndexedDbUnavailable(error) ? new IndexedDbUnavailableError('Confirmation queue is unavailable.', error) : error;
		}
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

}

/**
 * The queue record of `database`, in a read-only transaction of its own. On the store's own connection a dead one throws
 * `IndexedDbConnectionLostError`, which is what lets the operation open a new one.
 */
function readQueueRecord(database: IDBDatabase): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const transaction = startIndexedDbTransaction(database, PROPOSAL_QUEUE_STORE_NAME, 'readonly');
		const request = transaction.objectStore(PROPOSAL_QUEUE_STORE_NAME).get(QUEUE_KEY);
		let value: unknown;
		request.onsuccess = () => { value = request.result as unknown; };
		transaction.oncomplete = () => resolve(value);
		transaction.onerror = () => reject(new Error('Could not read confirmation queue.'));
		transaction.onabort = () => reject(new Error('Confirmation queue read was aborted.'));
	});
}
