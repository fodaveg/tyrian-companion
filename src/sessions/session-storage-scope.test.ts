/**
 * H18.12: two vaults open at once share one IndexedDB origin. These tests mount two vaults on the
 * SAME fake-indexeddb factory, the way two Obsidian windows share `app://obsidian.md`, and check
 * that each one gets its own saved session and its own lease, and that the unscoped pair an
 * earlier release wrote is adopted by at most one vault, in place, without copying or deleting it.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { openIndexedDb } from '../core/indexed-db-open';
import { ActiveSessionLeaseCoordinator } from './coordination-coordinator';
import { COORDINATION_DB_NAME } from './coordination-store';
import {
	SESSION_RUNTIME_DB_NAME,
	SESSION_RUNTIME_DB_VERSION,
	SESSION_RUNTIME_KEY,
	SESSION_RUNTIME_STORE_NAME,
} from './session-runtime-store';
import {
	SESSION_STORAGE_LEGACY_OWNER_KEY,
	SessionStorageScope,
	resolveSessionStorageNames,
	vaultSessionStorageNames,
} from './session-storage-scope';

const VAULT_A = 'a'.repeat(64);
const VAULT_B = 'b'.repeat(64);
const CLAIMED_AT = Date.parse('2026-09-24T08:00:00.000Z');
/** Stands in for whatever record an earlier release saved; the scope never reads it, only counts it. */
const LEGACY_RECORD = { written: 'by an earlier release' };

describe('session storage scoped per vault (H18.12)', () => {
	it('shows why: two vaults on the unscoped lease are one lease', async () => {
		const factory = new IDBFactory();
		const vaultA = leaseFor(factory, 'instance-a', COORDINATION_DB_NAME);
		const vaultB = leaseFor(factory, 'instance-b', COORDINATION_DB_NAME);

		await expect(vaultA.acquire('session-a')).resolves.toMatchObject({ status: 'acquired' });
		await expect(vaultB.acquire('session-b')).resolves.toMatchObject({ status: 'busy', ownerInstanceId: 'instance-a' });
	});

	it('gives each vault its own lease and its own runtime database', async () => {
		const factory = new IDBFactory();
		const scopeA = new SessionStorageScope(factory, VAULT_A);
		const scopeB = new SessionStorageScope(factory, VAULT_B);
		const vaultA = leaseFor(factory, 'instance-a', async () => await scopeA.coordinationDatabaseName());
		const vaultB = leaseFor(factory, 'instance-b', async () => await scopeB.coordinationDatabaseName());

		await expect(vaultA.acquire('session-a')).resolves.toMatchObject({ status: 'acquired' });
		await expect(vaultB.acquire('session-b')).resolves.toMatchObject({ status: 'acquired' });
		await expect(scopeA.names()).resolves.toEqual(vaultSessionStorageNames(VAULT_A));
		await expect(scopeB.names()).resolves.toEqual(vaultSessionStorageNames(VAULT_B));
		expect(vaultSessionStorageNames(VAULT_A)).toEqual({
			runtime: `tyrian-companion-session-runtime:${VAULT_A}`,
			coordination: `tyrian-companion-coordination:${VAULT_A}`,
			legacy: false,
		});
		// A fresh install never gets an empty unscoped database just because a vault looked for one.
		expect(await databaseNames(factory)).not.toContain(SESSION_RUNTIME_DB_NAME);
		expect(await databaseNames(factory)).not.toContain(COORDINATION_DB_NAME);
	});

	it('lets the first vault adopt an earlier session in place, and only that vault, across restarts', async () => {
		const factory = new IDBFactory();
		await seedLegacy(factory, { record: LEGACY_RECORD });

		await expect(resolveSessionStorageNames(factory, VAULT_A, () => CLAIMED_AT)).resolves.toEqual({
			runtime: SESSION_RUNTIME_DB_NAME, coordination: COORDINATION_DB_NAME, legacy: true,
		});
		await expect(resolveSessionStorageNames(factory, VAULT_B)).resolves.toEqual(vaultSessionStorageNames(VAULT_B));
		// A restart of either vault takes the same decision again.
		await expect(new SessionStorageScope(factory, VAULT_A).names()).resolves.toMatchObject({ legacy: true });
		await expect(new SessionStorageScope(factory, VAULT_B).names()).resolves.toMatchObject({ legacy: false });

		await expect(readLegacy(factory)).resolves.toEqual({
			record: LEGACY_RECORD,
			owner: { version: 1, vaultId: VAULT_A, claimedAt: CLAIMED_AT },
		});
	});

	it('leaves an earlier database without a session to nobody, and writes nothing into it', async () => {
		const factory = new IDBFactory();
		await seedLegacy(factory, {});

		await expect(resolveSessionStorageNames(factory, VAULT_A)).resolves.toEqual(vaultSessionStorageNames(VAULT_A));
		await expect(resolveSessionStorageNames(factory, VAULT_B)).resolves.toEqual(vaultSessionStorageNames(VAULT_B));
		await expect(readLegacy(factory)).resolves.toEqual({ record: undefined, owner: undefined });
	});

	it('never moves a vault that already uses its own pair back onto the earlier one', async () => {
		const factory = new IDBFactory();
		await openAndClose(factory, vaultSessionStorageNames(VAULT_A).runtime);
		await seedLegacy(factory, { record: LEGACY_RECORD });

		await expect(resolveSessionStorageNames(factory, VAULT_A)).resolves.toEqual(vaultSessionStorageNames(VAULT_A));
		await expect(readLegacy(factory)).resolves.toEqual({ record: LEGACY_RECORD, owner: undefined });
		// It is still there for the vault that did write it.
		await expect(resolveSessionStorageNames(factory, VAULT_B)).resolves.toMatchObject({ legacy: true });
	});

	it('lets exactly one of two vaults loading at the same moment adopt it', async () => {
		const factory = new IDBFactory();
		await seedLegacy(factory, { record: LEGACY_RECORD });

		const [first, second] = await Promise.all([
			resolveSessionStorageNames(factory, VAULT_A),
			resolveSessionStorageNames(factory, VAULT_B),
		]);
		expect([first.legacy, second.legacy].filter(Boolean)).toHaveLength(1);
		const owner = (await readLegacy(factory)).owner as { vaultId: string };
		expect(owner.vaultId).toBe(first.legacy ? VAULT_A : VAULT_B);
	});

	it('treats an owner mark it cannot read as somebody else\'s, and never overwrites it', async () => {
		const factory = new IDBFactory();
		const unreadable = { version: 2, vaultId: VAULT_B };
		await seedLegacy(factory, { record: LEGACY_RECORD, owner: unreadable });

		await expect(resolveSessionStorageNames(factory, VAULT_A)).resolves.toEqual(vaultSessionStorageNames(VAULT_A));
		await expect(resolveSessionStorageNames(factory, VAULT_B)).resolves.toEqual(vaultSessionStorageNames(VAULT_B));
		await expect(readLegacy(factory)).resolves.toEqual({ record: LEGACY_RECORD, owner: unreadable });
	});

	it('does not guess without a database list: its own pair, and the earlier one untouched', async () => {
		const factory = new IDBFactory();
		await seedLegacy(factory, { record: LEGACY_RECORD });
		const withoutList = Object.assign(Object.create(factory) as IDBFactory, { databases: undefined });

		await expect(resolveSessionStorageNames(withoutList, VAULT_A)).resolves.toEqual(vaultSessionStorageNames(VAULT_A));
		await expect(readLegacy(factory)).resolves.toEqual({ record: LEGACY_RECORD, owner: undefined });
	});

	it('retries a decision that failed, and keeps one that succeeded for the whole run', async () => {
		const factory = new IDBFactory();
		let listings = 0;
		const flaky = Object.assign(Object.create(factory) as IDBFactory, {
			databases: async () => {
				listings += 1;
				if (listings === 1) throw new Error('storage down');
				return await factory.databases();
			},
		});
		const scope = new SessionStorageScope(flaky, VAULT_A);

		await expect(scope.runtimeDatabaseName()).rejects.toThrow('storage down');
		await expect(scope.runtimeDatabaseName()).resolves.toBe(vaultSessionStorageNames(VAULT_A).runtime);
		await expect(scope.coordinationDatabaseName()).resolves.toBe(vaultSessionStorageNames(VAULT_A).coordination);
		expect(listings).toBe(2);
	});

	it('rejects an empty vault id instead of sharing a database under a blank suffix', () => {
		expect(() => vaultSessionStorageNames('')).toThrow('vault id');
	});
});

