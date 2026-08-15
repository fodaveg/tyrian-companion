import { describe, expect, it } from 'vitest';

import {
	MUMBLE_V2_CONTRACT_VERSION,
	MUMBLE_V2_FIXED_SOURCES,
	MUMBLE_V2_IPC_FRAME_KEYS,
	MUMBLE_V2_LABYRINTH_MAP,
	MUMBLE_V2_LIFECYCLE_CONTRACT,
	MUMBLE_V2_LIFECYCLE_EVENTS,
	MUMBLE_V2_LIFECYCLE_STATES,
	MUMBLE_V2_MAX_FRAME_BYTES,
	MUMBLE_V2_MESSAGE_KEYS,
	MUMBLE_V2_RECOMMENDED_DEFAULTS,
	MUMBLE_V2_SOURCE_FIELDS,
	MUMBLE_V2_SOURCE_LIMITS,
	MUMBLE_V2_TRANSPORT_CONTRACT,
	type MumbleV2BootstrapRecordV1,
	type MumbleV2ChannelError,
	type MumbleV2HeartbeatRecordV1,
	type MumbleV2IpcFrameV1,
	type MumbleV2LifecycleState,
	type MumbleV2ProtocolRecordV1,
	type MumbleV2ReadyRecordV1,
	type MumbleV2WelcomeRecordV1,
} from './mumble-v2-contract';

function failureRoute(state: MumbleV2LifecycleState, error: MumbleV2ChannelError) {
	return MUMBLE_V2_LIFECYCLE_CONTRACT.failureRoutes.find(
		(route) => route.fromStates.includes(state) && route.errors.includes(error),
	);
}

