import { describe, expect, it } from 'vitest';

import { LiveSourceConnections, liveSourceReliefAt } from './live-source-connections';

const LINKED = 'AQEBAQEBAQEBAQEBAQEBAQ';
const OTHER = 'AwMDAwMDAwMDAwMDAwMDAw';
const AT = Date.parse('2026-10-07T14:54:00.000Z');
const active = { phase: 'active' as const, sourceInstance: LINKED, epoch: 'AgICAgICAgICAgICAgICAg', lastSourceDisconnectedAt: null };

function connect(connections: LiveSourceConnections, connectionId: string, instance: string, client: 'nexus' | 'blish' = 'nexus'): void {
	connections.apply({ kind: 'authenticated', connectionId, client, instance, atMs: AT });
}
function close(connections: LiveSourceConnections, connectionId: string, atMs: number): void {
	connections.apply({ kind: 'closed', connectionId, atMs, lastSeenAtMs: atMs, reason: 'lost' });
}

describe('relief of a live producer that is gone (SPEC-live-loot §2, rule of 7 Oct 2026)', () => {
	it('a producer this host saw disconnect can be relieved, from the instant its last connection closed', () => {
		const connections = new LiveSourceConnections();
		connect(connections, 'a', LINKED);
		expect(liveSourceReliefAt(active, OTHER, connections)).toBeNull();
		close(connections, 'a', AT + 2000);
		expect(liveSourceReliefAt(active, OTHER, connections)).toBe(AT + 2000);
	});

	it('a producer that still holds a connection is never relieved', () => {
		const connections = new LiveSourceConnections();
		connect(connections, 'a', LINKED); connect(connections, 'a2', LINKED);
		close(connections, 'a', AT + 2000);
		expect(liveSourceReliefAt(active, OTHER, connections)).toBeNull();
		close(connections, 'a2', AT + 3000);
		expect(liveSourceReliefAt(active, OTHER, connections)).toBe(AT + 3000);
		// It came back: what closed before no longer says it is gone.
		connect(connections, 'a3', LINKED);
		expect(liveSourceReliefAt(active, OTHER, connections)).toBeNull();
	});

	it('never infers a disconnection it did not see', () => {
		const connections = new LiveSourceConnections();
		// Nothing seen at all: a host that restarted knows only what the stored record says.
		expect(liveSourceReliefAt(active, OTHER, connections)).toBeNull();
		// Blish HUD is not a live producer, even under the linked instance's name.
		connect(connections, 'b', LINKED, 'blish'); close(connections, 'b', AT + 1000);
		expect(liveSourceReliefAt(active, OTHER, connections)).toBeNull();
		// A close for a connection that never authenticated here.
		close(connections, 'unknown', AT + 1000);
		expect(liveSourceReliefAt(active, OTHER, connections)).toBeNull();
	});

	it('keeps the written ground as it was, and relieves nobody outside an active session with another producer', () => {
		const connections = new LiveSourceConnections();
		const written = { ...active, epoch: null, lastSourceDisconnectedAt: new Date(AT + 500).toISOString() };
		expect(liveSourceReliefAt(written, OTHER, connections)).toBe(AT + 500);
		connect(connections, 'a', LINKED); close(connections, 'a', AT + 2000);
		// The same instance reconnecting is not a relief, and neither is a session with no producer or already closed.
		expect(liveSourceReliefAt(active, LINKED, connections)).toBeNull();
		expect(liveSourceReliefAt({ ...active, sourceInstance: null }, OTHER, connections)).toBeNull();
		expect(liveSourceReliefAt({ ...active, phase: 'complete' }, OTHER, connections)).toBeNull();
	});

	it('a written disconnection does not relieve a producer that came back and holds a connection', () => {
		const connections = new LiveSourceConnections();
		const written = { ...active, epoch: null, lastSourceDisconnectedAt: new Date(AT + 500).toISOString() };
		connect(connections, 'a', LINKED); close(connections, 'a', AT + 500);
		expect(liveSourceReliefAt(written, OTHER, connections)).toBe(AT + 500);
		// Authenticated again and not yet at its `live_open`: the record still says it left.
		connect(connections, 'a2', LINKED);
		expect(liveSourceReliefAt(written, OTHER, connections)).toBeNull();
		close(connections, 'a2', AT + 3000);
		expect(liveSourceReliefAt(written, OTHER, connections)).toBe(AT + 500);
		// A host that restarted has seen no connection at all, and what is written decides alone.
		expect(liveSourceReliefAt(written, OTHER, new LiveSourceConnections())).toBe(AT + 500);
	});

	it('remembers a bounded number of producers that left', () => {
		const connections = new LiveSourceConnections();
		connect(connections, 'a', LINKED); close(connections, 'a', AT);
		for (let index = 0; index < 16; index += 1) { connect(connections, `c${String(index)}`, `instance-${String(index)}`); close(connections, `c${String(index)}`, AT); }
		expect(connections.disconnectedAt(LINKED)).toBeNull();
		expect(connections.disconnectedAt('instance-15')).toBe(AT);
	});
});
