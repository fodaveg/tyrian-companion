import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	BackedUpInventoryPreferencesStore,
	InventoryPreferencesBackup,
	mergeInventoryPreferencesBackup,
	readInventoryPreferencesBackup,
	type InventoryPreferencesBackupV1,
	type InventoryPreferencesBackupWriteOutcome,
} from './inventory-preferences-backup';
import type { InventoryAdvisorEvidenceCaptureResultV1 } from './inventory-advisor-evidence-model';
import {
	INVENTORY_PREFERENCES_DB_NAME,
	INVENTORY_PREFERENCES_DB_VERSION,
	INVENTORY_PREFERENCES_STORE_NAME,
	type InventoryPreferenceScope,
} from './inventory-preferences-model';
import { InventoryPreferencesRuntime } from './inventory-preferences-runtime';
import { InventoryPreferencesService } from './inventory-preferences-service';
import { IndexedDbInventoryPreferencesStore } from './inventory-preferences-store';
import type {
	LocalDebugActionContext,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';

/**
 * DU-13 (10 Oct 2026): the copy of the inventory preferences in the host's settings, over a real IndexedDB (fake-indexeddb)
 * and a settings port that keeps what it is given, as `data.json` would.
 */
const VAULT = 'vault-alpha';
const ACCOUNT = 'account-alpha';
const scope: InventoryPreferenceScope = { vaultId: VAULT, accountId: ACCOUNT };
const now = () => '2026-10-10T20:00:00.000Z';
let sequence = 0;

// The store reads one vault by key range, with the engine's `IDBKeyRange`; here, fake-indexeddb's.
beforeEach(() => { vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('inventory preferences copy: restore at the start', () => {
	it('restores a valid copy into an empty IndexedDB, once, and the editor reads it', async () => {
		const world = harness({ stored: copyOf([['account-alpha', ['goal-a'], ['keep-a']], ['account-beta', [], ['keep-b']]]) });

		await expect(world.backup.restore()).resolves.toBe('restored');
		await expect(world.backup.restore()).resolves.toBe('restored');
		expect(await world.service.list(scope)).toMatchObject({
			status: 'ok', record: { generation: 1, goals: [{ goalId: 'goal-a' }], keepExceptions: [{ exceptionId: 'keep-a' }] },
		});
		expect(await world.service.list({ vaultId: VAULT, accountId: 'account-beta' })).toMatchObject({
			status: 'ok', record: { keepExceptions: [{ exceptionId: 'keep-b' }] },
		});
		// Restoring is not a change: nothing is written back.
		world.timers.fire();
		await world.backup.settled();
		expect(world.writes).toEqual([]);
		expect(world.outcomes('backup_restore')).toEqual([['success', 'ok', 'backup_restored', { count: 2 }]]);
		world.dispose();
	});

	it('never overwrites a record IndexedDB can read, restores only the accounts it lacks, and leaves the copy alone', async () => {
		const world = harness({ stored: copyOf([[ACCOUNT, ['goal-from-copy'], []], ['account-beta', ['goal-beta'], []]]) });
		const own = new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(world.factory, world.name), now);
		await own.upsertGoal(scope, 0, goal('goal-in-indexeddb'));
		own.dispose();

		await expect(world.backup.restore()).resolves.toBe('restored');
		expect(await world.service.list(scope)).toMatchObject({ status: 'ok', record: { generation: 1, goals: [{ goalId: 'goal-in-indexeddb' }] } });
		// An account the vault does not have yet comes back from the copy.
		expect(await world.service.list({ vaultId: VAULT, accountId: 'account-beta' })).toMatchObject({
			status: 'ok', record: { generation: 1, goals: [{ goalId: 'goal-beta' }] },
		});
		expect(world.writes).toEqual([]);
		expect(world.outcomes('backup_restore')).toEqual([['success', 'ok', 'backup_restored', { count: 1 }]]);
		world.dispose();
	});

	it('has nothing to restore when IndexedDB can read every account of the copy', async () => {
		const world = harness({ stored: copyOf([[ACCOUNT, ['goal-from-copy'], []]]) });
		const own = new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(world.factory, world.name), now);
		await own.upsertGoal(scope, 0, goal('goal-in-indexeddb'));
		own.dispose();

		await expect(world.backup.restore()).resolves.toBe('not_empty');
		expect(await world.service.list(scope)).toMatchObject({ status: 'ok', record: { generation: 1, goals: [{ goalId: 'goal-in-indexeddb' }] } });
		expect(world.outcomes('backup_restore')).toEqual([['skip', 'skipped', 'backup_not_needed', undefined]]);
		world.dispose();
	});

	it('repairs a corrupt record from the copy, and never touches one of a future schema', async () => {
		const world = harness({ stored: copyOf([[ACCOUNT, ['goal-a'], []], ['account-beta', ['goal-beta'], []], ['account-gamma', ['goal-gamma'], []]]) });
		const future = { schemaVersion: 99, whatever: 'release 99 keeps here' };
		await putRaw(world.factory, world.name, `${VAULT}\u0000${ACCOUNT}`, { schemaVersion: 1, goals: 'not a list' });
		await putRaw(world.factory, world.name, `${VAULT}\u0000account-beta`, future);
		const own = new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(world.factory, world.name), now);
		await own.upsertGoal({ vaultId: VAULT, accountId: 'account-gamma' }, 0, goal('goal-gamma-in-indexeddb'));
		own.dispose();

		await expect(world.backup.restore()).resolves.toBe('restored');
		// The corrupt one blocked every read and write of its account; now it is the copy's, and editable again.
		expect(await world.service.list(scope)).toMatchObject({ status: 'ok', record: { generation: 1, goals: [{ goalId: 'goal-a' }] } });
		await expect(world.service.upsertGoal(scope, 1, goal('goal-a2'))).resolves.toMatchObject({ status: 'ok' });
		// Only the newer release that wrote it can read it: left as it is.
		expect(await getRaw(world.factory, world.name, `${VAULT}\u0000account-beta`)).toEqual(future);
		expect(await world.service.list({ vaultId: VAULT, accountId: 'account-beta' })).toEqual({ status: 'error', code: 'future_schema' });
		// A readable one is never written over.
		expect(await world.service.list({ vaultId: VAULT, accountId: 'account-gamma' })).toMatchObject({
			status: 'ok', record: { goals: [{ goalId: 'goal-gamma-in-indexeddb' }] },
		});
		expect(world.outcomes('backup_restore')).toEqual([['success', 'ok', 'backup_restored', { count: 1 }]]);
		world.dispose();
	});

	it('counts only this vault: records of a vault whose id starts the same do not stop the restore', async () => {
		const world = harness({ stored: copyOf([[ACCOUNT, ['goal-a'], []]]) });
		const other = new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(world.factory, world.name), now);
		await other.upsertGoal({ vaultId: `${VAULT}-other`, accountId: ACCOUNT }, 0, goal('goal-other'));
		other.dispose();

		await expect(world.backup.restore()).resolves.toBe('restored');
		expect(await world.service.list(scope)).toMatchObject({ status: 'ok', record: { goals: [{ goalId: 'goal-a' }] } });
		world.dispose();
	});

	it.each([
		['a copy of a future version', { version: 2, accounts: [] }, 'future_schema'],
		['a goal that does not validate', { version: 1, accounts: [{ accountId: ACCOUNT, goals: [{ goalId: 'x' }], keepExceptions: [] }] }, 'corrupt'],
		['an account twice', copyOf([[ACCOUNT, [], []], [ACCOUNT, [], []]]), 'corrupt'],
		['an unknown key', { version: 1, accounts: [], extra: true }, 'corrupt'],
		['not an object', 'a copy', 'corrupt'],
	])('does not restore %s, says so in the log, and deletes nothing', async (_label, stored, reason) => {
		const world = harness({ stored });

		await expect(world.backup.restore()).resolves.toBe('invalid');
		expect(await world.service.list(scope)).toEqual({ status: 'ok', record: null });
		expect(world.outcomes('backup_restore')).toEqual([['failure', 'validation_failed', 'backup_invalid', { reason }]]);
		expect(world.levels('backup_restore')).toEqual(['error']);
		expect(world.writes).toEqual([]);
		world.dispose();
	});

	it('records that there was no copy, and restores nothing', async () => {
		const world = harness({ stored: null });
		await expect(world.backup.restore()).resolves.toBe('absent');
		expect(world.outcomes('backup_restore')).toEqual([['skip', 'skipped', 'backup_absent', undefined]]);
		world.dispose();
	});

	it('makes the editor wait for the restore, so a first read never sees the empty store', async () => {
		const world = harness({ stored: copyOf([[ACCOUNT, ['goal-a'], []]]) });
		const runtime = new InventoryPreferencesRuntime(world.service, VAULT);
		const restoring = world.backup.restore();
		const loaded = runtime.load(capture(ACCOUNT));
		await restoring;
		await expect(loaded).resolves.toMatchObject({ status: 'ready', value: { goals: [{ goalId: 'goal-a' }] } });
		world.dispose();
	});
});

