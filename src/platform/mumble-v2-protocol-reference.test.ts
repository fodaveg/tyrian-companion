import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
	MUMBLE_V2_CHANNEL_ERRORS,
	MUMBLE_V2_LIFECYCLE_CONTRACT,
	MUMBLE_V2_LIFECYCLE_STATES,
	MUMBLE_V2_MESSAGE_KEYS,
	MUMBLE_V2_RECOMMENDED_DEFAULTS,
	MUMBLE_V2_SOURCE_LIMITS,
	MUMBLE_V2_SOURCE_STATUSES,
	MUMBLE_V2_TRANSPORT_CONTRACT,
	type MumbleV2ChannelError,
	type MumbleV2LifecycleEvent,
	type MumbleV2LifecycleState,
} from './mumble-v2-contract';

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_TOKEN = '___________________________________________';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_NONCE = '______________________';
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_SEQUENCE = MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMaximum;

describe('H8.4 framed record reference', () => {
	it('uses one uint32 big-endian length for every bootstrap, discovery and TCP record', () => {
		const records = protocolVectors();
		for (const record of records) {
			const payload = Buffer.from(JSON.stringify(record), 'utf8');
			const framed = frame(payload);
			expect(framed.readUInt32BE(0)).toBe(payload.length);
			expect(framed.subarray(4)).toEqual(payload);
		}
		expect(MUMBLE_V2_TRANSPORT_CONTRACT).toMatchObject({
			recordLengthBytes: 4,
			maximumBufferedRecordBytes: 516,
			inputChunkRetention: 'none',
			recordDelivery: 'incremental_ownership_transfer_before_callback',
			recordLengthEncoding: 'uint32_big_endian',
			payloadEncoding: 'utf8_json',
			minimumFrameBytes: 1,
			maxFrameBytes: 512,
		});
	});

	it('bounds one complete record buffer to four header bytes plus 512 payload bytes', () => {
		const payload = Buffer.alloc(512, 0x20);
		const complete = frame(payload);
		expect(complete).toHaveLength(516);
		expect(MUMBLE_V2_TRANSPORT_CONTRACT.maximumBufferedRecordBytes).toBe(516);
		const framer = new ReferenceFramer();
		let callbackRetainedBytes = 0;
		framer.push(complete, (record) => {
			callbackRetainedBytes = framer.retainedBytes;
			expect(record).toEqual(payload);
		});
		expect(callbackRetainedBytes).toBe(516);
		expect(framer.retainedBytes).toBe(4);
		expect(framer.maximumRetainedBytes).toBe(516);
		expect(deliveryMemoryViolations(ReferenceFramer.prototype.push.toString())).toEqual([]);
		expect(deliveryMemoryViolations('consume(Buffer.from(payload));'))
			.toEqual(['payload-copy']);
		expect(framer.finish()).toBeNull();
	});

	it('handles fragmentation and coalescing without accepting a truncated record', () => {
		const first = frameJson(protocolVectors()[0]);
		const second = frameJson(protocolVectors()[1]);
		const fragmented = new ReferenceFramer();
		const found: Buffer[] = [];
		for (const byte of first) fragmented.push(Buffer.of(byte), (record) => found.push(record));
		expect(found).toEqual([first.subarray(4)]);
		expect(fragmented.finish()).toBeNull();

		const coalesced = new ReferenceFramer();
		expect(pushAndCollect(coalesced, Buffer.concat([first, second]))).toEqual([
			first.subarray(4),
			second.subarray(4),
		]);
		expect(coalesced.finish()).toBeNull();

		const truncated = new ReferenceFramer();
		expect(pushAndCollect(truncated, first.subarray(0, first.length - 1))).toEqual([]);
		expect(truncated.finish()).toBe('frame_length');
	});

	it('drains an arbitrarily large coalesced chunk without retaining more than 516 bytes', () => {
		const encoded = frameJson({ version: 1 });
		const hugeChunk = Buffer.concat(Array.from({ length: 4_096 }, () => encoded));
		const framer = new ReferenceFramer();
		let records = 0;
		framer.push(hugeChunk, () => { records += 1; });
		expect(records).toBe(4_096);
		expect(framer.retainedBytes).toBe(4);
		expect(framer.maximumRetainedBytes).toBeLessThanOrEqual(516);
		expect(framerMemoryViolations(framer.maximumRetainedBytes)).toEqual([]);
		expect(framerMemoryViolations(517)).toEqual(['buffer-bound']);
	});

	it('bounds retained bytes across partial headers and partial bodies', () => {
		const encoded = frame(Buffer.alloc(512, 0x20));
		const framer = new ReferenceFramer();
		expect(pushAndCollect(framer, encoded.subarray(0, 2))).toEqual([]);
		expect(framer.retainedBytes).toBe(4);
		expect(pushAndCollect(framer, encoded.subarray(2, 515))).toEqual([]);
		expect(framer.retainedBytes).toBe(516);
		expect(pushAndCollect(framer, encoded.subarray(515))).toEqual([encoded.subarray(4)]);
		expect(framer.maximumRetainedBytes).toBe(516);
	});

	it('rejects zero, 513, invalid UTF-8, BOM and trailing JSON causally', () => {
		for (const length of [0, 513]) {
			const header = Buffer.alloc(4);
			header.writeUInt32BE(length);
			expect(() => new ReferenceFramer().push(header, () => undefined)).toThrow('frame_length');
		}
		expect(decodePayload(Buffer.from([0xc3, 0x28]))).toEqual({ ok: false, error: 'frame_utf8' });
		expect(decodePayload(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toEqual({
			ok: false,
			error: 'frame_utf8',
		});
		expect(decodePayload(Buffer.from('{} trailing', 'utf8'))).toEqual({
			ok: false,
			error: 'frame_json',
		});
	});
});

describe('H8.4 exact record validation reference', () => {
	it('accepts exactly the six schemas and their closed key sets', () => {
		for (const record of protocolVectors()) {
			const decoded = decodePayload(Buffer.from(JSON.stringify(record), 'utf8'));
			expect(decoded.ok).toBe(true);
			if (decoded.ok) expect(validateRecord(decoded.value)).toBeNull();
		}
		expect(Object.keys(MUMBLE_V2_MESSAGE_KEYS)).toEqual([
			'bootstrap', 'ready', 'hello', 'welcome', 'heartbeat', 'sample',
		]);
	});

	it('rejects missing, extra and duplicate properties as frame_schema', () => {
		expect(validateJson({ kind: 'ready', version: 1, host: '127.0.0.1' })).toBe('frame_schema');
		expect(validateJson({
			kind: 'ready', version: 1, host: '127.0.0.1', port: 49_152, unexpected: true,
		})).toBe('frame_schema');
		expect(validateSource(`{"kind":"ready","version":1,"host":"127.0.0.1","port":49152,"port":49153}`))
			.toBe('frame_schema');
	});

	it('rejects non-object JSON, external hosts and invalid discovered ports', () => {
		for (const value of [null, [], 'ready', 1, true]) {
			expect(validateJson(value)).toBe('frame_schema');
		}
		for (const host of ['localhost', '::1', '0.0.0.0', '192.168.1.20']) {
			expect(validateJson({ kind: 'ready', version: 1, host, port: 49_152 }))
				.toBe('discovery_invalid');
		}
		for (const port of [0, 65_536, -1, 1.5, '49152']) {
			expect(validateJson({ kind: 'ready', version: 1, host: '127.0.0.1', port }))
				.toBe('discovery_invalid');
		}
	});

	it('rejects version downgrade and unknown versions before use', () => {
		for (const version of [0, 2, '1', null]) {
			expect(validateJson({ kind: 'hello', version, token: TOKEN })).toBe('version_unsupported');
		}
	});

	it('pins token and nonce encodings, lifetimes and their only permitted surfaces', () => {
		expect(isEncodedSecret(TOKEN, 43, 32)).toBe(true);
		expect(isEncodedSecret(NONCE, 22, 16)).toBe(true);
		for (const value of [`${TOKEN}=`, TOKEN.slice(1), `${TOKEN}*`, 'á'.repeat(43)]) {
			expect(isEncodedSecret(value, 43, 32)).toBe(false);
		}
		for (const value of [`${NONCE}=`, NONCE.slice(1), `${NONCE}*`, 'á'.repeat(22)]) {
			expect(isEncodedSecret(value, 22, 16)).toBe(false);
		}
		expect(MUMBLE_V2_TRANSPORT_CONTRACT).toMatchObject({
			tokenEntropyBytes: 32,
			tokenEncodedCharacters: 43,
			tokenRandomness: 'csprng',
			tokenEncoding: 'base64url_no_padding',
			tokenScope: 'per_process',
			tokenComparison: 'constant_time_exact_32_bytes',
			tokenBinding: 'hello_equals_bootstrap_same_helper_process',
			tokenRetainedAcrossSameProcessReconnect: true,
			tokenInvalidatedOn: [
				'helper_exited', 'process_restarted', 'stdin_eof', 'shutdown_requested',
			],
			tokenSurfaces: ['stdin_bootstrap', 'tcp_hello'],
			tokenForbiddenSurfaces: [
				'argv', 'env', 'file', 'log', 'stdout', 'stderr', 'discovery', 'settings',
				'indexeddb', 'vault', 'telemetry',
			],
			nonceEntropyBytes: 16,
			nonceEncodedCharacters: 22,
			nonceRandomness: 'csprng',
			nonceEncoding: 'base64url_no_padding',
			nonceScope: 'per_connection',
			requireFreshNoncePerConnection: true,
			nonceSurfaces: ['welcome', 'heartbeat', 'sample'],
		});
		expect(validateJson({ kind: 'bootstrap', version: 1, token: OTHER_TOKEN }, NONCE, TOKEN))
			.toBeNull();
		expect(validateJson({ kind: 'hello', version: 1, token: OTHER_TOKEN }, NONCE, TOKEN))
			.toBe('auth_rejected');
	});

	it('uses an exact constant-time byte comparison and turns red for naive equality', () => {
		expect(compareEncodedToken(TOKEN, TOKEN)).toBe(true);
		expect(compareEncodedToken(TOKEN, OTHER_TOKEN)).toBe(false);
		expect(compareEncodedToken(TOKEN.slice(1), TOKEN)).toBe(false);
		expect(tokenComparisonViolations(compareEncodedToken.toString())).toEqual([]);
		expect(tokenComparisonViolations('return actual === expected;')).toEqual(['constant-time']);
	});

	it('pins the exact channel errors and source statuses', () => {
		expect(MUMBLE_V2_CHANNEL_ERRORS).toEqual([
			'discovery_timeout', 'discovery_invalid', 'connect_timeout', 'auth_rejected',
			'version_unsupported', 'frame_length', 'frame_utf8', 'frame_json', 'frame_schema',
			'nonce_mismatch', 'sequence_mismatch', 'heartbeat_timeout', 'peer_closed',
			'helper_exited',
		]);
		expect(MUMBLE_V2_SOURCE_STATUSES).toEqual([
			'warming_up', 'mapping_unavailable', 'layout_unsupported', 'sample_unstable',
			'sample_invalid',
		]);
	});
});

describe('H8.4 sequencing and liveness reference', () => {
	it('shares one sequence across heartbeat and sample from zero with exactly +1', () => {
		const sequence = new ReferenceSequence(NONCE);
		expect(sequence.accept({ nonce: NONCE, sequence: 0 })).toBeNull();
		expect(sequence.accept({ nonce: NONCE, sequence: 1 })).toBeNull();
		expect(sequence.accept({ nonce: NONCE, sequence: 3 })).toBe('sequence_mismatch');

		for (const values of [[0, 0, 0], [0, 0, -1], [1, 1, 0]] as const) {
			const replay = new ReferenceSequence(NONCE, values[0]);
			expect(replay.accept({ nonce: NONCE, sequence: values[1] })).toBeNull();
			expect(replay.accept({ nonce: NONCE, sequence: values[2] })).toBe('sequence_mismatch');
		}
	});

	it('rejects stale nonce, overflow and wrap', () => {
		const stale = new ReferenceSequence(NONCE);
		expect(stale.accept({ nonce: OTHER_NONCE, sequence: 0 })).toBe('nonce_mismatch');
		expect(new ReferenceSequence(NONCE).accept({ nonce: NONCE, sequence: MAX_SEQUENCE + 1 }))
			.toBe('sequence_mismatch');

		const boundary = new ReferenceSequence(NONCE, MAX_SEQUENCE);
		expect(boundary.accept({ nonce: NONCE, sequence: MAX_SEQUENCE })).toBeNull();
		expect(boundary.accept({ nonce: NONCE, sequence: 0 })).toBe('sequence_mismatch');
	});

	it('accepts uint32 tick rollover as advance without changing sequence rules', () => {
		expect(tickActivity(MUMBLE_V2_SOURCE_LIMITS.unsigned32Maximum, 0, 500)).toBe('link_advancing');
		expect(tickActivity(7, 7, 1_499)).toBe('link_advancing');
		expect(tickActivity(7, 7, 1_500)).toBe('link_stalled');
	});

	it('pins 500/1500/2000/5000 deadlines, sleep behavior and reconnect schedule', () => {
		const clock = new FakeClock();
		expect(clock.advance(499)).toBe(499);
		expect(deadlineReached(0, clock.now, 500)).toBe(false);
		expect(deadlineReached(0, clock.advance(1), 500)).toBe(true);
		expect(deadlineReached(0, clock.advance(999), 1_500)).toBe(false);
		expect(deadlineReached(0, clock.advance(1), 1_500)).toBe(true);
		expect(deadlineReached(0, clock.advance(500), 2_000)).toBe(true);
		expect(deadlineReached(0, clock.advance(3_000), 5_000)).toBe(true);

		const afterSleep = clock.advance(60_000);
		expect(deadlineReached(5_000, afterSleep, 2_000)).toBe(true);
		expect(reconnectDelay(0)).toBe(250);
		expect(reconnectDelay(1)).toBe(500);
		expect(reconnectDelay(2)).toBe(1_000);
		expect(reconnectDelay(3)).toBe(2_000);
		expect(reconnectDelay(4)).toBe(5_000);
		expect(reconnectDelay(50)).toBe(5_000);
	});

	it('keeps channel health, source health and stalled activity independent', () => {
		expect(MUMBLE_V2_TRANSPORT_CONTRACT).toMatchObject({
			channelAxis: 'transport_lifecycle',
			sourceAxis: 'heartbeat_source_status',
			stalledAxis: 'sample_activity',
			heartbeatIntervalMs: 500,
			sourceStalledAfterMs: 1_500,
			heartbeatTimeoutMs: 2_000,
			discoveryTimeoutMs: 5_000,
		});
		expect(MUMBLE_V2_SOURCE_STATUSES).not.toContain('link_stalled');
		expect(MUMBLE_V2_CHANNEL_ERRORS).not.toContain('sample_invalid');
	});

	it('allows one authenticated and one pending connection only', () => {
		expect(MUMBLE_V2_TRANSPORT_CONTRACT).toMatchObject({
			authenticatedConnectionMaximum: 1,
			pendingConnectionMaximum: 1,
			rejectAdditionalConnections: true,
		});
	});
});

describe('H8.4 deterministic lifecycle reference', () => {
	it('accepts each record only in its exact phase and rejects a valid record in every wrong phase', () => {
		const vectors = protocolVectors();
		const allowed = [
			['awaiting_bootstrap'],
			['awaiting_ready'],
			['awaiting_hello'],
			['awaiting_welcome'],
			['awaiting_first_sequenced', 'healthy'],
			['awaiting_first_sequenced', 'healthy'],
		] as const;
		for (const [index, record] of vectors.entries()) {
			for (const state of MUMBLE_V2_LIFECYCLE_STATES) {
				const expected = allowed[index]?.includes(state as never) === true ? null : 'frame_schema';
				expect(validateRecordForState(record, state), `${String(index)}:${state}`).toBe(expected);
			}
		}
	});

	it('maps every phase timeout to the exact deadline and channel error', () => {
		expect(MUMBLE_V2_LIFECYCLE_CONTRACT.timeouts).toEqual([
			{ name: 'discovery_timeout', state: 'awaiting_ready', timeoutMs: 5_000, error: 'discovery_timeout', deadlineStartsAfter: 'bootstrap_accepted', deadlineRefreshesAfter: [] },
			{ name: 'connect_timeout', state: 'connecting', timeoutMs: 2_000, error: 'connect_timeout', deadlineStartsAfter: 'ready_accepted', deadlineRefreshesAfter: [] },
			{ name: 'hello_timeout', state: 'awaiting_hello', timeoutMs: 2_000, error: 'auth_rejected', deadlineStartsAfter: 'tcp_connected', deadlineRefreshesAfter: [] },
			{ name: 'hello_timeout', state: 'awaiting_welcome', timeoutMs: 2_000, error: 'auth_rejected', deadlineStartsAfter: 'tcp_connected', deadlineRefreshesAfter: [] },
			{ name: 'first_sequenced_record_timeout', state: 'awaiting_first_sequenced', timeoutMs: 2_000, error: 'heartbeat_timeout', deadlineStartsAfter: 'welcome_accepted', deadlineRefreshesAfter: [] },
			{ name: 'heartbeat_timeout', state: 'healthy', timeoutMs: 2_000, error: 'heartbeat_timeout', deadlineStartsAfter: 'welcome_accepted', deadlineRefreshesAfter: ['heartbeat_accepted', 'sample_accepted'] },
		]);
		for (const timeout of MUMBLE_V2_LIFECYCLE_CONTRACT.timeouts) {
			expect(timeoutForState(timeout.state, timeout.timeoutMs - 1)).toBeNull();
			expect(timeoutForState(timeout.state, timeout.timeoutMs)).toBe(timeout.error);
		}
	});

	it('refreshes channel liveness on every valid heartbeat or sample', () => {
		const healthyTimeout = MUMBLE_V2_LIFECYCLE_CONTRACT.timeouts.find(
			(timeout) => timeout.state === 'healthy',
		);
		expect(healthyTimeout?.deadlineRefreshesAfter)
			.toEqual(['heartbeat_accepted', 'sample_accepted']);
		const clock = new FakeClock();
		let refreshedAt = clock.now;
		for (let sample = 0; sample < 10; sample += 1) {
			clock.advance(500);
			expect(deadlineReached(refreshedAt, clock.now, 2_000)).toBe(false);
			refreshedAt = clock.now;
		}
		expect(deadlineReached(refreshedAt, clock.advance(1_999), 2_000)).toBe(false);
		expect(deadlineReached(refreshedAt, clock.advance(1), 2_000)).toBe(true);
		expect(livenessRefreshViolations(['heartbeat_accepted', 'sample_accepted'])).toEqual([]);
		expect(livenessRefreshViolations(['heartbeat_accepted'])).toEqual(['missing-sample']);
	});

	it('walks the exact handshake and resets backoff only after the first sequenced record', () => {
		const lifecycle = new ReferenceLifecycle();
		expect(lifecycle.acceptRecord(protocolVectors()[0] ?? {})).toBeNull();
		expect(lifecycle.state).toBe('awaiting_ready');
		expect(lifecycle.acceptRecord(protocolVectors()[1] ?? {})).toBeNull();
		expect(lifecycle.state).toBe('connecting');
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(protocolVectors()[2] ?? {})).toBeNull();
		expect(lifecycle.acceptRecord(protocolVectors()[3] ?? {})).toBeNull();
		expect(lifecycle.state).toBe('awaiting_first_sequenced');

		expect(lifecycle.fail('heartbeat_timeout')).toBe(250);
		expect(lifecycle.event('reconnect_due')).toBeNull();
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(protocolVectors()[2] ?? {})).toBeNull();
		expect(lifecycle.acceptRecord(welcomeRecord(OTHER_NONCE))).toBeNull();
		expect(lifecycle.fail('heartbeat_timeout')).toBe(500);

		expect(lifecycle.event('reconnect_due')).toBeNull();
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(protocolVectors()[2] ?? {})).toBeNull();
		expect(lifecycle.acceptRecord(welcomeRecord('BBBBBBBBBBBBBBBBBBBBBB'))).toBeNull();
		expect(lifecycle.acceptRecord(heartbeatRecord('BBBBBBBBBBBBBBBBBBBBBB', 0))).toBeNull();
		expect(lifecycle.state).toBe('healthy');
		expect(lifecycle.fail('peer_closed')).toBe(250);

		expect(lifecycle.event('reconnect_due')).toBeNull();
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(protocolVectors()[2] ?? {})).toBeNull();
		expect(lifecycle.acceptRecord(welcomeRecord('CCCCCCCCCCCCCCCCCCCCCC'))).toBeNull();
		expect(lifecycle.acceptRecord(sampleRecord('CCCCCCCCCCCCCCCCCCCCCC', 0))).toBeNull();
		expect(lifecycle.state).toBe('healthy');
		expect(lifecycle.fail('peer_closed')).toBe(250);
	});

	it('routes pre-ready failure to process restart and never connects without a ready port', () => {
		const lifecycle = new ReferenceLifecycle();
		expect(lifecycle.acceptRecord(bootstrapRecord(TOKEN))).toBeNull();
		expect(lifecycle.fail('discovery_timeout')).toBeNull();
		expect(lifecycle.state).toBe('restart_wait');
		expect(lifecycle.hasBoundToken).toBe(false);
		expect(lifecycle.hasDiscoveredPort).toBe(false);
		expect(lifecycle.event('reconnect_due')).toBe('frame_schema');
		expect(lifecycle.event('tcp_connected')).toBe('frame_schema');
		expect(lifecycle.event('process_restarted')).toBeNull();
		expect(lifecycle.state).toBe('awaiting_bootstrap');
	});

	it('routes helper exit from every non-terminal state and cannot reconnect to a dead helper', () => {
		for (const state of MUMBLE_V2_LIFECYCLE_STATES.filter((item) => item !== 'shutdown')) {
			const route = failureRouteFor(state, 'helper_exited');
			expect(route, state).toBeDefined();
			expect(route).toMatchObject({
				to: 'restart_wait',
				recoveryEvent: 'process_restarted',
				tokenDisposition: 'invalidate',
				portDisposition: 'invalidate',
				nonceDisposition: 'invalidate',
				sequenceDisposition: 'invalidate',
			});
			const lifecycle = new ReferenceLifecycle(state);
			expect(lifecycle.fail('helper_exited'), state).toBeNull();
			expect(lifecycle.state, state).toBe('restart_wait');
			expect(lifecycle.event('reconnect_due'), state).toBe('frame_schema');
		}

		const reconnecting = connectedLifecycle(TOKEN, NONCE);
		expect(reconnecting.fail('peer_closed')).toBe(250);
		expect(reconnecting.state).toBe('reconnect_wait');
		expect(reconnecting.hasDiscoveredPort).toBe(true);
		expect(reconnecting.fail('helper_exited')).toBeNull();
		expect(reconnecting.state).toBe('restart_wait');
		expect(reconnecting.hasBoundToken).toBe(false);
		expect(reconnecting.hasDiscoveredPort).toBe(false);
		expect(reconnecting.event('reconnect_due')).toBe('frame_schema');
	});

	it('binds hello to bootstrap, retains the token on reconnect and rotates it after helper exit', () => {
		const lifecycle = new ReferenceLifecycle();
		expect(lifecycle.acceptRecord(bootstrapRecord(TOKEN))).toBeNull();
		expect(lifecycle.acceptRecord(protocolVectors()[1] ?? {})).toBeNull();
		expect(lifecycle.hasDiscoveredPort).toBe(true);
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(helloRecord(OTHER_TOKEN))).toBe('auth_rejected');
		expect(lifecycle.acceptRecord(helloRecord(TOKEN))).toBeNull();
		expect(lifecycle.acceptRecord(welcomeRecord(NONCE))).toBeNull();
		expect(lifecycle.fail('peer_closed')).toBe(250);
		expect(lifecycle.hasBoundToken).toBe(true);
		expect(lifecycle.hasDiscoveredPort).toBe(true);
		expect(lifecycle.event('reconnect_due')).toBeNull();
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(helloRecord(TOKEN))).toBeNull();
		expect(lifecycle.acceptRecord(welcomeRecord(OTHER_NONCE))).toBeNull();

		expect(lifecycle.fail('helper_exited')).toBeNull();
		expect(lifecycle.state).toBe('restart_wait');
		expect(lifecycle.hasBoundToken).toBe(false);
		expect(lifecycle.hasDiscoveredPort).toBe(false);
		expect(lifecycle.event('reconnect_due')).toBe('frame_schema');
		expect(lifecycle.event('process_restarted')).toBeNull();
		expect(lifecycle.acceptRecord(bootstrapRecord(OTHER_TOKEN))).toBeNull();
		expect(lifecycle.acceptRecord(protocolVectors()[1] ?? {})).toBeNull();
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(helloRecord(TOKEN))).toBe('auth_rejected');
		expect(lifecycle.acceptRecord(helloRecord(OTHER_TOKEN))).toBeNull();
	});

	it('requires a fresh nonce and sequence zero, and refreshes deadlines only after valid records', () => {
		const lifecycle = connectedLifecycle(TOKEN, NONCE);
		expect(lifecycle.acceptRecord(heartbeatRecord(NONCE, 0), 500)).toBeNull();
		expect(lifecycle.healthDeadlineStartedAt).toBe(500);
		expect(lifecycle.acceptRecord(heartbeatRecord(NONCE, 2), 750)).toBe('sequence_mismatch');
		expect(lifecycle.healthDeadlineStartedAt).toBe(500);
		expect(lifecycle.fail('peer_closed')).toBe(250);
		expect(lifecycle.event('reconnect_due')).toBeNull();
		expect(lifecycle.event('tcp_connected')).toBeNull();
		expect(lifecycle.acceptRecord(helloRecord(TOKEN))).toBeNull();
		expect(lifecycle.acceptRecord(welcomeRecord(NONCE), 1_000)).toBe('nonce_mismatch');
		expect(lifecycle.healthDeadlineStartedAt).toBeNull();
		expect(lifecycle.acceptRecord(welcomeRecord(OTHER_NONCE), 1_100)).toBeNull();
		expect(lifecycle.acceptRecord(sampleRecord(NONCE, 0), 1_200)).toBe('nonce_mismatch');
		expect(lifecycle.healthDeadlineStartedAt).toBe(1_100);
		expect(lifecycle.acceptRecord(sampleRecord(OTHER_NONCE, 1), 1_300))
			.toBe('sequence_mismatch');
		expect(lifecycle.healthDeadlineStartedAt).toBe(1_100);
		expect(lifecycle.acceptRecord(sampleRecord(OTHER_NONCE, 0), 1_400)).toBeNull();
		expect(lifecycle.healthDeadlineStartedAt).toBe(1_400);
	});

	it('treats stdin EOF as terminal shutdown and invalidates process credentials', () => {
		const lifecycle = new ReferenceLifecycle();
		expect(lifecycle.acceptRecord(bootstrapRecord(TOKEN))).toBeNull();
		expect(lifecycle.event('stdin_eof')).toBeNull();
		expect(lifecycle.state).toBe('shutdown');
		expect(lifecycle.hasBoundToken).toBe(false);
		expect(lifecycle.acceptRecord(bootstrapRecord(TOKEN))).toBe('frame_schema');
		expect(MUMBLE_V2_LIFECYCLE_CONTRACT.stdinEofCloses).toEqual([
			'listener', 'pending_connection', 'authenticated_connection',
		]);
	});
});

