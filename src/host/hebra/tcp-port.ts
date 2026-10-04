/**
 * `tcpServer` of HebraHost (R4): the core's `TyrianTcpServerPort` over `api.tcp`, Hebra's byte
 * server on 127.0.0.1 (desktop only, and only on the ports Hebra allows, today 47823). Only the
 * shape is translated: each Hebra connection (`connection`/`data`/`error`/`close` events) becomes
 * the `TyrianTcpConnection` that `alert-ingame-server.ts` drives like a `net.Socket`. The protocol
 * (`hello`, the 512-byte limit, the deadlines) stays in the core.
 *
 * Where Hebra has no server (`api.has('tcp')` is false: web, iPhone, Android) the host uses
 * `unavailableTcpServerPort`, which refuses with a clear reason and without reaching Hebra.
 */
import type { PluginTcp, PluginTcpEvent } from 'hebra-plugin-api';

import type { TyrianTcpConnection, TyrianTcpListenError, TyrianTcpServer, TyrianTcpServerPort } from '../tyrian-host';

/** The code `listen` refuses with where there is no bridge. */
export const TCP_UNAVAILABLE_CODE = 'EHEBRA_NO_BRIDGE';

export function unavailableTcpServerPort(reason: string): TyrianTcpServerPort {
	return {
		listen() {
			const error: TyrianTcpListenError = Object.assign(new Error(`tcp-server-unavailable: ${reason}`), { code: TCP_UNAVAILABLE_CODE });
			return Promise.reject(error);
		},
	};
}

/** What Hebra rejects with: an API error or the serialized Rust error (`code`), or text. */
function listenError(reason: unknown): TyrianTcpListenError {
	if (typeof reason === 'object' && reason !== null && 'code' in reason) {
		const { code, message } = reason as { code?: unknown; message?: unknown };
		return Object.assign(new Error(typeof message === 'string' ? message : String(code)), {
			code: typeof code === 'string' ? code : undefined,
		});
	}
	return Object.assign(new Error(typeof reason === 'string' ? reason : 'tcp-listen-failed'), { code: 'EHEBRA_TCP_LISTEN' });
}

class BridgeConnection implements TyrianTcpConnection {
	readonly #tcp: PluginTcp;
	readonly #id: number;
	readonly #report: (error: unknown, where: string) => void;
	readonly #data: ((chunk: Uint8Array) => void)[] = [];
	readonly #closed: (() => void)[] = [];
	readonly #errored: (() => void)[] = [];
	/** A connection's writes and its close leave in the order they are asked for. */
	#queue: Promise<void> = Promise.resolve();
	#done = false;

	constructor(tcp: PluginTcp, id: number, report: (error: unknown, where: string) => void) {
		this.#tcp = tcp;
		this.#id = id;
		this.#report = report;
	}

	onData(listener: (chunk: Uint8Array) => void): void {
		this.#data.push(listener);
	}

	onClose(listener: () => void): void {
		this.#closed.push(listener);
	}

	onError(listener: () => void): void {
		this.#errored.push(listener);
	}

	write(data: string): void {
		this.#enqueue(() => this.#tcp.write(this.#id, data));
	}

	end(data?: string): void {
		this.#enqueue(() => this.#tcp.end(this.#id, data));
	}

	/** After what is already queued, like `net.Socket.destroySoon`. */
	destroySoon(): void {
		this.#enqueue(() => this.#tcp.destroy(this.#id));
	}

	destroy(): void {
		if (this.#done) return;
		this.#tcp.destroy(this.#id).catch(() => {
			// The connection was gone already: Hebra emitted (or will emit) `close`. Not a failure.
		});
	}

	/** A Hebra event for this connection. */
	receive(event: PluginTcpEvent): void {
		if (this.#done) return;
		if (event.kind === 'data') {
			const chunk = new Uint8Array(event.bytes);
			for (const listener of this.#data) listener(chunk);
		} else if (event.kind === 'error') {
			for (const listener of this.#errored) listener();
		} else if (event.kind === 'close') {
			this.#done = true;
			for (const listener of this.#closed) listener();
		}
	}

	/** The server closed: no connection lives on. */
	shutdown(): void {
		if (this.#done) return;
		this.#done = true;
		for (const listener of this.#closed) listener();
	}

	#enqueue(operation: () => Promise<void>): void {
		if (this.#done) return;
		this.#queue = this.#queue.then(operation).catch((error: unknown) => {
			// Writing to a connection Hebra already closed: reported as a socket error.
			this.#report(error, 'tcp.connection');
			for (const listener of this.#errored) listener();
		});
	}
}

export function createTcpServerPort(tcp: PluginTcp, report: (error: unknown, where: string) => void = () => undefined): TyrianTcpServerPort {
	return {
		async listen(port, _host, onConnection): Promise<TyrianTcpServer> {
			const connections = new Map<number, BridgeConnection>();
			let closed = false;
			let bound: number;
			try {
				bound = await tcp.listen(port, (event) => {
					if (closed) return;
					if (event.kind === 'connection') {
						const connection = new BridgeConnection(tcp, event.id, report);
						connections.set(event.id, connection);
						onConnection(connection);
						return;
					}
					connections.get(event.id)?.receive(event);
					if (event.kind === 'close') connections.delete(event.id);
				});
			} catch (reason) {
				throw listenError(reason);
			}
			return {
				// Hebra always binds 127.0.0.1 (it takes no address): the caller does not decide it.
				address: '127.0.0.1',
				port: bound,
				async close() {
					if (closed) return;
					closed = true;
					await tcp.close();
					for (const connection of connections.values()) connection.shutdown();
					connections.clear();
				},
			};
		},
	};
}
