/**
 * DU-02: what to do when the vault's identity (the hash of its absolute path) is not the one this
 * device last used.
 *
 * Everything this device keeps locally (inventory preferences, the collector/consult mode, price
 * history, Halloween, the saved session) is keyed by that hash, so renaming or moving the folder
 * leaves all of it under the OLD id, unseen. The identity stays the path; this module only notices
 * the change and carries over what can travel without risk.
 *
 * Two memories of "the last id this device used", because Obsidian can lose one of them:
 * - the host's per-device local storage (`TyrianLocalStoragePort`, Obsidian's `loadLocalStorage`). Its key is
 *   anchored to the vault's `appId`, which Obsidian KEEPS when the folder is renamed or moved from its vault
 *   switcher and RENEWS when the folder is moved outside Obsidian and opened again;
 * - a per-device registry `vault token -> last id`, in its own origin-wide IndexedDB. The token
 *   is a random string kept in the plugin's data (`data.json`, which travels with the folder), so it follows the
 *   folder through any move and identifies the vault, not the device.
 * The registry is read first; the local storage is the fallback and is also kept up to date.
 *
 * Covered: a rename or move from the vault switcher, and a folder moved outside Obsidian (when the vault already had
 * its token, i.e. it ran a version with this module at least once). NOT covered: a vault from before the token that
 * is moved outside Obsidian on its first start with it (nothing remembers it); a vault COPIED whole, which shares
 * the token with the original (each opening then looks like a move from the other: it asks, starts in consult, and
 * answering "start fresh" or "adopt" copies and never moves, so the other copy loses nothing); a device that
 * never ran the plugin on that vault (nothing to adopt, no question).
 *
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

/** The per-device registry `vault token -> last id`: its own database, so it never shares a transaction queue with the mode. */
export const VAULT_REGISTRY_DB = 'tyrian-companion-vault-registry';
const VAULT_REGISTRY_STORE = 'tokens-v1';

function openRegistry(factory: IDBFactory): Promise<IDBDatabase> {
	return openIndexedDb({
		factory,
		databaseName: VAULT_REGISTRY_DB,
		databaseVersion: 1,
		schema: [{ name: VAULT_REGISTRY_STORE }],
		onVersionChange: 'close',
		toError: () => new Error('Vault registry could not be opened.'),
	});
}

async function readRegistry(factory: IDBFactory, key: string): Promise<unknown> {
	const database = await openRegistry(factory);
	try {
		return await new Promise<unknown>((resolve, reject) => {
			const request = database.transaction(VAULT_REGISTRY_STORE, 'readonly').objectStore(VAULT_REGISTRY_STORE).get(key);
			request.onsuccess = () => { resolve(request.result as unknown); };
			request.onerror = () => { reject(new Error('Vault registry could not be read.')); };
		});
	} finally {
		database.close();
	}
}

async function writeRegistry(factory: IDBFactory, key: string, value: unknown): Promise<void> {
	const database = await openRegistry(factory);
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(VAULT_REGISTRY_STORE, 'readwrite');
			transaction.objectStore(VAULT_REGISTRY_STORE).put(value, key);
			transaction.oncomplete = () => { resolve(); };
			transaction.onerror = () => { reject(new Error('Vault registry could not be written.')); };
			transaction.onabort = () => { reject(new Error('Vault registry write was aborted.')); };
		});
	} finally {
		database.close();
	}
}

export const VAULT_IDENTITY_KEY = 'tyrian-companion:vault-identity';

const VAULT_ID = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9-]{16,64}$/u;

/** What the device remembers: the last id used and, while the user has not answered, the id the data was under. */
interface VaultIdentityRecord {
	readonly vaultId: string;
	readonly pendingFrom?: string;
}

/** The question asked after a path change; `null` when there is none. */
export interface VaultRelocation {
	readonly previousVaultId: string;
	/** True when the check itself failed: the device has another id saved but could not look for its data. */
	readonly unverified?: boolean;
}

/** What `adoptVaultData` carried over. The mode is `null` when the previous id stored none. */
export interface VaultAdoption {
	readonly preferences: number;
	readonly mode: CollectorMode | null;
}

/** Where the identity is remembered: the host's local storage and, for a vault with a token, the device registry. */
export interface VaultIdentityStores {
	readonly storage: TyrianLocalStoragePort | undefined;
	readonly factory: IDBFactory;
	/** The vault's token; empty when the host keeps none. */
	readonly token: string;
}

export function isVaultToken(value: unknown): value is string {
	return typeof value === 'string' && TOKEN.test(value);
}

function parseRecord(raw: unknown): VaultIdentityRecord | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const { vaultId, pendingFrom } = raw as { vaultId?: unknown; pendingFrom?: unknown };
	if (typeof vaultId !== 'string' || !VAULT_ID.test(vaultId)) return null;
	return typeof pendingFrom === 'string' && VAULT_ID.test(pendingFrom) ? { vaultId, pendingFrom } : { vaultId };
}

/** The id the host's local storage remembers, for a caller that cannot reach the registry. */
export function savedVaultId(storage: TyrianLocalStoragePort | undefined): string | null {
	return storage === undefined ? null : parseRecord(storage.load(VAULT_IDENTITY_KEY))?.vaultId ?? null;
}

async function writeRecord(stores: VaultIdentityStores, record: VaultIdentityRecord): Promise<void> {
	stores.storage?.save(VAULT_IDENTITY_KEY, record);
	if (stores.token !== '') await writeRegistry(stores.factory, stores.token, record);
}

/**
 * Compares `currentId` with the last id this device used for this vault and records the current one. Returns the
 * relocation to ask about, or `null`. A device with nothing remembered (first start) just records. While the user
 * has not answered, every start asks again; coming back to the original path clears the question.
 */
export async function detectVaultRelocation(stores: VaultIdentityStores, currentId: string): Promise<VaultRelocation | null> {
	if (stores.storage === undefined && stores.token === '') return null;
	const fromRegistry = stores.token === '' ? null : parseRecord(await readRegistry(stores.factory, stores.token));
	const saved = fromRegistry ?? (stores.storage === undefined ? null : parseRecord(stores.storage.load(VAULT_IDENTITY_KEY)));
	if (saved === null) {
		await writeRecord(stores, { vaultId: currentId });
		return null;
	}
	if (saved.vaultId === currentId) {
		if (saved.pendingFrom === undefined) {
			// Memories that disagree (the registry knows the id, the local storage was renewed): bring them level.
			if (fromRegistry !== null) await writeRecord(stores, { vaultId: currentId });
			return null;
		}
		if (saved.pendingFrom === currentId) {
			await writeRecord(stores, { vaultId: currentId });
			return null;
		}
		return { previousVaultId: saved.pendingFrom };
	}
	// A second move before answering: the data are under the id that has some, else under the one still pending.
	const previousVaultId = !(await hasLocalData(stores.factory, saved.vaultId)) && saved.pendingFrom !== undefined
		? saved.pendingFrom : saved.vaultId;
	// Back to where it was before the first move: nothing moved.
	if (previousVaultId === currentId || !(await hasLocalData(stores.factory, previousVaultId))) {
		await writeRecord(stores, { vaultId: currentId });
		return null;
	}
	await writeRecord(stores, { vaultId: currentId, pendingFrom: previousVaultId });
	return { previousVaultId };
}

/** The user answered: the current id is recorded and nothing is pending. */
export async function settleVaultRelocation(stores: VaultIdentityStores, currentId: string): Promise<void> {
	await writeRecord(stores, { vaultId: currentId });
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
