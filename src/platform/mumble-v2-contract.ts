/** Declarative H8.1/H8.4 boundary. No helper, transport, scheduler, or runtime adapter lives here. */
export const MUMBLE_V2_CONTRACT_VERSION = 1 as const;

export const MUMBLE_V2_MAX_FRAME_BYTES = 512 as const;

export const MUMBLE_V2_MESSAGE_KEYS = {
	bootstrap: ['kind', 'version', 'token'],
	ready: ['kind', 'version', 'host', 'port'],
	hello: ['kind', 'version', 'token'],
	welcome: ['kind', 'version', 'nonce', 'heartbeatIntervalMs'],
	heartbeat: ['kind', 'version', 'nonce', 'sequence', 'sourceStatus'],
	sample: ['version', 'nonce', 'sequence', 'tick', 'mapId', 'activity'],
} as const;

export const MUMBLE_V2_IPC_FRAME_KEYS = [
	'version',
	'nonce',
	'sequence',
	'tick',
	'mapId',
	'activity',
] as const;

export const MUMBLE_V2_SOURCE_FIELDS = [
	'LinkedMem.uiVersion',
	'LinkedMem.uiTick',
	'LinkedMem.context_len',
	'MumbleContext.mapId',
] as const;

export type MumbleV2SourceField = typeof MUMBLE_V2_SOURCE_FIELDS[number];

export type MumbleV2DerivedActivity = 'link_advancing' | 'link_stalled';

export const MUMBLE_V2_SOURCE_STATUSES = [
	'warming_up',
	'mapping_unavailable',
	'layout_unsupported',
	'sample_unstable',
	'sample_invalid',
] as const;

export type MumbleV2SourceStatus = typeof MUMBLE_V2_SOURCE_STATUSES[number];

export const MUMBLE_V2_CHANNEL_ERRORS = [
	'discovery_timeout',
	'discovery_invalid',
	'connect_timeout',
	'auth_rejected',
	'version_unsupported',
	'frame_length',
	'frame_utf8',
	'frame_json',
	'frame_schema',
	'nonce_mismatch',
	'sequence_mismatch',
	'heartbeat_timeout',
	'peer_closed',
	'helper_exited',
] as const;

export type MumbleV2ChannelError = typeof MUMBLE_V2_CHANNEL_ERRORS[number];

export const MUMBLE_V2_LIFECYCLE_STATES = [
	'awaiting_bootstrap',
	'awaiting_ready',
	'connecting',
	'awaiting_hello',
	'awaiting_welcome',
	'awaiting_first_sequenced',
	'healthy',
	'reconnect_wait',
	'restart_wait',
	'shutdown',
] as const;

export type MumbleV2LifecycleState = typeof MUMBLE_V2_LIFECYCLE_STATES[number];

export const MUMBLE_V2_LIFECYCLE_EVENTS = [
	'bootstrap_accepted',
	'ready_accepted',
	'tcp_connected',
	'hello_accepted',
	'welcome_accepted',
	'heartbeat_accepted',
	'sample_accepted',
	'channel_failed',
	'reconnect_due',
	'process_restarted',
	'stdin_eof',
	'shutdown_requested',
] as const;

export type MumbleV2LifecycleEvent = typeof MUMBLE_V2_LIFECYCLE_EVENTS[number];

export interface MumbleV2BootstrapRecordV1 {
	kind: 'bootstrap';
	version: 1;
	token: string;
}

export interface MumbleV2ReadyRecordV1 {
	kind: 'ready';
	version: 1;
	host: '127.0.0.1';
	port: number;
}

export interface MumbleV2HelloRecordV1 {
	kind: 'hello';
	version: 1;
	token: string;
}

export interface MumbleV2WelcomeRecordV1 {
	kind: 'welcome';
	version: 1;
	nonce: string;
	heartbeatIntervalMs: 500;
}