describe('H8.4 authority and negative capability boundary', () => {
	it('keeps API authority, shadow rollout, human confirmation and no retention', () => {
		expect(MUMBLE_V2_RECOMMENDED_DEFAULTS).toMatchObject({
			enabled: false,
			rollout: 'shadow',
			observation: 'on_when_armed',
			retention: 'none',
			authority: 'api_v1',
			confirmation: 'human_required',
		});
	});

	it('keeps identity, character, PID, position, movement, combat and loot absent', () => {
		const source = readFileSync('src/platform/mumble-v2-contract.ts', 'utf8');
		for (const forbidden of [
			'identity', 'characterName', 'personaje', 'processId', 'pid', 'position', 'movement',
			'combat', 'loot',
		]) {
			expect(source).not.toMatch(new RegExp(`\\b${forbidden}\\b`, 'iu'));
		}
	});

	it('declares no persistence, external network or alternate source fallback', () => {
		const source = readFileSync('src/platform/mumble-v2-contract.ts', 'utf8');
		expect(MUMBLE_V2_TRANSPORT_CONTRACT.host).toBe('127.0.0.1');
		expect(MUMBLE_V2_TRANSPORT_CONTRACT.protocol).toBe('tcp_ipv4');
		expect(MUMBLE_V2_RECOMMENDED_DEFAULTS.retention).toBe('none');
		expect(source).not.toMatch(/\b(?:fallback|alternateSource|externalHost)\b/iu);
	});
});

