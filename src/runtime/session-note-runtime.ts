/**
 * The finished session's note and its summary (DE-01, step 3e): the live session's note when the
 * lifecycle completes it, the summary of a finished session (its write, the saved proof the next
 * session is released on, the retry and the "New session" that makes sure of it first), its
 * restore on a boot, with the one lookup across the vault a record from before the proof needs, and
 * the stored loot summary read back from the note.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps:
 * - building the services (`sessions`, `liveSessions`, `liveSessionLoot`, `sessionNotes`,
 *   `sessionHistory`, the detection quality whose initialization a retry waits for);
 * - the summary's state (`sessionSummarySaveState`, `storedSessionLootSummary`,
 *   `savedSessionNotePath`), which `LiveSessionRuntime` also writes on every way out of a session
 *   and the core's own Companion snapshot reads;
 * - the note's input (`sessionNoteInput`) and the economy it measures
 *   (`prepareSessionEconomyEvidence`), with the loot projection, Halloween and the farming context
 *   they read; the live entities' names (`getLiveSessionEntity`) and the start's opening.
 * It hands all of that through `SessionNoteRuntimePort`; the getters below carry the names of the
 * core's own fields, so the moved code reads as it did there. `LiveSessionRuntime` reaches the
 * summary's write and its proof here, through the core's port.
 *
 * Its name holds `session-note` and `session-runtime`, so `scripts/security-scan.mjs` treats it as a
 * persisted-session boundary and `security-boundary.test.ts` keeps the account key and its providers
 * out of it: it writes the session's notes and the saved proof, through the core's writer and store.
 */
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { TyrianSettings } from '../core/settings';
import { sha256Text } from '../assets/generic-assets';
import type { TyrianUiPort } from '../host/tyrian-host';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { LiveSessionLootTracker } from '../sessions/live-session-loot';
import type { LiveJournalEntryV1, LiveSessionFormat, LiveSessionRuntimeRecord } from '../sessions/live-session-model';
import { knownLiveDisplayNames } from '../sessions/live-session-note-model';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import type { DurableSessionLookup, SessionHistoryService } from '../sessions/session-history';
import type { SessionNoteInput } from '../sessions/session-note-model';
import type { StoredSessionLootSummary } from '../sessions/session-note-renderer';
import type { SessionNoteWriter, SessionNoteWriteResult } from '../sessions/session-note-writer';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import { writeSessionNoteWithDiagnostics } from './core-actions';
import type { SessionSummarySaveState } from './live-session-runtime';

/**
 * Everything `SessionNoteRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field or method, read live: a service the core builds in `initializeRuntime` is seen
 * as it stands at the moment of the read. The summary fields are written through, to the core's own.
 */
export interface SessionNoteRuntimePort {
	readonly settings: {
		readonly language: TyrianSettings['language'];
		/** Where the live session's note goes. */
		readonly outputFolder: TyrianSettings['outputFolder'];
	};
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** Opens the note the plugin just wrote. */
	readonly host: { readonly ui: Pick<TyrianUiPort, 'openNote'> };
	/** Built in `initializeRuntime`; read only from a step that needs it. */
	readonly sessions: Pick<
		ManualSessionStartService,
		'getState' | 'getCompletedSummaryReceipt' | 'getCompletedRuntimeRecord' | 'markCompletedSummarySaved'
	>;
	/** The live session's lifecycle, built in `initializeRuntime`; null before it and on a device without one. */
	readonly liveSessions: Pick<LiveSessionLifecycle, 'getRuntime'> | null;
	readonly liveSessionLoot: Pick<LiveSessionLootTracker, 'getState' | 'begin' | 'reconcile'>;
	readonly sessionNotes: Pick<SessionNoteWriter, 'write' | 'writeLive'>;
	readonly sessionHistory: Pick<SessionHistoryService, 'readSession' | 'readSessionAt'>;
	/** The detection quality's initialization, replaced by the boot: a retry waits for it. */
	readonly detectionQualityInitialization: Promise<unknown>;
	/** The core's own; `LiveSessionRuntime` writes them too, the Companion snapshot reads them. */
	sessionSummarySaveState: SessionSummarySaveState;
	storedSessionLootSummary: StoredSessionLootSummary | null;
	savedSessionNotePath: string | null;
	emitNotice(message: string, source: 'session_command'): void;
	renderViews(): void;
	refreshLootPresentation(): Promise<void>;
	/** Measures the finished session's economy again before its note is written (the core's). */
	prepareSessionEconomyEvidence(runtime: SessionRuntimeRecord, remeasure: boolean): Promise<void>;
	/** The note's input for a finished session's record (the core's). */
	sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput;
	/** A live entity's known name, which the live note writes instead of the bare id (the core's). */
	getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null;
	/** Opens the ordinary start (the core's, through `LiveSessionRuntime`). */
	openManualSessionStart(): void;
}

