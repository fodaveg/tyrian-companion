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
 * the same line carries the origin's `estimate()` where the manager has one: `usageMiB`, the usage in whole MiB, and
 * `quotaUsedBand`, the band the usage over the quota falls in (`<50`, `50-80`, `80-95` or `>=95` per cent). That says how
 * close the origin is to eviction without the quota, which gives the size of the disk away: an exact share would give
 * it back from the usage beside it, so only the band is kept, and never the exact byte counts. An estimate
 * that is missing or fails, or a figure that is not a finite, non-negative number, leaves them out and changes nothing else.
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
 * `usageMiB` and `quotaUsedBand` of the origin from the manager's own `estimate()` (called on itself): the usage only
 * when the engine gave a finite, non-negative number, and the band only with it and a positive quota; nothing at all
 * where there is no `estimate` or it throws or rejects.
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
	const usage = estimateBytes(estimate, 'usage');
	if (usage === undefined) return detail;
	detail.usageMiB = String(Math.round(usage / MIB));
	const quota = estimateBytes(estimate, 'quota');
	// The quota never goes to the log, not even as an exact share: with the usage beside it, the share gives the quota back,
	// and the quota gives the size of the disk away. Only the band the share falls in.
	if (quota !== undefined && quota > 0) detail.quotaUsedBand = quotaUsedBand(usage / quota);
	return detail;
}

/** The bands of `quotaUsedBand`: how close the origin is to eviction, coarse enough not to give the quota back. */
export const QUOTA_USED_BANDS = ['<50', '50-80', '80-95', '>=95'] as const;
export type QuotaUsedBand = typeof QUOTA_USED_BANDS[number];

/** The band of a share of the quota (`used / quota`, 0 or more; above 1 when the engine reports more usage than quota). */
export function quotaUsedBand(share: number): QuotaUsedBand {
	if (share < 0.5) return '<50';
	if (share < 0.8) return '50-80';
	if (share < 0.95) return '80-95';
	return '>=95';
}

/** One field of an estimate in bytes, or undefined when it is not a finite, non-negative number. */
function estimateBytes(estimate: unknown, field: 'usage' | 'quota'): number | undefined {
	if (typeof estimate !== 'object' || estimate === null) return undefined;
	const bytes = (estimate as Partial<Record<typeof field, unknown>>)[field];
	return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}
