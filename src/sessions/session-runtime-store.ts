import { compareStorageSnapshots, isComparableStorageSnapshot } from '../account/storage-delta';
import type { StorageDelta } from '../account/storage-delta-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { isSessionState } from './session-state-machine';
import {
	isSessionContaminationReview,
	type SessionContaminationReview,
} from './session-contamination-review';
import type {
	CompleteSessionState,
	ErrorSessionState,
	RecoverableSessionState,
	SessionAuthority,
	SessionSnapshotReference,
	SessionState,
} from './session';

export const SESSION_RUNTIME_VERSION = 2 as const;
export const SESSION_RUNTIME_DB_NAME = 'tyrian-companion-session-runtime';
export const SESSION_RUNTIME_DB_VERSION = 1;
export const SESSION_RUNTIME_STORE_NAME = 'active-session-v1';
const RUNTIME_KEY = 'active-session';

export type PersistedSessionState =
	| RecoverableSessionState
	| CompleteSessionState
	| (Omit<ErrorSessionState, 'failedState'> & { failedState: RecoverableSessionState });

export interface SessionRuntimeRecord {
	version: typeof SESSION_RUNTIME_VERSION;
	state: PersistedSessionState;
	baselineSnapshot: StorageSnapshot;
	finalSnapshot: StorageSnapshot | null;
	delta: StorageDelta | null;
	review: SessionContaminationReview | null;
	persistedAt: number;
}

export type SessionRuntimeLoadResult =
	| { status: 'empty' }
	| { status: 'loaded'; record: SessionRuntimeRecord }
	| { status: 'error'; code: 'corrupt' | 'unavailable' };

export type SessionRuntimeMutationResult =
	| { status: 'saved' | 'cleared' }
	| { status: 'stale' }
	| { status: 'error'; code: 'corrupt' | 'unavailable' };

export interface SessionRuntimeStore {
	load(): Promise<SessionRuntimeLoadResult>;
	save(record: SessionRuntimeRecord): Promise<SessionRuntimeMutationResult>;
	clear(authority: SessionAuthority): Promise<SessionRuntimeMutationResult>;
	close(): void;
}

/** Deterministic test adapter. Production must use IndexedDbSessionRuntimeStore. */
export class MemorySessionRuntimeStore implements SessionRuntimeStore {
	private value: unknown;

	constructor(initial?: unknown) {
		this.value = initial === undefined ? undefined : structuredClone(initial);
	}

	async load(): Promise<SessionRuntimeLoadResult> {
		if (this.value === undefined) return { status: 'empty' };
		const record = normalizeSessionRuntimeRecord(this.value);
		if (!record) return { status: 'error', code: 'corrupt' };
		this.value = structuredClone(record);
		return { status: 'loaded', record };
	}

	async save(record: SessionRuntimeRecord): Promise<SessionRuntimeMutationResult> {
		if (!isSessionRuntimeRecord(record)) return { status: 'error', code: 'corrupt' };
		if (this.value !== undefined) {
			const current = normalizeSessionRuntimeRecord(this.value);
			if (!current) return { status: 'error', code: 'corrupt' };
			if (!canReplace(current, record)) return { status: 'stale' };
		}
		this.value = structuredClone(record);
		return { status: 'saved' };
	}

	async clear(authority: SessionAuthority): Promise<SessionRuntimeMutationResult> {
		if (this.value === undefined) return { status: 'cleared' };
		const current = normalizeSessionRuntimeRecord(this.value);
		if (!current) return { status: 'error', code: 'corrupt' };
		if (!canWriteAuthority(runtimeAuthority(current.state), authority)) return { status: 'stale' };
		this.value = undefined;
		return { status: 'cleared' };
	}

	close(): void {}
}

/** Machine-local, fail-closed persistence. It never falls back to vault files or memory. */
export class IndexedDbSessionRuntimeStore implements SessionRuntimeStore {
	private database: IDBDatabase | null = null;
	private opening: Promise<IDBDatabase> | null = null;
	private unavailable = false;

	constructor(
		private readonly factory: IDBFactory,
		private readonly databaseName = SESSION_RUNTIME_DB_NAME,
	) {}

