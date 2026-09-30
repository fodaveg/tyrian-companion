import { randomFillSync } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
	ALERT_INGAME_MAX_MESSAGE_BYTES,
	startAlertIngameServer,
	type AlertIngameBridgeOptions,
	type AlertIngameServerHandle,
	type AlertIngameServerTimer,
} from './alert-ingame-server';
import { createNodeTcpServerPort, type NodeTcpServerModule } from '../host/obsidian/obsidian-tcp-server';
import { IngamePresenceTracker, type IngameConnectionEvent, type IngamePresenceEvent } from './alert-ingame-presence';
import { createIngameBridgeNonce, createIngameBridgeSecret, ingameBridgeSecretMatches } from './alert-ingame-protocol';

/**
 * Real loopback sockets throughout: this is the module the whole plugin trusts to authenticate
 * addons and keep a connection that never said hello from counting, and a fake `net` would only
 * prove the fake behaves. The bridge runs over the same `node:net` port Obsidian gets
 * (`createNodeTcpServerPort`), with the timer injected so the hello and liveness deadlines can be
 * driven by short real timers, and the port-retry tests by a controlled one.
 */

const SECRET = createIngameBridgeSecret((bytes) => { randomFillSync(bytes); });

/** Port 0 never collides, so `schedule` below only ever runs the handshake deadlines. */
const REAL_TIMER: AlertIngameServerTimer = {
	schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
	cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

interface Harness {
	readonly handle: AlertIngameServerHandle;
	readonly events: IngameConnectionEvent[];
}

async function startBridge(options: Partial<AlertIngameBridgeOptions> = {}): Promise<Harness> {
	const events: IngameConnectionEvent[] = [];
	const handle = await startAlertIngameServer(createNodeTcpServerPort({ createServer }), 0, REAL_TIMER, {
		authenticate: (candidate) => ingameBridgeSecretMatches(candidate, SECRET),
		now: () => Date.now(),
		fillRandom: (bytes) => { randomFillSync(bytes); },
		onConnectionEvent: (event) => { events.push(event); },
		...options,
	});
	return { handle, events };
}

function helloLine(overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		v: 2, type: 'hello', client: 'nexus', clientVersion: '0.2.0',
		instance: createIngameBridgeNonce((bytes) => { randomFillSync(bytes); }), token: SECRET, ...overrides,
	})}\n`;
}

describe('H18.22 in-game bridge handshake', () => {
	it('does not count a connection that has not said hello, and closes it when the hello deadline passes', async () => {
		const { handle } = await startBridge({ helloTimeoutMs: 80 });
		try {
			const mute = await LineClient.connect(handle.port);
			// Accepted by the kernel and by `net`, but mute: it must not read as a delivery target.
			await delay(20);
			expect(handle.clientCount()).toBe(0);
			expect(() => { handle.broadcast('{"v":2,"type":"alert"}'); }).not.toThrow();
			await mute.closed;
			expect(mute.lines).toEqual(['{"v":2,"type":"error","code":"hello_timeout"}']);
			expect(handle.clientCount()).toBe(0);
		} finally { await handle.close(); }
	});

	it('counts a client only after a valid, authenticated hello, and answers it with a welcome', async () => {
		const { handle, events } = await startBridge();
		try {
			const addon = await LineClient.connect(handle.port);
			addon.write(helloLine({ client: 'blish' }));
			const welcome = JSON.parse(await addon.nextLine()) as Record<string, unknown>;
			expect(Object.keys(welcome).sort()).toEqual(['heartbeatIntervalMs', 'nonce', 'server', 'type', 'v']);
			expect(welcome).toMatchObject({ v: 2, type: 'welcome', heartbeatIntervalMs: 5_000 });
			expect(handle.clientCount()).toBe(1);
			expect(events).toEqual([expect.objectContaining({ kind: 'authenticated', client: 'blish', connectionId: welcome.nonce })]);
			addon.destroy();
			await waitFor(() => handle.clientCount() === 0);
		} finally { await handle.close(); }
	});

	it('rejects a wrong secret with auth_rejected, closes the connection and never counts it', async () => {
		const { handle, events } = await startBridge();
		try {
			const intruder = await LineClient.connect(handle.port);
			intruder.write(helloLine({ token: 'x'.repeat(43) }));
			await intruder.closed;
			expect(intruder.lines).toEqual(['{"v":2,"type":"error","code":"auth_rejected"}']);
			expect(handle.clientCount()).toBe(0);
			expect(events).toEqual([]);
		} finally { await handle.close(); }
	});

	it('rejects every hello when no usable secret is configured, instead of falling back to open', async () => {
		const { handle } = await startBridge({ authenticate: (candidate) => ingameBridgeSecretMatches(candidate, null) });
		try {
			const addon = await LineClient.connect(handle.port);
			addon.write(helloLine());
			await addon.closed;
			expect(addon.lines).toEqual(['{"v":2,"type":"error","code":"auth_rejected"}']);
		} finally { await handle.close(); }
	});

	it('answers a v1 hello with version_unsupported so an old addon can say "update the addon"', async () => {
		const { handle } = await startBridge();
		try {
			const old = await LineClient.connect(handle.port);
			old.write('{"v":1,"client":"nexus","clientVersion":"0.1.0"}\n');
			await old.closed;
			expect(old.lines).toEqual(['{"v":2,"type":"error","code":"version_unsupported"}']);
			expect(handle.clientCount()).toBe(0);
		} finally { await handle.close(); }
	});

	it('closes a connection whose first line grows past 512 bytes before any newline arrives', async () => {
		const { handle } = await startBridge();
		try {
			const client = await LineClient.connect(handle.port);
			client.write('x'.repeat(600));
			await client.closed;
			expect(client.lines).toEqual(['{"v":2,"type":"error","code":"frame_length"}']);
		} finally { await handle.close(); }
	});

	it('accepts a hello terminated with \\r\\n, as a C# WriteLine on Windows sends it', async () => {
		const { handle } = await startBridge();
		try {
			const addon = await LineClient.connect(handle.port);
			addon.write(helloLine({ client: 'blish' }).replace('\n', '\r\n'));
			expect(JSON.parse(await addon.nextLine())).toMatchObject({ type: 'welcome' });
			expect(handle.clientCount()).toBe(1);
		} finally { await handle.close(); }
	});
});

describe('H18.23 in-game bridge, addon to plugin', () => {
	it('reports each sequenced context and ends the connection on a malformed line as lost', async () => {
		const { handle, events } = await startBridge();
		try {
			const addon = await AuthenticatedAddon.open(handle.port);
			addon.send({ type: 'context', state: 'gameplay', mapId: 866, character: 'Astra Uno' });
			await waitFor(() => events.some((event) => event.kind === 'context'));
			expect(events.at(-1)).toMatchObject({
				kind: 'context', connectionId: addon.nonce, context: { state: 'gameplay', mapId: 866, character: 'Astra Uno' },
			});
			addon.client.write('{not json}\n');
			await addon.client.closed;
			expect(addon.client.lines.at(-1)).toBe('{"v":2,"type":"error","code":"frame_json"}');
			expect(events.at(-1)).toMatchObject({ kind: 'closed', connectionId: addon.nonce, reason: 'lost' });
			expect(handle.clientCount()).toBe(0);
		} finally { await handle.close(); }
	});

	it('closes on a sequence gap instead of silently accepting a replayed or spliced stream', async () => {
		const { handle } = await startBridge();
		try {
			const addon = await AuthenticatedAddon.open(handle.port);
			addon.sendRaw({ v: 2, type: 'heartbeat', nonce: addon.nonce, seq: 1 });
			await addon.client.closed;
			expect(addon.client.lines.at(-1)).toBe('{"v":2,"type":"error","code":"sequence_mismatch"}');
		} finally { await handle.close(); }
	});

	it('closes on a frame with an extra key: the addon cannot smuggle a command field in', async () => {
		const { handle } = await startBridge();
		try {
			const addon = await AuthenticatedAddon.open(handle.port);
			addon.sendRaw({ v: 2, type: 'heartbeat', nonce: addon.nonce, seq: 0, command: 'start_session' });
			await addon.client.closed;
			expect(addon.client.lines.at(-1)).toBe('{"v":2,"type":"error","code":"frame_schema"}');
		} finally { await handle.close(); }
	});

	it('settles a bye at once: the connection stops counting and reports its reason', async () => {
		const { handle, events } = await startBridge();
		try {
			const addon = await AuthenticatedAddon.open(handle.port);
			addon.send({ type: 'bye', reason: 'game_exit' });
			await waitFor(() => events.some((event) => event.kind === 'closed'));
			expect(handle.clientCount()).toBe(0);
			expect(events.filter((event) => event.kind === 'closed')).toEqual([
				expect.objectContaining({ connectionId: addon.nonce, reason: 'game_exit' }),
			]);
			await addon.client.closed;
		} finally { await handle.close(); }
	});

	it('declares a silent authenticated connection lost after the liveness timeout', async () => {
		const { handle, events } = await startBridge({ livenessTimeoutMs: 80 });
		try {
			const addon = await AuthenticatedAddon.open(handle.port);
			await addon.client.closed;
			expect(addon.client.lines.at(-1)).toBe('{"v":2,"type":"error","code":"liveness_timeout"}');
			expect(events.at(-1)).toMatchObject({ kind: 'closed', reason: 'lost' });
		} finally { await handle.close(); }
	});
});

describe('H13.9/H13.15 in-game bridge, plugin to addon', () => {
	it('broadcasts one line to every authenticated client and to no pending one', async () => {
		const { handle } = await startBridge();
		try {
			const a = await AuthenticatedAddon.open(handle.port, 'nexus');
			const b = await AuthenticatedAddon.open(handle.port, 'blish');
			const pending = await LineClient.connect(handle.port);
			expect(handle.clientCount()).toBe(2);
			handle.broadcast('{"v":2,"type":"alert","seq":1}');
			expect(await a.client.nextLine()).toBe('{"v":2,"type":"alert","seq":1}');
			expect(await b.client.nextLine()).toBe('{"v":2,"type":"alert","seq":1}');
			await delay(30);
			expect(pending.lines).toEqual([]);
		} finally { await handle.close(); }
	});

	it('throws instead of sending a line over the 512-byte wire limit', async () => {
		const { handle } = await startBridge();
		try {
			const oversized = 'x'.repeat(ALERT_INGAME_MAX_MESSAGE_BYTES + 1);
			expect(() => { handle.broadcast(oversized); }).toThrow();
		} finally { await handle.close(); }
	});

	it('measures the wire limit in UTF-8 bytes, not in string length', async () => {
		const { handle } = await startBridge();
		try {
			const addon = await AuthenticatedAddon.open(handle.port);
			// 'ñ' is two UTF-8 bytes: this line is 257 characters long but 514 bytes on the wire.
			const multibyte = 'ñ'.repeat(ALERT_INGAME_MAX_MESSAGE_BYTES / 2 + 1);
			expect(() => { handle.broadcast(multibyte); }).toThrow();
			// Exactly at the cap in bytes is still one complete line.
			const atCap = 'ñ'.repeat(ALERT_INGAME_MAX_MESSAGE_BYTES / 2);
			handle.broadcast(atCap);
			expect(await addon.client.nextLine()).toBe(atCap);
		} finally { await handle.close(); }
	});

	it('closes every client socket, reports each authenticated one lost, and stops accepting on close', async () => {
		const { handle, events } = await startBridge();
		const addon = await AuthenticatedAddon.open(handle.port);
		const pending = await LineClient.connect(handle.port);
		await handle.close();
		await addon.client.closed;
		await pending.closed;
		expect(events.at(-1)).toMatchObject({ kind: 'closed', connectionId: addon.nonce, reason: 'lost' });
		await expect(LineClient.connect(handle.port)).rejects.toThrow();
	});
});

describe('H18.38 in-game bridge, alert acknowledgement (protocol v3)', () => {
	const alertFor = (alertSeq: number) => (version: 2 | 3): string => `{"v":${String(version)},"type":"alert","seq":${String(alertSeq)}}`;

	it('welcomes a v3 hello in v3, a v2 hello exactly as before, and speaks each its own version', async () => {
		const { handle } = await startBridge();
		try {
			const old = await LineClient.connect(handle.port);
			old.write(helloLine());
			const modern = await LineClient.connect(handle.port);
			modern.write(helloLine({ v: 3 }));
			expect(await old.nextLine()).toMatch(/^\{"v":2,"type":"welcome",/u);
			expect(await modern.nextLine()).toMatch(/^\{"v":3,"type":"welcome",/u);
			const delivery = handle.broadcastAlert(1, alertFor(1));
			expect(await old.nextLine()).toBe('{"v":2,"type":"alert","seq":1}');
			expect(await modern.nextLine()).toBe('{"v":3,"type":"alert","seq":1}');
			expect(delivery).toEqual({ v2Connections: 1, v3Clients: ['nexus'] });
		} finally { await handle.close(); }
	});

	it('answers a v3 addon with the wrong secret with a v3 error, and a v4 hello with the v2 version_unsupported', async () => {
		const { handle } = await startBridge();
		try {
			const wrong = await LineClient.connect(handle.port);
			wrong.write(helloLine({ v: 3, token: 'x'.repeat(40) }));
			await wrong.closed;
			expect(wrong.lines).toEqual(['{"v":3,"type":"error","code":"auth_rejected"}']);
			const future = await LineClient.connect(handle.port);
			future.write(helloLine({ v: 4 }));
			await future.closed;
			expect(future.lines).toEqual(['{"v":2,"type":"error","code":"version_unsupported"}']);
		} finally { await handle.close(); }
	});

	it('reports an ack for an alert sent to that connection, with the host that sent it', async () => {
		const acks: { alertSeq: number; client: string }[] = [];
		const { handle } = await startBridge({ onAlertAck: (ack) => { acks.push({ alertSeq: ack.alertSeq, client: ack.client }); } });
		try {
			const addon = await AuthenticatedAddon.open(handle.port, 'blish', 3);
			handle.broadcastAlert(7, alertFor(7));
			addon.send({ type: 'alert_ack', alertSeq: 7 });
			await waitFor(() => acks.length === 1);
			expect(acks).toEqual([{ alertSeq: 7, client: 'blish' }]);
			expect(handle.clientCount()).toBe(1);
		} finally { await handle.close(); }
	});

	it('ignores, without closing, an ack for an alert that was not sent to that connection', async () => {
		const acks: number[] = [];
		const { handle } = await startBridge({ onAlertAck: (ack) => { acks.push(ack.alertSeq); } });
		try {
			const addon = await AuthenticatedAddon.open(handle.port, 'nexus', 3);
			handle.broadcastAlert(1, alertFor(1));
			addon.send({ type: 'alert_ack', alertSeq: 99 });
			// The following frame proves the connection stayed open and the sequence advanced.
			addon.send({ type: 'alert_ack', alertSeq: 1 });
			await waitFor(() => acks.length === 1);
			expect(acks).toEqual([1]);
			expect(handle.clientCount()).toBe(1);
		} finally { await handle.close(); }
	});

	it('rejects an alert_ack on a v2 connection as unexpected_message, like any unknown type', async () => {
		const { handle } = await startBridge({ onAlertAck: () => { throw new Error('a v2 ack must not be reported'); } });
		try {
			const addon = await AuthenticatedAddon.open(handle.port, 'nexus', 2);
			handle.broadcastAlert(1, alertFor(1));
			addon.send({ type: 'alert_ack', alertSeq: 1 });
			await addon.client.closed;
			expect(addon.client.lines.at(-1)).toBe('{"v":2,"type":"error","code":"unexpected_message"}');
		} finally { await handle.close(); }
	});

	it('closes a connection whose frames carry another version than its hello negotiated', async () => {
		const { handle } = await startBridge();
		try {
			const v3 = await AuthenticatedAddon.open(handle.port, 'nexus', 3);
			v3.sendRaw({ v: 2, type: 'heartbeat', nonce: v3.nonce, seq: 0 });
			await v3.client.closed;
			expect(v3.client.lines.at(-1)).toBe('{"v":3,"type":"error","code":"frame_schema"}');
			const v2 = await AuthenticatedAddon.open(handle.port, 'blish', 2);
			v2.sendRaw({ v: 3, type: 'heartbeat', nonce: v2.nonce, seq: 0 });
			await v2.client.closed;
			expect(v2.client.lines.at(-1)).toBe('{"v":2,"type":"error","code":"frame_schema"}');
		} finally { await handle.close(); }
	});

	it('applies the 512-byte wire limit to each version line', async () => {
		const { handle } = await startBridge();
		try {
			await AuthenticatedAddon.open(handle.port, 'nexus', 3);
			expect(() => handle.broadcastAlert(1, () => 'x'.repeat(513))).toThrow(/512/u);
		} finally { await handle.close(); }
	});
});

describe('H18.23 presence through real sockets', () => {
	it('two addons of the same game produce one presence, and losing one of them changes only the source', async () => {
		const { handle, tracker, presence } = await startTrackedBridge();
		try {
			const nexus = await AuthenticatedAddon.open(handle.port, 'nexus');
			const blish = await AuthenticatedAddon.open(handle.port, 'blish');
			blish.send({ type: 'context', state: 'gameplay', mapId: 15, character: 'Astra Uno' });
			nexus.send({ type: 'context', state: 'gameplay', mapId: 15, character: 'Astra Uno' });
			await waitFor(() => presence.some((event) => event.kind === 'context'));
			expect(presence.filter((event) => event.kind === 'started')).toHaveLength(1);
			expect(tracker.snapshot()).toMatchObject({ status: 'present', connections: 2, context: { source: 'nexus' } });

			nexus.client.destroy();
			await waitFor(() => tracker.snapshot().connections === 1);
			expect(tracker.snapshot()).toMatchObject({ status: 'present', context: { source: 'blish' } });
			expect(presence.map((event) => event.kind)).not.toContain('lost');
		} finally { await handle.close(); tracker.dispose(); }
	});

	it('a dropped connection is a loss with grace, not the end of the game; reconnecting restores the same presence', async () => {
		const { handle, tracker, presence } = await startTrackedBridge();
		try {
			const first = await AuthenticatedAddon.open(handle.port);
			first.send({ type: 'context', state: 'gameplay', mapId: 866, character: 'Astra Uno' });
			await waitFor(() => tracker.snapshot().status === 'present');
			const presenceId = tracker.snapshot().presenceId;

			first.client.destroy();
			await waitFor(() => tracker.snapshot().status === 'lost');
			expect(presence.map((event) => event.kind)).not.toContain('ended');

			const second = await AuthenticatedAddon.open(handle.port);
			await waitFor(() => tracker.snapshot().status === 'present');
			expect(presence.at(-1)).toMatchObject({ kind: 'restored', presenceId });
			second.send({ type: 'context', state: 'gameplay', mapId: 866, character: 'Astra Uno' });
			await delay(20);
			expect(presence.filter((event) => event.kind === 'started')).toHaveLength(1);
		} finally { await handle.close(); tracker.dispose(); }
	});
});

async function startTrackedBridge(): Promise<{
	handle: AlertIngameServerHandle;
	tracker: IngamePresenceTracker;
	presence: IngamePresenceEvent[];
}> {
	const presence: IngamePresenceEvent[] = [];
	const tracker = new IngamePresenceTracker({
		// A grace timer that never fires on its own: these tests watch transitions, not the clock.
		timer: { schedule: () => 'grace', cancel: () => undefined },
		now: () => Date.now(),
		createPresenceId: () => createIngameBridgeNonce((bytes) => { randomFillSync(bytes); }),
		recordObserverFailure: (error) => { throw error; },
	});
	tracker.subscribe((event) => { presence.push(event); });
	const { handle } = await startBridge({ onConnectionEvent: (event) => { tracker.apply(event); } });
	return { handle, tracker, presence };
}

/** An addon that already completed its handshake, numbering its own frames from 0. */
class AuthenticatedAddon {
	private seq = 0;

	private constructor(readonly client: LineClient, readonly nonce: string, private readonly version: 2 | 3) {}

	static async open(port: number, client: 'nexus' | 'blish' = 'nexus', version: 2 | 3 = 2): Promise<AuthenticatedAddon> {
		const socket = await LineClient.connect(port);
		socket.write(helloLine({ client, v: version }));
		const welcome = JSON.parse(await socket.nextLine()) as { nonce: string };
		return new AuthenticatedAddon(socket, welcome.nonce, version);
	}

	send(fields: Record<string, unknown>): void {
		this.sendRaw({ v: this.version, nonce: this.nonce, seq: this.seq, ...fields });
		this.seq += 1;
	}

	sendRaw(frame: Record<string, unknown>): void {
		this.client.write(`${JSON.stringify(frame)}\n`);
	}
}

/** A raw TCP client that splits what it receives into lines, the way an addon's framer does. */
class LineClient {
	readonly lines: string[] = [];
	readonly closed: Promise<void>;
	private buffer = '';
	private waiters: (() => void)[] = [];

	private constructor(private readonly socket: Socket) {
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			this.buffer += chunk;
			let newline = this.buffer.indexOf('\n');
			while (newline !== -1) {
				this.lines.push(this.buffer.slice(0, newline));
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf('\n');
			}
			for (const wake of this.waiters.splice(0)) wake();
		});
		this.closed = new Promise((resolve) => { socket.once('close', () => { resolve(); }); });
	}

	static connect(port: number): Promise<LineClient> {
		return new Promise((resolve, reject) => {
			const socket = new Socket();
			socket.once('connect', () => { resolve(new LineClient(socket)); });
			socket.once('error', reject);
			socket.connect(port, '127.0.0.1');
		});
	}

	private consumed = 0;

	/** The next line not yet returned by a previous call. */
	async nextLine(): Promise<string> {
		const deadline = Date.now() + 2_000;
		while (this.lines.length <= this.consumed) {
			if (Date.now() > deadline) throw new Error('No line arrived.');
			await new Promise<void>((resolve) => { this.waiters.push(resolve); setTimeout(resolve, 20); });
		}
		const line = this.lines[this.consumed] ?? '';
		this.consumed += 1;
		return line;
	}

	write(text: string): void { this.socket.write(text); }

	destroy(): void { this.socket.destroy(); }
}

describe('H13.9/H13.15 in-game alert server binding', () => {
	it('binds loopback only and reports the bound port back', async () => {
		const { handle } = await startBridge();
		try {
			expect(handle.port).toBeGreaterThan(0);
			expect(handle.clientCount()).toBe(0);
		} finally { await handle.close(); }
	});

	it('retries a port already occupied, and succeeds once the occupant frees it', async () => {
		const occupant = createServer(() => undefined);
		const occupiedPort = await listenOnFreePort(occupant);
		// A controlled timer, not a real clock: `schedule` parks the retry instead of
		// firing it, so the test decides exactly when the second `.listen()` happens,
		// after the occupant has actually freed the port. A real setTimeout race here
		// would leave the flight's rejection unhandled if both attempts lost the race.
		const parked: { retry: (() => void) | null } = { retry: null };
		const controlledTimer = { schedule: (callback: () => void) => { parked.retry = callback; }, cancel: () => undefined };

		const flight = startAlertIngameServer(createNodeTcpServerPort({ createServer }), occupiedPort, controlledTimer, bridgeOptions(), [1, 1, 1]);
		await waitFor(() => parked.retry !== null);
		await new Promise<void>((resolve) => occupant.close(() => resolve()));
		const retry = parked.retry;
		parked.retry = null;
		retry?.();

		const handle = await flight;
		try {
			expect(handle.port).toBe(occupiedPort);
		} finally { await handle.close(); }
	});

	it('gives up after exhausting the retry schedule on a port that never frees', async () => {
		const occupant = createServer(() => undefined);
		const occupiedPort = await listenOnFreePort(occupant);
		try {
			const fastTimer = { schedule: (callback: () => void) => { setTimeout(callback, 0); }, cancel: () => undefined };
			await expect(startAlertIngameServer(createNodeTcpServerPort({ createServer }), occupiedPort, fastTimer, bridgeOptions(), [1]))
				.rejects.toMatchObject({ code: 'EADDRINUSE' });
		} finally { await new Promise<void>((resolve) => occupant.close(() => resolve())); }
	});

	/**
	 * Fails closed: a `net` module that ignores the requested host and binds
	 * somewhere other than loopback must never hand back a usable server.
	 */
	it('refuses to hand back a server that did not actually bind loopback', async () => {
		const wrongHost: NodeTcpServerModule = {
			createServer: (listener) => {
				const server = createServer(listener);
				const originalListen = server.listen.bind(server);
				// Simulate a broken/refactored net implementation that binds every
				// interface regardless of the host argument this module passed.
				server.listen = ((...args: unknown[]) => originalListen(args[0] as number)) as typeof server.listen;
				return server;
			},
		};
		let handle: AlertIngameServerHandle | undefined;
		await expect((async () => {
			handle = await startAlertIngameServer(createNodeTcpServerPort(wrongHost), 0, REAL_TIMER, bridgeOptions());
		})())
			.rejects.toThrow(/loopback/);
		expect(handle).toBeUndefined();
	});
});

function bridgeOptions(): AlertIngameBridgeOptions {
	return {
		authenticate: (candidate) => ingameBridgeSecretMatches(candidate, SECRET),
		now: () => Date.now(),
		fillRandom: (bytes) => { randomFillSync(bytes); },
		onConnectionEvent: () => undefined,
	};
}

function listenOnFreePort(server: ReturnType<typeof createServer>): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') { reject(new Error('No port assigned.')); return; }
			resolve(address.port);
		});
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Condition never became true.');
		await delay(5);
	}
}
