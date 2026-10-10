/**
 * DU-13 (10 Oct 2026): a copy of the inventory preferences in the host's settings.
 *
 * Goals and «keep» exceptions are the only data the user writes by hand, and IndexedDB is «best effort»: an engine short
 * of disk may evict the origin, and a reinstall or a cleared Hebra starts empty. The copy lives in the settings the host
 * already keeps for the plugin (`data.json` in Obsidian, `storage.settings` in Hebra), under its own versioned field,
 * so it travels with the vault or library wherever those settings go.
 *
 * - What: per account of this vault, its goals and exceptions. No vault id (it is a hash of the path in Obsidian, so it
 *   changes when the vault moves), no generation, no timestamp: nothing derived, only what restoring needs.
 * - When it is written: after a change IndexedDB confirmed, once per burst (`quietMs` after the last one), from what the
 *   vault holds in IndexedDB at that moment. A failure is recorded and never reaches the user's action.
 * - When it is restored: once per load, at the start, only when IndexedDB holds no record of this vault and the copy is
 *   valid. Checking and writing are one IndexedDB transaction, so a record saved meanwhile is never overwritten. Until
 *   the restore has settled, the store wrapped by `BackedUpInventoryPreferencesStore` makes reads and writes wait for it.
 * - IndexedDB wins: with records there, the copy is not touched until the next change rewrites it from them.
 * - A copy that does not validate (corrupt, or a version this release does not know) is not restored and is recorded;
 *   nothing deletes it.
 *
 * Timers come from the host (`schedule`/`cancel`), never a global read here.
 */

import { createInventoryPreferences, isInventoryPreferenceScope } from './inventory-preferences-contract';
import type { KeepExceptionV1 } from './inventory-advisor-model';
import type {
	InventoryPreferenceScope,
	InventoryPreferencesActionContext,
	InventoryPreferencesReadResult,
	InventoryPreferencesStore,
	InventoryPreferencesV1,
	InventoryPreferencesVaultStore,
	InventoryPreferencesWriteResult,
} from './inventory-preferences-model';
import type { ReservationGoal } from '../economy/reservation-model';
import { startLocalDebugAction, type LocalDebugActionPort } from '../core/local-debug-action-runner';

export const INVENTORY_PREFERENCES_BACKUP_VERSION = 1 as const;

/** One account's preferences in the copy: what the user wrote, and the account it belongs to. */
export interface InventoryPreferencesBackupAccountV1 {
	accountId: string;
	goals: ReservationGoal[];
	keepExceptions: KeepExceptionV1[];
}

/** The field `inventoryPreferencesBackup` of the host's settings. Accounts in `accountId` order, once each. */
export interface InventoryPreferencesBackupV1 {
	version: typeof INVENTORY_PREFERENCES_BACKUP_VERSION;
	accounts: InventoryPreferencesBackupAccountV1[];
}

export type InventoryPreferencesBackupReading =
	| { status: 'absent' }
	| { status: 'valid'; backup: InventoryPreferencesBackupV1 }
	| { status: 'invalid'; reason: 'corrupt' | 'future_schema' };

/** A well-formed identifier and timestamp, only to run each account through the record validator. */
const VALIDATION_SCOPE_VAULT = 'inventory-preferences-copy';
const VALIDATION_TIMESTAMP = '2026-10-10T00:00:00.000Z';

/** The copy of these records: every account once, in `accountId` order, with its goals and exceptions as stored. */
export function createInventoryPreferencesBackup(records: readonly InventoryPreferencesV1[]): InventoryPreferencesBackupV1 {
	const accounts = records
		.map((record) => ({
			accountId: record.accountId,
			goals: structuredClone(record.goals),
			keepExceptions: structuredClone(record.keepExceptions),
		}))
		.sort((left, right) => compareText(left.accountId, right.accountId));
	return { version: INVENTORY_PREFERENCES_BACKUP_VERSION, accounts };
}

/**
 * Reads the field as the settings hold it. `null` or `undefined` is no copy. Anything else must be exactly a version 1
 * copy whose every account would make a valid record, with no account twice; a higher version is `future_schema`, the
 * rest `corrupt`. Nothing here throws.
 */
