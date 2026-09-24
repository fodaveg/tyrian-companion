// Bare specifier, not `node:net`: esbuild.config.mjs externalizes every Node builtin by its bare
// name (`node:module`'s `builtinModules`, which does not include the prefixed form), and this is
// the only module in `src/` that reaches for one, so the bundle step is what catches a mismatch.
import { createServer, type Server, type Socket } from 'net';

import { ALERT_INGAME_MAX_MESSAGE_BYTES } from './alert-ingame';
import type { IngameConnectionEvent } from './alert-ingame-presence';
import {
	INGAME_BRIDGE_HELLO_TIMEOUT_MS,
	INGAME_BRIDGE_LIVENESS_TIMEOUT_MS,
	INGAME_BRIDGE_MAX_AUTHENTICATED_CONNECTIONS,
	INGAME_BRIDGE_MAX_LINE_BYTES,
	INGAME_BRIDGE_MAX_PENDING_CONNECTIONS,
	createIngameBridgeNonce,
	decodeIngameFrame,
	ingameErrorLine,
	ingameWelcomeLine,
	parseIngameHello,
	parseIngameSequenced,
	type IngameBridgeErrorCode,
	type IngameByeReason,
} from './alert-ingame-protocol';

export { ALERT_INGAME_MAX_MESSAGE_BYTES };

/**
 * The one module allowed to open `node:net`. `src/security-boundary.test.ts` censuses it by name.
 *
 * `docs/SPEC-puente-ingame.md` fixes the shape: one TCP server, loopback only, N clients, a line
 * framer on `\n`, protocol v2 (`alert-ingame-protocol.ts`). Since H18.23 the channel carries data
 * both ways, so every connection must first authenticate: a valid `hello` with the shared secret,
 * within `INGAME_BRIDGE_HELLO_TIMEOUT_MS`. Until then a connection is pending: it is not counted,
 * it receives no alert, and it is closed when the deadline passes (H18.22). After the `welcome`,
 * the only thing an addon can send is a closed, sequenced report of the game context; nothing it
 * sends reaches an alert, a command or the account. The report goes out through
 * `onConnectionEvent` and nowhere else.
 *
 * `src/platform/` (H8's link-layer helper) is not imported: its discipline (nonce, sequence, a
 * 512-byte cap, exact keys) is re-stated in `alert-ingame-protocol.ts`, not shared, so this channel
 * stays out of H8's census and threat model.
 */

/** Loopback only. Not a parameter: a caller cannot ask this module to bind anywhere else. */
const BIND_HOST = '127.0.0.1';

/** H8's reconnect table, reused here for port-occupied retries rather than a fresh guess. */
export const ALERT_INGAME_PORT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 5_000];

export interface AlertIngameServerHandle {
	readonly port: number;
	/**
	 * Connections that completed a valid, authenticated `hello`. A socket that connected and said
	 * nothing, or said something invalid, is never counted: counting it is what used to let the
	 * emitter report `ingame` as delivered to nobody (H18.22).
	 */
	clientCount(): number;
	/**
	 * Sends one line to every authenticated client. Throws rather than truncating when the composed
	 * line, plus its terminator, would exceed the wire contract's 512-byte cap: an addon's framer
	 * only ever expects a complete line, so a caller here must fail the delivery instead of handing
	 * out a line no addon parser was built to receive.
	 */
	broadcast(line: string): void;
	close(): Promise<void>;
}

export interface AlertIngameServerTimer {
	schedule(callback: () => void, milliseconds: number): unknown;
	cancel(handle: unknown): void;
}

/** Everything the bridge needs besides a socket; `main.ts` owns each capability. */
export interface AlertIngameBridgeOptions {
	/**
	 * Decides whether a `hello`'s candidate secret is the configured one. The caller reads the
	 * secret ephemerally and compares in constant time; this module never sees the expected value.
	 */
	authenticate(candidate: string): boolean;
	now(): number;
	fillRandom(bytes: Uint8Array): void;
	onConnectionEvent(event: IngameConnectionEvent): void;
	readonly helloTimeoutMs?: number;
	readonly livenessTimeoutMs?: number;
}

/**
 * Starts the loopback server used in production, injecting the real `node:net`.
 *
 * `timer` has no default here, the same way `postAlertWebhook`'s does not: the caller (`main.ts`)
 * owns the one place a real `setTimeout` is reached for, through `window.setTimeout`, for popout
 * window compatibility. Tests reach for `createAlertIngameServer` instead.
 */
export async function startAlertIngameServer(
	port: number,
	timer: AlertIngameServerTimer,
	bridge: AlertIngameBridgeOptions,
	retryDelaysMs: readonly number[] = ALERT_INGAME_PORT_RETRY_DELAYS_MS,
): Promise<AlertIngameServerHandle> {
	return await createAlertIngameServer({ createServer }, port, timer, bridge, retryDelaysMs);
}

export interface AlertIngameNetModule {
	createServer(connectionListener: (socket: Socket) => void): Server;
}

type ConnectionPhase = 'awaiting_hello' | 'authenticated' | 'closed';