describe('inventory preferences copy: writes after a change', () => {
	it('writes the vault\'s records once per burst, after the last change, from what IndexedDB holds', async () => {
		const world = harness({ stored: null });
		await world.backup.restore();
		const first = await world.service.upsertGoal(scope, 0, goal('goal-a'));
		const second = await world.service.upsertGoal(scope, 1, goal('goal-b'));
		await world.service.upsertKeepException({ vaultId: VAULT, accountId: 'account-beta' }, 0, keep('keep-b'));
		expect([first.status, second.status]).toEqual(['ok', 'ok']);
		expect(world.timers.pending).toBe(1);
		expect(world.writes).toEqual([]);

		world.timers.fire();
		await world.backup.settled();
		expect(world.writes).toEqual([{
			version: 1,
			accounts: [
				{ accountId: 'account-alpha', goals: [goalOf('goal-a'), goalOf('goal-b')], keepExceptions: [] },
				{ accountId: 'account-beta', goals: [], keepExceptions: [keep('keep-b')] },
			],
		}]);
		expect(readInventoryPreferencesBackup(world.writes[0]).status).toBe('valid');
		expect(world.outcomes('backup_write')).toEqual([['success', 'ok', 'backup_saved', { count: 2 }]]);
		world.dispose();
	});

	it('does not count a save that changed nothing as a change', async () => {
		const world = harness({ stored: null });
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		world.timers.fire();
		await world.backup.settled();
		expect(world.writes).toHaveLength(1);

		await world.service.upsertGoal(scope, 1, goal('goal-a'));
		expect(world.timers.pending).toBe(0);
		world.dispose();
	});

	it('keeps the user\'s change when the settings write fails, and records the failure', async () => {
		const world = harness({ stored: null, write: async () => { throw new Error('data.json is not writable'); } });
		await world.backup.restore();
		const runtime = new InventoryPreferencesRuntime(world.service, VAULT);
		await runtime.load(capture(ACCOUNT));

		await expect(runtime.upsertGoal(goal('goal-a'))).resolves.toMatchObject({ status: 'ready', goals: [{ goalId: 'goal-a' }] });
		world.timers.fire();
		await expect(world.backup.settled()).resolves.toBeUndefined();
		expect(world.outcomes('backup_write')).toEqual([['failure', 'storage_failure', 'backup_write_failed', undefined]]);
		// The change is in IndexedDB, and the next one tries the copy again.
		expect(await world.service.list(scope)).toMatchObject({ status: 'ok', record: { goals: [{ goalId: 'goal-a' }] } });
		await runtime.upsertGoal(goal('goal-b'));
		expect(world.timers.pending).toBe(1);
		world.dispose();
	});

	it('records a write the settings refused because they belong to a newer release (DU-04)', async () => {
		const world = harness({ stored: null, write: async () => 'read_only' });
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		world.timers.fire();
		await world.backup.settled();
		expect(world.outcomes('backup_write')).toEqual([['skip', 'precondition_failed', 'settings_read_only', { count: 1 }]]);
		world.dispose();
	});

	it.each([
		['the stored copy is of a future version', 'future_kept', ['skip', 'precondition_failed', 'backup_future_kept', { count: 1 }]],
		['the plugin is already unloaded', 'unloaded', ['skip', 'cancelled', 'backup_after_unload', { count: 1 }]],
	] as const)('records a write the host refused because %s', async (_label, outcome, line) => {
		const world = harness({ stored: null, write: async () => outcome });
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		world.timers.fire();
		await world.backup.settled();
		expect(world.outcomes('backup_write')).toEqual([line]);
		world.dispose();
	});

	it('writes only this vault\'s records, never those of a vault whose id starts the same', async () => {
		const world = harness({ stored: null });
		const other = new InventoryPreferencesService(new IndexedDbInventoryPreferencesStore(world.factory, world.name), now);
		await other.upsertGoal({ vaultId: `${VAULT}-other`, accountId: ACCOUNT }, 0, goal('goal-other'));
		other.dispose();
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		world.timers.fire();
		await world.backup.settled();
		expect(world.writes).toEqual([{ version: 1, accounts: [{ accountId: ACCOUNT, goals: [goalOf('goal-a')], keepExceptions: [] }] }]);
		// Nothing of the other vault was even read: no unreadable record is counted.
		expect(world.outcomes('backup_write')).toEqual([['success', 'ok', 'backup_saved', { count: 1 }]]);
		world.dispose();
	});
});

