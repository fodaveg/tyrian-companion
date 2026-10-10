import type { LocalDebugCode } from '../core/local-debug-contract';

/** Why a stop of a live session answered false. Names a step of the stop, never data of the session. */
export type LiveStopFailure = 'no_session' | 'disabled' | 'other_session' | 'lease_not_owned' | 'journal_close_refused' | 'record_stale'
	| 'storage_unavailable' | 'note_not_saved' | 'unknown';

/**
 * Thrown by «Terminar sesión» when the live session did not finish. Before it the stop threw a bare `Error`, the command
 * controller logged it as `unknown_failure` / `Error` and the player read «no se pudo completar la acción»: nothing said
 * which step refused. `code` is an own string property so the log's error fingerprint (`unmappedErrorLogDetails`) carries it.
 */
export class LiveSessionStopError extends Error {
	constructor(readonly code: LiveStopFailure) {
		super(`Live session finish failed: ${code}.`);
		this.name = 'LiveSessionStopError';
	}
}

/** The closed diagnostic code each reason is logged under. */
export function liveStopFailureLogCode(reason: LiveStopFailure): LocalDebugCode {
	switch (reason) {
		case 'record_stale': case 'storage_unavailable': case 'journal_close_refused': case 'note_not_saved': return 'storage_failure';
		case 'lease_not_owned': case 'other_session': case 'no_session': case 'disabled': return 'precondition_failed';
		case 'unknown': return 'internal_failure';
	}
}

/** The notice key that tells the player what to do for each reason. */
export function liveStopFailureNoticeKey(reason: LiveStopFailure):
	'commands.finishFailed.stale' | 'commands.finishFailed.lease' | 'commands.finishFailed.storage' | 'commands.finishFailed.note' | 'commands.finishFailed.other' {
	switch (reason) {
		case 'record_stale': return 'commands.finishFailed.stale';
		case 'lease_not_owned': return 'commands.finishFailed.lease';
		case 'storage_unavailable': case 'journal_close_refused': return 'commands.finishFailed.storage';
		case 'note_not_saved': return 'commands.finishFailed.note';
		default: return 'commands.finishFailed.other';
	}
}
