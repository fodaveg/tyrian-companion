import { HttpTransportError } from './http';

/**
 * Extracts an unmapped error's structural fingerprint for the local debug log: the error's class,
 * and any HTTP status or machine-readable code it carries. Never the message or the stack
 * (local-debug-contract.ts): those are free text, and the whole point of this boundary is to keep
 * the log useful without ever becoming a second place secrets or account data can leak through.
 *
 * Meant for the branch of a failure mapper that could not classify the error into a specific
 * product code: without this, that branch turns a `TypeError`, an `AbortError` and a rejected
 * state transition into the exact same opaque "unexpected" result, and the debug log cannot tell
 * them apart.
 */
export function unmappedErrorLogDetails(error: unknown): Record<string, unknown> {
	const details: Record<string, unknown> = { reason: errorClassName(error) };
	if (error instanceof HttpTransportError) {
		details.code = error.kind;
		if (error.status !== null) details.status = error.status;
	} else {
		const code = stringErrorCode(error);
		if (code !== undefined) details.code = code;
	}
	return details;
}

/** Names the error's class without ever reading its message. */
function errorClassName(error: unknown): string {
	if (error instanceof Error) return error.name || error.constructor.name;
	if (error === null) return 'null';
	if (typeof error !== 'object') return typeof error;
	return error.constructor?.name ?? 'object';
}

/** Reads a plain string `.code` own property (e.g. `SessionStartCaptureError`) without invoking getters. */
function stringErrorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
	if (descriptor === undefined || !('value' in descriptor)) return undefined;
	return typeof descriptor.value === 'string' ? descriptor.value : undefined;
}
