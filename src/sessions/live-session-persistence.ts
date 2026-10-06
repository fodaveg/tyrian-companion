import type { LiveSessionRuntimeRecord, LiveJournalEntryV1 } from './live-session-model';
import { isLiveSessionRuntimeRecord, isLiveJournalEntry } from './live-session-validation';
import type { SessionRuntimeMutationResult, SessionRuntimeLoadResult } from './session-runtime-store';
import { SESSION_RUNTIME_KEY, SESSION_RUNTIME_STORE_NAME } from './session-runtime-store';

export const LIVE_SESSION_JOURNAL_STORE_NAME = 'live-inventory-journal-v1';
export type LiveRuntimeLoadResult = { status: 'empty' | 'legacy' } | { status: 'loaded'; record: LiveSessionRuntimeRecord }
	| { status: 'error'; code: 'corrupt' | 'unavailable' };
export interface LiveSessionPersistence {
	loadLive(): Promise<LiveRuntimeLoadResult>;
	saveLive(record: LiveSessionRuntimeRecord, journal?: LiveJournalEntryV1): Promise<SessionRuntimeMutationResult>;
	readLiveJournal(sessionId: string): Promise<LiveJournalEntryV1[]>;
	markLiveAlertsProcessed(sessionId: string, epoch: string, cursor: number): Promise<boolean>;
}

/** One transaction commits the bounded runtime cursor and appends the sample's ledger together. */
export async function commitLiveRuntime(database: IDBDatabase, next: LiveSessionRuntimeRecord,
	journal?: LiveJournalEntryV1): Promise<SessionRuntimeMutationResult> {
	if (!isLiveSessionRuntimeRecord(next) || journal && (!isLiveJournalEntry(journal) || journal.sessionId !== next.sessionId
		|| journal.epoch !== next.lastSample?.epoch || journal.cursor !== next.lastSample.cursor)) return { status: 'error', code: 'corrupt' };
	return await new Promise((resolve) => {
		let result: SessionRuntimeMutationResult = { status: 'error', code: 'unavailable' };
		const transaction = database.transaction([SESSION_RUNTIME_STORE_NAME, LIVE_SESSION_JOURNAL_STORE_NAME], 'readwrite');
		const runtime = transaction.objectStore(SESSION_RUNTIME_STORE_NAME);
		const entries = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME);
		const request = runtime.get(SESSION_RUNTIME_KEY);
		request.onsuccess = () => {
			const current: unknown = request.result;
			if (current !== undefined && (!isLiveSessionRuntimeRecord(current) || !canReplaceLiveRuntime(current, next))) {
				result = { status: 'stale' }; return;
			}
			if (!journal) { runtime.put(structuredClone(next), SESSION_RUNTIME_KEY); result = { status: 'saved' }; return; }
			const key = journalKey(journal);
			const existing = entries.get(key);
			existing.onsuccess = () => {
				// Replays never replace a newer cursor or refresh receipt time. The lifecycle verifies
				// the last committed fingerprint before reaching this idempotent storage branch.
				if (existing.result !== undefined) {
					result = isLiveJournalEntry(existing.result) && identicalJournal(existing.result, journal)
						? { status: 'saved' } : { status: 'error', code: 'corrupt' }; return;
				}
				runtime.put(structuredClone(next), SESSION_RUNTIME_KEY);
				entries.add(structuredClone(journal), key); result = { status: 'saved' };
			};
		};
		transaction.oncomplete = () => resolve(result);
		transaction.onerror = transaction.onabort = () => resolve({ status: 'error', code: 'unavailable' });
	});
}

export async function readLiveJournal(database: IDBDatabase, sessionId: string): Promise<LiveJournalEntryV1[]> {
	return await new Promise((resolve, reject) => {
		const transaction = database.transaction(LIVE_SESSION_JOURNAL_STORE_NAME, 'readonly');
		const request = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME).index('session').openCursor(sessionId);
		const result: LiveJournalEntryV1[] = [];
		request.onsuccess = () => {
			const cursor = request.result; if (!cursor) return;
			const entry: unknown = cursor.value;
			if (cursor.key === sessionId) {
				if (!isLiveJournalEntry(entry)) { transaction.abort(); return; }
				result.push(structuredClone(entry));
			}
			cursor.continue();
		};
		transaction.oncomplete = () => resolve(result.sort((left, right) => left.observedAt.localeCompare(right.observedAt)
			|| left.epoch.localeCompare(right.epoch) || left.cursor - right.cursor));
		transaction.onerror = transaction.onabort = () => reject(new Error('Live session journal is unavailable.'));
	});
}
export async function markLiveAlertsProcessed(database: IDBDatabase, sessionId: string, epoch: string, cursor: number): Promise<boolean> {
	return await new Promise((resolve) => {
		const transaction = database.transaction(LIVE_SESSION_JOURNAL_STORE_NAME, 'readwrite');
		const store = transaction.objectStore(LIVE_SESSION_JOURNAL_STORE_NAME); let saved = false;
		const request = store.get([sessionId, epoch, cursor]);
		request.onsuccess = () => {
			if (!isLiveJournalEntry(request.result)) return;
			store.put({ ...request.result, alertsProcessed: true }, [sessionId, epoch, cursor]); saved = true;
		};
		transaction.oncomplete = () => resolve(saved); transaction.onerror = transaction.onabort = () => resolve(false);
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
	const { alertsProcessed: _leftProcessed, ...leftEvidence } = left;
	const { alertsProcessed: _rightProcessed, ...rightEvidence } = right;
	return JSON.stringify(leftEvidence) === JSON.stringify(rightEvidence);
}

export function liveRuntimeLoadResult(loaded: SessionRuntimeLoadResult): LiveRuntimeLoadResult {
	if (loaded.status === 'live') return { status: 'loaded', record: loaded.record };
	if (loaded.status === 'loaded') return { status: 'legacy' };
	return loaded;
}
