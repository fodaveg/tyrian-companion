import {
	MUMBLE_V2_TRANSPORT_CONTRACT,
	type MumbleV2ChannelError,
	type MumbleV2HeartbeatRecordV1,
	type MumbleV2IpcFrameV1,
	type MumbleV2LifecycleState,
	type MumbleV2ProtocolRecordV1,
} from './mumble-v2-contract';
import {
	decodeMumbleV2Payload,
	encodeMumbleV2Base64Url,
	frameMumbleV2Record,
	MumbleV2CodecError,
	MumbleV2RecordFramer,
} from './mumble-v2-codec';

export interface MumbleV2ClockPort {
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export interface MumbleV2RandomPort {
	randomBytes(length: number): Uint8Array;
}

export interface MumbleV2ProcessCallbacks {
	stdout(chunk: Uint8Array): void;
	exited(): void;
}

export interface MumbleV2ProcessHandle {
	writeStdin(chunk: Uint8Array): void;
	stop(): void;
}

export interface MumbleV2ProcessPort {
	spawn(callbacks: MumbleV2ProcessCallbacks): MumbleV2ProcessHandle;
}

export interface MumbleV2TcpCallbacks {
	connected(): void;
	data(chunk: Uint8Array): void;
	closed(): void;
}

export interface MumbleV2TcpHandle {
	write(chunk: Uint8Array): void;
	close(): void;
}

export interface MumbleV2TcpPort {
	connect(host: '127.0.0.1', port: number, callbacks: MumbleV2TcpCallbacks): MumbleV2TcpHandle;
}

export type MumbleV2ClientRecord = MumbleV2HeartbeatRecordV1 | MumbleV2IpcFrameV1;

export interface MumbleV2ClientPorts {
	process: MumbleV2ProcessPort;
	tcp: MumbleV2TcpPort;
	clock: MumbleV2ClockPort;
	random: MumbleV2RandomPort;
	onRecord?: (record: Readonly<MumbleV2ClientRecord>) => void;
	onStateChange?: (state: Readonly<MumbleV2ClientState>) => void;
	onError?: (error: MumbleV2ChannelError) => void;
}

export interface MumbleV2ClientState {
	lifecycle: MumbleV2LifecycleState;
	lastError: MumbleV2ChannelError | null;
	backoffAttempt: number;
	backoffDelayMs: number | null;
	hasProcessToken: boolean;
	hasDiscoveredPort: boolean;
	hasActiveNonce: boolean;
}

/**
 * Side-effect-free orchestration core: process, TCP, clock and randomness are
 * explicit ports, so construction never launches a helper or opens a socket.
 */
export class MumbleV2Client {
	private lifecycle: MumbleV2LifecycleState = 'awaiting_bootstrap';
	private lastError: MumbleV2ChannelError | null = null;
	private backoffAttempt = 0;
	private backoffDelayMs: number | null = null;
	private running = false;

	private processGeneration = 0;
	private connectionGeneration = 0;
	private timerGeneration = 0;
	private processHandle: MumbleV2ProcessHandle | null = null;
	private tcpHandle: MumbleV2TcpHandle | null = null;
	private timerHandle: unknown = null;
	private stdoutFramer = new MumbleV2RecordFramer();
	private tcpFramer = new MumbleV2RecordFramer();

	private processToken: string | null = null;
	private discoveredPort: number | null = null;
	private activeNonce: string | null = null;
	private sequence: MumbleV2SequenceGuard | null = null;
	private readonly usedNonces = new Set<string>();

	constructor(private readonly ports: MumbleV2ClientPorts) {}

	getState(): MumbleV2ClientState {
		return {
			lifecycle: this.lifecycle,
			lastError: this.lastError,
			backoffAttempt: this.backoffAttempt,
			backoffDelayMs: this.backoffDelayMs,
			hasProcessToken: this.processToken !== null,
			hasDiscoveredPort: this.discoveredPort !== null,
			hasActiveNonce: this.activeNonce !== null,
		};
	}

	start(): void {
		if (this.running || this.lifecycle === 'shutdown') {
			throw new Error('Mumble v2 client cannot be started from its current state.');
		}
		this.running = true;
		this.startProcess();
	}

	shutdown(): void {
		if (this.lifecycle === 'shutdown') return;
		this.running = false;
		this.clearTimer();
		this.invalidateConnection();
		this.invalidateProcess();
		this.processToken = null;
		this.discoveredPort = null;
		this.lifecycle = 'shutdown';
		this.backoffDelayMs = null;
		this.publish();
	}

