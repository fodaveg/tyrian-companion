import type { LiveSessionSummaryState } from './live-session-summary-state';
import { isLiveSessionFormat, LIVE_SESSION_FORMAT_KEY, liveSessionFormatMark } from './live-session-format';
import type { LiveSessionFormat, LiveSessionRuntimeRecord, LiveJournalEntryV1 } from './live-session-model';
import { isLiveSessionRuntimeRecord, isLiveJournalEntry } from './live-session-validation';
import type { SessionRuntimeMutationResult, SessionRuntimeLoadResult } from './session-runtime-store';
import { LIVE_SESSION_JOURNAL_STORE_NAME, SESSION_RUNTIME_KEY, SESSION_RUNTIME_STORE_NAME } from './session-runtime-store';
import { canUpdateLiveOutbox } from './live-session-outbox';
import { startIndexedDbTransaction } from '../core/indexed-db-open';

export { LIVE_SESSION_JOURNAL_STORE_NAME };
export type LiveRuntimeLoadResult = { status: 'empty' | 'legacy' } | { status: 'loaded'; record: LiveSessionRuntimeRecord }
	| { status: 'error'; code: 'corrupt' | 'unavailable' };
export interface LiveSessionPersistence {
	loadLive(): Promise<LiveRuntimeLoadResult>;
	/**
	 * `expected`, when given, is the stored record this write was made from: unless that is still exactly what is stored, in
	 * the transaction that writes, the answer is `stale` and nothing is written. The first save of a takeover gives it.
	 * `format`, when given, is the format the session of `record` starts with: its mark is written in the same transaction as the
	 * record (both or neither). Only the save that starts a session gives it.
	 */
	saveLive(record: LiveSessionRuntimeRecord, journal?: LiveJournalEntryV1, expected?: LiveSessionRuntimeRecord, format?: LiveSessionFormat): Promise<SessionRuntimeMutationResult>;
	/**
	 * The format the session `sessionId` started with (`liveSessionFormatOf`): the legacy one when no mark names it. Rejects when
	 * storage cannot read the mark, and when the mark of that session does not validate: either way nothing says how to read it.
	 */
	loadSessionFormat(sessionId: string): Promise<LiveSessionFormat>;
	readLiveJournal(sessionId: string): Promise<LiveJournalEntryV1[]>;
	markLiveAlertsProcessed(sessionId: string, epoch: string, cursor: number): Promise<boolean>;
	replaceLiveJournal(prior: LiveJournalEntryV1, next: LiveJournalEntryV1, owner?: LiveSessionRuntimeRecord): Promise<boolean>;
	/**
	 * The one journal entry stored under that key, or null when there is none or it does not validate. What a writer reads
	 * after `replaceLiveJournal` answered false, to learn whether the write is on disk after all. Rejects when storage cannot read.
	 */
	readLiveJournalEntry?(sessionId: string, epoch: string, cursor: number): Promise<LiveJournalEntryV1 | null>;
	/** Deletes the journal of a SEALED session (its note receipt is durable). Refuses the session the runtime key still holds. */
	pruneLiveJournal?(sessionId: string): Promise<boolean>;
	/**
	 * Sealed sessions whose journal is still to be pruned (each with the path of its durable note), so a restart does not forget them.
	 * Rejects when storage cannot read the queue: the lifecycle then saves nothing over it until a read works.
	 */
	loadPruneQueue?(): Promise<SealedJournal[]>;
	savePruneQueue?(queue: readonly SealedJournal[]): Promise<boolean>;
	/** Local summary facts (characters seen, summary written) under a key apart from the closed runtime record; best effort, never throws. */
	loadSummaryState?(): Promise<LiveSessionSummaryState | null>;
	saveSummaryState?(state: LiveSessionSummaryState): Promise<boolean>;
}
export interface SealedJournal { sessionId: string; receiptPath: string }
/** A second key in the runtime object store (like the summary receipt): no schema upgrade, and a 0.6.12 that opens the same database never reads it. */
export const LIVE_JOURNAL_PRUNE_QUEUE_KEY = 'live-journal-prune-queue';
export function isSealedJournalQueue(value: unknown): value is SealedJournal[] {
	return Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null && typeof (row as SealedJournal).sessionId === 'string' && typeof (row as SealedJournal).receiptPath === 'string');
}

/**
 * One transaction commits the bounded runtime cursor and appends the sample's ledger together. With `format` (the save that
 * starts a session) the same transaction writes the mark of that session's format under its own key of the runtime store: the
 * record and its mark land together or not at all, also when the answer never reaches the caller.
 */