export interface MumbleV2HeartbeatRecordV1 {
	kind: 'heartbeat';
	version: 1;
	nonce: string;
	sequence: number;
	sourceStatus: MumbleV2SourceStatus;
}

/** Exact untrusted frame accepted by the future plugin boundary. */
export interface MumbleV2IpcFrameV1 {
	version: 1;
	nonce: string;
	sequence: number;
	tick: number;
	mapId: number;
	activity: MumbleV2DerivedActivity;
}

export type MumbleV2ProtocolRecordV1 =
	| MumbleV2BootstrapRecordV1
	| MumbleV2ReadyRecordV1
	| MumbleV2HelloRecordV1
	| MumbleV2WelcomeRecordV1
	| MumbleV2HeartbeatRecordV1
	| MumbleV2IpcFrameV1;

export interface MumbleV2RecommendedDefaultsV1 {
	version: 1;
	stability: 'recommended_revisable';
	enabled: false;
	rollout: 'shadow';
	observation: 'on_when_armed';
	retention: 'none';
	authority: 'api_v1';
	confirmation: 'human_required';
	projection: 'map_id_and_derived_activity';
	stalledAfterMs: number;
}

/** Initial rollout defaults; every value marked revisable requires a later human decision to change. */
export const MUMBLE_V2_RECOMMENDED_DEFAULTS: MumbleV2RecommendedDefaultsV1 = {
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
};

export interface MumbleV2TransportContractV1 {
	version: 1;
	protocol: 'tcp_ipv4';
	server: 'helper';
	client: 'plugin';
	host: '127.0.0.1';
	bindPort: 0;
	discoveredPortMinimum: 1;
	discoveredPortMaximum: 65_535;
	bootstrapInput: 'stdin';
	discoveryOutput: 'stdout';
	recordLengthBytes: 4;
	maximumBufferedRecordBytes: 516;
	inputChunkRetention: 'none';
	recordDelivery: 'incremental_ownership_transfer_before_callback';
	recordLengthEncoding: 'uint32_big_endian';
	payloadEncoding: 'utf8_json';
	minimumFrameBytes: 1;
	maxFrameBytes: 512;
	rejectByteOrderMark: true;
	rejectNonObjectJson: true;
	rejectDuplicateKeys: true;
	rejectTrailingContent: true;
	rejectUnknownFields: true;
	rejectMissingFields: true;
	tokenEntropyBytes: 32;
	tokenEncodedCharacters: 43;
	tokenRandomness: 'csprng';
	tokenEncoding: 'base64url_no_padding';
	tokenScope: 'per_process';
	tokenGeneratedBy: 'plugin';
	tokenComparison: 'constant_time_exact_32_bytes';
	tokenBinding: 'hello_equals_bootstrap_same_helper_process';
	tokenRetainedAcrossSameProcessReconnect: true;
	tokenInvalidatedOn: readonly ['helper_exited', 'process_restarted', 'stdin_eof', 'shutdown_requested'];
	tokenSurfaces: readonly ['stdin_bootstrap', 'tcp_hello'];
	tokenForbiddenSurfaces: readonly [
		'argv', 'env', 'file', 'log', 'stdout', 'stderr', 'discovery', 'settings',
		'indexeddb', 'vault', 'telemetry',
	];
	nonceEntropyBytes: 16;
	nonceEncodedCharacters: 22;
	nonceRandomness: 'csprng';
	nonceEncoding: 'base64url_no_padding';
	nonceScope: 'per_connection';
	nonceGeneratedBy: 'helper';
	requireFreshNoncePerConnection: true;
	nonceSurfaces: readonly ['welcome', 'heartbeat', 'sample'];
	authenticatedConnectionMaximum: 1;
	pendingConnectionMaximum: 1;
	rejectAdditionalConnections: true;
	handshakeOrder: readonly ['bootstrap', 'ready', 'hello', 'welcome'];
	sequencedKinds: readonly ['heartbeat', 'sample'];
	initialSequence: 0;
	sequenceStep: 1;
	sequenceMinimum: 0;
	sequenceMaximum: number;
	rejectSequenceGap: true;
	rejectSequenceReplay: true;
	rejectSequenceRegression: true;
	rejectSequenceWrap: true;
	resetSequenceOnNewNonce: true;
	heartbeatIntervalMs: 500;
	heartbeatIntervalMeaning: 'maximum_interval_between_sequenced_records';
	sequencedSlotIntervalMs: 500;
	sequencedRecordsPerSlot: 1;
	sequencedRecordChoice: 'valid_after_warming_sample_else_heartbeat';
	sampleReplacesHeartbeatInSlot: true;
	sampleSatisfiesLiveness: true;
	heartbeatSourceStatusPolicy: 'exact_source_status_only';
	heartbeatHealthyStatusAllowed: false;
	firstValidReadAfter: readonly ['start', 'recovery', 'discontinuity'];
	firstValidReadEmits: 'heartbeat_warming_up';
	warmingUpValidReadCount: 1;
	warmingUpStoresSourceHistory: false;
	nextValidReadAction: 'establish_epoch_and_emit_sample_advancing';
	sourceReadInput: 'raw_tick_map_or_exact_status';
	sampleActivityDerivation: 'internal_tick_history_and_elapsed_ms';
	heartbeatClearsSourceHistory: true;
	sourceHistoryOnDiscontinuity: 'clear_tick_and_started_at';
	lateInvocationRecordMaximum: 1;
	missedSlotPolicy: 'no_catch_up_no_replay';
	nextSlotAfterLateInvocation: 'now_plus_interval';
	lateAfterHeartbeatTimeout: 'channel_failure_heartbeat_timeout';
	sourceStalledAfterMs: 1_500;
	discoveryTimeoutMs: 5_000;
	connectTimeoutMs: 2_000;
	helloTimeoutMs: 2_000;
	firstSequencedRecordTimeoutMs: 2_000;
	heartbeatTimeoutMs: 2_000;
	reconnectBackoffMs: readonly [250, 500, 1_000, 2_000, 5_000];
	channelAxis: 'transport_lifecycle';
	sourceAxis: 'heartbeat_source_status';
	stalledAxis: 'sample_activity';
}

