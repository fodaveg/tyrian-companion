/**
 * R1b: what this DEVICE keeps about itself as a collector, outside `data.json`.
 *
 * Both values have to be LOCAL: `data.json` travels with Obsidian Sync's plugin settings, so an id
 * kept there would make two synced computers the same "installation" (the status note could never
 * tell them apart), and a mode kept there would switch every synced device to consult at once. They
 * live in the host's `kv` IndexedDB instead, which no host syncs, keyed by `vaultId` because
 * Obsidian shares one IndexedDB between every vault it opens. Hebra reaches the same code through
 * its own `host.kv`.
 * - the installation id the collector's footprint names (`collector-status.ts`);
 * - the collector/consult mode (`CollectorMode`).
 */

import { openIndexedDb } from '../core/indexed-db-open';
import type { CollectorMode } from '../core/settings';
import { StorageDeadline } from '../sessions/storage-deadline';

/** The read ran out of time and is still in course: the one failure of a read that can still answer. */
export class CollectorReadUnansweredError extends Error {
	constructor() { super('Collector instance store did not answer.'); }
}

export const COLLECTOR_INSTANCE_DB = 'tyrian-companion-collector';
const STORE = 'instance-v1';
const INSTANCE_ID = /^[A-Za-z0-9-]{8,64}$/u;

/**
 * The id this installation already has for `vaultId`, or a new one stored in the same
 * transaction, so two windows opening at once still agree on a single id. Rejects when IndexedDB
 * is unavailable; the caller then runs without a heartbeat rather than with a throwaway id.
 */
export async function loadCollectorInstanceId(
	factory: IDBFactory,
	vaultId: string,
	createId: () => string = () => crypto.randomUUID(),
): Promise<string> {
	return await readOrSeed(factory, `instance:${vaultId}`, vaultId, isInstanceId, createId, false);
}

/**
 * This device's mode for `vaultId`. The first time there is none, `seed` decides it (the spec's
 * rule, `collectorModeSeed`) and it is stored in the same transaction; from then on the stored
 * mode wins, whatever a synced `data.json` later says. Rejects when IndexedDB is unavailable.
 *
 * The caller does not wait past the storage deadline (the plugin does not start until this settles): it is told the store
 * did not answer. The read itself is NOT abandoned: if it answers later, `onLate` is given the value the store holds, so
 * a mode saved on this device is not lost to the seed the start fell back on.
 */
export async function loadCollectorMode(
	factory: IDBFactory,
	vaultId: string,
	seed: () => CollectorMode,
	onLate?: (stored: CollectorMode | null) => void,
): Promise<CollectorMode> {
	return await readOrSeed(factory, `mode:${vaultId}`, vaultId, isCollectorMode, seed, false, onLate);
}

/**
 * The mode this device stored for `vaultId`, or `null` when there is none. Unlike `loadCollectorMode` it
 * never seeds: it is how DU-02 reads what an OLD vault id kept without leaving an entry behind.
 */
export async function readStoredCollectorMode(factory: IDBFactory, vaultId: string): Promise<CollectorMode | null> {
	if (!/^[a-f0-9]{64}$/u.test(vaultId)) throw new Error('Collector instance vault identity is invalid.');
	const database = await openIndexedDb({
		factory,
		databaseName: COLLECTOR_INSTANCE_DB,
		databaseVersion: 1,
		schema: [{ name: STORE }],
		onVersionChange: 'close',
		toError: () => new Error('Collector instance store could not be opened.'),
	});
	try {
		return await new Promise<CollectorMode | null>((resolve, reject) => {
			const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(`mode:${vaultId}`);
			request.onsuccess = () => {
				const stored = request.result as unknown;
				resolve(isCollectorMode(stored) ? stored : null);
			};
			request.onerror = () => { reject(new Error('Collector instance value could not be read.')); };
		});
	} finally {
		database.close();
	}
}

/** Stores this device's mode for `vaultId`; the only way it changes after the seed. */
export async function saveCollectorMode(factory: IDBFactory, vaultId: string, mode: CollectorMode): Promise<void> {
	await readOrSeed(factory, `mode:${vaultId}`, vaultId, isCollectorMode, () => mode, true);
}

function isInstanceId(value: unknown): value is string {
	return typeof value === 'string' && INSTANCE_ID.test(value);
}

function isCollectorMode(value: unknown): value is CollectorMode {
	return value === 'collector' || value === 'consult';
}

/**
 * Reads `key`; when it is absent or invalid, or `overwrite` is set, writes `create()` in the same
 * transaction. Resolves the value the store holds afterwards.
 */
async function readOrSeed<T extends string>(
	factory: IDBFactory,
	key: string,
	vaultId: string,
	valid: (stored: unknown) => stored is T,
	create: () => T,
	overwrite: boolean,
	onLate?: (stored: T | null) => void,
): Promise<T> {
	if (!/^[a-f0-9]{64}$/u.test(vaultId)) throw new Error('Collector instance vault identity is invalid.');
	const database = await openIndexedDb({
		factory,
		databaseName: COLLECTOR_INSTANCE_DB,
		databaseVersion: 1,
		schema: [{ name: STORE }],
		onVersionChange: 'close',
		toError: () => new Error('Collector instance store could not be opened.'),
	});
	// 9 Oct 2026: the plugin does not start until this settles, and a transaction the engine takes and never answers settles
	// nothing. The wait of a READ ends as a failed read does (the caller falls back to its seed); the transaction stays in
	// course, closes the database whenever it ends and hands a late answer (or `null`, if it ends without one) to `onLate`. A WRITE the user asked for (`overwrite`)
	// has no deadline: failing it while it can still land would show a failure for a mode that changes at the next start.
	const transaction = new Promise<T>((resolve, reject) => {
		const transaction = database.transaction(STORE, 'readwrite');
		const store = transaction.objectStore(STORE);
		const request = store.get(key);
		let value: T | null = null;
		request.onsuccess = () => {
			const stored = request.result as unknown;
			if (!overwrite && valid(stored)) { value = stored; return; }
			value = create();
			// Never store what a later read would reject; the abort rejects below.
			if (valid(value)) store.put(value, key);
			else transaction.abort();
		};
		transaction.oncomplete = () => {
			database.close();
			if (value !== null && valid(value)) resolve(value);
			else reject(new Error('Collector instance value is invalid.'));
		};
		transaction.onerror = () => { database.close(); reject(new Error('Collector instance value could not be read.')); };
		transaction.onabort = () => { database.close(); reject(new Error('Collector instance value read was aborted.')); };
	});
	if (overwrite) return await transaction;
	return await new StorageDeadline().bounded(() => transaction, () => {
		// `null`: the read ended without a value, so nothing is left that could still answer.
		if (onLate !== undefined) transaction.then(onLate, () => { onLate(null); });
		return Promise.reject(new CollectorReadUnansweredError());
	});
}
