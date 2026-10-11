/**
 * The session commands (DE-01, step 3d): the session command controller the ribbon, the palette and
 * the Companion's buttons run, and what each command asks before it runs.
 * - The controller's setup (its context, its locale, its notices) with its dispatch and the ribbon,
 *   the ribbon's menu (the pending proposal on top, then the commands) and the ribbon's title.
 * - The intents: the confirmation modals of the start, the discard of a saved or a stuck live
 *   session, the clear of a finished one and the abandon, each resolving to the action the
 *   controller then runs (`LiveSessionRuntime`'s), and the start modal a pending start proposal opens.
 * - The passive session's identity and availability, which the controller and the product actions read.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see and keeps the
 * fields these write (the modals, the controller, its dispatch and the ribbon): the core closes the
 * modals and disposes the controller at unload, the product actions get the controller from it, and
 * `LiveSessionRuntime` runs its commands through it. The core also keeps the two standalone export
 * commands of the palette (`registerSessionExportCommands`), registered with its other standalone
 * commands. It hands all of that through `SessionCommandRuntimePort`; the getters below carry the
 * names of the core's own fields, so the moved code reads as it did there.
 *
 * Its name does not hold `session-runtime`, and it is not a persisted-session boundary: it reaches
 * no store and no note writer. What a command writes is written by `LiveSessionRuntime`, reached
 * through the port.
 */
import type { ConnectionService } from '../account/connection-service';
import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import type { TyrianHost, TyrianMenuEntry, TyrianRibbonHandle } from '../host/tyrian-host';
import type { IngameSessionMarker, IngameSessionView } from '../sessions/ingame-session-marker';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import { proposalIntent, type PendingProposalIntent } from '../sessions/pending-proposal-model';
import type { PendingProposalService } from '../sessions/pending-proposal-service';
import { SESSION_STATE_VERSION } from '../sessions/session';
import type { SessionHistoryRuntimeAuthority } from '../sessions/session-history';
import {
	ConfirmAbandonSessionModal,
	ConfirmDiscardLiveSessionModal,
	ConfirmClearCompletedSessionModal,
	ConfirmDiscardSessionModal,
	ConfirmDiscardUnreadableSessionModal,
} from '../ui/companion-modals';
import { ManualSessionStartModal } from '../ui/manual-session-start-modal';
import { projectPendingProposalUi } from '../ui/pending-proposal-command';
import { createSessionCommandDispatch, projectSessionMenu, type SessionCommandDispatch } from '../ui/session-command-adapter';
import { SessionCommandController, type PreparedSessionCommand } from '../ui/session-command-controller';
import type { SessionCommandId } from '../ui/session-command-model';
import { consulting, consumeRecorded, fireAndForgetLocal } from './core-actions';
import type { LiveSessionRuntime } from './live-session-runtime';

/**
 * Everything `SessionCommandRuntime` reads from the core and asks of it. Each member carries the name
 * of the core's own field or method, read live: a service the core builds in `initializeRuntime` is
 * seen as it stands at the moment of the read. The modals, the controller, its dispatch and the
 * ribbon are written through, to the core's own fields.
 */
