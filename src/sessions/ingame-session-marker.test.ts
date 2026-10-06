/**
 * H18.26: the in-game presence marks the session by itself. Each rule David decided on 2026-09-24
 * runs through the REAL presence tracker (H18.23), driven by a fake clock and a fake timer, so a
 * disconnection's grace is the tracker's own and not a copy of it here. The session side is a
 * small in-memory double of the host pipeline: it records every start and every stop it is asked
 * for, which is exactly what the marker decides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { INGAME_PRESENCE_GRACE_MS, IngamePresenceTracker } from '../alerts/alert-ingame-presence';
import type { IngameBridgeClient, IngameGameContext } from '../alerts/alert-ingame-protocol';
import {
	IngameSessionMarker,
	isIngameSessionLink,
	type IngameSessionLink,
	type IngameSessionView,
} from './ingame-session-marker';
import type { SessionStatus } from './session';

const T0 = Date.parse('2026-10-20T18:00:00.000Z');
const OUTSIDE: IngameGameContext = { state: 'gameplay', mapId: 50, character: 'Astra Uno' };
const LABYRINTH: IngameGameContext = { state: 'gameplay', mapId: 866, character: 'Astra Uno' };

let clock = T0;

interface FakeTimer { callback: () => void; at: number }

function harness(options: {
	enabled?: boolean;
	session?: { status: SessionStatus; sessionId: string | null };
	link?: IngameSessionLink | null;
} = {}) {
	let timers: FakeTimer[] = [];
	let presenceIds = 0;
	let sessionIds = 0;
	let enabled = options.enabled ?? true;
	let session = options.session ?? { status: 'idle' as SessionStatus, sessionId: null };
	let savedLink: IngameSessionLink | null = options.link ?? null;
	const tracker = new IngamePresenceTracker({
		timer: {
			schedule: (callback, milliseconds) => {
				const timer = { callback, at: clock + milliseconds };
				timers.push(timer);
				return timer;
			},
			cancel: (handle) => { timers = timers.filter((timer) => timer !== handle); },
		},
		now: () => clock,
		createPresenceId: () => { presenceIds += 1; return `presence-${String(presenceIds)}`; },
		recordObserverFailure: vi.fn(),
	});
	const port = {
		enabled: () => enabled,
		session: (): IngameSessionView => ({
			...session, canStart: session.status === 'idle' || session.status === 'complete',
		}),
		start: vi.fn(async (_character: string | null) => {
			sessionIds += 1;
			session = { status: 'active', sessionId: `session-${String(sessionIds)}` };
			return session.sessionId;
		}),
		stopAt: vi.fn(async (sessionId: string, _endedAtMs: number) => {
			session = { status: 'stopping', sessionId };
		}),
		loadLink: () => savedLink,
		saveLink: (link: IngameSessionLink | null) => { savedLink = link; },
		recordFailure: vi.fn(),
	};
	const marker = new IngameSessionMarker({ port, presence: () => tracker.snapshot(), now: () => clock });
	let pending: Promise<void> = Promise.resolve();
	tracker.subscribe((event) => { pending = marker.handle(event); });

	return {
		port,
		marker,
		tracker,
		setSession: (next: { status: SessionStatus; sessionId: string | null }) => { session = next; },
		setEnabled: (value: boolean) => { enabled = value; },
		link: () => savedLink,
		/** Waits until the marker has handled every event emitted so far. */
		settled: async () => { await pending; },
		connect: (connectionId: string, client: IngameBridgeClient = 'nexus', instance = `game-${connectionId}`) => {
			tracker.apply({ kind: 'authenticated', connectionId, client, instance, atMs: clock });
		},
		report: (connectionId: string, context: IngameGameContext) => {
			tracker.apply({ kind: 'context', connectionId, context, atMs: clock });
		},
		drop: (connectionId: string) => {
			tracker.apply({ kind: 'closed', connectionId, atMs: clock, lastSeenAtMs: clock, reason: 'lost' });
		},
		/** Moves the fake clock and fires every timer that came due, like the host would. */
		advance: (milliseconds: number) => {
			clock += milliseconds;
			for (const timer of timers.filter((candidate) => candidate.at <= clock)) {
				timers = timers.filter((candidate) => candidate !== timer);
				timer.callback();
			}
		},
	};
}

