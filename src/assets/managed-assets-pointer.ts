import {
	ReopeningIndexedDbConnection,
	isIndexedDbUnavailable,
	openIndexedDb,
	startIndexedDbTransaction,
} from '../core/indexed-db-open';
import { LocalDebugPersistenceProbe, localDebugStorageFailureCode } from '../core/local-debug-persistence';

export const MANAGED_ASSETS_POINTER_DB = 'tyrian-companion-managed-assets';
const STORE = 'pointer-v1';

export type ManagedAssetsPointerState =
	| { schemaVersion: 1; generation: number; status: 'ready'; root: string | null; targetRoot: null }
	| { schemaVersion: 1; generation: number; status: 'installing'; root: null; targetRoot: string }
	| { schemaVersion: 1; generation: number; status: 'removing'; root: string; targetRoot: null }
	| { schemaVersion: 1; generation: number; status: 'moving'; root: string; targetRoot: string };

export const EMPTY_MANAGED_ASSETS_POINTER: ManagedAssetsPointerState = Object.freeze({
	schemaVersion: 1, generation: 0, status: 'ready', root: null, targetRoot: null,
});

export interface ManagedAssetsPointerStore {
	read(): Promise<ManagedAssetsPointerState>;
	compareAndSet(expected: ManagedAssetsPointerState, next: Omit<ManagedAssetsPointerState, 'schemaVersion' | 'generation'>): Promise<ManagedAssetsPointerState | null>;
	close(): void;
}

/**
 * The durable pointer, opened lazily. A connection the engine dropped, or that a `versionchange` other than an upgrade
 * released, is replaced on the next operation (DU-05); `close()` and a real upgrade end the store for good.
 */
