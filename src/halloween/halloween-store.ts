import {
	isHalloweenObservation,
	type HalloweenAlertItem,
	type HalloweenBackfillCandidate,
	type HalloweenNoticeV1,
	type HalloweenObservationV1,
} from './halloween-model';

export const HALLOWEEN_DB_NAME = 'tyrian-companion-halloween';
export const HALLOWEEN_DB_VERSION = 2;
export const HALLOWEEN_OBSERVATION_STORE = 'observations-v1';
export const HALLOWEEN_SEEN_STORE = 'seen-items-v1';
export const HALLOWEEN_NOTICE_STORE = 'notices-v1';
export const HALLOWEEN_EPISODE_STORE = 'notice-episodes-v1';
export const HALLOWEEN_META_STORE = 'meta-v1';

export type HalloweenStoreFailure = 'unavailable' | 'blocked' | 'future_schema' | 'corrupt' | 'quota';

export class HalloweenStoreError extends Error {
	constructor(readonly failure: HalloweenStoreFailure) {
		super(`Halloween storage is ${failure}.`);
		this.name = 'HalloweenStoreError';
	}
}

interface StoredObservationV1 extends HalloweenObservationV1 {
	firstSeenItemIds: number[];
}

export interface HalloweenObservationReceipt {
	status: 'recorded' | 'duplicate';
	firstSeenItemIds: number[];
}

/** Dedicated fail-closed store. Observation idempotence and first-seen are one transaction. */
export class IndexedDbHalloweenStore {
	private closed = false;

	constructor(private readonly database: IDBDatabase) {
		database.onversionchange = () => { this.closed = true; database.close(); };
	}

