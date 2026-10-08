import { FARMING_GOAL_MIN_WINDOW_MS } from '../sessions/farming-goal';
import type { LiveSessionViewV1 } from '../sessions/live-session-model';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import type { IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import { emptyFarmingIngameState, type FarmingIngameState } from '../alerts/farming-ingame-state';
import {
	PRICE_INGAME_STACK, PRICE_INGAME_STALE_SECONDS, emptyPriceIngameState, type PriceIngameState,
} from '../alerts/price-ingame-state';
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

/** Nexus observations use their covered intervals; account API cache margins do not apply. */
export function projectLiveFarmingIngameState(input: {
	view: LiveSessionViewV1; goal: FarmingGoalProgress | null; now: number; preparationEnabled: boolean;
}): FarmingIngameState {
	const { view, goal, now } = input;
	const output = emptyFarmingIngameState();
	output.phase = view.phase;
	output.err = view.phase === 'error' ? 'save' : view.phase === 'active' && ['stale', 'unavailable', 'conflict', 'missing'].includes(view.sourceState) ? 'observe' : null;
	output.elapsed = view.elapsedMs === null ? null : Math.floor(view.elapsedMs / 1_000);
	output.age = evidenceAge(view.lastObservationAt, now);
	const bags = view.totals.find((row) => row.kind === 'item' && row.idNumber === 36038);
	const measured = view.lastObservationAt !== null && view.itemCoverage === 'complete';
	output.observed = bags?.positive ?? (measured ? 0 : null);
	output.net = bags?.net ?? (measured ? 0 : null);
	const band = output.observed === null || view.observedItemsMs <= 0 || view.itemCoverage !== 'complete'
		? null : observedRateBand(output.observed * 1_000, view.observedItemsMs, 0);
	output.lo = band?.low == null ? null : Math.floor(band.low / 1_000);
	output.hi = band?.high == null ? null : Math.ceil(band.high / 1_000);
	output.slots = view.freeSlots;
	output.slotSrc = view.freeSlots === null ? 'unknown' : view.connection === 'connected' && view.sourceState === 'ready' ? 'ingame' : 'recent';
	output.slotAge = view.freeSlots === null ? null : output.age;
	output.mf = view.magicFind.value;
	output.mfKind = output.mf === null ? 'unknown' : 'partial';
	if (goal !== null) {
		output.goal = goal.goal.kind;
		output.target = goal.goal.kind === 'bags' ? goal.goal.targetBags : goal.goal.kind === 'duration' ? Math.floor(goal.goal.targetDurationMs / 1_000) : null;
		output.progress = goal.goal.kind === 'bags' ? output.observed : goal.goal.kind === 'duration' ? output.elapsed : null;
		output.eta = view.phase !== 'active' || goal.remainingMs === null || goal.goal.kind === 'bags' && (view.sourceState !== 'ready' || view.connection !== 'connected' || view.observedItemsMs < FARMING_GOAL_MIN_WINDOW_MS) ? null : Math.ceil(goal.remainingMs / 1_000);
	}
	output.prep = !input.preparationEnabled ? 'unknown' : output.mf === null || output.slots === null || output.slots <= 5 ? 'attention' : 'partial';
	return output;
}

/** Raw public best bid and lowest ask (copper, `null` when that side has no order) with the instant they were read. */
export interface BagRawQuote { bid: number | null; ask: number | null; capturedAt: number }

/**
 * Gross public price of the Halloween bag for the game (`price2`), as the Trading Post shows it: the
 * highest buy order and the lowest sell offer, per unit and times 250, with no fee discounted. Only a
 * live session in `active` has anything to price; an absent quotation is `pending`, one of 600 s or
 * more is `stale` and sends no figures.
 */
export function projectBagPriceIngameState(input: {
	phase: LiveSessionViewV1['phase']; quote: BagRawQuote | null; now: number;
}): PriceIngameState {
	const output = emptyPriceIngameState();
	if (input.phase !== 'active') return output;
	if (input.quote === null) return { ...output, st: 'pending' };
	const age = Math.max(0, Math.floor((input.now - input.quote.capturedAt) / 1_000));
	if (!Number.isFinite(age)) return { ...output, st: 'pending' };
	if (age >= PRICE_INGAME_STALE_SECONDS) return { ...output, st: 'stale', age };
	const gross = (unit: number | null, quantity: number): number | null => {
		if (unit === null || !Number.isSafeInteger(unit) || unit < 0) return null;
		const total = unit * quantity;
		return total <= 2_147_483_647 ? total : null;
	};
	const { bid, ask } = input.quote;
	return {
		st: 'ok', age,
		sell: gross(bid, 1), sellStack: gross(bid, PRICE_INGAME_STACK),
		list: gross(ask, 1), listStack: gross(ask, PRICE_INGAME_STACK),
	};
}
