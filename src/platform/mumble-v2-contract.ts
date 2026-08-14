/** Declarative H8.1 boundary. No helper, transport, scheduler, or runtime adapter lives here. */
export const MUMBLE_V2_CONTRACT_VERSION = 1 as const;

export const MUMBLE_V2_MAX_FRAME_BYTES = 512 as const;

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

/** Exact untrusted frame accepted by the future plugin boundary. */
export interface MumbleV2IpcFrameV1 {
	version: 1;
	nonce: string;
	sequence: number;
	tick: number;
	mapId: number;
	activity: MumbleV2DerivedActivity;
}

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
	host: '127.0.0.1';
	port: 'ephemeral';
	frameEncoding: 'utf8_json';
	maxFrameBytes: 512;
	nonceEntropyBitsMinimum: 128;
	initialSequence: 0;
	sequenceMinimum: 0;
	sequenceMaximum: number;
	rejectUnknownFields: true;
	rejectReplayOrReorder: true;
}

export const MUMBLE_V2_TRANSPORT_CONTRACT: MumbleV2TransportContractV1 = {
	version: MUMBLE_V2_CONTRACT_VERSION,
	host: '127.0.0.1',
	port: 'ephemeral',
	frameEncoding: 'utf8_json',
	maxFrameBytes: MUMBLE_V2_MAX_FRAME_BYTES,
	nonceEntropyBitsMinimum: 128,
	initialSequence: 0,
	sequenceMinimum: 0,
	sequenceMaximum: 9_007_199_254_740_991,
	rejectUnknownFields: true,
	rejectReplayOrReorder: true,
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
