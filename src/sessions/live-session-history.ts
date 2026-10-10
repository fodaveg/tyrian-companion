import { buildLiveSessionComparison, type LiveSessionComparison, type LiveSessionSetAside } from './live-session-comparison';
export type { LiveSessionSetAside } from './live-session-comparison';
import { settlePersistedIngameReceipt } from '../alerts/alert-ingame-receipt';
import { buildLiveChart, GOLD_CURRENCY_ID, liveItemValueCopper } from './live-session-reducer';
import type { LivePriceBasis, LiveSessionViewV1, LiveTotalV1 } from './live-session-model';
import { inspectLiveHistoryNote, type LiveHistoryNoteOutcome, type SessionHistoryFile, type SessionHistoryVault, type SessionNoteReads,
	type SharedNoteRead } from './session-history';
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
interface LiveHistoryItem { idNumber: number; net: number }
/** The coins of a saved session: currency rows with a net other than 0, gold (id 1) first and the rest by ascending id. */
export function liveHistoryCurrencies(totals: readonly LiveTotalV1[]): LiveHistoryItem[] {
	return totals.filter((row) => row.kind === 'currency' && row.net !== 0)
		.sort((a, b) => (a.idNumber === 1 ? 0 : 1) - (b.idNumber === 1 ? 0 : 1) || a.idNumber - b.idNumber)
		.map((row) => ({ idNumber: row.idNumber, net: row.net }));
}
/**
 * The item rows with a net other than 0, best estimated value first (unpriced and negative nets sink; shared by the live grid and the saved sessions), pricing each id through one Map instead of a scan per comparison.
 * `basis` is the one the valuation of those prices states: the value that ranks a row is the one the session shows for it.
 */
export function sortLiveItemsByValue(totals: readonly LiveTotalV1[], prices: readonly { itemId: number; unitCopper: number | null }[],
	basis: LivePriceBasis = 'instant_sell_net'): LiveTotalV1[] {
	const unit = new Map(prices.map((entry) => [entry.itemId, entry.unitCopper] as const));
	const rank = (row: LiveTotalV1): number => {
		if (row.net < 0) return Number.NEGATIVE_INFINITY; const price = unit.get(row.idNumber);
		// The net basis ranks by the plain product, as it always did; only the gross one needs the commission worked out.
		return price == null ? -1 : basis === 'instant_sell_net' ? price * row.net : liveItemValueCopper(basis, price, row.net) ?? -1;
	};
	return totals.filter((row) => row.kind === 'item' && row.net !== 0).sort((a, b) => rank(b) - rank(a) || b.net - a.net);
}
type LiveSessionHistoryList = { status: 'ok'; sessions: LiveSessionHistoryEntry[]; ignored: number; setAside: LiveSessionSetAside[] }
	| { status: 'conflict'; invalid: number; duplicates: number } | { status: 'unavailable' };
type LiveSessionComparisonLoad = { status: 'ok'; comparison: LiveSessionComparison; ignored: number; setAside: LiveSessionSetAside[] }
	| Exclude<LiveSessionHistoryList, { status: 'ok' }>;
type LiveSessionHistorySelection = { status: 'found'; session: StoredLiveSessionPayloadV1 }
	| { status: 'missing' | 'conflict' | 'unavailable' };

type NoteOutcome = LiveHistoryNoteOutcome;

/** Explicit history actions read synced notes, so a new machine needs no old IDB journal. */
export class LiveSessionHistoryService {
	/** What each listed note inspected to, against the mtime it had: an unchanged note is not read again. Never kept for a note without a real mtime. */
	private readonly inspected = new Map<string,{ mtime: number; outcome: NoteOutcome; bytes: number }>();
	private inspectedBytes = 0;
	/**
	 * `cacheBytes` bounds the note text behind the remembered session payloads; a note that would exceed it is simply not remembered.
	 * `reads` are the durable history's shared reads (Z24): this history reads through them, and keeps what the durable history
	 * reads, so the same note is not read twice in a run. Without them it reads on its own, as before.
	 */
	constructor(private readonly vault: SessionHistoryVault, private readonly cacheBytes = 32 * 1024 * 1024,
		private readonly reads?: SessionNoteReads) {
		reads?.share((file, read) => { this.keepRead(file, read); });
	}
	/** Keeps another history's read of a note under this history's own rule: a real mtime, and the same budget. */
	private keepRead(file: SessionHistoryFile, read: SharedNoteRead): void {
		if (file.mtime === undefined || file.mtime <= 0 || this.inspected.get(file.path)?.mtime === file.mtime) return;
		this.remember(file.path, { mtime: file.mtime, outcome: read.live, bytes: read.liveBytes });
	}
	private forget(path: string): void {
		const known = this.inspected.get(path); if (known === undefined) return;
		this.inspectedBytes -= known.bytes; this.inspected.delete(path);
	}
	private remember(path: string, entry: { mtime: number; outcome: NoteOutcome; bytes: number }): void {
		this.forget(path);
		if (this.inspectedBytes + entry.bytes > this.cacheBytes) return; // over budget: kept notes stay, this one is read again next time
		this.inspected.set(path, entry); this.inspectedBytes += entry.bytes;
	}

