/**
 * The farming session's runtime view (DE-01, step 3f): the session-local farming context a start
 * captures and its saved copy on this device, the group context and the manual reminders, the
 * capacity evidence, and the three projections the panels and the game read (the goal's progress,
 * the preparation context and the in-game state).
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The next
 * session's saved preferences (goal, preparation, declared build) stay in `SessionRuntime`. The core
 * keeps:
 * - the group context and the reminders, because a start captures the first and the live session
 *   writes the second (`LiveSessionRuntimePort`); this reads and writes them through the port;
 * - the failure record of the in-game session (`recordIngameSessionFailure`);
 * - building every service this reads.
 *
 * The file name carries `session-runtime` on purpose: the captured context is saved in the device's
 * local storage, so `scripts/security-scan.mjs` holds the module by name as a persisted-session
 * boundary, like `session-note-runtime.ts`.
 */
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { FarmingIngameState } from '../alerts/farming-ingame-state';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import type { TyrianHost } from '../host/tyrian-host';
import { liveObservedFrom, projectFarmingGoal, type FarmingGoalProgress } from '../sessions/farming-goal';
import type { FarmingManualReminder, FarmingPreparationContext, FarmingReminderKind } from '../sessions/farming-goal-preparation';
import type { LiveSessionLootState } from '../sessions/live-session-loot';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import type { SessionState } from '../sessions/session';
import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import { farmingBagCapacity, farmingGoalForSession, projectFarmingIngameState, projectLiveFarmingIngameState } from './farming-runtime-projection';
import {
	readFarmingSessionContext,
	type FarmingGroupContext,
	type FarmingSessionContext,
} from './farming-session-context';
import type { SessionSummarySaveState } from './live-session-runtime';

/**
 * Everything `FarmingSessionRuntime` reads from the core and asks of it. Each member carries the
 * name of the core's own field or method, read live: a service the core builds in
 * `initializeRuntime` or a setting changed is seen as it stands at the moment of the read.
 */
export interface FarmingSessionRuntimePort {
	readonly settings: { readonly farmingPreparation: Pick<TyrianSettings['farmingPreparation'], 'enabled'> };
	readonly runtimeReady: boolean;
	readonly host: { readonly localStorage?: Pick<NonNullable<TyrianHost['localStorage']>, 'load' | 'save'> };
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so. */
	readonly sessions: {
		getBaselineSnapshot(): StorageSnapshot | null;
		getState(): SessionState;
	};
	readonly inventoryAdvisor: { analysis(): { source: { input: { snapshot: StorageSnapshot | null } } } | null };
	readonly assistedDetection: {
		getLastSnapshot(): StorageSnapshot | null;
		getState(): { scheduler: { consecutiveFailures: number } };
	};
	/** The live session's lifecycle, built in `initializeRuntime`; null before it and on a device without one. */
	readonly liveSessions: Pick<LiveSessionLifecycle, 'getRuntime' | 'getView'> | null;
	readonly sessionSummarySaveState: SessionSummarySaveState;
	/** The core's own: a start captures it, so it stays there. */
	farmingGroupContext: FarmingGroupContext;
	/** The core's own: the live session's lifecycle writes it too. */
	farmingReminders: FarmingManualReminder[];
	getCollectorMode(): CollectorMode;
	getSessionState(): SessionState;
	getIngamePresence(): IngamePresenceSnapshot;
	getLiveSessionLoot(): LiveSessionLootState;
	recordIngameSessionFailure(error: unknown): void;
}

