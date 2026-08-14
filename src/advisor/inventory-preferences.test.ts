import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { cloneInventoryPreferences, isInventoryPreferences, isInventoryPreferenceScope } from './inventory-preferences-contract';
import {
	INVENTORY_PREFERENCES_DB_NAME,
	INVENTORY_PREFERENCES_STORE_NAME,
	type InventoryPreferenceScope,
} from './inventory-preferences-model';
import { InventoryPreferencesService } from './inventory-preferences-service';
import { IndexedDbInventoryPreferencesStore } from './inventory-preferences-store';

const scope: InventoryPreferenceScope = { vaultId: 'vault-alpha', accountId: 'account-alpha' };
const now = () => '2026-08-14T10:00:00.000Z';

describe('inventory preferences persistence', () => {
	it('persists a canonical, immutable record across reopen', async () => {
		const factory = new IDBFactory();
		const name = databaseName('reopen');
		const first = service(factory, name);
		const goal = validGoal('goal-z');
		const exception = validException('exception-z');
		const written = await first.replaceGoals(scope, 0, [goal, validGoal('goal-a')]);
		expect(written).toMatchObject({ status: 'ok', record: { generation: 1, goals: [{ goalId: 'goal-a' }, { goalId: 'goal-z' }] } });
		if (written.status !== 'ok' || written.record === null) throw new Error('Expected a record.');
		const exceptions = await first.replaceKeepExceptions(scope, written.record.generation, [exception, validException('exception-a')]);
		expect(exceptions).toMatchObject({ status: 'ok', record: { generation: 2, keepExceptions: [{ exceptionId: 'exception-a' }, { exceptionId: 'exception-z' }] } });
		goal.title = 'Mutated outside';
		first.dispose();

		const second = service(factory, name);
		const reopened = await second.list(scope);
		expect(reopened).toMatchObject({ status: 'ok', record: { generation: 2, goals: [{ title: 'goal-a' }, { title: 'goal-z' }] } });
		if (reopened.status !== 'ok' || reopened.record === null) throw new Error('Expected persisted record.');
		expect(JSON.parse(JSON.stringify(reopened.record))).toEqual(reopened.record);
		reopened.record.goals[0]!.title = 'Caller mutation';
		const loadedAgain = await second.list(scope);
		expect(loadedAgain.status === 'ok' && loadedAgain.record?.goals[0]?.title).toBe('goal-a');
		second.dispose();
	});

	it('isolates every vault and account even when their IDs share a prefix', async () => {
		const factory = new IDBFactory();
		const preferences = service(factory, databaseName('isolation'));
		const secondVault = { vaultId: 'vault-alpha-extra', accountId: 'account-alpha' };
		const secondAccount = { vaultId: 'vault-alpha', accountId: 'account-alpha-extra' };
		await expect(preferences.upsertGoal(scope, 0, validGoal('goal-one'))).resolves.toMatchObject({ status: 'ok' });
		await expect(preferences.list(secondVault)).resolves.toEqual({ status: 'ok', record: null });
		await expect(preferences.list(secondAccount)).resolves.toEqual({ status: 'ok', record: null });
		preferences.dispose();
	});

	it('uses generation CAS to reject a simultaneous stale writer', async () => {
		const factory = new IDBFactory();
		const name = databaseName('cas');
		const left = service(factory, name);
		const right = service(factory, name);
		await expect(left.upsertGoal(scope, 0, validGoal('goal-left'))).resolves.toMatchObject({ status: 'ok', record: { generation: 1 } });
		await expect(right.upsertGoal(scope, 0, validGoal('goal-right'))).resolves.toEqual({ status: 'conflict', generation: 1 });
		await expect(right.list(scope)).resolves.toMatchObject({ record: { goals: [{ goalId: 'goal-left' }] } });
		left.dispose();
		right.dispose();
	});

	it('settles a real concurrent Promise.all CAS race with one durable winner', async () => {
		const factory = new IDBFactory();
		const name = databaseName('cas-promise-all');
		const left = service(factory, name);
		const right = service(factory, name);
		const results = await Promise.all([
			left.upsertGoal(scope, 0, validGoal('goal-left')),
			right.upsertGoal(scope, 0, validGoal('goal-right')),
		]);
		expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);
		const durable = await left.list(scope);
		expect(durable.status).toBe('ok');
		expect(durable.status === 'ok' && durable.record?.goals).toHaveLength(1);
		expect(durable.status === 'ok' && durable.record?.goals[0]?.goalId).toMatch(/goal-(left|right)/);
		left.dispose();
		right.dispose();
	});

	it('makes replacement, upsert, and remove idempotent while preserving CAS checks', async () => {
		const preferences = service(new IDBFactory(), databaseName('idempotent'));
		const one = await preferences.upsertGoal(scope, 0, validGoal('goal-one'));
		if (one.status !== 'ok' || one.record === null) throw new Error('Expected first write.');
		const same = await preferences.upsertGoal(scope, one.record.generation, validGoal('goal-one'));
		expect(same).toMatchObject({ status: 'ok', record: { generation: 1 } });
		const removed = await preferences.removeGoal(scope, 1, 'missing-goal');
		expect(removed).toMatchObject({ status: 'ok', record: { generation: 1 } });
		await expect(preferences.removeGoal(scope, 0, 'missing-goal')).resolves.toEqual({ status: 'conflict', generation: 1 });
		preferences.dispose();
	});

	it('treats recursively reordered plain input as the same intent', async () => {
		const preferences = service(new IDBFactory(), databaseName('canonical-idempotent'));
		const first = await preferences.upsertGoal(scope, 0, validGoal('goal-one'));
		if (first.status !== 'ok' || first.record === null) throw new Error('Expected first write.');
		const reordered = reorderKeys(validGoal('goal-one')) as ReturnType<typeof validGoal>;
		const same = await preferences.upsertGoal(scope, first.record.generation, reordered);
		expect(same).toMatchObject({ status: 'ok', record: { generation: 1, updatedAt: now() } });
		preferences.dispose();
	});

	it('returns the durable current record without putting an updated timestamp for a direct no-op CAS', async () => {
		const factory = new IDBFactory();
		const name = databaseName('direct-noop-cas');
		const store = new IndexedDbInventoryPreferencesStore(factory, name);
		const preferences = new InventoryPreferencesService(store, now);
		const first = await preferences.upsertGoal(scope, 0, validGoal('goal-one'));
		if (first.status !== 'ok' || first.record === null) throw new Error('Expected first write.');
		const changedTimestamp = { ...first.record, updatedAt: '2026-08-14T11:00:00.000Z' };
		await expect(store.compareAndSwap(scope, 1, changedTimestamp)).resolves.toMatchObject({
			status: 'saved', record: { generation: 1, updatedAt: now() },
		});
		await expect(getRaw(factory, name, scope)).resolves.toMatchObject({ generation: 1, updatedAt: now() });
		preferences.dispose();
	});

	it('rejects duplicate IDs before an IndexedDB open or write', async () => {
		let opened = false;
		const factory = { open: () => { opened = true; throw new Error('must not open'); } } as unknown as IDBFactory;
		const preferences = service(factory, databaseName('duplicate'));
		await expect(preferences.replaceGoals(scope, 0, [validGoal('same'), validGoal('same')])).resolves.toEqual({ status: 'invalid' });
		await expect(preferences.replaceKeepExceptions(scope, 0, [validException('same'), validException('same')])).resolves.toEqual({ status: 'invalid' });
		expect(opened).toBe(false);
	});

	it('fails closed on corrupt, future, and missing-store records', async () => {
		const factory = new IDBFactory();
		const corruptName = databaseName('corrupt');
		await putRaw(factory, corruptName, { schemaVersion: 1 }, scope);
		await expect(service(factory, corruptName).list(scope)).resolves.toEqual({ status: 'error', code: 'corrupt' });

		const futureName = databaseName('future-record');
		await putRaw(factory, futureName, { schemaVersion: 99 }, scope);
		await expect(service(factory, futureName).list(scope)).resolves.toEqual({ status: 'error', code: 'future_schema' });

		const futureDb = databaseName('future-db');
		const raw = await openRaw(factory, futureDb, 2);
		raw.createObjectStore?.toString();
		raw.close();
		await expect(service(factory, futureDb).list(scope)).resolves.toEqual({ status: 'error', code: 'future_schema' });

		const missingStore = databaseName('missing-store-v1');
		const noStore = await openWithoutStore(factory, missingStore, 1);
		noStore.close();
		await expect(service(factory, missingStore).list(scope)).resolves.toEqual({ status: 'error', code: 'corrupt' });
	});

	it('migrates the admitted v0 envelope exactly once into the current schema', async () => {
		const factory = new IDBFactory();
		const name = databaseName('migration');
		await putRaw(factory, name, {
			schemaVersion: 0,
			vaultId: scope.vaultId,
			accountId: scope.accountId,
			updatedAt: now(),
			goals: [validGoal('legacy-goal')],
			keepExceptions: [validException('legacy-exception')],
		}, scope);
		const preferences = service(factory, name);
		await expect(preferences.list(scope)).resolves.toMatchObject({ status: 'ok', record: { schemaVersion: 1, generation: 0 } });
		const raw = await getRaw(factory, name, scope);
		expect(raw).toMatchObject({ schemaVersion: 1, generation: 0 });
		preferences.dispose();
	});

	it('rejects hostile input and has no side effects until an explicit API call', async () => {
		let opened = 0;
		const factory = { open: () => { opened += 1; throw new Error('no open expected'); } } as unknown as IDBFactory;
		const store = new IndexedDbInventoryPreferencesStore(factory, databaseName('explicit-only'));
		const preferences = new InventoryPreferencesService(store, now);
		expect(opened).toBe(0);
		const hostile = new Proxy({}, { get: () => { throw new Error('hostile'); }, ownKeys: () => { throw new Error('hostile'); } });
		expect(isInventoryPreferences(hostile)).toBe(false);
		const plain = await service(new IDBFactory(), databaseName('plain-input')).upsertGoal(scope, 0, validGoal('plain-goal'));
		if (plain.status !== 'ok' || plain.record === null) throw new Error('Expected a plain record.');
		const inheritedToJson = Object.create({ toJSON: () => ({}) }) as Record<string, unknown>;
		for (const [key, value] of Object.entries(plain.record)) inheritedToJson[key] = value;
		expect(isInventoryPreferences(inheritedToJson)).toBe(false);
		let getterReads = 0;
		const accessorScope = { accountId: scope.accountId, get vaultId() { getterReads += 1; return scope.vaultId; } };
		expect(isInventoryPreferenceScope(accessorScope)).toBe(false);
		expect(getterReads).toBe(0);
		const topLevelAccessor = structuredClone(plain.record);
		Object.defineProperty(topLevelAccessor, 'updatedAt', { enumerable: true, get: () => { getterReads += 1; return now(); } });
		expect(isInventoryPreferences(topLevelAccessor)).toBe(false);
		const nestedAccessor = structuredClone(plain.record);
		Object.defineProperty(nestedAccessor.goals[0]!.requirements[0]!, 'id', { enumerable: true, get: () => { getterReads += 1; return 1; } });
		expect(isInventoryPreferences(nestedAccessor)).toBe(false);
		expect(getterReads).toBe(0);
		vi.stubGlobal('structuredClone', () => { throw new Error('clone failed'); });
		try {
			expect(cloneInventoryPreferences(plain.record)).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
		await expect(preferences.upsertGoal(scope, 0, hostile as never)).resolves.toEqual({ status: 'invalid' });
		expect(opened).toBe(0);
		preferences.dispose();
		await expect(preferences.list(scope)).resolves.toEqual({ status: 'error', code: 'unavailable' });
	});
});

