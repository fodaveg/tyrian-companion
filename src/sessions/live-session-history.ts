import { buildLiveSessionComparison, type LiveSessionComparison } from './live-session-comparison';
import { settlePersistedIngameReceipt } from '../alerts/alert-ingame-receipt';
import { liveObservationTotals, valueLiveTotals } from './live-session-reducer';
import type { LiveSessionViewV1, LiveChartPointV1, LiveTotalV1 } from './live-session-model';
import { inspectLiveSessionNote } from './live-session-note-renderer';
import { inspectDurableSessionNote, type SessionHistoryVault } from './session-history';
import type { StoredLiveSessionPayloadV1 } from './live-session-note-model';
import { exportLiveSession, type LiveSessionExportFormat, type LiveSessionExportKind, type LiveSessionExportResult, type LiveSessionExportPayload } from './live-session-export';

export interface LiveSessionHistoryEntry {
	sessionRef: string; startedAt: string; endedAt: string; observationCount: number;
	/** The value saved with the session (coins included when observed, else the item subtotal); no current price is applied. */
	estimatedValueCopper: number;
	/** Net item quantity saved with the session: the figure the panel shows as «Objetos». */
	itemCount: number;
}
export type LiveSessionHistoryList = { status: 'ok'; sessions: LiveSessionHistoryEntry[]; ignored: number }
	| { status: 'conflict'; invalid: number; duplicates: number } | { status: 'unavailable' };
export type LiveSessionComparisonLoad = { status: 'ok'; comparison: LiveSessionComparison; ignored: number }
	| Exclude<LiveSessionHistoryList, { status: 'ok' }>;
export type LiveSessionHistorySelection = { status: 'found'; session: StoredLiveSessionPayloadV1 }
	| { status: 'missing' | 'conflict' | 'unavailable' };

/** Explicit history actions read synced notes, so a new machine needs no old IDB journal. */
export class LiveSessionHistoryService {
	constructor(private readonly vault: SessionHistoryVault) {}

	async list(): Promise<LiveSessionHistoryList> {
		const scan = await this.scan();
		if (scan.status !== 'ok') return scan;
		return { status: 'ok',ignored: scan.ignored,sessions: scan.sessions.map((session) => ({
			sessionRef: session.sessionRef,startedAt: session.startedAt,endedAt: session.endedAt,observationCount: session.observationCount,
			estimatedValueCopper: session.valuation.knownNetValueCopper ?? session.valuation.netItemValueKnownCopper,
			itemCount: session.totals.filter((row) => row.kind === 'item').reduce((sum,row) => sum + row.net,0),
		})) };
	}

	/** One explicit comparison load reuses the validated scan; no per-session rereads or API fallback. */
	async loadComparison(): Promise<LiveSessionComparisonLoad> {
		const scan = await this.scan();
		return scan.status === 'ok' ? { status: 'ok', comparison: buildLiveSessionComparison(scan.sessions), ignored: scan.ignored } : scan;
	}

	/** No source freshness is reconstructed here; the caller projects saved evidence as historical. */
	async select(sessionRef: string): Promise<LiveSessionHistorySelection> {
		if (!/^[a-f0-9]{64}$/u.test(sessionRef)) return { status: 'missing' };
		const scan = await this.scan();
		if (scan.status !== 'ok') return { status: scan.status };
		const session = scan.sessions.find((candidate) => candidate.sessionRef === sessionRef);
		return session === undefined ? { status: 'missing' } : { status: 'found',session };
	}

	export(folder: unknown, kind: LiveSessionExportKind, format: LiveSessionExportFormat,
		session: LiveSessionExportPayload): Promise<LiveSessionExportResult> {
		return exportLiveSession(this.vault,folder,kind,format,session);
	}

