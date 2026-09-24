import {
	INGAME_BRIDGE_CLIENT_PRIORITY,
	INGAME_BRIDGE_LIVENESS_TIMEOUT_MS,
	INGAME_LABYRINTH_MAP_ID,
	type IngameBridgeClient,
	type IngameByeReason,
	type IngameGameContext,
	type IngameGameState,
} from './alert-ingame-protocol';

/**
 * H18.23: game presence as the in-game bridge sees it, one presence for the whole machine.
 *
 * David's decisions of 2026-09-24 this module encodes, and nothing beyond them:
 * - outside the Labyrinth a session is the whole connection to the game;
 * - a disconnection of more than 10 minutes closes it, so a closed connection is a LOSS of
 *   presence with grace, never by itself "the game closed";
 * - Nexus and Blish HUD speak the same protocol, and two addons connected at once must produce
 *   ONE presence, not two.
 *
 * It does not start or finish a session. H18.26 owns that: it subscribes to these events and turns
 * `started`/`ended` into the session lifecycle. `presenceId` is the idempotency key it needs — a
 * `started` and an `ended` with the same id describe the same stretch of play however many
 * addons, reconnects or duplicate deliveries happened in between — and `revision` orders events.
 *
 * What presence is NOT evidence of: loot, activity, or AFK. Silence in combat, a disconnection or
 * a map change do not prove inactivity; the supported, audited sources do not provide a complete
 * loot flow or a reliable AFK signal. Only `game_exit` from the host is positive evidence of an end.
 */

/** Decided by David on 2026-09-24: more than ten minutes disconnected closes the session. */
export const INGAME_PRESENCE_GRACE_MS = 10 * 60_000;

/** What the server reports about one connection. `connectionId` is that connection's nonce. */
export type IngameConnectionEvent =
	| {
		readonly kind: 'authenticated';
		readonly connectionId: string;
		readonly client: IngameBridgeClient;
		readonly instance: string;
		readonly atMs: number;
	}
	| { readonly kind: 'context'; readonly connectionId: string; readonly context: IngameGameContext; readonly atMs: number }
	| {
		readonly kind: 'closed';
		readonly connectionId: string;
		readonly atMs: number;
		/** Time of the last valid frame on that connection: the last evidence the game was there. */
		readonly lastSeenAtMs: number;
		/** `lost` for every end without a `bye`: timeout, reset, protocol error, plugin shutdown. */
		readonly reason: 'lost' | IngameByeReason;
	};

export interface IngameEffectiveContext {
	readonly source: IngameBridgeClient;
	readonly state: IngameGameState;
	readonly mapId: number | null;
	readonly character: string | null;
	/** Map 866 while not at character select. A tag for H18.26, not a definition of "playing". */
	readonly labyrinth: boolean;
}

export type IngamePresenceStatus = 'absent' | 'present' | 'lost';

export type IngamePresenceEvent =
	| { readonly kind: 'started'; readonly presenceId: string; readonly revision: number; readonly atMs: number; readonly context: IngameEffectiveContext }
	| { readonly kind: 'context'; readonly presenceId: string; readonly revision: number; readonly atMs: number; readonly context: IngameEffectiveContext }
	| {
		readonly kind: 'lost';
		readonly presenceId: string;
		readonly revision: number;
		readonly atMs: number;
		readonly lastSeenAtMs: number;
		readonly graceUntilMs: number;
	}
	| { readonly kind: 'restored'; readonly presenceId: string; readonly revision: number; readonly atMs: number }
	| {
		readonly kind: 'ended';
		readonly presenceId: string;
		readonly revision: number;
		readonly atMs: number;
		/** When play actually stopped: the `bye` itself, or the last evidence before the grace ran out. */
		readonly endedAtMs: number;
		readonly reason: 'game_exit' | 'grace_expired';
	};

