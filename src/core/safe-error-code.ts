/**
 * The one way a failure's cause reaches the screen or the persisted settings: a short, stable
 * snake_case code, never a free message. Our own errors already carry such a code as their message
 * (`inventory_capture_identity_mismatch`); a foreign error (a browser or IndexedDB rejection, whose
 * message can be anything) is reduced to its class. No path here reads a stack or any other field.
 */

/** A code an `Error` message may carry to be shown as-is: snake_case, `:` for a sub-code, 80 chars at most. */
const SAFE_MESSAGE_CODE = /^[a-z][a-z0-9_:]{0,79}$/;
/** The bound of a full cause (a prefix plus a safe code) as displayed and persisted. */
const SAFE_CAUSE = /^[a-z][a-z0-9_:]{0,119}$/;

/** Whether a value is a well-formed cause code (the shape the settings normalizer accepts). */
export function isSafeCause(value: unknown): value is string {
	return typeof value === 'string' && SAFE_CAUSE.test(value);
}

/**
 * The safe code of a rejection: its message when that already is a code in the closed format,
 * else its class name in snake_case (`TypeError` -> `type_error`). A message that is free text
 * (spaces, capitals, digits first, values of the account) is never used.
 */
export function safeErrorCode(error: unknown): string {
	if (!(error instanceof Error)) return 'non_error';
	if (SAFE_MESSAGE_CODE.test(error.message)) return error.message;
	const name = error.name || error.constructor.name;
	const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);
	return /^[a-z]/.test(snake) ? snake : 'error';
}
