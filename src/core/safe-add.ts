/**
 * Adds two numbers and returns the sum only when it is a safe integer, so a negative sum is
 * allowed; anything else (an unsafe integer, a fraction, NaN or an infinity) throws
 * `Error(message)`. Callers keep their own message because it is what their users and tests see.
 */
export function safeAddOrThrow(left: number, right: number, message: string): number {
	const result = left + right;
	if (!Number.isSafeInteger(result)) throw new Error(message);
	return result;
}
