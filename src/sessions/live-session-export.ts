import { canonicalJson } from '../core/canonical-sha256';
import { ensureFoldersBySegments } from '../core/vault-folders';
import { isStoredLiveSessionPayload, isLiveSessionSnapshot, prepareLiveSessionSnapshot, type LiveSessionSnapshotV1, type LiveSessionNoteInput, type StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { sha256Text } from './session-note-renderer';
import { normalizeSessionOutputFolder } from './session-note-model';
import { serializeCsvCell, type SessionHistoryVault } from './session-history';

export type LiveSessionExportPayload = StoredLiveSessionPayloadV1 | LiveSessionSnapshotV1;
export interface LiveSessionExportSnapshotInput extends Pick<LiveSessionNoteInput,'record' | 'journal'> { capturedAt: string }
/** Point-in-time export factory, independent of completed schema7 note generation. */
export async function prepareLiveSessionExportSnapshot(input: LiveSessionExportSnapshotInput): Promise<LiveSessionSnapshotV1 | null> {
	return await prepareLiveSessionSnapshot(input,input.capturedAt);
}

export type LiveSessionExportKind = 'timeline' | 'summary';
export type LiveSessionExportFormat = 'csv' | 'json';
export type LiveSessionExportResult = { status: 'written' | 'unchanged'; path: string }
	| { status: 'conflict' | 'invalid' | 'unavailable'; message: string };

/** Both views export full portable evidence; UI pagination never limits this boundary. */
export function serializeLiveSessionExport(session: LiveSessionExportPayload, kind: LiveSessionExportKind, format: LiveSessionExportFormat): string {
	const snapshot = 'capturedAt' in session; const version = snapshot ? 2 : 1;
	if (format === 'json') return `${JSON.stringify({ format: 'tyrian-companion-live-session-export', version, kind, session },null,2)}\n`;
	const columns = ['row_type','version','source','session_ref','account_ref','build','profile','started_at','ended_at',
		'entity_kind','id_number','before','after','delta','positive','negative','net','observed_at','window_start_at',
		'source_elapsed_ms','epoch','cursor','cause','coverage','channels','reason','from_at','to_at','break_before',
		'price_basis','price_captured_at','unit_copper','payload_json',...(snapshot ? ['captured_at','export_state'] as const : [])] as const;
	type Row = Partial<Record<typeof columns[number],string | number | null>>;
	const common: Row = { version, source: session.source, session_ref: session.sessionRef, account_ref: null,
		build: session.build, profile: session.profile, started_at: session.startedAt, ended_at: session.endedAt,
		price_basis: session.valuation.priceBasis, price_captured_at: session.valuation.capturedAt,
		...(snapshot ? { captured_at: session.capturedAt,export_state: session.exportState } : {}) };
	const rows: Row[] = [{ ...common, row_type: 'session', payload_json: canonicalJson({ ...session,journal: [],gaps: [],totals: [] }) }];
	for (const entry of session.journal) {
		rows.push({ ...common,row_type: 'sample',epoch: entry.epoch,cursor: entry.cursor,observed_at: entry.observedAt,
			break_before: entry.breakBefore ? 1 : 0,
			payload_json: canonicalJson({version: entry.version,epoch: entry.epoch,cursor: entry.cursor,observedAt: entry.observedAt,breakBefore: entry.breakBefore}) });
		for (const alert of entry.outbox) rows.push({ ...common,row_type: 'alert',epoch: entry.epoch,cursor: entry.cursor,observed_at: entry.observedAt,payload_json: canonicalJson(alert) });
		for (const row of entry.observations) rows.push({ ...common,row_type: 'observation',entity_kind: row.kind,id_number: row.idNumber,
			before: row.before,after: row.after,delta: row.delta,observed_at: row.observedAt,window_start_at: row.windowStartAt,
			source_elapsed_ms: row.sourceElapsedMs,epoch: row.epoch,cursor: row.cursor,cause: row.cause,coverage: row.coverage,
			payload_json: canonicalJson(row) });
	}
	for (const gap of session.gaps) rows.push({ ...common,row_type: 'gap',channels: gap.channels.join(','),reason: gap.reason,from_at: gap.fromAt,to_at: gap.toAt });
	for (const total of session.totals) rows.push({ ...common,row_type: 'total',entity_kind: total.kind,id_number: total.idNumber,
		positive: total.positive,negative: total.negative,net: total.net });
	for (const price of session.valuation.prices) rows.push({ ...common,row_type: 'price',entity_kind: 'item',id_number: price.itemId,unit_copper: price.unitCopper });
	return `${[columns.map(serializeCsvCell).join(','),...rows.map((row) => columns.map((column) => serializeCsvCell(row[column] ?? null)).join(','))].join('\r\n')}\r\n`;
}

/** Immutable exports use the established vault-only create surface and verify bytes after create. */
export async function exportLiveSession(vault: SessionHistoryVault, folder: unknown, kind: LiveSessionExportKind,
	format: LiveSessionExportFormat, session: LiveSessionExportPayload): Promise<LiveSessionExportResult> {
	const output = normalizeSessionOutputFolder(folder);
	if (output === null || !['timeline','summary'].includes(kind) || !['csv','json'].includes(format)
		|| !('capturedAt' in session ? isLiveSessionSnapshot(session) : isStoredLiveSessionPayload(session))) return { status: 'invalid',message: 'The live export input is not valid.' };
	const snapshot = 'capturedAt' in session;
	const ref = snapshot ? await sha256Text(canonicalJson(session)) : null;
	const filename = snapshot ? `tyrian-live-${session.sessionRef.slice(0,16)}-${ref!}-${kind}-v2.${format}`
		: `tyrian-companion-live-${session.sessionRef}-${kind}-v1.${format}`;
	const path = `${output}/exports/${filename}`;
	const content = serializeLiveSessionExport(session,kind,format);
	try {
		const existing = vault.file(path);
		if (existing !== null) return await vault.read(existing) === content ? { status: 'unchanged',path }
			: { status: 'conflict',message: 'The existing live export has different content.' };
		if (vault.exists(path)) return { status: 'conflict',message: 'The live export path is occupied.' };
		await ensureFoldersBySegments({file: (folder) => vault.exists(folder) ? {path: folder} : null,
			createFolder: (folder) => vault.createFolder(folder)},`${output}/exports`,'Export folder creation failed.');
		try { await vault.create(path,content); }
		catch {
			const raced = vault.file(path);
			if (raced === null) return { status: 'unavailable',message: 'The live export could not be created.' };
			return await vault.read(raced) === content ? { status: 'unchanged',path }
				: { status: 'conflict',message: 'The live export path changed during creation.' };
		}
		const written = vault.file(path);
		return written !== null && await vault.read(written) === content ? { status: 'written',path }
			: { status: 'unavailable',message: 'The live export could not be verified.' };
	} catch { return { status: 'unavailable',message: 'The live export is unavailable.' }; }
}
