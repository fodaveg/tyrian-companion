/**
 * The in-game presence's side of a session (DE-01, ninth wave: the in-game session).
 * - `startIngameSessionMarking` builds the core's `IngameSessionMarker` once the runtime is ready and
 *   follows every presence event (H18.26).
 * - `ingameSessionView` and `startIngameSession`: what the marker and the passive start see of the
 *   session, and the start they ask for.
 * - `ingameLabyrinthDeclaration` and `storageCharacterFromIngame`: what the session's note and the
 *   advisor read from the presence.
 * - `getIngameSessionLink` and the link's read and write in the host's per-vault local storage, and
 *   `recordIngameSessionFailure`, the one diagnostic all of them report through.
 *
 * Moved from `TyrianCompanionCore`. The marker itself stays the core's field, read and written through
 * the port: `AlertRuntime`, `LiveSessionRuntime`, `SessionCommandRuntime`, the note's input and the
 * unload read it too. The bridge's secret (its read, copy and replacement) stays in the core, the
 * reviewed home of `host.secrets`; this runtime never sees it.
 *
 * Its name holds `session-runtime`, so the persistence guard of `scripts/security-scan.mjs` holds it:
 * it saves the link in the host's local storage.
 */
import type { IngamePresenceEvent, IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import type { TyrianHost } from '../host/tyrian-host';
import { IngameSessionMarker, type IngameSessionLink, type IngameSessionView } from '../sessions/ingame-session-marker';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import { recoveryAllowsLiveStart } from '../sessions/manual-session-start-model';
import type { ManualSessionStartService } from '../sessions/manual-session-start-service';
import type { SessionHistoryRuntimeAuthority } from '../sessions/session-history';
import type { SessionNoteEventDeclaration } from '../sessions/session-note-model';
import type { SessionRuntimeRecord } from '../sessions/session-runtime-store';
import { consulting } from './core-actions';

/** H18.26: per-vault local storage key of the link between the in-game presence and its session. */
const INGAME_SESSION_LINK_KEY = 'tyrian-companion:ingame-session-link';

/**
 * Everything `IngameSessionRuntime` reads from the core and asks of it. Each member carries the name
 * of the core's own field or method, read live: the services are built in `initializeRuntime`, after
 * this runtime, and a setting changed or the device turned to consult is read as it stands.
 */
export interface IngameSessionRuntimePort {
	readonly settings: Pick<TyrianSettings, 'alertIngameEnabled'>;
	readonly runtimeReady: boolean;
	readonly collectorMode: CollectorMode | undefined;
	readonly host: { readonly localStorage?: Pick<NonNullable<TyrianHost['localStorage']>, 'load' | 'save'> };
	readonly localDebugActions: Pick<LocalDebugActionRunner, 'run' | 'event'> | null;
	readonly sessionHistoryRuntimeAuthority: Pick<SessionHistoryRuntimeAuthority, 'runtimeMutationAllowed'>;
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so. */
	readonly sessions: Pick<ManualSessionStartService,
		'getState' | 'getRecoveryState' | 'initialize' | 'getPreservedLegacyRuntime' | 'preserveLegacyForLiveMigration'>;
	/** The live session's lifecycle, built in `initializeRuntime`; null before it and on a device without one. */
	readonly liveSessions: Pick<LiveSessionLifecycle, 'getRuntime' | 'start' | 'stop' | 'presence'> | null;
	/** The core's own: the alerts, the live session, the commands, the note and the unload read it too. */
	ingameSessionMarker: IngameSessionMarker | null;
	getIngamePresence(): IngamePresenceSnapshot;
	onIngamePresence(listener: (event: IngamePresenceEvent) => void): () => void;
	renderViews(): void;
}

export class IngameSessionRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: IngameSessionRuntimePort) {}

	// The core's own fields, read through the port under the names the moved code uses.
	private get settings(): IngameSessionRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get host(): IngameSessionRuntimePort['host'] { return this.port.host; }
	private get localDebugActions(): IngameSessionRuntimePort['localDebugActions'] { return this.port.localDebugActions; }
	private get sessions(): IngameSessionRuntimePort['sessions'] { return this.port.sessions; }
	private get liveSessions(): IngameSessionRuntimePort['liveSessions'] { return this.port.liveSessions; }

	/**
	 * H18.26: the in-game presence marks the session. Built once the session runtime is ready, it
	 * catches up with a presence that started earlier (`reconcile`) and then follows every event.
	 * It does nothing unless the bridge is enabled and an API key is configured.
	 */
	startIngameSessionMarking(): void {
		if (this.port.ingameSessionMarker !== null) return;
		const marker = new IngameSessionMarker({
			presence: () => this.port.getIngamePresence(),
			now: () => Date.now(),
			port: {
				enabled: () => this.settings.alertIngameEnabled && !consulting(this.port),
				session: () => this.ingameSessionView(),
				start: async (character) => await this.startIngameSession(character),
				stopAt: async (sessionId, endedAtMs) => {
					const stop = async () => { await this.liveSessions?.stop(endedAtMs,sessionId); };
					await (this.localDebugActions?.run(
						{ component: 'session', action: 'session_finish', state: 'ingame_presence' }, stop,
					) ?? stop());
				},
				loadLink: () => this.readIngameSessionLink(),
				saveLink: (link) => { this.writeIngameSessionLink(link); },
				recordFailure: (error) => { this.recordIngameSessionFailure(error); },
			},
		});
		this.port.ingameSessionMarker = marker;
		this.port.onIngamePresence((event) => {
			// The Session panel reads presence only when it paints, and an idle panel has no tick: without
			// this repaint «Iniciar sesión» stays on «Abre Guild Wars 2…» after the addon connects.
			this.port.renderViews();
			void marker.handle(event);
			void this.liveSessions?.presence(this.port.getIngamePresence().status === 'present',
				event.kind === 'lost' ? event.lastSeenAtMs : event.kind === 'ended' ? event.endedAtMs : Date.now());
		});
		void marker.reconcile();
	}

	/** What the marker needs to know about the session; `canStart` mirrors what `start()` accepts. */
	ingameSessionView(): IngameSessionView {
		const live = this.liveSessions?.getRuntime();
		if (live) return {
			status: live.phase, sessionId: live.sessionId,
			canStart: this.runtimeReady && live.phase === 'complete' && live.summaryReceipt !== null
				&& this.port.sessionHistoryRuntimeAuthority.runtimeMutationAllowed(),
		};
		const state = this.sessions.getState();
		const sessionId = state.status === 'idle' ? null
			: state.status === 'error' ? state.failedState.sessionId : state.sessionId;
		const released = state.status === 'idle' || state.status === 'abandoned' || state.status === 'complete';
		return {
			status: state.status,
			sessionId,
			canStart: this.runtimeReady && released && this.manualRecoveryAllowsStart()
				&& this.port.sessionHistoryRuntimeAuthority.runtimeMutationAllowed(),
		};
	}

	/**
	 * The manual service's saved-session state lets a Nexus session start when nothing is pending or it can be taken as it is. A
	 * store that did not answer (`unavailable`) says nothing about what is saved: it counts as startable here only because
	 * `startIngameSession` asks the store again before it goes on (Z2-2). A record that is corrupt keeps blocking.
	 */
	private manualRecoveryAllowsStart(): boolean {
		return recoveryAllowsLiveStart(this.sessions.getRecoveryState());
	}

	/**
	 * Starts the addon-reported connection through the shared fenced passive lifecycle.
	 * Any saved API evidence transfers durably before the new source can establish its baseline.
	 */
	async startIngameSession(character: string | null): Promise<string | null> {
		if (!this.runtimeReady || !this.ingameSessionView().canStart) return null;
		// Z2-2: the saved sessions were not readable at boot and nothing asks again but this. Read them before any start or migration,
		// so pending API evidence is found and preserved below; while they still do not answer nothing is started over them.
		if (this.sessions.getRecoveryState().status === 'error') {
			await this.sessions.initialize();
			if (this.sessions.getRecoveryState().status === 'error' || !this.ingameSessionView().canStart) return null;
		}
		// An older archive must not hide a NEWER unfinished API session: that one still needs its own transfer.
		const recoveryPending = this.sessions.getRecoveryState().status !== 'none';
		if ((recoveryPending || this.sessions.getState().status === 'complete') && (recoveryPending || this.sessions.getPreservedLegacyRuntime() === null)
			&& !await this.sessions.preserveLegacyForLiveMigration()) return null;
		return await this.liveSessions?.start(character) ?? null;
	}

	/** The Labyrinth tag the presence saw for this session, as the note's event declaration. */
	ingameLabyrinthDeclaration(runtime: SessionRuntimeRecord): SessionNoteEventDeclaration | null {
		if (runtime.state.status !== 'complete') return null;
		const observedAt = this.port.ingameSessionMarker?.labyrinthObservedAt(runtime.state.sessionId) ?? null;
		if (observedAt === null || Date.parse(observedAt) > Date.parse(runtime.state.stoppedAt)) return null;
		return { event: 'halloween', source: 'ingame_presence', observedAt };
	}

	/** Authenticated current gameplay only: a lost connection is not a character selector. */
	storageCharacterFromIngame(): string | null {
		const presence = this.port.getIngamePresence();
		return presence.status === 'present' && presence.context?.state === 'gameplay'
			? presence.context.character : null;
	}

	/**
	 * H18.36: the Sesión tab's own "Laberinto" badge and "la marcó Nexus" meta suffix (boceto
	 * lámina 2.1) read this for the session on screen. Null with no addon marker (bridge disabled,
	 * or the running session started before this plugin load's marker linked it).
	 */
	getIngameSessionLink(sessionId: string): { owner: 'automatic' | 'adopted'; labyrinthAt: string | null } | null {
		return this.port.ingameSessionMarker?.linkFor(sessionId) ?? null;
	}

	/**
	 * The link lives in the host's per-vault local storage (`host.localStorage`, Obsidian's
	 * `loadLocalStorage`), never in `data.json`: it names a session of THIS vault on THIS machine and
	 * must not sync. A host without that storage keeps no link, which only means an automatic
	 * session found after a reload is treated as one started by hand.
	 */
	private readIngameSessionLink(): unknown {
		const storage = this.host.localStorage;
		if (storage === undefined) return null;
		try {
			return storage.load(INGAME_SESSION_LINK_KEY);
		} catch (error) {
			this.recordIngameSessionFailure(error);
			return null;
		}
	}

	private writeIngameSessionLink(link: IngameSessionLink | null): void {
		const storage = this.host.localStorage;
		if (storage === undefined) return;
		try {
			storage.save(INGAME_SESSION_LINK_KEY, link);
		} catch (error) {
			this.recordIngameSessionFailure(error);
		}
	}

	/** The in-game session's one diagnostic, by error class only: the marker, the link, the farming context and the alerts report here. */
	recordIngameSessionFailure(error: unknown): void {
		const mapped = unmappedErrorLogDetails(error);
		this.localDebugActions?.event({
			component: 'session', action: 'session_start', state: 'ingame_presence',
			level: 'error', phase: 'failure', code: 'internal_failure',
			details: { reason: mapped.reason },
		});
	}
}
