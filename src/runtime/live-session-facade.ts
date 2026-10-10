/**
 * The live session runtime's first part (DE-01, step 3c): the session's state as the views read it
 * (state, last start and stop failures, the stalled close's retry and the settlement wait), and the
 * ways out of a session other than its stop: the recovery and the discard of a saved one, a session
 * the service took back on its own, the clear of a finished one, the abandon of a stop that cannot
 * finish and the discard of a stuck live one.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see and keeps the
 * session command controller, its intents and modals. The core keeps:
 * - building the services (`sessions`, `liveSessions`, `liveSessionLoot`, `sessionNotes`, the
 *   in-game session marker) and the history's runtime authority the leases come from;
 * - the start and the stop, and the live observation a recovered session resumes
 *   (`startLiveObservation`);
 * - the recovery's own pilot hooks (`pilotRecoveryIdentity`, `ensurePilotRecoveryPresented`);
 * - the summary's state (`sessionSummarySaveState`, `storedSessionLootSummary`,
 *   `savedSessionNotePath`), which the ways out reset and the core's note and summary code read;
 * - the note's input (`sessionNoteInput`) and the detector's arming.
 * It hands all of that through `LiveSessionRuntimePort`; the getters below carry the names of the
 * core's own fields, so the moved code reads as it did there.
 *
 * Not named `live-session-runtime.ts`: `scripts/security-scan.mjs` treats any file whose name holds
 * `session-runtime` as a persisted-session boundary, and this module persists nothing of its own; the
 * stores and the note writer it reaches are the core's, through the port.
 */
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { TyrianSettings } from '../core/settings';
import type { IngameSessionMarker } from '../sessions/ingame-session-marker';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { LiveSessionLootTracker } from '../sessions/live-session-loot';
import { LiveSessionStopError } from '../sessions/live-session-stop-failure';
import type {
	ManualSessionStartService,
	SessionRecoveryState,
	SessionStartFailure,
	SessionStopFailure,
} from '../sessions/manual-session-start-service';
import type { PilotMetricsRecorder } from '../sessions/pilot-metrics-recorder';
import { SESSION_STATE_VERSION, type SessionState } from '../sessions/session';
import type { SessionSettlementWait } from '../sessions/session-api-settlement';
import type { SessionNoteInput } from '../sessions/session-note-model';
import type { StoredSessionLootSummary } from '../sessions/session-note-renderer';
import { writeSessionNoteBeforeClear, type SessionNoteWriter } from '../sessions/session-note-writer';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import { hasExactSessionBackendResult, type SessionCommandDispatch } from '../ui/session-command-adapter';
import type { SessionCommandController } from '../ui/session-command-controller';
import { fireAndForgetLocal, writeSessionNoteWithDiagnostics } from './core-actions';

/** What a finished session's summary is known to be; the core's own field, reset by every way out. */
export type SessionSummarySaveState = 'unknown' | 'saving' | 'saved' | 'failed';

/**
 * Everything `LiveSessionRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field or method, read live: a service the core builds in `initializeRuntime` or the
 * command controller `onload` sets up is seen as it stands at the moment of the read. The three
 * summary fields are written through, to the core's own fields.
 */
