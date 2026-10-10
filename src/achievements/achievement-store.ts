import {
	parseAccountAchievements,
	type AccountAchievementEntry,
} from '../account/account-achievements';
import type { CatalogLocale } from '../catalog/public-catalog-model';
import {
	IndexedDbConnectionLostError,
	openIndexedDb,
	startIndexedDbTransaction,
	withIndexedDbReopen,
} from '../core/indexed-db-open';
import { LocalDebugPersistenceProbe, localDebugStorageFailureCode } from '../core/local-debug-persistence';

/**
 * The local storage of the «Logros» section: its own IndexedDB, opened on first use and never at
 * plugin load.
 *
 * - `public-v1`: what the public API said (groups, categories, pages of the search index, details
 *   of the tracked achievements). Keyed by language and never by vault, with the same reasoning as
 *   `tyrian-companion-public-catalog`: the content is public and identical for every vault. Each
 *   record carries the time it was saved; how long it is trusted is the service's decision.
 * - `progress-v1`: the last reading of the account, keyed by `vaultId` (Obsidian shares one
 *   IndexedDB across all its vaults) and holding only the tracked achievements, under the hashed
 *   account reference. The account id itself is never stored.
 *
 * No method throws: a storage failure reads as "nothing kept" and a write answers `false`, so a
 * broken store degrades the section to the network and never breaks it.
 */
export const ACHIEVEMENTS_DB_NAME = 'tyrian-companion-achievements';
export const ACHIEVEMENTS_DB_VERSION = 1;
export const ACHIEVEMENTS_PUBLIC_STORE = 'public-v1';
export const ACHIEVEMENTS_PROGRESS_STORE = 'progress-v1';

/** The kinds of public record; `index-page` and `detail` carry a number (page index or achievement id). */
export type AchievementPublicKind = 'groups' | 'categories' | 'index-page' | 'detail';

export interface AchievementPublicRecord {
	key: string;
	/** Epoch milliseconds of the save. */
	savedAt: number;
	value: unknown;
}

/** The last reading of the account, as `progress-v1` keeps it for one vault. */
export interface StoredTrackedProgress {
	/** Hashed account reference (`tracked-progress-service.ts`), never the account id. */
	accountRef: string;
	/** ISO instant of the reading. */
	capturedAt: string;
	entries: AccountAchievementEntry[];
}

/** The part of the store the catalog service uses. */
export interface AchievementPublicStore {
	/** The valid records among `keys`; a missing, foreign or unreadable one is simply absent. */
	readPublic(keys: readonly string[]): Promise<Map<string, AchievementPublicRecord>>;
	/** All records in one transaction, all or nothing. */
	writePublic(records: readonly AchievementPublicRecord[]): Promise<boolean>;
}

/** The part of the store the progress service uses. */
export interface TrackedProgressStore {
	/**
	 * The vault's last reading. With an `accountRef`, a reading of another account is discarded
	 * (answers null); with null, whatever is kept is answered.
	 */
	readProgress(vaultId: string, accountRef: string | null): Promise<StoredTrackedProgress | null>;
	/** Replaces the vault's reading; refuses one that does not validate. */
	writeProgress(vaultId: string, progress: StoredTrackedProgress): Promise<boolean>;
}

export function achievementPublicKey(locale: CatalogLocale, kind: AchievementPublicKind, part?: number): string {
	return part === undefined ? `${locale}:${kind}` : `${locale}:${kind}:${String(part)}`;
}

const RECORD_VERSION = 1;

/** The IndexedDB adapter. One connection, opened lazily and reopened once if the engine drops it. */
export class IndexedDbAchievementStore implements AchievementPublicStore, TrackedProgressStore {
	private database: IDBDatabase | null = null;
	private opening: Promise<IDBDatabase> | null = null;
	private disposed = false;

	constructor(
		private readonly factory: IDBFactory,
		private readonly databaseName = ACHIEVEMENTS_DB_NAME,
		private readonly diagnostics = new LocalDebugPersistenceProbe(),
	) {}

	async readPublic(keys: readonly string[]): Promise<Map<string, AchievementPublicRecord>> {
		const found = new Map<string, AchievementPublicRecord>();
		if (keys.length === 0) return found;
		const raws = await this.run('read', ACHIEVEMENTS_PUBLIC_STORE, 'readonly', (store) => keys.map((key) => store.get(key)));
		if (raws === null) return found;
		keys.forEach((key, index) => {
			const record = parsePublicRecord(raws[index], key);
			if (record !== null) found.set(key, record);
		});
		return found;
	}

	async writePublic(records: readonly AchievementPublicRecord[]): Promise<boolean> {
		if (records.length === 0) return true;
		if (!records.every((record) => typeof record.key === 'string' && validSavedAt(record.savedAt))) return false;
		const written = await this.run('write', ACHIEVEMENTS_PUBLIC_STORE, 'readwrite', (store) => records.map((record) =>
			store.put({ version: RECORD_VERSION, key: record.key, savedAt: record.savedAt, value: record.value }, record.key)));
		return written !== null;
	}

