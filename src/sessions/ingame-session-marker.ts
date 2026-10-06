import type { SessionMapInterval, SessionPresenceEvidence } from './session-comparison-metadata';
import type { IngamePresenceEvent, IngamePresenceSnapshot } from '../alerts/alert-ingame-presence';
import type { SessionStatus } from './session';

/**
 * H18.26: the in-game addon marks the session by itself. David's decisions of 2026-09-24, and
 * nothing beyond them:
 * - outside the Labyrinth a session is the whole connection to the game;
 * - entering map 866 tags the session as the Labyrinth;
 * - a disconnection of more than ten minutes closes it (the presence tracker owns that grace);
 * - pauses, character changes and short disconnections never cut it;
 * - two addons connected at once give one session (the tracker already merges them into one
 *   presence, so this only ever sees one `presenceId`).
 *
 * Policy for a session the player started by hand (decided here, the minimum that never overrides
 * the player): a presence that finds a session already in progress ADOPTS it instead of opening a
 * second one. An adopted session is tagged like any other, but the presence never stops it; the
 * player who started it by hand ends it by hand. Only a session this marker opened is closed by the
 * presence, at the end the presence observed. And a presence that was linked to a session once
 * never opens another one: a session the player stopped by hand mid-game stays stopped.
 *
 * It does nothing at all unless `enabled()` says so (the bridge is on and an API key is set).
 */

/** What survives a plugin reload, so an automatic session found running again stays automatic. */
export interface IngameSessionLink {
	version: 1;
	presenceId: string;
	sessionId: string;
	owner: 'automatic' | 'adopted';
	/** First instant the presence reported map 866 while this session ran; null until then. */
	labyrinthAt: string | null;
	/** Optional extension of link v1: old links remain valid, with unknown map coverage. */
	mapIntervals?: SessionMapInterval[];
	mapObservation?: { mapId: number | null; fromMs: number } | null;
	mapCoveragePartial?: boolean;
}

export interface IngameSessionView {
	status: SessionStatus;
	/** Null while idle, or when the status carries no session (an error without a failed state). */
	sessionId: string | null;
	/** Whether a new session may start now (idle, or a finished one whose summary is saved). */
	canStart: boolean;
}

export interface IngameSessionMarkerPort {
	/** The bridge is enabled and an API key is configured. */
	enabled(): boolean;
	session(): IngameSessionView;
	/** Starts a session through the host's own start pipeline; resolves to its id, or null. */
	start(character: string | null): Promise<string | null>;
	/** Stops the session through the host's own stop pipeline, ending it at `endedAtMs`. */
	stopAt(sessionId: string, endedAtMs: number): Promise<void>;
	/** Whatever was stored; the marker keeps it only if it has the exact shape it writes. */
	loadLink(): unknown;
	saveLink(link: IngameSessionLink | null): void;
	/** Receives what a start, a stop or a link write threw; the marker itself never throws. */
	recordFailure(error: unknown): void;
}

export interface IngameSessionMarkerOptions {
	port: IngameSessionMarkerPort;
	presence: () => IngamePresenceSnapshot;
	now: () => number;
}

/** Finished stretches of play kept for H18.11: enough to cover any session, bounded all the same. */
const OBSERVED_PLAY_KEPT = 32;

const IN_PROGRESS: ReadonlySet<SessionStatus> = new Set(['starting', 'active', 'stopping', 'provisional']);

export class IngameSessionMarker {
	private link: IngameSessionLink | null;
	/** Presences already linked to a session once; none of them opens another. */
	private readonly linkedPresences = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	/** Session changes from our own start are feedback, not another request to start. */
	private startInFlight = false;
	private disposed = false;
	/** H18.11: when each presence still open started, to close its stretch on `ended`. */
	private readonly playStartedAt = new Map<string, number>();
	/** H18.11: finished stretches of observed play, most recent last, at most `OBSERVED_PLAY_KEPT`. */
	private readonly finishedPlay: Array<{ fromMs: number; toMs: number }> = [];