function service(factory: IDBFactory, databaseName: string): InventoryPreferencesService {
	return new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(factory, databaseName), now);
}

function validGoal(goalId: string) {
	return {
		schemaVersion: 1 as const,
		goalId,
		title: goalId,
		status: 'active' as const,
		priority: 1,
		reason: 'personal' as const,
		requirements: [{
			key: 'item:1', namespace: 'item' as const, id: 1, targetQuantity: 1,
			creditedQuantity: 0, basis: 'available' as const, intendedUse: 'hold' as const,
		}],
	};
}

function validException(exceptionId: string) {
	return {
		version: 1 as const,
		exceptionId,
		itemId: 1,
		status: 'active' as const,
		basis: 'available' as const,
		quantity: { mode: 'all' as const },
		reason: 'user_keep' as const,
	};
}

function reorderKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reorderKeys);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorderKeys(child)]));
}

function databaseName(label: string): string {
	return `${INVENTORY_PREFERENCES_DB_NAME}-test-${label}`;
}

function storageKey(value: InventoryPreferenceScope): string {
	return `${value.vaultId}\u0000${value.accountId}`;
}

async function putRaw(factory: IDBFactory, name: string, value: unknown, key: InventoryPreferenceScope): Promise<void> {
	const database = await openRaw(factory, name, 1);
	const transaction = database.transaction(INVENTORY_PREFERENCES_STORE_NAME, 'readwrite');
	transaction.objectStore(INVENTORY_PREFERENCES_STORE_NAME).put(value, storageKey(key));
	await transactionDone(transaction);
	database.close();
}

async function getRaw(factory: IDBFactory, name: string, key: InventoryPreferenceScope): Promise<unknown> {
	const database = await openRaw(factory, name, 1);
	const transaction = database.transaction(INVENTORY_PREFERENCES_STORE_NAME, 'readonly');
	const request = transaction.objectStore(INVENTORY_PREFERENCES_STORE_NAME).get(storageKey(key));
	const value = await new Promise<unknown>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result as unknown);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed.'));
	});
	await transactionDone(transaction);
	database.close();
	return value;
}

function openRaw(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(INVENTORY_PREFERENCES_STORE_NAME)) {
				request.result.createObjectStore(INVENTORY_PREFERENCES_STORE_NAME);
			}
		};
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
		request.onsuccess = () => resolve(request.result);
	});
}

function openWithoutStore(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name, version);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
		request.onsuccess = () => resolve(request.result);
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
		transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
	});
}