export function readInventoryPreferencesBackup(value: unknown): InventoryPreferencesBackupReading {
	if (value === null || value === undefined) return { status: 'absent' };
	try {
		if (!plainRecord(value)) return { status: 'invalid', reason: 'corrupt' };
		if (typeof value.version === 'number' && Number.isInteger(value.version) && value.version > INVENTORY_PREFERENCES_BACKUP_VERSION) {
			return { status: 'invalid', reason: 'future_schema' };
		}
		if (value.version !== INVENTORY_PREFERENCES_BACKUP_VERSION || !exactKeys(value, ['version', 'accounts'])
			|| !Array.isArray(value.accounts)) return { status: 'invalid', reason: 'corrupt' };
		const accounts: InventoryPreferencesBackupAccountV1[] = [];
		for (const entry of value.accounts as unknown[]) {
			if (!plainRecord(entry) || !exactKeys(entry, ['accountId', 'goals', 'keepExceptions'])) return { status: 'invalid', reason: 'corrupt' };
			const scope = { vaultId: VALIDATION_SCOPE_VAULT, accountId: entry.accountId };
			if (!isInventoryPreferenceScope(scope)) return { status: 'invalid', reason: 'corrupt' };
			const record = createInventoryPreferences(scope, 1, VALIDATION_TIMESTAMP,
				entry.goals as ReservationGoal[], entry.keepExceptions as KeepExceptionV1[]);
			if (record === null) return { status: 'invalid', reason: 'corrupt' };
			accounts.push({ accountId: record.accountId, goals: record.goals, keepExceptions: record.keepExceptions });
		}
		if (new Set(accounts.map((account) => account.accountId)).size !== accounts.length) return { status: 'invalid', reason: 'corrupt' };
		accounts.sort((left, right) => compareText(left.accountId, right.accountId));
		return { status: 'valid', backup: { version: INVENTORY_PREFERENCES_BACKUP_VERSION, accounts } };
	} catch {
		// A value that throws while it is read (an accessor, a revoked proxy) is not a copy this release can use.
		return { status: 'invalid', reason: 'corrupt' };
	}
}

/** The records a valid copy restores into `vaultId`: generation 1, as a first save would leave them, stamped `updatedAt`. */
export function inventoryPreferencesFromBackup(
	backup: InventoryPreferencesBackupV1,
	vaultId: string,
	updatedAt: string,
): InventoryPreferencesV1[] | null {
	const records: InventoryPreferencesV1[] = [];
	for (const account of backup.accounts) {
		const record = createInventoryPreferences({ vaultId, accountId: account.accountId }, 1, updatedAt, account.goals, account.keepExceptions);
		if (record === null) return null;
		records.push(record);
	}
	return records;
}

/** Whether two copies say the same, so writing one over the other would change nothing in the settings. */
export function sameInventoryPreferencesBackup(left: unknown, right: InventoryPreferencesBackupV1): boolean {
	const before = readInventoryPreferencesBackup(left);
	const after = readInventoryPreferencesBackup(right);
	return before.status === 'valid' && after.status === 'valid' && canonical(before.backup) === canonical(after.backup);
}

/** How the host's settings answered a write of the copy. `read_only`: settings from a newer release (DU-04), nothing written. */
export type InventoryPreferencesBackupWriteOutcome = 'saved' | 'unchanged' | 'read_only';

/** The host's settings, seen from the copy. */
export interface InventoryPreferencesBackupSettingsPort {
	/** The field as the settings were loaded at this start. */
	read(): unknown;
	/** Writes the field over the settings as they are now; rejects when the write failed. */
	write(backup: InventoryPreferencesBackupV1): Promise<InventoryPreferencesBackupWriteOutcome>;
}

export interface InventoryPreferencesBackupOptions {
	vaultId: string;
	store: InventoryPreferencesVaultStore;
	settings: InventoryPreferencesBackupSettingsPort;
	schedule: (callback: () => void, milliseconds: number) => unknown;
	cancel: (handle: unknown) => void;
	/** ISO timestamp of the restore, for the `updatedAt` of what it writes. */
	now: () => string;
	diagnostics?: LocalDebugActionPort;
	/** How long after the last change of a burst the copy is written. */
	quietMs?: number;
}

/** A burst of edits (one goal after another) is written once, this long after the last one. */
export const INVENTORY_PREFERENCES_BACKUP_QUIET_MS = 2_000;

export type InventoryPreferencesRestoreOutcome =
	| 'restored' | 'not_empty' | 'absent' | 'invalid' | 'failed';

/** Restores the copy once at the start and rewrites it after each burst of changes. Never throws to its callers. */
export class InventoryPreferencesBackup {
	private restoring: Promise<InventoryPreferencesRestoreOutcome> | null = null;
	private timer: unknown = undefined;
	private pending = false;
	private writing: Promise<void> = Promise.resolve();
	private disposed = false;
	private readonly quietMs: number;

	constructor(private readonly options: InventoryPreferencesBackupOptions) {
		this.quietMs = options.quietMs ?? INVENTORY_PREFERENCES_BACKUP_QUIET_MS;
	}

	/** Runs the restore the first time it is called; every later call answers the same outcome. */
	async restore(): Promise<InventoryPreferencesRestoreOutcome> {
		this.restoring ??= this.restoreOnce();
		return await this.restoring;
	}

	/** Settles when the restore has, or at once if none was started: what reads and writes wait for. */
	async ready(): Promise<void> {
		if (this.restoring !== null) await this.restoring;
	}