	constructor(private readonly options: IngameSessionMarkerOptions) {
		this.link = readLink(options.port);
		if (this.link !== null) {
			this.linkedPresences.add(this.link.presenceId);
			// Reload silence cannot certify which map was played while this marker was absent.
			this.link = { ...this.link, mapObservation: null, mapCoveragePartial: true };
		}
	}

	/** Feeds one presence event. Events are handled one at a time, in order. */
	handle(event: IngamePresenceEvent): Promise<void> {
		if (event.kind === 'started') this.playStartedAt.set(event.presenceId, event.atMs);
		if (event.kind === 'ended') this.finishPlay(event.presenceId, event.endedAtMs);
		return this.enqueue(() => this.process(event));
	}

	/** Closes one observed stretch of play, keeping only the most recent ones. */
	private finishPlay(presenceId: string, endedAtMs: number): void {
		const startedAt = this.playStartedAt.get(presenceId);
		this.playStartedAt.delete(presenceId);
		if (startedAt === undefined || endedAtMs <= startedAt) return;
		this.finishedPlay.push({ fromMs: startedAt, toMs: endedAtMs });
		if (this.finishedPlay.length > OBSERVED_PLAY_KEPT) this.finishedPlay.splice(0, this.finishedPlay.length - OBSERVED_PLAY_KEPT);
	}

	/**
	 * Re-reads the session and the presence: called when the session changes on its own (a finished
	 * one got its summary saved, a recovery ended), so a presence that could not start a session
	 * before can do it now without waiting for the next event from the game.
	 */
	reconcile(): Promise<void> {
		if (this.startInFlight) return Promise.resolve();
		return this.enqueue(async () => {
			const presence = this.options.presence();
			if (presence.status !== 'present' || presence.presenceId === null) return;
			await this.ensureLinked(presence.presenceId, presence.context?.character ?? null);
			if (presence.context?.labyrinth === true) this.tagLabyrinth(presence.presenceId, this.options.now());
			this.observeMap(presence.presenceId, presence.context?.state === 'gameplay' ? presence.context.mapId : null, this.options.now());
		});
	}

	/**
	 * H18.11: the stretches the game was seen being played, oldest first. A finished presence runs
	 * from its start to its end; the current one runs to now while present, or to its last frame
	 * while in its grace. Kept whatever `enabled()` says: it is evidence, not an action.
	 */
	observedPlayIntervals(): Array<{ fromMs: number; toMs: number }> {
		const intervals = this.finishedPlay.map((interval) => ({ ...interval }));
		const presence = this.options.presence();
		if (presence.startedAtMs !== null) {
			const toMs = presence.status === 'present' ? this.options.now()
				: presence.status === 'lost' ? presence.lastSeenAtMs : null;
			if (toMs !== null && toMs > presence.startedAtMs) intervals.push({ fromMs: presence.startedAtMs, toMs });
		}
		return intervals;
	}

	/** When the Labyrinth tag was observed for `sessionId`, or null. Read when its note is written. */
	labyrinthObservedAt(sessionId: string): string | null {
		return this.link?.sessionId === sessionId ? this.link.labyrinthAt : null;
	}

	/**
	 * H18.36: the Sesión tab's own badge (boceto lámina 2.1) reads `owner`/`labyrinthAt` for the
	 * session ON SCREEN, the same two fields the note already reads through `labyrinthObservedAt`.
	 * Null for a session this marker never linked (never enabled, or started before the addon saw
	 * it) — the badge and the "la marcó Nexus" meta suffix simply do not render, never a guess.
	 */
	linkFor(sessionId: string): Pick<IngameSessionLink, 'owner' | 'labyrinthAt'> | null {
		if (this.link === null || this.link.sessionId !== sessionId) return null;
		return { owner: this.link.owner, labyrinthAt: this.link.labyrinthAt };
	}

