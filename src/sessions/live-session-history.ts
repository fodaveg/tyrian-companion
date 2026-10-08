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
	/** The session's objects (items only, net quantity other than 0), best first: the order of the panel's own grid. */
	items: LiveHistoryItem[];
	/** The session's observed coins (net other than 0): gold first, the rest by id. An unobserved coin is absent, never zero. */
	currencies: LiveHistoryItem[];
}
export interface LiveHistoryItem { idNumber: number; net: number }
/** The coins of a saved session: currency rows with a net other than 0, gold (id 1) first and the rest by ascending id. */
export function liveHistoryCurrencies(totals: readonly LiveTotalV1[]): LiveHistoryItem[] {
	return totals.filter((row) => row.kind === 'currency' && row.net !== 0)
		.sort((a, b) => (a.idNumber === 1 ? 0 : 1) - (b.idNumber === 1 ? 0 : 1) || a.idNumber - b.idNumber)
		.map((row) => ({ idNumber: row.idNumber, net: row.net }));
}
/** Tiles sort by estimated value; unpriced and negative nets sink to the end. Shared by the live grid and the saved sessions. */
export function liveItemRank(row: LiveTotalV1, prices: readonly { itemId: number; unitCopper: number | null }[]): number {
	if (row.net < 0) return Number.NEGATIVE_INFINITY;
	const price = prices.find((entry) => entry.itemId === row.idNumber)?.unitCopper;
	return price == null ? -1 : price * row.net;
}
export type LiveSessionHistoryList = { status: 'ok'; sessions: LiveSessionHistoryEntry[]; ignored: number }
	| { status: 'conflict'; invalid: number; duplicates: number } | { status: 'unavailable' };
export type LiveSessionComparisonLoad = { status: 'ok'; comparison: LiveSessionComparison; ignored: number }
	| Exclude<LiveSessionHistoryList, { status: 'ok' }>;
export type LiveSessionHistorySelection = { status: 'found'; session: StoredLiveSessionPayloadV1 }
	| { status: 'missing' | 'conflict' | 'unavailable' };

type NoteOutcome = { kind: 'invalid' } | { kind: 'ignored' } | { kind: 'live'; session: StoredLiveSessionPayloadV1 };

/** Explicit history actions read synced notes, so a new machine needs no old IDB journal. */
export class LiveSessionHistoryService {
	/** What each listed note inspected to, against the mtime it had: an unchanged note is not read again. Never kept for a note without a real mtime. */
	private readonly inspected = new Map<string,{ mtime: number; outcome: NoteOutcome }>();
	constructor(private readonly vault: SessionHistoryVault) {}

	async list(): Promise<LiveSessionHistoryList> {
		const scan = await this.scan();
		if (scan.status !== 'ok') return scan;
		return { status: 'ok',ignored: scan.ignored,sessions: scan.sessions.map((session) => ({
			sessionRef: session.sessionRef,startedAt: session.startedAt,endedAt: session.endedAt,observationCount: session.observationCount,
			estimatedValueCopper: session.valuation.knownNetValueCopper ?? session.valuation.netItemValueKnownCopper,
			itemCount: session.totals.filter((row) => row.kind === 'item').reduce((sum,row) => sum + row.net,0),
			items: session.totals.filter((row) => row.kind === 'item' && row.net !== 0)
				.sort((a,b) => liveItemRank(b,session.valuation.prices) - liveItemRank(a,session.valuation.prices) || b.net - a.net)
				.map((row) => ({ idNumber: row.idNumber,net: row.net })),
			currencies: liveHistoryCurrencies(session.totals),
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

	private async inspect(content: string): Promise<NoteOutcome> {
		const live = await inspectLiveSessionNote(content);
		if (live.status === 'invalid') return { kind: 'invalid' };
		if (live.status === 'non_candidate') return (await inspectDurableSessionNote(content)).status === 'invalid' ? { kind: 'invalid' } : { kind: 'ignored' };
		return { kind: 'live', session: live.session };
	}

	private async scan(): Promise<{ status: 'ok'; sessions: StoredLiveSessionPayloadV1[]; ignored: number }
		| Exclude<LiveSessionHistoryList,{ status: 'ok' }>> {
		try {
			const sessions: StoredLiveSessionPayloadV1[] = []; let ignored = 0; let invalid = 0; let duplicates = 0;
			const refs = new Set<string>();
			const files = this.vault.markdownFiles();
			const listed = new Set(files.map((file) => file.path));
			for (const path of this.inspected.keys()) if (!listed.has(path)) this.inspected.delete(path);
			for (const file of files) {
				const cacheable = file.mtime !== undefined && file.mtime > 0;
				let outcome = cacheable ? this.inspected.get(file.path) : undefined;
				if (outcome === undefined || outcome.mtime !== file.mtime) {
					outcome = { mtime: file.mtime ?? 0, outcome: await this.inspect(await this.vault.read(file)) };
					if (cacheable) this.inspected.set(file.path, outcome); else this.inspected.delete(file.path);
				}
				const note = outcome.outcome;
				if (note.kind === 'invalid') { invalid += 1; continue; }
				if (note.kind === 'ignored') { ignored += 1; continue; }
				if (refs.has(note.session.sessionRef)) duplicates += 1;
				refs.add(note.session.sessionRef); sessions.push(note.session);
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
		const valuation = valueLiveTotals(totals,payload.valuation.prices,payload.valuation.capturedAt,payload.valuation.coinNetCopper !== null);
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
