import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TyrianTcpConnection, TyrianTcpServerPort } from '../host/tyrian-host';
import { startAlertIngameServer } from './alert-ingame-server';
import type { LiveIngamePort } from './live-loot-protocol';
import { magicFindIngameCapabilityLine, type MagicFindIngameReading } from './magic-find-ingame-state';
import type { PriceIngameState } from './price-ingame-state';

/** `mf1` on the bridge (14 Oct 2026): who is offered it, what is accepted, and what the owner is told. No network, no account. */
interface MagicFindFixture { readonly frames: Record<string, unknown>[] }
const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/mf1.json', import.meta.url), 'utf8')) as MagicFindFixture;
const NONCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const NOW = 1_760_000_000_000;

class Client implements TyrianTcpConnection {
	readonly lines: Record<string, unknown>[] = [];
	closed = false;
	private receive: (chunk: Uint8Array) => void = () => {};
	private onClosed: () => void = () => {};
	onData(listener: (chunk: Uint8Array) => void): void { this.receive = listener; }
	onClose(listener: () => void): void { this.onClosed = listener; }
	onError(): void {}
	write(line: string): void { this.lines.push(JSON.parse(line) as Record<string, unknown>); }
	end(line?: string): void { if (line) this.write(line); this.closed = true; this.onClosed(); }
	destroySoon(): void { this.closed = true; this.onClosed(); }
	destroy(): void { this.closed = true; this.onClosed(); }
	send(record: Record<string, unknown>): void { this.receive(new TextEncoder().encode(`${JSON.stringify(record)}\n`)); }
	types(): unknown[] { return this.lines.map((line) => line.type); }
	errors(): unknown[] { return this.lines.filter((line) => line.type === 'error').map((line) => line.code); }
}

const PRICE: PriceIngameState = { st: 'idle', sell: null, sellStack: null, list: null, listStack: null, age: null };

async function bridge(options: { magicFind?: boolean } = {}) {
	let accept: (socket: TyrianTcpConnection) => void = () => {};
	const readings: MagicFindIngameReading[] = [];
	const live: LiveIngamePort = {
		open: vi.fn(async () => 'ready' as const), commit: vi.fn(async () => 'stored' as const), gap: vi.fn(async () => undefined), onError: vi.fn(),
	};
	const tcp: TyrianTcpServerPort = { listen: async (_port, _host, listener) => {
		accept = listener;
		return { address: '127.0.0.1', port: 47823, close: async () => {} };
	} };
	const server = await startAlertIngameServer(tcp, 47823, {
		schedule: (callback, ms) => setTimeout(callback, ms), cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
	}, {
		authenticate: () => true, fillRandom: (bytes) => { bytes.fill(1); }, now: () => Date.now(), onConnectionEvent: () => {},
		priceState: () => PRICE, live,
		...(options.magicFind === false ? {} : { onMagicFind: (reading: MagicFindIngameReading) => { readings.push(reading); } }),
	});
	return { server, readings, connect: (version = 3, client: 'nexus' | 'blish' = 'nexus') => {
		const socket = new Client();
		accept(socket);
		socket.send({ v: version, type: 'hello', client, clientVersion: '0.8.11', instance: 'AgICAgICAgICAgICAgICAg', token: 'x'.repeat(43) });
		return socket;
	} };
}

const state = (seq: number, mf: unknown, ageMs: unknown = 0) => ({ v: 3, type: 'mf_state', nonce: NONCE, seq, tag: 'mf1', mf, ageMs });

