import { describe, expect, it } from 'vitest';

import {
	MUMBLE_V2_TRANSPORT_CONTRACT,
	type MumbleV2ProtocolRecordV1,
} from './mumble-v2-contract';
import {
	MumbleV2Client,
	type MumbleV2ClientPorts,
	type MumbleV2ProcessCallbacks,
	type MumbleV2ProcessHandle,
	MumbleV2SequenceGuard,
	type MumbleV2TcpCallbacks,
	type MumbleV2TcpHandle,
} from './mumble-v2-client';
import { decodeMumbleV2Payload, frameMumbleV2Record } from './mumble-v2-codec';

const NONCE_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const NONCE_B = '_____________________w';

describe('MumbleV2Client handshake and sequencing', () => {
	it('binds one process token across fragmented discovery and hello, then accepts coalesced records', () => {
		const harness = new ClientHarness();
		const records: MumbleV2ProtocolRecordV1[] = [];
		const client = harness.create({ onRecord: (record) => records.push(record) });
		client.start();

		const bootstrap = harness.processRecord(0, 0);
		const bootstrapToken = tokenOf(bootstrap);
		expect(bootstrapToken).toHaveLength(43);

		const discovery = frameMumbleV2Record(ready());
		harness.processes[0]!.callbacks.stdout(discovery.subarray(0, 2));
		harness.processes[0]!.callbacks.stdout(discovery.subarray(2));
		expect(client.getState().lifecycle).toBe('connecting');
		harness.tcp[0]!.callbacks.connected();
		const hello = harness.tcpRecord(0, 0);
		expect(hello).toEqual({ kind: 'hello', version: 1, token: bootstrapToken });

		const welcomeAndHeartbeat = join(
			frameMumbleV2Record(welcome(NONCE_A)),
			frameMumbleV2Record(heartbeat(NONCE_A, 0)),
		);
		harness.tcp[0]!.callbacks.data(welcomeAndHeartbeat);
		expect(client.getState()).toMatchObject({
			lifecycle: 'healthy',
			backoffAttempt: 0,
			hasProcessToken: true,
			hasDiscoveredPort: true,
			hasActiveNonce: true,
		});
		expect(records).toEqual([heartbeat(NONCE_A, 0)]);
	});

	it('rejects a sample before the mandatory first heartbeat', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		harness.handshakeToWelcome(client, NONCE_A);
		harness.tcp[0]!.callbacks.data(frameMumbleV2Record(sample(NONCE_A, 0)));
		expect(client.getState()).toMatchObject({
			lifecycle: 'reconnect_wait',
			lastError: 'frame_schema',
			backoffDelayMs: 250,
		});
	});

	it('rejects sequence replay and gaps on the live connection', () => {
		for (const invalidSequence of [0, 2]) {
			const harness = new ClientHarness();
			const client = harness.create();
			harness.handshakeToHealthy(client, NONCE_A);
			harness.tcp[0]!.callbacks.data(frameMumbleV2Record(sample(NONCE_A, invalidSequence)));
			expect(client.getState()).toMatchObject({
				lifecycle: 'reconnect_wait',
				lastError: 'sequence_mismatch',
			});
		}
	});

	it('rejects nonce mismatch, overflow and wrap in the shared sequence guard', () => {
		const mismatch = new MumbleV2SequenceGuard(NONCE_A);
		expect(mismatch.accept({ nonce: NONCE_B, sequence: 0 })).toBe('nonce_mismatch');
		expect(mismatch.accept({ nonce: NONCE_A, sequence: Number.MAX_SAFE_INTEGER + 1 }))
			.toBe('sequence_mismatch');

		const boundary = new MumbleV2SequenceGuard(
			NONCE_A,
			MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMaximum,
		);
		expect(boundary.accept({
			nonce: NONCE_A,
			sequence: MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMaximum,
		})).toBeNull();
		expect(boundary.accept({ nonce: NONCE_A, sequence: 0 })).toBe('sequence_mismatch');
	});

	it('requires a fresh nonce on every same-process reconnect while retaining the token', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		harness.handshakeToHealthy(client, NONCE_A);
		const originalToken = tokenOf(harness.processRecord(0, 0));

		harness.tcp[0]!.callbacks.closed();
		harness.clock.fireNext();
		harness.tcp[1]!.callbacks.connected();
		expect(tokenOf(harness.tcpRecord(1, 0))).toBe(originalToken);
		harness.tcp[1]!.callbacks.data(frameMumbleV2Record(welcome(NONCE_A)));
		expect(client.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', lastError: 'nonce_mismatch',
		});

		harness.clock.fireNext();
		harness.tcp[2]!.callbacks.connected();
		harness.tcp[2]!.callbacks.data(frameMumbleV2Record(welcome(NONCE_B)));
		expect(client.getState().lifecycle).toBe('awaiting_first_sequenced');
	});

	it('rejects a non-canonical nonce alias before the per-process nonce census', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		client.start();
		harness.sendReady(0);
		harness.tcp[0]!.callbacks.connected();
		const alias = `${NONCE_A.slice(0, -1)}B`;
		harness.tcp[0]!.callbacks.data(frameUnchecked({
			kind: 'welcome', version: 1, nonce: alias, heartbeatIntervalMs: 500,
		}));
		expect(client.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', lastError: 'frame_schema',
		});
		harness.clock.fireNext();
		harness.tcp[1]!.callbacks.connected();
		harness.tcp[1]!.callbacks.data(frameMumbleV2Record(welcome(NONCE_A)));
		expect(client.getState().lifecycle).toBe('awaiting_first_sequenced');
	});

	it('creates a different token for each helper process and clears the raw random bytes', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		client.start();
		const first = tokenOf(harness.processRecord(0, 0));
		expect(harness.randomOutputs[0]).toEqual(new Uint8Array(32));
		harness.processes[0]!.callbacks.exited();
		harness.clock.fireNext();
		const second = tokenOf(harness.processRecord(1, 0));
		expect(second).not.toBe(first);
		expect(harness.randomOutputs[1]).toEqual(new Uint8Array(32));
	});
});