	private async scan(): Promise<{ status: 'ok'; sessions: StoredLiveSessionPayloadV1[]; ignored: number }
		| Exclude<LiveSessionHistoryList,{ status: 'ok' }>> {
		try {
			const sessions: StoredLiveSessionPayloadV1[] = []; let ignored = 0; let invalid = 0; let duplicates = 0;
			const refs = new Set<string>();
			for (const file of this.vault.markdownFiles()) {
				const content = await this.vault.read(file);
				const live = await inspectLiveSessionNote(content);
				if (live.status === 'invalid') { invalid += 1; continue; }
				if (live.status === 'non_candidate') {
					const legacy = await inspectDurableSessionNote(content);
					if (legacy.status === 'invalid') invalid += 1; else ignored += 1;
					continue;
				}
				if (refs.has(live.session.sessionRef)) duplicates += 1;
				refs.add(live.session.sessionRef); sessions.push(live.session);
			}
			if (invalid > 0 || duplicates > 0) return { status: 'conflict',invalid,duplicates };
			return { status: 'ok',ignored,sessions: sessions.sort((a,b) => b.startedAt.localeCompare(a.startedAt) || a.sessionRef.localeCompare(b.sessionRef)) };
		} catch { return { status: 'unavailable' }; }
	}
}

/** Frozen history is never a live source; current time cannot renew its last capture. */
export function liveSessionViewFromStored(payload: StoredLiveSessionPayloadV1, _now: number, offset = 0, limit = 200): LiveSessionViewV1 {
	const all = payload.journal.flatMap((entry) => entry.observations);
	const start = Math.max(0,Number.isSafeInteger(offset) ? offset : 0);
	const size = Math.max(1,Math.min(200,Number.isSafeInteger(limit) ? limit : 200));
	const chart: LiveChartPointV1[] = []; let totals: LiveTotalV1[] = [];
	for (const [index,entry] of payload.journal.entries()) {
		totals = liveObservationTotals(totals,entry.observations);
		if (index < payload.journal.length - 600) continue;
		const valuation = valueLiveTotals(totals,payload.valuation.prices,payload.valuation.capturedAt);
		chart.push({ observedAt: entry.observedAt,itemQuantityNet: totals.filter((row) => row.kind === 'item').reduce((sum,row) => sum + row.net,0),
			netItemValueKnownCopper: valuation.netItemValueKnownCopper,knownNetValueCopper: valuation.knownNetValueCopper,
			breakBefore: entry.breakBefore || chart.length === 0 && index > 0 });
	}
	return { version: 1,sessionId: payload.sessionRef,phase: 'complete',connection: 'disconnected',sourceState: 'unavailable',
		sourceReason: 'source_missing',source: 'nexus_inventory',startedAt: payload.startedAt,endedAt: payload.endedAt,
		elapsedMs: Date.parse(payload.endedAt) - Date.parse(payload.startedAt),observedItemsMs: payload.observedItemsMs,
		observedCurrenciesMs: payload.observedCurrenciesMs,lastObservationAt: payload.coverage.lastObservationAt,
		itemCoverage: payload.coverage.items,currencyCoverage: payload.coverage.currencies,currencyIds: [...payload.coverage.currencyIds],
		freeSlots: payload.coverage.freeSlots,observations: structuredClone(all.slice(start,start + size)),observationCount: payload.observationCount,
		observationOffset: start,hasMore: start + size < all.length,gaps: structuredClone(payload.gaps),totals: structuredClone(payload.totals),
		valuation: structuredClone(payload.valuation),chartPoints: chart,magicFind: {...payload.magicFind} };
}

/** Read-only historical receipts keep their saved state, without replaying dispatch effects. */
export function liveSessionAlertsFromStored(payload: StoredLiveSessionPayloadV1) {
	return payload.journal.flatMap((entry) => entry.outbox.map((row) => {
		const observation = entry.observations.find((candidate) => candidate.id === row.observationId)!;
		return { id: row.observationId,outboxId: row.outboxId,observedAt: observation.observedAt,itemId: observation.idNumber,
			quantity: observation.delta,totalCopper: row.alert?.totalCopper ?? null,state: row.state,skipReason: row.skipReason,
			sentTo: [...row.sentTo],receipt: row.receipt === null ? null : settlePersistedIngameReceipt(structuredClone(row.receipt)),deliveryReport: structuredClone(row.deliveryReport) };
	}));
}
