/**
 * The live session runtime (DE-01, step 3c): the session's lifecycle and the state the views read of
 * it (state, last start and stop failures, the stalled close's retry and the settlement wait).
 * - The start: the start modal's opening, the start itself with the next session's goal and group
 *   captured before it, and the live observation (loot poll) of an active session.
 * - The stop: the stop of a live or an observed session, the capture-now override, the
 *   finalization and the step after it (journal, note, loot projection, Halloween, the detector
 *   armed again).
 * - The ways out other than the stop: the recovery and the discard of a saved session, a session the
 *   service took back on its own, the clear of a finished one, the abandon of a stop that cannot
 *   finish and the discard of a stuck live one.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see and keeps the
 * session command controller, its intents and modals. The core keeps:
 * - building the services (`sessions`, `liveSessions`, `liveSessionLoot`, `sessionNotes`, the
 *   in-game session marker, the detector, the pending queue) and the history's runtime authority
 *   the leases come from;
 * - the pending proposals' claim (`acquirePendingIntent`) and the detector's arming;
 * - the recovery's own pilot hooks (`pilotRecoveryIdentity`, `ensurePilotRecoveryPresented`);
 * - the summary's state (`sessionSummarySaveState`, `storedSessionLootSummary`,
 *   `savedSessionNotePath`) and the farming state a start captures (`farmingGroupContext`,
 *   `farmingReminders`), which the lifecycle writes and the core's note, summary and farming code
 *   read;
 * - the note and its summary (`sessionNoteInput`, `persistCompletedSessionSummary`,
 *   `ensureCompletedSummarySaved`), the loot projection and Halloween.
 * It hands all of that through `LiveSessionRuntimePort`; the getters below carry the names of the
 * core's own fields, so the moved code reads as it did there.
 *
 * Its name holds `session-runtime`, so `scripts/security-scan.mjs` treats it as a persisted-session
 * boundary and `security-boundary.test.ts` keeps the account key and its providers out of it: it
 * orchestrates the session note's writes (the abandoned note, the summary after a stop), even though
 * the stores and the note writer it reaches are the core's, through the port.
 */
import type { StorageDelta } from '../account/storage-delta-model';
import { ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS } from '../alerts/alert-contract';
import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import type { PriceHistoryRuntime } from '../economy/price-history-runtime';
import type { HalloweenRuntime } from '../halloween/halloween-runtime';
import type { AssistedDetectionService } from '../sessions/assisted-detection-service';
import { normalizeFarmingGoal } from '../sessions/farming-goal';
import type { FarmingManualReminder } from '../sessions/farming-goal-preparation';
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
import type { PendingProposal, PendingProposalIntent } from '../sessions/pending-proposal-model';
import type { PendingProposalService } from '../sessions/pending-proposal-service';
import type { PilotMetricsRecorder } from '../sessions/pilot-metrics-recorder';
import { SESSION_STATE_VERSION, type SessionState } from '../sessions/session';
import type { SessionSettlementWait } from '../sessions/session-api-settlement';
import type { DetectionQualityRecorder } from '../sessions/session-detection-quality-recorder';
import type { SessionHistoryRuntimeAuthority } from '../sessions/session-history';
import type { SessionNoteInput } from '../sessions/session-note-model';
import type { StoredSessionLootSummary } from '../sessions/session-note-renderer';
import { writeSessionNoteBeforeClear, type SessionNoteWriter, type SessionNoteWriteResult } from '../sessions/session-note-writer';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import type { SessionStartInput } from '../sessions/session-start-capture';
import { hasExactSessionBackendResult, type SessionCommandDispatch } from '../ui/session-command-adapter';
import type { SessionCommandController } from '../ui/session-command-controller';
import type { SettingsUpdateResult } from '../ui/settings-panel-actions';
import { consulting, fireAndForgetLocal, refusedInConsult, writeSessionNoteWithDiagnostics } from './core-actions';
import type { FarmingGroupContext, FarmingSessionContext } from './farming-session-context';

/** What a finished session's summary is known to be; the core's own field, reset by every way out. */
export type SessionSummarySaveState = 'unknown' | 'saving' | 'saved' | 'failed';

/** A confirmed proposal's claim on the pending queue, renewed until the workflow ends (the core's). */
export interface PendingIntentClaim {
	readonly proposal: PendingProposal;
	readonly operationId: string;
	stopRenewal(): void;
}