export interface SessionCommandRuntimePort {
	readonly settings: {
		readonly language: TyrianSettings['language'];
		/** The character the start modal offers. */
		readonly preferredCharacter: TyrianSettings['preferredCharacter'];
	};
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** R1b: only an explicit `consult` refuses the passive session's commands. */
	readonly collectorMode: CollectorMode | undefined;
	/** True once the unload began: the passive session offers nothing more. */
	readonly unloaded: boolean;
	readonly localDebugActions: LocalDebugActionRunner | null;
	/** The host's UI: the ribbon, its menu and the modals. */
	readonly host: { readonly ui: TyrianHost['ui'] };
	/** The core's own: no command is prepared while a history scrub runs. */
	readonly sessionHistoryRuntimeAuthority: Pick<SessionHistoryRuntimeAuthority, 'runtimeMutationAllowed'>;
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so. */
	readonly sessions: Pick<ManualSessionStartService, 'getState' | 'getRecoveryState' | 'getLastStopFailure'>;
	/** The live session's lifecycle, built in `initializeRuntime`; null before it and on a device without one. */
	readonly liveSessions: Pick<LiveSessionLifecycle, 'getRuntime'> | null;
	/** The account's connection, built in `initializeRuntime`. */
	readonly connection: Pick<ConnectionService, 'getState'>;
	/** The pending queue, built in `initializeRuntime`; the ribbon checks it is there before reading it. */
	readonly pendingProposals: Pick<PendingProposalService, 'getState'>;
	/** The addon's session link; null until the in-game server built it. */
	readonly ingameSessionMarker: Pick<IngameSessionMarker, 'linkReplacement'> | null;
	/** The live session's lifecycle the commands run. */
	readonly live: Pick<
		LiveSessionRuntime,
		'startManualSession' | 'performStopManualSession' | 'performRecoverSession' | 'performDiscardRecoveredSession'
		| 'performDiscardLiveSession' | 'performClearCompletedSession' | 'performAbandonSession'
	>;
	/** The core's own; the unload closes them. */
	startModal: ManualSessionStartModal | null;
	discardModal: ConfirmDiscardSessionModal | ConfirmDiscardUnreadableSessionModal | null;
	clearModal: ConfirmClearCompletedSessionModal | null;
	abandonModal: ConfirmAbandonSessionModal | null;
	discardLiveModal: ConfirmDiscardLiveSessionModal | null;
	/** The core's own, set up here in `onload`; the product actions and `LiveSessionRuntime` read them. */
	sessionCommands: SessionCommandController;
	sessionDispatch: SessionCommandDispatch;
	sessionRibbon: TyrianRibbonHandle | null;
	/** Says the runtime is still starting, or that it failed to start. */
	notifyRuntimeStarting(): void;
	emitNotice(message: string, source: 'session_command' | 'pending_start_failed'): void;
	/** Opens the Companion view. */
	activateView(): Promise<void>;
	/** Reviews a pending proposal (the core's, `LiveSessionRuntime`'s). */
	reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean>;
	/** The addon's presence, which the passive session needs. */
	getIngamePresence(): IngamePresenceSnapshot;
	/** Starts a passive session for that character; its id, or null when it did not start (the core's). */
	startIngameSession(character: string | null): Promise<string | null>;
	/** Stops the session (the core's, `LiveSessionRuntime`'s). */
	stopManualSession(): Promise<void>;
	/** The passive session as the in-game channel sees it (the core's). */
	ingameSessionView(): IngameSessionView;
	/** A live session that cannot get out by itself. */
	isLiveSessionStuck(): boolean;
}

