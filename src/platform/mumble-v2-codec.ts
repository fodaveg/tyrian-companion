import {
	MUMBLE_V2_MESSAGE_KEYS,
	MUMBLE_V2_SOURCE_STATUSES,
	MUMBLE_V2_TRANSPORT_CONTRACT,
	type MumbleV2ChannelError,
	type MumbleV2ProtocolRecordV1,
} from './mumble-v2-contract';

type JsonObject = Record<string, unknown>;

export type MumbleV2DecodeResult =
	| { ok: true; record: MumbleV2ProtocolRecordV1 }
	| { ok: false; error: MumbleV2ChannelError };

export interface MumbleV2DecodeExpectations {
	expectedNonce?: string;
	expectedToken?: string;
}

/** A typed framing failure suitable for routing through the H8.4 lifecycle. */
export class MumbleV2CodecError extends Error {
	constructor(readonly code: MumbleV2ChannelError) {
		super(code);
		this.name = 'MumbleV2CodecError';
	}
}

/**
 * Incremental uint32-BE framer. It owns at most one 4-byte header and one
 * contract-bounded payload; the caller's input chunk is never retained.
 */
export class MumbleV2RecordFramer {
	private readonly header = new Uint8Array(MUMBLE_V2_TRANSPORT_CONTRACT.recordLengthBytes);
	private headerBytes = 0;
	private payload: Uint8Array | null = null;
	private payloadBytes = 0;
	private callbackBytes = 0;
	private maximumBytes = this.header.byteLength;

	get retainedBytes(): number {
		return this.header.byteLength + (this.payload?.byteLength ?? 0) + this.callbackBytes;
	}

	get maximumRetainedBytes(): number {
		return this.maximumBytes;
	}