export class FarmingSessionRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: FarmingSessionRuntimePort) {}

	private farmingSessionContext: FarmingSessionContext | null = null;

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): FarmingSessionRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get host(): FarmingSessionRuntimePort['host'] { return this.port.host; }
	private get sessions(): FarmingSessionRuntimePort['sessions'] { return this.port.sessions; }
	private get inventoryAdvisor(): FarmingSessionRuntimePort['inventoryAdvisor'] { return this.port.inventoryAdvisor; }
	private get assistedDetection(): FarmingSessionRuntimePort['assistedDetection'] { return this.port.assistedDetection; }
	private get liveSessions(): FarmingSessionRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get sessionSummarySaveState(): SessionSummarySaveState { return this.port.sessionSummarySaveState; }
	private get farmingGroupContext(): FarmingGroupContext { return this.port.farmingGroupContext; }
	private set farmingGroupContext(value: FarmingGroupContext) { this.port.farmingGroupContext = value; }
	private get farmingReminders(): FarmingManualReminder[] { return this.port.farmingReminders; }
	private set farmingReminders(value: FarmingManualReminder[]) { this.port.farmingReminders = value; }
	private getCollectorMode(): CollectorMode { return this.port.getCollectorMode(); }
	private getSessionState(): SessionState { return this.port.getSessionState(); }
	private getIngamePresence(): IngamePresenceSnapshot { return this.port.getIngamePresence(); }
	private getLiveSessionLoot(): LiveSessionLootState { return this.port.getLiveSessionLoot(); }
	private recordIngameSessionFailure(error: unknown): void { this.port.recordIngameSessionFailure(error); }

	/** Session-local intent is matched by id after reload, never inferred from changed defaults. */
	currentFarmingSessionContext(sessionId: string): FarmingSessionContext | null {
		if (this.farmingSessionContext?.sessionId === sessionId) return this.farmingSessionContext;
		try {
			const loaded = readFarmingSessionContext(this.host.localStorage?.load('tyrian-farming-session'));
			if (loaded?.sessionId === sessionId) this.farmingSessionContext = loaded;
		} catch (error) { this.recordIngameSessionFailure(error); }
		return this.farmingSessionContext?.sessionId === sessionId ? this.farmingSessionContext : null;
	}

	persistFarmingSessionContext(context: FarmingSessionContext): void {
		this.farmingSessionContext = context;
		try { this.host.localStorage?.save('tyrian-farming-session', context); }
		catch (error) { this.recordIngameSessionFailure(error); }
	}

	getFarmingGroupContext(): FarmingGroupContext { return this.farmingGroupContext; }
	setFarmingGroupContext(context: FarmingGroupContext): void { this.farmingGroupContext = context; }
	getFarmingReminders(): readonly FarmingManualReminder[] { return this.farmingReminders.map((reminder) => ({ ...reminder })); }
	startFarmingReminder(kind: FarmingReminderKind, minutes: number): void {
		if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) return;
		this.farmingReminders = [...this.farmingReminders.filter((reminder) => reminder.kind !== kind),
			{ kind, durationMinutes: minutes, startedAt: new Date().toISOString() }];
	}
	clearFarmingReminder(kind: FarmingReminderKind): void {
		this.farmingReminders = this.farmingReminders.filter((reminder) => reminder.kind !== kind);
	}

	/** The newest already captured capacity evidence; reading it never requests account data. */
	private farmingCapacitySnapshot(): StorageSnapshot | null {
		if (!this.runtimeReady) return null;
		const baseline = this.sessions.getBaselineSnapshot();
		const inventory = this.inventoryAdvisor.analysis()?.source.input.snapshot ?? null;
		const live = this.assistedDetection.getLastSnapshot();
		return [baseline, inventory, live].filter((snapshot): snapshot is StorageSnapshot => snapshot !== null && (!baseline || snapshot.accountId === baseline.accountId))
			.sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))[0] ?? null;
	}

	getFarmingGoalProgress(): FarmingGoalProgress | null {
		if (!this.runtimeReady) return null;
		const live = this.liveSessions?.getRuntime();
		if (live) {
			const view = this.liveSessions!.getView(); const bags = view.totals.find((row) => row.kind === 'item' && row.idNumber === 36038);
			const covered = liveObservedFrom(live.startedAt,view.lastObservationAt,view.observedItemsMs);
			return projectFarmingGoal(live.farmingGoal,{startedAt:live.startedAt,now:new Date(Date.parse(live.startedAt)+(view.elapsedMs ?? 0)).toISOString(),endedAt:live.endedAt,
				observedBags:live.lastValidItemsAt === null ? null : bags?.positive ?? 0,finalNetBags:live.phase === 'complete' ? bags?.net ?? 0 : null,
				observedFrom:covered,observedAt:view.lastObservationAt,sampleCount:live.sampleCount,maxObservationAgeMs:5000});
		}
		const state = this.sessions.getState();
		const observed = state.status === 'error' ? state.failedState : state;
		const context = observed.status === 'idle' ? null : this.currentFarmingSessionContext(observed.sessionId);
		return farmingGoalForSession(state, this.getLiveSessionLoot(), context, Date.now());
	}

	getFarmingPreparationContext(): FarmingPreparationContext {
		const live = this.liveSessions?.getRuntime();
		if (live) return {characterName:live.context?.character ?? null,buildName:null,freeBagSlots:live.lastSample?.freeSlots ?? null,
			freeBagSlotsCharacter:live.context?.character ?? null,freeBagSlotsObservedAt:live.lastObservationAt,collectorMode:this.getCollectorMode(),
			addonConnection:live.connection,magicFindBreakdown:null,magicFindObservedAt:null};
		const state = this.getSessionState();
		const session = state.status === 'error' ? state.failedState : state;
		const context = session.status === 'idle' || session.status === 'starting' ? null : session.startContext;
		const presence = this.getIngamePresence();
		const snapshot = this.farmingCapacitySnapshot();
		const bags = farmingBagCapacity(snapshot, presence, Date.now());
		return {
			characterName: context?.characterName ?? bags.character, buildName: context?.build.name ?? null,
			freeBagSlots: bags.slots, freeBagSlotsCharacter: bags.character, freeBagSlotsObservedAt: snapshot?.completedAt ?? null, collectorMode: this.getCollectorMode(),
			addonConnection: presence.status === 'present' ? 'connected' : 'disconnected',
			magicFindBreakdown: context?.magicFind.breakdown ?? null, magicFindObservedAt: context?.capturedAt ?? null,
		};
	}

	/** The game consumes the same goal/evidence as the host, with identities removed at the wire boundary. */
	getFarmingIngameState(): FarmingIngameState {
		if (this.liveSessions !== null) return projectLiveFarmingIngameState({view:this.liveSessions.getView(),goal:this.getFarmingGoalProgress(),
			now:Date.now(),preparationEnabled:this.settings.farmingPreparation.enabled});
		return projectFarmingIngameState({
			state: this.getSessionState(), loot: this.getLiveSessionLoot(), snapshot: this.farmingCapacitySnapshot(),
			presence: this.getIngamePresence(), goal: this.getFarmingGoalProgress(), now: Date.now(),
			saveFailed: this.sessionSummarySaveState === 'failed', preparationEnabled: this.settings.farmingPreparation.enabled,
			observationFailed: this.runtimeReady && this.assistedDetection.getState().scheduler.consecutiveFailures > 0,
		});
	}
}