	/** Map coverage of the linked connection, read at note time; loot stays whole-connection. */
	presenceEvidenceFor(sessionId: string, endedAtMs?: number): SessionPresenceEvidence | null {
		if (this.link?.sessionId !== sessionId) return null;
		const intervals = (this.link.mapIntervals ?? []).map((interval) => ({ ...interval }));
		const current = this.link.mapObservation;
		const presence = this.options.presence();
		const observedEnd = presence.status === 'lost' ? presence.lastSeenAtMs : this.options.now();
		const end = endedAtMs ?? observedEnd;
		if (current && end !== null && end > current.fromMs) intervals.push({ mapId: current.mapId, fromMs: current.fromMs, toMs: end });
		const clipped = intervals.map((interval) => ({ ...interval,
			toMs: Math.min(interval.toMs, end ?? interval.toMs),
		})).filter((interval) => interval.toMs > interval.fromMs);
		const partial = this.link.mapCoveragePartial === true;
		const maps = clipped.map((interval) => interval.mapId);
		const scope = maps.includes(866) && maps.some((map) => map !== null && map !== 866) ? 'mixed'
			: partial || maps.length === 0 || maps.includes(null) ? 'unknown'
				: maps.every((map) => map === 866) ? 'pure_labyrinth' : 'unknown';
		return { scope, intervals: clipped, ...(partial ? { coverage: 'partial' } : {}) };
	}

	/** A context transition closes only its map interval, never the session itself. */
	private observeMap(presenceId: string, mapId: number | null, atMs: number): void {
		if (this.link?.presenceId !== presenceId) return;
		const session = this.options.port.session();
		if (session.sessionId !== this.link.sessionId || !IN_PROGRESS.has(session.status)) return;
		const previous = this.link.mapObservation;
		if (previous?.mapId === mapId) return;
		const intervals = [...(this.link.mapIntervals ?? [])];
		if (previous && atMs > previous.fromMs) intervals.push({ mapId: previous.mapId, fromMs: previous.fromMs, toMs: atMs });
		// Bounded persistence: a very long connection can lose detail, never gain a "pure" claim.
		const overflow = intervals.length > 256;
		this.setLink({ ...this.link, mapIntervals: overflow ? intervals.slice(-256) : intervals,
			mapObservation: { mapId, fromMs: atMs }, mapCoveragePartial: this.link.mapCoveragePartial === true || overflow });
	}

	private finishMap(presenceId: string, atMs: number): void {
		if (this.link?.presenceId !== presenceId || !this.link.mapObservation) return;
		const previous = this.link.mapObservation;
		const intervals = [...(this.link.mapIntervals ?? [])];
		if (atMs > previous.fromMs) intervals.push({ mapId: previous.mapId, fromMs: previous.fromMs, toMs: atMs });
		this.setLink({ ...this.link, mapIntervals: intervals, mapObservation: null });
	}

	dispose(): void {
		this.disposed = true;
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		const next = this.queue.then(async () => {
			if (this.disposed || !this.options.port.enabled()) return;
			try {
				await work();
			} catch (error) {
				this.options.port.recordFailure(error);
			}
		});
		this.queue = next;
		return next;
	}

	private async process(event: IngamePresenceEvent): Promise<void> {
		switch (event.kind) {
			case 'started':
			case 'context':
				await this.ensureLinked(event.presenceId, event.context.character);
				if (event.context.labyrinth) this.tagLabyrinth(event.presenceId, event.atMs);
				this.observeMap(event.presenceId, event.context.state === 'gameplay' ? event.context.mapId : null, event.atMs);
				return;
			case 'restored':
				// Back within the grace: the same session goes on, nothing to open or close.
				await this.ensureLinked(event.presenceId, this.options.presence().context?.character ?? null);
				this.observeMap(event.presenceId, this.options.presence().context?.state === 'gameplay' ? this.options.presence().context?.mapId ?? null : null, event.atMs);
				return;
			case 'lost':
				this.finishMap(event.presenceId, event.lastSeenAtMs);
				if (this.link?.presenceId === event.presenceId) this.setLink({ ...this.link, mapCoveragePartial: true });
				// A short disconnection never cuts the session; the tracker's grace decides.
				return;
			case 'ended':
				this.finishMap(event.presenceId, event.endedAtMs);
				await this.closeAutomatic(event.presenceId, event.endedAtMs);
				return;
		}
	}

