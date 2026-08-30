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
	type InventoryPreferencesWriteResult,
} from './inventory-preferences-model';
import { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';

/** Lets composition classify read and write persistence under their real actions. */
export interface InventoryPreferencesPersistenceDiagnostics {
	read: LocalDebugPersistenceProbe;
	write: LocalDebugPersistenceProbe;
	lifecycle?: LocalDebugPersistenceProbe;
}

/** Dedicated, explicit-use IndexedDB adapter for inventory preference intent. */
export class IndexedDbInventoryPreferencesStore implements InventoryPreferencesStore {
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
			const database = await this.open(this.readDiagnostics, actionContext);
			const result: InventoryPreferencesReadResult = await this.transaction<InventoryPreferencesReadResult>(database, 'readwrite', scope, (store, key, raw) => {
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
			const database = await this.open(this.writeDiagnostics, actionContext);
			const result: InventoryPreferencesWriteResult = await this.transaction<InventoryPreferencesWriteResult>(database, 'readwrite', scope, (store, key, raw) => {
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
		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			let settled = false;
			const request = this.factory.open(this.databaseName, INVENTORY_PREFERENCES_DB_VERSION);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(INVENTORY_PREFERENCES_STORE_NAME)) {
					request.result.createObjectStore(INVENTORY_PREFERENCES_STORE_NAME);
				}
			};
			request.onerror = () => rejectOnce(request.error?.name === 'VersionError' ? 'future_schema' : 'unavailable');
			request.onblocked = () => rejectOnce('unavailable');
			request.onsuccess = () => {
				const database = request.result;
				if (settled || this.disposed || !database.objectStoreNames.contains(INVENTORY_PREFERENCES_STORE_NAME)) {
					database.close();
					rejectOnce(this.disposed ? 'unavailable' : 'corrupt');
					return;
				}
				settled = true;
				database.onversionchange = () => {
					database.close();
					if (this.database === database) this.database = null;
					this.disposed = true;
				};
				this.database = database;
				attempt.success();
				resolve(database);
			};
			function rejectOnce(code: InventoryPreferencesFailureCode): void {
				if (settled) return;
				settled = true;
				attempt.failure(code === 'corrupt' || code === 'future_schema' ? 'validation_failed' : 'storage_failure');
				reject(new StorageFailure(code));
			}
		});
		this.opening = opening;
		try {
			return await opening;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}

	private async transaction<T>(
		database: IDBDatabase,
		mode: IDBTransactionMode,
		scope: InventoryPreferenceScope,
		mutator: (store: IDBObjectStore, key: string, raw: unknown) => T,
	): Promise<T> {
		return await new Promise<T>((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = database.transaction(INVENTORY_PREFERENCES_STORE_NAME, mode);
			} catch {
				reject(new StorageFailure('unavailable'));
				return;
			}
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