describe('mf1 negotiated bridge consumer', () => {
	afterEach(() => { vi.useRealTimers(); });

	it('announces mf_cap after price_cap and before live_cap, only to a v3 Nexus connection and only with an owner', async () => {
		vi.useFakeTimers();
		const harness = await bridge();
		expect(harness.connect(3).types()).toEqual(['welcome', 'price_cap', 'mf_cap', 'live_cap']);
		expect(harness.connect(3).lines[2]).toEqual(fixture.frames[0]);
		expect(magicFindIngameCapabilityLine(NONCE)).toBe(JSON.stringify(fixture.frames[0]));
		expect(harness.connect(2).types()).toEqual(['welcome']);
		expect(harness.connect(3, 'blish').types()).toEqual(['welcome', 'price_cap']);
		await harness.server.close();
		const bare = await bridge({ magicFind: false });
		expect(bare.connect(3).types()).toEqual(['welcome', 'price_cap', 'live_cap']);
		await bare.server.close();
	});

	it('hands the fixture lines to the owner with the instant of their reading, on the shared input sequence', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const harness = await bridge();
		const client = harness.connect();
		client.send({ ...fixture.frames[1], seq: 0 });
		client.send({ v: 3, type: 'heartbeat', nonce: NONCE, seq: 1 });
		client.send({ ...fixture.frames[2], seq: 2 });
		expect(client.errors()).toEqual([]);
		expect(harness.readings).toEqual([
			{ connectionId: NONCE, value: 333, observedAtMs: NOW - 12 },
			{ connectionId: NONCE, value: null, observedAtMs: NOW },
		]);
		await harness.server.close();
	});

	it('closes a connection that sends mf_state without the announcement, as 0.6.58 did for a type it did not know', async () => {
		vi.useFakeTimers();
		for (const [magicFind, version, client] of [[false, 3, 'nexus'], [true, 2, 'nexus'], [true, 3, 'blish']] as const) {
			const harness = await bridge({ magicFind });
			const socket = harness.connect(version, client);
			socket.send({ ...state(0, 333), v: version });
			expect(socket.errors()).toEqual(['unexpected_message']);
			expect(socket.closed).toBe(true);
			expect(harness.readings).toEqual([]);
			await harness.server.close();
		}
	});

	it.each([
		['another tag', { ...state(0, 333), tag: 'mf2' }],
		['a negative figure', state(0, -1)],
		['a fraction', state(0, 333.5)],
		['a figure as text', state(0, '333')],
		['a figure above the bound', state(0, 100_001)],
		['an age above the bound', state(0, 333, 600_001)],
		['a missing age', { v: 3, type: 'mf_state', nonce: NONCE, seq: 0, tag: 'mf1', mf: 333 }],
		['an extra key', { ...state(0, 333), character: 'Astra' }],
	])('rejects %s as frame_schema and tells the owner nothing', async (_name, line) => {
		vi.useFakeTimers();
		const harness = await bridge();
		const client = harness.connect();
		client.send(line);
		expect(client.errors()).toEqual(['frame_schema']);
		expect(harness.readings).toEqual([]);
		await harness.server.close();
	});

	it('an addon that never sends mf_state (0.8.10 ignores mf_cap) keeps its connection and the owner hears nothing', async () => {
		vi.useFakeTimers();
		const harness = await bridge();
		const client = harness.connect();
		client.send({ v: 3, type: 'context', nonce: NONCE, seq: 0, state: 'gameplay', mapId: 866, character: 'Astra' });
		client.send({ v: 3, type: 'heartbeat', nonce: NONCE, seq: 1 });
		client.destroy();
		expect(client.errors()).toEqual([]);
		expect(harness.readings).toEqual([]);
		await harness.server.close();
	});

	it.each([
		['bye', (client: Client) => { client.send({ v: 3, type: 'bye', nonce: NONCE, seq: 1, reason: 'game_exit' }); }],
		['socket close', (client: Client) => { client.destroy(); }],
		['reject', (client: Client) => { client.send(state(1, -5)); }],
	])('a connection that reported tells the owner its figure is gone on %s', async (_name, end) => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const harness = await bridge();
		const client = harness.connect();
		client.send(state(0, 363));
		vi.setSystemTime(NOW + 5_000);
		end(client);
		expect(harness.readings).toEqual([
			{ connectionId: NONCE, value: 363, observedAtMs: NOW },
			{ connectionId: NONCE, value: null, observedAtMs: NOW + 5_000 },
		]);
		await harness.server.close();
		expect(harness.readings).toHaveLength(2);
	});
});