export interface IngamePresenceSnapshot {
	readonly status: IngamePresenceStatus;
	readonly presenceId: string | null;
	readonly revision: number;
	readonly startedAtMs: number | null;
	readonly lastSeenAtMs: number | null;
	readonly graceUntilMs: number | null;
	readonly context: IngameEffectiveContext | null;
	/** Authenticated connections right now. */
	readonly connections: number;
	/** Distinct addon processes among them: more than one host, or more than one game client. */
	readonly instances: number;
}

interface TrackedConnection {
	readonly id: string;
	readonly client: IngameBridgeClient;
	readonly instance: string;
	readonly connectedAtMs: number;
	readonly order: number;
	readonly context: IngameGameContext | null;
}

export interface IngamePresenceState {
	readonly status: IngamePresenceStatus;
	readonly presenceId: string | null;
	readonly revision: number;
	readonly startedAtMs: number | null;
	readonly lastSeenAtMs: number | null;
	readonly graceUntilMs: number | null;
	readonly exitDeclaredAtMs: number | null;
	readonly nextOrder: number;
	readonly connections: readonly TrackedConnection[];
	readonly context: IngameEffectiveContext | null;
}

export type IngamePresenceInput = IngameConnectionEvent | { readonly kind: 'tick'; readonly atMs: number };

export interface IngamePresenceResult {
	readonly state: IngamePresenceState;
	readonly events: readonly IngamePresenceEvent[];
}

export function initialIngamePresenceState(): IngamePresenceState {
	return {
		status: 'absent', presenceId: null, revision: 0, startedAtMs: null, lastSeenAtMs: null,
		graceUntilMs: null, exitDeclaredAtMs: null, nextOrder: 0, connections: [], context: null,
	};
}

/**
 * The pure transition. `createPresenceId` is called only when a new presence starts.
 *
 * - absent → present on the first `context` whose state is `gameplay` (a character in the world);
 *   an addon sitting at the login or character screen does not start anything.
 * - present → lost when the LAST connection ends without `bye game_exit`; `lastSeenAtMs` of that
 *   connection starts the grace. Other connections still open keep presence as it was.
 * - lost → present (`restored`, same `presenceId`) on any new authenticated connection before the
 *   grace runs out, whichever host or game client it is.
 * - lost → absent (`ended`, `grace_expired`) on a `tick` at or after `graceUntilMs`.
 * - present → absent (`ended`, `game_exit`) when the last connection closes with `bye game_exit`,
 *   or closes any other way within the liveness window after another connection declared it.
 */
export function reduceIngamePresence(
	current: IngamePresenceState,
	input: IngamePresenceInput,
	createPresenceId: () => string,
	graceMs: number = INGAME_PRESENCE_GRACE_MS,
): IngamePresenceResult {
	if (input.kind === 'tick') return reduceTick(current, input.atMs);
	if (input.kind === 'authenticated') {
		if (current.connections.some((connection) => connection.id === input.connectionId)) return { state: current, events: [] };
		const connections = [...current.connections, {
			id: input.connectionId, client: input.client, instance: input.instance,
			connectedAtMs: input.atMs, order: current.nextOrder, context: null,
		}];
		const next: IngamePresenceState = { ...current, connections, nextOrder: current.nextOrder + 1, exitDeclaredAtMs: null };
		if (current.status !== 'lost' || current.presenceId === null) return { state: next, events: [] };
		const revision = current.revision + 1;
		return {
			state: { ...next, status: 'present', revision, lastSeenAtMs: null, graceUntilMs: null },
			events: [{ kind: 'restored', presenceId: current.presenceId, revision, atMs: input.atMs }],
		};
	}
	if (input.kind === 'context') return reduceContext(current, input, createPresenceId);
	return reduceClosed(current, input, graceMs);
}