	static open(
		factory: IDBFactory,
		databaseName = HALLOWEEN_DB_NAME,
		databaseVersion = HALLOWEEN_DB_VERSION,
	): Promise<IndexedDbHalloweenStore> {
		return new Promise((resolve, reject) => {
			const request = factory.open(databaseName, databaseVersion);
			let settled = false;
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(HALLOWEEN_OBSERVATION_STORE)) {
					db.createObjectStore(HALLOWEEN_OBSERVATION_STORE, { keyPath: ['vaultId', 'accountRef', 'observationId'] });
				}
				if (!db.objectStoreNames.contains(HALLOWEEN_SEEN_STORE)) {
					db.createObjectStore(HALLOWEEN_SEEN_STORE, { keyPath: ['vaultId', 'accountRef', 'itemId'] });
				}
				if (!db.objectStoreNames.contains(HALLOWEEN_NOTICE_STORE)) {
					const notices = db.createObjectStore(HALLOWEEN_NOTICE_STORE, { keyPath: ['vaultId', 'accountRef', 'noticeId'] });
					notices.createIndex('by-scope-observed', ['vaultId', 'accountRef', 'observedAt']);
				}
				if (!db.objectStoreNames.contains(HALLOWEEN_EPISODE_STORE)) {
					db.createObjectStore(HALLOWEEN_EPISODE_STORE, { keyPath: ['vaultId', 'accountRef', 'episodeId', 'itemId'] });
				}
				if (!db.objectStoreNames.contains(HALLOWEEN_META_STORE)) {
					db.createObjectStore(HALLOWEEN_META_STORE, { keyPath: ['vaultId', 'accountRef'] });
				}
			};
			request.onerror = () => fail(new HalloweenStoreError(request.error?.name === 'VersionError' ? 'future_schema' : 'unavailable'));
			request.onblocked = () => fail(new HalloweenStoreError('blocked'));
			request.onsuccess = () => {
				if (settled) { request.result.close(); return; }
				settled = true;
				resolve(new IndexedDbHalloweenStore(request.result));
			};
			function fail(error: HalloweenStoreError): void { if (!settled) reject(error); settled = true; }
		});
	}

	async applyBackfill(
		vaultId: string,
		accountRef: string,
		candidates: readonly HalloweenBackfillCandidate[],
		completedAt: string,
	): Promise<number[]> {
		if (!isIso(completedAt) || !strictBackfill(candidates)) throw new HalloweenStoreError('corrupt');
		const ids = new Set<number>();
		for (const candidate of candidates) {
			candidate.gains.forEach(({ itemId }) => ids.add(itemId));
			await this.recordObservation({
				version: 1, vaultId, accountRef, source: 'legacy_backfill', ...structuredClone(candidate),
			});
		}
		await this.run([HALLOWEEN_META_STORE], 'readwrite', (tx, resolve) => {
			tx.objectStore(HALLOWEEN_META_STORE).put({ version: 1, vaultId, accountRef, completedAt,
				coverage: candidates.some(({ coverage }) => coverage === 'partial') ? 'partial' : 'complete' });
			tx.oncomplete = () => resolve(undefined);
		});
		return [...ids].sort((left, right) => left - right);
	}

	readLearningCoverage(vaultId: string, accountRef: string): Promise<'complete' | 'partial' | null> {
		return this.run([HALLOWEEN_META_STORE], 'readonly', (tx, resolve, reject) => {
			const request = tx.objectStore(HALLOWEEN_META_STORE).get([vaultId, accountRef]);
			request.onerror = () => reject(storeError(request.error));
			request.onsuccess = () => {
				try {
					if (request.result === undefined) { tx.oncomplete = () => resolve(null); return; }
					const coverage = parseMeta(request.result, vaultId, accountRef);
					tx.oncomplete = () => resolve(coverage);
				} catch (error) { reject(error); tx.abort(); }
			};
		});
	}

	recordObservation(observation: HalloweenObservationV1): Promise<HalloweenObservationReceipt> {
		if (!isHalloweenObservation(observation)) return Promise.reject(new HalloweenStoreError('corrupt'));
		return this.run([HALLOWEEN_OBSERVATION_STORE, HALLOWEEN_SEEN_STORE], 'readwrite', (tx, resolve, reject) => {
			const observations = tx.objectStore(HALLOWEEN_OBSERVATION_STORE);
			const seen = tx.objectStore(HALLOWEEN_SEEN_STORE);
			const existing = observations.get([observation.vaultId, observation.accountRef, observation.observationId]);
			existing.onerror = () => reject(storeError(existing.error));
			existing.onsuccess = () => {
				if (existing.result !== undefined) {
					try {
						const parsed = parseStoredObservation(existing.result);
						if (canonicalObservation(parsed) !== canonicalObservation(observation)) throw new HalloweenStoreError('corrupt');
						tx.oncomplete = () => resolve({ status: 'duplicate', firstSeenItemIds: [...parsed.firstSeenItemIds] });
					} catch (error) { reject(error); tx.abort(); }
					return;
				}
				const firstSeenItemIds: number[] = [];
				const visit = (index: number): void => {
					const gain = observation.gains[index];
					if (!gain) {
						observations.put({ ...structuredClone(observation), firstSeenItemIds } satisfies StoredObservationV1);
						tx.oncomplete = () => resolve({ status: 'recorded', firstSeenItemIds: [...firstSeenItemIds] });
						return;
					}
					const request = seen.get([observation.vaultId, observation.accountRef, gain.itemId]);
					request.onerror = () => reject(storeError(request.error));
					request.onsuccess = () => {
						try {
							if (request.result === undefined) firstSeenItemIds.push(gain.itemId);
							else parseSeen(request.result, observation.vaultId, observation.accountRef, gain.itemId);
							seen.put({ version: 1, vaultId: observation.vaultId, accountRef: observation.accountRef,
								itemId: gain.itemId, lastObservedAt: observation.observedAt });
							visit(index + 1);
						} catch (error) { reject(error); tx.abort(); }
					};
				};
				try { visit(0); } catch (error) { reject(error); tx.abort(); }
			};
		});
	}

	enqueueNotice(notice: HalloweenNoticeV1): Promise<HalloweenNoticeV1 | null> {
		if (!validNotice(notice)) return Promise.reject(new HalloweenStoreError('corrupt'));
		return this.run([HALLOWEEN_NOTICE_STORE, HALLOWEEN_EPISODE_STORE], 'readwrite', (tx, resolve, reject) => {
			const notices = tx.objectStore(HALLOWEEN_NOTICE_STORE);
			const episodes = tx.objectStore(HALLOWEEN_EPISODE_STORE);
			const retained: HalloweenAlertItem[] = [];
			const visit = (index: number): void => {
				const item = notice.items[index];
				if (!item) {
					if (retained.length > 0) notices.put({ ...structuredClone(notice), items: retained });
					tx.oncomplete = () => resolve(retained.length === 0 ? null : { ...structuredClone(notice), items: retained });
					return;
				}
				const key = [notice.vaultId, notice.accountRef, notice.episodeId, item.itemId];
				const request = episodes.get(key);
				request.onerror = () => reject(storeError(request.error));
				request.onsuccess = () => {
					try {
						if (request.result === undefined) {
							retained.push(structuredClone(item));
							episodes.put({ version: 1, vaultId: notice.vaultId, accountRef: notice.accountRef,
								episodeId: notice.episodeId, itemId: item.itemId, noticeId: notice.noticeId });
						} else parseEpisode(request.result, notice.vaultId, notice.accountRef, notice.episodeId, item.itemId);
						visit(index + 1);
					} catch (error) { reject(error); tx.abort(); }
				};
			};
			try { visit(0); } catch (error) { reject(error); tx.abort(); }
		});
	}

	/** Replaces every provisional notice for one accepted session without emitting a new foreground event. */
	replaceEpisodeNotice(
		vaultId: string,
		accountRef: string,
		episodeId: string,
		notice: HalloweenNoticeV1 | null,
	): Promise<HalloweenNoticeV1 | null> {
		if (notice !== null && (!validNotice(notice) || notice.vaultId !== vaultId || notice.accountRef !== accountRef ||
			notice.episodeId !== episodeId || notice.source !== 'session_final')) {
			return Promise.reject(new HalloweenStoreError('corrupt'));
		}
		return this.run([HALLOWEEN_NOTICE_STORE, HALLOWEEN_EPISODE_STORE], 'readwrite', (tx, resolve, reject) => {
			const notices = tx.objectStore(HALLOWEEN_NOTICE_STORE);
			const episodes = tx.objectStore(HALLOWEEN_EPISODE_STORE);
			const request = episodes.getAll(IDBKeyRange.bound(
				[vaultId, accountRef, episodeId, 0],
				[vaultId, accountRef, episodeId, Number.MAX_SAFE_INTEGER],
			));
			request.onerror = () => reject(storeError(request.error));
			request.onsuccess = () => {
				try {
					const prior = request.result.map((value) => parseEpisode(value, vaultId, accountRef, episodeId));
					for (const record of prior) {
						notices.delete([vaultId, accountRef, record.noticeId]);
						episodes.delete([vaultId, accountRef, episodeId, record.itemId]);
					}
					if (notice !== null) {
						notices.put(structuredClone(notice));
						for (const item of notice.items) episodes.put({
							version: 1, vaultId, accountRef, episodeId, itemId: item.itemId, noticeId: notice.noticeId,
						});
					}
					tx.oncomplete = () => resolve(notice === null ? null : structuredClone(notice));
				} catch (error) { reject(error); tx.abort(); }
			};
		});
	}

	readNotices(vaultId: string, accountRef: string): Promise<HalloweenNoticeV1[]> {
		return this.run([HALLOWEEN_NOTICE_STORE], 'readonly', (tx, resolve, reject) => {
			const request = tx.objectStore(HALLOWEEN_NOTICE_STORE).index('by-scope-observed')
				.getAll(IDBKeyRange.bound([vaultId, accountRef, ''], [vaultId, accountRef, '\uffff']));
			request.onerror = () => reject(storeError(request.error));
			request.onsuccess = () => {
				try {
					const notices = request.result.map(parseNotice).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
					tx.oncomplete = () => resolve(notices);
				} catch (error) { reject(error); tx.abort(); }
			};
		});
	}

	readRecentItemIds(vaultId: string, accountRef: string, limit = 400): Promise<number[]> {
		return this.run([HALLOWEEN_SEEN_STORE], 'readonly', (tx, resolve, reject) => {
			const request = tx.objectStore(HALLOWEEN_SEEN_STORE).getAll(
				IDBKeyRange.bound([vaultId, accountRef, 0], [vaultId, accountRef, Number.MAX_SAFE_INTEGER]),
			);
			request.onerror = () => reject(storeError(request.error));
			request.onsuccess = () => {
				try {
					const records = request.result.map((value) => parseSeen(value, vaultId, accountRef))
						.sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt) || a.itemId - b.itemId)
						.slice(0, Math.max(0, Math.min(400, limit))).map(({ itemId }) => itemId);
					tx.oncomplete = () => resolve(records);
				} catch (error) { reject(error); tx.abort(); }
			};
		});
	}

	acknowledge(vaultId: string, accountRef: string, noticeId: string, acknowledgedAt: string): Promise<boolean> {
		if (!isIso(acknowledgedAt)) return Promise.reject(new HalloweenStoreError('corrupt'));
		return this.run([HALLOWEEN_NOTICE_STORE], 'readwrite', (tx, resolve, reject) => {
			const store = tx.objectStore(HALLOWEEN_NOTICE_STORE);
			const request = store.get([vaultId, accountRef, noticeId]);
			request.onerror = () => reject(storeError(request.error));
			request.onsuccess = () => {
				try {
					if (request.result === undefined) { tx.oncomplete = () => resolve(false); return; }
					const notice = parseNotice(request.result);
					store.put({ ...notice, acknowledgedAt });
					tx.oncomplete = () => resolve(true);
				} catch (error) { reject(error); tx.abort(); }
			};
		});
	}

	close(): void { this.closed = true; this.database.close(); }

	private run<T>(
		stores: string[], mode: IDBTransactionMode,
		body: (transaction: IDBTransaction, resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
	): Promise<T> {
		if (this.closed) return Promise.reject(new HalloweenStoreError('unavailable'));
		return new Promise((resolve, reject) => {
			let tx: IDBTransaction;
			try { tx = this.database.transaction(stores, mode); }
			catch { reject(new HalloweenStoreError('unavailable')); return; }
			tx.onerror = () => reject(storeError(tx.error));
			tx.onabort = () => reject(storeError(tx.error));
			body(tx, resolve, reject);
		});
	}
}