export const MUMBLE_V2_TRANSPORT_CONTRACT: MumbleV2TransportContractV1 = {
	version: MUMBLE_V2_CONTRACT_VERSION,
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
	tokenInvalidatedOn: ['helper_exited', 'process_restarted', 'stdin_eof', 'shutdown_requested'],
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
};

export interface MumbleV2LifecycleTransitionV1 {
	from: MumbleV2LifecycleState;
	event: MumbleV2LifecycleEvent;
	to: MumbleV2LifecycleState;
}

export interface MumbleV2LifecycleTimeoutV1 {
	name: 'discovery_timeout' | 'connect_timeout' | 'hello_timeout'
		| 'first_sequenced_record_timeout' | 'heartbeat_timeout';
	state: MumbleV2LifecycleState;
	timeoutMs: number;
	error: MumbleV2ChannelError;
	deadlineStartsAfter: MumbleV2LifecycleEvent;
	deadlineRefreshesAfter: readonly MumbleV2LifecycleEvent[];
}

export interface MumbleV2LifecycleFailureRouteV1 {
	fromStates: readonly MumbleV2LifecycleState[];
	errors: readonly MumbleV2ChannelError[];
	to: 'reconnect_wait' | 'restart_wait';
	recoveryEvent: 'reconnect_due' | 'process_restarted';
	tokenDisposition: 'retain' | 'invalidate';
	portDisposition: 'retain' | 'invalidate';
	nonceDisposition: 'invalidate';
	sequenceDisposition: 'invalidate';
}