type JsonObject = Record<string, unknown>;
type DecodeResult = { ok: true; value: JsonObject } | { ok: false; error: MumbleV2ChannelError };

class ReferenceFramer {
	private readonly header = Buffer.alloc(4);
	private headerBytes = 0;
	private payload: Buffer | null = null;
	private payloadBytes = 0;
	private callbackBytes = 0;
	maximumRetainedBytes = 0;

	get retainedBytes(): number {
		return this.header.length + (this.payload?.length ?? 0) + this.callbackBytes;
	}

	push(chunk: Buffer, consume: (record: Buffer) => void): void {
		let offset = 0;
		while (offset < chunk.length) {
			if (this.payload === null) {
				const copied = Math.min(4 - this.headerBytes, chunk.length - offset);
				chunk.copy(this.header, this.headerBytes, offset, offset + copied);
				this.headerBytes += copied;
				offset += copied;
				this.observeRetainedBytes();
				if (this.headerBytes < 4) continue;
				const length = this.header.readUInt32BE(0);
				if (length < 1 || length > 512) throw new Error('frame_length');
				this.payload = Buffer.allocUnsafe(length);
				this.observeRetainedBytes();
			}
			const copied = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
			chunk.copy(this.payload, this.payloadBytes, offset, offset + copied);
			this.payloadBytes += copied;
			offset += copied;
			this.observeRetainedBytes();
			if (this.payloadBytes !== this.payload.length) continue;
			const completed = this.payload;
			this.headerBytes = 0;
			this.payload = null;
			this.payloadBytes = 0;
			this.callbackBytes = completed.length;
			this.observeRetainedBytes();
			try {
				consume(completed);
			} finally {
				this.callbackBytes = 0;
			}
		}
	}

