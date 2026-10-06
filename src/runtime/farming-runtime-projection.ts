import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import { emptyFarmingIngameState, type FarmingIngameState } from '../alerts/farming-ingame-state';
import type { LiveSessionLootState } from '../sessions/live-session-loot';
import { observedRateBand } from '../sessions/observed-rate-band';
import { sessionUnobservedMs, type SessionState } from '../sessions/session';
import { projectFarmingGoal, type FarmingGoalProgress } from '../sessions/farming-goal';
import type { FarmingSessionContext } from './farming-session-context';

/** Time is based on the declared measurement window, with recorded unobserved gaps removed. */
export function farmingSessionElapsed(state: SessionState, now: number): number | null {
	const session = state.status === 'error' ? state.failedState : state;
	if (session.status === 'idle' || session.status === 'starting') return null;
	const started = Date.parse(session.baseline.completedAt);
	const ended = session.status === 'active' ? now : Date.parse(session.stopRequestedAt);
	const elapsed = ended - started - sessionUnobservedMs(session);
	return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/** Shared host and addon projection. The elapsed duration and cache observation age stay separate. */
export function farmingGoalForSession(
	state: SessionState, loot: LiveSessionLootState, context: FarmingSessionContext | null, now: number,
): FarmingGoalProgress | null {
	const session = state.status === 'error' ? state.failedState : state;
	if (session.status === 'idle' || session.status === 'starting' || context?.sessionId !== session.sessionId) return null;
	const elapsed = farmingSessionElapsed(state, now);
	// A duration goal excludes recorded suspension; bag evidence keeps its actual API window.
	const endedAt = session.status === 'active' ? now : Date.parse(session.stopRequestedAt);
	const projection = projectFarmingGoal(context.goal, {
		startedAt: elapsed === null ? '' : context.goal.kind === 'duration' ? new Date(endedAt - elapsed).toISOString() : session.baseline.completedAt,
		now: new Date(now).toISOString(), endedAt: session.status === 'active' ? null : new Date(endedAt).toISOString(),
		observedBags: loot.status === 'idle' ? null : loot.observedSackGains ?? null,
		observedFrom: context.observedFrom, observedAt: loot.status === 'idle' ? null : loot.updatedAt,
		sampleCount: context.sampleCount, finalNetBags: loot.status === 'idle' ? null : loot.netSackQuantity ?? null,
	});
	return { ...projection, elapsedMs: elapsed };
}

/** Reads bag capacity only for a captured character; no account-wide sum substitutes for it. */
export function farmingBagCapacity(snapshot: StorageSnapshot | null, presence: IngamePresenceSnapshot, now: number): {
	character: string | null; slots: number | null; source: FarmingIngameState['slotSrc']; age: number | null;
} {
	if (snapshot === null) return { character: null, slots: null, source: 'unknown', age: null };
	const ingame = presence.status === 'present' && presence.context?.state === 'gameplay' ? presence.context.character : null;
	const captured = (character: string | null): boolean => character !== null && snapshot.roster.includes(character)
		&& snapshot.coverage.characters[character]?.status === 'complete'
		&& snapshot.freeSlots?.characterBags.some((bag) => bag.character === character) === true;
	const character = captured(ingame) ? ingame : snapshot.lastPlayedCharacter?.character ?? null;
	if (!captured(character)) return { character: null, slots: null, source: 'unknown', age: null };
	return {
		character, slots: (snapshot.freeSlots?.characterBags ?? []).filter((bag) => bag.character === character)
			.reduce((sum, bag) => sum + bag.free, 0),
		source: character === ingame ? 'ingame' : 'recent', age: evidenceAge(snapshot.completedAt, now),
	};
}

/** Only numeric evidence and closed states go to the game; transport ticks do not refresh evidence. */
export function projectFarmingIngameState(input: {
	state: SessionState; loot: LiveSessionLootState; snapshot: StorageSnapshot | null; presence: IngamePresenceSnapshot;
	goal: FarmingGoalProgress | null; now: number; saveFailed: boolean; preparationEnabled: boolean; observationFailed?: boolean;
}): FarmingIngameState {
	const { state, loot, now } = input;
	const output = emptyFarmingIngameState();
	output.phase = state.status;
	const session = state.status === 'error' ? state.failedState : state;
	output.err = state.status === 'error' ? session.status === 'starting' ? 'start'
		: session.status === 'active' ? 'observe' : 'stop'
		: input.saveFailed ? 'save' : input.observationFailed ? 'observe' : loot.status !== 'idle' && loot.error !== null ? 'observe' : null;
	const elapsed = farmingSessionElapsed(state, now);
	output.elapsed = elapsed === null ? null : Math.floor(elapsed / 1_000);
	if (session.status !== 'idle' && session.status !== 'starting' && loot.status !== 'idle' && loot.sessionId === session.sessionId) {
		output.observed = loot.observedSackGains ?? null;
		output.net = loot.netSackQuantity ?? null;
		output.age = evidenceAge(loot.updatedAt, now);
		const windowMs = loot.updatedAt === null ? NaN : Date.parse(loot.updatedAt) - Date.parse(session.baseline.completedAt);
		const band = output.observed === null ? null : observedRateBand(output.observed * 1_000, windowMs);
		output.lo = band?.low == null ? null : Math.floor(band.low / 1_000);
		output.hi = band?.high == null ? null : Math.ceil(band.high / 1_000);
		const magicFind = session.startContext.magicFind;
		output.mf = magicFind.source === 'unavailable' ? null : magicFind.value;
		output.mfKind = output.mf === null ? 'unknown' : 'partial';
	}
	const bags = farmingBagCapacity(input.snapshot, input.presence, now);
	output.slots = bags.slots;
	output.slotSrc = bags.source;
	output.slotAge = bags.age;
	if (input.goal !== null) {
		const goal = input.goal.goal;
		output.goal = goal.kind;
		output.target = goal.kind === 'bags' ? goal.targetBags : goal.kind === 'duration' ? Math.floor(goal.targetDurationMs / 1_000) : null;
		output.progress = goal.kind === 'bags' ? input.goal.observedBags
			: goal.kind === 'duration' && input.goal.elapsedMs !== null ? Math.floor(input.goal.elapsedMs / 1_000) : null;
		output.eta = state.status !== 'active' || input.goal.remainingMs === null ? null : Math.ceil(input.goal.remainingMs / 1_000);
	}
	output.prep = !input.preparationEnabled ? 'unknown' : output.mf === null || bags.slots === null || bags.slots <= 5 ? 'attention' : 'partial';
	return output;
}

function evidenceAge(at: string | null, now: number): number | null {
	if (at === null) return null;
	const age = now - Date.parse(at);
	return Number.isFinite(age) && age >= 0 ? Math.floor(age / 1_000) : null;
}
