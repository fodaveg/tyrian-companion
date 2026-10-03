// @vitest-environment happy-dom
// (a `window` for the timers, `window.setTimeout`, as in Hebra's webview)
import type { PluginTcp, PluginTcpEvent } from 'hebra-plugin-api';
import { describe, expect, it, vi } from 'vitest';

import type { TyrianTcpConnection } from '../tyrian-host';
import { createTcpServerPort, TCP_UNAVAILABLE_CODE, unavailableTcpServerPort } from './tcp-port';

// Ported from Hebra's `src/lib/modules/tyrian/tcp-port.test.ts`, over `api.tcp` instead of Hebra's
// `host-tcp.ts`. The integration test against a real socket (`tcp-bridge.integration.test.ts`,
// `node:net` against Hebra's Rust bridge) stays in Hebra: the bridge is Hebra's, not the plugin's.

/** An `api.tcp` that records the calls and lets the test emit events by hand. */
function fakeTcp(): { tcp: PluginTcp; calls: string[]; emit: (event: PluginTcpEvent) => void; listenError: { current: unknown } } {
	const calls: string[] = [];
	let sink: ((event: PluginTcpEvent) => void) | null = null;
	const listenError = { current: null as unknown };
	const tcp: PluginTcp = {
		listen(port, onEvent) {
			calls.push(`listen ${String(port)}`);
			// What Hebra rejects with is not always an `Error` (a serialized Rust error, a string):
			// that is exactly what these tests feed it.
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above.
			if (listenError.current !== null) return Promise.reject(listenError.current);
			sink = onEvent;
			return Promise.resolve(port);
		},
		write: async (id, data) => { calls.push(`write ${String(id)} ${data}`); },
		end: async (id, data) => { calls.push(`end ${String(id)} ${data ?? ''}`); },
		destroy: async (id) => { calls.push(`destroy ${String(id)}`); },
		close: async () => { calls.push('close'); },
	};
	return { tcp, calls, emit: (event) => sink?.(event), listenError };
}

const flush = (): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, 0); });

describe('tcp-port: TyrianTcpServerPort over api.tcp', () => {
	it('listen gives a loopback address and the bound port', async () => {
		const server = await createTcpServerPort(fakeTcp().tcp).listen(47823, '127.0.0.1', () => undefined);
		expect([server.address, server.port]).toEqual(['127.0.0.1', 47823]);
	});

	it('each Hebra connection is a socket: bytes delivered as they are, in order', async () => {
		const { tcp, emit } = fakeTcp();
		const received: string[] = [];
		let closed = 0;
		await createTcpServerPort(tcp).listen(47823, '127.0.0.1', (connection) => {
			connection.onData((chunk) => received.push(new TextDecoder().decode(chunk)));
			connection.onClose(() => { closed += 1; });
		});
		emit({ kind: 'connection', id: 1 });
		emit({ kind: 'data', id: 1, bytes: [...new TextEncoder().encode('{"a":1}\n')] });
		emit({ kind: 'data', id: 1, bytes: [...new TextEncoder().encode('{"b"')] });
		emit({ kind: 'data', id: 99, bytes: [65] }); // unknown connection: ignored
		emit({ kind: 'close', id: 1 });
		emit({ kind: 'close', id: 1 });
		expect(received).toEqual(['{"a":1}\n', '{"b"']);
		expect(closed).toBe(1);
	});

	it('write, end and destroySoon leave in the order asked; destroy does not wait', async () => {
		const { tcp, calls, emit } = fakeTcp();
		let socket: TyrianTcpConnection | undefined;
		await createTcpServerPort(tcp).listen(47823, '127.0.0.1', (connection) => { socket = connection; });
		emit({ kind: 'connection', id: 7 });
		socket?.write('one\n');
		socket?.end('two\n');
		socket?.destroySoon();
		await flush();
		expect(calls.slice(1)).toEqual(['write 7 one\n', 'end 7 two\n', 'destroy 7']);
		socket?.destroy();
		await flush();
		expect(calls.at(-1)).toBe('destroy 7');
	});

	it('a write Hebra refuses (connection already closed) is reported as a socket error', async () => {
		const { tcp, emit } = fakeTcp();
		tcp.write = () => Promise.reject(Object.assign(new Error('gone'), { code: 'module-tcp-unknown-connection' }));
		const report = vi.fn();
		const onError = vi.fn();
		let socket: TyrianTcpConnection | undefined;
		await createTcpServerPort(tcp, report).listen(47823, '127.0.0.1', (connection) => {
			connection.onError(onError);
			socket = connection;
		});
		emit({ kind: 'connection', id: 1 });
		socket?.write('x');
		await flush();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith(expect.anything(), 'tcp.connection');
	});

	it('the error event warns the socket and the close after it closes it', async () => {
		const { tcp, emit } = fakeTcp();
		const order: string[] = [];
		await createTcpServerPort(tcp).listen(47823, '127.0.0.1', (connection) => {
			connection.onError(() => order.push('error'));
			connection.onClose(() => order.push('close'));
		});
		emit({ kind: 'connection', id: 1 });
		emit({ kind: 'error', id: 1 });
		emit({ kind: 'close', id: 1 });
		expect(order).toEqual(['error', 'close']);
	});

	it('port in use: refuses with EADDRINUSE, the code the core retries on; text keeps a code of its own', async () => {
		const busy = fakeTcp();
		busy.listenError.current = { code: 'EADDRINUSE', message: 'Address already in use' };
		await expect(createTcpServerPort(busy.tcp).listen(47823, '127.0.0.1', () => undefined))
			.rejects.toMatchObject({ code: 'EADDRINUSE', message: 'Address already in use' });
		const text = fakeTcp();
		text.listenError.current = 'Command not found';
		await expect(createTcpServerPort(text.tcp).listen(47823, '127.0.0.1', () => undefined))
			.rejects.toMatchObject({ code: 'EHEBRA_TCP_LISTEN' });
	});

	it('an API refusal (TCP not available here) keeps its code, which the core does not retry', async () => {
		const { tcp, listenError } = fakeTcp();
		listenError.current = Object.assign(new Error('«tcp» en ios.'), { name: 'PluginApiError', code: 'unavailable-on-platform' });
		await expect(createTcpServerPort(tcp).listen(47823, '127.0.0.1', () => undefined))
			.rejects.toMatchObject({ code: 'unavailable-on-platform' });
	});

	it('close closes Hebra\'s server once and closes the live connections', async () => {
		const { tcp, calls, emit } = fakeTcp();
		const onClose = vi.fn();
		const server = await createTcpServerPort(tcp).listen(47823, '127.0.0.1', (connection) => { connection.onClose(onClose); });
		emit({ kind: 'connection', id: 1 });
		await server.close();
		await server.close();
		expect(calls.filter((call) => call === 'close')).toHaveLength(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		emit({ kind: 'connection', id: 2 }); // already closed: it does not arrive
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('where there is no bridge (web, iPhone) it refuses with a clear reason and a code that is not retried', async () => {
		await expect(unavailableTcpServerPort('desktop only').listen(47823, '127.0.0.1', () => undefined)).rejects.toMatchObject({
			code: TCP_UNAVAILABLE_CODE,
			message: expect.stringContaining('desktop only') as string,
		});
		expect(TCP_UNAVAILABLE_CODE).not.toBe('EADDRINUSE');
	});
});
