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

const IN_PROGRESS: ReadonlySet<SessionStatus> = new Set(['starting', 'active', 'stopping', 'provisional']);

export class IngameSessionMarker {
	private link: IngameSessionLink | null;
	/** Presences already linked to a session once; none of them opens another. */
	private readonly linkedPresences = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(private readonly options: IngameSessionMarkerOptions) {
		this.link = readLink(options.port);
		if (this.link !== null) this.linkedPresences.add(this.link.presenceId);
	}

	/** Feeds one presence event. Events are handled one at a time, in order. */
	handle(event: IngamePresenceEvent): Promise<void> {
		return this.enqueue(() => this.process(event));
	}

	/**
	 * Re-reads the session and the presence: called when the session changes on its own (a finished
	 * one got its summary saved, a recovery ended), so a presence that could not start a session
	 * before can do it now without waiting for the next event from the game.
	 */
	reconcile(): Promise<void> {
		return this.enqueue(async () => {
			const presence = this.options.presence();
			if (presence.status !== 'present' || presence.presenceId === null) return;
			await this.ensureLinked(presence.presenceId, presence.context?.character ?? null);
			if (presence.context?.labyrinth === true) this.tagLabyrinth(presence.presenceId, this.options.now());
		});
	}

	/**
	 * H18.11: the latest instant the game was seen being played, or null. Present right now counts
	 * as now; a presence in its grace counts up to its last evidence.
	 */
	lastPlayEvidenceAt(): number | null {
		const presence = this.options.presence();
		if (presence.status === 'present') return this.options.now();
		if (presence.status === 'lost') return presence.lastSeenAtMs;
		return null;
	}

	/** When the Labyrinth tag was observed for `sessionId`, or null. Read when its note is written. */
	labyrinthObservedAt(sessionId: string): string | null {
		return this.link?.sessionId === sessionId ? this.link.labyrinthAt : null;
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
				return;
			case 'restored':
				// Back within the grace: the same session goes on, nothing to open or close.
				await this.ensureLinked(event.presenceId, this.options.presence().context?.character ?? null);
				return;
			case 'lost':
				// A short disconnection never cuts the session; the tracker's grace decides.
				return;
			case 'ended':
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
			this.setLink({ version: 1, presenceId, sessionId: session.sessionId, owner: 'adopted', labyrinthAt: null });
			return;
		}
		if (!session.canStart) return;
		const sessionId = await this.options.port.start(character);
		if (sessionId === null) return;
		this.setLink({ version: 1, presenceId, sessionId, owner: 'automatic', labyrinthAt: null });
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
	return link.version === 1
		&& typeof link.presenceId === 'string' && link.presenceId.length > 0
		&& typeof link.sessionId === 'string' && link.sessionId.length > 0
		&& (link.owner === 'automatic' || link.owner === 'adopted')
		&& (link.labyrinthAt === null || (typeof link.labyrinthAt === 'string' && Number.isFinite(Date.parse(link.labyrinthAt))));
}