	async load(): Promise<SessionRuntimeLoadResult> {
		try {
			const value = await this.read();
			if (value === undefined) return { status: 'empty' };
			const record = normalizeSessionRuntimeRecord(value);
			if (!record) return { status: 'error', code: 'corrupt' };
			return { status: 'loaded', record };
		} catch {
			return { status: 'error', code: 'unavailable' };
		}
	}

	async save(record: SessionRuntimeRecord): Promise<SessionRuntimeMutationResult> {
		if (!isSessionRuntimeRecord(record)) return { status: 'error', code: 'corrupt' };
		try {
			return await this.mutate<SessionRuntimeMutationResult>((value) => {
				const current = value === undefined ? null : normalizeSessionRuntimeRecord(value);
				if (value !== undefined && !current) return { result: { status: 'error', code: 'corrupt' } as const };
				if (current && !canReplace(current, record)) {
					return { result: { status: 'stale' } as const };
				}
				return {
					result: { status: 'saved' } as const,
					next: structuredClone(record),
				};
			});
		} catch {
			return { status: 'error', code: 'unavailable' };
		}
	}

	async clear(authority: SessionAuthority): Promise<SessionRuntimeMutationResult> {
		try {
			return await this.mutate<SessionRuntimeMutationResult>((value) => {
				if (value === undefined) return { result: { status: 'cleared' } as const, remove: true };
				const current = normalizeSessionRuntimeRecord(value);
				if (!current) return { result: { status: 'error', code: 'corrupt' } as const };
				if (!canWriteAuthority(runtimeAuthority(current.state), authority)) {
					return { result: { status: 'stale' } as const };
				}
				return { result: { status: 'cleared' } as const, remove: true };
			});
		} catch {
			return { status: 'error', code: 'unavailable' };
		}
	}

	close(): void {
		this.unavailable = true;
		this.database?.close();
		this.database = null;
	}

	private async open(): Promise<IDBDatabase> {
		if (this.unavailable) throw new Error('Session recovery storage is unavailable.');
		if (this.database) return this.database;
		if (this.opening) return this.opening;
		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			const request = this.factory.open(this.databaseName, SESSION_RUNTIME_DB_VERSION);
			let settled = false;
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(SESSION_RUNTIME_STORE_NAME)) {
					request.result.createObjectStore(SESSION_RUNTIME_STORE_NAME);
				}
			};
			request.onerror = () => fail('Could not open session recovery storage.');
			request.onblocked = () => fail('Session recovery storage upgrade was blocked.');
			request.onsuccess = () => {
				if (settled || this.unavailable) {
					request.result.close();
					return;
				}
				settled = true;
				const database = request.result;
				database.onversionchange = () => {
					database.close();
					if (this.database === database) this.database = null;
					this.unavailable = true;
				};
				this.database = database;
				resolve(database);
			};

			function fail(message: string): void {
				if (!settled) reject(new Error(message));
				settled = true;
			}
		});
		this.opening = opening;
		try {
			return await opening;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}

	private async read(): Promise<unknown> {
		const database = await this.open();
		return await new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readonly');
			} catch {
				reject(new Error('Session recovery storage is unavailable.'));
				return;
			}
			const request = transaction.objectStore(SESSION_RUNTIME_STORE_NAME).get(RUNTIME_KEY);
			let value: unknown;
			request.onsuccess = () => { value = request.result as unknown; };
			transaction.oncomplete = () => resolve(value);
			transaction.onerror = () => reject(new Error('Could not read session recovery storage.'));
			transaction.onabort = () => reject(new Error('Session recovery read was aborted.'));
		});
	}

	private async mutate<T extends SessionRuntimeMutationResult>(
		mutator: (current: unknown) => { result: T; next?: SessionRuntimeRecord; remove?: boolean },
	): Promise<T> {
		const database = await this.open();
		return await new Promise((resolve, reject) => {
			let transaction: IDBTransaction;
			try {
				transaction = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
			} catch {
				reject(new Error('Session recovery storage is unavailable.'));
				return;
			}
			const store = transaction.objectStore(SESSION_RUNTIME_STORE_NAME);
			const request = store.get(RUNTIME_KEY);
			let result: T;
			let mutationFailed = false;
			request.onsuccess = () => {
				try {
					const mutation = mutator(request.result as unknown);
					result = mutation.result;
					if (mutation.remove) store.delete(RUNTIME_KEY);
					else if (mutation.next) store.put(mutation.next, RUNTIME_KEY);
				} catch {
					mutationFailed = true;
					transaction.abort();
				}
			};
			transaction.oncomplete = () => resolve(result);
			transaction.onerror = () => reject(new Error('Could not update session recovery storage.'));
			transaction.onabort = () => reject(new Error(
				mutationFailed ? 'Session recovery mutation failed.' : 'Session recovery update was aborted.',
			));
		});
	}
}

