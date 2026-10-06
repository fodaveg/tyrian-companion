import { canonicalJson, sha256CanonicalValue } from '../core/canonical-sha256';
import type { SessionRuntimeRecord, SessionSummaryReceipt } from './session-runtime-store';
import { SESSION_RUNTIME_KEY, SESSION_RUNTIME_STORE_NAME, SESSION_SUMMARY_RECEIPT_KEY } from './session-runtime-store';
import type { SessionAuthority } from './session';

export const LEGACY_RUNTIME_ARCHIVE_PREFIX = 'legacy-api-runtime:';
export interface LegacyRuntimeArchiveV1 {version:1;kind:'legacy_api_runtime';original:unknown;receipt:SessionSummaryReceipt|null;sha256:string;preservedAt:number;reason:'passive_source_migration'}
/** Checksum preparation happens outside IDB's active transaction. The archived original is unchanged. */
export function prepareLegacyRuntimeArchive(original: unknown, archivedAt: number, receipt:SessionSummaryReceipt|null = null): LegacyRuntimeArchiveV1 {
	return {version:1,kind:'legacy_api_runtime',original:structuredClone(original),receipt:structuredClone(receipt),sha256:sha256CanonicalValue([original,receipt]),preservedAt:archivedAt,reason:'passive_source_migration'};
}
/** A fenced CAS transfers the unique copy, never deletes it before its additive archive commits. */
export async function archiveLegacyRuntime(database: IDBDatabase, expected: SessionRuntimeRecord,
	archive: LegacyRuntimeArchiveV1, authority: SessionAuthority): Promise<boolean> {
	const sessionId = expected.state.status === 'error' ? expected.state.failedState.sessionId : expected.state.sessionId;
	if (authority.sessionId !== sessionId) return false;
	const priorAuthority = expected.state.status === 'error' ? expected.state.failedState.authority : expected.state.authority;
	if (priorAuthority.machineId !== authority.machineId || authority.fence < priorAuthority.fence
		|| authority.fence === priorAuthority.fence && (authority.instanceId !== priorAuthority.instanceId || authority.acquiredAt !== priorAuthority.acquiredAt)) return false;
	const expectedJson = canonicalJson(archive.original); const archiveKey = `${LEGACY_RUNTIME_ARCHIVE_PREFIX}${sessionId}`;
	return await new Promise((resolve) => {
		const tx = database.transaction(SESSION_RUNTIME_STORE_NAME,'readwrite'); const store = tx.objectStore(SESSION_RUNTIME_STORE_NAME); let saved = false;
		const request = store.get(SESSION_RUNTIME_KEY);
		request.onsuccess = () => {
			if (canonicalJson(request.result) !== expectedJson) return;
			const receipt = store.get(SESSION_SUMMARY_RECEIPT_KEY);
			receipt.onsuccess = () => {
				const current = receipt.result as SessionSummaryReceipt | undefined;
				if (canonicalJson(current?.sessionId === sessionId ? current : null) !== canonicalJson(archive.receipt)) return;
				const existing = store.get(archiveKey);
				existing.onsuccess = () => {
				const prior = existing.result as LegacyRuntimeArchiveV1 | undefined;
				if (prior !== undefined && (prior.sha256 !== archive.sha256 || canonicalJson(prior.original) !== expectedJson)) return;
				if (prior === undefined) store.add(archive,archiveKey);
				store.delete(SESSION_RUNTIME_KEY); saved = true;
				};
			};
		};
		tx.oncomplete = () => resolve(saved); tx.onerror = tx.onabort = () => resolve(false);
	});
}
