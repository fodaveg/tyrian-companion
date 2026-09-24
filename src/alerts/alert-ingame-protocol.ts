/**
 * H18.23: the in-game bridge wire contract, version 2. Pure: no socket, no clock, no storage.
 *
 * `docs/SPEC-puente-ingame.md` is the normative text an addon author reads; this module is the
 * plugin's executable copy of it. The bridge used to be one-directional (v1: one `hello`, then the
 * plugin stopped reading). David decided on 2026-09-24 that the addons of Nexus and Blish HUD,
 * with one and the same protocol, report the game context (map, character, whether the player is
 * in gameplay) so the plugin can mark sessions without a click. That makes the channel
 * bidirectional, and therefore authenticated.
 *
 * What is reused from H8.4 (`src/platform/`) is the discipline, not the modules — importing from
 * there would drag this channel into H8's census and threat model (see the SPEC): a 512-byte frame
 * cap, UTF-8 decoded fatally, one closed JSON object per frame with exact keys and no duplicates, a
 * CSPRNG per-connection nonce issued by the server, and a sequence that starts at 0 and advances by
 * exactly one. The framing itself stays a `\n`-terminated line, because both existing addon clients
 * already speak it and neither host needs a length prefix to find the end of a record.
 */

export const INGAME_BRIDGE_PROTOCOL_VERSION = 2 as const;

/** Hard cap on one frame, excluding its `\n` terminator, in either direction. Same number as H8.4. */
export const INGAME_BRIDGE_MAX_LINE_BYTES = 512;

/** A fresh connection that has not produced a valid, authenticated `hello` by then is closed. */
export const INGAME_BRIDGE_HELLO_TIMEOUT_MS = 5_000;

/** Longest an authenticated addon may stay silent; the `welcome` tells it this number. */
export const INGAME_BRIDGE_HEARTBEAT_INTERVAL_MS = 5_000;

/** Three missed heartbeats: the connection is declared lost (not "the game closed"). */
export const INGAME_BRIDGE_LIVENESS_TIMEOUT_MS = 15_000;

/** Connections still waiting for their `hello`; one more is refused at accept time. */
export const INGAME_BRIDGE_MAX_PENDING_CONNECTIONS = 4;

/** Authenticated connections at once: two hosts times two game clients is the most a player runs. */
export const INGAME_BRIDGE_MAX_AUTHENTICATED_CONNECTIONS = 4;

/** Official map id of Mad King's Labyrinth; the same id H8's link-layer contract targets. */
export const INGAME_LABYRINTH_MAP_ID = 866;

export const INGAME_BRIDGE_CLIENTS = ['nexus', 'blish'] as const;
export type IngameBridgeClient = typeof INGAME_BRIDGE_CLIENTS[number];

/**
 * Source priority when both hosts report at once. Nexus runs inside the game process and reads
 * `NexusLink.IsGameplay` directly; Blish HUD is a separate process that infers the same from the
 * game's shared-memory link. The higher number wins the effective context; presence itself never depends on it.
 */
export const INGAME_BRIDGE_CLIENT_PRIORITY: Readonly<Record<IngameBridgeClient, number>> = { nexus: 2, blish: 1 };

export const INGAME_GAME_STATES = ['gameplay', 'loading', 'character_select'] as const;
export type IngameGameState = typeof INGAME_GAME_STATES[number];

/**
 * Why an addon says goodbye. Only `game_exit` is positive evidence the game is closing (the host
 * saw its window or process go away); every other end of a connection, this one included when it
 * comes from `addon_unload`, is a loss of presence with a grace period.
 */
export const INGAME_BYE_REASONS = ['game_exit', 'addon_unload'] as const;
export type IngameByeReason = typeof INGAME_BYE_REASONS[number];

export const INGAME_BRIDGE_ERROR_CODES = [
	'version_unsupported', 'auth_rejected', 'hello_timeout', 'capacity',
	'frame_length', 'frame_utf8', 'frame_json', 'frame_schema',
	'nonce_mismatch', 'sequence_mismatch', 'unexpected_message', 'liveness_timeout',
] as const;
export type IngameBridgeErrorCode = typeof INGAME_BRIDGE_ERROR_CODES[number];

