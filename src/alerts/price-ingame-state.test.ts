import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { parseIngameSequenced } from './alert-ingame-protocol';
import {
	PRICE_INGAME_STACK, emptyPriceIngameState, priceIngameCapabilityLine, priceIngameStateLine, type PriceIngameState,
} from './price-ingame-state';

interface PriceFixture {
	stack: number;
	source: { bidUnitCopper: number; askUnitCopper: number };
	frames: Record<string, unknown>[];
}
const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/price1.json', import.meta.url), 'utf8')) as PriceFixture;
const NONCE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const KEYS = ['v', 'type', 'tag', 'nonce', 'seq', 'ttl', 'st', 'sell', 'sellStack', 'list', 'listStack', 'age'];
const ok: PriceIngameState = { st: 'ok', sell: 293, sellStack: 73_312, list: 312, listStack: 77_987, age: 412 };
const bytes = (line: string) => new TextEncoder().encode(line).byteLength;

describe('price1 wire projection', () => {
	it('emits exactly the 12 contract keys in order and discards accidental private fields', () => {
		const line = priceIngameStateLine({ ...ok, itemId: 36_038, name: 'private', token: 'secret' } as PriceIngameState, NONCE, 1);
		expect(Object.keys(JSON.parse(line) as object)).toEqual(KEYS);
		expect(line).not.toContain('private');
		expect(line).not.toContain('secret');
		expect(line).not.toContain('36038');
	});

	it('fits the 512-byte cap at the int32 extreme, within the 216 bytes the contract measured', () => {
		const max = 2_147_483_647;
		const line = priceIngameStateLine({ st: 'ok', sell: max, sellStack: max, list: max, listStack: max, age: max }, NONCE, max);
		expect(bytes(line)).toBe(211); // the contract's 216 is the longest st word, `pending`, with figures that cannot coexist
		expect(bytes(line)).toBeLessThanOrEqual(216);
		expect(bytes(line)).toBeLessThanOrEqual(512);
	});

	it('sends null, never zero or a clamp, for anything that is not an int32 >= 0', () => {
		const line = priceIngameStateLine({ st: 'ok', sell: -1, sellStack: 2_147_483_648, list: 1.5, listStack: NaN, age: Infinity }, NONCE, 1);
		expect(JSON.parse(line)).toMatchObject({ sell: null, sellStack: null, list: null, listStack: null, age: null });
		expect(JSON.parse(priceIngameStateLine({ ...ok, sell: 0 }, NONCE, 1))).toMatchObject({ sell: 0 });
	});

	it('forces the four figures to null unless st is ok, and drops the age for idle and pending', () => {
		for (const st of ['idle', 'pending', 'stale'] as const) {
			const record = JSON.parse(priceIngameStateLine({ ...ok, st }, NONCE, 1)) as Record<string, unknown>;
			expect(record).toMatchObject({ st, sell: null, sellStack: null, list: null, listStack: null });
			expect(record.age).toBe(st === 'stale' ? 412 : null);
		}
	});

	it('rejects a sequence outside 1..int32', () => {
		for (const seq of [0, -1, 1.5, 2_147_483_648]) expect(() => priceIngameStateLine(ok, NONCE, seq)).toThrow('Invalid price sequence');
	});

	it('starts idle with no figures', () => {
		expect(emptyPriceIngameState()).toEqual({ st: 'idle', sell: null, sellStack: null, list: null, listStack: null, age: null });
	});
});

describe('price_sub negotiation', () => {
	const input = { v: 3, type: 'price_sub', nonce: 'nonce', seq: 0, tag: 'price1' };

	it('is accepted only on v3, with exact keys, the tag price1 and the shared input sequence', () => {
		expect(parseIngameSequenced(input, { nonce: 'nonce', seq: 0 }, 3)).toMatchObject({ ok: true, value: { type: 'price_sub', tag: 'price1' } });
		expect(parseIngameSequenced({ ...input, v: 2 }, { nonce: 'nonce', seq: 0 }, 2)).toEqual({ ok: false, code: 'unexpected_message' });
		expect(parseIngameSequenced({ ...input, tag: 'farm1' }, { nonce: 'nonce', seq: 0 }, 3)).toEqual({ ok: false, code: 'frame_schema' });
		expect(parseIngameSequenced({ ...input, command: 'x' }, { nonce: 'nonce', seq: 0 }, 3)).toEqual({ ok: false, code: 'frame_schema' });
		const { tag: _tag, ...missing } = input;
		expect(parseIngameSequenced(missing, { nonce: 'nonce', seq: 0 }, 3)).toEqual({ ok: false, code: 'frame_schema' });
		expect(parseIngameSequenced(input, { nonce: 'nonce', seq: 1 }, 3)).toMatchObject({ code: 'sequence_mismatch' });
		expect(parseIngameSequenced(input, { nonce: 'other', seq: 0 }, 3)).toMatchObject({ code: 'nonce_mismatch' });
	});
});

describe('shared price1 fixture', () => {
	const state = (frame: Record<string, unknown>): PriceIngameState => ({
		st: frame.st as PriceIngameState['st'], sell: frame.sell as number | null, sellStack: frame.sellStack as number | null,
		list: frame.list as number | null, listStack: frame.listStack as number | null, age: frame.age as number | null,
	});

	it('pins the stack the host computes', () => {
		expect(fixture.stack).toBe(PRICE_INGAME_STACK);
	});

	it('every price_state frame is reproduced byte for byte by the line builder', () => {
		const frames = fixture.frames.filter((frame) => frame.type === 'price_state');
		expect(frames).toHaveLength(5);
		for (const frame of frames) {
			expect(priceIngameStateLine(state(frame), frame.nonce as string, frame.seq as number)).toBe(JSON.stringify(frame));
			expect(bytes(JSON.stringify(frame))).toBeLessThanOrEqual(512);
		}
	});

	it('the capability frame is reproduced byte for byte and the subscription passes the parser', () => {
		const cap = fixture.frames.find((frame) => frame.type === 'price_cap')!;
		expect(priceIngameCapabilityLine(cap.nonce as string)).toBe(JSON.stringify(cap));
		const sub = fixture.frames.find((frame) => frame.type === 'price_sub')!;
		expect(parseIngameSequenced(sub, { nonce: sub.nonce as string, seq: sub.seq as number }, 3).ok).toBe(true);
	});

	it('the figures of the ok frame come out of the source quote with the real fee policy', () => {
		const frame = fixture.frames.find((candidate) => candidate.type === 'price_state' && candidate.sell === 293)!;
		const net = (kind: 'instant_sell' | 'listing', unit: number, quantity: number): number => {
			const value = createTradingPostValueWithPolicy(kind, unit, quantity);
			if (value.status !== 'ok') throw new Error('invalid');
			return value.value.netCopper;
		};
		const { bidUnitCopper: bid, askUnitCopper: ask } = fixture.source;
		expect([bid, ask]).toEqual([345, 367]);
		expect({
			sell: net('instant_sell', bid, 1), sellStack: net('instant_sell', bid, fixture.stack),
			list: net('listing', ask, 1), listStack: net('listing', ask, fixture.stack),
		}).toEqual({ sell: frame.sell, sellStack: frame.sellStack, list: frame.list, listStack: frame.listStack });
		expect(frame.sellStack).not.toBe(250 * (frame.sell as number));
	});
});
