import { describe, expect, it } from 'vitest';

import {
	MUMBLE_V2_CONTRACT_VERSION,
	MUMBLE_V2_FIXED_SOURCES,
	MUMBLE_V2_IPC_FRAME_KEYS,
	MUMBLE_V2_LABYRINTH_MAP,
	MUMBLE_V2_MAX_FRAME_BYTES,
	MUMBLE_V2_RECOMMENDED_DEFAULTS,
	MUMBLE_V2_SOURCE_FIELDS,
	MUMBLE_V2_SOURCE_LIMITS,
	MUMBLE_V2_TRANSPORT_CONTRACT,
	type MumbleV2IpcFrameV1,
} from './mumble-v2-contract';

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

	it('pins loopback framing, nonce strength, ordering and a bounded frame', () => {
		expect(MUMBLE_V2_TRANSPORT_CONTRACT).toEqual({
			version: 1,
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
		});
		expect(MUMBLE_V2_TRANSPORT_CONTRACT.initialSequence).toBe(0);
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