describe('MumbleV2Client deterministic failure routing', () => {
	it('isolates throwing state and error observers', () => {
		const stateHarness = new ClientHarness();
		const stateClient = stateHarness.create({
			onStateChange: () => { throw new Error('observer failure'); },
		});
		expect(() => stateClient.start()).not.toThrow();
		expect(stateHarness.processes).toHaveLength(1);
		expect(stateClient.getState().lifecycle).toBe('awaiting_ready');

		const errorHarness = new ClientHarness();
		const errorClient = errorHarness.create({
			onError: () => { throw new Error('observer failure'); },
		});
		errorClient.start();
		expect(() => errorHarness.processes[0]!.callbacks.exited()).not.toThrow();
		expect(errorClient.getState()).toMatchObject({
			lifecycle: 'restart_wait', lastError: 'helper_exited', backoffDelayMs: 250,
		});
	});

	it('does not revive when an error observer shuts down the client', () => {
		const harness = new ClientHarness();
		let client: MumbleV2Client;
		client = harness.create({ onError: () => client.shutdown() });
		client.start();
		harness.processes[0]!.callbacks.exited();
		expect(client.getState().lifecycle).toBe('shutdown');
		expect(harness.clock.nextDelay()).toBeNull();
	});

	it('contains reentrant start and shutdown calls from state observers', () => {
		const startHarness = new ClientHarness();
		let startClient: MumbleV2Client;
		startClient = startHarness.create({
			onStateChange: () => startClient.start(),
		});
		expect(() => startClient.start()).not.toThrow();
		expect(startHarness.processes).toHaveLength(1);
		expect(startClient.getState().lifecycle).toBe('awaiting_ready');

		const shutdownHarness = new ClientHarness();
		let shutdownClient: MumbleV2Client;
		shutdownClient = shutdownHarness.create({
			onStateChange: (state) => {
				if (state.lifecycle === 'awaiting_bootstrap') {
					shutdownClient.shutdown();
					shutdownClient.start();
				}
			},
		});
		expect(() => shutdownClient.start()).not.toThrow();
		expect(shutdownClient.getState().lifecycle).toBe('shutdown');
		expect(shutdownHarness.processes).toHaveLength(0);
		expect(shutdownHarness.clock.nextDelay()).toBeNull();
	});

	it('uses one saturated backoff across restart and reconnect, resetting only after healthy', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		client.start();

		harness.processes[0]!.callbacks.exited();
		expect(client.getState()).toMatchObject({
			lifecycle: 'restart_wait', backoffDelayMs: 250, backoffAttempt: 1,
		});
		harness.clock.fireNext();
		harness.processes[1]!.callbacks.exited();
		expect(client.getState()).toMatchObject({
			lifecycle: 'restart_wait', backoffDelayMs: 500, backoffAttempt: 2,
		});

		harness.clock.fireNext();
		harness.sendReady(2);
		harness.tcp[0]!.callbacks.connected();
		harness.tcp[0]!.callbacks.data(frameMumbleV2Record(welcome(NONCE_A)));
		expect(client.getState().backoffAttempt).toBe(2);
		harness.tcp[0]!.callbacks.closed();
		expect(client.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', backoffDelayMs: 1_000, backoffAttempt: 3,
		});

		harness.clock.fireNext();
		harness.tcp[1]!.callbacks.connected();
		harness.tcp[1]!.callbacks.data(frameMumbleV2Record(welcome(NONCE_B)));
		expect(client.getState().backoffAttempt).toBe(3);
		harness.tcp[1]!.callbacks.data(frameMumbleV2Record(heartbeat(NONCE_B, 0)));
		expect(client.getState()).toMatchObject({ lifecycle: 'healthy', backoffAttempt: 0 });
		harness.tcp[1]!.callbacks.closed();
		expect(client.getState()).toMatchObject({ backoffDelayMs: 250, backoffAttempt: 1 });
	});

	it('saturates the shared backoff at five seconds', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		client.start();
		for (const expected of [250, 500, 1_000, 2_000, 5_000, 5_000]) {
			const current = harness.processes.length - 1;
			harness.processes[current]!.callbacks.exited();
			expect(client.getState().backoffDelayMs).toBe(expected);
			harness.clock.fireNext();
		}
	});

	it('routes discovery and first-record deadlines without using ambient timers', () => {
		const discovery = new ClientHarness();
		const discoveryClient = discovery.create();
		discoveryClient.start();
		expect(discovery.clock.nextDelay()).toBe(5_000);
		discovery.clock.fireNext();
		expect(discoveryClient.getState()).toMatchObject({
			lifecycle: 'restart_wait', lastError: 'discovery_timeout', backoffDelayMs: 250,
		});

		const firstRecord = new ClientHarness();
		const firstClient = firstRecord.create();
		firstRecord.handshakeToWelcome(firstClient, NONCE_A);
		expect(firstRecord.clock.nextDelay()).toBe(2_000);
		firstRecord.clock.fireNext();
		expect(firstClient.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', lastError: 'heartbeat_timeout',
		});
	});

	it('routes connect, hello and healthy heartbeat deadlines through the same clock port', () => {
		const connect = new ClientHarness();
		const connectClient = connect.create();
		connectClient.start();
		connect.sendReady(0);
		expect(connect.clock.nextDelay()).toBe(2_000);
		connect.clock.fireNext();
		expect(connectClient.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', lastError: 'connect_timeout',
		});

		const hello = new ClientHarness();
		const helloClient = hello.create();
		helloClient.start();
		hello.sendReady(0);
		hello.tcp[0]!.callbacks.connected();
		expect(hello.clock.nextDelay()).toBe(2_000);
		hello.clock.fireNext();
		expect(helloClient.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', lastError: 'auth_rejected',
		});

		const heartbeatDeadline = new ClientHarness();
		const healthyClient = heartbeatDeadline.create();
		heartbeatDeadline.handshakeToHealthy(healthyClient, NONCE_A);
		expect(heartbeatDeadline.clock.nextDelay()).toBe(2_000);
		heartbeatDeadline.clock.fireNext();
		expect(healthyClient.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', lastError: 'heartbeat_timeout',
		});
	});

	it('reports a partial frame before peer_closed when TCP closes mid-record', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		client.start();
		harness.sendReady(0);
		harness.tcp[0]!.callbacks.connected();
		const framed = frameMumbleV2Record(welcome(NONCE_A));
		harness.tcp[0]!.callbacks.data(framed.subarray(0, framed.byteLength - 1));
		harness.tcp[0]!.callbacks.closed();
		expect(client.getState()).toMatchObject({
			lifecycle: 'reconnect_wait', lastError: 'frame_length',
		});
	});

	it('ignores stale process and TCP callbacks from previous generations', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		client.start();
		const staleProcess = harness.processes[0]!;
		staleProcess.callbacks.exited();
		harness.clock.fireNext();
		staleProcess.callbacks.stdout(frameMumbleV2Record(ready()));
		expect(harness.tcp).toHaveLength(0);

		harness.sendReady(1);
		const staleTcp = harness.tcp[0]!;
		staleTcp.callbacks.closed();
		harness.clock.fireNext();
		staleTcp.callbacks.connected();
		staleTcp.callbacks.data(frameMumbleV2Record(welcome(NONCE_A)));
		expect(client.getState().lifecycle).toBe('connecting');
		expect(harness.tcp).toHaveLength(2);
	});

	it('makes helper exit authoritative over an active connection and ignores its late close', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		harness.handshakeToHealthy(client, NONCE_A);
		const staleTcp = harness.tcp[0]!;
		harness.processes[0]!.callbacks.exited();
		expect(client.getState()).toMatchObject({
			lifecycle: 'restart_wait', lastError: 'helper_exited',
			hasProcessToken: false, hasDiscoveredPort: false, hasActiveNonce: false,
		});
		staleTcp.callbacks.closed();
		expect(client.getState().lifecycle).toBe('restart_wait');
	});

	it('invalidates all generations on shutdown', () => {
		const harness = new ClientHarness();
		const client = harness.create();
		client.start();
		const process = harness.processes[0]!;
		client.shutdown();
		process.callbacks.stdout(frameMumbleV2Record(ready()));
		process.callbacks.exited();
		expect(client.getState()).toEqual({
			lifecycle: 'shutdown',
			lastError: null,
			backoffAttempt: 0,
			backoffDelayMs: null,
			hasProcessToken: false,
			hasDiscoveredPort: false,
			hasActiveNonce: false,
		});
		expect(harness.tcp).toHaveLength(0);
	});
});