export async function commitLiveRuntime(database: IDBDatabase, next: LiveSessionRuntimeRecord,
	journal?: LiveJournalEntryV1, expected?: LiveSessionRuntimeRecord, format?: LiveSessionFormat): Promise<SessionRuntimeMutationResult> {
	if (!isLiveSessionRuntimeRecord(next) || journal && (!isLiveJournalEntry(journal) || journal.sessionId !== next.sessionId
		|| journal.epoch !== next.lastSample?.epoch || journal.cursor !== next.lastSample.cursor)
		|| format !== undefined && !isLiveSessionFormat(format)) return { status: 'error', code: 'corrupt' };
	return await new Promise((resolve) => {
		let result: SessionRuntimeMutationResult = { status: 'error', code: 'unavailable' };
		const transaction = startIndexedDbTransaction(database, [SESSION_RUNTIME_STORE_NAME, LIVE_SESSION_JOURNAL_STORE_NAME], 'readwrite');
		const runtime = transaction.objectStore(SESSION_RUNTIME_STORE_NAME);
		const entries = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME);
		const putRecord = (): void => {
			runtime.put(structuredClone(next), SESSION_RUNTIME_KEY);
			if (format !== undefined) runtime.put(liveSessionFormatMark(next.sessionId, format), LIVE_SESSION_FORMAT_KEY);
		};
		const request = runtime.get(SESSION_RUNTIME_KEY);
		request.onsuccess = () => {
			const current: unknown = request.result;
			if (current !== undefined && (!isLiveSessionRuntimeRecord(current) || !canReplaceLiveRuntime(current, next))) {
				result = { status: 'stale' }; return;
			}
			// A new fence may replace anything older, so the fence alone lets a takeover write over what the last owner
			// wrote after the takeover read it. Whoever says what it read is refused when that is no longer what is stored.
			if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) { result = { status: 'stale' }; return; }
			if (!journal) { putRecord(); result = { status: 'saved' }; return; }
			const key = journalKey(journal);
			const existing = entries.get(key);
			existing.onsuccess = () => {
				// Replays never replace a newer cursor or refresh receipt time. The lifecycle verifies
				// the last committed fingerprint before reaching this idempotent storage branch.
				if (existing.result !== undefined) {
					result = isLiveJournalEntry(existing.result) && identicalJournal(existing.result, journal)
						? { status: 'saved' } : { status: 'error', code: 'corrupt' }; return;
				}
				putRecord();
				entries.add(structuredClone(journal), key); result = { status: 'saved' };
			};
		};
		transaction.oncomplete = () => resolve(result);
		transaction.onerror = transaction.onabort = () => resolve({ status: 'error', code: 'unavailable' });
	});
}

/**
 * Every entry of the session, in the order it was observed, or a rejection when one entry does not validate.
 *
 * One `getAll` on the session index, not a cursor: a restore reads the whole journal twice, and walking it one `continue()`
 * at a time cost Chromium 170 ms per read of a 3 h journal against 94 ms in one call (M4, docs/audit/m4-profile). What
 * `getAll` hands back is already a copy nobody else holds, so it is not cloned again.
 */