	push(chunk: Uint8Array, consume: (payload: Uint8Array) => void): void {
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (this.payload === null) {
				const copied = Math.min(this.header.byteLength - this.headerBytes, chunk.byteLength - offset);
				this.header.set(chunk.subarray(offset, offset + copied), this.headerBytes);
				this.headerBytes += copied;
				offset += copied;
				this.observeMemory();
				if (this.headerBytes < this.header.byteLength) continue;

				const length = (
					(this.header[0]! * 0x1_00_00_00)
					+ (this.header[1]! << 16)
					+ (this.header[2]! << 8)
					+ this.header[3]!
				);
				if (length < MUMBLE_V2_TRANSPORT_CONTRACT.minimumFrameBytes
					|| length > MUMBLE_V2_TRANSPORT_CONTRACT.maxFrameBytes) {
					this.reset();
					throw new MumbleV2CodecError('frame_length');
				}
				this.payload = new Uint8Array(length);
				this.observeMemory();
			}

			const copied = Math.min(this.payload.byteLength - this.payloadBytes, chunk.byteLength - offset);
			this.payload.set(chunk.subarray(offset, offset + copied), this.payloadBytes);
			this.payloadBytes += copied;
			offset += copied;
			this.observeMemory();
			if (this.payloadBytes !== this.payload.byteLength) continue;

			const completed = this.payload;
			this.headerBytes = 0;
			this.payload = null;
			this.payloadBytes = 0;
			this.callbackBytes = completed.byteLength;
			this.observeMemory();
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

	private observeMemory(): void {
		this.maximumBytes = Math.max(this.maximumBytes, this.retainedBytes);
		if (this.maximumBytes > MUMBLE_V2_TRANSPORT_CONTRACT.maximumBufferedRecordBytes) {
			throw new MumbleV2CodecError('frame_length');
		}
	}

	private reset(): void {
		this.headerBytes = 0;
		this.payload = null;
		this.payloadBytes = 0;
		this.callbackBytes = 0;
	}
}

export function frameMumbleV2Record(record: MumbleV2ProtocolRecordV1): Uint8Array {
	const validation = validateMumbleV2Record(record);
	if (validation !== null) throw new MumbleV2CodecError(validation);
	const payload = new TextEncoder().encode(JSON.stringify(record));
	if (payload.byteLength < MUMBLE_V2_TRANSPORT_CONTRACT.minimumFrameBytes
		|| payload.byteLength > MUMBLE_V2_TRANSPORT_CONTRACT.maxFrameBytes) {
		throw new MumbleV2CodecError('frame_length');
	}
	const framed = new Uint8Array(MUMBLE_V2_TRANSPORT_CONTRACT.recordLengthBytes + payload.byteLength);
	const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
	view.setUint32(0, payload.byteLength, false);
	framed.set(payload, MUMBLE_V2_TRANSPORT_CONTRACT.recordLengthBytes);
	return framed;
}

export function decodeMumbleV2Payload(
	payload: Uint8Array,
	expectations: MumbleV2DecodeExpectations = {},
): MumbleV2DecodeResult {
	if (payload.byteLength < MUMBLE_V2_TRANSPORT_CONTRACT.minimumFrameBytes
		|| payload.byteLength > MUMBLE_V2_TRANSPORT_CONTRACT.maxFrameBytes) {
		return { ok: false, error: 'frame_length' };
	}
	if (payload.byteLength >= 3 && payload[0] === 0xef && payload[1] === 0xbb && payload[2] === 0xbf) {
		return { ok: false, error: 'frame_utf8' };
	}

	let source: string;
	try {
		source = new TextDecoder('utf-8', { fatal: true }).decode(payload);
	} catch {
		return { ok: false, error: 'frame_utf8' };
	}
	if (source.includes('\uFEFF')) return { ok: false, error: 'frame_utf8' };

	let value: unknown;
	try {
		value = JSON.parse(source) as unknown;
	} catch {
		return { ok: false, error: 'frame_json' };
	}
	if (!isObject(value) || hasDuplicateTopLevelKey(source)) {
		return { ok: false, error: 'frame_schema' };
	}
	const error = validateMumbleV2Record(value, expectations);
	return error === null
		? { ok: true, record: value as unknown as MumbleV2ProtocolRecordV1 }
		: { ok: false, error };
}

export function validateMumbleV2Record(
	value: unknown,
	expectations: MumbleV2DecodeExpectations = {},
): MumbleV2ChannelError | null {
	if (!isObject(value)) return 'frame_schema';
	if (value.version !== 1) return 'version_unsupported';
	const kind = typeof value.kind === 'string' ? value.kind : 'sample';
	if (!Object.prototype.hasOwnProperty.call(MUMBLE_V2_MESSAGE_KEYS, kind)) return 'frame_schema';
	const expectedKeys = MUMBLE_V2_MESSAGE_KEYS[kind as keyof typeof MUMBLE_V2_MESSAGE_KEYS];
	if (!sameKeys(Object.keys(value), expectedKeys)) return 'frame_schema';

	if (kind === 'bootstrap') return validSecret(value.token, 43, 32) ? null : 'auth_rejected';
	if (kind === 'hello') {
		if (!validSecret(value.token, 43, 32)) return 'auth_rejected';
		return expectations.expectedToken === undefined
			|| constantTimeTextEqual(value.token as string, expectations.expectedToken)
			? null : 'auth_rejected';
	}
	if (kind === 'ready') {
		return value.host === MUMBLE_V2_TRANSPORT_CONTRACT.host
			&& integerInRange(
				value.port,
				MUMBLE_V2_TRANSPORT_CONTRACT.discoveredPortMinimum,
				MUMBLE_V2_TRANSPORT_CONTRACT.discoveredPortMaximum,
			)
			? null : 'discovery_invalid';
	}
	if (kind === 'welcome') {
		return validSecret(value.nonce, 22, 16)
			&& value.heartbeatIntervalMs === MUMBLE_V2_TRANSPORT_CONTRACT.heartbeatIntervalMs
			? null : 'frame_schema';
	}
	if (!validSecret(value.nonce, 22, 16)) return 'frame_schema';
	if (expectations.expectedNonce !== undefined && value.nonce !== expectations.expectedNonce) {
		return 'nonce_mismatch';
	}
	if (!integerInRange(value.sequence, 0, MUMBLE_V2_TRANSPORT_CONTRACT.sequenceMaximum)) {
		return 'sequence_mismatch';
	}
	if (kind === 'heartbeat') {
		return typeof value.sourceStatus === 'string'
			&& MUMBLE_V2_SOURCE_STATUSES.includes(value.sourceStatus as never)
			? null : 'frame_schema';
	}
	return integerInRange(value.tick, 0, 4_294_967_295)
		&& integerInRange(value.mapId, 1, 4_294_967_295)
		&& (value.activity === 'link_advancing' || value.activity === 'link_stalled')
		? null : 'frame_schema';
}

export function isMumbleV2SequencedRecord(
	record: MumbleV2ProtocolRecordV1,
): record is Extract<MumbleV2ProtocolRecordV1, { sequence: number }> {
	return 'sequence' in record;
}

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
		if (character === '}' || character === ']') {
			depth -= 1;
			continue;
		}
		if (character === ',' && depth === 1) {
			expectingKey = true;
			continue;
		}
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
		if (!escaped && source[index] === '\\') escaped = true;
		else escaped = false;
	}
	return source.length - 1;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function integerInRange(value: unknown, minimum: number, maximum: number): boolean {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validSecret(value: unknown, characters: 22 | 43, bytes: 16 | 32): boolean {
	if (typeof value !== 'string' || value.length !== characters
		|| !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
	const decoded = decodeBase64Url(value);
	return decoded !== null && decoded.byteLength === bytes
		&& encodeMumbleV2Base64Url(decoded) === value;
}

function constantTimeTextEqual(actual: string, expected: string): boolean {
	let difference = actual.length ^ expected.length;
	const length = Math.max(actual.length, expected.length);
	for (let index = 0; index < length; index += 1) {
		difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
	}
	return difference === 0;
}

export function encodeMumbleV2Base64Url(bytes: Uint8Array): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	let encoded = '';
	for (let index = 0; index < bytes.byteLength; index += 3) {
		const first = bytes[index]!;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
		encoded += alphabet[(value >>> 18) & 63]!;
		encoded += alphabet[(value >>> 12) & 63]!;
		if (second !== undefined) encoded += alphabet[(value >>> 6) & 63]!;
		if (third !== undefined) encoded += alphabet[value & 63]!;
	}
	return encoded;
}

function decodeBase64Url(value: string): Uint8Array | null {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	const decoded: number[] = [];
	let accumulator = 0;
	let bits = 0;
	for (const character of value) {
		const digit = alphabet.indexOf(character);
		if (digit < 0) return null;
		accumulator = (accumulator << 6) | digit;
		bits += 6;
		if (bits < 8) continue;
		bits -= 8;
		decoded.push((accumulator >>> bits) & 0xff);
		accumulator &= (1 << bits) - 1;
	}
	return new Uint8Array(decoded);
}