	finish(): MumbleV2ChannelError | null {
		return this.headerBytes === 0 && this.payload === null ? null : 'frame_length';
	}

	private observeRetainedBytes(): void {
		this.maximumRetainedBytes = Math.max(this.maximumRetainedBytes, this.retainedBytes);
	}
}

class ReferenceSequence {
	private exhausted = false;

	constructor(
		private readonly nonce: string,
		private expected: number = 0,
	) {}

	accept(record: { nonce: string; sequence: number }): MumbleV2ChannelError | null {
		if (record.nonce !== this.nonce) return 'nonce_mismatch';
		if (this.exhausted || !Number.isSafeInteger(record.sequence)
			|| record.sequence < 0 || record.sequence > MAX_SEQUENCE
			|| record.sequence !== this.expected) return 'sequence_mismatch';
		if (record.sequence === MAX_SEQUENCE) this.exhausted = true;
		else this.expected += 1;
		return null;
	}
}

class FakeClock {
	now = 0;

	advance(milliseconds: number): number {
		this.now += milliseconds;
		return this.now;
	}
}

class ReferenceLifecycle {
	private reconnectAttempt = 0;
	private bootstrapToken: string | null = null;
	private discoveredPort: number | null = null;
	private activeNonce: string | null = null;
	private readonly usedNonces = new Set<string>();
	private sequence: ReferenceSequence | null = null;
	healthDeadlineStartedAt: number | null = null;