interface BridgeConnection {
	readonly socket: Socket;
	phase: ConnectionPhase;
	buffered: Buffer;
	nonce: string | null;
	nextSeq: number;
	lastSeenAtMs: number;
	deadline: unknown;
	endReason: 'lost' | IngameByeReason;
}

interface BridgeRuntime {
	readonly timer: AlertIngameServerTimer;
	readonly bridge: AlertIngameBridgeOptions;
	readonly serverInstance: string;
	readonly pending: Set<BridgeConnection>;
	readonly authenticated: Set<BridgeConnection>;
}

/**
 * Builds and binds the server. `net`, `timer` and `bridge` are injected so a unit test can exercise
 * the port-occupied retry, the loopback-only guarantee and every handshake deadline without a real
 * clock; the sockets themselves stay real in the tests.
 */
export async function createAlertIngameServer(
	net: AlertIngameNetModule,
	port: number,
	timer: AlertIngameServerTimer,
	bridge: AlertIngameBridgeOptions,
	retryDelaysMs: readonly number[] = ALERT_INGAME_PORT_RETRY_DELAYS_MS,
): Promise<AlertIngameServerHandle> {
	const runtime: BridgeRuntime = {
		timer, bridge,
		serverInstance: createIngameBridgeNonce((bytes) => { bridge.fillRandom(bytes); }),
		pending: new Set(), authenticated: new Set(),
	};
	const server = net.createServer((socket) => { attachClient(socket, runtime); });

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
		for (const connection of [...runtime.pending, ...runtime.authenticated]) connection.socket.destroy();
		throw new Error('The in-game alert server refused to bind to loopback only.');
	}

	return {
		port: address.port,
		clientCount: () => runtime.authenticated.size,
		broadcast: (line) => { broadcastLine(runtime.authenticated, line); },
		close: () => new Promise((resolve) => {
			for (const connection of [...runtime.pending, ...runtime.authenticated]) connection.socket.destroy();
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

function broadcastLine(clients: ReadonlySet<BridgeConnection>, line: string): void {
	if (Buffer.byteLength(line, 'utf8') > ALERT_INGAME_MAX_MESSAGE_BYTES) {
		throw new Error(`In-game alert line exceeds the ${String(ALERT_INGAME_MAX_MESSAGE_BYTES)}-byte wire limit.`);
	}
	const frame = `${line}\n`;
	for (const connection of clients) connection.socket.write(frame);
}

/**
 * Registers a fresh connection as pending and arms its hello deadline. Over the pending cap it is
 * dropped at once, without an answer: a local process opening sockets in a loop gets nothing back.
 */
function attachClient(socket: Socket, runtime: BridgeRuntime): void {
	if (runtime.pending.size >= INGAME_BRIDGE_MAX_PENDING_CONNECTIONS) { socket.destroy(); return; }
	const connection: BridgeConnection = {
		socket, phase: 'awaiting_hello', buffered: Buffer.alloc(0), nonce: null, nextSeq: 0,
		lastSeenAtMs: runtime.bridge.now(), deadline: null, endReason: 'lost',
	};
	runtime.pending.add(connection);
	armDeadline(connection, runtime, runtime.bridge.helloTimeoutMs ?? INGAME_BRIDGE_HELLO_TIMEOUT_MS, 'hello_timeout');

	socket.on('data', (chunk: Buffer) => { receive(connection, runtime, chunk); });
	socket.on('close', () => { settleClosed(connection, runtime); });
	socket.on('error', () => { settleClosed(connection, runtime); });
}

/**
 * Splits whatever arrived into `\n`-terminated frames and handles them in order. A frame longer
 * than the cap, complete or still growing, rejects the connection, so a client cannot hold the
 * buffer open by never sending a newline.
 */
function receive(connection: BridgeConnection, runtime: BridgeRuntime, chunk: Buffer): void {
	if (isClosed(connection)) return;
	connection.buffered = Buffer.concat([connection.buffered, chunk]);
	// Re-read on every turn: handling one frame may reject, or accept a `bye`, and close it.
	while (!isClosed(connection)) {
		const newline = connection.buffered.indexOf(0x0a);
		if (newline === -1) {
			// One extra byte of slack for the `\r` a Windows writer may put before the `\n`.
			if (connection.buffered.byteLength > INGAME_BRIDGE_MAX_LINE_BYTES + 1) reject(connection, runtime, 'frame_length');
			return;
		}
		const frame = connection.buffered.subarray(0, newline);
		connection.buffered = connection.buffered.subarray(newline + 1);
		handleFrame(connection, runtime, frame);
	}
}

function handleFrame(connection: BridgeConnection, runtime: BridgeRuntime, frame: Buffer): void {
	const decoded = decodeIngameFrame(frame);
	if (!decoded.ok) { reject(connection, runtime, decoded.code); return; }
	if (connection.phase === 'awaiting_hello') { handleHello(connection, runtime, decoded.value); return; }
	const nonce = connection.nonce;
	if (nonce === null) { reject(connection, runtime, 'unexpected_message'); return; }
	const message = parseIngameSequenced(decoded.value, { nonce, seq: connection.nextSeq });
	if (!message.ok) { reject(connection, runtime, message.code); return; }
	connection.nextSeq += 1;
	connection.lastSeenAtMs = runtime.bridge.now();
	armDeadline(connection, runtime, runtime.bridge.livenessTimeoutMs ?? INGAME_BRIDGE_LIVENESS_TIMEOUT_MS, 'liveness_timeout');
	if (message.value.type === 'context') {
		const { state, mapId, character } = message.value;
		runtime.bridge.onConnectionEvent({
			kind: 'context', connectionId: nonce, context: { state, mapId, character }, atMs: connection.lastSeenAtMs,
		});
		return;
	}
	if (message.value.type === 'bye') {
		// Settled here rather than on the socket's `close`: the goodbye is the evidence, and the
		// connection stops counting the moment the addon says it is leaving.
		connection.endReason = message.value.reason;
		connection.phase = 'closed';
		cancelDeadline(connection, runtime);
		runtime.authenticated.delete(connection);
		emitClosed(connection, runtime);
		connection.socket.end();
	}
}

/**
 * Authenticates the first frame. The order of the checks is the order of what an attacker learns:
 * shape first (no secret involved), then the secret, then capacity, so a wrong secret and a full
 * server answer differently only to a client that already knows the secret.
 */
function handleHello(connection: BridgeConnection, runtime: BridgeRuntime, record: Record<string, unknown>): void {
	const hello = parseIngameHello(record);
	if (!hello.ok) { reject(connection, runtime, hello.code); return; }
	if (!runtime.bridge.authenticate(hello.value.token)) { reject(connection, runtime, 'auth_rejected'); return; }
	if (runtime.authenticated.size >= INGAME_BRIDGE_MAX_AUTHENTICATED_CONNECTIONS) { reject(connection, runtime, 'capacity'); return; }

	const nonce = createIngameBridgeNonce((bytes) => { runtime.bridge.fillRandom(bytes); });
	runtime.pending.delete(connection);
	runtime.authenticated.add(connection);
	connection.phase = 'authenticated';
	connection.nonce = nonce;
	connection.nextSeq = 0;
	connection.lastSeenAtMs = runtime.bridge.now();
	connection.socket.write(`${ingameWelcomeLine(runtime.serverInstance, nonce)}\n`);
	armDeadline(connection, runtime, runtime.bridge.livenessTimeoutMs ?? INGAME_BRIDGE_LIVENESS_TIMEOUT_MS, 'liveness_timeout');
	runtime.bridge.onConnectionEvent({
		kind: 'authenticated', connectionId: nonce, client: hello.value.client,
		instance: hello.value.instance, atMs: connection.lastSeenAtMs,
	});
}

/**
 * Ends a connection that broke the contract: one `error` line carrying only the code, then close.
 * It leaves both counted sets at once, so `clientCount` never reports a connection being torn down.
 */
function reject(connection: BridgeConnection, runtime: BridgeRuntime, code: IngameBridgeErrorCode): void {
	if (connection.phase === 'closed') return;
	const wasAuthenticated = connection.phase === 'authenticated';
	connection.phase = 'closed';
	cancelDeadline(connection, runtime);
	runtime.pending.delete(connection);
	runtime.authenticated.delete(connection);
	connection.buffered = Buffer.alloc(0);
	connection.socket.end(`${ingameErrorLine(code)}\n`);
	connection.socket.destroySoon();
	if (wasAuthenticated) emitClosed(connection, runtime);
}

/** The socket is gone, whichever way. Idempotent: `close` follows `error`, and `reject` may have run. */
function settleClosed(connection: BridgeConnection, runtime: BridgeRuntime): void {
	cancelDeadline(connection, runtime);
	runtime.pending.delete(connection);
	const wasAuthenticated = runtime.authenticated.delete(connection);
	connection.phase = 'closed';
	if (wasAuthenticated) emitClosed(connection, runtime);
}

function emitClosed(connection: BridgeConnection, runtime: BridgeRuntime): void {
	if (connection.nonce === null) return;
	runtime.bridge.onConnectionEvent({
		kind: 'closed', connectionId: connection.nonce, atMs: runtime.bridge.now(),
		lastSeenAtMs: connection.lastSeenAtMs, reason: connection.endReason,
	});
}

function isClosed(connection: BridgeConnection): boolean {
	return connection.phase === 'closed';
}

function armDeadline(
	connection: BridgeConnection, runtime: BridgeRuntime, milliseconds: number, code: IngameBridgeErrorCode,
): void {
	cancelDeadline(connection, runtime);
	connection.deadline = runtime.timer.schedule(() => {
		connection.deadline = null;
		reject(connection, runtime, code);
	}, milliseconds);
}

function cancelDeadline(connection: BridgeConnection, runtime: BridgeRuntime): void {
	if (connection.deadline === null) return;
	runtime.timer.cancel(connection.deadline);
	connection.deadline = null;
}
