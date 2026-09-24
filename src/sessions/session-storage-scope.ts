/**
 * H18.12: which IndexedDB databases hold ONE vault's session.
 *
 * IndexedDB is per origin, and every Obsidian window shares the origin `app://obsidian.md`: two
 * vaults open with this plugin used to read and write the same `tyrian-companion-session-runtime`
 * record and fight over the same `tyrian-companion-coordination` lease. A vault could restore the
 * other vault's session, write its note into the wrong vault, or be told another window was busy
 * when that window was a different vault. `App.loadLocalStorage` says the same thing from the other
 * side: Obsidian needs a "for this vault" variant because the plain storage is shared.
 *
 * Each vault now gets its own pair, `<name>:<vaultId>`, the same form the pilot metrics journal
 * already uses, keyed by the same `vaultId` every other vault-owned store in the plugin receives.
 *
 * The pair an earlier release wrote, without any vault in its name, is never migrated and never
 * deleted. Nothing in it says which vault wrote it, so the rule is deliberately simple:
 *
 * - The first vault that loads this release while that pair still holds a session record, and that
 *   has never opened its own pair, adopts the old pair IN PLACE: it keeps using both old databases
 *   under their old names, and writes an owner mark into the old runtime database so the decision
 *   survives restarts. Nothing is copied.
 * - Every other vault uses its own pair from then on, and never reads the old one again.
 * - An old pair with no session in it is not adopted by anyone: there is nothing to keep.
 *
 * Runtime and coordination are always adopted together, never one without the other: recovering a
 * saved session requires a lease from the same machine identity the record was fenced with, and
 * that identity lives in the coordination database.
 */

import { openIndexedDb } from '../core/indexed-db-open';
import { COORDINATION_DB_NAME } from './coordination-store';
import {
	SESSION_RUNTIME_DB_NAME,
	SESSION_RUNTIME_DB_VERSION,
	SESSION_RUNTIME_KEY,
	SESSION_RUNTIME_STORE_NAME,
} from './session-runtime-store';

/** Third key in the runtime object store (no schema upgrade), only ever written in the unscoped database. */
export const SESSION_STORAGE_LEGACY_OWNER_KEY = 'legacy-vault-owner';

/** Which vault adopted the unscoped databases an earlier release wrote. */
export interface SessionStorageLegacyOwner {
	version: 1;
	vaultId: string;
	claimedAt: number;
}

export interface SessionStorageNames {
	runtime: string;
	coordination: string;
	/** True only for the one vault that adopted the unscoped pair an earlier release wrote. */
	legacy: boolean;
}

/** The pair a vault uses when it did not adopt the old one. */
export function vaultSessionStorageNames(vaultId: string): SessionStorageNames {
	if (vaultId.length === 0) throw new Error('A vault id is required to scope session storage.');
	return {
		runtime: `${SESSION_RUNTIME_DB_NAME}:${vaultId}`,
		coordination: `${COORDINATION_DB_NAME}:${vaultId}`,
		legacy: false,
	};
}

const LEGACY_NAMES: SessionStorageNames = Object.freeze({
	runtime: SESSION_RUNTIME_DB_NAME,
	coordination: COORDINATION_DB_NAME,
	legacy: true,
});

/**
 * Decides, once, which pair this vault uses; see the module comment for the rule. Only reads the
 * list of databases unless the old runtime database exists, and never creates it: a fresh install
 * never gets an empty unscoped database just because this check ran.
 *
 * Without `IDBFactory.databases()` (every desktop Obsidian has it) it cannot tell whether its own
 * pair was already in use, so it does not guess: it takes its own pair and leaves the old one alone.
 */