export interface MumbleV2LifecycleContractV1 {
	version: 1;
	initialState: 'awaiting_bootstrap';
	terminalState: 'shutdown';
	phaseRecordError: 'frame_schema';
	phaseRecords: {
		awaiting_bootstrap: readonly ['bootstrap'];
		awaiting_ready: readonly ['ready'];
		connecting: readonly [];
		awaiting_hello: readonly ['hello'];
		awaiting_welcome: readonly ['welcome'];
		awaiting_first_sequenced: readonly ['heartbeat'];
		healthy: readonly ['heartbeat', 'sample'];
		reconnect_wait: readonly [];
		restart_wait: readonly [];
		shutdown: readonly [];
	};
	transitions: readonly MumbleV2LifecycleTransitionV1[];
	timeouts: readonly MumbleV2LifecycleTimeoutV1[];
	failureRoutes: readonly MumbleV2LifecycleFailureRouteV1[];
	stdinEofFromStates: readonly [
		'awaiting_bootstrap', 'awaiting_ready', 'connecting', 'awaiting_hello',
		'awaiting_welcome', 'awaiting_first_sequenced', 'healthy', 'reconnect_wait', 'restart_wait',
	];
	stdinEofTo: 'shutdown';
	stdinEofAction: 'shutdown_helper';
	stdinEofCloses: readonly ['listener', 'pending_connection', 'authenticated_connection'];
	backoffResetState: 'healthy';
	backoffResetEvents: readonly ['heartbeat_accepted', 'sample_accepted'];
	backoffResetOnlyWhenHealthy: true;
	sameProcessReconnectEvent: 'reconnect_due';
	newProcessReconnectEvent: 'process_restarted';
}