/**
 * Everything `LiveSessionRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field or method, read live: a service the core builds in `initializeRuntime` or the
 * command controller `onload` sets up is seen as it stands at the moment of the read. The summary
 * fields and the farming reminders are written through, to the core's own fields.
 */
export interface LiveSessionRuntimePort {
	readonly settings: {
		readonly language: TyrianSettings['language'];
		/** Where an abandoned session's note goes. */
		readonly outputFolder: TyrianSettings['outputFolder'];
		/** The next session's goal, captured by a start. */
		readonly farmingGoal: TyrianSettings['farmingGoal'];
		/** The character the start modal offers; a start remembers the one it used. */
		readonly preferredCharacter: TyrianSettings['preferredCharacter'];
	};
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** R1b: only an explicit `consult` refuses a start and starts no loot poll. */
	readonly collectorMode: CollectorMode | undefined;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** The core's own: a start, a stop and the other ways out take their leases from it. */
	readonly sessionHistoryRuntimeAuthority: Pick<SessionHistoryRuntimeAuthority, 'runtimeMutationAllowed' | 'acquireRuntimeMutation'>;
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so, or from a command that needs it. */
	readonly sessions: Pick<
		ManualSessionStartService,
		'getState' | 'getLastFailure' | 'getLastStopFailure' | 'getAutoRetryAt' | 'getSettlementWait' | 'getRecoveryState'
		| 'recover' | 'discardRecovery' | 'canAbandon' | 'abandon' | 'getCompletedRuntimeRecord' | 'resetCompletedSession'
		| 'start' | 'stop' | 'stopAt' | 'captureFinalNow' | 'getPriceSnapshot' | 'finalizeStoppedSession' | 'getBaselineSnapshot'
	>;
	/** The live session's lifecycle, built in `initializeRuntime`; null before it and on a device without one. */
	readonly liveSessions: Pick<LiveSessionLifecycle, 'isStuck' | 'discard' | 'getRuntime' | 'stop' | 'getStopFailure'> | null;
	readonly liveSessionLoot: Pick<LiveSessionLootTracker, 'getState' | 'begin' | 'reconcile'>;
	/** The addon's session link; null until the in-game server built it. */
	readonly ingameSessionMarker: Pick<IngameSessionMarker, 'clearStoppedByPlayer' | 'reconcile' | 'markStoppedByPlayer' | 'restoreLink'> | null;
	readonly sessionNotes: Pick<SessionNoteWriter, 'write' | 'writeAbandoned'>;
	/** The session command controller and its dispatch, set up in `onload`. */
	readonly sessionCommands: Pick<SessionCommandController, 'run'>;
	readonly sessionDispatch: Pick<SessionCommandDispatch, 'recover' | 'discard' | 'finish'>;
	readonly pilotMetrics: Pick<PilotMetricsRecorder, 'recoveryFinished' | 'sessionStarted' | 'sessionCompleted' | 'proposalDecided'>;
	readonly assistedDetection: Pick<AssistedDetectionService, 'getState' | 'disarm' | 'dismissProposal' | 'armFromSnapshot'>;
	readonly detectionQuality: Pick<DetectionQualityRecorder, 'recordAccepted'>;
	readonly pendingProposals: Pick<PendingProposalService, 'accept'>;
	/** Null until the boot built it, and on a device with price history off. */
	readonly priceHistory: Pick<PriceHistoryRuntime, 'observeSessionItemIds'> | null;
	/** The group context the next session starts with (the core's farming state). */
	readonly farmingGroupContext: FarmingGroupContext;
	/** The core's own; its note and summary code read them. */
	sessionSummarySaveState: SessionSummarySaveState;
	storedSessionLootSummary: StoredSessionLootSummary | null;
	savedSessionNotePath: string | null;
	/** The core's own; a start clears them. */
	farmingReminders: FarmingManualReminder[];
	/** Says once that this device only consults (`refusedInConsult`). */
	notifyConsultMode(): void;
	/** Says the runtime is still starting, or that it failed to start. */
	notifyRuntimeStarting(): void;
	/** A lease from the history's runtime authority; throws while a history scrub runs. */
	requireRuntimeMutationLease(): { release(): void };
	renderViews(): void;
	emitNotice(message: string, source: 'session_command' | 'live_observation'): void;
	/** Arms the assisted detection again for the next session. */
	armAssistedDetection(): Promise<unknown>;
	/** The recovery on screen as `sessionId:fence`, or null when there is none. */
	pilotRecoveryIdentity(): string | null;
	/** Records the recovery as presented and reads its saved kind back (the core's). */
	ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean>;
	/** The note's input for a finished session's record (the core's). */
	sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput;
	/** Claims a confirmed proposal on the pending queue, with its renewal (the core's). */
	acquirePendingIntent(intent: PendingProposalIntent): Promise<PendingIntentClaim>;
	/** True once a finished session's summary is proven saved, writing it first when needed (the core's). */
	ensureCompletedSummarySaved(): Promise<boolean>;
	/** Saves the farming context a start captured (the core's). */
	persistFarmingSessionContext(context: FarmingSessionContext): void;
	/** The core's own settings write. */
	updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult>;
	/** The addon's presence, which a start needs. */
	getIngamePresence(): IngamePresenceSnapshot;
	/** Writes a finished session's summary note (the core's). */
	persistCompletedSessionSummary(notifyFailure: boolean, existingRuntime?: SessionRuntimeRecord): Promise<SessionNoteWriteResult | null>;
	refreshLootPresentation(): Promise<void>;
	/** Hands a finalized session's delta to Halloween (the core's). */
	observeHalloweenDelta(
		delta: StorageDelta,
		source: 'session_final',
		episodeId: string,
		classification?: Parameters<HalloweenRuntime['observeDelta']>[0]['classification'],
	): Promise<void>;
}