describe('H18.26: the in-game presence marks the session', () => {
	beforeEach(() => { clock = T0; });

	it('observes outside and Labyrinth intervals without splitting the whole connection', async () => {
		const game = harness();
		game.connect('a'); game.report('a', OUTSIDE); await game.settled();
		game.advance(30 * 60_000); game.report('a', LABYRINTH); await game.settled();
		game.advance(60 * 60_000);
		expect(game.marker.presenceEvidenceFor('session-1')).toEqual({ scope: 'mixed', intervals: [
			{ mapId: 50, fromMs: T0, toMs: T0 + 30 * 60_000 },
			{ mapId: 866, fromMs: T0 + 30 * 60_000, toMs: T0 + 90 * 60_000 },
		] });
		expect(game.marker.presenceEvidenceFor('session-1', T0 + 60 * 60_000)).toEqual({ scope: 'mixed', intervals: [
			{ mapId: 50, fromMs: T0, toMs: T0 + 30 * 60_000 },
			{ mapId: 866, fromMs: T0 + 30 * 60_000, toMs: T0 + 60 * 60_000 },
		] });
		expect(game.port.start).toHaveBeenCalledOnce(); expect(game.port.stopAt).not.toHaveBeenCalled();
	});

	it('certifies observed pure Labyrinth presence but marks disconnect coverage unknown', async () => {
		const game = harness(); game.connect('a'); game.report('a', LABYRINTH); await game.settled();
		game.advance(60_000);
		expect(game.marker.presenceEvidenceFor('session-1')?.scope).toBe('pure_labyrinth');
		game.drop('a'); await game.settled();
		expect(game.marker.presenceEvidenceFor('session-1')).toMatchObject({ scope: 'unknown', coverage: 'partial' });
	});

	it('opens a session when the game starts, once, with the character the game reported', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', OUTSIDE);
		await game.settled();

		expect(game.port.start).toHaveBeenCalledOnce();
		expect(game.port.start).toHaveBeenCalledWith('Astra Uno');
		expect(game.link()).toMatchObject({ presenceId: 'presence-1', sessionId: 'session-1', owner: 'automatic' });
	});

	it('does not open anything at the character screen', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', { state: 'character_select', mapId: null, character: null });
		await game.settled();
		expect(game.port.start).not.toHaveBeenCalled();
	});

	it('adopts a session the player already started by hand instead of opening a second one', async () => {
		const game = harness({ session: { status: 'active', sessionId: 'manual-1' } });
		game.connect('a');
		game.report('a', OUTSIDE);
		await game.settled();

		expect(game.port.start).not.toHaveBeenCalled();
		expect(game.link()).toMatchObject({ sessionId: 'manual-1', owner: 'adopted' });
	});

	it('never closes an adopted session: the player who started it by hand ends it', async () => {
		const game = harness({ session: { status: 'active', sessionId: 'manual-1' } });
		game.connect('a');
		game.report('a', OUTSIDE);
		game.drop('a');
		game.advance(INGAME_PRESENCE_GRACE_MS + 1_000);
		await game.settled();

		expect(game.port.stopAt).not.toHaveBeenCalled();
	});

	it('tags the session as the Labyrinth when the game enters map 866', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', OUTSIDE);
		await game.settled();
		expect(game.link()?.labyrinthAt).toBeNull();

		clock += 60_000;
		game.report('a', LABYRINTH);
		await game.settled();
		expect(game.link()?.labyrinthAt).toBe(new Date(clock).toISOString());
		expect(game.marker.labyrinthObservedAt('session-1')).toBe(new Date(clock).toISOString());
		expect(game.marker.labyrinthObservedAt('another-session')).toBeNull();
	});

	/** H18.36: the Sesión tab's own badge and meta suffix (boceto lámina 2.1) read this. */
	it('linkFor: owner and labyrinthAt for the session on screen, null for any other', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', OUTSIDE);
		await game.settled();
		expect(game.marker.linkFor('session-1')).toEqual({ owner: 'automatic', labyrinthAt: null });
		expect(game.marker.linkFor('another-session')).toBeNull();

		clock += 60_000;
		game.report('a', LABYRINTH);
		await game.settled();
		expect(game.marker.linkFor('session-1')).toEqual({ owner: 'automatic', labyrinthAt: new Date(clock).toISOString() });
	});

	it('keeps the session through a short disconnection', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', OUTSIDE);
		game.drop('a');
		game.advance(INGAME_PRESENCE_GRACE_MS - 1_000);
		game.connect('a2');
		game.report('a2', OUTSIDE);
		game.advance(INGAME_PRESENCE_GRACE_MS * 2);
		await game.settled();

		expect(game.port.stopAt).not.toHaveBeenCalled();
		expect(game.port.start).toHaveBeenCalledOnce();
	});

	it('closes it after more than ten minutes away, ending at the last presence, not at the close', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', OUTSIDE);
		clock += 45 * 60_000;
		const lastSeen = clock;
		game.drop('a');
		game.advance(INGAME_PRESENCE_GRACE_MS);
		await game.settled();

		expect(game.port.stopAt).toHaveBeenCalledOnce();
		expect(game.port.stopAt).toHaveBeenCalledWith('session-1', lastSeen);
		expect(clock - lastSeen).toBe(INGAME_PRESENCE_GRACE_MS);
	});

	it('gives one session for Nexus and Blish connected at once, and keeps it while one of them stays', async () => {
		const game = harness();
		game.connect('blish', 'blish', 'blish-process');
		game.report('blish', OUTSIDE);
		game.connect('nexus', 'nexus', 'game-process');
		game.report('nexus', OUTSIDE);
		game.drop('blish');
		game.advance(INGAME_PRESENCE_GRACE_MS * 2);
		await game.settled();

		expect(game.port.start).toHaveBeenCalledOnce();
		expect(game.port.stopAt).not.toHaveBeenCalled();
	});

	it('does not cut the session on a character change', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', OUTSIDE);
		game.report('a', { state: 'loading', mapId: null, character: 'Astra Uno' });
		game.report('a', { state: 'character_select', mapId: null, character: null });
		game.report('a', { state: 'gameplay', mapId: 15, character: 'Astra Dos' });
		await game.settled();

		expect(game.port.start).toHaveBeenCalledOnce();
		expect(game.port.stopAt).not.toHaveBeenCalled();
		expect(game.link()).toMatchObject({ presenceId: 'presence-1', sessionId: 'session-1' });
	});

	it('does nothing when the bridge or the API key is missing', async () => {
		const game = harness({ enabled: false });
		game.connect('a');
		game.report('a', OUTSIDE);
		game.drop('a');
		game.advance(INGAME_PRESENCE_GRACE_MS * 2);
		await game.settled();

		expect(game.port.start).not.toHaveBeenCalled();
		expect(game.port.stopAt).not.toHaveBeenCalled();
		expect(game.link()).toBeNull();
	});

	it('never reopens a session the player stopped by hand while the same game goes on', async () => {
		const game = harness();
		game.connect('a');
		game.report('a', OUTSIDE);
		await game.settled();
		game.setSession({ status: 'complete', sessionId: 'session-1' });
		game.report('a', LABYRINTH);
		await game.marker.reconcile();

		expect(game.port.start).toHaveBeenCalledOnce();
	});

	// The Session tab's «Finish session» goes through `stopManualSession`, which marks the stop with
	// `markStoppedByPlayer`; this is what that mark guarantees (measured 6 oct 2026).
	it('keeps the automatic start closed after a hand stop for as long as the same presence lasts, and a hand start reopens it', async () => {
		const game = harness();
		game.connect('a'); game.report('a', OUTSIDE); await game.settled();
		expect(game.marker.blocksAutomaticRestart()).toBe(false);
		expect(game.port.start).toHaveBeenCalledOnce();

		game.marker.markStoppedByPlayer('session-1');
		game.setSession({ status: 'complete', sessionId: 'session-1' });
		expect(game.marker.blocksAutomaticRestart()).toBe(true);
		expect(game.link()).toMatchObject({ sessionId: 'session-1', stoppedByPlayer: true });
		game.report('a', LABYRINTH); await game.marker.reconcile(); await game.settled();
		expect(game.port.start).toHaveBeenCalledOnce();
		expect(game.marker.blocksAutomaticRestart()).toBe(true);

		// «Start session» by hand (the core links the new session through `linkReplacement`) lifts the block.
		game.marker.linkReplacement('session-1', 'session-2', 'adopted');
		expect(game.marker.blocksAutomaticRestart()).toBe(false);
		expect(game.link()).toMatchObject({ sessionId: 'session-2', owner: 'adopted' });
		expect(game.link()?.stoppedByPlayer).toBeUndefined();
	});

	it('lets a new game connection open its own session after a hand stop on the previous one', async () => {
		const game = harness();
		game.connect('a'); game.report('a', OUTSIDE); await game.settled();
		game.marker.markStoppedByPlayer('session-1');
		game.setSession({ status: 'complete', sessionId: 'session-1' });
		game.drop('a'); game.advance(INGAME_PRESENCE_GRACE_MS); await game.settled();
		game.connect('b'); game.report('b', OUTSIDE); await game.settled();
		expect(game.marker.blocksAutomaticRestart()).toBe(false);
		expect(game.port.start).toHaveBeenCalledTimes(2);
	});

	it('keeps an automatic session automatic across a plugin reload', async () => {
		const link: IngameSessionLink = {
			version: 1, presenceId: 'before-reload', sessionId: 'session-9', owner: 'automatic', labyrinthAt: null,
		};
		const game = harness({ session: { status: 'active', sessionId: 'session-9' }, link });
		game.connect('a');
		game.report('a', OUTSIDE);
		const lastSeen = clock;
		game.drop('a');
		game.advance(INGAME_PRESENCE_GRACE_MS);
		await game.settled();

		expect(game.port.start).not.toHaveBeenCalled();
		expect(game.port.stopAt).toHaveBeenCalledWith('session-9', lastSeen);
	});

	it('opens the next session once the previous one can be released, without another event', async () => {
		const game = harness({ session: { status: 'provisional', sessionId: 'old' } });
		game.connect('a');
		game.report('a', OUTSIDE);
		await game.settled();
		expect(game.port.start).not.toHaveBeenCalled();

		game.setSession({ status: 'complete', sessionId: 'old' });
		await game.marker.reconcile();
		expect(game.port.start).toHaveBeenCalledOnce();
	});

	it('reports a failed start instead of throwing, and tries again on the next event', async () => {
		const game = harness();
		game.port.start.mockRejectedValueOnce(new Error('network'));
		game.connect('a');
		game.report('a', OUTSIDE);
		await game.settled();
		expect(game.port.recordFailure).toHaveBeenCalledOnce();

		game.report('a', LABYRINTH);
		await game.settled();
		expect(game.port.start).toHaveBeenCalledTimes(2);
		expect(game.link()).toMatchObject({ owner: 'automatic', labyrinthAt: new Date(clock).toISOString() });
	});

	it('keeps the observed game exit queued while its initial session capture is in flight', async () => {
		const game = harness();
		let finishStart!: (sessionId: string) => void;
		game.port.start.mockImplementationOnce(() => new Promise<string>((resolve) => { finishStart = resolve; }));
		game.connect('a');
		game.report('a', OUTSIDE);
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		const lastSeen = clock;
		game.drop('a');
		game.advance(INGAME_PRESENCE_GRACE_MS);
		const reconciled = game.marker.reconcile();
		game.setSession({ status: 'active', sessionId: 'session-1' });
		finishStart('session-1');
		await game.settled();
		await reconciled;
		expect(game.port.start).toHaveBeenCalledOnce();
		expect(game.port.stopAt).toHaveBeenCalledOnce();
		expect(game.port.stopAt).toHaveBeenCalledWith('session-1', lastSeen);
	});

	it('H18.11: reports the stretches the game was seen being played, open and finished', () => {
		const game = harness();
		expect(game.marker.observedPlayIntervals()).toEqual([]);
		game.connect('a');
		game.report('a', OUTSIDE);
		const startedAt = clock;
		clock += 30 * 60_000;
		// Present: the stretch runs to now.
		expect(game.marker.observedPlayIntervals()).toEqual([{ fromMs: startedAt, toMs: clock }]);
		const lastSeen = clock;
		game.drop('a');
		clock += 60_000;
		// In its grace: up to the last frame, not to now.
		expect(game.marker.observedPlayIntervals()).toEqual([{ fromMs: startedAt, toMs: lastSeen }]);
		game.advance(INGAME_PRESENCE_GRACE_MS);
		// Ended: kept as a finished stretch that closes at the last frame.
		expect(game.marker.observedPlayIntervals()).toEqual([{ fromMs: startedAt, toMs: lastSeen }]);
	});

	it('only trusts a stored link with the exact shape it writes', () => {
		expect(isIngameSessionLink({ version: 1, presenceId: 'p', sessionId: 's', owner: 'automatic', labyrinthAt: null })).toBe(true);
		expect(isIngameSessionLink({ version: 1, presenceId: 'p', sessionId: 's', owner: 'someone', labyrinthAt: null })).toBe(false);
		expect(isIngameSessionLink({ version: 2, presenceId: 'p', sessionId: 's', owner: 'automatic', labyrinthAt: null })).toBe(false);
		expect(isIngameSessionLink(null)).toBe(false);
	});
});
