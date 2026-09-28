/**
 * R1b: the installation id the collector's footprint names (`collector-status.ts`).
 *
 * It has to be stable across reloads and LOCAL: `data.json` travels with Obsidian Sync, so an id
 * kept there would make two synced computers the same "installation" and the status note could
 * never tell them apart. It lives in the host's `kv` IndexedDB instead, which no host syncs, keyed
 * by `vaultId` because Obsidian shares one IndexedDB between every vault it opens.
 */

import { openIndexedDb } from '../core/indexed-db-open';

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
	if (!/^[a-f0-9]{64}$/u.test(vaultId)) throw new Error('Collector instance vault identity is invalid.');
	const database = await openIndexedDb({
		factory,
		databaseName: COLLECTOR_INSTANCE_DB,
		databaseVersion: 1,
		schema: [{ name: STORE }],
		onVersionChange: 'close',
		toError: () => new Error('Collector instance store could not be opened.'),
	});
	const key = `instance:${vaultId}`;
	return await new Promise<string>((resolve, reject) => {
		const transaction = database.transaction(STORE, 'readwrite');
		const store = transaction.objectStore(STORE);
		const request = store.get(key);
		let id: string | null = null;
		request.onsuccess = () => {
			const stored = request.result as unknown;
			if (typeof stored === 'string' && INSTANCE_ID.test(stored)) { id = stored; return; }
			id = createId();
			store.put(id, key);
		};
		transaction.oncomplete = () => {
			database.close();
			if (id !== null && INSTANCE_ID.test(id)) resolve(id);
			else reject(new Error('Collector instance id is invalid.'));
		};
		transaction.onerror = () => { database.close(); reject(new Error('Collector instance id could not be read.')); };
		transaction.onabort = () => { database.close(); reject(new Error('Collector instance id read was aborted.')); };
	});
}