	private startProcess(): void {
		if (!this.running) return;
		this.clearTimer();
		this.invalidateConnection();
		this.invalidateProcess();
		this.lifecycle = 'awaiting_bootstrap';
		this.lastError = null;
		this.backoffDelayMs = null;
		this.discoveredPort = null;
		this.usedNonces.clear();
		this.stdoutFramer = new MumbleV2RecordFramer();
		this.processToken = this.createProcessToken();
		const generation = this.processGeneration;
		this.publish();
		if (!this.running || generation !== this.processGeneration
			|| this.lifecycle !== 'awaiting_bootstrap') return;
		try {
			const handle = this.ports.process.spawn({
				stdout: (chunk) => this.onProcessStdout(generation, chunk),
				exited: () => this.onProcessExited(generation),
			});
			if (!this.running || generation !== this.processGeneration
				|| this.lifecycle !== 'awaiting_bootstrap') {
				handle.stop();
				return;
			}
			this.processHandle = handle;
			this.lifecycle = 'awaiting_ready';
			this.publish();
			if (!this.running || generation !== this.processGeneration
				|| this.lifecycle !== 'awaiting_ready') return;
			this.armFailure(
				MUMBLE_V2_TRANSPORT_CONTRACT.discoveryTimeoutMs,
				'discovery_timeout',
				'awaiting_ready',
			);
			handle.writeStdin(frameMumbleV2Record({
				kind: 'bootstrap',
				version: 1,
				token: this.processToken,
			}));
		} catch {
			this.routeFailure('helper_exited');
		}
	}

	private onProcessStdout(generation: number, chunk: Uint8Array): void {
		if (!this.running || generation !== this.processGeneration) return;
		const framer = this.stdoutFramer;
		try {
			framer.push(chunk, (payload) => {
				if (this.running && generation === this.processGeneration) this.acceptDiscovery(payload);
			});
		} catch (error) {
			this.routeFailure(codecError(error));
		}
	}

	private acceptDiscovery(payload: Uint8Array): void {
		if (this.lifecycle !== 'awaiting_ready') {
			this.routeFailure('frame_schema');
			return;
		}
		const decoded = decodeMumbleV2Payload(payload);
		if (!decoded.ok) {
			this.routeFailure(decoded.error);
			return;
		}
		if (!('kind' in decoded.record) || decoded.record.kind !== 'ready') {
			this.routeFailure('frame_schema');
			return;
		}
		this.discoveredPort = decoded.record.port;
		this.beginConnection();
	}

	private beginConnection(): void {
		if (!this.running || this.discoveredPort === null || this.processToken === null) return;
		this.clearTimer();
		this.invalidateConnection();
		this.lifecycle = 'connecting';
		this.backoffDelayMs = null;
		this.tcpFramer = new MumbleV2RecordFramer();
		const generation = this.connectionGeneration;
		this.publish();
		if (!this.running || generation !== this.connectionGeneration
			|| this.lifecycle !== 'connecting') return;
		try {
			const pending: Array<() => void> = [];
			let handleReady = false;
			const dispatch = (callback: () => void): void => {
				if (handleReady) callback();
				else pending.push(callback);
			};
			const handle = this.ports.tcp.connect(
				MUMBLE_V2_TRANSPORT_CONTRACT.host,
				this.discoveredPort,
				{
					connected: () => dispatch(() => this.onConnected(generation)),
					data: (chunk) => dispatch(() => this.onTcpData(generation, chunk)),
					closed: () => dispatch(() => this.onTcpClosed(generation)),
				},
			);
			if (!this.currentConnection(generation) || this.lifecycle !== 'connecting') {
				handle.close();
				return;
			}
			this.tcpHandle = handle;
			this.armFailure(
				MUMBLE_V2_TRANSPORT_CONTRACT.connectTimeoutMs,
				'connect_timeout',
				'connecting',
			);
			handleReady = true;
			for (const callback of pending) callback();
		} catch {
			this.routeFailure('peer_closed');
		}
	}

	private onConnected(generation: number): void {
		if (!this.currentConnection(generation) || this.lifecycle !== 'connecting'
			|| this.processToken === null || this.tcpHandle === null) return;
		this.clearTimer();
		this.lifecycle = 'awaiting_hello';
		this.publish();
		if (!this.currentConnection(generation) || this.lifecycle !== 'awaiting_hello'
			|| this.processToken === null || this.tcpHandle === null) return;
		try {
			this.lifecycle = 'awaiting_welcome';
			this.publish();
			if (!this.currentConnection(generation) || this.lifecycle !== 'awaiting_welcome'
				|| this.processToken === null || this.tcpHandle === null) return;
			this.armFailure(
				MUMBLE_V2_TRANSPORT_CONTRACT.helloTimeoutMs,
				'auth_rejected',
				'awaiting_welcome',
			);
			this.tcpHandle.write(frameMumbleV2Record({
				kind: 'hello',
				version: 1,
				token: this.processToken,
			}));
		} catch {
			this.routeFailure('peer_closed');
		}
	}