export async function resolveSessionStorageNames(
	factory: IDBFactory,
	vaultId: string,
	now: () => number = Date.now,
): Promise<SessionStorageNames> {
	const own = vaultSessionStorageNames(vaultId);
	// The DOM typings declare it, but an injected factory may still predate it.
	const listDatabases = (factory as Partial<Pick<IDBFactory, 'databases'>>).databases;
	if (typeof listDatabases !== 'function') return own;
	const existing = new Set((await listDatabases.call(factory)).map((info) => info.name));
	if (!existing.has(SESSION_RUNTIME_DB_NAME)) return own;
	const database = await openIndexedDb({
		factory,
		databaseName: SESSION_RUNTIME_DB_NAME,
		databaseVersion: SESSION_RUNTIME_DB_VERSION,
		schema: [{ name: SESSION_RUNTIME_STORE_NAME }],
		onVersionChange: 'close',
		toError: (reason) => new Error(reason === 'blocked'
			? 'The earlier session storage was blocked.'
			: 'Could not open the earlier session storage.'),
	});
	let adopted: boolean;
	try {
		adopted = await claimLegacyStorage(database, vaultId, existing.has(own.runtime), now);
	} finally {
		database.close();
	}
	return adopted ? { ...LEGACY_NAMES } : own;
}

/**
 * Reads the owner mark and, only when nobody holds it, this vault never used its own pair and a
 * session record is there to keep, writes it for this vault. One `readwrite` transaction, so two
 * vaults loading at the same moment cannot both win.
 */
function claimLegacyStorage(
	database: IDBDatabase,
	vaultId: string,
	ownPairExists: boolean,
	now: () => number,
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		// A throw here rejects this promise: the executor runs synchronously inside it.
		const transaction = database.transaction(SESSION_RUNTIME_STORE_NAME, 'readwrite');
		const store = transaction.objectStore(SESSION_RUNTIME_STORE_NAME);
		const ownerRequest = store.get(SESSION_STORAGE_LEGACY_OWNER_KEY);
		// Presence only: counting never reads the snapshots a session record carries.
		const recordRequest = store.count(SESSION_RUNTIME_KEY);
		let adopted = false;
		recordRequest.onsuccess = () => {
			const owner = ownerRequest.result as unknown;
			if (owner !== undefined) {
				// A mark this release cannot read is somebody's claim too: it is left alone, never replaced.
				adopted = isSessionStorageLegacyOwner(owner) && owner.vaultId === vaultId;
				return;
			}
			if (ownPairExists || recordRequest.result === 0) return;
			const claim: SessionStorageLegacyOwner = { version: 1, vaultId, claimedAt: now() };
			store.put(claim, SESSION_STORAGE_LEGACY_OWNER_KEY);
			adopted = true;
		};
		transaction.oncomplete = () => resolve(adopted);
		transaction.onerror = () => reject(new Error('Could not read the earlier session storage owner.'));
		transaction.onabort = () => reject(new Error('The earlier session storage claim was aborted.'));
	});
}

export function isSessionStorageLegacyOwner(value: unknown): value is SessionStorageLegacyOwner {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return Object.keys(candidate).length === 3
		&& candidate.version === 1
		&& typeof candidate.vaultId === 'string' && candidate.vaultId.length > 0
		&& Number.isSafeInteger(candidate.claimedAt) && (candidate.claimedAt as number) >= 0;
}

/**
 * One vault's decision, shared by the runtime store and the lease coordinator so both always open
 * the same pair. Nothing is opened until one of them asks; a decision that failed (storage down) is
 * not remembered, so the next ask tries again, and one that succeeded holds for the whole run.
 */
export class SessionStorageScope {
	private resolved: SessionStorageNames | null = null;
	private pending: Promise<SessionStorageNames> | null = null;

	constructor(
		private readonly factory: IDBFactory,
		private readonly vaultId: string,
		private readonly now: () => number = Date.now,
	) {}

	async names(): Promise<SessionStorageNames> {
		if (this.resolved) return { ...this.resolved };
		const pending = this.pending ?? resolveSessionStorageNames(this.factory, this.vaultId, this.now);
		this.pending = pending;
		try {
			const names = await pending;
			this.resolved ??= names;
			return { ...this.resolved };
		} finally {
			if (this.pending === pending) this.pending = null;
		}
	}

	async runtimeDatabaseName(): Promise<string> {
		return (await this.names()).runtime;
	}

	async coordinationDatabaseName(): Promise<string> {
		return (await this.names()).coordination;
	}
}
