import { describe, expect, it } from 'vitest';

import {
	INGAME_PRESENCE_GRACE_MS,
	IngamePresenceTracker,
	initialIngamePresenceState,
	reduceIngamePresence,
	type IngameConnectionEvent,
	type IngamePresenceEvent,
	type IngamePresenceInput,
	type IngamePresenceState,
} from './alert-ingame-presence';
import type { IngameGameContext } from './alert-ingame-protocol';

const GAMEPLAY_866: IngameGameContext = { state: 'gameplay', mapId: 866, character: 'Astra Uno' };
const GAMEPLAY_LA: IngameGameContext = { state: 'gameplay', mapId: 50, character: 'Astra Uno' };

/** Replays inputs through the pure reducer, collecting every emitted event. */
function replay(inputs: readonly IngamePresenceInput[]): { state: IngamePresenceState; events: IngamePresenceEvent[] } {
	let state = initialIngamePresenceState();
	const events: IngamePresenceEvent[] = [];
	let ids = 0;
	for (const input of inputs) {
		const result = reduceIngamePresence(state, input, () => { ids += 1; return `presence-${String(ids)}`; });
		state = result.state;
		events.push(...result.events);
	}
	return { state, events };
}

const auth = (connectionId: string, atMs: number, client: 'nexus' | 'blish' = 'nexus', instance = `i-${connectionId}`): IngameConnectionEvent =>
	({ kind: 'authenticated', connectionId, client, instance, atMs });
const context = (connectionId: string, atMs: number, value: IngameGameContext = GAMEPLAY_866): IngameConnectionEvent =>
	({ kind: 'context', connectionId, context: value, atMs });
const closed = (connectionId: string, atMs: number, reason: 'lost' | 'game_exit' | 'addon_unload' = 'lost', lastSeenAtMs = atMs): IngameConnectionEvent =>
	({ kind: 'closed', connectionId, atMs, lastSeenAtMs, reason });

describe('H18.23 in-game presence reducer', () => {
	it('starts on the first gameplay context, not on the connection or the character screen', () => {
		const { events, state } = replay([
			auth('a', 1_000),
			context('a', 1_500, { state: 'character_select', mapId: null, character: null }),
			context('a', 9_000, GAMEPLAY_866),
		]);
		expect(events).toEqual([{
			kind: 'started', presenceId: 'presence-1', revision: 1, atMs: 9_000,
			context: { source: 'nexus', state: 'gameplay', mapId: 866, character: 'Astra Uno', labyrinth: true },
		}]);
		expect(state.status).toBe('present');
	});

	it('produces one presence for two addons, and the effective context follows source priority', () => {
		const { events, state } = replay([
			auth('blish-1', 1_000, 'blish', 'same-game-blish'),
			context('blish-1', 1_100, GAMEPLAY_LA),
			auth('nexus-1', 1_200, 'nexus', 'same-game-nexus'),
			context('nexus-1', 1_300, GAMEPLAY_LA),
		]);
		expect(events.filter((event) => event.kind === 'started')).toHaveLength(1);
		expect(events.map((event) => event.kind)).toEqual(['started', 'context']);
		expect(state.context).toMatchObject({ source: 'nexus', labyrinth: false });
	});

	it('treats a closed connection as lost with grace, never as the end of the game', () => {
		const { events, state } = replay([auth('a', 0), context('a', 10), closed('a', 20_000, 'lost', 5_000)]);
		expect(events.at(-1)).toEqual({
			kind: 'lost', presenceId: 'presence-1', revision: 2, atMs: 20_000,
			lastSeenAtMs: 5_000, graceUntilMs: 5_000 + INGAME_PRESENCE_GRACE_MS,
		});
		expect(state.status).toBe('lost');
		expect(events.map((event) => event.kind)).not.toContain('ended');
	});

	it('restores the same presence when any addon reconnects within the grace', () => {
		const { events, state } = replay([
			auth('a', 0), context('a', 10), closed('a', 1_000),
			{ kind: 'tick', atMs: 1_000 + INGAME_PRESENCE_GRACE_MS - 1 },
			auth('b', 1_000 + INGAME_PRESENCE_GRACE_MS - 1, 'blish'),
		]);
		expect(events.map((event) => event.kind)).toEqual(['started', 'lost', 'restored']);
		expect(events.at(-1)).toMatchObject({ presenceId: 'presence-1' });
		expect(state.status).toBe('present');
	});

	it('ends after more than ten minutes lost, dated at the last evidence, not at the tick', () => {
		const { events, state } = replay([
			auth('a', 0), context('a', 10), closed('a', 3_000, 'lost', 2_000),
			{ kind: 'tick', atMs: 2_000 + INGAME_PRESENCE_GRACE_MS },
		]);
		expect(events.at(-1)).toEqual({
			kind: 'ended', presenceId: 'presence-1', revision: 3, atMs: 2_000 + INGAME_PRESENCE_GRACE_MS,
			endedAtMs: 2_000, reason: 'grace_expired',
		});
		expect(state.status).toBe('absent');
	});

	it('ends at once on bye game_exit from the last connection', () => {
		const { events } = replay([auth('a', 0), context('a', 10), closed('a', 4_000, 'game_exit')]);
		expect(events.at(-1)).toMatchObject({ kind: 'ended', endedAtMs: 4_000, reason: 'game_exit' });
	});

	it('keeps presence while another addon is still connected after one says game_exit', () => {
		const { events, state } = replay([
			auth('n', 0, 'nexus'), auth('b', 0, 'blish'), context('n', 10), context('b', 10),
			closed('n', 4_000, 'game_exit'),
		]);
		expect(events.map((event) => event.kind)).not.toContain('ended');
		expect(state.status).toBe('present');
		// The remaining addon then vanishes without a bye right after: the declared exit still dates the end.
		const after = reduceIngamePresence(state, closed('b', 6_000), () => 'unused');
		expect(after.events).toEqual([expect.objectContaining({ kind: 'ended', endedAtMs: 4_000, reason: 'game_exit' })]);
	});

	it('treats bye addon_unload like any other loss: grace, not an end', () => {
		const { events } = replay([auth('a', 0), context('a', 10), closed('a', 4_000, 'addon_unload')]);
		expect(events.at(-1)).toMatchObject({ kind: 'lost' });
	});

	it('ignores a duplicate authenticated event and a context from an unknown connection', () => {
		const once = replay([auth('a', 0), context('a', 10)]);
		const twice = replay([auth('a', 0), auth('a', 5), context('a', 10), context('ghost', 11, GAMEPLAY_LA)]);
		expect(twice.events).toEqual(once.events);
		expect(twice.state.connections).toHaveLength(1);
	});
});

