// Bare specifier, not `node:net`: esbuild.config.mjs externalizes every Node builtin by its bare
// name (`node:module`'s `builtinModules`, which does not include the prefixed form), and this is
// the only module in `src/` that reaches for one, so the bundle step is what catches a mismatch.
import { createServer, type Server, type Socket } from 'net';

import { ALERT_INGAME_MAX_HELLO_BYTES, ALERT_INGAME_MAX_MESSAGE_BYTES } from './alert-ingame';

export { ALERT_INGAME_MAX_HELLO_BYTES, ALERT_INGAME_MAX_MESSAGE_BYTES };

/**
 * The one module allowed to open `node:net`. `src/security-boundary.test.ts` censuses it by name.
 *
 * `docs/SPEC-puente-ingame.md` fixes the shape: one TCP server, loopback only, N clients, a line
 * framer on `\n`. The direction is fixed structurally, not by convention: `broadcast` is the only
 * way data leaves this module towards a client, and a connection is read exactly once, for its
 * `hello`, after which any further byte closes it. There is no path from a client's bytes back into
 * a broadcast; an addon that tried to smuggle a command in would just be disconnected.
 *
 * `src/platform/` (H8's link-layer helper) is not imported. This framer is a new ~60-line one, not
 * a reuse of H8's own record framer: importing from there would drag this channel into H8's
 * census and threat model over a shared line-splitting idea neither module needs the other for.
 */

/** Loopback only. Not a parameter: a caller cannot ask this module to bind anywhere else. */
const BIND_HOST = '127.0.0.1';

/** H8's reconnect table, reused here for port-occupied retries rather than a fresh guess. */
export const ALERT_INGAME_PORT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 5_000];

export interface AlertIngameServerHandle {
	readonly port: number;
	/** Sockets that have completed the TCP handshake, whether or not their `hello` line has arrived yet. */
	clientCount(): number;
	/**
	 * Sends one line to every connected client. Throws rather than truncating when the composed
	 * line, plus its terminator, would exceed the wire contract's 512-byte cap: an addon's framer
	 * only ever expects a complete line, so a caller here must fail the delivery instead of handing
	 * out a line no addon parser was built to receive.
	 */
	broadcast(line: string): void;
	close(): Promise<void>;
}

export interface AlertIngameServerTimer {
	schedule(callback: () => void, milliseconds: number): unknown;
}

/**
 * Starts the loopback server used in production, injecting the real `node:net`.
 *
 * `timer` has no default here, the same way `postAlertWebhook`'s does not: the caller (`main.ts`)
 * owns the one place a real `setTimeout` is reached for, through `window.setTimeout`, for popout
 * window compatibility. Tests reach for `createAlertIngameServer` instead, with a fake `net` module.
 */
export async function startAlertIngameServer(
	port: number,
	timer: AlertIngameServerTimer,
	retryDelaysMs: readonly number[] = ALERT_INGAME_PORT_RETRY_DELAYS_MS,
): Promise<AlertIngameServerHandle> {
	return await createAlertIngameServer({ createServer }, port, timer, retryDelaysMs);
}

export interface AlertIngameNetModule {
	createServer(connectionListener: (socket: Socket) => void): Server;
}

/**
 * Builds and binds the server. `net` and `timer` are injected so a unit test can exercise the
 * port-occupied retry and the loopback-only guarantee without a real socket or a real clock.
 */
export async function createAlertIngameServer(
	net: AlertIngameNetModule,
	port: number,
	timer: AlertIngameServerTimer,
	retryDelaysMs: readonly number[] = ALERT_INGAME_PORT_RETRY_DELAYS_MS,
): Promise<AlertIngameServerHandle> {
	const clients = new Set<Socket>();
	const server = net.createServer((socket) => { attachClient(socket, clients); });

	try {
		await listenWithRetry(server, port, timer, retryDelaysMs);
	} catch (error) {
		server.close();
		throw error;
	}

	// Fails closed: a `net` implementation that silently bound somewhere other than
	// loopback (a broken host, a future refactor that adds a host parameter) does
	// not get to hand back a working server. This is the check that turns "we only
	// ever call `.listen(port, '127.0.0.1')`" into something a test can break.
	const address = server.address();
	if (address === null || typeof address === 'string' || address.address !== BIND_HOST) {
		server.close();
		for (const socket of clients) socket.destroy();
		throw new Error('The in-game alert server refused to bind to loopback only.');
	}

	return {
		port: address.port,
		clientCount: () => clients.size,
		broadcast: (line) => { broadcastLine(clients, line); },
		close: () => new Promise((resolve) => {
			for (const socket of clients) socket.destroy();
			clients.clear();
			server.close(() => resolve());
		}),
	};
}

/**
 * Binds `port` on loopback, retrying on `EADDRINUSE` with the given backoff. A server can be
 * `.listen()`ed again on the same instance after such an error; every other error rejects at once.
 */
function listenWithRetry(
	server: Server, port: number, timer: AlertIngameServerTimer, retryDelaysMs: readonly number[],
): Promise<void> {
	return new Promise((resolve, reject) => {
		let attempt = 0;
		const tryListen = (): void => {
			const onError = (error: NodeJS.ErrnoException): void => {
				server.removeListener('listening', onListening);
				if (error.code === 'EADDRINUSE' && attempt < retryDelaysMs.length) {
					const delayMs = retryDelaysMs[attempt];
					attempt += 1;
					timer.schedule(tryListen, delayMs ?? 0);
					return;
				}
				reject(error);
			};
			const onListening = (): void => {
				server.removeListener('error', onError);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, BIND_HOST);
		};
		tryListen();
	});
}

function broadcastLine(clients: ReadonlySet<Socket>, line: string): void {
	if (Buffer.byteLength(line, 'utf8') > ALERT_INGAME_MAX_MESSAGE_BYTES) {
		throw new Error(`In-game alert line exceeds the ${String(ALERT_INGAME_MAX_MESSAGE_BYTES)}-byte wire limit.`);
	}
	const frame = `${line}\n`;
	for (const socket of clients) socket.write(frame);
}

/**
 * Reads exactly one line from a fresh connection — the addon's `hello` — then stops reading.
 *
 * `helloRead` is the whole one-direction guarantee at the socket level: once it flips, the very
 * next `data` event, whatever it carries, destroys the connection instead of being buffered,
 * parsed or acted on. An oversized line before the newline arrives destroys it the same way,
 * so a client cannot hold the buffer open indefinitely by never sending `\n`.
 */
function attachClient(socket: Socket, clients: Set<Socket>): void {
	clients.add(socket);
	socket.setEncoding('utf8');
	let buffer = '';
	let helloRead = false;

	socket.on('data', (chunk: string) => {
		if (helloRead) { socket.destroy(); return; }
		buffer += chunk;
		const newlineIndex = buffer.indexOf('\n');
		if (newlineIndex === -1) {
			if (Buffer.byteLength(buffer, 'utf8') > ALERT_INGAME_MAX_HELLO_BYTES) socket.destroy();
			return;
		}
		const line = buffer.slice(0, newlineIndex);
		const rest = buffer.slice(newlineIndex + 1);
		if (Buffer.byteLength(line, 'utf8') > ALERT_INGAME_MAX_HELLO_BYTES) { socket.destroy(); return; }
		helloRead = true;
		if (rest.length > 0) socket.destroy();
	});
	socket.on('close', () => { clients.delete(socket); });
	socket.on('error', () => { clients.delete(socket); });
}
