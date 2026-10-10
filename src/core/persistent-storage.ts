import type { LocalDebugPersistenceProbe } from './local-debug-persistence';

/**
 * What the host's storage manager answered when asked to keep this origin's data: `granted`, `denied`, or
 * `unavailable` where there is nothing to ask or asking failed.
 */
export type PersistentStorageResult = 'granted' | 'denied' | 'unavailable';

/** What is read of the host's `navigator.storage`: the request itself and, where the host has one, `estimate`. */
export type PersistentStorageManager = Pick<StorageManager, 'persist'> & Partial<Pick<StorageManager, 'estimate'>>;

const MIB = 1024 * 1024;

/**
 * Asks the engine not to evict this origin's storage when the disk runs short (`navigator.storage.persist()`,
 * DU-13, 10 Oct 2026), and records its answer in the local diagnostic log by the persistence probe every store
 * uses: store `origin_storage`, operation `open`, `result` `granted`, `denied` or `unavailable`. Once it answered,
 * the same line carries the origin's `estimate()` where the manager has one: `usageMiB` and `quotaMiB`, in whole MiB
 * (rounded, so the line says how full the origin is without the exact byte counts). An estimate that is missing or
 * fails leaves them out and changes nothing else.
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
	let manager: PersistentStorageManager;
	let answer: unknown;
	try {
		const storage = readStorage();
		if (typeof storage?.persist !== 'function') {
			attempt.skip('skipped', { result: 'unavailable', reason: 'no_api' });
			return 'unavailable';
		}
		manager = storage;
		answer = await storage.persist();
	} catch {
		attempt.skip('unavailable', { result: 'unavailable', reason: 'request_failed' });
		return 'unavailable';
	}
	const estimate = await originEstimate(manager);
	if (answer === true) {
		attempt.success('ok', { result: 'granted', ...estimate });
		return 'granted';
	}
	if (answer === false) {
		attempt.skip('permission_denied', { result: 'denied', ...estimate });
		return 'denied';
	}
	attempt.skip('unavailable', { result: 'unavailable', reason: 'unexpected_answer', ...estimate });
	return 'unavailable';
}

/**
 * `usageMiB` and `quotaMiB` of the origin from the manager's own `estimate()` (called on itself), each only when the
 * engine gave a finite, non-negative number; nothing at all where there is no `estimate` or it throws or rejects.
 */
async function originEstimate(storage: PersistentStorageManager): Promise<Record<string, string>> {
	if (typeof storage.estimate !== 'function') return {};
	let estimate: unknown;
	try {
		estimate = await storage.estimate();
	} catch {
		// Only the figures are lost: the answer to `persist()` is already known and is recorded without them.
		return {};
	}
	const detail: Record<string, string> = {};
	const usage = wholeMiB(estimate, 'usage');
	if (usage !== undefined) detail.usageMiB = usage;
	const quota = wholeMiB(estimate, 'quota');
	if (quota !== undefined) detail.quotaMiB = quota;
	return detail;
}

/** One field of an estimate in whole MiB, or undefined when it is not a finite, non-negative number. */
function wholeMiB(estimate: unknown, field: 'usage' | 'quota'): string | undefined {
	if (typeof estimate !== 'object' || estimate === null) return undefined;
	const bytes = (estimate as Partial<Record<typeof field, unknown>>)[field];
	return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? String(Math.round(bytes / MIB)) : undefined;
}