export function createSessionRuntimeRecord(
	state: SessionState,
	baselineSnapshot: StorageSnapshot,
	finalSnapshot: StorageSnapshot | null,
	delta: StorageDelta | null,
	persistedAt: number,
	review: SessionContaminationReview | null = null,
): SessionRuntimeRecord | null {
	const candidate = {
		version: SESSION_RUNTIME_VERSION,
		state: structuredClone(state),
		baselineSnapshot: structuredClone(baselineSnapshot),
		finalSnapshot: finalSnapshot === null ? null : structuredClone(finalSnapshot),
		delta: delta === null ? null : structuredClone(delta),
		review: review === null ? null : structuredClone(review),
		persistedAt,
	};
	return isSessionRuntimeRecord(candidate) ? candidate : null;
}

export function isSessionRuntimeRecord(value: unknown): value is SessionRuntimeRecord {
	return isSessionRuntimeRecordV2(value);
}

function isSessionRuntimeRecordV2(value: unknown): value is SessionRuntimeRecord {
	if (!isJsonValue(value) || !isRecord(value) || !exactKeys(value, [
		'version',
		'state',
		'baselineSnapshot',
		'finalSnapshot',
		'delta',
		'review',
		'persistedAt',
	])) return false;
	if (
		value.version !== SESSION_RUNTIME_VERSION
		|| !Number.isSafeInteger(value.persistedAt)
		|| (value.persistedAt as number) < 0
		|| !isSessionState(value.state)
		|| !isPersistableState(value.state)
		|| !isComparableStorageSnapshot(value.baselineSnapshot)
		|| !hasPassEnvelope(value.baselineSnapshot)
	) return false;
	const state = value.state;
	const evidenceState = state.status === 'error' ? state.failedState : state;
	if (!sameSnapshotReference(evidenceState.baseline, value.baselineSnapshot)) return false;
	if (evidenceState.status !== 'provisional' && evidenceState.status !== 'complete') {
		return value.finalSnapshot === null && value.delta === null && value.review === null;
	}
	if (!isComparableStorageSnapshot(value.finalSnapshot)
		|| !hasPassEnvelope(value.finalSnapshot)
		|| !sameSnapshotReference(
			evidenceState.finalSnapshot,
			value.finalSnapshot,
	)) return false;
	const calculated = compareStorageSnapshots(value.baselineSnapshot, value.finalSnapshot);
	if (calculated.status === 'invalid'
		|| !isRecord(value.delta)
		|| JSON.stringify(calculated) !== JSON.stringify(value.delta)) return false;
	if (value.review !== null && !isSessionContaminationReview(
		value.review,
		value.baselineSnapshot,
		value.finalSnapshot,
		calculated,
	)) return false;
	if (evidenceState.status === 'complete') {
		return value.review !== null
			&& value.review.classification.permissions.finalize
			&& value.review.classification.status === evidenceState.classification;
	}
	return true;
}

export function recoverableState(state: PersistedSessionState): RecoverableSessionState {
	if (state.status === 'complete') throw new Error('A complete session is not recoverable.');
	return state.status === 'error' ? state.failedState : state;
}

export function runtimeAuthority(state: PersistedSessionState): SessionAuthority {
	return state.status === 'complete' ? state.authority : recoverableState(state).authority;
}

function isPersistableState(state: SessionState): state is PersistedSessionState {
	if (state.status === 'active' || state.status === 'stopping' || state.status === 'provisional' || state.status === 'complete') return true;
	return state.status === 'error'
		&& (state.failedState.status === 'active'
			|| state.failedState.status === 'stopping'
			|| state.failedState.status === 'provisional');
}