	async list(): Promise<LiveSessionHistoryList> {
		const scan = await this.scan();
		if (scan.status !== 'ok') return scan;
		return { status: 'ok',ignored: scan.ignored,setAside: scan.setAside,sessions: scan.sessions.map((session) => ({
			sessionRef: session.sessionRef,startedAt: session.startedAt,endedAt: session.endedAt,observationCount: session.observationCount,
			estimatedValueCopper: session.valuation.knownNetValueCopper ?? session.valuation.netItemValueKnownCopper,
			itemCount: session.totals.filter((row) => row.kind === 'item').reduce((sum,row) => sum + row.net,0),
			items: sortLiveItemsByValue(session.totals,session.valuation.prices,session.valuation.priceBasis)
				.map((row) => ({ idNumber: row.idNumber,net: row.net })),
			currencies: liveHistoryCurrencies(session.totals),
		})) };
	}

	/** One explicit comparison load reuses the validated scan; no per-session rereads or API fallback. */
	async loadComparison(): Promise<LiveSessionComparisonLoad> {
		const scan = await this.scan();
		return scan.status === 'ok' ? { status: 'ok', comparison: buildLiveSessionComparison(scan.sessions), ignored: scan.ignored, setAside: scan.setAside } : scan;
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

	/** One note read and inspected: through the shared reads when there are, on its own otherwise. */
	private async readNote(file: SessionHistoryFile): Promise<{ outcome: NoteOutcome; bytes: number }> {
		if (this.reads !== undefined) {
			const read = await (await this.reads.read(file, 'join')).inspect();
			return { outcome: read.live, bytes: read.liveBytes };
		}
		return await inspectLiveHistoryNote(await this.vault.read(file));
	}

	private async scan(): Promise<{ status: 'ok'; sessions: StoredLiveSessionPayloadV1[]; ignored: number; setAside: LiveSessionSetAside[] }
		| Exclude<LiveSessionHistoryList,{ status: 'ok' }>> {
		try {
			const sessions: StoredLiveSessionPayloadV1[] = []; let ignored = 0; let invalid = 0; let duplicates = 0; const setAside: LiveSessionSetAside[] = [];
			const refs = new Set<string>();
			const files = this.vault.markdownFiles();
			const listed = new Set(files.map((file) => file.path));
			for (const path of [...this.inspected.keys()]) if (!listed.has(path)) this.forget(path);
			for (const file of files) {
				const cacheable = file.mtime !== undefined && file.mtime > 0;
				let outcome = cacheable ? this.inspected.get(file.path) : undefined;
				if (outcome === undefined || outcome.mtime !== file.mtime) {
					const inspected = await this.readNote(file);
					outcome = { mtime: file.mtime ?? 0, outcome: inspected.outcome, bytes: inspected.bytes };
					if (cacheable) this.remember(file.path, outcome); else this.forget(file.path);
				}
				const note = outcome.outcome;
				// A note this build cannot use is set aside with its path, never moved or rewritten, and never costs the others their listing.
				if (note.kind === 'invalid') { invalid += 1; setAside.push({ path: file.path, reason: 'unreadable' }); continue; }
				if (note.kind === 'unsupported') { setAside.push({ path: file.path, reason: 'newer_version' }); continue; }
				if (note.kind === 'ignored') { ignored += 1; continue; }
				if (refs.has(note.session.sessionRef)) duplicates += 1;
				refs.add(note.session.sessionRef); sessions.push(note.session);
			}
			// Two notes of one session stay a conflict: nothing decides which of them is the session.
			if (duplicates > 0) return { status: 'conflict',invalid,duplicates };
			return { status: 'ok',ignored,setAside: setAside.sort((a,b) => a.path.localeCompare(b.path)),sessions: sessions.sort((a,b) => b.startedAt.localeCompare(a.startedAt) || a.sessionRef.localeCompare(b.sessionRef)) };
		} catch { return { status: 'unavailable' }; }
	}
}

/** Frozen history is never a live source; current time cannot renew its last capture. */
export function liveSessionViewFromStored(payload: StoredLiveSessionPayloadV1, _now: number, offset = 0, limit = 200): LiveSessionViewV1 {
	const all = payload.journal.flatMap((entry) => entry.observations);
	const start = Math.max(0,Number.isSafeInteger(offset) ? offset : 0);
	const size = Math.max(1,Math.min(200,Number.isSafeInteger(limit) ? limit : 200));
	// Same criterion as the live chart: the whole session in at most 600 points.
	// The line ends at the session's last sample, which a version 2 journal may not have an entry for.
	// Every point is valued in the basis the saved valuation states, so the last one is the value saved with the session.
	const chart = buildLiveChart(payload.journal,{ prices: payload.valuation.prices,priceCapturedAt: payload.valuation.capturedAt,
		currencyTrackedIds: payload.valuation.coinNetCopper !== null ? [GOLD_CURRENCY_ID] : [],priceBasis: payload.valuation.priceBasis },600,payload.coverage.lastObservationAt);
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