export class IndexedDbManagedAssetsPointerStore implements ManagedAssetsPointerStore {
	private readonly connection: ReopeningIndexedDbConnection;
	private readonly key: string;
	constructor(
		factory: IDBFactory,
		vaultId: string,
		databaseName = MANAGED_ASSETS_POINTER_DB,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {
		if (!/^[a-f0-9]{64}$/u.test(vaultId)) throw new Error('Managed-assets vault identity is invalid.');
		this.key = `managed-assets-pointer:${vaultId}`;
		this.connection = new ReopeningIndexedDbConnection(async (hooks) => {
			const attempt = this.diagnostics.begin('managed_assets_pointer', 'open');
			try {
				const database = await openIndexedDb({
					factory,
					databaseName,
					databaseVersion: 1,
					schema: [{ name: STORE }],
					...hooks,
					toError: () => new Error('Managed-assets pointer could not be opened.'),
				});
				attempt.success();
				return database;
			} catch (error) {
				attempt.failure(localDebugStorageFailureCode(error), error);
				throw error;
			}
		}, () => new Error('Managed-assets pointer is closed.'));
	}

	async read(): Promise<ManagedAssetsPointerState> {
		const attempt = this.diagnostics.begin('managed_assets_pointer', 'read');
		try {
			const result = await this.run((database) => requestTransaction(database, 'readonly', (store) => store.get(this.key), (value) => parsePointer(value)));
			attempt.success();
			return result;
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			throw error;
		}
	}

	async compareAndSet(expected: ManagedAssetsPointerState, next: Omit<ManagedAssetsPointerState, 'schemaVersion' | 'generation'>): Promise<ManagedAssetsPointerState | null> {
		const attempt = this.diagnostics.begin('managed_assets_pointer', 'write');
		try {
			const result = await this.run((database) => new Promise<ManagedAssetsPointerState | null>((resolve, reject) => {
			// A throw here rejects this promise before the compare ran, so running it again is safe.
			const transaction = startIndexedDbTransaction(database, STORE, 'readwrite');
			const store = transaction.objectStore(STORE);
			const request = store.get(this.key);
			let result: ManagedAssetsPointerState | null = null;
			request.onsuccess = () => {
				try {
					const current = parsePointer(request.result as unknown);
					if (!samePointer(current, expected)) return;
					if (!Number.isSafeInteger(current.generation + 1)) throw new Error('pointer_overflow');
					result = { ...next, schemaVersion: 1, generation: current.generation + 1 } as ManagedAssetsPointerState;
					if (!isPointer(result)) throw new Error('invalid_pointer');
					store.put(result, this.key);
				} catch { transaction.abort(); }
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(new Error('Managed-assets pointer update failed.'));
			transaction.onabort = () => reject(new Error('Managed-assets pointer update was aborted.'));
			}));
			if (result === null) attempt.skip('validation_failed');
			else attempt.success();
			return result;
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			throw error;
		}
	}

	close(): void {
		const attempt = this.diagnostics.begin('managed_assets_pointer', 'close');
		this.connection.close();
		attempt.success();
	}

	/** One transaction on the cached connection, replacing a dead one once (DU-05); a second dead one is this call's failure. */
	private async run<T>(operation: (database: IDBDatabase) => Promise<T>): Promise<T> {
		try {
			return await this.connection.run(operation);
		} catch (error) {
			throw isIndexedDbUnavailable(error) ? new Error('Managed-assets pointer is unavailable.') : error;
		}
	}
}

export class MemoryManagedAssetsPointerStore implements ManagedAssetsPointerStore {
	private value: ManagedAssetsPointerState = structuredClone(EMPTY_MANAGED_ASSETS_POINTER);
	private queue = Promise.resolve();
	async read(): Promise<ManagedAssetsPointerState> { await this.queue; return structuredClone(this.value); }
	async compareAndSet(expected: ManagedAssetsPointerState, next: Omit<ManagedAssetsPointerState, 'schemaVersion' | 'generation'>): Promise<ManagedAssetsPointerState | null> {
		let result: ManagedAssetsPointerState | null = null;
		this.queue = this.queue.then(() => {
			if (!samePointer(this.value, expected)) return;
			result = { ...next, schemaVersion: 1, generation: this.value.generation + 1 } as ManagedAssetsPointerState;
			this.value = structuredClone(result);
		});
		await this.queue;
		return structuredClone(result);
	}
	close(): void {}
}

function parsePointer(value: unknown): ManagedAssetsPointerState {
	if (value === undefined) return structuredClone(EMPTY_MANAGED_ASSETS_POINTER);
	if (!isPointer(value)) throw new Error('Managed-assets pointer is corrupt.');
	return structuredClone(value);
}
function isPointer(value: unknown): value is ManagedAssetsPointerState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 5 || !['schemaVersion', 'generation', 'status', 'root', 'targetRoot'].every((key) => Object.prototype.hasOwnProperty.call(record, key))) return false;
	if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.generation) || Number(record.generation) < 0) return false;
	if (!['ready', 'installing', 'removing', 'moving'].includes(String(record.status))) return false;
	if (record.status === 'ready') return (record.root === null || nonEmpty(record.root)) && record.targetRoot === null;
	if (record.status === 'installing') return record.root === null && nonEmpty(record.targetRoot);
	if (record.status === 'removing') return nonEmpty(record.root) && record.targetRoot === null;
	return nonEmpty(record.root) && nonEmpty(record.targetRoot) && record.root !== record.targetRoot;
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function samePointer(a: ManagedAssetsPointerState, b: ManagedAssetsPointerState): boolean { return JSON.stringify(a) === JSON.stringify(b); }
async function requestTransaction<T>(database: IDBDatabase, mode: IDBTransactionMode, request: (store: IDBObjectStore) => IDBRequest, map: (value: unknown) => T): Promise<T> {
	return await new Promise((resolve, reject) => {
		const transaction = startIndexedDbTransaction(database, STORE, mode); const operation = request(transaction.objectStore(STORE)); let result: T;
		operation.onsuccess = () => { try { result = map(operation.result as unknown); } catch { transaction.abort(); } };
		transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(new Error('Managed-assets pointer read failed.')); transaction.onabort = () => reject(new Error('Managed-assets pointer read was aborted.'));
	});
}
