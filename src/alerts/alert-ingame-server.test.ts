import { randomFillSync } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
	ALERT_INGAME_MAX_MESSAGE_BYTES,
	createAlertIngameServer,
	type AlertIngameBridgeOptions,
	type AlertIngameNetModule,
	type AlertIngameServerHandle,
	type AlertIngameServerTimer,
} from './alert-ingame-server';
import { IngamePresenceTracker, type IngameConnectionEvent, type IngamePresenceEvent } from './alert-ingame-presence';
import { createIngameBridgeNonce, createIngameBridgeSecret, ingameBridgeSecretMatches } from './alert-ingame-protocol';

/**
 * Real loopback sockets throughout: this is the module the whole plugin trusts to authenticate
 * addons and keep a connection that never said hello from counting, and a fake `net` would only
 * prove the fake behaves. `createAlertIngameServer` is used so the hello and liveness deadlines
 * can be driven by short real timers, and the port-retry tests by a controlled one.
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
	const handle = await createAlertIngameServer({ createServer }, 0, REAL_TIMER, {
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

	private constructor(readonly client: LineClient, readonly nonce: string) {}

	static async open(port: number, client: 'nexus' | 'blish' = 'nexus'): Promise<AuthenticatedAddon> {
		const socket = await LineClient.connect(port);
		socket.write(helloLine({ client }));
		const welcome = JSON.parse(await socket.nextLine()) as { nonce: string };
		return new AuthenticatedAddon(socket, welcome.nonce);
	}

	send(fields: Record<string, unknown>): void {
		this.sendRaw({ v: 2, nonce: this.nonce, seq: this.seq, ...fields });
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

		const flight = createAlertIngameServer({ createServer }, occupiedPort, controlledTimer, bridgeOptions(), [1, 1, 1]);
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
			await expect(createAlertIngameServer({ createServer }, occupiedPort, fastTimer, bridgeOptions(), [1]))
				.rejects.toMatchObject({ code: 'EADDRINUSE' });
		} finally { await new Promise<void>((resolve) => occupant.close(() => resolve())); }
	});

	/**
	 * Fails closed: a `net` module that ignores the requested host and binds
	 * somewhere other than loopback must never hand back a usable server.
	 */
	it('refuses to hand back a server that did not actually bind loopback', async () => {
		const wrongHost: AlertIngameNetModule = {
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
		await expect((async () => { handle = await createAlertIngameServer(wrongHost, 0, REAL_TIMER, bridgeOptions()); })())
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
