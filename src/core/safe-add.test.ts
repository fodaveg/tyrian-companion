import { describe, expect, it } from 'vitest';

import { safeAddOrThrow } from './safe-add';

// Bodies of the four pre-extraction copies (account storage delta, account contamination,
// economy hold intent, economy reservation), verbatim except that the message is a parameter.
const LEGACY: ReadonlyArray<readonly [string, string, (left: number, right: number) => number]> = [
	['storage-delta', 'Aggregate exceeds the safe integer range.', (left, right) => {
		const result = left + right;
		if (!Number.isSafeInteger(result)) throw new Error('Aggregate exceeds the safe integer range.');
		return result;
	}],
	['contamination', 'Unsafe boundary aggregate.', (left, right) => {
		const value = left + right;
		if (!Number.isSafeInteger(value)) throw new Error('Unsafe boundary aggregate.');
		return value;
	}],
	['hold-intent', 'Unsafe hold sum.', (left, right) => {
		const result = left + right;
		if (!Number.isSafeInteger(result)) throw new Error('Unsafe hold sum.');
		return result;
	}],
	['reservation', 'overflow', (left, right) => { const value = left + right; if (!Number.isSafeInteger(value)) throw new Error('overflow'); return value; }],
];

function outcome(run: () => number): { value: number } | { error: string } {
	try { return { value: run() }; }
	catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

const SAMPLES: ReadonlyArray<readonly [number, number]> = [
	[0, 0], [1, 2], [-1, -2], [-5, 3], [3, -5], [0.5, 0.5], [0.1, 0.2], [1.5, 1],
	[Number.MAX_SAFE_INTEGER, 0], [Number.MAX_SAFE_INTEGER, 1], [Number.MIN_SAFE_INTEGER, 0], [Number.MIN_SAFE_INTEGER, -1],
	[Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER], [Number.NaN, 1], [1, Number.NaN],
	[Number.POSITIVE_INFINITY, 1], [Number.NEGATIVE_INFINITY, 1], [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
];

describe('safeAddOrThrow', () => {
	it('returns exact safe-integer sums, negative ones included', () => {
		expect(safeAddOrThrow(1, 2, 'x')).toBe(3);
		expect(safeAddOrThrow(-5, 3, 'x')).toBe(-2);
		expect(safeAddOrThrow(0.5, 0.5, 'x')).toBe(1);
		expect(safeAddOrThrow(Number.MAX_SAFE_INTEGER, 0, 'x')).toBe(Number.MAX_SAFE_INTEGER);
	});

	it('throws exactly the given message for overflow, fractions, NaN and infinities', () => {
		for (const [left, right] of [[Number.MAX_SAFE_INTEGER, 1], [0.1, 0.2], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1]] as const) {
			expect(() => safeAddOrThrow(left, right, 'the message')).toThrow(new Error('the message'));
		}
	});

	it('behaves exactly like each legacy body for the same inputs, given that body message', () => {
		for (const [name, message, legacy] of LEGACY) {
			for (const [left, right] of SAMPLES) {
				expect(outcome(() => safeAddOrThrow(left, right, message)), `${name} ${left} + ${right}`)
					.toEqual(outcome(() => legacy(left, right)));
			}
		}
	});
});