function canReplace(current: SessionRuntimeRecord, next: SessionRuntimeRecord): boolean {
	const currentAuthority = runtimeAuthority(current.state);
	const nextAuthority = runtimeAuthority(next.state);
	if (!canWriteAuthority(currentAuthority, nextAuthority)) return false;
	if (nextAuthority.fence > currentAuthority.fence) {
		return JSON.stringify(recordEvidence(current)) === JSON.stringify(recordEvidence(next));
	}
	const currentBase = current.state.status === 'error' ? current.state.failedState : current.state;
	const nextBase = next.state.status === 'error' ? next.state.failedState : next.state;
	const currentRank = stateRank(currentBase);
	const nextRank = stateRank(nextBase);
	if (nextRank < currentRank) return false;
	if (nextRank > currentRank) return current.state.status !== 'error';
	if (current.state.status === 'error') return JSON.stringify(current) === JSON.stringify(next);
	if (next.state.status === 'error') {
		return JSON.stringify(next.state.failedState) === JSON.stringify(current.state)
			&& JSON.stringify(next.review) === JSON.stringify(current.review);
	}
	if (JSON.stringify(next.state) !== JSON.stringify(current.state)) return false;
	if (current.review === null || JSON.stringify(next.review) === JSON.stringify(current.review)) return true;
	return current.state.status === 'provisional'
		&& next.state.status === 'provisional'
		&& next.review !== null
		&& next.persistedAt >= current.persistedAt
		&& Date.parse(next.review.reviewedAt) > Date.parse(current.review.reviewedAt);
}

function canWriteAuthority(current: SessionAuthority, next: SessionAuthority): boolean {
	if (current.machineId !== next.machineId || current.sessionId !== next.sessionId) return false;
	if (next.fence > current.fence) return true;
	return next.fence === current.fence
		&& next.instanceId === current.instanceId
		&& next.acquiredAt === current.acquiredAt;
}

function sameSnapshotReference(reference: SessionSnapshotReference, snapshot: StorageSnapshot): boolean {
	return reference.snapshotId === snapshot.snapshotId
		&& reference.accountId === snapshot.accountId
		&& reference.schemaVersion === snapshot.schemaVersion
		&& reference.startedAt === snapshot.startedAt
		&& reference.completedAt === snapshot.completedAt
		&& reference.quality === snapshot.quality;
}

function recordEvidence(record: SessionRuntimeRecord): object {
	const state = record.state.status === 'error' ? record.state.failedState : record.state;
	const { authority: _authority, ...evidence } = state;
	return { state: evidence, review: record.review };
}

function stateRank(state: RecoverableSessionState | CompleteSessionState): number {
	return state.status === 'active' ? 1 : state.status === 'stopping' ? 2 : state.status === 'provisional' ? 3 : 4;
}

function normalizeSessionRuntimeRecord(value: unknown): SessionRuntimeRecord | null {
	if (isSessionRuntimeRecordV2(value)) return structuredClone(value);
	if (!isRecord(value) || value.version !== 1 || !exactKeys(value, [
		'version', 'state', 'baselineSnapshot', 'finalSnapshot', 'delta', 'persistedAt',
	])) return null;
	const migrated = { ...structuredClone(value), version: SESSION_RUNTIME_VERSION, review: null };
	return isSessionRuntimeRecordV2(migrated) ? migrated : null;
}

function hasPassEnvelope(snapshot: StorageSnapshot): boolean {
	return (snapshot.passes === 2 || snapshot.passes === 3)
		&& Array.isArray(snapshot.passCoverages)
		&& snapshot.passCoverages.every(isRecord);
}

function isJsonValue(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
	if (depth > 64) return false;
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	seen.add(value);
	const valid = Array.isArray(value)
		? value.every((entry) => isJsonValue(entry, seen, depth + 1))
		: Object.getPrototypeOf(value) === Object.prototype
			&& Object.values(value).every((entry) => isJsonValue(entry, seen, depth + 1));
	seen.delete(value);
	return valid;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const expected = [...keys].sort();
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