function parseStoredObservation(value: unknown): StoredObservationV1 {
	if (!isHalloweenObservation(value) || !isRecord(value) || !Array.isArray(value.firstSeenItemIds) ||
		!strictIds(value.firstSeenItemIds) || value.firstSeenItemIds.some((id) =>
			!value.gains.some((gain) => gain.itemId === id))) throw new HalloweenStoreError('corrupt');
	return structuredClone(value) as unknown as StoredObservationV1;
}

function parseNotice(value: unknown): HalloweenNoticeV1 {
	if (!validNotice(value)) throw new HalloweenStoreError('corrupt');
	return structuredClone(value);
}

function validNotice(value: unknown): value is HalloweenNoticeV1 {
	return isRecord(value) && value.version === 1 && typeof value.vaultId === 'string' && value.vaultId.length > 0 &&
		typeof value.accountRef === 'string' && value.accountRef.length > 0 && typeof value.noticeId === 'string' && value.noticeId.length > 0 &&
		typeof value.episodeId === 'string' && value.episodeId.length > 0 && isIso(value.observedAt) &&
		(value.source === 'assisted_poll' || value.source === 'session_final') && value.wording === 'observed_change' &&
		(value.coverage === 'complete' || value.coverage === 'partial') && Array.isArray(value.items) && value.items.length > 0 &&
		value.items.every(validAlertItem) && strictlyAscending(value.items.map((item) => item.itemId)) &&
		(value.acknowledgedAt === null || isIso(value.acknowledgedAt));
}

