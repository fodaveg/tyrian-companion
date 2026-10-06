import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TyrianTcpConnection, TyrianTcpServerPort } from '../host/tyrian-host';
import { startAlertIngameServer } from './alert-ingame-server';
import { emptyFarmingIngameState } from './farming-ingame-state';

/** Controlled socket boundary exercises consumer negotiation and timer cleanup without account or network access. */
class FarmingClient implements TyrianTcpConnection {
	readonly lines: Record<string, unknown>[] = [];
	private receive: (chunk: Uint8Array) => void = () => {};
	private closed: () => void = () => {};
	onData(listener: (chunk: Uint8Array) => void): void { this.receive = listener; }
	onClose(listener: () => void): void { this.closed = listener; }
	onError(): void {}
	write(line: string): void { this.lines.push(JSON.parse(line) as Record<string, unknown>); }
	end(line?: string): void { if (line) this.write(line); this.closed(); }
	destroySoon(): void { this.closed(); }
	destroy(): void { this.closed(); }
	send(record: Record<string, unknown>): void { this.receive(new TextEncoder().encode(`${JSON.stringify(record)}\n`)); }
}

async function farmingBridge() {
	let accept: (socket: TyrianTcpConnection) => void = () => {};
	const read = vi.fn(() => ({ ...emptyFarmingIngameState(), phase: 'active' as const, observed: 10, age: 600 }));
	const ack = vi.fn();
	const failure = vi.fn();
	const tcp: TyrianTcpServerPort = { listen: async (_port, _host, listener) => {
		accept = listener;
		return { address: '127.0.0.1', port: 47823, close: async () => {} };
	} };
	const server = await startAlertIngameServer(tcp, 47823, {
		schedule: (callback, ms) => setTimeout(callback, ms), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	}, { authenticate: () => true, fillRandom: (bytes) => { bytes.fill(1); }, now: () => Date.now(),
		onConnectionEvent: () => {}, farmingState: read, onAlertAck: ack, onFarmingError: failure });
	return { server, read, ack, failure, connect: (version = 3) => {
		const client = new FarmingClient();
		accept(client);
		client.send({ v: version, type: 'hello', client: 'nexus', clientVersion: '1.0', instance: 'AQEBAQEBAQEBAQEBAQEBAQ', token: 'x'.repeat(43) });
		return client;
	} };
}

describe('farm1 negotiated bridge consumer', () => {
	afterEach(() => vi.useRealTimers());

	it('advertises only to v3, sends no unsolicited farming to an older or unsubscribed client', async () => {
		vi.useFakeTimers();
		const harness = await farmingBridge();
		const old = harness.connect(2);
		const modern = harness.connect();
		expect(old.lines.map((line) => line.type)).toEqual(['welcome']);
		expect(modern.lines.map((line) => line.type)).toEqual(['welcome', 'farming_cap']);
		vi.advanceTimersByTime(10_000);
		expect(harness.read).not.toHaveBeenCalled();
		await harness.server.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('consumes duplicate subscription input sequence without extra snapshot, and keeps alert ack independent', async () => {
		vi.useFakeTimers();
		const harness = await farmingBridge();
		const client = harness.connect();
		const nonce = client.lines[0]?.nonce;
		client.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce, seq: 0 });
		client.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce, seq: 1 });
		harness.server.broadcastAlert(99, (v) => JSON.stringify({ v, type: 'alert', seq: 99 }));
		client.send({ v: 3, type: 'alert_ack', nonce, seq: 2, alertSeq: 99 });
		expect(harness.read).toHaveBeenCalledTimes(1);
		expect(harness.ack).toHaveBeenCalledWith(expect.objectContaining({ alertSeq: 99 }));
		vi.advanceTimersByTime(5_000);
		expect(client.lines.filter((line) => line.type === 'farming_state')).toMatchObject([{ seq: 1, age: 600 }, { seq: 2, age: 600 }]);
		await harness.server.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('discards the stream on disconnect, resets its sequence on reconnect and sends no backlog after suspension', async () => {
		vi.useFakeTimers();
		const harness = await farmingBridge();
		const first = harness.connect();
		first.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce: first.lines[0]?.nonce, seq: 0 });
		first.destroy();
		vi.advanceTimersByTime(60_000);
		expect(harness.read).toHaveBeenCalledTimes(1);
		const second = harness.connect();
		second.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce: second.lines[0]?.nonce, seq: 0 });
		expect(second.lines.at(-1)).toMatchObject({ type: 'farming_state', seq: 1 });
		vi.advanceTimersByTime(60_000);
		expect(harness.server.clientCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		await harness.server.close();
	});

	it('reports a failed projection, retains input liveness and recovers without consuming a farming sequence', async () => {
		vi.useFakeTimers();
		const harness = await farmingBridge();
		const failure = new Error('Projection unavailable');
		harness.read.mockImplementationOnce(() => { throw failure; });
		const client = harness.connect();
		client.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce: client.lines[0]?.nonce, seq: 0 });
		expect(harness.failure).toHaveBeenCalledWith(failure);
		expect(client.lines.map((line) => line.type)).toEqual(['welcome', 'farming_cap']);
		client.send({ v: 3, type: 'heartbeat', nonce: client.lines[0]?.nonce, seq: 1 });
		vi.advanceTimersByTime(5_000);
		expect(client.lines.at(-1)).toMatchObject({ type: 'farming_state', seq: 1 });
		await harness.server.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects extra subscription keys instead of accepting a hidden account operation', async () => {
		vi.useFakeTimers();
		const harness = await farmingBridge();
		const client = harness.connect();
		client.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce: client.lines[0]?.nonce, seq: 0, command: 'start' });
		expect(client.lines.at(-1)).toMatchObject({ type: 'error', code: 'frame_schema' });
		expect(harness.read).not.toHaveBeenCalled();
		await harness.server.close();
	});
});