	constructor(public state: MumbleV2LifecycleState = 'awaiting_bootstrap') {}

	get hasBoundToken(): boolean {
		return this.bootstrapToken !== null;
	}

	get hasDiscoveredPort(): boolean {
		return this.discoveredPort !== null;
	}

	acceptRecord(record: JsonObject, acceptedAt = 0): MumbleV2ChannelError | null {
		const phaseError = validateRecordForState(
			record,
			this.state,
			this.activeNonce ?? '',
			this.bootstrapToken ?? '',
		);
		if (phaseError !== null) return phaseError;
		const kind = recordKind(record);
		if (kind === 'bootstrap') this.bootstrapToken = record.token as string;
		if (kind === 'ready') this.discoveredPort = record.port as number;
		if (kind === 'welcome') {
			const nonce = record.nonce as string;
			if (this.usedNonces.has(nonce)) return 'nonce_mismatch';
			this.activeNonce = nonce;
			this.usedNonces.add(nonce);
			this.sequence = new ReferenceSequence(nonce);
			this.healthDeadlineStartedAt = acceptedAt;
		}
		if (kind === 'heartbeat' || kind === 'sample') {
			if (this.sequence === null) return 'nonce_mismatch';
			const sequenceError = this.sequence.accept({
				nonce: record.nonce as string,
				sequence: record.sequence as number,
			});
			if (sequenceError !== null) return sequenceError;
			this.healthDeadlineStartedAt = acceptedAt;
		}
		const event = eventForRecord(record);
		if (event === null) return 'frame_schema';
		return this.event(event);
	}