describe('H18.23 in-game presence tracker', () => {
	it('arms the grace timer on loss and ends the presence when it fires', () => {
		let now = 0;
		const scheduled: { callback: () => void; milliseconds: number }[] = [];
		const tracker = new IngamePresenceTracker({
			timer: { schedule: (callback, milliseconds) => { scheduled.push({ callback, milliseconds }); return scheduled.length; }, cancel: () => undefined },
			now: () => now,
			createPresenceId: () => 'p-1',
			recordObserverFailure: () => undefined,
		});
		const events: IngamePresenceEvent[] = [];
		tracker.subscribe((event) => { events.push(event); });
		tracker.apply(auth('a', 0));
		tracker.apply(context('a', 0));
		now = 1_000;
		tracker.apply(closed('a', 1_000));
		expect(scheduled.at(-1)?.milliseconds).toBe(INGAME_PRESENCE_GRACE_MS);
		now = 1_000 + INGAME_PRESENCE_GRACE_MS;
		scheduled.at(-1)?.callback();
		expect(events.map((event) => event.kind)).toEqual(['started', 'lost', 'ended']);
		expect(tracker.snapshot()).toMatchObject({ status: 'absent', connections: 0 });
	});

	it('isolates a throwing listener: the others still hear the event and the failure is recorded', () => {
		const failures: unknown[] = [];
		const tracker = new IngamePresenceTracker({
			timer: { schedule: () => 1, cancel: () => undefined },
			now: () => 0,
			createPresenceId: () => 'p-1',
			recordObserverFailure: (error) => { failures.push(error); },
		});
		const heard: string[] = [];
		tracker.subscribe(() => { throw new Error('listener bug'); });
		tracker.subscribe((event) => { heard.push(event.kind); });
		tracker.apply(auth('a', 0));
		expect(() => { tracker.apply(context('a', 0)); }).not.toThrow();
		expect(heard).toEqual(['started']);
		expect(failures).toHaveLength(1);
	});
});