export class SessionCommandRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: SessionCommandRuntimePort) {}

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): SessionCommandRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	/** Public, like the core's: `consulting` reads it from `this`. */
	get collectorMode(): CollectorMode | undefined { return this.port.collectorMode; }
	private get unloaded(): boolean { return this.port.unloaded; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get host(): SessionCommandRuntimePort['host'] { return this.port.host; }
	private get sessionHistoryRuntimeAuthority(): SessionCommandRuntimePort['sessionHistoryRuntimeAuthority'] {
		return this.port.sessionHistoryRuntimeAuthority;
	}
	private get sessions(): SessionCommandRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): SessionCommandRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get connection(): SessionCommandRuntimePort['connection'] { return this.port.connection; }
	private get pendingProposals(): SessionCommandRuntimePort['pendingProposals'] { return this.port.pendingProposals; }
	private get ingameSessionMarker(): SessionCommandRuntimePort['ingameSessionMarker'] { return this.port.ingameSessionMarker; }
	private get live(): SessionCommandRuntimePort['live'] { return this.port.live; }
	private get startModal(): SessionCommandRuntimePort['startModal'] { return this.port.startModal; }
	private set startModal(value: SessionCommandRuntimePort['startModal']) { this.port.startModal = value; }
	private get discardModal(): SessionCommandRuntimePort['discardModal'] { return this.port.discardModal; }
	private set discardModal(value: SessionCommandRuntimePort['discardModal']) { this.port.discardModal = value; }
	private get clearModal(): SessionCommandRuntimePort['clearModal'] { return this.port.clearModal; }
	private set clearModal(value: SessionCommandRuntimePort['clearModal']) { this.port.clearModal = value; }
	private get abandonModal(): SessionCommandRuntimePort['abandonModal'] { return this.port.abandonModal; }
	private set abandonModal(value: SessionCommandRuntimePort['abandonModal']) { this.port.abandonModal = value; }
	private get discardLiveModal(): SessionCommandRuntimePort['discardLiveModal'] { return this.port.discardLiveModal; }
	private set discardLiveModal(value: SessionCommandRuntimePort['discardLiveModal']) { this.port.discardLiveModal = value; }
	private get sessionCommands(): SessionCommandController { return this.port.sessionCommands; }
	private set sessionCommands(value: SessionCommandController) { this.port.sessionCommands = value; }
	/** Written only: the setup builds it, and `LiveSessionRuntime` runs the recovery's commands through it. */
	private set sessionDispatch(value: SessionCommandDispatch) { this.port.sessionDispatch = value; }
	private get sessionRibbon(): TyrianRibbonHandle | null { return this.port.sessionRibbon; }
	private set sessionRibbon(value: TyrianRibbonHandle | null) { this.port.sessionRibbon = value; }
	private notifyRuntimeStarting(): void { this.port.notifyRuntimeStarting(); }
	private emitNotice(message: string, source: 'session_command' | 'pending_start_failed'): void { this.port.emitNotice(message, source); }
	private getIngamePresence(): IngamePresenceSnapshot { return this.port.getIngamePresence(); }
	private ingameSessionView(): IngameSessionView { return this.port.ingameSessionView(); }
	private isLiveSessionStuck(): boolean { return this.port.isLiveSessionStuck(); }
	// These hand back the core's own promise, so an await on them takes the ticks it took there.
	private activateView(): Promise<void> { return this.port.activateView(); }
	private reviewPendingProposal(intent: PendingProposalIntent): Promise<boolean> { return this.port.reviewPendingProposal(intent); }
	private startIngameSession(character: string | null): Promise<string | null> { return this.port.startIngameSession(character); }
	private stopManualSession(): Promise<void> { return this.port.stopManualSession(); }

	openPendingSessionStart(intent: PendingProposalIntent, humanBoundaryAt: string | null = null): void {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		if (intent.phase !== 'start' || this.startModal) return;
		this.startModal = new ManualSessionStartModal(
			this.host.ui,
			this.settings.preferredCharacter,
			() => this.settings.language,
			(input) => { fireAndForgetLocal(this.localDebugActions,
				{ component: 'session', action: 'session_start' },
				async () => {
					try { await this.live.startManualSession(input, intent, humanBoundaryAt); }
					catch (error) {
						this.emitNotice(
							translateRuntime(createTranslator(this.settings.language), 'notices.pendingStartFailed'),
							'pending_start_failed',
						);
						throw error;
					}
				}); },
			() => { this.startModal = null; },
		);
		this.startModal.open();
	}

	setupSessionCommands(): void {
		this.sessionCommands = new SessionCommandController({
			getContext: () => this.runtimeReady && this.liveSessions !== null ? this.passiveSessionCommandContext() : this.runtimeReady
				? {
					state: this.sessions.getState(),
					recovery: this.sessions.getRecoveryState(),
					connection: this.connection.getState().status,
					stopFailure: this.sessions.getLastStopFailure(),
				}
				: {
					state: { version: SESSION_STATE_VERSION, status: 'idle' },
					recovery: { status: 'none' },
					connection: 'idle',
					stopFailure: null,
				},
			getLocale: () => this.settings.language,
			prepare: (id) => this.prepareSessionCommand(id),
			notify: (message) => { this.emitNotice(message, 'session_command'); },
			diagnostics: this.localDebugActions ?? undefined,
		});
		this.sessionDispatch = createSessionCommandDispatch(this.sessionCommands);
		this.sessionRibbon = this.host.ui.ribbon({
			icon: 'sword',
			title: createTranslator(this.settings.language).t('commands.ribbon'),
			onClick: (event) => { this.openSessionCommandMenu(event); },
		});
		this.refreshSessionRibbon();
	}

	refreshSessionRibbon(): void {
		if (!this.sessionRibbon || !this.sessionCommands) return;
		const next = this.sessionCommands.available().find((command) => !command.destructive);
		const pending = this.pendingProposals
			? projectPendingProposalUi(this.pendingProposals.getState(), this.settings.language)
			: { pendingCount: 0, ribbonLabel: null };
		const translator = createTranslator(this.settings.language);
		const title = pending.ribbonLabel || next
			? translator.t('commands.ribbonCurrentAction', { label: pending.ribbonLabel ?? next!.name })
			: translator.t('commands.ribbon');
		// The ribbon has a live title and a pending flag, no badge (`TyrianRibbonHandle`).
		this.sessionRibbon.setTitle(title);
		this.sessionRibbon.setPending(pending.pendingCount > 0);
	}

	private openSessionCommandMenu(event: MouseEvent): void {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const menu: TyrianMenuEntry[] = [];
		if (this.pendingProposals.getState().pendingCount > 0) {
			const next = this.pendingProposals.getState().next;
			menu.push({
				kind: 'item', title: translateRuntime(createTranslator(this.settings.language), 'commands.reviewPending'), icon: 'inbox',
				onClick: () => { if (next) consumeRecorded(this.reviewPendingProposal(proposalIntent(next))); },
			});
			menu.push({ kind: 'separator' });
		}
		for (const entry of projectSessionMenu(this.sessionCommands.available(), this.settings.language)) {
			if (entry.type === 'separator') menu.push({ kind: 'separator' });
			else if (entry.type === 'open') {
				menu.push({ kind: 'item', title: entry.title, icon: entry.icon, onClick: () => {
					fireAndForgetLocal(this.localDebugActions,
						{ component: 'ui', action: 'command_execute', state: 'open_companion' }, () => this.activateView());
				} });
			} else {
				menu.push({ kind: 'item', title: entry.command.name, icon: entry.command.icon,
					onClick: () => { fireAndForgetLocal(this.localDebugActions,
						{ component: 'session', action: 'command_execute', state: entry.command.id },
						() => this.sessionCommands.run(entry.command.id)); } });
			}
		}
		this.host.ui.openMenu(menu, event);
	}

	prepareSessionCommand(id: SessionCommandId): Promise<PreparedSessionCommand | null> {
		if (!this.sessionHistoryRuntimeAuthority.runtimeMutationAllowed()) return Promise.resolve(null);
		if (this.liveSessions !== null) {
			if (id === 'start-farming-session') return Promise.resolve(async () => {
				const previous = this.liveSessions?.getRuntime()?.sessionId ?? null;
				const presence = this.getIngamePresence();
				if (presence.status !== 'present') throw new Error('The passive inventory source is unavailable.');
				const id = await this.startIngameSession(presence.context?.character ?? null);
				if (id === null) throw new Error('The passive session could not start.');
				this.ingameSessionMarker?.linkReplacement(previous,id,'adopted');
			});
			if (id === 'finish-farming-session') return Promise.resolve(async () => { await this.stopManualSession(); });
			if (id === 'discard-saved-session') return this.prepareDiscardLiveIntent();
			return Promise.resolve(null);
		}
		if (id === 'start-farming-session') return this.prepareStartIntent();
		if (id === 'discard-saved-session') return this.prepareDiscardIntent();
		if (id === 'clear-completed-session') return this.prepareClearIntent();
		if (id === 'abandon-farming-session') return this.prepareAbandonIntent();
		if (id === 'finish-farming-session') return Promise.resolve(() => this.live.performStopManualSession());
		return Promise.resolve(() => this.live.performRecoverSession());
	}

	/** Every palette/ribbon action uses the same passive identity and manual-source availability. */
	passiveSessionCommandContext() {
		const live = this.liveSessions?.getRuntime(); const presence = this.getIngamePresence();
		return {source:'nexus_inventory' as const,sessionId:live?.sessionId ?? null,phase:live?.phase ?? 'idle' as const,
			fence:live?.authority.fence ?? null,
			canStart:!consulting(this) && !this.unloaded && this.ingameSessionView().canStart && presence.status === 'present'
				&& (presence.context?.source === 'nexus' || live?.sourceInstance !== null && live?.sourceInstance !== undefined),
			canFinish:!consulting(this) && !this.unloaded && live !== null && live !== undefined
				&& (live.phase === 'active' || live.summaryReceipt === null),
			canDiscard:!this.unloaded && !consulting(this) && this.isLiveSessionStuck()};
	}

	private prepareStartIntent(): Promise<PreparedSessionCommand | null> {
		if (this.startModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let submitted = false;
			this.startModal = new ManualSessionStartModal(
				this.host.ui,
				this.settings.preferredCharacter,
				() => this.settings.language,
				(input) => { submitted = true; resolve(() => this.live.startManualSession(input)); },
				() => { this.startModal = null; if (!submitted) resolve(null); },
			);
			this.startModal.open();
		});
	}

	private prepareDiscardIntent(): Promise<PreparedSessionCommand | null> {
		if (this.discardModal) return Promise.resolve(null);
		// An unreadable saved record gets its own copy: there is nothing to recover from it, only
		// something to erase, and the generic discard copy implies the opposite.
		const unreadable = this.sessions.getRecoveryState().status === 'error';
		const ModalClass = unreadable ? ConfirmDiscardUnreadableSessionModal : ConfirmDiscardSessionModal;
		return new Promise((resolve) => {
			let confirmed = false;
			this.discardModal = new ModalClass(
				this.host.ui,
				() => { confirmed = true; resolve(() => this.live.performDiscardRecoveredSession()); return Promise.resolve(); },
				() => { this.discardModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.discardModal.open();
		});
	}

	private prepareDiscardLiveIntent(): Promise<PreparedSessionCommand | null> {
		if (this.discardLiveModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.discardLiveModal = new ConfirmDiscardLiveSessionModal(
				this.host.ui,
				() => { confirmed = true; resolve(() => this.live.performDiscardLiveSession()); return Promise.resolve(); },
				() => { this.discardLiveModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.discardLiveModal.open();
		});
	}

	private prepareClearIntent(): Promise<PreparedSessionCommand | null> {
		if (this.clearModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.clearModal = new ConfirmClearCompletedSessionModal(
				this.host.ui,
				() => { confirmed = true; resolve(() => this.live.performClearCompletedSession()); return Promise.resolve(); },
				() => { this.clearModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.clearModal.open();
		});
	}

	private prepareAbandonIntent(): Promise<PreparedSessionCommand | null> {
		if (this.abandonModal) return Promise.resolve(null);
		return new Promise((resolve) => {
			let confirmed = false;
			this.abandonModal = new ConfirmAbandonSessionModal(
				this.host.ui,
				() => { confirmed = true; resolve(() => this.live.performAbandonSession()); return Promise.resolve(); },
				() => { this.abandonModal = null; if (!confirmed) resolve(null); },
				() => this.settings.language,
			);
			this.abandonModal.open();
		});
	}
}