	event(event: MumbleV2LifecycleEvent): MumbleV2ChannelError | null {
		if (event === 'stdin_eof' || event === 'shutdown_requested') {
			if (this.state === 'shutdown') return 'frame_schema';
			this.bootstrapToken = null;
			this.discoveredPort = null;
			this.invalidateConnection();
			this.state = 'shutdown';
			return null;
		}
		const transition = MUMBLE_V2_LIFECYCLE_CONTRACT.transitions.find(
			(candidate) => candidate.from === this.state && candidate.event === event,
		);
		if (transition === undefined) return 'frame_schema';
		this.state = transition.to;
		if (event === 'process_restarted') {
			this.bootstrapToken = null;
			this.discoveredPort = null;
		}
		if (this.state === MUMBLE_V2_LIFECYCLE_CONTRACT.backoffResetState
			&& MUMBLE_V2_LIFECYCLE_CONTRACT.backoffResetEvents.includes(event as never)) {
			this.reconnectAttempt = 0;
		}
		return null;
	}

	fail(error: MumbleV2ChannelError): number | null {
		const route = MUMBLE_V2_LIFECYCLE_CONTRACT.failureRoutes.find(
			(candidate) => candidate.fromStates.includes(this.state)
				&& candidate.errors.includes(error),
		);
		if (route === undefined) return null;
		this.state = route.to;
		this.invalidateConnection();
		if (route.tokenDisposition === 'invalidate') this.bootstrapToken = null;
		if (route.portDisposition === 'invalidate') this.discoveredPort = null;
		if (route.recoveryEvent === 'process_restarted') return null;
		const delay = reconnectDelay(this.reconnectAttempt);
		this.reconnectAttempt += 1;
		return delay;
	}

