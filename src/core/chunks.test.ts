import { describe, expect, it } from 'vitest';

import { chunks } from './chunks';

// The body every pre-extraction copy shared (advisor evidence, Halloween evidence, price history,
// commerce listings, session price snapshot, session item types and the catalog `chunk`).
function legacyChunks<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

describe('chunks', () => {
	it('splits in order with a shorter final slice', () => {
		expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it('returns one slice when the size covers the input and none for an empty input', () => {
		expect(chunks([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
		expect(chunks([1, 2, 3], 200)).toEqual([[1, 2, 3]]);
		expect(chunks([], 5)).toEqual([]);
	});

	it('handles size one and an exact multiple', () => {
		expect(chunks(['a', 'b'], 1)).toEqual([['a'], ['b']]);
		expect(chunks([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
	});

	it('copies slices without mutating a readonly input', () => {
		const input: readonly number[] = Object.freeze([1, 2, 3]);
		const [first] = chunks(input, 2);
		first!.push(9);
		expect(input).toEqual([1, 2, 3]);
	});

	it('matches the legacy body for non-integer sizes as well', () => {
		for (const size of [0.5, 1.5, 2.5, 7]) {
			expect(chunks([1, 2, 3, 4, 5, 6], size)).toEqual(legacyChunks([1, 2, 3, 4, 5, 6], size));
		}
	});
});