	/** A change IndexedDB confirmed: the copy is written `quietMs` after the last one of this burst. */
	changed(): void {
		if (this.disposed) return;
		this.pending = true;
		if (this.timer !== undefined) this.options.cancel(this.timer);
		this.timer = this.options.schedule(() => {
			this.timer = undefined;
			this.flush();
		}, this.quietMs);
	}

	/** The write of a burst still waiting, or in course, when it settles. For tests and for an orderly stop. */
	async settled(): Promise<void> {
		await this.writing;
	}

	/** Stops scheduling. A burst still waiting is not written: the copy catches up with the next change. */
	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) this.options.cancel(this.timer);
		this.timer = undefined;
		this.pending = false;
	}

	/** One write per burst, after the previous one: two never run together. */
	private flush(): void {
		if (!this.pending || this.disposed) return;
		this.pending = false;
		const previous = this.writing;
		this.writing = (async () => {
			await previous;
			await this.writeNow();
		})();
	}

	private async writeNow(): Promise<void> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'advisor', action: 'inventory_preferences_write', state: 'backup_write',
		});
		try {
			const read = await this.options.store.readVault(this.options.vaultId);
			if (read.status === 'error') {
				span.failure(new Error(`inventory_preferences_${read.code}`), 'storage_failure', 'backup_read_failed', { reason: read.code });
				return;
			}
			const outcome = await this.options.settings.write(createInventoryPreferencesBackup(read.records));
			const details = { count: read.records.length, ...(read.unreadable > 0 ? { result: `unreadable_${String(read.unreadable)}` } : {}) };
			if (outcome === 'saved') span.success('backup_saved', details);
			else if (outcome === 'unchanged') span.skip('skipped', 'backup_unchanged', details);
			else span.skip('precondition_failed', 'settings_read_only', details);
		} catch (error) {
			// The user's change is already in IndexedDB; only the copy is behind, until the next change writes it.
			span.failure(error, 'storage_failure', 'backup_write_failed');
		}
	}

	private async restoreOnce(): Promise<InventoryPreferencesRestoreOutcome> {
		const span = startLocalDebugAction(this.options.diagnostics, {
			component: 'advisor', action: 'inventory_preferences_write', state: 'backup_restore',
		});
		try {
			const reading = readInventoryPreferencesBackup(this.options.settings.read());
			if (reading.status === 'absent') {
				span.skip('skipped', 'backup_absent');
				return 'absent';
			}
			if (reading.status === 'invalid') {
				span.failure(new Error(`inventory_preferences_backup_${reading.reason}`), 'validation_failed', 'backup_invalid', { reason: reading.reason });
				return 'invalid';
			}
			const records = inventoryPreferencesFromBackup(reading.backup, this.options.vaultId, this.options.now());
			if (records === null) {
				span.failure(new Error('inventory_preferences_backup_corrupt'), 'validation_failed', 'backup_invalid', { reason: 'corrupt' });
				return 'invalid';
			}
			const result = await this.options.store.restoreVaultIfEmpty(this.options.vaultId, records);
			if (result.status === 'restored') {
				span.success('backup_restored', { count: result.count });
				return 'restored';
			}
			if (result.status === 'not_empty') {
				span.skip('skipped', 'backup_not_needed');
				return 'not_empty';
			}
			span.failure(new Error(`inventory_preferences_${result.code}`), 'storage_failure', 'backup_restore_failed', { reason: result.code });
			return 'failed';
		} catch (error) {
			span.failure(error, 'storage_failure', 'backup_restore_failed');
			return 'failed';
		}
	}
}

/**
 * The preferences store with the copy around it: reads and writes wait for the start's restore, and a write that changed
 * a record (its generation went up by one) tells the copy. Everything else is the wrapped store's.
 */
export class BackedUpInventoryPreferencesStore implements InventoryPreferencesStore {
	constructor(
		private readonly inner: InventoryPreferencesStore,
		private readonly backup: InventoryPreferencesBackup,
	) {}

	async read(scope: InventoryPreferenceScope, actionContext?: InventoryPreferencesActionContext): Promise<InventoryPreferencesReadResult> {
		await this.backup.ready();
		return await this.inner.read(scope, actionContext);
	}

	async compareAndSwap(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		next: InventoryPreferencesV1,
		actionContext?: InventoryPreferencesActionContext,
	): Promise<InventoryPreferencesWriteResult> {
		await this.backup.ready();
		const result = await this.inner.compareAndSwap(scope, expectedGeneration, next, actionContext);
		// A save that changed nothing answers the current record, whose generation did not move.
		if (result.status === 'saved' && result.record.generation === expectedGeneration + 1) this.backup.changed();
		return result;
	}

	dispose(): void {
		this.backup.dispose();
		this.inner.dispose();
	}
}

/** JSON with every object's keys in order, so two copies that differ only in key order compare equal. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