	private invalidateConnection(): void {
		this.activeNonce = null;
		this.sequence = null;
		this.healthDeadlineStartedAt = null;
	}
}

function protocolVectors(): JsonObject[] {
	return [
		{ kind: 'bootstrap', version: 1, token: TOKEN },
		{ kind: 'ready', version: 1, host: '127.0.0.1', port: 49_152 },
		{ kind: 'hello', version: 1, token: TOKEN },
		{ kind: 'welcome', version: 1, nonce: NONCE, heartbeatIntervalMs: 500 },
		{ kind: 'heartbeat', version: 1, nonce: NONCE, sequence: 0, sourceStatus: 'warming_up' },
		{ version: 1, nonce: NONCE, sequence: 1, tick: 4_294_967_295, mapId: 866, activity: 'link_advancing' },
	];
}

function bootstrapRecord(token: string): JsonObject {
	return { kind: 'bootstrap', version: 1, token };
}

function helloRecord(token: string): JsonObject {
	return { kind: 'hello', version: 1, token };
}

function welcomeRecord(nonce: string): JsonObject {
	return { kind: 'welcome', version: 1, nonce, heartbeatIntervalMs: 500 };
}

function heartbeatRecord(nonce: string, sequence: number): JsonObject {
	return { kind: 'heartbeat', version: 1, nonce, sequence, sourceStatus: 'warming_up' };
}

function sampleRecord(nonce: string, sequence: number): JsonObject {
	return {
		version: 1,
		nonce,
		sequence,
		tick: 4_294_967_295,
		mapId: 866,
		activity: 'link_advancing',
	};
}

function connectedLifecycle(token: string, nonce: string): ReferenceLifecycle {
	const lifecycle = new ReferenceLifecycle();
	if (lifecycle.acceptRecord(bootstrapRecord(token)) !== null
		|| lifecycle.acceptRecord(protocolVectors()[1] ?? {}) !== null
		|| lifecycle.event('tcp_connected') !== null
		|| lifecycle.acceptRecord(helloRecord(token)) !== null
		|| lifecycle.acceptRecord(welcomeRecord(nonce)) !== null) {
		throw new Error('reference setup failed');
	}
	return lifecycle;
}

function frameJson(value: unknown): Buffer {
	return frame(Buffer.from(JSON.stringify(value), 'utf8'));
}

function frame(payload: Buffer): Buffer {
	if (payload.length < 1 || payload.length > 512) throw new Error('frame_length');
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length);
	return Buffer.concat([header, payload]);
}

function pushAndCollect(framer: ReferenceFramer, chunk: Buffer): Buffer[] {
	const records: Buffer[] = [];
	framer.push(chunk, (record) => records.push(record));
	return records;
}

function decodePayload(payload: Buffer): DecodeResult {
	if (payload.length < 1 || payload.length > 512) return { ok: false, error: 'frame_length' };
	if (payload.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
		return { ok: false, error: 'frame_utf8' };
	}
	let source: string;
	try {
		source = new TextDecoder('utf-8', { fatal: true }).decode(payload);
	} catch {
		return { ok: false, error: 'frame_utf8' };
	}
	let value: unknown;
	try {
		value = JSON.parse(source) as unknown;
	} catch {
		return { ok: false, error: 'frame_json' };
	}
	if (!isObject(value)) return { ok: false, error: 'frame_schema' };
	const keys = topLevelKeys(source);
	if (new Set(keys).size !== keys.length) return { ok: false, error: 'frame_schema' };
	return { ok: true, value };
}

function validateSource(
	source: string,
	expectedNonce = NONCE,
	expectedToken = TOKEN,
): MumbleV2ChannelError | null {
	const decoded = decodePayload(Buffer.from(source, 'utf8'));
	return decoded.ok ? validateRecord(decoded.value, expectedNonce, expectedToken) : decoded.error;
}

function validateJson(
	value: unknown,
	expectedNonce = NONCE,
	expectedToken = TOKEN,
): MumbleV2ChannelError | null {
	const source = JSON.stringify(value);
	return source === undefined ? 'frame_json' : validateSource(source, expectedNonce, expectedToken);
}

function validateRecord(
	value: JsonObject,
	expectedNonce = NONCE,
	expectedToken = TOKEN,
): MumbleV2ChannelError | null {
	if (value.version !== 1) return 'version_unsupported';
	const kind = typeof value.kind === 'string' ? value.kind : 'sample';
	if (!Object.prototype.hasOwnProperty.call(MUMBLE_V2_MESSAGE_KEYS, kind)) return 'frame_schema';
	const expectedKeys = MUMBLE_V2_MESSAGE_KEYS[kind as keyof typeof MUMBLE_V2_MESSAGE_KEYS];
	if (!sameKeys(Object.keys(value), expectedKeys)) return 'frame_schema';
	if (kind === 'bootstrap') {
		return isEncodedSecret(value.token, 43, 32) ? null : 'auth_rejected';
	}
	if (kind === 'hello') {
		return typeof value.token === 'string' && compareEncodedToken(value.token, expectedToken)
			? null : 'auth_rejected';
	}
	if (kind === 'ready') {
		return value.host === '127.0.0.1' && isIntegerInRange(value.port, 1, 65_535)
			? null : 'discovery_invalid';
	}
	if (kind === 'welcome') {
		return isEncodedSecret(value.nonce, 22, 16) && value.heartbeatIntervalMs === 500
			? null : 'frame_schema';
	}
	if (!isEncodedSecret(value.nonce, 22, 16)) return 'frame_schema';
	if (value.nonce !== expectedNonce) return 'nonce_mismatch';
	if (!isIntegerInRange(value.sequence, 0, MAX_SEQUENCE)) return 'sequence_mismatch';
	if (kind === 'heartbeat') {
		return typeof value.sourceStatus === 'string'
			&& MUMBLE_V2_SOURCE_STATUSES.includes(value.sourceStatus as never)
			? null : 'frame_schema';
	}
	return isIntegerInRange(value.tick, 0, 4_294_967_295)
		&& isIntegerInRange(value.mapId, 1, 4_294_967_295)
		&& (value.activity === 'link_advancing' || value.activity === 'link_stalled')
		? null : 'frame_schema';
}