function validAlertItem(value: unknown): value is HalloweenAlertItem {
	return isRecord(value) && typeof value.itemId === 'number' && Number.isSafeInteger(value.itemId) && value.itemId > 0 &&
		typeof value.quantity === 'number' && Number.isSafeInteger(value.quantity) && value.quantity > 0 &&
		(value.name === null || (typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 256)) &&
		Array.isArray(value.reasons) && value.reasons.length > 0 && value.reasons.every(validAlertReason);
}

function validAlertReason(value: unknown): boolean {
	if (!isRecord(value) || typeof value.code !== 'string') return false;
	if (value.code === 'valuable') return exactKeys(value, ['code', 'netUnitCopper', 'thresholdCopper']) &&
		safeNonNegative(value.netUnitCopper) && safeNonNegative(value.thresholdCopper);
	if (value.code === 'rare_unpriced_or_bound') return exactKeys(value, ['code', 'rarity']) &&
		typeof value.rarity === 'string' && value.rarity.length > 0 && value.rarity.length <= 64;
	if (value.code === 'first_seen') return exactKeys(value, ['code']);
	if (value.code === 'skin_not_unlocked') return exactKeys(value, ['code', 'skinIds']) &&
		Array.isArray(value.skinIds) && value.skinIds.length > 0 && strictIds(value.skinIds);
	return value.code === 'mini_not_unlocked' && exactKeys(value, ['code', 'miniId']) && positiveInteger(value.miniId);
}