describe('H8.1 Mumble v2 declarative contract', () => {
	it('fixes the minimum untrusted IPC projection without personal or spatial fields', () => {
		const frame: MumbleV2IpcFrameV1 = {
			version: 1,
			nonce: 'synthetic-local-capability',
			sequence: 7,
			tick: 42,
			mapId: 866,
			activity: 'link_advancing',
		};

		expect(Object.keys(frame)).toEqual(MUMBLE_V2_IPC_FRAME_KEYS);
		expect(Object.keys(frame)).not.toEqual(expect.arrayContaining([
			'identity', 'name', 'position', 'coordinates', 'processId', 'pid',
		]));
	});

	it('starts opt-in, shadow-only, armed-only, API-authoritative and non-persistent', () => {
		expect(MUMBLE_V2_RECOMMENDED_DEFAULTS).toEqual({
			version: MUMBLE_V2_CONTRACT_VERSION,
			stability: 'recommended_revisable',
			enabled: false,
			rollout: 'shadow',
			observation: 'on_when_armed',
			retention: 'none',
			authority: 'api_v1',
			confirmation: 'human_required',
			projection: 'map_id_and_derived_activity',
			stalledAfterMs: 1_500,
		});
	});

	it('pins the six exact record schemas without widening the H8.1 sample', () => {
		const records: readonly MumbleV2ProtocolRecordV1[] = [
			{ kind: 'bootstrap', version: 1, token: 'A'.repeat(43) } satisfies MumbleV2BootstrapRecordV1,
			{ kind: 'ready', version: 1, host: '127.0.0.1', port: 49_152 } satisfies MumbleV2ReadyRecordV1,
			{ kind: 'hello', version: 1, token: 'A'.repeat(43) },
			{ kind: 'welcome', version: 1, nonce: 'B'.repeat(22), heartbeatIntervalMs: 500 } satisfies MumbleV2WelcomeRecordV1,
			{ kind: 'heartbeat', version: 1, nonce: 'B'.repeat(22), sequence: 0, sourceStatus: 'warming_up' } satisfies MumbleV2HeartbeatRecordV1,
			{ version: 1, nonce: 'B'.repeat(22), sequence: 1, tick: 42, mapId: 866, activity: 'link_advancing' },
		];

		expect(records.map((record) => Object.keys(record))).toEqual(Object.values(MUMBLE_V2_MESSAGE_KEYS));
		expect(MUMBLE_V2_MESSAGE_KEYS.sample).toEqual(MUMBLE_V2_IPC_FRAME_KEYS);
	});

	it('pins loopback framing, credentials, sequencing and lifecycle deadlines', () => {
		expect(MUMBLE_V2_TRANSPORT_CONTRACT).toEqual({
			version: 1,
			protocol: 'tcp_ipv4',
			server: 'helper',
			client: 'plugin',
			host: '127.0.0.1',
			bindPort: 0,
			discoveredPortMinimum: 1,
			discoveredPortMaximum: 65_535,
			bootstrapInput: 'stdin',
			discoveryOutput: 'stdout',
			recordLengthBytes: 4,
			maximumBufferedRecordBytes: 516,
			inputChunkRetention: 'none',
			recordDelivery: 'incremental_ownership_transfer_before_callback',
			recordLengthEncoding: 'uint32_big_endian',
			payloadEncoding: 'utf8_json',
			minimumFrameBytes: 1,
			maxFrameBytes: MUMBLE_V2_MAX_FRAME_BYTES,
			rejectByteOrderMark: true,
			rejectNonObjectJson: true,
			rejectDuplicateKeys: true,
			rejectTrailingContent: true,
			rejectUnknownFields: true,
			rejectMissingFields: true,
			tokenEntropyBytes: 32,
			tokenEncodedCharacters: 43,
			tokenRandomness: 'csprng',
			tokenEncoding: 'base64url_no_padding',
			tokenScope: 'per_process',
			tokenGeneratedBy: 'plugin',
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
			nonceGeneratedBy: 'helper',
			requireFreshNoncePerConnection: true,
			nonceSurfaces: ['welcome', 'heartbeat', 'sample'],
			authenticatedConnectionMaximum: 1,
			pendingConnectionMaximum: 1,
			rejectAdditionalConnections: true,
			handshakeOrder: ['bootstrap', 'ready', 'hello', 'welcome'],
			sequencedKinds: ['heartbeat', 'sample'],
			initialSequence: 0,
			sequenceStep: 1,
			sequenceMinimum: 0,
			sequenceMaximum: 9_007_199_254_740_991,
			rejectSequenceGap: true,
			rejectSequenceReplay: true,
			rejectSequenceRegression: true,
			rejectSequenceWrap: true,
			resetSequenceOnNewNonce: true,
			heartbeatIntervalMs: 500,
			heartbeatIntervalMeaning: 'maximum_interval_between_sequenced_records',
			sequencedSlotIntervalMs: 500,
			sequencedRecordsPerSlot: 1,
			sequencedRecordChoice: 'valid_after_warming_sample_else_heartbeat',
			sampleReplacesHeartbeatInSlot: true,
			sampleSatisfiesLiveness: true,
			heartbeatSourceStatusPolicy: 'exact_source_status_only',
			heartbeatHealthyStatusAllowed: false,
			firstValidReadAfter: ['start', 'recovery', 'discontinuity'],
			firstValidReadEmits: 'heartbeat_warming_up',
			warmingUpValidReadCount: 1,
			warmingUpStoresSourceHistory: false,
			nextValidReadAction: 'establish_epoch_and_emit_sample_advancing',
			sourceReadInput: 'raw_tick_map_or_exact_status',
			sampleActivityDerivation: 'internal_tick_history_and_elapsed_ms',
			heartbeatClearsSourceHistory: true,
			sourceHistoryOnDiscontinuity: 'clear_tick_and_started_at',
			lateInvocationRecordMaximum: 1,
			missedSlotPolicy: 'no_catch_up_no_replay',
			nextSlotAfterLateInvocation: 'now_plus_interval',
			lateAfterHeartbeatTimeout: 'channel_failure_heartbeat_timeout',
			sourceStalledAfterMs: 1_500,
			discoveryTimeoutMs: 5_000,
			connectTimeoutMs: 2_000,
			helloTimeoutMs: 2_000,
			firstSequencedRecordTimeoutMs: 2_000,
			heartbeatTimeoutMs: 2_000,
			reconnectBackoffMs: [250, 500, 1_000, 2_000, 5_000],
			channelAxis: 'transport_lifecycle',
			sourceAxis: 'heartbeat_source_status',
			stalledAxis: 'sample_activity',
		});
		expect(MUMBLE_V2_TRANSPORT_CONTRACT.initialSequence).toBe(0);
	});

	it('pins the deterministic phase, transition, timeout and shutdown lifecycle', () => {
		expect(MUMBLE_V2_LIFECYCLE_STATES).toEqual([
			'awaiting_bootstrap', 'awaiting_ready', 'connecting', 'awaiting_hello',
			'awaiting_welcome', 'awaiting_first_sequenced', 'healthy', 'reconnect_wait',
			'restart_wait', 'shutdown',
		]);
		expect(MUMBLE_V2_LIFECYCLE_EVENTS).toEqual([
			'bootstrap_accepted', 'ready_accepted', 'tcp_connected', 'hello_accepted',
			'welcome_accepted', 'heartbeat_accepted', 'sample_accepted', 'channel_failed',
			'reconnect_due', 'process_restarted', 'stdin_eof', 'shutdown_requested',
		]);
		expect(MUMBLE_V2_LIFECYCLE_CONTRACT).toMatchObject({
			initialState: 'awaiting_bootstrap',
			terminalState: 'shutdown',
			phaseRecordError: 'frame_schema',
			backoffResetState: 'healthy',
			backoffResetEvents: ['heartbeat_accepted', 'sample_accepted'],
			backoffResetOnlyWhenHealthy: true,
			stdinEofAction: 'shutdown_helper',
			stdinEofTo: 'shutdown',
			stdinEofCloses: ['listener', 'pending_connection', 'authenticated_connection'],
		});
		expect(MUMBLE_V2_LIFECYCLE_CONTRACT.phaseRecords.awaiting_first_sequenced)
			.toEqual(['heartbeat']);
		expect(MUMBLE_V2_LIFECYCLE_CONTRACT.transitions).not.toContainEqual({
			from: 'awaiting_first_sequenced', event: 'sample_accepted', to: 'healthy',
		});
		expect(MUMBLE_V2_LIFECYCLE_CONTRACT.timeouts).toEqual([
			{ name: 'discovery_timeout', state: 'awaiting_ready', timeoutMs: 5_000, error: 'discovery_timeout', deadlineStartsAfter: 'bootstrap_accepted', deadlineRefreshesAfter: [] },
			{ name: 'connect_timeout', state: 'connecting', timeoutMs: 2_000, error: 'connect_timeout', deadlineStartsAfter: 'ready_accepted', deadlineRefreshesAfter: [] },
			{ name: 'hello_timeout', state: 'awaiting_hello', timeoutMs: 2_000, error: 'auth_rejected', deadlineStartsAfter: 'tcp_connected', deadlineRefreshesAfter: [] },
			{ name: 'hello_timeout', state: 'awaiting_welcome', timeoutMs: 2_000, error: 'auth_rejected', deadlineStartsAfter: 'tcp_connected', deadlineRefreshesAfter: [] },
			{ name: 'first_sequenced_record_timeout', state: 'awaiting_first_sequenced', timeoutMs: 2_000, error: 'heartbeat_timeout', deadlineStartsAfter: 'welcome_accepted', deadlineRefreshesAfter: [] },
			{ name: 'heartbeat_timeout', state: 'healthy', timeoutMs: 2_000, error: 'heartbeat_timeout', deadlineStartsAfter: 'welcome_accepted', deadlineRefreshesAfter: ['heartbeat_accepted', 'sample_accepted'] },
		]);
		expect(MUMBLE_V2_LIFECYCLE_CONTRACT.failureRoutes).toHaveLength(7);
		expect(failureRoute('awaiting_ready', 'discovery_timeout')).toMatchObject({
			to: 'restart_wait', recoveryEvent: 'process_restarted', tokenDisposition: 'invalidate',
			portDisposition: 'invalidate', sequenceDisposition: 'invalidate',
		});
		expect(failureRoute('healthy', 'helper_exited')).toMatchObject({
			to: 'restart_wait', recoveryEvent: 'process_restarted', tokenDisposition: 'invalidate',
			portDisposition: 'invalidate', sequenceDisposition: 'invalidate',
		});
		expect(failureRoute('healthy', 'heartbeat_timeout')).toMatchObject({
			to: 'reconnect_wait', recoveryEvent: 'reconnect_due', tokenDisposition: 'retain',
			portDisposition: 'retain', sequenceDisposition: 'invalidate',
		});
		expect(failureRoute('healthy', 'discovery_timeout')).toBeUndefined();
	});

	it('reads only the documented fields and bounds needed for map and liveness', () => {
		expect(MUMBLE_V2_SOURCE_FIELDS).toEqual([
			'LinkedMem.uiVersion',
			'LinkedMem.uiTick',
			'LinkedMem.context_len',
			'MumbleContext.mapId',
		]);
		expect(MUMBLE_V2_SOURCE_LIMITS).toEqual({
			version: 1,
			linkedMemVersion: 2,
			unsigned32Maximum: 4_294_967_295,
			contextBytesMinimum: 32,
			contextBytesDocumented: 48,
			contextBufferBytes: 256,
			mapIdByteOffset: 28,
		});
	});

	it('pins the official Labyrinth map and immutable layout references', () => {
		expect(MUMBLE_V2_LABYRINTH_MAP).toMatchObject({
			id: 866,
			nameEn: "Mad King's Labyrinth",
			nameEs: 'Laberinto del Rey Loco',
			type: 'Public',
			sourceEn: 'https://api.guildwars2.com/v2/maps/866?lang=en',
			sourceEs: 'https://api.guildwars2.com/v2/maps/866?lang=es',
		});
		expect(MUMBLE_V2_FIXED_SOURCES.map(({ url }) => url)).toEqual([
			'https://github.com/mumble-voip/mumble-www/blob/088209c5a14650a04f6c88991374b44655ead34c/hugo/content/documentation/developer/positional-audio/link-plugin/_index.md',
			'https://github.com/arenanet/api-cdi/blob/06c4175ad55e4338c7e824c01fdeb6978d1b33d3/mumble.md',
			'https://wiki.guildwars2.com/index.php?title=API:MumbleLink&oldid=3086433',
		]);
	});
});