/** Bounds on the shared secret the user pastes into each addon. The plugin generates 43 characters. */
export const INGAME_BRIDGE_SECRET_MIN_CHARACTERS = 32;
export const INGAME_BRIDGE_SECRET_MAX_CHARACTERS = 128;

/** GW2 caps a character name well below this; the margin only keeps a hostile frame bounded. */
export const INGAME_CHARACTER_NAME_MAX_CHARACTERS = 32;

export interface IngameGameContext {
	readonly state: IngameGameState;
	/** `null` when the host has no map to report (character select, first load). */
	readonly mapId: number | null;
	readonly character: string | null;
}

export interface IngameHelloV2 {
	readonly v: typeof INGAME_BRIDGE_PROTOCOL_VERSION;
	readonly type: 'hello';
	readonly client: IngameBridgeClient;
	readonly clientVersion: string;
	/** Per addon-process id (16 random bytes, base64url). Stable across that process's reconnects. */
	readonly instance: string;
	readonly token: string;
}

export type IngameSequencedMessageV2 =
	| { readonly v: 2; readonly type: 'context'; readonly nonce: string; readonly seq: number } & IngameGameContext
	| { readonly v: 2; readonly type: 'heartbeat'; readonly nonce: string; readonly seq: number }
	| { readonly v: 2; readonly type: 'bye'; readonly nonce: string; readonly seq: number; readonly reason: IngameByeReason };

export type IngameParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: IngameBridgeErrorCode };

const HELLO_KEYS = ['v', 'type', 'client', 'clientVersion', 'instance', 'token'] as const;
const SEQUENCED_KEYS = {
	context: ['v', 'type', 'nonce', 'seq', 'state', 'mapId', 'character'],
	heartbeat: ['v', 'type', 'nonce', 'seq'],
	bye: ['v', 'type', 'nonce', 'seq', 'reason'],
} as const;
const MAP_ID_MAXIMUM = 2_147_483_647;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Turns one frame (the bytes between two `\n`, terminator excluded) into a closed JSON object.
 *
 * A single trailing `\r` is tolerated because a C# `StreamWriter.WriteLine` on Windows ends lines
 * with `\r\n`; anything else outside the object — a byte-order mark, a second value, invalid UTF-8
 * — rejects the frame. Duplicate top-level keys reject it too, since `JSON.parse` would otherwise
 * keep the last one silently and two parsers could disagree on what the addon said.
 */
export function decodeIngameFrame(frame: Uint8Array): IngameParseResult<Record<string, unknown>> {
	const bytes = frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d ? frame.subarray(0, frame.byteLength - 1) : frame;
	if (bytes.byteLength === 0 || bytes.byteLength > INGAME_BRIDGE_MAX_LINE_BYTES) return { ok: false, code: 'frame_length' };
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { ok: false, code: 'frame_utf8' };
	// Lossy decode, then a byte-exact round trip: an invalid sequence decodes to U+FFFD and no
	// longer re-encodes to the same bytes. Same guarantee as `fatal: true` without a throw to catch.
	const text = new TextDecoder('utf-8').decode(bytes);
	if (!sameBytes(new TextEncoder().encode(text), bytes)) return { ok: false, code: 'frame_utf8' };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, code: 'frame_json' };
	}
	if (!isRecord(value) || hasDuplicateTopLevelKey(text)) return { ok: false, code: 'frame_json' };
	return { ok: true, value };
}

/**
 * Validates the first frame of a connection. A `v` other than 2 answers `version_unsupported`,
 * which is exactly what a v1 addon (`{"v":1,"client":…}`) receives: its own contract already tells
 * it to show "update the addon" on a version it does not know.
 */