function parseSeen(value: unknown, vaultId: string, accountRef: string, itemId?: number): { itemId: number; lastObservedAt: string } {
	if (!isRecord(value) || !exactKeys(value, ['version', 'vaultId', 'accountRef', 'itemId', 'lastObservedAt']) ||
		value.version !== 1 || value.vaultId !== vaultId || value.accountRef !== accountRef ||
		!positiveInteger(value.itemId) || (itemId !== undefined && value.itemId !== itemId) || !isIso(value.lastObservedAt)) {
		throw new HalloweenStoreError('corrupt');
	}
	return { itemId: value.itemId, lastObservedAt: value.lastObservedAt };
}

function parseEpisode(
	value: unknown, vaultId: string, accountRef: string, episodeId: string, itemId?: number,
): { itemId: number; noticeId: string } {
	if (!isRecord(value) || !exactKeys(value, ['version', 'vaultId', 'accountRef', 'episodeId', 'itemId', 'noticeId']) ||
		value.version !== 1 || value.vaultId !== vaultId || value.accountRef !== accountRef || value.episodeId !== episodeId ||
		!positiveInteger(value.itemId) || (itemId !== undefined && value.itemId !== itemId) ||
		typeof value.noticeId !== 'string' || value.noticeId.length === 0) throw new HalloweenStoreError('corrupt');
	return { itemId: value.itemId, noticeId: value.noticeId };
}

function parseMeta(value: unknown, vaultId: string, accountRef: string): 'complete' | 'partial' {
	if (!isRecord(value) || !exactKeys(value, ['version', 'vaultId', 'accountRef', 'completedAt', 'coverage']) ||
		value.version !== 1 || value.vaultId !== vaultId || value.accountRef !== accountRef || !isIso(value.completedAt) ||
		(value.coverage !== 'complete' && value.coverage !== 'partial')) {
		throw new HalloweenStoreError('corrupt');
	}
	return value.coverage;
}

function canonicalObservation(value: HalloweenObservationV1): string {
	const { version, vaultId, accountRef, observationId, episodeId, observedAt, source, coverage, gains } = value;
	return JSON.stringify({ version, vaultId, accountRef, observationId, episodeId, observedAt, source, coverage, gains });
}

function storeError(error: DOMException | null): HalloweenStoreError {
	return new HalloweenStoreError(halloweenStoreFailureFrom(error));
}

export function halloweenStoreFailureFrom(error: Pick<DOMException, 'name'> | null): HalloweenStoreFailure {
	return error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable';
}

function isIso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeNonNegative(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function strictBackfill(value: readonly HalloweenBackfillCandidate[]): boolean {
	const ids = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate.observationId !== 'string' || candidate.observationId.length === 0 || ids.has(candidate.observationId) ||
			typeof candidate.episodeId !== 'string' || candidate.episodeId.length === 0 || !isIso(candidate.observedAt) ||
			(candidate.coverage !== 'complete' && candidate.coverage !== 'partial') || !strictGains(candidate.gains)) return false;
		ids.add(candidate.observationId);
	}
	return true;
}

function strictGains(value: readonly { itemId: number; quantity: number }[]): boolean {
	return value.every((gain, index) => positiveInteger(gain.itemId) && positiveInteger(gain.quantity) &&
		(index === 0 || value[index - 1]!.itemId < gain.itemId));
}

function strictIds(value: unknown[]): value is number[] {
	return value.every((id, index) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0 &&
		(index === 0 || (value[index - 1] as number) < id));
}
function strictlyAscending(values: number[]): boolean { return values.every((value, index) => index === 0 || values[index - 1]! < value); }
