/**
 * DU-02: what to do when the vault's identity (the hash of its absolute path) is not the one this
 * device last used.
 *
 * Everything this device keeps locally (inventory preferences, the collector/consult mode, price
 * history, Halloween, the saved session) is keyed by that hash, so renaming or moving the folder
 * leaves all of it under the OLD id, unseen. The identity stays the path; this module only notices
 * the change and carries over what can travel without risk.
 *
 * - The last id used lives in the host's per-device local storage (`TyrianLocalStoragePort`), never
 *   in `data.json`, which syncs.
 * - A change is reported only when there are local data under the previous id: a collector-mode
 *   entry (every start with IndexedDB leaves one) or inventory preferences.
 * - Adopting COPIES, never moves, and never overwrites what the new id already holds.
 */

import { isInventoryPreferences, migrateInventoryPreferences } from '../advisor/inventory-preferences-contract';
import {
	INVENTORY_PREFERENCES_DB_NAME,
	INVENTORY_PREFERENCES_DB_VERSION,
	INVENTORY_PREFERENCES_STORE_NAME,
} from '../advisor/inventory-preferences-model';
import { openIndexedDb } from '../core/indexed-db-open';
import type { CollectorMode } from '../core/settings';
import type { TyrianLocalStoragePort } from '../host/tyrian-host';
import { readStoredCollectorMode } from './collector-instance';

export const VAULT_IDENTITY_KEY = 'tyrian-companion:vault-identity';

const VAULT_ID = /^[a-f0-9]{64}$/u;

/** What the device remembers: the last id used and, while the user has not answered, the id the data was under. */
interface VaultIdentityRecord {
	readonly vaultId: string;
	readonly pendingFrom?: string;
}

/** The question asked after a path change; `null` when there is none. */
export interface VaultRelocation {
	readonly previousVaultId: string;
}

/** What `adoptVaultData` carried over. The mode is `null` when the previous id stored none. */
export interface VaultAdoption {
	readonly preferences: number;
	readonly mode: CollectorMode | null;
}

function readRecord(storage: TyrianLocalStoragePort): VaultIdentityRecord | null {
	const raw = storage.load(VAULT_IDENTITY_KEY);
	if (typeof raw !== 'object' || raw === null) return null;
	const { vaultId, pendingFrom } = raw as { vaultId?: unknown; pendingFrom?: unknown };
	if (typeof vaultId !== 'string' || !VAULT_ID.test(vaultId)) return null;
	return typeof pendingFrom === 'string' && VAULT_ID.test(pendingFrom) ? { vaultId, pendingFrom } : { vaultId };
}

/**
 * Compares `currentId` with the last id this device used and records the current one. Returns the
 * relocation to ask about, or `null`. A device with nothing saved (first start) just records.
 * While the user has not answered, every start asks again.
 */
export async function detectVaultRelocation(
	storage: TyrianLocalStoragePort | undefined,
	factory: IDBFactory,
	currentId: string,
): Promise<VaultRelocation | null> {
	if (storage === undefined) return null;
	const saved = readRecord(storage);
	if (saved === null) {
		storage.save(VAULT_IDENTITY_KEY, { vaultId: currentId });
		return null;
	}
	if (saved.vaultId === currentId) {
		return saved.pendingFrom !== undefined && saved.pendingFrom !== currentId
			? { previousVaultId: saved.pendingFrom } : null;
	}
	// A second move before answering: the data are under the id that has some, else under the one still pending.
	const previousVaultId = !(await hasLocalData(factory, saved.vaultId)) && saved.pendingFrom !== undefined
		? saved.pendingFrom : saved.vaultId;
	if (!(await hasLocalData(factory, previousVaultId))) {
		storage.save(VAULT_IDENTITY_KEY, { vaultId: currentId });
		return null;
	}
	storage.save(VAULT_IDENTITY_KEY, { vaultId: currentId, pendingFrom: previousVaultId });
	return { previousVaultId };
}

/** The user answered: the current id is recorded and nothing is pending. */
export function settleVaultRelocation(storage: TyrianLocalStoragePort | undefined, currentId: string): void {
	storage?.save(VAULT_IDENTITY_KEY, { vaultId: currentId });
}