/** Positive phase/transition table for future implementations; it performs no lifecycle work. */
export const MUMBLE_V2_LIFECYCLE_CONTRACT: MumbleV2LifecycleContractV1 = {
	version: MUMBLE_V2_CONTRACT_VERSION,
	initialState: 'awaiting_bootstrap',
	terminalState: 'shutdown',
	phaseRecordError: 'frame_schema',
	phaseRecords: {
		awaiting_bootstrap: ['bootstrap'],
		awaiting_ready: ['ready'],
		connecting: [],
		awaiting_hello: ['hello'],
		awaiting_welcome: ['welcome'],
		awaiting_first_sequenced: ['heartbeat'],
		healthy: ['heartbeat', 'sample'],
		reconnect_wait: [],
		restart_wait: [],
		shutdown: [],
	},
	transitions: [
		{ from: 'awaiting_bootstrap', event: 'bootstrap_accepted', to: 'awaiting_ready' },
		{ from: 'awaiting_ready', event: 'ready_accepted', to: 'connecting' },
		{ from: 'connecting', event: 'tcp_connected', to: 'awaiting_hello' },
		{ from: 'awaiting_hello', event: 'hello_accepted', to: 'awaiting_welcome' },
		{ from: 'awaiting_welcome', event: 'welcome_accepted', to: 'awaiting_first_sequenced' },
		{ from: 'awaiting_first_sequenced', event: 'heartbeat_accepted', to: 'healthy' },
		{ from: 'healthy', event: 'heartbeat_accepted', to: 'healthy' },
		{ from: 'healthy', event: 'sample_accepted', to: 'healthy' },
		{ from: 'reconnect_wait', event: 'reconnect_due', to: 'connecting' },
		{ from: 'restart_wait', event: 'process_restarted', to: 'awaiting_bootstrap' },
	],
	timeouts: [
		{ name: 'discovery_timeout', state: 'awaiting_ready', timeoutMs: 5_000, error: 'discovery_timeout', deadlineStartsAfter: 'bootstrap_accepted', deadlineRefreshesAfter: [] },
		{ name: 'connect_timeout', state: 'connecting', timeoutMs: 2_000, error: 'connect_timeout', deadlineStartsAfter: 'ready_accepted', deadlineRefreshesAfter: [] },
		{ name: 'hello_timeout', state: 'awaiting_hello', timeoutMs: 2_000, error: 'auth_rejected', deadlineStartsAfter: 'tcp_connected', deadlineRefreshesAfter: [] },
		{ name: 'hello_timeout', state: 'awaiting_welcome', timeoutMs: 2_000, error: 'auth_rejected', deadlineStartsAfter: 'tcp_connected', deadlineRefreshesAfter: [] },
		{ name: 'first_sequenced_record_timeout', state: 'awaiting_first_sequenced', timeoutMs: 2_000, error: 'heartbeat_timeout', deadlineStartsAfter: 'welcome_accepted', deadlineRefreshesAfter: [] },
		{ name: 'heartbeat_timeout', state: 'healthy', timeoutMs: 2_000, error: 'heartbeat_timeout', deadlineStartsAfter: 'welcome_accepted', deadlineRefreshesAfter: ['heartbeat_accepted', 'sample_accepted'] },
	],
	failureRoutes: [
		{
			fromStates: ['awaiting_bootstrap'],
			errors: [
				'auth_rejected', 'version_unsupported', 'frame_length', 'frame_utf8',
				'frame_json', 'frame_schema',
			],
			to: 'restart_wait',
			recoveryEvent: 'process_restarted',
			tokenDisposition: 'invalidate',
			portDisposition: 'invalidate',
			nonceDisposition: 'invalidate',
			sequenceDisposition: 'invalidate',
		},
		{
			fromStates: ['awaiting_ready'],
			errors: [
				'discovery_timeout', 'discovery_invalid', 'version_unsupported', 'frame_length',
				'frame_utf8', 'frame_json', 'frame_schema',
			],
			to: 'restart_wait',
			recoveryEvent: 'process_restarted',
			tokenDisposition: 'invalidate',
			portDisposition: 'invalidate',
			nonceDisposition: 'invalidate',
			sequenceDisposition: 'invalidate',
		},
		{
			fromStates: [
				'awaiting_bootstrap', 'awaiting_ready', 'connecting', 'awaiting_hello',
				'awaiting_welcome', 'awaiting_first_sequenced', 'healthy',
				'reconnect_wait', 'restart_wait',
			],
			errors: ['helper_exited'],
			to: 'restart_wait',
			recoveryEvent: 'process_restarted',
			tokenDisposition: 'invalidate',
			portDisposition: 'invalidate',
			nonceDisposition: 'invalidate',
			sequenceDisposition: 'invalidate',
		},
		{
			fromStates: ['connecting'],
			errors: ['connect_timeout', 'frame_schema', 'peer_closed'],
			to: 'reconnect_wait',
			recoveryEvent: 'reconnect_due',
			tokenDisposition: 'retain',
			portDisposition: 'retain',
			nonceDisposition: 'invalidate',
			sequenceDisposition: 'invalidate',
		},
		{
			fromStates: ['awaiting_hello'],
			errors: [
				'auth_rejected', 'version_unsupported', 'frame_length', 'frame_utf8',
				'frame_json', 'frame_schema', 'peer_closed',
			],
			to: 'reconnect_wait',
			recoveryEvent: 'reconnect_due',
			tokenDisposition: 'retain',
			portDisposition: 'retain',
			nonceDisposition: 'invalidate',
			sequenceDisposition: 'invalidate',
		},
		{
			fromStates: ['awaiting_welcome'],
			errors: [
				'auth_rejected', 'version_unsupported', 'frame_length', 'frame_utf8',
				'frame_json', 'frame_schema', 'nonce_mismatch', 'peer_closed',
			],
			to: 'reconnect_wait',
			recoveryEvent: 'reconnect_due',
			tokenDisposition: 'retain',
			portDisposition: 'retain',
			nonceDisposition: 'invalidate',
			sequenceDisposition: 'invalidate',
		},
		{
			fromStates: ['awaiting_first_sequenced', 'healthy'],
			errors: [
				'version_unsupported', 'frame_length', 'frame_utf8', 'frame_json', 'frame_schema',
				'nonce_mismatch', 'sequence_mismatch', 'heartbeat_timeout', 'peer_closed',
			],
			to: 'reconnect_wait',
			recoveryEvent: 'reconnect_due',
			tokenDisposition: 'retain',
			portDisposition: 'retain',
			nonceDisposition: 'invalidate',
			sequenceDisposition: 'invalidate',
		},
	],
	stdinEofFromStates: [
		'awaiting_bootstrap', 'awaiting_ready', 'connecting', 'awaiting_hello',
		'awaiting_welcome', 'awaiting_first_sequenced', 'healthy', 'reconnect_wait', 'restart_wait',
	],
	stdinEofTo: 'shutdown',
	stdinEofAction: 'shutdown_helper',
	stdinEofCloses: ['listener', 'pending_connection', 'authenticated_connection'],
	backoffResetState: 'healthy',
	backoffResetEvents: ['heartbeat_accepted', 'sample_accepted'],
	backoffResetOnlyWhenHealthy: true,
	sameProcessReconnectEvent: 'reconnect_due',
	newProcessReconnectEvent: 'process_restarted',
};

