import { describe, expect, it } from 'vitest';
import { emptyFarmingIngameState, farmingIngameStateLine } from './farming-ingame-state';
import { parseIngameSequenced } from './alert-ingame-protocol';

describe('read-only farm1 wire projection', () => {
	it('negotiates only on v3 with closed keys and the existing input sequence', () => {
		const input = { v: 3, type: 'farming_sub', nonce: 'nonce', seq: 0, tag: 'farm1' };
		expect(parseIngameSequenced(input, { nonce: 'nonce', seq: 0 }, 3).ok).toBe(true);
		expect(parseIngameSequenced(input, { nonce: 'nonce', seq: 0 }, 2).ok).toBe(false);
		expect(parseIngameSequenced({ ...input, character: 'private' }, { nonce: 'nonce', seq: 0 }, 3).ok).toBe(false);
		expect(parseIngameSequenced({ ...input, tag: 'farm2' }, { nonce: 'nonce', seq: 0 }, 3).ok).toBe(false);
		expect(parseIngameSequenced(input, { nonce: 'nonce', seq: 1 }, 3)).toMatchObject({ code: 'sequence_mismatch' });
	});

	it('keeps measured zero, signed net, unknowns and discards accidental private fields', () => {
		const line = farmingIngameStateLine({ ...emptyFarmingIngameState(), observed: 0, net: -10,
			slots: NaN, mf: Infinity, eta: -1, character: 'private', token: 'secret',
		} as ReturnType<typeof emptyFarmingIngameState>, 'x'.repeat(22), 1);
		const record = JSON.parse(line) as Record<string, unknown>;
		expect(record).toMatchObject({ observed: 0, net: -10, slots: null, mf: null, eta: null, seq: 1, ttl: 15 });
		expect(Object.keys(record)).toEqual(['v', 'type', 'tag', 'nonce', 'seq', 'ttl', 'phase', 'err',
			'elapsed', 'observed', 'net', 'lo', 'hi', 'age', 'slots', 'slotSrc', 'slotAge', 'goal',
			'target', 'progress', 'eta', 'mf', 'mfKind', 'prep']);
		expect(line).not.toContain('private');
		expect(line).not.toContain('secret');
	});

	it('fits every int32 metric at its extreme within the frame cap', () => {
		const max = 2_147_483_647;
		const line = farmingIngameStateLine({ phase: 'provisional', err: 'observe', elapsed: max,
			observed: max, net: -2_147_483_648, lo: max, hi: max, age: max, slots: max,
			slotSrc: 'unknown', slotAge: max, goal: 'duration', target: max, progress: max,
			eta: max, mf: max, mfKind: 'partial', prep: 'attention',
		}, 'x'.repeat(22), max);
		expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(512);
	});
});
