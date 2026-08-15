import { describe, expect, it } from 'vitest';

import {
	MUMBLE_V2_TRANSPORT_CONTRACT,
	type MumbleV2ProtocolRecordV1,
} from './mumble-v2-contract';
import {
	decodeMumbleV2Payload,
	frameMumbleV2Record,
	MumbleV2CodecError,
	MumbleV2RecordFramer,
} from './mumble-v2-codec';

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('MumbleV2RecordFramer', () => {
	it('decodes a record fragmented at every byte boundary', () => {
		const framed = frameMumbleV2Record(ready());
		for (let split = 0; split <= framed.byteLength; split += 1) {
			const framer = new MumbleV2RecordFramer();
			const records: Uint8Array[] = [];
			framer.push(framed.subarray(0, split), (record) => records.push(record));
			framer.push(framed.subarray(split), (record) => records.push(record));
			expect(records).toHaveLength(1);
			expect(decodeMumbleV2Payload(records[0]!).ok).toBe(true);
			expect(framer.finish()).toBeNull();
		}
	});

	it('drains a huge coalesced input without retaining the input chunk', () => {
		const framed = frameMumbleV2Record(ready());
		const repetitions = 4_096;
		const huge = new Uint8Array(framed.byteLength * repetitions);
		for (let index = 0; index < repetitions; index += 1) huge.set(framed, index * framed.byteLength);
		const framer = new MumbleV2RecordFramer();
		let records = 0;
		framer.push(huge, () => { records += 1; });
		expect(records).toBe(repetitions);
		expect(framer.retainedBytes).toBe(4);
		expect(framer.maximumRetainedBytes).toBeLessThanOrEqual(
			MUMBLE_V2_TRANSPORT_CONTRACT.maximumBufferedRecordBytes,
		);
	});

	it('caps partial body ownership at exactly 516 bytes', () => {
		const header = new Uint8Array([0, 0, 2, 0]);
		const payload = new Uint8Array(512).fill(0x20);
		const framed = join(header, payload);
		const framer = new MumbleV2RecordFramer();
		framer.push(framed.subarray(0, 515), () => undefined);
		expect(framer.retainedBytes).toBe(516);
		framer.push(framed.subarray(515), () => undefined);
		expect(framer.maximumRetainedBytes).toBe(516);
	});

	it('rejects zero, oversized and truncated frames', () => {
		for (const header of [
			new Uint8Array([0, 0, 0, 0]),
			new Uint8Array([0, 0, 2, 1]),
		]) {
			expect(() => new MumbleV2RecordFramer().push(header, () => undefined))
				.toThrowError(MumbleV2CodecError);
		}
		const truncated = new MumbleV2RecordFramer();
		const framed = frameMumbleV2Record(ready());
		truncated.push(framed.subarray(0, framed.byteLength - 1), () => undefined);
		expect(truncated.finish()).toBe('frame_length');
	});
});

describe('Mumble v2 strict JSON codec', () => {
	it('accepts only the six exact closed schemas', () => {
		for (const record of vectors()) {
			const payload = frameMumbleV2Record(record).subarray(4);
			expect(decodeMumbleV2Payload(payload)).toEqual({ ok: true, record });
		}
	});

	it('rejects missing, unknown and duplicate keys including escaped equivalents', () => {
		expect(decodeSource('{"kind":"ready","version":1,"host":"127.0.0.1"}'))
			.toEqual({ ok: false, error: 'frame_schema' });
		expect(decodeSource('{"kind":"ready","version":1,"host":"127.0.0.1","port":42,"x":1}'))
			.toEqual({ ok: false, error: 'frame_schema' });
		expect(decodeSource('{"kind":"ready","version":1,"host":"127.0.0.1","port":42,"port":43}'))
			.toEqual({ ok: false, error: 'frame_schema' });
		expect(decodeSource('{"kind":"ready","version":1,"host":"127.0.0.1","port":42,"p\\u006frt":43}'))
			.toEqual({ ok: false, error: 'frame_schema' });
	});

	it('rejects non-canonical base64url aliases for tokens and nonces', () => {
		const tokenAlias = `${TOKEN.slice(0, -1)}B`;
		const nonceAlias = `${NONCE.slice(0, -1)}B`;
		expect(decodeSource(JSON.stringify({ kind: 'bootstrap', version: 1, token: tokenAlias })))
			.toEqual({ ok: false, error: 'auth_rejected' });
		expect(decodeSource(JSON.stringify({
			kind: 'welcome', version: 1, nonce: nonceAlias, heartbeatIntervalMs: 500,
		}))).toEqual({ ok: false, error: 'frame_schema' });
	});

	it('rejects BOM, malformed UTF-8, trailing JSON and non-object roots causally', () => {
		expect(decodeMumbleV2Payload(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])))
			.toEqual({ ok: false, error: 'frame_utf8' });
		expect(decodeMumbleV2Payload(new Uint8Array([0xc3, 0x28])))
			.toEqual({ ok: false, error: 'frame_utf8' });
		expect(decodeSource('{} trailing')).toEqual({ ok: false, error: 'frame_json' });
		for (const source of ['null', '[]', '1', 'true', '"ready"']) {
			expect(decodeSource(source)).toEqual({ ok: false, error: 'frame_schema' });
		}
	});

	it('rejects versions, external hosts, invalid ports, nonce mismatches and unknown statuses', () => {
		expect(decodeSource('{"kind":"ready","version":2,"host":"127.0.0.1","port":42}'))
			.toEqual({ ok: false, error: 'version_unsupported' });
		expect(decodeSource('{"kind":"ready","version":1,"host":"localhost","port":42}'))
			.toEqual({ ok: false, error: 'discovery_invalid' });
		expect(decodeSource('{"kind":"ready","version":1,"host":"127.0.0.1","port":0}'))
			.toEqual({ ok: false, error: 'discovery_invalid' });
		const heartbeat = new TextEncoder().encode(JSON.stringify({
			kind: 'heartbeat', version: 1, nonce: NONCE, sequence: 0, sourceStatus: 'healthy',
		}));
		expect(decodeMumbleV2Payload(heartbeat, { expectedNonce: NONCE }))
			.toEqual({ ok: false, error: 'frame_schema' });
		expect(decodeMumbleV2Payload(
			new TextEncoder().encode(JSON.stringify(vectors()[4])),
			{ expectedNonce: '______________________' },
		)).toEqual({ ok: false, error: 'nonce_mismatch' });
	});
});

function vectors(): MumbleV2ProtocolRecordV1[] {
	return [
		{ kind: 'bootstrap', version: 1, token: TOKEN },
		ready(),
		{ kind: 'hello', version: 1, token: TOKEN },
		{ kind: 'welcome', version: 1, nonce: NONCE, heartbeatIntervalMs: 500 },
		{ kind: 'heartbeat', version: 1, nonce: NONCE, sequence: 0, sourceStatus: 'warming_up' },
		{ version: 1, nonce: NONCE, sequence: 1, tick: 1, mapId: 866, activity: 'link_advancing' },
	];
}

function ready(): MumbleV2ProtocolRecordV1 {
	return { kind: 'ready', version: 1, host: '127.0.0.1', port: 49_152 };
}

function decodeSource(source: string) {
	return decodeMumbleV2Payload(new TextEncoder().encode(source));
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