interface FakeProcess {
	callbacks: MumbleV2ProcessCallbacks;
	writes: Uint8Array[];
	stopped: boolean;
}

interface FakeTcp {
	callbacks: MumbleV2TcpCallbacks;
	host: string;
	port: number;
	writes: Uint8Array[];
	closed: boolean;
}

class FakeClock {
	private nextId = 1;
	private readonly timers: Array<{
		id: number;
		delayMs: number;
		callback: () => void;
		cancelled: boolean;
		fired: boolean;
	}> = [];

	schedule(callback: () => void, delayMs: number): number {
		const timer = { id: this.nextId, delayMs, callback, cancelled: false, fired: false };
		this.nextId += 1;
		this.timers.push(timer);
		return timer.id;
	}

	cancel(handle: unknown): void {
		const timer = this.timers.find((candidate) => candidate.id === handle);
		if (timer !== undefined) timer.cancelled = true;
	}

	nextDelay(): number | null {
		return this.timers.find((timer) => !timer.cancelled && !timer.fired)?.delayMs ?? null;
	}

	fireNext(): void {
		const timer = this.timers.find((candidate) => !candidate.cancelled && !candidate.fired);
		if (timer === undefined) throw new Error('No active timer.');
		timer.fired = true;
		timer.callback();
	}
}

