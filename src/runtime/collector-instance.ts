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
 */
export async function loadCollectorMode(
	factory: IDBFactory,
	vaultId: string,
	seed: () => CollectorMode,
): Promise<CollectorMode> {
	return await readOrSeed(factory, `mode:${vaultId}`, vaultId, isCollectorMode, seed, false);
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
	return await new Promise<T>((resolve, reject) => {
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
}
