import { LocalDebugPersistenceProbe } from '../core/local-debug-persistence';

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

export class IndexedDbManagedAssetsPointerStore implements ManagedAssetsPointerStore {
	private database: IDBDatabase | null = null;
	private opening: Promise<IDBDatabase> | null = null;
	private closed = false;
	private readonly key: string;
	constructor(
		private readonly factory: IDBFactory,
		vaultId: string,
		private readonly databaseName = MANAGED_ASSETS_POINTER_DB,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {
		if (!/^[a-f0-9]{64}$/u.test(vaultId)) throw new Error('Managed-assets vault identity is invalid.');
		this.key = `managed-assets-pointer:${vaultId}`;
	}

	async read(): Promise<ManagedAssetsPointerState> {
		const attempt = this.diagnostics.begin('managed_assets_pointer', 'read');
		try {
			const database = await this.open();
			const result = await requestTransaction(database, 'readonly', (store) => store.get(this.key), (value) => parsePointer(value));
			attempt.success();
			return result;
		} catch (error) {
			attempt.failure('storage_failure');
			throw error;
		}
	}

	async compareAndSet(expected: ManagedAssetsPointerState, next: Omit<ManagedAssetsPointerState, 'schemaVersion' | 'generation'>): Promise<ManagedAssetsPointerState | null> {
		const attempt = this.diagnostics.begin('managed_assets_pointer', 'write');
		try {
			const database = await this.open();
			const result = await new Promise<ManagedAssetsPointerState | null>((resolve, reject) => {
			const transaction = database.transaction(STORE, 'readwrite');
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
			});
			if (result === null) attempt.skip('validation_failed');
			else attempt.success();
			return result;
		} catch (error) {
			attempt.failure('storage_failure');
			throw error;
		}
	}

	close(): void {
		const attempt = this.diagnostics.begin('managed_assets_pointer', 'close');
		this.closed = true;
		this.database?.close();
		this.database = null;
		attempt.success();
	}
	private async open(): Promise<IDBDatabase> {
		if (this.closed) throw new Error('Managed-assets pointer is closed.');
		if (this.database) return this.database;
		if (this.opening) return this.opening;
		const attempt = this.diagnostics.begin('managed_assets_pointer', 'open');
		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			const request = this.factory.open(this.databaseName, 1);
			let settled = false;
			request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
			request.onerror = () => fail(); request.onblocked = () => fail();
			request.onsuccess = () => {
				if (settled || this.closed) { request.result.close(); if (!settled) fail(); return; }
				settled = true; this.database = request.result;
				request.result.onversionchange = () => { request.result.close(); this.database = null; this.closed = true; };
				attempt.success();
				resolve(request.result);
			};
			const fail = () => {
				if (!settled) {
					attempt.failure('storage_failure');
					reject(new Error('Managed-assets pointer could not be opened.'));
				}
				settled = true;
			};
		});
		this.opening = opening;
		try { return await opening; } finally { if (this.opening === opening) this.opening = null; }
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
		const transaction = database.transaction(STORE, mode); const operation = request(transaction.objectStore(STORE)); let result: T;
		operation.onsuccess = () => { try { result = map(operation.result as unknown); } catch { transaction.abort(); } };
		transaction.oncomplete = () => resolve(result); transaction.onerror = () => reject(new Error('Managed-assets pointer read failed.')); transaction.onabort = () => reject(new Error('Managed-assets pointer read was aborted.'));
	});
}
