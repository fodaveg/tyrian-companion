import type { LiveJournalEntryV1, LiveSessionRuntimeRecord } from './live-session-model';
import { prepareLiveSessionPayload } from './live-session-note-model';
import { summaryMainMap, type SummaryItemMetaMap } from './live-session-summary-figures';
import { readComparablePerHour, type SummaryHistoryVault } from './live-session-summary-history';
import { LiveSessionSummaryWriter, type LiveSessionSummaryVault, type LiveSessionSummaryWriteResult } from './live-session-summary-note';

/** At most this many attempts per session, at least this far apart: a failing vault is not hammered. */
export const LIVE_SUMMARY_MAX_ATTEMPTS = 3;
export const LIVE_SUMMARY_RETRY_MS = 60_000;
/** Map names are cosmetic: the summary waits this long for the public API and then writes «Mapa <id>». */
export const LIVE_SUMMARY_MAP_WAIT_MS = 5_000;

export interface LiveSessionSummaryServiceOptions {
	vault: LiveSessionSummaryVault & SummaryHistoryVault;
	runtime(): LiveSessionRuntimeRecord | null;
	journal(): readonly LiveJournalEntryV1[];
	locale(): 'es' | 'en';
	outputFolder(): string;
	displayNames(record: LiveSessionRuntimeRecord): Record<string, string>;
	/** Flags and types of the given items from the catalog CACHE only; never the network. */
	itemMeta(itemIds: readonly number[]): Promise<SummaryItemMetaMap>;
	/** Map names by decimal id: cache first, then the public API. The service bounds the wait. */
	mapNames(mapIds: readonly number[]): Promise<Record<string, string>>;
	/** False in consult mode and after unload: the same gate that governs the full note. */
	enabled(): boolean;
	now(): number;
	/** Diagnostics only; a failure here never reaches the session. */
	onFailure(details: { status: string; reason: string | null; attempt: number }): void;
	/** Starts a timer and returns how to cancel it (the host's `window` timers; the service owns no global). */
	startTimer(callback: () => void, ms: number): () => void;
	/** Test seam for the map-name wait. */
	mapWaitMs?: number;
}

interface Progress { sessionId: string; attempts: number; lastAttemptAt: number; done: boolean; running: boolean }

/**
 * Writes the summary note of the closed session AFTER its full note is saved and acknowledged:
 * `observe()` does nothing until the runtime is `complete` and carries its `summaryReceipt`.
 * The host calls it on every lifecycle state change (the receipt itself raises one), so the retry
 * policy is: the first attempt right after the receipt, then at most two more on later state
 * changes at least a minute apart. No timer of its own, no loop; once the session is replaced
 * the summary is not retried (the next start, which still sees the completed session, tries again).
 * A failure is logged and never thrown, so it cannot hold the session, the header or the next start.
 * Everything optional (flags, map names, earlier summaries) degrades to «unknown» instead of failing.
 */
export class LiveSessionSummaryService {
	private progress: Progress | null = null;
	private readonly writer: LiveSessionSummaryWriter;

	constructor(private readonly options: LiveSessionSummaryServiceOptions) {
		this.writer = new LiveSessionSummaryWriter(options.vault);
	}

	async observe(): Promise<void> {
		try { await this.attempt(); } catch (error) {
			this.options.onFailure({ status: 'unexpected', reason: error instanceof Error ? error.name : null, attempt: this.progress?.attempts ?? 0 });
		}
	}

	private async attempt(): Promise<void> {
		if (!this.options.enabled()) return;
		const record = this.options.runtime();
		const receipt = record?.summaryReceipt ?? null;
		if (record === null || record.phase !== 'complete' || receipt === null || receipt.sessionId !== record.sessionId) return;
		if (this.progress?.sessionId !== record.sessionId) this.progress = { sessionId: record.sessionId, attempts: 0, lastAttemptAt: 0, done: false, running: false };
		const progress = this.progress;
		const now = this.options.now();
		if (progress.done || progress.running || progress.attempts >= LIVE_SUMMARY_MAX_ATTEMPTS
			|| progress.attempts > 0 && now - progress.lastAttemptAt < LIVE_SUMMARY_RETRY_MS) return;
		progress.running = true; progress.attempts += 1; progress.lastAttemptAt = now;
		try {
			const locale = this.options.locale(); const outputFolder = this.options.outputFolder();
			const session = await prepareLiveSessionPayload({ record, journal: this.options.journal(), locale, outputFolder });
			if (session === null) { progress.done = true; this.options.onFailure({ status: 'invalid', reason: 'invalid_live_evidence', attempt: progress.attempts }); return; }
			const itemIds = session.totals.filter((row) => row.kind === 'item' && row.net !== 0).map((row) => row.idNumber);
			const mapIds = [...new Set(session.mapIntervals.flatMap((interval) => interval.mapId === null ? [] : [interval.mapId]))];
			const [itemMeta, mapNames, comparablePerHour] = await Promise.all([
				optional(() => this.options.itemMeta(itemIds), {}),
				optional(() => this.boundedMapNames(mapIds), {}),
				optional(() => readComparablePerHour(this.options.vault, outputFolder, summaryMainMap(session), session.sessionRef), []),
			]);
			const result: LiveSessionSummaryWriteResult = await this.writer.write({ session, locale, outputFolder, fullNotePath: receipt.path,
				displayNames: this.options.displayNames(record), characters: record.characters ?? [], itemMeta, mapNames, comparablePerHour });
			if (result.status === 'written' || result.status === 'unchanged' || result.status === 'kept') { progress.done = true; return; }
			// Invalid input will not heal by itself; a conflict is somebody else's note on our path.
			if (result.status === 'invalid' || result.status === 'conflict') progress.done = true;
			this.options.onFailure({ status: result.status, attempt: progress.attempts,
				reason: 'reason' in result ? result.reason : 'errorName' in result ? result.errorName ?? null : null });
		} finally { progress.running = false; }
	}

	/** Never longer than `mapWaitMs`: a slow API costs the name, not the summary. */
	private async boundedMapNames(mapIds: readonly number[]): Promise<Record<string, string>> {
		if (mapIds.length === 0) return {};
		let cancel = (): void => undefined;
		const wait = new Promise<Record<string, string>>((resolve) => { cancel = this.options.startTimer(() => { resolve({}); }, this.options.mapWaitMs ?? LIVE_SUMMARY_MAP_WAIT_MS); });
		try { return await Promise.race([this.options.mapNames(mapIds), wait]); } finally { cancel(); }
	}
}

/** Optional context: whatever fails here is simply absent from the note. */
async function optional<T>(work: () => Promise<T>, fallback: T): Promise<T> {
	try { return await work(); } catch { return fallback; }
}