export function parseIngameHello(record: Record<string, unknown>): IngameParseResult<IngameHelloV2> {
	if (typeof record.v === 'number' && record.v !== INGAME_BRIDGE_PROTOCOL_VERSION) return { ok: false, code: 'version_unsupported' };
	if (record.v !== INGAME_BRIDGE_PROTOCOL_VERSION) return { ok: false, code: 'frame_schema' };
	if (record.type !== 'hello') return { ok: false, code: 'unexpected_message' };
	if (!exactKeys(record, HELLO_KEYS)) return { ok: false, code: 'frame_schema' };
	const { client, clientVersion, instance, token } = record;
	if (!isClient(client) || !validClientVersion(clientVersion) || !validBase64UrlId(instance, 22, 16)
		|| typeof token !== 'string') {
		return { ok: false, code: 'frame_schema' };
	}
	return { ok: true, value: { v: INGAME_BRIDGE_PROTOCOL_VERSION, type: 'hello', client, clientVersion, instance, token } };
}

/**
 * Validates every frame after the `welcome`: bound to that connection's nonce and to the exact
 * next sequence number. A gap, a replay or a regression is `sequence_mismatch`; TCP already orders
 * bytes, so any of the three is an addon bug or a spliced stream, never a network hiccup to absorb.
 */
export function parseIngameSequenced(
	record: Record<string, unknown>,
	expected: { readonly nonce: string; readonly seq: number },
): IngameParseResult<IngameSequencedMessageV2> {
	if (record.v !== INGAME_BRIDGE_PROTOCOL_VERSION) return { ok: false, code: 'frame_schema' };
	const type = record.type;
	if (type !== 'context' && type !== 'heartbeat' && type !== 'bye') return { ok: false, code: 'unexpected_message' };
	if (!exactKeys(record, SEQUENCED_KEYS[type])) return { ok: false, code: 'frame_schema' };
	if (typeof record.nonce !== 'string' || typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq)) {
		return { ok: false, code: 'frame_schema' };
	}
	if (record.nonce !== expected.nonce) return { ok: false, code: 'nonce_mismatch' };
	if (record.seq !== expected.seq) return { ok: false, code: 'sequence_mismatch' };
	const base = { v: INGAME_BRIDGE_PROTOCOL_VERSION, nonce: record.nonce, seq: record.seq } as const;
	if (type === 'heartbeat') return { ok: true, value: { ...base, type } };
	if (type === 'bye') {
		const reason = record.reason;
		if (reason !== 'game_exit' && reason !== 'addon_unload') return { ok: false, code: 'frame_schema' };
		return { ok: true, value: { ...base, type, reason } };
	}
	const { state, mapId, character } = record;
	if (!isGameState(state) || !validMapId(mapId) || !validCharacterName(character)) return { ok: false, code: 'frame_schema' };
	return { ok: true, value: { ...base, type, state, mapId, character } };
}

/** The server's answer to an accepted `hello`. `server` changes every time the plugin's server starts. */
export function ingameWelcomeLine(server: string, nonce: string): string {
	return JSON.stringify({
		v: INGAME_BRIDGE_PROTOCOL_VERSION, type: 'welcome', server, nonce,
		heartbeatIntervalMs: INGAME_BRIDGE_HEARTBEAT_INTERVAL_MS,
	});
}

/** The last line a rejected connection receives before the plugin closes it. It carries a code, never input. */
export function ingameErrorLine(code: IngameBridgeErrorCode): string {
	return JSON.stringify({ v: INGAME_BRIDGE_PROTOCOL_VERSION, type: 'error', code });
}

/** 32 CSPRNG bytes as 43 base64url characters: what "Copy token" generates when none is usable. */
export function createIngameBridgeSecret(fillRandom: (bytes: Uint8Array) => void): string {
	return randomBase64Url(fillRandom, 32);
}

/** 16 CSPRNG bytes as 22 base64url characters: per-connection nonces and per-server instance ids. */
export function createIngameBridgeNonce(fillRandom: (bytes: Uint8Array) => void): string {
	return randomBase64Url(fillRandom, 16);
}

/**
 * A configured secret the bridge will accept at all: 32 to 128 printable ASCII characters, no
 * spaces. A shorter or empty entry is treated as "no secret configured", and then every `hello`
 * fails authentication: the bridge never falls back to accepting unauthenticated addons.
 */
