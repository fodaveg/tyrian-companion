import {
	cloneInventoryPreferences,
	exactInventoryPreferences,
	isFutureInventoryPreferences,
	isInventoryPreferenceScope,
	isInventoryPreferences,
	migrateInventoryPreferences,
	sameInventoryPreferenceContent,
} from './inventory-preferences-contract';
import {
	INVENTORY_PREFERENCES_DB_NAME,
	INVENTORY_PREFERENCES_DB_VERSION,
	INVENTORY_PREFERENCES_STORE_NAME,
	type InventoryPreferenceScope,
	type InventoryPreferencesActionContext,
	type InventoryPreferencesFailureCode,
	type InventoryPreferencesReadResult,
	type InventoryPreferencesStore,
	type InventoryPreferencesV1,
	type InventoryPreferencesVaultReadResult,
	type InventoryPreferencesVaultRestoreResult,
	type InventoryPreferencesVaultStore,
	type InventoryPreferencesWriteResult,
} from './inventory-preferences-model';
import {
	IndexedDbConnectionLostError,
	openIndexedDb,
	startIndexedDbTransaction,
	withIndexedDbReopen,
} from '../core/indexed-db-open';
import { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';

/** Lets composition classify read and write persistence under their real actions. */
export interface InventoryPreferencesPersistenceDiagnostics {
	read: LocalDebugPersistenceProbe;
	write: LocalDebugPersistenceProbe;
	lifecycle?: LocalDebugPersistenceProbe;
}

/** Dedicated, explicit-use IndexedDB adapter for inventory preference intent. */
export class IndexedDbInventoryPreferencesStore implements InventoryPreferencesStore, InventoryPreferencesVaultStore {
	private database: IDBDatabase | null = null;
	private opening: Promise<IDBDatabase> | null = null;
	private disposed = false;
	private readonly readDiagnostics: LocalDebugPersistenceProbe;
	private readonly writeDiagnostics: LocalDebugPersistenceProbe;
	private readonly lifecycleDiagnostics: LocalDebugPersistenceProbe;

	constructor(
		private readonly factory: IDBFactory,
		private readonly databaseName = INVENTORY_PREFERENCES_DB_NAME,
		diagnostics: LocalDebugPersistenceProbe | InventoryPreferencesPersistenceDiagnostics = new LocalDebugPersistenceProbe(),
	) {
		if ('begin' in diagnostics) {
			this.readDiagnostics = diagnostics;
			this.writeDiagnostics = diagnostics;
			this.lifecycleDiagnostics = diagnostics;
		} else {
			this.readDiagnostics = diagnostics.read;
			this.writeDiagnostics = diagnostics.write;
			this.lifecycleDiagnostics = diagnostics.lifecycle ?? new LocalDebugPersistenceProbe();
		}
	}

	async read(
		scope: InventoryPreferenceScope,
		actionContext?: InventoryPreferencesActionContext,
	): Promise<InventoryPreferencesReadResult> {
		const attempt = this.readDiagnostics.begin('inventory_preferences', 'read', actionContext);
		if (!isInventoryPreferenceScope(scope)) {
			attempt.failure('validation_failed');
			return { status: 'error', code: 'corrupt' };
		}
		try {
			const result: InventoryPreferencesReadResult = await this.transaction<InventoryPreferencesReadResult>(this.readDiagnostics, actionContext, 'readwrite', scope, (store, key, raw) => {
				const parsed = parseRecord(raw, scope);
				if (parsed.status === 'error') return parsed;
				const copied = parsed.record === null ? null : cloneInventoryPreferences(parsed.record);
				if (parsed.record !== null && copied === null) return { status: 'error', code: 'corrupt' };
				if (parsed.migrated && copied !== null) store.put(copied, key);
				return { status: 'ok', record: copied };
			});
			if (result.status === 'error') attempt.failure(preferenceFailureCode(result.code));
			else attempt.success();
			return result;
		} catch (error) {
			const code = failure(error);
			attempt.failure(preferenceFailureCode(code));
			return { status: 'error', code };
		}
	}

	async compareAndSwap(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		next: InventoryPreferencesV1,
		actionContext?: InventoryPreferencesActionContext,
	): Promise<InventoryPreferencesWriteResult> {
		const attempt = this.writeDiagnostics.begin('inventory_preferences', 'write', actionContext);
		if (!isInventoryPreferenceScope(scope) || !validGeneration(expectedGeneration) || !isInventoryPreferences(next)
			|| next.vaultId !== scope.vaultId || next.accountId !== scope.accountId) {
			attempt.failure('validation_failed');
			return { status: 'error', code: 'corrupt' };
		}
		try {
			const result: InventoryPreferencesWriteResult = await this.transaction<InventoryPreferencesWriteResult>(this.writeDiagnostics, actionContext, 'readwrite', scope, (store, key, raw) => {
				const parsed = parseRecord(raw, scope);
				if (parsed.status === 'error') return parsed;
				const current = parsed.record;
				const currentGeneration = current?.generation ?? 0;
				if (currentGeneration !== expectedGeneration) return { status: 'conflict', generation: currentGeneration };
				const noChange = current !== null && sameInventoryPreferenceContent(current, next);
				if (noChange) {
					const copied = cloneInventoryPreferences(current);
					if (copied === null) return { status: 'error', code: 'corrupt' };
					if (next.generation !== currentGeneration || !exactInventoryPreferences(current, next)) {
						return { status: 'saved', record: copied };
					}
					return { status: 'saved', record: copied };
				}
				if (next.generation !== expectedGeneration + 1) {
					return { status: 'error', code: 'corrupt' };
				}
				const copied = cloneInventoryPreferences(next);
				if (copied === null) return { status: 'error', code: 'corrupt' };
				store.put(copied, key);
				return { status: 'saved', record: copied };
			});
			if (result.status === 'error') attempt.failure(preferenceFailureCode(result.code));
			else if (result.status === 'conflict') attempt.skip('validation_failed');
			else attempt.success();
			return result;
		} catch (error) {
			const code = failure(error);
			attempt.failure(preferenceFailureCode(code));
			return { status: 'error', code };
		}
	}

	/**
	 * DU-13: every record of one vault this release can read, for the copy kept in the host's settings. A record it cannot
	 * read (corrupt, or written by a newer release) is left out and counted in `unreadable`; it stays in IndexedDB as it is.
	 */
	async readVault(vaultId: string): Promise<InventoryPreferencesVaultReadResult> {
		const attempt = this.readDiagnostics.begin('inventory_preferences', 'read');
		try {
			const stored = await this.onStore<{ keys: IDBValidKey[]; values: unknown[] }>(this.readDiagnostics, 'readonly', (store, done) => {
				const keys = store.getAllKeys();
				const values = store.getAll();
				// Both lists come back in key order, from the same transaction.
				values.onsuccess = () => { done({ keys: keys.result, values: values.result as unknown[] }); };
			});
			const records: InventoryPreferencesV1[] = [];
			let unreadable = 0;
			stored.keys.forEach((key, index) => {
				if (!inVault(key, vaultId)) return;
				const record = migrateInventoryPreferences(stored.values[index]);
				if (record === null || record.vaultId !== vaultId || storageKey(record) !== key) unreadable += 1;
				else records.push(record);
			});
			attempt.success();
			return { status: 'ok', records, unreadable };
		} catch (error) {
			const code = failure(error);
			attempt.failure(preferenceFailureCode(code));
			return { status: 'error', code };
		}
	}

	/**
	 * DU-13: writes `records` only when the vault has no record at all, checked and written in one transaction, so a record
	 * saved meanwhile is never overwritten. Every record must be valid and belong to `vaultId`.
	 */
	async restoreVaultIfEmpty(vaultId: string, records: readonly InventoryPreferencesV1[]): Promise<InventoryPreferencesVaultRestoreResult> {
		const attempt = this.writeDiagnostics.begin('inventory_preferences', 'write');
		const copies = records.map(cloneInventoryPreferences);
		if (copies.some((record) => record === null || record.vaultId !== vaultId)
			|| new Set(copies.map((record) => record?.accountId)).size !== copies.length) {
			attempt.failure('validation_failed');
			return { status: 'error', code: 'corrupt' };
		}
		try {
			const result = await this.onStore<InventoryPreferencesVaultRestoreResult>(this.writeDiagnostics, 'readwrite', (store, done) => {
				const keys = store.getAllKeys();
				keys.onsuccess = () => {
					if (keys.result.some((key) => inVault(key, vaultId))) {
						done({ status: 'not_empty' });
						return;
					}
					for (const record of copies as InventoryPreferencesV1[]) store.put(record, storageKey(record));
					done({ status: 'restored', count: copies.length });
				};
			});
			attempt.success();
			return result;
		} catch (error) {
			const code = failure(error);
			attempt.failure(preferenceFailureCode(code));
			return { status: 'error', code };
		}
	}

	dispose(): void {
		const attempt = this.lifecycleDiagnostics.begin('inventory_preferences', 'close');
		this.disposed = true;
		this.database?.close();
		this.database = null;
		attempt.success();
	}

	private async open(
		diagnostics: LocalDebugPersistenceProbe,
		actionContext?: InventoryPreferencesActionContext,
	): Promise<IDBDatabase> {
		if (this.disposed) throw new StorageFailure('unavailable');
		if (this.database) return this.database;
		if (this.opening) return this.opening;
		const attempt = diagnostics.begin('inventory_preferences', 'open', actionContext);
		const opening = openIndexedDb({
			factory: this.factory,
			databaseName: this.databaseName,
			databaseVersion: INVENTORY_PREFERENCES_DB_VERSION,
			schema: [{ name: INVENTORY_PREFERENCES_STORE_NAME }],
			// A database that opened without the store is corrupt, not merely
			// unavailable, and the two codes reach the caller differently.
			accept: (database) => !this.disposed
				&& database.objectStoreNames.contains(INVENTORY_PREFERENCES_STORE_NAME),
			onVersionChange: (database, kind) => {
				if (this.database === database) this.database = null;
				// Only a real upgrade is final: opening again would answer `future_schema` every time.
				// Anything else leaves the next read or write free to open a new connection.
				if (kind === 'upgrade') this.disposed = true;
			},
			onClose: (database) => { this.discard(database); },
			toError: (reason, error) => new StorageFailure(reason === 'refused'
				? (this.disposed ? 'unavailable' : 'corrupt')
				: reason === 'error' && error?.name === 'VersionError' ? 'future_schema' : 'unavailable'),
		});
		this.opening = opening;
		try {
			const database = await opening;
			this.database = database;
			attempt.success();
			return database;
		} catch (error) {
			attempt.failure(preferenceFailureCode(error instanceof StorageFailure ? error.code : 'unavailable'));
			throw error;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}

	/** Forgets a connection the engine closed or that no longer starts transactions; the next `open()` opens anew. */
	private discard(database: IDBDatabase): void {
		if (this.database === database) this.database = null;
		try { database.close(); } catch { /* Already gone, which is the reason it is being dropped. */ }
	}

	/**
	 * One transaction on the cached connection. A connection that died underneath is dropped and the
	 * transaction runs once more on a new one (one reopen per operation); the mutator has not run
	 * yet when that happens, so nothing is applied twice.
	 */
	private async transaction<T>(
		diagnostics: LocalDebugPersistenceProbe,
		actionContext: InventoryPreferencesActionContext | undefined,
		mode: IDBTransactionMode,
		scope: InventoryPreferenceScope,
		mutator: (store: IDBObjectStore, key: string, raw: unknown) => T,
	): Promise<T> {
		try {
			return await withIndexedDbReopen({
				open: async () => await this.open(diagnostics, actionContext),
				discard: (database) => { this.discard(database); },
			}, async (database) => await this.transact(database, mode, scope, mutator));
		} catch (error) {
			throw error instanceof IndexedDbConnectionLostError ? new StorageFailure('unavailable') : error;
		}
	}

	/**
	 * One transaction over the whole store, not one key (DU-13's vault-wide read and restore), with the same single reopen
	 * as `transaction`. `body` issues its requests and hands its answer to `done`; it is what the transaction resolves with
	 * once it commits.
	 */
	private async onStore<T>(
		diagnostics: LocalDebugPersistenceProbe,
		mode: IDBTransactionMode,
		body: (store: IDBObjectStore, done: (value: T) => void) => void,
	): Promise<T> {
		try {
			return await withIndexedDbReopen({
				open: async () => await this.open(diagnostics),
				discard: (database) => { this.discard(database); },
			}, async (database) => await new Promise<T>((resolve, reject) => {
				// A throw here rejects this promise: the executor runs synchronously inside it.
				const transaction = startIndexedDbTransaction(database, INVENTORY_PREFERENCES_STORE_NAME, mode);
				let result: T | undefined;
				body(transaction.objectStore(INVENTORY_PREFERENCES_STORE_NAME), (value) => { result = value; });
				transaction.oncomplete = () => resolve(result as T);
				transaction.onerror = () => reject(new StorageFailure('unavailable'));
				transaction.onabort = () => reject(new StorageFailure('unavailable'));
			}));
		} catch (error) {
			throw error instanceof IndexedDbConnectionLostError ? new StorageFailure('unavailable') : error;
		}
	}

	private async transact<T>(
		database: IDBDatabase,
		mode: IDBTransactionMode,
		scope: InventoryPreferenceScope,
		mutator: (store: IDBObjectStore, key: string, raw: unknown) => T,
	): Promise<T> {
		return await new Promise<T>((resolve, reject) => {
			// A throw here rejects this promise: the executor runs synchronously inside it.
			const transaction = startIndexedDbTransaction(database, INVENTORY_PREFERENCES_STORE_NAME, mode);
			const store = transaction.objectStore(INVENTORY_PREFERENCES_STORE_NAME);
			const request = store.get(storageKey(scope));
			let result: T | undefined;
			let failed = false;
			request.onsuccess = () => {
				try {
					result = mutator(store, storageKey(scope), request.result as unknown);
				} catch {
					failed = true;
					transaction.abort();
				}
			};
			transaction.oncomplete = () => resolve(result as T);
			transaction.onerror = () => reject(new StorageFailure(failed ? 'corrupt' : 'unavailable'));
			transaction.onabort = () => reject(new StorageFailure(failed ? 'corrupt' : 'unavailable'));
		});
	}
}

/** Whether a key of this store belongs to `vaultId` (`<vaultId>\0<accountId>`), never to a vault whose id only starts the same. */
function inVault(key: IDBValidKey, vaultId: string): key is string {
	return typeof key === 'string' && key.startsWith(`${vaultId}\u0000`);
}

function parseRecord(raw: unknown, scope: InventoryPreferenceScope):
	| { status: 'ok'; record: InventoryPreferencesV1 | null; migrated: boolean }
	| { status: 'error'; code: InventoryPreferencesFailureCode } {
	if (raw === undefined) return { status: 'ok', record: null, migrated: false };
	if (isFutureInventoryPreferences(raw)) return { status: 'error', code: 'future_schema' };
	const record = migrateInventoryPreferences(raw);
	if (!record || record.vaultId !== scope.vaultId || record.accountId !== scope.accountId) {
		return { status: 'error', code: 'corrupt' };
	}
	return { status: 'ok', record, migrated: (raw as { schemaVersion?: unknown }).schemaVersion === 0 };
}

function storageKey(scope: InventoryPreferenceScope): string {
	return `${scope.vaultId}\u0000${scope.accountId}`;
}

function validGeneration(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function failure(error: unknown): InventoryPreferencesFailureCode {
	return error instanceof StorageFailure ? error.code : 'unavailable';
}

class StorageFailure extends Error {
	constructor(readonly code: InventoryPreferencesFailureCode) {
		super(code);
	}
}

function preferenceFailureCode(code: InventoryPreferencesFailureCode): 'validation_failed' | 'storage_failure' {
	return code === 'corrupt' || code === 'future_schema' ? 'validation_failed' : 'storage_failure';
}