describe('inventory preferences copy: merge over the stored copy', () => {
	it('keeps every stored account the new copy does not carry, and takes the new copy for the ones it does', () => {
		const stored = copyOf([['account-alpha', ['goal-old'], []], ['account-beta', [], ['keep-b']], ['account-gamma', ['goal-g'], []]]);
		const fresh = copyOf([['account-alpha', ['goal-new'], []]]);

		expect(mergeInventoryPreferencesBackup(stored, fresh)).toEqual(copyOf([
			['account-alpha', ['goal-new'], []], ['account-beta', [], ['keep-b']], ['account-gamma', ['goal-g'], []],
		]));
		// Even an empty read of IndexedDB never empties the copy.
		expect(mergeInventoryPreferencesBackup(stored, copyOf([]))).toEqual(stored);
	});

	it.each([
		['no stored copy', null],
		['a corrupt stored copy', 'not a copy'],
		['a stored copy of a future version', { version: 2, accounts: [] }],
	])('adds nothing from %s', (_label, stored) => {
		const fresh = copyOf([['account-alpha', ['goal-a'], []]]);
		expect(mergeInventoryPreferencesBackup(stored, fresh)).toEqual(fresh);
	});
});

describe('inventory preferences copy: dispose', () => {
	it('writes a burst still waiting once more, as the final write, and closes the store after it', async () => {
		const world = harness({ stored: null });
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		expect(world.timers.pending).toBe(1);

		world.dispose();
		expect(world.timers.pending).toBe(0);
		await world.backup.settled();
		expect(world.writes).toEqual([{ version: 1, accounts: [{ accountId: ACCOUNT, goals: [goalOf('goal-a')], keepExceptions: [] }] }]);
		expect(world.finals).toEqual([true]);
		expect(world.outcomes('backup_write_final')).toEqual([['success', 'ok', 'backup_saved', { count: 1 }]]);
		// Nothing after it: a later change schedules nothing.
		world.backup.changed();
		expect(world.timers.pending).toBe(0);
	});

	it('never holds or breaks the unload: a final write that fails is only recorded', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const world = harness({ stored: null, write: async () => { await held; throw new Error('data.json is gone'); } });
		await world.service.upsertGoal(scope, 0, goal('goal-a'));

		expect(() => { world.dispose(); }).not.toThrow();
		release();
		await expect(world.backup.settled()).resolves.toBeUndefined();
		expect(world.outcomes('backup_write_final')).toEqual([['failure', 'storage_failure', 'backup_write_failed', undefined]]);
	});

	/** A host that, like the core after the unload, refuses a write that is not final; the first write is held open. */
	function inFlightWorld() {
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const saved: InventoryPreferencesBackupV1[] = [];
		const world = harness({
			stored: null,
			write: async (copy, final) => {
				if (!final) {
					await held;
					return 'unloaded';
				}
				saved.push(JSON.parse(JSON.stringify(copy)) as InventoryPreferencesBackupV1);
				return 'saved';
			},
		});
		const storeDispose = vi.spyOn(world.store, 'dispose');
		return { world, saved, release, storeDispose };
	}

	it('a write already running when the unload comes ends with the copy saved, by a final write', async () => {
		const { world, saved, release } = inFlightWorld();
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		world.timers.fire();
		// Let the burst's own write reach the settings port and stop there.
		await vi.waitFor(() => { expect(world.finals).toEqual([false]); });

		world.dispose();
		release();
		await world.backup.settled();
		expect(world.finals).toEqual([false, true]);
		expect(saved).toEqual([{ version: 1, accounts: [{ accountId: ACCOUNT, goals: [goalOf('goal-a')], keepExceptions: [] }] }]);
	});

	it('does not close the store before the running write and the final one have ended', async () => {
		const { world, release, storeDispose } = inFlightWorld();
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		world.timers.fire();
		await vi.waitFor(() => { expect(world.finals).toEqual([false]); });

		world.dispose();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(storeDispose).not.toHaveBeenCalled();
		release();
		await world.backup.settled();
		await vi.waitFor(() => { expect(storeDispose).toHaveBeenCalledTimes(1); });
		expect(world.finals).toEqual([false, true]);
	});

	it('never waits for the running write: the dispose returns at once and does not throw', async () => {
		const { world, saved, release } = inFlightWorld();
		await world.service.upsertGoal(scope, 0, goal('goal-a'));
		world.timers.fire();
		await vi.waitFor(() => { expect(world.finals).toEqual([false]); });

		let returned = false;
		expect(() => { world.dispose(); returned = true; }).not.toThrow();
		expect(returned).toBe(true);
		expect(saved).toEqual([]);
		release();
		await expect(world.backup.settled()).resolves.toBeUndefined();
	});

	it('writes nothing at dispose when no burst is waiting', async () => {
		const world = harness({ stored: null });
		world.dispose();
		await world.backup.settled();
		expect(world.writes).toEqual([]);
	});
});