export class SessionNoteRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: SessionNoteRuntimePort) {}

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): SessionNoteRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get host(): SessionNoteRuntimePort['host'] { return this.port.host; }
	private get sessions(): SessionNoteRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): SessionNoteRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get liveSessionLoot(): SessionNoteRuntimePort['liveSessionLoot'] { return this.port.liveSessionLoot; }
	private get sessionNotes(): SessionNoteRuntimePort['sessionNotes'] { return this.port.sessionNotes; }
	private get sessionHistory(): SessionNoteRuntimePort['sessionHistory'] { return this.port.sessionHistory; }
	private get detectionQualityInitialization(): Promise<unknown> { return this.port.detectionQualityInitialization; }
	private get sessionSummarySaveState(): SessionSummarySaveState { return this.port.sessionSummarySaveState; }
	private set sessionSummarySaveState(value: SessionSummarySaveState) { this.port.sessionSummarySaveState = value; }
	private get storedSessionLootSummary(): StoredSessionLootSummary | null { return this.port.storedSessionLootSummary; }
	private set storedSessionLootSummary(value: StoredSessionLootSummary | null) { this.port.storedSessionLootSummary = value; }
	private get savedSessionNotePath(): string | null { return this.port.savedSessionNotePath; }
	private set savedSessionNotePath(value: string | null) { this.port.savedSessionNotePath = value; }
	private emitNotice(message: string, source: 'session_command'): void { this.port.emitNotice(message, source); }
	private renderViews(): void { this.port.renderViews(); }
	private sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput { return this.port.sessionNoteInput(runtime); }
	private getLiveSessionEntity(kind: 'item' | 'currency', id: number): { name: string; icon: string | null } | null {
		return this.port.getLiveSessionEntity(kind, id);
	}
	private openManualSessionStart(): void { this.port.openManualSessionStart(); }
	// These hand back the core's own promise, so an await on them takes the ticks it took there.
	private refreshLootPresentation(): Promise<void> { return this.port.refreshLootPresentation(); }
	private prepareSessionEconomyEvidence(runtime: SessionRuntimeRecord, remeasure: boolean): Promise<void> {
		return this.port.prepareSessionEconomyEvidence(runtime, remeasure);
	}

	/** `format` is the one the lifecycle hands over with the session: the note is written in the format that session started with. */
	async saveLiveSessionNote(record: LiveSessionRuntimeRecord, journal: readonly LiveJournalEntryV1[], format: LiveSessionFormat): Promise<string|null> {
		// An entity nobody has named gets no key: the note then writes «Objeto <id>» / «Moneda <id>», never the bare id.
		const displayNames = knownLiveDisplayNames(record.totals,(kind,id) => this.getLiveSessionEntity(kind,id)?.name);
		const result = await this.sessionNotes.writeLive({record,journal,format,locale:this.settings.language,outputFolder:this.settings.outputFolder,displayNames});
		const saved = result.status === 'written' || result.status === 'unchanged';
		if (this.liveSessions?.getRuntime()?.sessionId === record.sessionId) {
			this.sessionSummarySaveState = saved ? 'saved' : 'failed';
			if (saved) this.savedSessionNotePath = result.path;
		}
		if (result.status === 'written' || result.status === 'unchanged') return result.path;
		// The writer's own answer, not a generic error: an `invalid` note (and its reason) and a
		// vault that refuses the write read the same from outside, a finished session that never
		// lets the next one start, and the log could not tell them apart.
		this.localDebugActions?.event({
			component: 'session', action: 'session_finish', state: 'live_note_write',
			level: 'error', phase: 'failure', code: 'storage_failure',
			details: { status: result.status, reason: 'reason' in result ? result.reason : 'errorName' in result ? result.errorName ?? null : null },
		});
		return null;
	}

	getSessionSummarySaveState(): SessionSummarySaveState {
		return this.sessionSummarySaveState;
	}

	getStoredSessionLootSummary(): StoredSessionLootSummary | null {
		return this.storedSessionLootSummary === null ? null : structuredClone(this.storedSessionLootSummary);
	}

	getSavedSessionNotePath(): string | null {
		return this.savedSessionNotePath;
	}

	/** Opens the note the plugin just wrote; it is the only delivery of the completed summary. */
	openSavedSessionNote(): void {
		const path = this.savedSessionNotePath;
		if (path === null) return;
		this.host.ui.openNote(path);
	}

	async retrySessionSummarySave(): Promise<void> {
		const [quality] = await Promise.allSettled([this.detectionQualityInitialization]);
		if (quality?.status === 'rejected') {
			this.sessionSummarySaveState = 'failed';
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			this.renderViews();
			return;
		}
		const runtime = await this.sessions.getCompletedRuntimeRecord();
		if (runtime !== null && runtime.state.status === 'complete' && runtime.delta !== null) {
			if (this.liveSessionLoot.getState().status === 'idle') this.liveSessionLoot.begin(runtime.state.sessionId, true);
			await this.liveSessionLoot.reconcile(runtime.state.sessionId, runtime.delta);
		}
		const note = await this.persistCompletedSessionSummary(true, runtime ?? undefined);
		if ((note?.status === 'written' || note?.status === 'unchanged') && runtime?.state.status === 'complete') {
			await this.readStoredSessionLoot(runtime.state.sessionId, note.path);
		}
		await this.refreshLootPresentation();
		this.renderViews();
	}

	/**
	 * "New session" from a finished one (H18.8). It no longer clears anything itself, and no longer
	 * scans every note in the vault to prove the summary exists: it only makes sure the summary is
	 * saved (idempotent, and a no-op once it already was) and opens the ordinary start. The start
	 * releases the finished session only once it has started, so cancelling it changes nothing.
	 */
	async rotateToNewSession(): Promise<void> {
		if (this.sessions.getState().status !== 'complete') return;
		if (!await this.ensureCompletedSummarySaved()) {
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.newSessionBlocked'),
				'session_command',
			);
			return;
		}
		this.openManualSessionStart();
	}

	/**
	 * True once the finished session's summary is proven to be in the vault, writing it first when
	 * nothing proves that yet. Never rewrites a summary already proven saved, so a note the player
	 * moved or edited since neither blocks the next session nor gets a duplicate.
	 */
	async ensureCompletedSummarySaved(): Promise<boolean> {
		if (this.sessions.getState().status !== 'complete') return true;
		if (this.sessions.getCompletedSummaryReceipt() !== null) return true;
		const note = await this.persistCompletedSessionSummary(true);
		return (note?.status === 'written' || note?.status === 'unchanged')
			&& this.sessions.getCompletedSummaryReceipt() !== null;
	}

	/**
	 * Boot with a finished session (H18.8). The saved proof says where its summary went, so only
	 * that one note is read, for its loot summary; a note moved since still counts as saved. Only a
	 * record from before the proof existed falls back, once, to the old full lookup, and leaves the
	 * proof behind when it finds the note.
	 */
	async restoreCompletedSessionSummary(): Promise<void> {
		const receipt = this.sessions.getCompletedSummaryReceipt();
		if (receipt !== null) {
			this.sessionSummarySaveState = 'saved';
			this.savedSessionNotePath = receipt.path;
			await this.readStoredSessionLoot(receipt.sessionId, receipt.path);
			return;
		}
		const found = await this.inspectCompletedSessionSummary();
		if (found !== null) {
			this.savedSessionNotePath = found;
			await this.sessions.markCompletedSummarySaved(found);
		}
	}

	/** Reads the stored loot summary from the one note the session was written to. */
	private async readStoredSessionLoot(sessionId: string, path: string): Promise<void> {
		const durable = await this.sessionHistory.readSessionAt(path, await sha256Text(sessionId));
		this.storedSessionLootSummary = durable.status === 'found' ? durable.loot : null;
		if (this.runtimeReady) this.renderViews();
	}

	/** Legacy full lookup of the completed session's note; returns its path when found. */
	private async inspectCompletedSessionSummary(existingRuntime?: SessionRuntimeRecord): Promise<string | null> {
		const runtime = existingRuntime ?? await this.sessions.getCompletedRuntimeRecord();
		if (runtime === null || runtime.state.status !== 'complete') {
			this.sessionSummarySaveState = 'failed';
			this.storedSessionLootSummary = null;
			return null;
		}
		let durable: DurableSessionLookup;
		try { durable = await this.sessionHistory.readSession(await sha256Text(runtime.state.sessionId)); }
		catch { durable = { status: 'unavailable' }; }
		this.sessionSummarySaveState = durable.status === 'found' ? 'saved' : 'failed';
		this.storedSessionLootSummary = durable.status === 'found' ? durable.loot : null;
		if (this.runtimeReady) this.renderViews();
		return durable.status === 'found' ? durable.path : null;
	}

	async persistCompletedSessionSummary(
		notifyFailure: boolean,
		existingRuntime?: SessionRuntimeRecord,
	): Promise<SessionNoteWriteResult | null> {
		this.sessionSummarySaveState = 'saving';
		if (this.runtimeReady) this.renderViews();
		const runtime = existingRuntime ?? await this.sessions.getCompletedRuntimeRecord();
		if (runtime === null) {
			this.sessionSummarySaveState = 'failed';
			if (notifyFailure) this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return null;
		}
		// Writing the note is the user's own retry, so the economy is measured again here rather
		// than reused: a catalog that was unreachable at close must not freeze the note as unvalued.
		await this.prepareSessionEconomyEvidence(runtime, true);
		let note: SessionNoteWriteResult;
		try {
			note = await writeSessionNoteWithDiagnostics(
				this.localDebugActions, () => this.sessionNotes.write(this.sessionNoteInput(runtime)),
			);
		} catch {
			this.sessionSummarySaveState = 'failed';
			if (notifyFailure) this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return null;
		}
		const durable = note.status === 'written' || note.status === 'unchanged' ? note : null;
		// The proof the next session releases this one on (H18.8): no vault scan, no rewrite later.
		if (durable !== null) await this.sessions.markCompletedSummarySaved(durable.path);
		this.sessionSummarySaveState = durable === null ? 'failed' : 'saved';
		this.savedSessionNotePath = durable?.path ?? null;
		if (this.runtimeReady) this.renderViews();
		if (this.sessionSummarySaveState === 'failed' && notifyFailure) this.emitNotice(
			translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
			'session_command',
		);
		return note;
	}
}
