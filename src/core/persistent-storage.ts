import type { LocalDebugPersistenceProbe } from './local-debug-persistence';

/**
 * What the host's storage manager answered when asked to keep this origin's data: `granted`, `denied`, or
 * `unavailable` where there is nothing to ask or asking failed.
 */
export type PersistentStorageResult = 'granted' | 'denied' | 'unavailable';

/** What is read of the host's `navigator.storage`: only the request itself, never `estimate`. */
export type PersistentStorageManager = Pick<StorageManager, 'persist'>;

/**
 * Asks the engine not to evict this origin's storage when the disk runs short (`navigator.storage.persist()`,
 * DU-13, 10 Oct 2026), and records its answer in the local diagnostic log by the persistence probe every store
 * uses: store `origin_storage`, operation `open`, `result` `granted`, `denied` or `unavailable`.
 *
 * Until it is granted, IndexedDB is «best effort»: an engine short of disk may drop the whole origin, and with it
 * the only copy of what the user wrote by hand (the inventory preferences). The request changes nothing else, and
 * an engine is free to answer it without asking anybody.
 *
 * The manager is the host's (`TyrianKvPort.storage`), never a global read here. `readStorage` hands it over when
 * asked, so a host whose getter throws is one more `unavailable`, and it is called on itself, never through a
 * `persist` kept apart from it. Nobody waits for the answer: the start goes on whatever it is, or if it never comes.
 * Nothing is thrown: a manager that is missing, rejects or throws answers `unavailable`.
 */
export async function requestPersistentStorage(
	readStorage: () => PersistentStorageManager | null | undefined,
	diagnostics: LocalDebugPersistenceProbe,
): Promise<PersistentStorageResult> {
	const attempt = diagnostics.begin('origin_storage', 'open');
	let answer: unknown;
	try {
		const storage = readStorage();
		if (typeof storage?.persist !== 'function') {
			attempt.skip('skipped', { result: 'unavailable', reason: 'no_api' });
			return 'unavailable';
		}
		answer = await storage.persist();
	} catch {
		attempt.skip('unavailable', { result: 'unavailable', reason: 'request_failed' });
		return 'unavailable';
	}
	if (answer === true) {
		attempt.success('ok', { result: 'granted' });
		return 'granted';
	}
	if (answer === false) {
		attempt.skip('permission_denied', { result: 'denied' });
		return 'denied';
	}
	attempt.skip('unavailable', { result: 'unavailable', reason: 'unexpected_answer' });
	return 'unavailable';
}
