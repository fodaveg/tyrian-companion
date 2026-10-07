import type { IngameConnectionEvent } from '../alerts/alert-ingame-presence';
import type { LiveSessionRuntimeRecord } from './live-session-model';

/** Producers remembered as gone; a bound, not a history. */
const REMEMBERED_INSTANCES = 16;

/**
 * Which live producers hold a bridge connection right now, as this host saw it. Memory only.
 *
 * It exists for one decision (SPEC-live-loot §2, rule added on 7 Oct 2026): a producer linked to
 * the active session whose connection this host SAW close can be relieved by another instance even
 * when storage was down and the disconnection could not be written. It never says a producer is
 * gone unless a connection of that instance was open here and closed, and while any connection of
 * that instance is still open it says only that the producer is here.
 */
export class LiveSourceConnections {
	/** Open Nexus connections: connection id to the `instance` of its hello. */
	private readonly open = new Map<string, string>();
	/** When the last connection of an instance closed, for the instances that hold none now. */
	private readonly closedAt = new Map<string, number>();

	apply(event: IngameConnectionEvent): void {
		if (event.kind === 'authenticated') {
			// Only Nexus can be a live source; Blish HUD's connections say nothing about one.
			if (event.client !== 'nexus') return;
			this.open.set(event.connectionId, event.instance);
			this.closedAt.delete(event.instance);
			return;
		}
		if (event.kind !== 'closed') return;
		const instance = this.open.get(event.connectionId);
		if (instance === undefined) return;
		this.open.delete(event.connectionId);
		for (const connected of this.open.values()) if (connected === instance) return;
		this.closedAt.delete(instance);
		this.closedAt.set(instance, event.atMs);
		if (this.closedAt.size > REMEMBERED_INSTANCES) this.closedAt.delete(this.closedAt.keys().next().value!);
	}

	/** When this host saw the instance's last connection close; null while it is connected or was never seen. */
	disconnectedAt(instance: string): number | null {
		return this.closedAt.get(instance) ?? null;
	}

	/** Whether the instance holds a connection this host has open now. False for one it never saw, as after a restart. */
	connected(instance: string): boolean {
		for (const open of this.open.values()) if (open === instance) return true;
		return false;
	}
}

/**
 * Whether `candidate` may relieve the producer linked to an active session, as the instant that
 * producer was last connected (where the session is closed), or null while it may not.
 *
 * Two grounds, either one enough:
 * - written: the stored record says the producer's epoch ended and it disconnected;
 * - seen: this host saw the producer's last connection close and it holds none now, whatever
 *   storage managed to write about it.
 *
 * A linked producer that is still connected is never relieved: that stays `source_conflict`. This
 * comes before both grounds, the written one too: a producer written as gone may have come back and
 * be authenticated without having sent its `live_open`, and the record still says it left. A host
 * that restarted has no connection on its list, so there what is written decides alone.
 */
export function liveSourceReliefAt(
	record: Pick<LiveSessionRuntimeRecord, 'phase' | 'sourceInstance' | 'epoch' | 'lastSourceDisconnectedAt'>,
	candidate: string,
	connections: LiveSourceConnections,
): number | null {
	if (record.phase !== 'active' || record.sourceInstance === null || record.sourceInstance === candidate) return null;
	if (connections.connected(record.sourceInstance)) return null;
	if (record.epoch === null && record.lastSourceDisconnectedAt !== null) return Date.parse(record.lastSourceDisconnectedAt);
	return connections.disconnectedAt(record.sourceInstance);
}