export interface MumbleV2SourceLimitsV1 {
	version: 1;
	linkedMemVersion: 2;
	unsigned32Maximum: number;
	contextBytesMinimum: 32;
	contextBytesDocumented: 48;
	contextBufferBytes: 256;
	mapIdByteOffset: 28;
}

export const MUMBLE_V2_SOURCE_LIMITS: MumbleV2SourceLimitsV1 = {
	version: MUMBLE_V2_CONTRACT_VERSION,
	linkedMemVersion: 2,
	unsigned32Maximum: 4_294_967_295,
	contextBytesMinimum: 32,
	contextBytesDocumented: 48,
	contextBufferBytes: 256,
	mapIdByteOffset: 28,
};

export interface MumbleV2FixedSourceV1 {
	id: string;
	url: string;
	retrievedAt: string;
}

export const MUMBLE_V2_FIXED_SOURCES: readonly MumbleV2FixedSourceV1[] = [
	{
		id: 'mumble-link-plugin-layout',
		url: 'https://github.com/mumble-voip/mumble-www/blob/088209c5a14650a04f6c88991374b44655ead34c/hugo/content/documentation/developer/positional-audio/link-plugin/_index.md',
		retrievedAt: '2026-08-14T19:55:59.000Z',
	},
	{
		id: 'arenanet-api-cdi-mumble-context',
		url: 'https://github.com/arenanet/api-cdi/blob/06c4175ad55e4338c7e824c01fdeb6978d1b33d3/mumble.md',
		retrievedAt: '2026-08-14T19:55:59.000Z',
	},
	{
		id: 'gw2-wiki-mumble-layout',
		url: 'https://wiki.guildwars2.com/index.php?title=API:MumbleLink&oldid=3086433',
		retrievedAt: '2026-08-14T19:55:59.000Z',
	},
] as const;

export interface MumbleV2LabyrinthMapV1 {
	id: 866;
	nameEn: "Mad King's Labyrinth";
	nameEs: 'Laberinto del Rey Loco';
	type: 'Public';
	sourceEn: string;
	sourceEs: string;
	verifiedAt: string;
}

export const MUMBLE_V2_LABYRINTH_MAP: MumbleV2LabyrinthMapV1 = {
	id: 866,
	nameEn: "Mad King's Labyrinth",
	nameEs: 'Laberinto del Rey Loco',
	type: 'Public',
	sourceEn: 'https://api.guildwars2.com/v2/maps/866?lang=en',
	sourceEs: 'https://api.guildwars2.com/v2/maps/866?lang=es',
	verifiedAt: '2026-08-14T19:55:59.000Z',
};