	private onTcpData(generation: number, chunk: Uint8Array): void {
		if (!this.currentConnection(generation)) return;
		const framer = this.tcpFramer;
		try {
			framer.push(chunk, (payload) => {
				if (this.currentConnection(generation)) this.acceptTcpPayload(payload);
			});
		} catch (error) {
			this.routeFailure(codecError(error));
		}
	}

	private acceptTcpPayload(payload: Uint8Array): void {
		const decoded = decodeMumbleV2Payload(payload, {
			expectedNonce: this.activeNonce ?? undefined,
			expectedToken: this.processToken ?? undefined,
		});
		if (!decoded.ok) {
			this.routeFailure(decoded.error);
			return;
		}
		const record = decoded.record;
		if (this.lifecycle === 'awaiting_welcome') {
			this.acceptWelcome(record);
			return;
		}
		if (this.lifecycle === 'awaiting_first_sequenced') {
			if (!('kind' in record) || record.kind !== 'heartbeat') {
				this.routeFailure('frame_schema');
				return;
			}
			this.acceptSequenced(record);
			return;
		}
		if (this.lifecycle === 'healthy' && isSequenced(record)) {
			this.acceptSequenced(record);
			return;
		}
		this.routeFailure('frame_schema');
	}

	private acceptWelcome(record: MumbleV2ProtocolRecordV1): void {
		if (!('kind' in record) || record.kind !== 'welcome') {
			this.routeFailure('frame_schema');
			return;
		}
		if (this.usedNonces.has(record.nonce)) {
			this.routeFailure('nonce_mismatch');
			return;
		}
		this.clearTimer();
		this.usedNonces.add(record.nonce);
		this.activeNonce = record.nonce;
		this.sequence = new MumbleV2SequenceGuard(record.nonce);
		this.lifecycle = 'awaiting_first_sequenced';
		this.publish();
		if (!this.running || this.lifecycle !== 'awaiting_first_sequenced'
			|| this.activeNonce !== record.nonce) return;
		this.armFailure(
			MUMBLE_V2_TRANSPORT_CONTRACT.firstSequencedRecordTimeoutMs,
			'heartbeat_timeout',
			'awaiting_first_sequenced',
		);
	}

	private acceptSequenced(record: MumbleV2ClientRecord): void {
		const sequenceError = this.sequence === null ? 'nonce_mismatch' : this.sequence.accept(record);
		if (sequenceError !== null) {
			this.routeFailure(sequenceError);
			return;
		}
		this.clearTimer();
		if (this.lifecycle === 'awaiting_first_sequenced') {
			this.lifecycle = 'healthy';
			this.backoffAttempt = 0;
			this.backoffDelayMs = null;
			this.lastError = null;
			this.publish();
			if (!this.running || this.lifecycle !== 'healthy'
				|| this.activeNonce !== record.nonce) return;
		}
		this.deliver(() => this.ports.onRecord?.(record));
		if (!this.running || this.lifecycle !== 'healthy'
			|| this.activeNonce !== record.nonce) return;
		this.armFailure(
			MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatTimeoutMs,
			'heartbeat_timeout',
			'healthy',
		);
	}

	private onTcpClosed(generation: number): void {
		if (!this.currentConnection(generation)) return;
		this.tcpHandle = null;
		this.routeFailure(this.tcpFramer.finish() ?? 'peer_closed');
	}

	private onProcessExited(generation: number): void {
		if (!this.running || generation !== this.processGeneration) return;
		this.processHandle = null;
		this.routeFailure('helper_exited');
	}

	private routeFailure(error: MumbleV2ChannelError): void {
		if (!this.running || this.getState().lifecycle === 'shutdown') return;
		this.lastError = error;
		this.deliver(() => this.ports.onError?.(error));
		if (!this.running || this.getState().lifecycle === 'shutdown') return;
		const restart = error === 'helper_exited'
			|| this.lifecycle === 'awaiting_bootstrap'
			|| this.lifecycle === 'awaiting_ready'
			|| this.lifecycle === 'restart_wait';
		if (restart) this.scheduleRestart();
		else this.scheduleReconnect();
	}

	private scheduleRestart(): void {
		this.clearTimer();
		this.invalidateConnection();
		this.invalidateProcess();
		this.processToken = null;
		this.discoveredPort = null;
		this.lifecycle = 'restart_wait';
		const delay = this.takeBackoffDelay();
		this.publish();
		if (!this.running || this.lifecycle !== 'restart_wait') return;
		this.armRecovery(delay, () => this.startProcess(), 'restart_wait');
	}

