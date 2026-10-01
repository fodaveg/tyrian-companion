/**
 * Splits `values` into consecutive slices of at most `size` items, in order. The caller passes a
 * positive integer: a `size` of zero or below never advances the cursor, so it must not be reached.
 */
export function chunks<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}