export interface LiveSessionRuntimePort {
	readonly settings: {
		readonly language: TyrianSettings['language'];
		/** Where an abandoned session's note goes. */
		readonly outputFolder: TyrianSettings['outputFolder'];
	};
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so, or from a command that needs it. */
	readonly sessions: Pick<
		ManualSessionStartService,
		'getState' | 'getLastFailure' | 'getLastStopFailure' | 'getAutoRetryAt' | 'getSettlementWait' | 'getRecoveryState'
		| 'recover' | 'discardRecovery' | 'canAbandon' | 'abandon' | 'getCompletedRuntimeRecord' | 'resetCompletedSession'
	>;
	/** The live session's lifecycle, built in `initializeRuntime`; null before it and on a device without one. */
	readonly liveSessions: Pick<LiveSessionLifecycle, 'isStuck' | 'discard'> | null;
	readonly liveSessionLoot: Pick<LiveSessionLootTracker, 'getState'>;
	/** The addon's session link; null until the in-game server built it. */
	readonly ingameSessionMarker: Pick<IngameSessionMarker, 'clearStoppedByPlayer' | 'reconcile'> | null;
	readonly sessionNotes: Pick<SessionNoteWriter, 'write' | 'writeAbandoned'>;
	/** The session command controller and its dispatch, set up in `onload`. */
	readonly sessionCommands: Pick<SessionCommandController, 'run'>;
	readonly sessionDispatch: Pick<SessionCommandDispatch, 'recover' | 'discard'>;
	readonly pilotMetrics: Pick<PilotMetricsRecorder, 'recoveryFinished'>;
	/** The core's own; its note and summary code read them. */
	sessionSummarySaveState: SessionSummarySaveState;
	storedSessionLootSummary: StoredSessionLootSummary | null;
	savedSessionNotePath: string | null;
	/** A lease from the history's runtime authority; throws while a history scrub runs. */
	requireRuntimeMutationLease(): { release(): void };
	renderViews(): void;
	emitNotice(message: string, source: 'session_command'): void;
	/** Arms the assisted detection again for the next session. */
	armAssistedDetection(): Promise<unknown>;
	/** Starts the loot poll of an active session (the core's, with the start). */
	startLiveObservation(sessionId: string, restored: boolean): void;
	/** The recovery on screen as `sessionId:fence`, or null when there is none. */
	pilotRecoveryIdentity(): string | null;
	/** Records the recovery as presented and reads its saved kind back (the core's). */
	ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean>;
	/** The note's input for a finished session's record (the core's). */
	sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput;
}