function leaseFor(
	factory: IDBFactory,
	instanceId: string,
	databaseName: string | (() => Promise<string>),
): ActiveSessionLeaseCoordinator {
	return new ActiveSessionLeaseCoordinator({
		indexedDb: factory,
		databaseName,
		instanceId,
		machineId: () => `machine-${instanceId}`,
		clock: () => CLAIMED_AT,
		sleep: async () => undefined,
	});
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
	return (await factory.databases()).map((info) => info.name ?? '');
}

function openRuntime(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return openIndexedDb({
		factory,
		databaseName: name,
		databaseVersion: SESSION_RUNTIME_DB_VERSION,
		schema: [{ name: SESSION_RUNTIME_STORE_NAME }],
		toError: (reason) => new Error(`Could not open the fixture database: ${reason}`),
	});
}

async function openAndClose(factory: IDBFactory, name: string): Promise<void> {
	(await openRuntime(factory, name)).close();
}

/** Writes straight to the unscoped runtime database, exactly as an earlier release left it. */
async function seedLegacy(factory: IDBFactory, values: { record?: unknown; owner?: unknown }): Promise<void> {
	const database = await openRuntime(factory, SESSION_RUNTIME_DB_NAME);
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
		const store = transaction.objectStore(SESSION_RUNTIME_STORE_NAME);
		if (values.record !== undefined) store.put(values.record, SESSION_RUNTIME_KEY);
		if (values.owner !== undefined) store.put(values.owner, SESSION_STORAGE_LEGACY_OWNER_KEY);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(new Error('Could not seed the fixture database.'));
	});
	database.close();
}

async function readLegacy(factory: IDBFactory): Promise<{ record: unknown; owner: unknown }> {
	const database = await openRuntime(factory, SESSION_RUNTIME_DB_NAME);
	const values = await new Promise<{ record: unknown; owner: unknown }>((resolve, reject) => {
		const transaction = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readonly');
		const store = transaction.objectStore(SESSION_RUNTIME_STORE_NAME);
		const record = store.get(SESSION_RUNTIME_KEY);
		const owner = store.get(SESSION_STORAGE_LEGACY_OWNER_KEY);
		transaction.oncomplete = () => resolve({ record: record.result as unknown, owner: owner.result as unknown });
		transaction.onerror = () => reject(new Error('Could not read the fixture database.'));
	});
	database.close();
	return values;
}