	async readProgress(vaultId: string, accountRef: string | null): Promise<StoredTrackedProgress | null> {
		const raws = await this.run('read', ACHIEVEMENTS_PROGRESS_STORE, 'readonly', (store) => [store.get(vaultId)]);
		const progress = raws === null ? null : parseProgressRecord(raws[0], vaultId);
		if (progress === null) return null;
		return accountRef !== null && progress.accountRef !== accountRef ? null : progress;
	}

	async writeProgress(vaultId: string, progress: StoredTrackedProgress): Promise<boolean> {
		const record = {
			version: RECORD_VERSION,
			vaultId,
			accountRef: progress.accountRef,
			capturedAt: progress.capturedAt,
			entries: progress.entries.map(apiShapedEntry),
		};
		if (parseProgressRecord(record, vaultId) === null) return false;
		const written = await this.run('write', ACHIEVEMENTS_PROGRESS_STORE, 'readwrite', (store) => [store.put(record, vaultId)]);
		return written !== null;
	}

	/** Closes the connection; every later call answers as a store with nothing kept. */
	dispose(): void {
		this.disposed = true;
		this.database?.close();
		this.database = null;
	}

	/**
	 * Issues `requests` in one transaction and answers their results once it completes, or null
	 * when storage failed (closed, refused, aborted, unanswered in time).
	 */
	private async run(
		operation: 'read' | 'write',
		storeName: string,
		mode: IDBTransactionMode,
		requests: (store: IDBObjectStore) => IDBRequest[],
	): Promise<unknown[] | null> {
		const attempt = this.diagnostics.begin('achievements', operation);
		try {
			const results = await withIndexedDbReopen({
				open: async () => await this.open(),
				discard: (database) => { this.discard(database); },
			}, async (database) => await new Promise<unknown[]>((resolve, reject) => {
				// A throw here rejects this promise: the executor runs synchronously inside it.
				const transaction = startIndexedDbTransaction(database, storeName, mode);
				const issued = requests(transaction.objectStore(storeName));
				transaction.oncomplete = () => resolve(issued.map((request) => request.result as unknown));
				transaction.onerror = () => reject(transaction.error ?? new Error('Achievement storage failed.'));
				transaction.onabort = () => reject(transaction.error ?? new Error('Achievement storage was aborted.'));
			}));
			attempt.success();
			return results;
		} catch (error) {
			attempt.failure(localDebugStorageFailureCode(error), error);
			return null;
		}
	}

	private async open(): Promise<IDBDatabase> {
		if (this.disposed) throw new IndexedDbConnectionLostError(null);
		if (this.database) return this.database;
		if (this.opening) return await this.opening;
		const opening = openIndexedDb({
			factory: this.factory,
			databaseName: this.databaseName,
			databaseVersion: ACHIEVEMENTS_DB_VERSION,
			schema: [{ name: ACHIEVEMENTS_PUBLIC_STORE }, { name: ACHIEVEMENTS_PROGRESS_STORE }],
			accept: () => !this.disposed,
			onVersionChange: (database, kind) => {
				if (this.database === database) this.database = null;
				// A newer build owns the schema now: opening again would only fail against it.
				if (kind === 'upgrade') this.disposed = true;
			},
			onClose: (database) => { this.discard(database); },
			toError: (reason) => new Error(`Could not open the achievements storage (${reason}).`),
		});
		this.opening = opening;
		try {
			this.database = await opening;
			return this.database;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
	}

	/** Forgets a connection the engine closed or that no longer starts transactions. */
	private discard(database: IDBDatabase): void {
		if (this.database === database) this.database = null;
		database.close();
	}
}

function parsePublicRecord(raw: unknown, key: string): AchievementPublicRecord | null {
	if (!isRecord(raw) || raw.version !== RECORD_VERSION || raw.key !== key || !validSavedAt(raw.savedAt) || !('value' in raw)) return null;
	return { key, savedAt: raw.savedAt, value: raw.value };
}

/**
 * Validates a kept reading with the same `full` parser the API answer went through: the entries are
 * stored in the API's own shape (`apiShapedEntry`), so one validator serves both.
 */
function parseProgressRecord(raw: unknown, vaultId: string): StoredTrackedProgress | null {
	if (!isRecord(raw) || raw.version !== RECORD_VERSION || raw.vaultId !== vaultId) return null;
	if (typeof raw.accountRef !== 'string' || !/^[a-f0-9]{8,64}$/u.test(raw.accountRef)) return null;
	if (typeof raw.capturedAt !== 'string' || Number.isNaN(Date.parse(raw.capturedAt))
		|| new Date(Date.parse(raw.capturedAt)).toISOString() !== raw.capturedAt) return null;
	const entries = parseAccountAchievements(raw.entries, 'full');
	return entries === null ? null : { accountRef: raw.accountRef, capturedAt: raw.capturedAt, entries };
}

/** The entry as `account/achievements` answers it: the fields the API omits are left out, not null. */
function apiShapedEntry(entry: AccountAchievementEntry): Record<string, unknown> {
	return {
		id: entry.id,
		done: entry.done,
		...(entry.current === null ? {} : { current: entry.current }),
		...(entry.max === null ? {} : { max: entry.max }),
		...(entry.repeated === null ? {} : { repeated: entry.repeated }),
		...(entry.bits === null ? {} : { bits: [...entry.bits] }),
	};
}

function validSavedAt(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