	private scheduleReconnect(): void {
		this.clearTimer();
		this.invalidateConnection();
		this.lifecycle = 'reconnect_wait';
		const delay = this.takeBackoffDelay();
		this.publish();
		if (!this.running || this.lifecycle !== 'reconnect_wait') return;
		this.armRecovery(delay, () => this.beginConnection(), 'reconnect_wait');
	}

	private takeBackoffDelay(): number {
		const schedule = MUMBLE_V2_TRANSPORT_CONTRACT.reconnectBackoffMs;
		const delay = schedule[Math.min(this.backoffAttempt, schedule.length - 1)]
			?? schedule[schedule.length - 1]!;
		this.backoffAttempt += 1;
		this.backoffDelayMs = delay;
		return delay;
	}

	private armFailure(
		delayMs: number,
		error: MumbleV2ChannelError,
		expectedState: MumbleV2LifecycleState,
	): void {
		this.setTimer(delayMs, () => {
			if (this.lifecycle === expectedState) this.routeFailure(error);
		});
	}

	private armRecovery(
		delayMs: number,
		recover: () => void,
		expectedState: 'reconnect_wait' | 'restart_wait',
	): void {
		this.setTimer(delayMs, () => {
			if (this.lifecycle === expectedState) recover();
		});
	}

	private setTimer(delayMs: number, callback: () => void): void {
		this.clearTimer();
		const generation = this.timerGeneration;
		this.timerHandle = this.ports.clock.schedule(() => {
			if (!this.running || generation !== this.timerGeneration) return;
			this.timerHandle = null;
			callback();
		}, delayMs);
	}

	private clearTimer(): void {
		this.timerGeneration += 1;
		if (this.timerHandle !== null) this.ports.clock.cancel(this.timerHandle);
		this.timerHandle = null;
	}

	private invalidateConnection(): void {
		this.connectionGeneration += 1;
		const handle = this.tcpHandle;
		this.tcpHandle = null;
		this.activeNonce = null;
		this.sequence = null;
		this.tcpFramer = new MumbleV2RecordFramer();
		try {
			handle?.close();
		} catch {
			// The lifecycle is already failing closed; adapter cleanup cannot change its route.
		}
	}

	private invalidateProcess(): void {
		this.processGeneration += 1;
		const handle = this.processHandle;
		this.processHandle = null;
		this.stdoutFramer = new MumbleV2RecordFramer();
		try {
			handle?.stop();
		} catch {
			// The next generation is already authoritative.
		}
	}

	private currentConnection(generation: number): boolean {
		return this.running && generation === this.connectionGeneration;
	}

	private randomBytes(length: number): Uint8Array {
		const bytes = this.ports.random.randomBytes(length);
		if (bytes.byteLength !== length) throw new Error('CSPRNG port returned an invalid length.');
		return bytes;
	}

	private createProcessToken(): string {
		const bytes = this.randomBytes(MUMBLE_V2_TRANSPORT_CONTRACT.tokenEntropyBytes);
		try {
			return encodeMumbleV2Base64Url(bytes);
		} finally {
			bytes.fill(0);
		}
	}

	private publish(): void {
		this.deliver(() => this.ports.onStateChange?.(this.getState()));
	}

	private deliver(callback: () => void): void {
		try {
			callback();
		} catch {
			// Observer code has no authority over the protocol lifecycle.
		}
	}
}

/** Exact nonce-bound sequence checker, exported so boundary adapters can share its invariant. */
export class MumbleV2SequenceGuard {
	private exhausted = false;

	constructor(
		private readonly nonce: string,
		private expected: number = MUMBLE_V2_TRANSPORT_CONTRACT.initialSequence,
	) {}

	accept(record: { nonce: string; sequence: number }): MumbleV2ChannelError | null {
		if (record.nonce !== this.nonce) return 'nonce_mismatch';
		if (this.exhausted || !Number.isSafeInteger(record.sequence)
			|| record.sequence < MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMinimum
			|| record.sequence > MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMaximum
			|| record.sequence !== this.expected) return 'sequence_mismatch';
		if (record.sequence === MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMaximum) this.exhausted = true;
		else this.expected += MUMBLE_V2_TRANSPORT_CONTRACT.sequenceStep;
		return null;
	}
}

function isSequenced(record: MumbleV2ProtocolRecordV1): record is MumbleV2ClientRecord {
	return 'sequence' in record;
}

function codecError(error: unknown): MumbleV2ChannelError {
	return error instanceof MumbleV2CodecError ? error.code : 'frame_schema';
}