/** Whether this device kept anything of the vault under `vaultId`. */
async function hasLocalData(factory: IDBFactory, vaultId: string): Promise<boolean> {
	if (await readStoredCollectorMode(factory, vaultId) !== null) return true;
	return await countPreferences(factory, vaultId) > 0;
}

/**
 * Carries over what is safe from `fromId` to `toId`: the inventory preferences (the only data the
 * user wrote by hand) and the mode the device had. Everything else stays under the previous id:
 * - the saved session and its lease: a lease names the old id and another window may still hold it, so copying could
 *   leave two owners of one session;
 * - price history, price seeds and Halloween: caches and emitted-alert bookkeeping that refill by themselves, and
 *   whose stores each have their own schema, so a copy would be code written blind;
 * - the installation id and the collector heartbeat: the status note must name the new installation.
 */
export async function adoptVaultData(factory: IDBFactory, fromId: string, toId: string): Promise<VaultAdoption> {
	const mode = await readStoredCollectorMode(factory, fromId);
	return { preferences: await copyPreferences(factory, fromId, toId), mode };
}

function openPreferences(factory: IDBFactory): Promise<IDBDatabase> {
	return openIndexedDb({
		factory,
		databaseName: INVENTORY_PREFERENCES_DB_NAME,
		databaseVersion: INVENTORY_PREFERENCES_DB_VERSION,
		schema: [{ name: INVENTORY_PREFERENCES_STORE_NAME }],
		onVersionChange: 'close',
		toError: () => new Error('Inventory preferences could not be opened.'),
	});
}

/** The keys of one vault are `<vaultId>\0<accountId>`; this range holds exactly that vault's. */
function vaultKeys(vaultId: string): IDBKeyRange {
	return IDBKeyRange.bound(`${vaultId}\u0000`, `${vaultId}\u0001`, false, true);
}

async function countPreferences(factory: IDBFactory, vaultId: string): Promise<number> {
	const database = await openPreferences(factory);
	try {
		return await new Promise<number>((resolve, reject) => {
			const request = database.transaction(INVENTORY_PREFERENCES_STORE_NAME, 'readonly')
				.objectStore(INVENTORY_PREFERENCES_STORE_NAME).count(vaultKeys(vaultId));
			request.onsuccess = () => { resolve(request.result); };
			request.onerror = () => { reject(new Error('Inventory preferences could not be counted.')); };
		});
	} finally {
		database.close();
	}
}

/** Copies each record under `fromId` to `toId` unless that key already holds one; resolves how many were copied. */
async function copyPreferences(factory: IDBFactory, fromId: string, toId: string): Promise<number> {
	const database = await openPreferences(factory);
	try {
		return await new Promise<number>((resolve, reject) => {
			const transaction = database.transaction(INVENTORY_PREFERENCES_STORE_NAME, 'readwrite');
			const store = transaction.objectStore(INVENTORY_PREFERENCES_STORE_NAME);
			let copied = 0;
			const cursorRequest = store.openCursor(vaultKeys(fromId));
			cursorRequest.onsuccess = () => {
				const cursor = cursorRequest.result;
				if (cursor === null) return;
				// A record this version cannot read (future schema, corrupt) stays where it is.
				const record = migrateInventoryPreferences(cursor.value as unknown);
				if (record !== null) {
					const adopted = { ...record, vaultId: toId };
					const key = `${toId}\u0000${adopted.accountId}`;
					if (isInventoryPreferences(adopted)) {
						const existing = store.get(key);
						existing.onsuccess = () => {
							if (existing.result !== undefined) return;
							store.put(adopted, key);
							copied += 1;
						};
					}
				}
				cursor.continue();
			};
			transaction.oncomplete = () => { resolve(copied); };
			transaction.onerror = () => { reject(new Error('Inventory preferences could not be adopted.')); };
			transaction.onabort = () => { reject(new Error('Inventory preferences adoption was aborted.')); };
		});
	} finally {
		database.close();
	}
}