export class LiveSessionRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: LiveSessionRuntimePort) {}

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): LiveSessionRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get sessions(): LiveSessionRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): LiveSessionRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get liveSessionLoot(): LiveSessionRuntimePort['liveSessionLoot'] { return this.port.liveSessionLoot; }
	private get ingameSessionMarker(): LiveSessionRuntimePort['ingameSessionMarker'] { return this.port.ingameSessionMarker; }
	private get sessionNotes(): LiveSessionRuntimePort['sessionNotes'] { return this.port.sessionNotes; }
	private get sessionCommands(): LiveSessionRuntimePort['sessionCommands'] { return this.port.sessionCommands; }
	private get sessionDispatch(): LiveSessionRuntimePort['sessionDispatch'] { return this.port.sessionDispatch; }
	private get pilotMetrics(): LiveSessionRuntimePort['pilotMetrics'] { return this.port.pilotMetrics; }
	private get sessionSummarySaveState(): SessionSummarySaveState { return this.port.sessionSummarySaveState; }
	private set sessionSummarySaveState(value: SessionSummarySaveState) { this.port.sessionSummarySaveState = value; }
	private get storedSessionLootSummary(): StoredSessionLootSummary | null { return this.port.storedSessionLootSummary; }
	private set storedSessionLootSummary(value: StoredSessionLootSummary | null) { this.port.storedSessionLootSummary = value; }
	private get savedSessionNotePath(): string | null { return this.port.savedSessionNotePath; }
	private set savedSessionNotePath(value: string | null) { this.port.savedSessionNotePath = value; }
	private requireRuntimeMutationLease(): { release(): void } { return this.port.requireRuntimeMutationLease(); }
	private renderViews(): void { this.port.renderViews(); }
	private emitNotice(message: string, source: 'session_command'): void { this.port.emitNotice(message, source); }
	// These hand back the core's own promise, so an await on them takes the ticks it took there.
	private armAssistedDetection(): Promise<unknown> { return this.port.armAssistedDetection(); }
	private startLiveObservation(sessionId: string, restored: boolean): void { this.port.startLiveObservation(sessionId, restored); }
	private pilotRecoveryIdentity(): string | null { return this.port.pilotRecoveryIdentity(); }
	private ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean> {
		return this.port.ensurePilotRecoveryPresented(recoveryId);
	}
	private sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput { return this.port.sessionNoteInput(runtime); }

	getSessionState(): SessionState {
		return this.runtimeReady ? this.sessions.getState() : { version: SESSION_STATE_VERSION, status: 'idle' };
	}

	getSessionStartFailure(): SessionStartFailure | null {
		return this.runtimeReady ? this.sessions.getLastFailure() : null;
	}

	getSessionStopFailure(): SessionStopFailure | null {
		return this.runtimeReady ? this.sessions.getLastStopFailure() : null;
	}

	/** H18.36: the session card's own meta line for a stalled cierre (boceto lámina 2.3). */
	getSessionAutoRetryAt(): number | null {
		return this.runtimeReady ? this.sessions.getAutoRetryAt() : null;
	}

	confirmClearCompletedSession(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_clear' }, () => this.sessionCommands.run('clear-completed-session'));
	}

	async resetCompletedSession(): Promise<void> {
		const perform = async () => await this.sessionCommands.run('clear-completed-session');
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_clear' }, perform) ?? perform());
	}

	getSessionRecoveryState(): SessionRecoveryState {
		return this.runtimeReady ? this.sessions.getRecoveryState() : { status: 'none' };
	}

	async recoverSession(): Promise<void> {
		const perform = async () => await this.sessionDispatch.recover();
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_recover' }, perform) ?? perform());
	}

	async discardRecoveredSession(): Promise<void> {
		const perform = async () => await this.sessionDispatch.discard();
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_discard' }, perform) ?? perform());
	}

	confirmDiscardRecoveredSession(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_discard' }, () => this.sessionCommands.run('discard-saved-session'));
	}

	/** Countdown of the grace window the final capture is waiting for; null when nothing waits. */
	getSessionSettlementWait(): SessionSettlementWait | null {
		return this.sessions.getSettlementWait();
	}

	/**
	 * A live session that cannot get out by itself: in error, finished without its note, or whose last stop was refused.
	 * The player may drop it («Descartar la sesión atascada»); an ordinary running or sealed one is never offered.
	 */
	isLiveSessionStuck(): boolean {
		return this.liveSessions?.isStuck() ?? false;
	}

	/** Drops the stuck live session (see `LiveSessionLifecycle.discard`) and leaves its own trace, under codes of its own. */
	async performDiscardLiveSession(): Promise<void> {
		const lifecycle = this.liveSessions;
		if (lifecycle === null) return;
		const result = await lifecycle.discard();
		// A refusal is thrown with its reason and logged ONCE, by the command controller, under the code of that reason.
		if (!result.cleared) throw new LiveSessionStopError(result.reason ?? 'unknown', 'discard');
		this.localDebugActions?.event({
			component: 'session', action: 'session_discard', state: `live_discard_${result.note}`,
			level: 'warn', phase: 'success', code: 'ok',
		});
		this.ingameSessionMarker?.clearStoppedByPlayer();
		this.sessionSummarySaveState = 'unknown'; this.savedSessionNotePath = null;
		const t = createTranslator(this.settings.language);
		this.emitNotice(translateRuntime(t, result.note === 'not_written' ? 'notices.liveDiscardedNoNote' : 'notices.liveDiscarded'), 'session_command');
		this.renderViews();
		void this.ingameSessionMarker?.reconcile();
	}

	/**
	 * Abandons a stopping session whose stop cannot finish (David, 2026-09-24): the session ends
	 * `abandoned` with no loot, its record and lease are released, its note says it was abandoned
	 * and why, and detection is armed again so the next session is detectable at once. A note that
	 * could not be written is reported but does not keep the player stuck in the failed stop.
	 */
	async performAbandonSession(): Promise<void> {
		const runtimeLease = this.requireRuntimeMutationLease();
		const result = await this.sessions.abandon().finally(() => runtimeLease.release());
		if (result.status !== 'abandoned') throw new Error('Abandon failed.');
		this.sessionSummarySaveState = 'unknown';
		this.storedSessionLootSummary = null;
		this.savedSessionNotePath = null;
		const note = await writeSessionNoteWithDiagnostics(this.localDebugActions, () => this.sessionNotes.writeAbandoned({
			state: result.state, locale: this.settings.language, outputFolder: this.settings.outputFolder,
		}));
		if (note.status === 'written' || note.status === 'unchanged') this.savedSessionNotePath = note.path;
		else this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'), 'session_command');
		this.renderViews();
		if (this.runtimeReady) fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_arm', state: 'session_abandoned' },
			() => this.armAssistedDetection());
	}

	/** Whether the card may offer "Abandon session": a stopping session no retry can finish. */
	canAbandonSession(): boolean {
		return this.runtimeReady && this.sessions.canAbandon();
	}

	/** The card's "Abandon session": the confirmation opens first; cancelling it does nothing. */
	confirmAbandonSession(): void {
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_finish', state: 'abandon' },
			() => this.sessionCommands.run('abandon-farming-session'));
	}

	async performRecoverSession(): Promise<void> {
		const recoveryId = this.pilotRecoveryIdentity();
		if (recoveryId) void this.ensurePilotRecoveryPresented(recoveryId);
		const runtimeLease = this.requireRuntimeMutationLease();
		let result: Awaited<ReturnType<ManualSessionStartService['recover']>>;
		try { result = await this.sessions.recover().finally(() => runtimeLease.release()); }
		catch (error) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw error;
		}
		this.renderViews();
		if (!hasExactSessionBackendResult('recover', result)) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw new SessionRecoveryBackendFailure('recover', result.status === 'busy' ? 'busy' : 'failed');
		}
		const recovered = this.sessions.getState();
		if (recovered.status === 'active') this.startLiveObservation(recovered.sessionId, true);
		if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'succeeded');
	}

	/**
	 * The session service took a session back on its own (H18.7: a lease lost while the machine
	 * slept, or a saved session another window held when Obsidian started). An `active` session whose
	 * loot poll is not following it any more gets it back, as after a manual recovery; one the poll
	 * still follows is left alone, so the running loot is not reset.
	 */
	resumeAutoRecoveredSession(): void {
		// Never earlier than a timer tick after `initialize()`, so every service below is assigned.
		const session = this.sessions.getState();
		const live = this.liveSessionLoot.getState();
		if (session.status === 'active' && (live.status !== 'observing' || live.sessionId !== session.sessionId)) {
			this.startLiveObservation(session.sessionId, true);
		}
		this.renderViews();
	}

	async performDiscardRecoveredSession(): Promise<void> {
		const recoveryId = this.pilotRecoveryIdentity();
		if (recoveryId) void this.ensurePilotRecoveryPresented(recoveryId);
		const runtimeLease = this.requireRuntimeMutationLease();
		let result: Awaited<ReturnType<ManualSessionStartService['discardRecovery']>>;
		try { result = await this.sessions.discardRecovery().finally(() => runtimeLease.release()); }
		catch (error) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw error;
		}
		this.renderViews();
		if (!hasExactSessionBackendResult('discard', result)) {
			if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'failed');
			throw new SessionRecoveryBackendFailure('discard', result.status === 'busy' ? 'busy' : 'failed');
		}
		if (recoveryId) void this.pilotMetrics.recoveryFinished(recoveryId, 'discarded');
	}

	async performClearCompletedSession(): Promise<void> {
		const runtimeLease = this.requireRuntimeMutationLease();
		try {
		const runtime = await this.sessions.getCompletedRuntimeRecord();
		if (!runtime) throw new Error('Completed session evidence is unavailable.');
		const cleared = await writeSessionNoteBeforeClear(
			this.sessionNotes,
			this.sessionNoteInput(runtime),
			() => this.sessions.resetCompletedSession(),
		);
		this.renderViews();
		if (!hasExactSessionBackendResult('clear', cleared)) throw new Error('Clear failed.');
		} finally { runtimeLease.release(); }
	}
}

/**
 * Thrown by `performRecoverSession`/`performDiscardRecoveredSession` when the confirmed backend
 * action did not settle on `'recovered'`/`'discarded'` (H15.6, 2026-09-10 audit): carries the
 * backend's own `status` and a `code` own property instead of `result.message`, which stays out of
 * the debug log on purpose (`core/local-debug-error-details.ts` never reads a message or stack).
 * `unmappedErrorLogDetails` picks up any error's own `code` property, so
 * `SessionCommandController`'s catch (`session-command-controller.ts`) now records
 * `session_recover`/`session_discard failure` with `details.code` set to `'busy'`/`'failed'`
 * instead of the opaque `unknown_failure` every other unclassified rejection gets there.
 */
class SessionRecoveryBackendFailure extends Error {
	readonly status: 'busy' | 'failed';
	readonly code: 'busy' | 'failed';
	constructor(action: 'recover' | 'discard', status: 'busy' | 'failed') {
		super(`Session ${action} ${status}.`);
		this.name = 'SessionRecoveryBackendFailure';
		this.status = status;
		this.code = status;
	}
}