// --- harness ---------------------------------------------------------------------------------------------------------------

function harness(options: {
	stored: unknown;
	write?: (backup: InventoryPreferencesBackupV1, final: boolean) => Promise<InventoryPreferencesBackupWriteOutcome>;
}) {
	const factory = new IDBFactory();
	const finals: boolean[] = [];
	sequence += 1;
	const name = `${INVENTORY_PREFERENCES_DB_NAME}-backup-test-${String(sequence)}`;
	const store = new IndexedDbInventoryPreferencesStore(factory, name);
	const timers = manualTimers();
	const writes: InventoryPreferencesBackupV1[] = [];
	const events: LocalDebugEventContext[] = [];
	let spans = 0;
	const diagnostics = {
		createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext {
			spans += 1;
			const actionId = `backup-span-${String(spans)}`;
			return { ...context, actionId, correlationId: actionId };
		},
		event(context: LocalDebugEventContext): void { events.push(context); },
	};
	const backup = new InventoryPreferencesBackup({
		vaultId: VAULT,
		store,
		settings: {
			read: () => options.stored,
			write: async (copy, final) => {
				finals.push(final);
				if (options.write !== undefined) return await options.write(copy, final);
				writes.push(JSON.parse(JSON.stringify(copy)) as InventoryPreferencesBackupV1);
				return 'saved';
			},
		},
		schedule: timers.schedule,
		cancel: timers.cancel,
		now,
		diagnostics,
	});
	const service = new InventoryPreferencesService(new BackedUpInventoryPreferencesStore(store, backup), now);
	const terminal = (state: string) => events.filter((event) => event.phase !== 'start' && event.actionId !== undefined
		&& events.some((start) => start.phase === 'start' && start.actionId === event.actionId && start.state === state));
	return {
		factory, name, store, backup, service, timers, writes, finals,
		outcomes: (state: string) => terminal(state).map((event) => [event.phase, event.code, event.state, event.details]),
		levels: (state: string) => terminal(state).map((event) => event.level),
		dispose: () => { service.dispose(); },
	};
}

