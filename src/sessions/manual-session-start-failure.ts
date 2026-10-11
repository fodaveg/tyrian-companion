/**
 * The errors `ManualSessionStartService` throws inside its own flows and the builder of a start
 * failure. Mapping a thrown error to a product failure stays in the service (`mapFailure`,
 * `mapStopFailure`): it reads `HttpTransportError`, and only the reviewed service imports `core/http`.
 */
import type { SessionTransitionRejection } from './session';
import type { SessionStartFailure } from './manual-session-start-model';

/**
 * A state-machine rejection the service could not map to a product failure. `code` is the machine
 * reason (`illegal_transition`, `invariant_violation`...): `unmappedErrorLogDetails` logs it as
 * `details.code` and never the message.
 */
export class SessionTransitionRejectedError extends Error {
	constructor(readonly code: SessionTransitionRejection) {
		super(`Session transition rejected: ${code}`);
		this.name = 'SessionTransitionRejectedError';
	}
}

export class ManualSessionStartError extends Error {
	constructor(readonly failure: SessionStartFailure) {
		super(failure.message);
		this.name = 'ManualSessionStartError';
	}
}

export function failure(code: SessionStartFailure['code'], message: string): SessionStartFailure {
	return { code, message };
}
