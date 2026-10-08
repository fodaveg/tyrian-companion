import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TyrianTcpConnection, TyrianTcpServerPort } from '../host/tyrian-host';
import { startAlertIngameServer } from './alert-ingame-server';
import { emptyFarmingIngameState } from './farming-ingame-state';
import type { PriceIngameState } from './price-ingame-state';

/** Controlled socket boundary: negotiation and timer cleanup with no network and no account. */
class PriceClient implements TyrianTcpConnection {
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
	types(): unknown[] { return this.lines.map((line) => line.type); }
	prices(): Record<string, unknown>[] { return this.lines.filter((line) => line.type === 'price_state'); }
}

const OK: PriceIngameState = { st: 'ok', sell: 345, sellStack: 86_250, list: 367, listStack: 91_750, age: 412 };

async function priceBridge(options: { price?: boolean } = {}) {
	let accept: (socket: TyrianTcpConnection) => void = () => {};
	const read = vi.fn((): PriceIngameState => OK);
	const farm = vi.fn(() => emptyFarmingIngameState());
	const failure = vi.fn();
	const tcp: TyrianTcpServerPort = { listen: async (_port, _host, listener) => {
		accept = listener;
		return { address: '127.0.0.1', port: 47823, close: async () => {} };
	} };
	const server = await startAlertIngameServer(tcp, 47823, {
		schedule: (callback, ms) => setTimeout(callback, ms), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	}, { authenticate: () => true, fillRandom: (bytes) => { bytes.fill(1); }, now: () => Date.now(),
		onConnectionEvent: () => {}, farmingState: farm, onFarmingError: failure,
		...(options.price === false ? {} : { priceState: read }) });
	return { server, read, farm, failure, connect: (version = 3) => {
		const client = new PriceClient();
		accept(client);
		client.send({ v: version, type: 'hello', client: 'nexus', clientVersion: '1.0', instance: 'AQEBAQEBAQEBAQEBAQEBAQ', token: 'x'.repeat(43) });
		return client;
	} };
}
const sub = (client: PriceClient, seq: number) => { client.send({ v: 3, type: 'price_sub', tag: 'price2', nonce: client.lines[0]?.nonce, seq }); };

describe('price2 negotiated bridge consumer', () => {
	afterEach(() => vi.useRealTimers());

	it('announces price_cap after farming_cap, only on v3 and only with a provider', async () => {
		vi.useFakeTimers();
		const harness = await priceBridge();
		expect(harness.connect(2).types()).toEqual(['welcome']);
		expect(harness.connect(3).types()).toEqual(['welcome', 'farming_cap', 'price_cap']);
		expect(harness.connect(3).lines[2]).toEqual({ v: 3, type: 'price_cap', nonce: 'AQEBAQEBAQEBAQEBAQEBAQ', tag: 'price2' });
		await harness.server.close();
		const bare = await priceBridge({ price: false });
		expect(bare.connect(3).types()).toEqual(['welcome', 'farming_cap']);
		await bare.server.close();
	});

	it('sends nothing to a connection that did not subscribe, not even one that has farm1', async () => {
		vi.useFakeTimers();
		const harness = await priceBridge();
		const client = harness.connect();
		client.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce: client.lines[0]?.nonce, seq: 0 });
		vi.advanceTimersByTime(30_000);
		expect(harness.read).not.toHaveBeenCalled();
		expect(client.prices()).toEqual([]);
		expect(client.lines.filter((line) => line.type === 'farming_state').length).toBeGreaterThan(0);
		await harness.server.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('sends on subscribe and every 5 s with its own sequence from 1, independent of farm1', async () => {
		vi.useFakeTimers();
		const harness = await priceBridge();
		const client = harness.connect();
		client.send({ v: 3, type: 'farming_sub', tag: 'farm1', nonce: client.lines[0]?.nonce, seq: 0 });
		vi.advanceTimersByTime(5_000);
		sub(client, 1);
		expect(client.prices()).toMatchObject([{ seq: 1, tag: 'price2', st: 'ok', sell: 345, sellStack: 86_250 }]);
		vi.advanceTimersByTime(10_000);
		expect(client.prices().map((line) => line.seq)).toEqual([1, 2, 3]);
		expect(client.lines.filter((line) => line.type === 'farming_state').at(-1)).toMatchObject({ seq: 4 });
		await harness.server.close();
	});

	it('a repeated subscription consumes input sequence and starts no second read or timer', async () => {
		vi.useFakeTimers();
		const harness = await priceBridge();
		const client = harness.connect();
		sub(client, 0);
		sub(client, 1);
		expect(harness.read).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(2); // liveness deadline + one price timer
		vi.advanceTimersByTime(5_000);
		expect(client.prices().map((line) => line.seq)).toEqual([1, 2]);
		await harness.server.close();
	});

	const endings: [string, (harness: Awaited<ReturnType<typeof priceBridge>>, client: PriceClient) => unknown][] = [
		['close', async (harness) => { await harness.server.close(); }],
		['bye', (_h, client) => { client.send({ v: 3, type: 'bye', nonce: client.lines[0]?.nonce, seq: 1, reason: 'game_exit' }); }],
		['reject', (_h, client) => { client.send({ v: 3, type: 'price_sub', tag: 'price2', nonce: client.lines[0]?.nonce, seq: 1, command: 'x' }); }],
		['socket close', (_h, client) => { client.destroy(); }],
	];
	it.each(endings)('leaves zero timers after %s', async (_name, end) => {
		vi.useFakeTimers();
		const harness = await priceBridge();
		const client = harness.connect();
		sub(client, 0);
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		await end(harness, client);
		expect(vi.getTimerCount()).toBe(0);
		const reads = harness.read.mock.calls.length;
		vi.advanceTimersByTime(60_000);
		expect(harness.read).toHaveBeenCalledTimes(reads);
		await harness.server.close();
	});

	it('a failing provider is reported, consumes no price sequence and recovers on the next tick', async () => {
		vi.useFakeTimers();
		const harness = await priceBridge();
		const failure = new Error('Price unavailable');
		harness.read.mockImplementationOnce(() => { throw failure; });
		const client = harness.connect();
		sub(client, 0);
		expect(harness.failure).toHaveBeenCalledWith(failure);
		expect(client.prices()).toEqual([]);
		vi.advanceTimersByTime(5_000);
		expect(client.prices()).toMatchObject([{ seq: 1 }]);
		await harness.server.close();
	});

	it('a price_sub in v2, with another tag or with an extra key never reaches the provider', async () => {
		vi.useFakeTimers();
		const harness = await priceBridge();
		const old = harness.connect(2);
		old.send({ v: 2, type: 'price_sub', tag: 'price2', nonce: old.lines[0]?.nonce, seq: 0 });
		expect(old.lines.at(-1)).toMatchObject({ type: 'error', code: 'unexpected_message' });
		const other = harness.connect();
		other.send({ v: 3, type: 'price_sub', tag: 'farm1', nonce: other.lines[0]?.nonce, seq: 0 });
		expect(other.lines.at(-1)).toMatchObject({ type: 'error', code: 'frame_schema' });
		expect(harness.read).not.toHaveBeenCalled();
		await harness.server.close();
	});
});