/** Opens the preferences database as the store would, to write or read a raw value past every validator. */
async function onRaw<T>(factory: IDBFactory, name: string, mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest | undefined): Promise<T> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name, INVENTORY_PREFERENCES_DB_VERSION);
		request.onupgradeneeded = () => { request.result.createObjectStore(INVENTORY_PREFERENCES_STORE_NAME); };
		request.onsuccess = () => { resolve(request.result); };
		request.onerror = () => { reject(request.error ?? new Error('open failed')); };
	});
	const transaction = database.transaction(INVENTORY_PREFERENCES_STORE_NAME, mode);
	const request = body(transaction.objectStore(INVENTORY_PREFERENCES_STORE_NAME));
	await new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => { resolve(); };
		transaction.onerror = () => { reject(transaction.error ?? new Error('transaction failed')); };
	});
	database.close();
	return request?.result as T;
}

async function putRaw(factory: IDBFactory, name: string, key: string, value: unknown): Promise<void> {
	await onRaw(factory, name, 'readwrite', (store) => { store.put(value, key); return undefined; });
}

async function getRaw(factory: IDBFactory, name: string, key: string): Promise<unknown> {
	return await onRaw(factory, name, 'readonly', (store) => store.get(key));
}

function manualTimers() {
	const live = new Map<number, () => void>();
	let next = 0;
	return {
		schedule: (callback: () => void) => { next += 1; live.set(next, callback); return next; },
		cancel: (handle: unknown) => { live.delete(handle as number); },
		get pending() { return live.size; },
		fire() { for (const [handle, callback] of [...live]) { live.delete(handle); callback(); } },
	};
}

/** A copy as the settings would hold it: `[accountId, goalIds, exceptionIds]` per account. */
function copyOf(accounts: readonly (readonly [string, readonly string[], readonly string[]])[]): InventoryPreferencesBackupV1 {
	return {
		version: 1,
		accounts: accounts.map(([accountId, goals, exceptions]) => ({
			accountId, goals: goals.map(goalOf), keepExceptions: exceptions.map(keep),
		})),
	};
}

function goal(goalId: string) { return goalOf(goalId); }

function goalOf(goalId: string) {
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

function keep(exceptionId: string) {
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

function capture(accountId: string): InventoryAdvisorEvidenceCaptureResultV1 {
	return {
		status: 'complete',
		evidence: { accountId, snapshot: { accountId }, prices: { accountId }, accountSignals: { accountId } },
	} as unknown as InventoryAdvisorEvidenceCaptureResultV1;
}