function reduceContext(
	current: IngamePresenceState,
	input: Extract<IngameConnectionEvent, { kind: 'context' }>,
	createPresenceId: () => string,
): IngamePresenceResult {
	if (!current.connections.some((connection) => connection.id === input.connectionId)) return { state: current, events: [] };
	const connections = current.connections.map((connection) => connection.id === input.connectionId
		? { ...connection, context: { ...input.context } } : connection);
	const context = effectiveContext(connections);
	const next: IngamePresenceState = { ...current, connections, context: context ?? current.context };
	if (current.status === 'absent') {
		if (context === null || context.state !== 'gameplay') return { state: next, events: [] };
		const presenceId = createPresenceId();
		const revision = current.revision + 1;
		return {
			state: { ...next, status: 'present', presenceId, revision, startedAtMs: input.atMs, exitDeclaredAtMs: null },
			events: [{ kind: 'started', presenceId, revision, atMs: input.atMs, context }],
		};
	}
	return withContextEvent(current, next, context, input.atMs);
}

function reduceClosed(
	current: IngamePresenceState,
	input: Extract<IngameConnectionEvent, { kind: 'closed' }>,
	graceMs: number,
): IngamePresenceResult {
	const closing = current.connections.find((connection) => connection.id === input.connectionId);
	if (closing === undefined) return { state: current, events: [] };
	const connections = current.connections.filter((connection) => connection.id !== input.connectionId);
	const exitDeclaredAtMs = input.reason === 'game_exit' ? input.atMs : current.exitDeclaredAtMs;
	const next: IngamePresenceState = { ...current, connections, exitDeclaredAtMs };
	if (current.status !== 'present' || current.presenceId === null) {
		return { state: { ...next, context: connections.length === 0 ? null : effectiveContext(connections) }, events: [] };
	}
	if (connections.length > 0) return withContextEvent(current, next, effectiveContext(connections), input.atMs);

	const revision = current.revision + 1;
	const declaredExit = exitDeclaredAtMs !== null && input.atMs - exitDeclaredAtMs <= INGAME_BRIDGE_LIVENESS_TIMEOUT_MS;
	if (declaredExit) {
		return {
			state: { ...initialIngamePresenceState(), revision, nextOrder: current.nextOrder },
			events: [{
				kind: 'ended', presenceId: current.presenceId, revision, atMs: input.atMs,
				endedAtMs: exitDeclaredAtMs, reason: 'game_exit',
			}],
		};
	}
	const lastSeenAtMs = Math.min(input.lastSeenAtMs, input.atMs);
	const graceUntilMs = lastSeenAtMs + graceMs;
	return {
		state: { ...next, status: 'lost', revision, lastSeenAtMs, graceUntilMs, exitDeclaredAtMs: null },
		events: [{ kind: 'lost', presenceId: current.presenceId, revision, atMs: input.atMs, lastSeenAtMs, graceUntilMs }],
	};
}

function reduceTick(current: IngamePresenceState, atMs: number): IngamePresenceResult {
	if (current.status !== 'lost' || current.presenceId === null || current.graceUntilMs === null
		|| current.lastSeenAtMs === null || atMs < current.graceUntilMs) {
		return { state: current, events: [] };
	}
	const revision = current.revision + 1;
	return {
		state: { ...initialIngamePresenceState(), revision, nextOrder: current.nextOrder },
		events: [{
			kind: 'ended', presenceId: current.presenceId, revision, atMs,
			endedAtMs: current.lastSeenAtMs, reason: 'grace_expired',
		}],
	};
}

function withContextEvent(
	current: IngamePresenceState,
	next: IngamePresenceState,
	context: IngameEffectiveContext | null,
	atMs: number,
): IngamePresenceResult {
	if (context === null || current.presenceId === null || sameContext(context, current.context)) {
		return { state: next, events: [] };
	}
	const revision = current.revision + 1;
	return {
		state: { ...next, context, revision },
		events: [{ kind: 'context', presenceId: current.presenceId, revision, atMs, context }],
	};
}

/**
 * The one context everybody sees: the highest-priority host, then the earliest connection among
 * equals. Connections that have not reported yet do not compete. Deterministic, so the same set of
 * connections always yields the same answer whatever order their frames arrived in.
 */
function effectiveContext(connections: readonly TrackedConnection[]): IngameEffectiveContext | null {
	let best: TrackedConnection | null = null;
	for (const connection of connections) {
		if (connection.context === null) continue;
		if (best === null || outranks(connection, best)) best = connection;
	}
	if (best === null || best.context === null) return null;
	const { state, mapId, character } = best.context;
	return {
		source: best.client, state, mapId, character,
		labyrinth: mapId === INGAME_LABYRINTH_MAP_ID && state !== 'character_select',
	};
}

