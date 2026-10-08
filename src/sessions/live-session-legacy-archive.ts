import { canonicalJson, sha256CanonicalValue } from '../core/canonical-sha256';
import { startIndexedDbTransaction } from '../core/indexed-db-open';
import type { SessionRuntimeRecord, SessionSummaryReceipt } from './session-runtime-store';
import { SESSION_RUNTIME_KEY, SESSION_RUNTIME_STORE_NAME, SESSION_SUMMARY_RECEIPT_KEY } from './session-runtime-store';
import { isSessionSummaryReceipt, isSessionRuntimeRecord, legacyRuntimeRecordFromArchive } from './session-runtime-store';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { normalizeSessionOutputFolder } from './session-note-model';
import { ensureFoldersBySegments } from '../core/vault-folders';
import type { SessionHistoryVault } from './session-history';
import type { SessionAuthority } from './session';

export const LEGACY_RUNTIME_ARCHIVE_PREFIX = 'legacy-api-runtime:';
export interface LegacyRuntimeArchiveV1 {version:1;kind:'legacy_api_runtime';original:unknown;receipt:SessionSummaryReceipt|null;sha256:string;preservedAt:number;reason:'passive_source_migration'}
/** Checksum preparation happens outside IDB's active transaction. The archived original is unchanged. */
export function prepareLegacyRuntimeArchive(original: unknown, archivedAt: number, receipt:SessionSummaryReceipt|null = null): LegacyRuntimeArchiveV1 {
	return {version:1,kind:'legacy_api_runtime',original:structuredClone(original),receipt:structuredClone(receipt),sha256:sha256CanonicalValue([original,receipt]),preservedAt:archivedAt,reason:'passive_source_migration'};
}
/** Closed archive metadata never changes the phase or completion evidence of its original. */
export function isLegacyRuntimeArchive(value: unknown): value is LegacyRuntimeArchiveV1 {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const row = value as Record<string,unknown>;
	return Object.keys(row).sort().join(',') === ['version','kind','original','receipt','sha256','preservedAt','reason'].sort().join(',')
		&& row.version === 1 && row.kind === 'legacy_api_runtime' && row.reason === 'passive_source_migration'
		&& typeof row.preservedAt === 'number' && Number.isSafeInteger(row.preservedAt) && row.preservedAt >= 0
		&& (row.receipt === null || isSessionSummaryReceipt(row.receipt)) && row.sha256 === sha256CanonicalValue([row.original,row.receipt]);
}
/** Portable aggregate evidence uses pseudonymous references; the unchanged raw copy stays local. */
export function prepareLegacyRuntimeExport(archive:LegacyRuntimeArchiveV1, runtime:SessionRuntimeRecord) {
	if (!isLegacyRuntimeArchive(archive) || !isSessionRuntimeRecord(runtime)) throw new Error('Preserved API evidence is invalid.');
	if (canonicalJson(legacyRuntimeRecordFromArchive(archive)) !== canonicalJson(runtime)) throw new Error('Preserved API export evidence does not match its archive.');
	const state = runtime.state.status === 'error' ? runtime.state.failedState : runtime.state;
	const snapshot = (value:StorageSnapshot|null) => value === null ? null : ({
		snapshotRef:sha256CanonicalValue(value.snapshotId),startedAt:value.startedAt,completedAt:value.completedAt,
		schemaVersion:value.schemaVersion,quality:value.quality,passes:value.passes,
		availableByItem:structuredClone(value.availableByItem),ownedByItem:structuredClone(value.ownedByItem),
		currencyById:structuredClone(value.currencyById),sourceCoverage:structuredClone(value.coverage.sources),
	});
	const delta = runtime.delta;
	return {format:'tyrian-companion-legacy-runtime-export',version:1,source:'account_api',scope:'saved_aggregate_inventory_and_wallet',
		sessionRef:sha256CanonicalValue(state.sessionId),accountRef:sha256CanonicalValue(runtime.baselineSnapshot.accountId),
		originalStatus:runtime.state.status,preservedAt:archive.preservedAt,requestedAt:state.requestedAt,
		stoppedAt:'stoppedAt' in state ? state.stoppedAt : null,finalizedAt:'finalizedAt' in state ? state.finalizedAt : null,
		baseline:snapshot(runtime.baselineSnapshot),final:snapshot(runtime.finalSnapshot),
		delta:delta === null ? null : {status:delta.status,window:structuredClone(delta.window),surface:delta.surface,currencySurface:delta.currencySurface,
			itemChanges:structuredClone(delta.itemChanges),currencyChanges:structuredClone(delta.currencyChanges),availabilityChanges:structuredClone(delta.availabilityChanges)},
		summarySaved:archive.receipt !== null,summarySavedAt:archive.receipt?.savedAt ?? null};
}
/** Create-only and reread-verified export never resumes an old session or invents a completion. */
export async function exportLegacyRuntimeArchive(vault:Pick<SessionHistoryVault,'file'|'read'|'create'|'exists'|'createFolder'>, outputFolder:string, archive:LegacyRuntimeArchiveV1, runtime:SessionRuntimeRecord):Promise<string> {
	const output = normalizeSessionOutputFolder(outputFolder);
	if (output === null || !isLegacyRuntimeArchive(archive)) throw new Error('The preserved API runtime export is invalid.');
	const payload = prepareLegacyRuntimeExport(archive,runtime);
	const path = `${output}/exports/tyrian-legacy-runtime-${sha256CanonicalValue(payload)}.json`;
	const content = `${JSON.stringify(payload,null,2)}\n`;
	const existing = vault.file(path);
	if (existing !== null) { if (await vault.read(existing) === content) return path; throw new Error('The preserved API export path has changed.'); }
	if (vault.exists(path)) throw new Error('The preserved API export path is occupied.');
	await ensureFoldersBySegments({file:(folder) => vault.exists(folder) ? {path:folder} : null,createFolder:(folder) => vault.createFolder(folder)},`${output}/exports`,'Export folder creation failed.');
	await vault.create(path,content); const written = vault.file(path);
	if (written === null || await vault.read(written) !== content) throw new Error('The preserved API runtime export could not be verified.');
	return path;
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
		const tx = startIndexedDbTransaction(database,SESSION_RUNTIME_STORE_NAME,'readwrite'); const store = tx.objectStore(SESSION_RUNTIME_STORE_NAME); let saved = false;
		const request = store.get(SESSION_RUNTIME_KEY);
		request.onsuccess = () => {
			if (canonicalJson(request.result) !== expectedJson) return;
			const receipt = store.get(SESSION_SUMMARY_RECEIPT_KEY);
			receipt.onsuccess = () => {
				const current = receipt.result as SessionSummaryReceipt | undefined;
				if (current !== undefined && !isSessionSummaryReceipt(current)) return;
				if (canonicalJson(current?.sessionId === sessionId ? current : null) !== canonicalJson(archive.receipt)) return;
				const existing = store.get(archiveKey);
				existing.onsuccess = () => {
				const prior = existing.result as LegacyRuntimeArchiveV1 | undefined;
				if (prior !== undefined && (!isLegacyRuntimeArchive(prior) || prior.sha256 !== archive.sha256 || canonicalJson(prior.original) !== expectedJson)) return;
				if (prior === undefined) store.add(archive,archiveKey);
				store.delete(SESSION_RUNTIME_KEY); saved = true;
				};
			};
		};
		tx.oncomplete = () => resolve(saved); tx.onerror = tx.onabort = () => resolve(false);
	});
}