	/** Links the presence to the running session, adopting one or opening one, never two. */
	private async ensureLinked(presenceId: string, character: string | null): Promise<void> {
		const session = this.options.port.session();
		if (this.link?.presenceId === presenceId) return;
		// Same session, new presence: a plugin reload or a reconnection after one. Keep the owner.
		if (this.link !== null && session.sessionId === this.link.sessionId && IN_PROGRESS.has(session.status)) {
			this.setLink({ ...this.link, presenceId });
			return;
		}
		if (this.linkedPresences.has(presenceId)) return;
		if (session.sessionId !== null && (session.status === 'starting' || session.status === 'active')) {
			this.setLink({ version: 1, presenceId, sessionId: session.sessionId, owner: 'adopted', labyrinthAt: null, mapCoveragePartial: true });
			return;
		}
		if (!session.canStart) return;
		this.startInFlight = true;
		try {
			const sessionId = await this.options.port.start(character);
			if (sessionId === null) return;
			this.setLink({ version: 1, presenceId, sessionId, owner: 'automatic', labyrinthAt: null, mapCoveragePartial: false });
		} finally {
			this.startInFlight = false;
		}
	}

	/** Tags the linked session while it still runs; a session already stopping is left as it ended. */
	private tagLabyrinth(presenceId: string, atMs: number): void {
		if (this.link?.presenceId !== presenceId || this.link.labyrinthAt !== null) return;
		const session = this.options.port.session();
		if (session.sessionId !== this.link.sessionId || (session.status !== 'starting' && session.status !== 'active')) return;
		this.setLink({ ...this.link, labyrinthAt: new Date(atMs).toISOString() });
	}

	private async closeAutomatic(presenceId: string, endedAtMs: number): Promise<void> {
		const link = this.link;
		if (link?.presenceId !== presenceId || link.owner !== 'automatic') return;
		const session = this.options.port.session();
		// A session the player already stopped, or a different one, is left alone.
		if (session.status !== 'active' || session.sessionId !== link.sessionId) return;
		await this.options.port.stopAt(link.sessionId, endedAtMs);
	}

	private setLink(link: IngameSessionLink): void {
		this.link = link;
		this.linkedPresences.add(link.presenceId);
		this.options.port.saveLink(link);
	}
}

function readLink(port: IngameSessionMarkerPort): IngameSessionLink | null {
	const value: unknown = port.loadLink();
	return isIngameSessionLink(value) ? value : null;
}

export function isIngameSessionLink(value: unknown): value is IngameSessionLink {
	if (typeof value !== 'object' || value === null) return false;
	const link = value as Record<string, unknown>;
	if (link.mapCoveragePartial !== undefined && typeof link.mapCoveragePartial !== 'boolean') return false;
	if (link.mapIntervals !== undefined && (!Array.isArray(link.mapIntervals) || link.mapIntervals.length > 257 ||
		link.mapIntervals.some((interval: unknown) => !validMapInterval(interval)))) return false;
	if (link.mapObservation !== undefined && link.mapObservation !== null) {
		const current = link.mapObservation as Record<string, unknown>;
		if (typeof current !== 'object' || !current || !validMapId(current.mapId) || !Number.isSafeInteger(current.fromMs)) return false;
	}
	return link.version === 1
		&& typeof link.presenceId === 'string' && link.presenceId.length > 0
		&& typeof link.sessionId === 'string' && link.sessionId.length > 0
		&& (link.owner === 'automatic' || link.owner === 'adopted')
		&& (link.labyrinthAt === null || (typeof link.labyrinthAt === 'string' && Number.isFinite(Date.parse(link.labyrinthAt))));
}

function validMapId(value: unknown): boolean {
	return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function validMapInterval(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const interval = value as Record<string, unknown>;
	return validMapId(interval.mapId) && typeof interval.fromMs === 'number' && Number.isSafeInteger(interval.fromMs) &&
		typeof interval.toMs === 'number' && Number.isSafeInteger(interval.toMs) && interval.toMs > interval.fromMs;
}