export class LiveSessionRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: LiveSessionRuntimePort) {}

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): LiveSessionRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	/** Public, like the core's: `consulting` and `refusedInConsult` read it from `this`. */
	get collectorMode(): CollectorMode | undefined { return this.port.collectorMode; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get sessionHistoryRuntimeAuthority(): LiveSessionRuntimePort['sessionHistoryRuntimeAuthority'] {
		return this.port.sessionHistoryRuntimeAuthority;
	}
	private get sessions(): LiveSessionRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): LiveSessionRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get liveSessionLoot(): LiveSessionRuntimePort['liveSessionLoot'] { return this.port.liveSessionLoot; }
	private get ingameSessionMarker(): LiveSessionRuntimePort['ingameSessionMarker'] { return this.port.ingameSessionMarker; }
	private get sessionNotes(): LiveSessionRuntimePort['sessionNotes'] { return this.port.sessionNotes; }
	private get sessionCommands(): LiveSessionRuntimePort['sessionCommands'] { return this.port.sessionCommands; }
	private get sessionDispatch(): LiveSessionRuntimePort['sessionDispatch'] { return this.port.sessionDispatch; }
	private get pilotMetrics(): LiveSessionRuntimePort['pilotMetrics'] { return this.port.pilotMetrics; }
	private get assistedDetection(): LiveSessionRuntimePort['assistedDetection'] { return this.port.assistedDetection; }
	private get detectionQuality(): LiveSessionRuntimePort['detectionQuality'] { return this.port.detectionQuality; }
	private get pendingProposals(): LiveSessionRuntimePort['pendingProposals'] { return this.port.pendingProposals; }
	private get priceHistory(): LiveSessionRuntimePort['priceHistory'] { return this.port.priceHistory; }
	private get farmingGroupContext(): FarmingGroupContext { return this.port.farmingGroupContext; }
	private get farmingReminders(): FarmingManualReminder[] { return this.port.farmingReminders; }
	private set farmingReminders(value: FarmingManualReminder[]) { this.port.farmingReminders = value; }
	private get sessionSummarySaveState(): SessionSummarySaveState { return this.port.sessionSummarySaveState; }
	private set sessionSummarySaveState(value: SessionSummarySaveState) { this.port.sessionSummarySaveState = value; }
	private get storedSessionLootSummary(): StoredSessionLootSummary | null { return this.port.storedSessionLootSummary; }
	private set storedSessionLootSummary(value: StoredSessionLootSummary | null) { this.port.storedSessionLootSummary = value; }
	private get savedSessionNotePath(): string | null { return this.port.savedSessionNotePath; }
	private set savedSessionNotePath(value: string | null) { this.port.savedSessionNotePath = value; }
	/** Public, like the core's: `refusedInConsult` calls it on `this`. */
	notifyConsultMode(): void { this.port.notifyConsultMode(); }
	private notifyRuntimeStarting(): void { this.port.notifyRuntimeStarting(); }
	private requireRuntimeMutationLease(): { release(): void } { return this.port.requireRuntimeMutationLease(); }
	private renderViews(): void { this.port.renderViews(); }
	private emitNotice(message: string, source: 'session_command' | 'live_observation'): void { this.port.emitNotice(message, source); }
	private pilotRecoveryIdentity(): string | null { return this.port.pilotRecoveryIdentity(); }
	private sessionNoteInput(runtime: SessionRuntimeRecord): SessionNoteInput { return this.port.sessionNoteInput(runtime); }
	private persistFarmingSessionContext(context: FarmingSessionContext): void { this.port.persistFarmingSessionContext(context); }
	private getIngamePresence(): IngamePresenceSnapshot { return this.port.getIngamePresence(); }
	// These hand back the core's own promise, so an await on them takes the ticks it took there.
	private armAssistedDetection(): Promise<unknown> { return this.port.armAssistedDetection(); }
	private ensurePilotRecoveryPresented(recoveryId: string): Promise<boolean> {
		return this.port.ensurePilotRecoveryPresented(recoveryId);
	}
	private acquirePendingIntent(intent: PendingProposalIntent): Promise<PendingIntentClaim> { return this.port.acquirePendingIntent(intent); }
	private ensureCompletedSummarySaved(): Promise<boolean> { return this.port.ensureCompletedSummarySaved(); }
	private updateSettings(settings: Partial<TyrianSettings>): Promise<SettingsUpdateResult> { return this.port.updateSettings(settings); }
	private persistCompletedSessionSummary(notifyFailure: boolean, existingRuntime?: SessionRuntimeRecord): Promise<SessionNoteWriteResult | null> {
		return this.port.persistCompletedSessionSummary(notifyFailure, existingRuntime);
	}
	private refreshLootPresentation(): Promise<void> { return this.port.refreshLootPresentation(); }
	private observeHalloweenDelta(
		delta: StorageDelta,
		source: 'session_final',
		episodeId: string,
		classification?: Parameters<HalloweenRuntime['observeDelta']>[0]['classification'],
	): Promise<void> {
		return this.port.observeHalloweenDelta(delta, source, episodeId, classification);
	}

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

	async stopManualSession(humanBoundaryAt: string | null = null): Promise<void> {
		const live = this.liveSessions?.getRuntime();
		if (live) {
			const mark = this.ingameSessionMarker?.markStoppedByPlayer(live.sessionId) ?? null;
			let stopped = false;
			try { stopped = await this.liveSessions!.stop(Date.now(),live.sessionId); }
			// Only a session still running is given back to the addon: one that closed and lacks its note did stop.
			finally { if (!stopped && mark !== null && this.liveSessions?.getRuntime()?.phase === 'active') this.ingameSessionMarker?.restoreLink(mark); }
			if (!stopped) throw new LiveSessionStopError(this.liveSessions!.getStopFailure() ?? 'unknown');
			return;
		}
		const perform = async () => humanBoundaryAt === null
			? await this.sessionDispatch.finish()
			: await this.performStopManualSession(undefined, humanBoundaryAt);
		return await (this.localDebugActions?.run({ component: 'session', action: 'session_finish' }, perform) ?? perform());
	}

	/**
	 * Explicit human override: capture the final snapshot without waiting out the cache window.
	 * Unlike `stopManualSession`, this never went through `sessionCommands`, so a failure here used
	 * to reach the caller with no Notice at all and a `session_finish` line with no cause (H15.9,
	 * 2026-09-10 audit). The `catch` below gives it the same Notice `SessionCommandController`
	 * already shows for every other stop failure, and the backend's real `SessionStopFailure` code
	 * as `details.cause` instead of the generic `unknown_failure` the rethrow's own outer `run()`
	 * still logs. It rethrows on purpose: the caller (`companion-view.ts`'s "Capturar ya" button)
	 * already swallows the rejection with its own `.catch(() => undefined)`.
	 */
	async captureSessionFinalNow(): Promise<void> {
		const perform = async () => {
			try {
				await this.performStopManualSession(undefined, null, true);
			} catch (error) {
				this.localDebugActions?.event({
					component: 'session', action: 'session_finish', level: 'error', phase: 'failure',
					code: 'unknown_failure', state: 'settlement_skipped',
					details: { cause: error instanceof SessionStopBackendFailure ? error.code : 'unknown_failure' },
				});
				this.emitNotice(createTranslator(this.settings.language).t('commands.actionFailed'), 'session_command');
				throw error;
			}
		};
		return await (this.localDebugActions?.run(
			{ component: 'session', action: 'session_finish', state: 'settlement_skipped' },
			perform,
		) ?? perform());
	}

	async performStopManualSession(
		intent?: PendingProposalIntent,
		humanBoundaryAt: string | null = null,
		captureNow = false,
		/** H18.26: the end the in-game presence observed; null is the ordinary stop at this call. */
		observedEndAtMs: number | null = null,
	): Promise<void> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) throw new Error('Session history scrub is active.');
		const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null;
		const detection = this.assistedDetection.getState();
		const proposal = pendingClaim?.proposal.phase === 'stop'
			? pendingClaim.proposal.proposal : detection.status === 'stop_proposed' ? detection.proposal : null;
		const workflowProposalId = pendingClaim?.proposal.proposalId ?? proposal?.proposalId ?? null;
		let pilotWorkflowSucceeded = false;
		this.renderViews();
		try {
			const runtimeLease = this.requireRuntimeMutationLease();
			const result = await (captureNow ? this.sessions.captureFinalNow()
				: observedEndAtMs !== null ? this.sessions.stopAt(observedEndAtMs) : this.sessions.stop())
				.finally(() => runtimeLease.release());
			// The stop itself is decided the moment the session leaves `active`, even when the final
			// snapshot still waits out the API cache window: the detector must not keep proposing and
			// the accepted proposal must not stay claimed for ten minutes waiting for a receipt.
			// What the accepted proposal led to (H18.4): a stop whose summary could not be saved is
			// recorded as such in its receipt and in the pilot, never as a clean success.
			let summarySaved = true;
			if (result.status !== 'failed') {
				this.assistedDetection.disarm('session_stopped'); this.localDebugActions?.event({ component: 'detection', action: 'detection_disarm', state: 'session_stopped', level: 'info', phase: 'success', code: 'ok' });
				if (result.status === 'stopped') {
					summarySaved = await this.finalizeAndPersistStoppedSession(result.state.sessionId, result.delta);
				}
				// A resumed result is a retry of a capture already reported once: finalize again, but do
				// not record the stop or its price observation a second time.
				if (result.status === 'stopped' && result.resumed !== true) {
					const priceSnapshot = this.sessions.getPriceSnapshot();
					const stopped = result.state;
					const delta = result.delta;
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'inventory', action: 'inventory_refresh', state: 'price_history_observe' },
						async () => { await this.priceHistory?.observeSessionItemIds([
							...delta.itemChanges.map(({ id }) => id),
							...(priceSnapshot?.items.map(({ itemId }) => itemId) ?? []),
							...(priceSnapshot?.missingItemIds ?? []),
						]); });
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'detection', action: 'detection_proposal', state: 'accept_stop' },
						async () => { await this.detectionQuality.recordAccepted(
						'stop',
						stopped.sessionId,
						stopped.finalSnapshot.completedAt,
						proposal ?? {
							mode: 'manual',
							window: {
								from: stopped.stopRequestedAt,
								to: stopped.finalSnapshot.completedAt,
							},
						},
						); this.renderViews(); });
				}
				const workflow = summarySaved ? 'succeeded' : 'failed';
				if (intent && pendingClaim) {
					if (!await this.pendingProposals.accept(intent, pendingClaim.operationId, result.state.sessionId, workflow)) {
						throw new Error('Proposal receipt failed.');
					}
				}
				pilotWorkflowSucceeded = true;
				if (workflowProposalId) void this.pilotMetrics?.proposalDecided({
					proposalId: workflowProposalId,
					decision: 'accepted', workflow, cause: null, humanBoundaryAt,
				});
			}
			this.renderViews();
			if (result.status === 'failed') throw new SessionStopBackendFailure(result.failure.code);
		} catch (error) {
			if (workflowProposalId && !pilotWorkflowSucceeded) void this.pilotMetrics?.proposalDecided({
				proposalId: workflowProposalId,
				decision: 'accepted', workflow: 'failed', cause: null, humanBoundaryAt,
			});
			throw error;
		} finally {
			pendingClaim?.stopRenewal();
		}
	}

	/**
	 * Stop a live session: hand its final delta to the runtime, then finalize and persist it. Returns
	 * whether the summary is saved (H18.4): before, a failure here only showed a Notice, and the
	 * proposal receipt and the pilot kept recording the workflow as a success.
	 */
	async finalizeAndPersistStoppedSession(sessionId: string, delta: StorageDelta): Promise<boolean> {
		await this.liveSessionLoot.reconcile(sessionId, delta);
		const reviewed = await this.sessions.finalizeStoppedSession();
		if (reviewed.status !== 'finalized' || reviewed.state.status !== 'complete') {
			this.sessionSummarySaveState = 'failed';
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return false;
		}
		return await this.finishFinalizedSession(sessionId, delta, reviewed);
	}

	/**
	 * Writes the note and runs the pilot metrics/Halloween bookkeeping that follow finalization
	 * (`provisional` → `complete`), regardless of who finalized it: a live `stop()`
	 * (`finalizeAndPersistStoppedSession`) or `initialize()` auto-finalizing a `provisional` record
	 * it found already stopped (no human reviews anything anymore, David 2026-09-09).
	 */
	async finishFinalizedSession(
		sessionId: string,
		delta: StorageDelta,
		reviewed: Extract<Awaited<ReturnType<ManualSessionStartService['finalizeStoppedSession']>>, { status: 'finalized' }>,
	): Promise<boolean> {
		void this.pilotMetrics?.sessionCompleted(reviewed.state.sessionId, reviewed.state.finalizedAt);
		const runtime = await this.sessions.getCompletedRuntimeRecord();
		if (runtime === null) {
			this.sessionSummarySaveState = 'failed';
			this.emitNotice(
				translateRuntime(createTranslator(this.settings.language), 'notices.sessionSummaryNotSaved'),
				'session_command',
			);
			return false;
		}
		const note = await this.persistCompletedSessionSummary(true, runtime);
		await this.refreshLootPresentation();
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'halloween', action: 'halloween_refresh', state: 'session_final' },
			() => this.observeHalloweenDelta(delta, 'session_final', `session:${sessionId}`,
				reviewed.review.classification));
		// The detector was disarmed when the stop was decided; the next session must be detectable
		// again without anyone checking the connection by hand (H18.9). It only arms with an account
		// already connected, and a summary not saved yet never blocks it: `start()` guards that. At
		// boot the connection warm-up arms it instead, once the runtime is ready.
		if (this.runtimeReady) fireAndForgetLocal(this.localDebugActions,
			{ component: 'detection', action: 'detection_arm', state: 'session_complete' },
			() => this.armAssistedDetection());
		return note?.status === 'written' || note?.status === 'unchanged';
	}

	openManualSessionStart(_humanBoundaryAt: string | null = null): void {
		if (refusedInConsult(this)) return;
		fireAndForgetLocal(this.localDebugActions,
			{ component: 'session', action: 'session_start' }, async () => {
				if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
				const presence = this.getIngamePresence();
				if (presence.status !== 'present') {
					this.emitNotice('Connect Nexus to start an observed inventory session.', 'session_command'); return;
				}
				await this.sessionCommands.run('start-farming-session');
			});
	}

	async startManualSession(
		input: SessionStartInput,
		intent?: PendingProposalIntent,
		humanBoundaryAt: string | null = null,
	): Promise<void> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) throw new Error('Session history scrub is active.');
		const pendingClaim = intent ? await this.acquirePendingIntent(intent) : null;
		const detection = this.assistedDetection.getState();
		const capturedGoal = normalizeFarmingGoal(this.settings.farmingGoal);
		const capturedGroup = this.farmingGroupContext;
		const proposal = pendingClaim?.proposal.phase === 'start'
			? pendingClaim.proposal.proposal : detection.status === 'start_proposed' ? detection.proposal : null;
		const workflowProposalId = pendingClaim?.proposal.proposalId ?? proposal?.proposalId ?? null;
		let pilotWorkflowSucceeded = false;
		this.renderViews();
		try {
			// A finished session is released by the start itself once its summary is proven saved
			// (H18.8); saving it here first is what lets the next session start without a clear.
			await this.ensureCompletedSummarySaved();
			const runtimeLease = this.sessionHistoryRuntimeAuthority.acquireRuntimeMutation();
			if (runtimeLease === null) throw new Error('Session history scrub is active.');
			const result = await this.sessions.start(input).finally(() => runtimeLease.release());
			if (result.status === 'started') {
				this.persistFarmingSessionContext({ version: 1, sessionId: result.state.sessionId, goal: capturedGoal,
					groupContext: capturedGroup, observedFrom: result.state.baseline.completedAt,
					observedAt: result.state.baseline.completedAt, sampleCount: 1 });
				this.farmingReminders = [];
				this.startLiveObservation(result.state.sessionId, false);
				void this.pilotMetrics?.sessionStarted(result.state.sessionId, result.state.baseline.completedAt);
				await this.detectionQuality.recordAccepted(
					'start',
					result.state.sessionId,
					result.state.baseline.completedAt,
					proposal ?? {
						mode: 'manual',
						window: {
							from: result.state.requestedAt,
							to: result.state.baseline.completedAt,
						},
					},
				);
				this.renderViews();
				this.assistedDetection.dismissProposal();
				if (intent && pendingClaim) {
					if (!await this.pendingProposals.accept(intent, pendingClaim.operationId, result.state.sessionId)) {
						throw new Error('Proposal receipt failed.');
					}
				}
				pilotWorkflowSucceeded = true;
				if (workflowProposalId) void this.pilotMetrics?.proposalDecided({
					proposalId: workflowProposalId,
					decision: 'accepted', workflow: 'succeeded', cause: null, humanBoundaryAt,
				});
			}
			if (result.status === 'started' && this.settings.preferredCharacter !== input.characterName.trim()) {
				try {
					await this.updateSettings({ preferredCharacter: input.characterName.trim() });
				} catch { /* the active session does not depend on remembering the preference */ }
			}
			this.renderViews();
			if (result.status === 'failed') throw new Error('Start failed.');
		} catch (error) {
			if (workflowProposalId && !pilotWorkflowSucceeded) void this.pilotMetrics?.proposalDecided({
				proposalId: workflowProposalId,
				decision: 'accepted', workflow: 'failed', cause: null, humanBoundaryAt,
			});
			throw error;
		} finally {
			pendingClaim?.stopRenewal();
		}
	}

	/**
	 * Starts the loot poll of an active session, manual or assisted alike.
	 *
	 * The cadence here is deliberately NOT `pollingIntervalMinutes`. That setting
	 * is the idle detection cadence, floored at ten minutes because a background
	 * hunt for a start proposal re-reads bytes a 5-10 minute cache cannot have
	 * changed. Once a session is open the player is farming and the alert is the
	 * product, so it polls at the five minutes H13.3 declares: the fastest
	 * cadence that still buys new bytes, and the one the latency copy quotes.
	 */
	startLiveObservation(sessionId: string, restored: boolean): void {
		// R1b: the loot poll is a Guild Wars 2 request; a consult installation never starts one.
		if (consulting(this)) return;
		this.sessionSummarySaveState = 'unknown';
		this.storedSessionLootSummary = null;
		this.savedSessionNotePath = null;
		this.liveSessionLoot.begin(sessionId, restored);
		const baseline = this.sessions.getBaselineSnapshot();
		const state = baseline === null
			? { status: 'error' as const }
			: this.assistedDetection.armFromSnapshot(baseline, ACTIVE_SESSION_ALERT_POLL_INTERVAL_MS);
		if (state.status !== 'error') return;
		this.emitNotice(
			translateRuntime(createTranslator(this.settings.language), 'notices.liveObservationUnavailable'),
			'live_observation',
		);
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

/**
 * Thrown by `performStopManualSession` when `sessions.stop()`/`captureFinalNow()` returns
 * `{status:'failed'}` (H15.9, 2026-09-10 audit): carries the backend's own `SessionStopFailure`
 * code as an own `code` property instead of the fixed `'Stop failed.'` message it replaced, which
 * discarded it entirely. `captureSessionFinalNow` reads this `code` to log `session_finish`
 * `details.cause` and to show the same Notice the Terminar button's `SessionCommandController`
 * already shows for every other stop failure.
 */
class SessionStopBackendFailure extends Error {
	readonly code: SessionStopFailure['code'];
	constructor(code: SessionStopFailure['code']) {
		super('Session stop failed.');
		this.name = 'SessionStopBackendFailure';
		this.code = code;
	}
}