function outranks(candidate: TrackedConnection, incumbent: TrackedConnection): boolean {
	const byPriority = INGAME_BRIDGE_CLIENT_PRIORITY[candidate.client] - INGAME_BRIDGE_CLIENT_PRIORITY[incumbent.client];
	if (byPriority !== 0) return byPriority > 0;
	if (candidate.connectedAtMs !== incumbent.connectedAtMs) return candidate.connectedAtMs < incumbent.connectedAtMs;
	return candidate.order < incumbent.order;
}

function sameContext(left: IngameEffectiveContext, right: IngameEffectiveContext | null): boolean {
	return right !== null && left.source === right.source && left.state === right.state
		&& left.mapId === right.mapId && left.character === right.character;
}

export function ingamePresenceSnapshot(state: IngamePresenceState): IngamePresenceSnapshot {
	return {
		status: state.status,
		presenceId: state.presenceId,
		revision: state.revision,
		startedAtMs: state.startedAtMs,
		lastSeenAtMs: state.lastSeenAtMs,
		graceUntilMs: state.graceUntilMs,
		context: state.context === null ? null : { ...state.context },
		connections: state.connections.length,
		instances: new Set(state.connections.map((connection) => connection.instance)).size,
	};
}

export interface IngamePresenceTimer {
	schedule(callback: () => void, milliseconds: number): unknown;
	cancel(handle: unknown): void;
}

export interface IngamePresenceTrackerOptions {
	readonly timer: IngamePresenceTimer;
	readonly now: () => number;
	readonly createPresenceId: () => string;
	/** Receives what a subscriber threw, so one bad listener neither breaks the socket nor the others. */
	readonly recordObserverFailure: (error: unknown) => void;
	readonly graceMs?: number;
}

/**
 * The stateful shell around `reduceIngamePresence`: holds the state across server restarts (a port
 * change closes every connection, which is a loss with grace like any other), arms the one grace
 * timer, and fans events out to subscribers. This is the store H18.26 reads and subscribes to.
 */
export class IngamePresenceTracker {
	private state = initialIngamePresenceState();
	private readonly listeners = new Set<(event: IngamePresenceEvent) => void>();
	private graceTimer: unknown = null;

	constructor(private readonly options: IngamePresenceTrackerOptions) {}

	/** Feeds one connection event from the server. */
	apply(event: IngameConnectionEvent): void {
		this.dispatch(event);
	}

	snapshot(): IngamePresenceSnapshot {
		return ingamePresenceSnapshot(this.state);
	}

	/** Registers a listener for every future event; the returned function removes it. */
	subscribe(listener: (event: IngamePresenceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Cancels the grace timer and drops every listener. The plugin calls it on unload. */
	dispose(): void {
		this.cancelGraceTimer();
		this.listeners.clear();
	}

	private dispatch(input: IngamePresenceInput): void {
		const result = reduceIngamePresence(this.state, input, this.options.createPresenceId, this.options.graceMs);
		this.state = result.state;
		this.armGraceTimer();
		for (const event of result.events) this.notify(event);
	}

	private armGraceTimer(): void {
		this.cancelGraceTimer();
		const graceUntilMs = this.state.status === 'lost' ? this.state.graceUntilMs : null;
		if (graceUntilMs === null) return;
		const delay = Math.max(0, graceUntilMs - this.options.now());
		this.graceTimer = this.options.timer.schedule(() => {
			this.graceTimer = null;
			this.dispatch({ kind: 'tick', atMs: this.options.now() });
		}, delay);
	}

	private cancelGraceTimer(): void {
		if (this.graceTimer === null) return;
		this.options.timer.cancel(this.graceTimer);
		this.graceTimer = null;
	}

	private notify(event: IngamePresenceEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch (error) {
				this.options.recordObserverFailure(error);
			}
		}
	}
}