function sameKeys(actual: string[], expected: readonly string[]): boolean {
	return [...actual].sort().join('\0') === [...expected].sort().join('\0');
}

function topLevelKeys(source: string): string[] {
	const keys: string[] = [];
	let depth = 0;
	let expectingKey = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === '{' || character === '[') {
			depth += 1;
			if (depth === 1 && character === '{') expectingKey = true;
			continue;
		}
		if (character === '}' || character === ']') {
			depth -= 1;
			continue;
		}
		if (character === ',' && depth === 1) {
			expectingKey = true;
			continue;
		}
		if (character !== '"') continue;
		const end = stringEnd(source, index);
		if (depth === 1 && expectingKey) {
			keys.push(JSON.parse(source.slice(index, end + 1)) as string);
			expectingKey = false;
		}
		index = end;
	}
	return keys;
}

function stringEnd(source: string, start: number): number {
	let escaped = false;
	for (let index = start + 1; index < source.length; index += 1) {
		if (!escaped && source[index] === '"') return index;
		if (!escaped && source[index] === '\\') escaped = true;
		else escaped = false;
	}
	return source.length - 1;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): boolean {
	return typeof value === 'number' && Number.isSafeInteger(value)
		&& value >= minimum && value <= maximum;
}

function isEncodedSecret(value: unknown, characters: number, bytes: number): boolean {
	return typeof value === 'string' && value.length === characters && BASE64URL.test(value)
		&& !value.includes('=') && Buffer.from(value, 'base64url').length === bytes;
}

function compareEncodedToken(actual: string, expected: string): boolean {
	if (!isEncodedSecret(actual, 43, 32) || !isEncodedSecret(expected, 43, 32)) return false;
	const actualBytes = Buffer.from(actual, 'base64url');
	const expectedBytes = Buffer.from(expected, 'base64url');
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function tokenComparisonViolations(source: string): string[] {
	return source.includes('timingSafeEqual')
		&& !/\bactual\s*(?:===|==)\s*expected\b/u.test(source)
		? [] : ['constant-time'];
}

function validateRecordForState(
	record: JsonObject,
	state: MumbleV2LifecycleState,
	expectedNonce = NONCE,
	expectedToken = TOKEN,
): MumbleV2ChannelError | null {
	const kind = recordKind(record);
	if (!MUMBLE_V2_LIFECYCLE_CONTRACT.phaseRecords[state].includes(kind as never)) {
		return MUMBLE_V2_LIFECYCLE_CONTRACT.phaseRecordError;
	}
	const recordError = validateRecord(record, expectedNonce, expectedToken);
	if (recordError !== null) return recordError;
	return null;
}

function recordKind(record: JsonObject): string {
	return typeof record.kind === 'string' ? record.kind : 'sample';
}

function eventForRecord(record: JsonObject): MumbleV2LifecycleEvent | null {
	const kind = typeof record.kind === 'string' ? record.kind : 'sample';
	const events: Partial<Record<string, MumbleV2LifecycleEvent>> = {
		bootstrap: 'bootstrap_accepted',
		ready: 'ready_accepted',
		hello: 'hello_accepted',
		welcome: 'welcome_accepted',
		heartbeat: 'heartbeat_accepted',
		sample: 'sample_accepted',
	};
	return events[kind] ?? null;
}

function timeoutForState(
	state: MumbleV2LifecycleState,
	elapsedMs: number,
): MumbleV2ChannelError | null {
	const timeout = MUMBLE_V2_LIFECYCLE_CONTRACT.timeouts.find(
		(candidate) => candidate.state === state,
	);
	return timeout !== undefined && elapsedMs >= timeout.timeoutMs ? timeout.error : null;
}

function failureRouteFor(state: MumbleV2LifecycleState, error: MumbleV2ChannelError) {
	return MUMBLE_V2_LIFECYCLE_CONTRACT.failureRoutes.find(
		(route) => route.fromStates.includes(state) && route.errors.includes(error),
	);
}

function livenessRefreshViolations(events: readonly MumbleV2LifecycleEvent[]): string[] {
	return events.includes('sample_accepted') ? [] : ['missing-sample'];
}

function framerMemoryViolations(maximumRetainedBytes: number): string[] {
	return maximumRetainedBytes <= MUMBLE_V2_TRANSPORT_CONTRACT.maximumBufferedRecordBytes
		? [] : ['buffer-bound'];
}

function deliveryMemoryViolations(source: string): string[] {
	return /Buffer\.from\s*\(/u.test(source) ? ['payload-copy'] : [];
}

function deadlineReached(startedAt: number, now: number, timeoutMs: number): boolean {
	return now - startedAt >= timeoutMs;
}

function reconnectDelay(attempt: number): number {
	const schedule = MUMBLE_V2_TRANSPORT_CONTRACT.reconnectBackoffMs;
	return schedule[Math.min(attempt, schedule.length - 1)] ?? 5_000;
}

function tickActivity(previous: number, current: number, unchangedForMs: number): string {
	return previous !== current || unchangedForMs < MUMBLE_V2_TRANSPORT_CONTRACT.sourceStalledAfterMs
		? 'link_advancing' : 'link_stalled';
}