class ClientHarness {
	readonly clock = new FakeClock();
	readonly processes: FakeProcess[] = [];
	readonly tcp: FakeTcp[] = [];
	readonly randomOutputs: Uint8Array[] = [];
	private randomSeed = 0;

	create(overrides: Partial<MumbleV2ClientPorts> = {}): MumbleV2Client {
		return new MumbleV2Client({
			process: {
				spawn: (callbacks) => {
					const process: FakeProcess = { callbacks, writes: [], stopped: false };
					this.processes.push(process);
					const handle: MumbleV2ProcessHandle = {
						writeStdin: (chunk) => process.writes.push(chunk),
						stop: () => { process.stopped = true; },
					};
					return handle;
				},
			},
			tcp: {
				connect: (host, port, callbacks) => {
					const tcp: FakeTcp = { callbacks, host, port, writes: [], closed: false };
					this.tcp.push(tcp);
					const handle: MumbleV2TcpHandle = {
						write: (chunk) => tcp.writes.push(chunk),
						close: () => { tcp.closed = true; },
					};
					return handle;
				},
			},
			clock: this.clock,
			random: {
				randomBytes: (length) => {
					const bytes = new Uint8Array(length).fill(this.randomSeed);
					this.randomSeed += 1;
					this.randomOutputs.push(bytes);
					return bytes;
				},
			},
			...overrides,
		});
	}

