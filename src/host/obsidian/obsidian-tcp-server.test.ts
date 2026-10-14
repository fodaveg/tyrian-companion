import { EventEmitter } from 'events';
import type { Server } from 'net';
import { describe, expect, it, vi } from 'vitest';
import { createNodeTcpServerPort, type NodeTcpServerModule } from './obsidian-tcp-server';

class FakeServer extends EventEmitter {
	listen(): this { queueMicrotask(() => { this.emit('listening'); }); return this; }
	address() { return { address: '127.0.0.1', port: 47823, family: 'IPv4' }; }
	close(callback?: () => void): this { callback?.(); return this; }
}

function fakeNet(server: FakeServer): NodeTcpServerModule {
	return { createServer: () => server as unknown as Server };
}

describe('obsidian tcp server', () => {
	it('keeps an error listener after listening: a later server error is reported, not uncaught', async () => {
		const server = new FakeServer(); const reported = vi.fn();
		const bound = await createNodeTcpServerPort(fakeNet(server), reported).listen(47823, '127.0.0.1', () => undefined);
		expect(bound.port).toBe(47823);
		const failure = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
		// EventEmitter throws an `error` event nobody listens to: this is the uncaught exception.
		expect(() => server.emit('error', failure)).not.toThrow();
		expect(reported).toHaveBeenCalledWith(failure);
	});

	it('absorbs a later server error when no reporter is given', async () => {
		const quiet = new FakeServer();
		await createNodeTcpServerPort(fakeNet(quiet)).listen(1, '127.0.0.1', () => undefined);
		expect(() => quiet.emit('error', new Error('x'))).not.toThrow();
	});

	it('still rejects a bind failure with the original error and closes its server', async () => {
		const server = new FakeServer(); const close = vi.spyOn(server, 'close');
		server.listen = function listen() { queueMicrotask(() => { this.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' })); }); return this; };
		await expect(createNodeTcpServerPort(fakeNet(server)).listen(1, '127.0.0.1', () => undefined)).rejects.toMatchObject({ code: 'EADDRINUSE' });
		expect(close).toHaveBeenCalledOnce();
	});
});
