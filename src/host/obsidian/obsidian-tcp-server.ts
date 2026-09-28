// Bare specifier, not `node:net`: esbuild.config.mjs externalizes every Node builtin by its bare
// name (`node:module`'s `builtinModules`, which does not include the prefixed form), and this is
// the only module in `src/` that reaches for one, so the bundle step is what catches a mismatch.
import { createServer, type Server, type Socket } from 'net';

import type {
	TyrianTcpConnection,
	TyrianTcpListenError,
	TyrianTcpServer,
	TyrianTcpServerPort,
} from '../tyrian-host';

/**
 * `TyrianTcpServerPort` over `node:net`, the one module allowed to open a socket.
 * `src/security-boundary.test.ts` censuses it by name.
 *
 * It only binds and moves bytes: the in-game bridge's protocol, its loopback-only check and its
 * port-occupied retry live in `src/alerts/alert-ingame-server.ts`, host-neutral.
 */
export interface NodeTcpServerModule {
	createServer(connectionListener: (socket: Socket) => void): Server;
}

/** The production port; `net` is injected only so a test can hand in a misbehaving module. */
export function createNodeTcpServerPort(net: NodeTcpServerModule = { createServer }): TyrianTcpServerPort {
	return {
		listen: (port, host, onConnection) => listenOnce(net, port, host, onConnection),
	};
}

/**
 * One bind attempt. A failed attempt closes its own server before rejecting with the original
 * error (its `code`, e.g. `EADDRINUSE`, is what the caller's retry reads), so the caller never
 * has to dispose of a server it was never handed.
 */
function listenOnce(
	net: NodeTcpServerModule,
	port: number,
	host: string,
	onConnection: (connection: TyrianTcpConnection) => void,
): Promise<TyrianTcpServer> {
	const server = net.createServer((socket) => { onConnection(nodeConnection(socket)); });
	return new Promise((resolve, reject) => {
		const onError = (error: TyrianTcpListenError): void => {
			server.removeListener('listening', onListening);
			server.close();
			reject(error);
		};
		const onListening = (): void => {
			server.removeListener('error', onError);
			resolve(boundServer(server));
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(port, host);
	});
}

/** Reports the address the socket actually bound, never the one that was asked for. */
function boundServer(server: Server): TyrianTcpServer {
	const address = server.address();
	const bound = address === null || typeof address === 'string' ? { address: '', port: 0 } : address;
	return {
		address: bound.address,
		port: bound.port,
		close: () => new Promise((resolve) => { server.close(() => resolve()); }),
	};
}

function nodeConnection(socket: Socket): TyrianTcpConnection {
	return {
		// A Node `Buffer` is a `Uint8Array`; the listener never sees anything Node-specific.
		onData: (listener) => { socket.on('data', listener); },
		onClose: (listener) => { socket.on('close', listener); },
		onError: (listener) => { socket.on('error', listener); },
		write: (data) => { socket.write(data); },
		end: (data) => { if (data === undefined) socket.end(); else socket.end(data); },
		destroySoon: () => { socket.destroySoon(); },
		destroy: () => { socket.destroy(); },
	};
}
