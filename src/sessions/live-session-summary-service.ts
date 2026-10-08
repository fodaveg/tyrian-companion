import type { LiveJournalEntryV1, LiveSessionRuntimeRecord } from './live-session-model';
import { prepareLiveSessionPayload } from './live-session-note-model';
import { LiveSessionSummaryWriter, type LiveSessionSummaryVault, type LiveSessionSummaryWriteResult } from './live-session-summary-note';

/** At most this many attempts per session, at least this far apart: a failing vault is not hammered. */
export const LIVE_SUMMARY_MAX_ATTEMPTS = 3;
export const LIVE_SUMMARY_RETRY_MS = 60_000;

export interface LiveSessionSummaryServiceOptions {
	vault: LiveSessionSummaryVault;
	runtime(): LiveSessionRuntimeRecord | null;
	journal(): readonly LiveJournalEntryV1[];
	locale(): 'es' | 'en';
	outputFolder(): string;
	displayNames(record: LiveSessionRuntimeRecord): Record<string, string>;
	/** False in consult mode and after unload: the same gate that governs the full note. */
	enabled(): boolean;
	now(): number;
	/** Diagnostics only; a failure here never reaches the session. */
	onFailure(details: { status: string; reason: string | null; attempt: number }): void;
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
			const session = await prepareLiveSessionPayload({ record, journal: this.options.journal(), locale: this.options.locale(),
				outputFolder: this.options.outputFolder() });
			if (session === null) { progress.done = true; this.options.onFailure({ status: 'invalid', reason: 'invalid_live_evidence', attempt: progress.attempts }); return; }
			const result: LiveSessionSummaryWriteResult = await this.writer.write({ session, locale: this.options.locale(),
				outputFolder: this.options.outputFolder(), fullNotePath: receipt.path, displayNames: this.options.displayNames(record) });
			if (result.status === 'written' || result.status === 'unchanged' || result.status === 'kept') { progress.done = true; return; }
			// Invalid input will not heal by itself; a conflict is somebody else's note on our path.
			if (result.status === 'invalid' || result.status === 'conflict') progress.done = true;
			this.options.onFailure({ status: result.status, attempt: progress.attempts,
				reason: 'reason' in result ? result.reason : 'errorName' in result ? result.errorName ?? null : null });
		} finally { progress.running = false; }
	}
}
