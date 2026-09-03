import { createServer, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
	ALERT_INGAME_MAX_MESSAGE_BYTES,
	createAlertIngameServer,
	type AlertIngameNetModule,
	type AlertIngameServerHandle,
} from './alert-ingame-server';

/**
 * Real loopback sockets throughout: this is the module the whole plugin trusts to keep the
 * in-game bridge one-directional, and a fake `net` would only prove the fake behaves.
 * `createAlertIngameServer` (not `startAlertIngameServer`) is used so a fast, deterministic
 * timer can drive the port-retry tests without a real multi-second wait.
 */

/** Port 0 never collides, so this timer's `schedule` is never actually called; it just satisfies the type. */
const UNUSED_RETRY_TIMER = { schedule: () => undefined };

describe('H13.9/H13.15 in-game alert server', () => {
	it('binds loopback only and reports the bound port back', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		try {
			expect(handle.port).toBeGreaterThan(0);
			expect(handle.clientCount()).toBe(0);
		} finally { await handle.close(); }
	});

	it('counts a client as connected as soon as the TCP handshake completes', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		try {
			const client = await connect(handle.port);
			await waitFor(() => handle.clientCount() === 1);
			client.destroy();
			await waitFor(() => handle.clientCount() === 0);
		} finally { await handle.close(); }
	});

	it('reads exactly one hello line, then closes the connection on any further byte', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		try {
			const client = await connect(handle.port);
			const closed = onceClosed(client);
			client.write('{"v":1,"client":"nexus","clientVersion":"0.1.0"}\n');
			client.write('X');
			await closed;
		} finally { await handle.close(); }
	});

	it('closes the connection when hello and an extra byte arrive in the same write', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		try {
			const client = await connect(handle.port);
			const closed = onceClosed(client);
			client.write('{"v":1,"client":"nexus","clientVersion":"0.1.0"}\nX');
			await closed;
		} finally { await handle.close(); }
	});

	it('closes the connection when the hello line exceeds 128 bytes before a newline arrives', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		try {
			const client = await connect(handle.port);
			const closed = onceClosed(client);
			client.write('x'.repeat(200));
			await closed;
		} finally { await handle.close(); }
	});

	it('broadcasts one line, newline-terminated, to every connected client', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		try {
			const a = await connect(handle.port);
			const b = await connect(handle.port);
			const receivedA = onceData(a);
			const receivedB = onceData(b);
			handle.broadcast('{"v":1,"kind":"valuable_loot"}');
			expect(await receivedA).toBe('{"v":1,"kind":"valuable_loot"}\n');
			expect(await receivedB).toBe('{"v":1,"kind":"valuable_loot"}\n');
		} finally { await handle.close(); }
	});

	it('throws instead of sending a line over the 512-byte wire limit', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		try {
			const oversized = 'x'.repeat(ALERT_INGAME_MAX_MESSAGE_BYTES + 1);
			expect(() => { handle.broadcast(oversized); }).toThrow();
		} finally { await handle.close(); }
	});

	it('closes every client socket and stops accepting new ones on close', async () => {
		const handle = await createAlertIngameServer({ createServer }, 0, UNUSED_RETRY_TIMER);
		const client = await connect(handle.port);
		const closed = onceClosed(client);
		await handle.close();
		await closed;
		await expect(connect(handle.port)).rejects.toThrow();
	});

	it('retries a port already occupied, and succeeds once the occupant frees it', async () => {
		const occupant = createServer(() => undefined);
		const occupiedPort = await listenOnFreePort(occupant);
		// A controlled timer, not a real clock: `schedule` parks the retry instead of
		// firing it, so the test decides exactly when the second `.listen()` happens,
		// after the occupant has actually freed the port. A real setTimeout race here
		// would leave the flight's rejection unhandled if both attempts lost the race.
		const parked: { retry: (() => void) | null } = { retry: null };
		const controlledTimer = { schedule: (callback: () => void) => { parked.retry = callback; } };

		const flight = createAlertIngameServer({ createServer }, occupiedPort, controlledTimer, [1, 1, 1]);
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
			const fastTimer = { schedule: (callback: () => void) => { setTimeout(callback, 0); } };
			await expect(createAlertIngameServer({ createServer }, occupiedPort, fastTimer, [1]))
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
		await expect((async () => { handle = await createAlertIngameServer(wrongHost, 0, UNUSED_RETRY_TIMER); })())
			.rejects.toThrow(/loopback/);
		expect(handle).toBeUndefined();
	});
});

function connect(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		socket.once('connect', () => { resolve(socket); });
		socket.once('error', reject);
		socket.connect(port, '127.0.0.1');
	});
}

function onceClosed(socket: Socket): Promise<void> {
	return new Promise((resolve) => { socket.once('close', () => resolve()); });
}

function onceData(socket: Socket): Promise<string> {
	socket.setEncoding('utf8');
	return new Promise((resolve) => { socket.once('data', (chunk: string) => { resolve(chunk); }); });
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

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Condition never became true.');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