export async function readLiveJournal(database: IDBDatabase, sessionId: string): Promise<LiveJournalEntryV1[]> {
	return await new Promise((resolve, reject) => {
		const transaction = startIndexedDbTransaction(database, LIVE_SESSION_JOURNAL_STORE_NAME, 'readonly');
		const request = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME).index('session').getAll(sessionId);
		let result: LiveJournalEntryV1[] = [];
		request.onsuccess = () => {
			const entries: unknown[] = request.result;
			if (!entries.every(isLiveJournalEntry)) { transaction.abort(); return; }
			result = entries;
		};
		transaction.oncomplete = () => resolve(result.sort((left, right) => left.observedAt.localeCompare(right.observedAt)
			|| left.epoch.localeCompare(right.epoch) || left.cursor - right.cursor));
		transaction.onerror = transaction.onabort = () => reject(new Error('Live session journal is unavailable.'));
	});
}
/** One entry by its key: a single `get`, whatever the length of the session's journal. */
export async function readLiveJournalEntry(database: IDBDatabase, sessionId: string, epoch: string, cursor: number): Promise<LiveJournalEntryV1 | null> {
	return await new Promise((resolve, reject) => {
		const transaction = startIndexedDbTransaction(database, LIVE_SESSION_JOURNAL_STORE_NAME, 'readonly');
		const request = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME).get([sessionId, epoch, cursor]);
		let entry: LiveJournalEntryV1 | null = null;
		request.onsuccess = () => { const stored: unknown = request.result; if (isLiveJournalEntry(stored)) entry = structuredClone(stored); };
		transaction.oncomplete = () => resolve(entry);
		transaction.onerror = transaction.onabort = () => reject(new Error('Live session journal is unavailable.'));
	});
}
export async function markLiveAlertsProcessed(database: IDBDatabase, sessionId: string, epoch: string, cursor: number): Promise<boolean> {
	return await new Promise((resolve) => {
		const transaction = startIndexedDbTransaction(database, LIVE_SESSION_JOURNAL_STORE_NAME, 'readwrite');
		const store = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME); let saved = false;
		const request = store.get([sessionId, epoch, cursor]);
		request.onsuccess = () => {
			if (!isLiveJournalEntry(request.result)) return;
			store.put({ ...request.result, alertsProcessed: true }, [sessionId, epoch, cursor]); saved = true;
		};
		transaction.oncomplete = () => resolve(saved); transaction.onerror = transaction.onabort = () => resolve(false);
	});
}
/** Removes every journal entry of `sessionId` through the `session` index, unless the runtime key still holds that session. */
export async function pruneLiveJournal(database: IDBDatabase, sessionId: string): Promise<boolean> {
	return await new Promise((resolve) => {
		const tx = startIndexedDbTransaction(database,[SESSION_RUNTIME_STORE_NAME,LIVE_SESSION_JOURNAL_STORE_NAME],'readwrite'); let pruned = false;
		const current = tx.objectStore(SESSION_RUNTIME_STORE_NAME).get(SESSION_RUNTIME_KEY);
		current.onsuccess = () => {
			if (isLiveSessionRuntimeRecord(current.result) && current.result.sessionId === sessionId) return;
			// Keys only: nothing is deserialized, and each entry goes by its primary key.
			const entries = tx.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME); const request = entries.index('session').openKeyCursor(sessionId);
			request.onsuccess = () => { const cursor = request.result; if (!cursor) { pruned = true; return; } entries.delete(cursor.primaryKey); cursor.continue(); };
		};
		tx.oncomplete = () => resolve(pruned); tx.onerror = tx.onabort = () => resolve(false);
	});
}
export function canReplaceLiveRuntime(current: LiveSessionRuntimeRecord, next: LiveSessionRuntimeRecord): boolean {
	return current.sessionId === next.sessionId && current.authority.machineId === next.authority.machineId
		&& next.persistedAt >= current.persistedAt && (current.phase !== 'complete' || next.phase === 'complete')
		&& (next.authority.fence > current.authority.fence || next.authority.fence === current.authority.fence
			&& next.authority.instanceId === current.authority.instanceId && next.authority.acquiredAt === current.authority.acquiredAt);
}
export function journalKey(entry: LiveJournalEntryV1): [string,string,number] { return [entry.sessionId, entry.epoch, entry.cursor]; }
export function identicalJournal(left: LiveJournalEntryV1, right: LiveJournalEntryV1): boolean {
	const { alertsProcessed: _leftProcessed, outbox: _leftOutbox, ...leftEvidence } = left;
	const { alertsProcessed: _rightProcessed, outbox: _rightOutbox, ...rightEvidence } = right;
	return JSON.stringify(leftEvidence) === JSON.stringify(rightEvidence);
}

/** Compare-and-set intent/receipts without ever replacing measurement evidence. Claims are fenced. */
export async function replaceLiveJournal(database: IDBDatabase, prior: LiveJournalEntryV1,
	next: LiveJournalEntryV1, owner?: LiveSessionRuntimeRecord): Promise<boolean> {
	if (!isLiveJournalEntry(prior) || !isLiveJournalEntry(next) || !identicalJournal(prior,next) || !canUpdateLiveOutbox(prior,next,owner !== undefined)) return false;
	return await new Promise((resolve) => {
		const tx = startIndexedDbTransaction(database,[SESSION_RUNTIME_STORE_NAME,LIVE_SESSION_JOURNAL_STORE_NAME],'readwrite');
		const journal = tx.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME); let saved = false;
		const write = (): void => {
			const request = journal.get(journalKey(prior));
			request.onsuccess = () => { if (JSON.stringify(request.result) !== JSON.stringify(prior)) return;
				journal.put(structuredClone(next),journalKey(next)); saved = true; };
		};
		if (owner) {
			const request = tx.objectStore(SESSION_RUNTIME_STORE_NAME).get(SESSION_RUNTIME_KEY);
			request.onsuccess = () => { if (isLiveSessionRuntimeRecord(request.result) && request.result.sessionId === owner.sessionId
				&& JSON.stringify(request.result.authority) === JSON.stringify(owner.authority)) write(); };
		} else write();
		tx.oncomplete = () => resolve(saved); tx.onerror = tx.onabort = () => resolve(false);
	});
}

export function liveRuntimeLoadResult(loaded: SessionRuntimeLoadResult): LiveRuntimeLoadResult {
	if (loaded.status === 'live') return { status: 'loaded', record: loaded.record };
	if (loaded.status === 'loaded') return { status: 'legacy' };
	return loaded;
}
