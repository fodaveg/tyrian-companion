import { describe, expect, it } from 'vitest';

import {
	createIngameBridgeNonce,
	createIngameBridgeSecret,
	decodeIngameFrame,
	ingameBridgeSecretMatches,
	ingameErrorLine,
	ingameWelcomeLine,
	isUsableIngameBridgeSecret,
	parseIngameHello,
	parseIngameSequenced,
} from './alert-ingame-protocol';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const counterFill = (bytes: Uint8Array): void => { bytes.forEach((_, index) => { bytes[index] = index * 7 + 3; }); };
const INSTANCE = createIngameBridgeNonce(counterFill);
const SECRET = createIngameBridgeSecret(counterFill);

function decoded(text: string): Record<string, unknown> {
	const result = decodeIngameFrame(encode(text));
	if (!result.ok) throw new Error(`fixture did not decode: ${result.code}`);
	return result.value;
}

describe('H18.23 bridge frame decoding', () => {
	it('decodes one closed JSON object and tolerates a single trailing \\r', () => {
		expect(decodeIngameFrame(encode('{"v":2}\r'))).toEqual({ ok: true, value: { v: 2 } });
	});

	it.each([
		['an empty frame', new Uint8Array(), 'frame_length'],
		['a frame over 512 bytes', encode(`{"v":"${'x'.repeat(520)}"}`), 'frame_length'],
		['a byte-order mark', Uint8Array.from([0xef, 0xbb, 0xbf, ...encode('{"v":2}')]), 'frame_utf8'],
		['invalid UTF-8', Uint8Array.from([0x7b, 0xff, 0x7d]), 'frame_utf8'],
		['a non-object', encode('[1,2]'), 'frame_json'],
		['trailing content', encode('{"v":2} {"v":2}'), 'frame_json'],
		['a duplicated key, even escaped', encode('{"v":2,"\\u0076":1}'), 'frame_json'],
	] as const)('rejects %s', (_label, frame, code) => {
		expect(decodeIngameFrame(frame)).toEqual({ ok: false, code });
	});
});

describe('H18.23 bridge hello', () => {
	const hello = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
		v: 2, type: 'hello', client: 'nexus', clientVersion: '0.2.0', instance: INSTANCE, token: SECRET, ...overrides,
	});

	it('accepts the exact v2 hello', () => {
		expect(parseIngameHello(hello())).toMatchObject({ ok: true, value: { client: 'nexus', instance: INSTANCE } });
	});

	it('answers any other numeric version with version_unsupported', () => {
		expect(parseIngameHello(decoded('{"v":1,"client":"nexus","clientVersion":"0.1.0"}')))
			.toEqual({ ok: false, code: 'version_unsupported' });
	});

	it.each([
		['an unknown host', { client: 'arcdps' }],
		['a missing key', { token: undefined }],
		['an extra key', { command: 'start' }],
		['a non-canonical instance', { instance: 'short' }],
		['a clientVersion with spaces', { clientVersion: '0.2 beta' }],
	])('rejects %s as frame_schema', (_label, overrides) => {
		const record = JSON.parse(JSON.stringify(hello(overrides))) as Record<string, unknown>;
		expect(parseIngameHello(record)).toEqual({ ok: false, code: 'frame_schema' });
	});
});

describe('H18.23 bridge sequenced frames', () => {
	const expected = { nonce: INSTANCE, seq: 3 };

	it('accepts a context bound to the nonce and the exact next sequence', () => {
		expect(parseIngameSequenced(
			{ v: 2, type: 'context', nonce: INSTANCE, seq: 3, state: 'loading', mapId: 866, character: null }, expected,
		)).toEqual({ ok: true, value: { v: 2, type: 'context', nonce: INSTANCE, seq: 3, state: 'loading', mapId: 866, character: null } });
	});

	it.each([
		['a replay', { v: 2, type: 'heartbeat', nonce: INSTANCE, seq: 2 }, 'sequence_mismatch'],
		['a gap', { v: 2, type: 'heartbeat', nonce: INSTANCE, seq: 4 }, 'sequence_mismatch'],
		['another connection nonce', { v: 2, type: 'heartbeat', nonce: 'A'.repeat(22), seq: 3 }, 'nonce_mismatch'],
		['a second hello', { v: 2, type: 'hello', nonce: INSTANCE, seq: 3 }, 'unexpected_message'],
		['an unknown bye reason', { v: 2, type: 'bye', nonce: INSTANCE, seq: 3, reason: 'afk' }, 'frame_schema'],
		['an unknown game state', { v: 2, type: 'context', nonce: INSTANCE, seq: 3, state: 'afk', mapId: 1, character: null }, 'frame_schema'],
		['map id zero', { v: 2, type: 'context', nonce: INSTANCE, seq: 3, state: 'gameplay', mapId: 0, character: null }, 'frame_schema'],
		['a name with a control character', { v: 2, type: 'context', nonce: INSTANCE, seq: 3, state: 'gameplay', mapId: 1, character: 'A\u0007' }, 'frame_schema'],
		['a name over 32 characters', { v: 2, type: 'context', nonce: INSTANCE, seq: 3, state: 'gameplay', mapId: 1, character: 'N'.repeat(33) }, 'frame_schema'],
	] as const)('rejects %s', (_label, record, code) => {
		expect(parseIngameSequenced(record, expected)).toEqual({ ok: false, code });
	});
});

describe('H18.23 bridge secret', () => {
	it('generates 43 base64url characters from 32 random bytes and 22 for a nonce', () => {
		expect(SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(INSTANCE).toMatch(/^[A-Za-z0-9_-]{22}$/u);
	});

	it('matches only the exact configured secret and never an absent or weak one', () => {
		expect(ingameBridgeSecretMatches(SECRET, SECRET)).toBe(true);
		expect(ingameBridgeSecretMatches(`${SECRET}x`, SECRET)).toBe(false);
		expect(ingameBridgeSecretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
		expect(ingameBridgeSecretMatches('', null)).toBe(false);
		expect(ingameBridgeSecretMatches('short', 'short')).toBe(false);
		expect(isUsableIngameBridgeSecret('with a space'.padEnd(40, 'x'))).toBe(false);
	});

	it('never echoes input in the lines the server writes', () => {
		expect(JSON.parse(ingameErrorLine('auth_rejected'))).toEqual({ v: 2, type: 'error', code: 'auth_rejected' });
		expect(Object.keys(JSON.parse(ingameWelcomeLine(INSTANCE, INSTANCE)) as object).sort())
			.toEqual(['heartbeatIntervalMs', 'nonce', 'server', 'type', 'v']);
	});
});
