import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeIngameFrame } from './alert-ingame-protocol';
import { LIVE_INGAME_BUILD, LIVE_INGAME_PROFILE, parseLiveIngameMessage, liveIngameCapabilityLine, liveIngameAckLine, liveIngameReadyLine } from './live-loot-protocol';

const nonce = 'AQEBAQEBAQEBAQEBAQEBAQ';
const epoch = 'AgICAgICAgICAgICAgICAg';
const base = { v: 3, nonce, seq: 0, tag: 'live1', epoch };
const begin = { ...base, type: 'live_begin', cursor: 0, ctx: 0, ms: 0, mode: 'baseline', items: 'complete', currencies: 'none', unknown: 0, slots: null, rows: 0 };
const parse = (record: Record<string, unknown>) => parseLiveIngameMessage(record, { nonce, seq: 0 }, 3);

describe('live1 strict wire codec', () => {
	it('matches the exact Nexus Rust shared fixture without treating synthetic slots as reader coverage', () => {
		const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/live1.json', import.meta.url), 'utf8')) as { frames: Record<string, unknown>[]; limitations: string };
		for (const frame of fixture.frames) {
			const line = JSON.stringify(frame);
			expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(512);
			expect(decodeIngameFrame(new TextEncoder().encode(line))).toEqual({ ok: true, value: frame });
			if (frame.seq !== undefined) {
				expect(parseLiveIngameMessage(frame, { nonce, seq: frame.seq as number }, 3)).toEqual({ ok: true, value: frame });
			} else if (frame.type === 'live_cap') expect(liveIngameCapabilityLine(nonce)).toBe(line);
			else if (frame.type === 'live_ready') expect(liveIngameReadyLine(nonce, epoch, 'ready')).toBe(line);
			else if (frame.type === 'live_ack') expect(liveIngameAckLine(nonce, epoch, 0, 'stored')).toBe(line);
		}
		expect(fixture.limitations).toContain('native reader reports null');
	});

	it('accepts each exact message and keeps response shapes independent of alert/farming sequences', () => {
		for (const record of [
			{ ...base, type: 'live_open', build: LIVE_INGAME_BUILD, profile: LIVE_INGAME_PROFILE }, begin,
			{ ...base, type: 'live_rows', cursor: 0, part: 0, rows: [[0, 36038, 2_147_483_647], [1, 1, 0]] },
			{ ...base, type: 'live_end', cursor: 0 }, { ...base, type: 'live_status', epoch: null, status: 'unavailable', reason: 'read_failed' },
		]) expect(parse(record)).toEqual({ ok: true, value: record });
		expect(JSON.parse(liveIngameCapabilityLine(nonce))).toEqual({ v: 3, type: 'live_cap', nonce, tag: 'live1' });
		expect(JSON.parse(liveIngameReadyLine(nonce, epoch, 'source_conflict'))).toEqual({ v: 3, type: 'live_ready', nonce, tag: 'live1', epoch, status: 'source_conflict' });
		expect(JSON.parse(liveIngameAckLine(nonce, epoch, 0, 'stored'))).toEqual({ v: 3, type: 'live_ack', nonce, tag: 'live1', epoch, cursor: 0, status: 'stored' });
	});

	it('retains byte length, CRLF, UTF-8 and duplicate-key framing rules at 512/513 bytes', () => {
		const line = JSON.stringify(begin);
		const at512 = line + ' '.repeat(512 - new TextEncoder().encode(line).length);
		expect(decodeIngameFrame(new TextEncoder().encode(at512))).toMatchObject({ ok: true });
		expect(decodeIngameFrame(new TextEncoder().encode(at512 + '\r')).ok).toBe(true);
		expect(decodeIngameFrame(new TextEncoder().encode(at512 + ' '))).toEqual({ ok: false, code: 'frame_length' });
		expect(decodeIngameFrame(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({ ok: false, code: 'frame_utf8' });
		expect(decodeIngameFrame(new TextEncoder().encode('{"v":3,"v":3}'))).toEqual({ ok: false, code: 'frame_json' });
	});

	it('rejects version, nonce, shared sequence, noncanonical epochs and unexpected keys', () => {
		expect(parseLiveIngameMessage(begin, { nonce, seq: 0 }, 2)).toEqual({ ok: false, code: 'unexpected_message' });
		expect(parse({ ...begin, nonce: epoch })).toEqual({ ok: false, code: 'nonce_mismatch' });
		for (const seq of [1, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(parse({ ...begin, seq })).toEqual({ ok: false, code: 'sequence_mismatch' });
		for (const changed of [{ epoch: epoch.slice(0, -1) + 'h' }, { epoch: null }, { command: 'start' }, { tag: 'farm1' }, { rows: 4097 }, { mode: ['baseline'] }, { items: ['complete'] }, { currencies: ['none'] }, { unknown: 1 }, { slots: -1 }]) {
			expect(parse({ ...begin, ...changed })).toEqual({ ok: false, code: 'frame_schema' });
		}
	});

	it('rejects tuple schema, per-frame row cap, overflow and coercible enums without clamping', () => {
		const rows = { ...base, type: 'live_rows', cursor: 0, part: 0, rows: [[0, 12147, 251]] };
		expect(parse(rows).ok).toBe(true); // Aggregates can exceed the native per-stack limit.
		for (const values of [[], Array.from({ length: 9 }, () => [0, 1, 0]), [[0, 1]], [[2, 1, 0]], [[0, 0, 0]], [[0, 1, -1]], [[0, 1, 2_147_483_648]], [['0', 1, 0]]]) expect(parse({ ...rows, rows: values }).ok).toBe(false);
		expect(parse({ ...base, type: 'live_status', status: 'unavailable', reason: ['read_failed'] }).ok).toBe(false);
	});
});