	handshakeToWelcome(client: MumbleV2Client, nonce: string): void {
		client.start();
		this.sendReady(0);
		this.tcp[0]!.callbacks.connected();
		this.tcp[0]!.callbacks.data(frameMumbleV2Record(welcome(nonce)));
		expect(client.getState().lifecycle).toBe('awaiting_first_sequenced');
	}

	handshakeToHealthy(client: MumbleV2Client, nonce: string): void {
		this.handshakeToWelcome(client, nonce);
		this.tcp[0]!.callbacks.data(frameMumbleV2Record(heartbeat(nonce, 0)));
		expect(client.getState().lifecycle).toBe('healthy');
	}

	sendReady(processIndex: number): void {
		this.processes[processIndex]!.callbacks.stdout(frameMumbleV2Record(ready()));
	}

	processRecord(processIndex: number, writeIndex: number): MumbleV2ProtocolRecordV1 {
		return decodeFrame(this.processes[processIndex]!.writes[writeIndex]!);
	}

	tcpRecord(tcpIndex: number, writeIndex: number): MumbleV2ProtocolRecordV1 {
		return decodeFrame(this.tcp[tcpIndex]!.writes[writeIndex]!);
	}
}

function ready(): MumbleV2ProtocolRecordV1 {
	return { kind: 'ready', version: 1, host: '127.0.0.1', port: 49_152 };
}

function welcome(nonce: string): MumbleV2ProtocolRecordV1 {
	return { kind: 'welcome', version: 1, nonce, heartbeatIntervalMs: 500 };
}

function heartbeat(nonce: string, sequence: number): MumbleV2ProtocolRecordV1 {
	return { kind: 'heartbeat', version: 1, nonce, sequence, sourceStatus: 'warming_up' };
}

function sample(nonce: string, sequence: number): MumbleV2ProtocolRecordV1 {
	return { version: 1, nonce, sequence, tick: 7, mapId: 866, activity: 'link_advancing' };
}

function tokenOf(record: MumbleV2ProtocolRecordV1): string {
	if (!('kind' in record) || (record.kind !== 'bootstrap' && record.kind !== 'hello')) {
		throw new Error('Expected token record.');
	}
	return record.token;
}

function decodeFrame(frame: Uint8Array): MumbleV2ProtocolRecordV1 {
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const length = view.getUint32(0, false);
	expect(length).toBe(frame.byteLength - 4);
	const decoded = decodeMumbleV2Payload(frame.subarray(4));
	if (!decoded.ok) throw new Error(decoded.error);
	return decoded.record;
}

function frameUnchecked(record: unknown): Uint8Array {
	const payload = new TextEncoder().encode(JSON.stringify(record));
	const framed = new Uint8Array(payload.byteLength + 4);
	new DataView(framed.buffer).setUint32(0, payload.byteLength, false);
	framed.set(payload, 4);
	return framed;
}

function join(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}