export function isUsableIngameBridgeSecret(value: string | null): value is string {
	return value !== null && value.length >= INGAME_BRIDGE_SECRET_MIN_CHARACTERS
		&& value.length <= INGAME_BRIDGE_SECRET_MAX_CHARACTERS && /^[\x21-\x7e]+$/u.test(value);
}

/**
 * Constant-time comparison of a `hello`'s candidate with the configured secret. Time depends only
 * on the longer of the two lengths, so a local prober cannot learn a prefix one character at a time.
 */
export function ingameBridgeSecretMatches(candidate: string, expected: string | null): boolean {
	if (!isUsableIngameBridgeSecret(expected)) return false;
	let difference = candidate.length ^ expected.length;
	const length = Math.max(candidate.length, expected.length);
	for (let index = 0; index < length; index += 1) {
		difference |= (candidate.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
	}
	return difference === 0;
}

function randomBase64Url(fillRandom: (bytes: Uint8Array) => void, byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	fillRandom(bytes);
	return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
	let encoded = '';
	for (let index = 0; index < bytes.byteLength; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
		encoded += BASE64URL_ALPHABET.charAt((value >>> 18) & 63);
		encoded += BASE64URL_ALPHABET.charAt((value >>> 12) & 63);
		if (second !== undefined) encoded += BASE64URL_ALPHABET.charAt((value >>> 6) & 63);
		if (third !== undefined) encoded += BASE64URL_ALPHABET.charAt(value & 63);
	}
	return encoded;
}

/** Canonical base64url of exactly `bytes` bytes: re-encoding the decoded value must give it back. */
function validBase64UrlId(value: unknown, characters: number, bytes: number): value is string {
	if (typeof value !== 'string' || value.length !== characters || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
	const decoded: number[] = [];
	let accumulator = 0;
	let bits = 0;
	for (const character of value) {
		accumulator = (accumulator << 6) | BASE64URL_ALPHABET.indexOf(character);
		bits += 6;
		if (bits < 8) continue;
		bits -= 8;
		decoded.push((accumulator >>> bits) & 0xff);
		accumulator &= (1 << bits) - 1;
	}
	return decoded.length === bytes && encodeBase64Url(Uint8Array.from(decoded)) === value;
}

function validClientVersion(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9A-Za-z.+-]{1,32}$/u.test(value);
}

function validMapId(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAP_ID_MAXIMUM);
}

/* eslint-disable no-control-regex -- a character name must reject every control character. */
function validCharacterName(value: unknown): value is string | null {
	if (value === null) return true;
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
	return [...value].length <= INGAME_CHARACTER_NAME_MAX_CHARACTERS && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
/* eslint-enable no-control-regex -- restore the repository default after the name guard. */

function isClient(value: unknown): value is IngameBridgeClient {
	return typeof value === 'string' && (INGAME_BRIDGE_CLIENTS as readonly string[]).includes(value);
}

function isGameState(value: unknown): value is IngameGameState {
	return typeof value === 'string' && (INGAME_GAME_STATES as readonly string[]).includes(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(record);
	return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks the top level of an already-valid JSON object and reports a key seen twice, escapes included. */
function hasDuplicateTopLevelKey(source: string): boolean {
	const keys = new Set<string>();
	let depth = 0;
	let expectingKey = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === '{' || character === '[') {
			depth += 1;
			if (depth === 1 && character === '{') expectingKey = true;
			continue;
		}
		if (character === '}' || character === ']') { depth -= 1; continue; }
		if (character === ',' && depth === 1) { expectingKey = true; continue; }
		if (character !== '"') continue;
		const end = jsonStringEnd(source, index);
		if (depth === 1 && expectingKey) {
			const key = JSON.parse(source.slice(index, end + 1)) as string;
			if (keys.has(key)) return true;
			keys.add(key);
			expectingKey = false;
		}
		index = end;
	}
	return false;
}

function jsonStringEnd(source: string, start: number): number {
	let escaped = false;
	for (let index = start + 1; index < source.length; index += 1) {
		if (!escaped && source[index] === '"') return index;
		escaped = !escaped && source[index] === '\\';
	}
	return source.length - 1;
}
