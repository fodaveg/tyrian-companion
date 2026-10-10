import type { LocalDebugCode } from '../core/local-debug-contract';

/** Why a stop (or a discard) of a live session did not happen. Names a step, never data of the session. */
export type LiveStopFailure = 'no_session' | 'disabled' | 'other_session' | 'lease_not_owned' | 'clock_anomaly' | 'journal_close_refused'
	| 'record_stale' | 'storage_unavailable' | 'note_not_saved' | 'unknown';

/**
 * Thrown by «Terminar sesión» and by «Descartar sesión» when the live session did not finish or was not dropped. Before it the
 * stop threw a bare `Error`, the command controller logged it as `unknown_failure` / `Error` and the player read «no se pudo
 * completar la acción»: nothing said which step refused. `code` is an own string property so the log's error fingerprint
 * (`unmappedErrorLogDetails`) carries it, and `during` says which of the two actions it was.
 */
export class LiveSessionStopError extends Error {
	constructor(readonly code: LiveStopFailure, readonly during: 'finish' | 'discard' = 'finish') {
		super(`Live session ${during} failed: ${code}.`);
		this.name = 'LiveSessionStopError';
	}
}

/** The closed diagnostic code each reason is logged under. */
export function liveStopFailureLogCode(reason: LiveStopFailure): LocalDebugCode {
	switch (reason) {
		case 'record_stale': case 'storage_unavailable': case 'journal_close_refused': case 'note_not_saved': return 'storage_failure';
		case 'lease_not_owned': case 'clock_anomaly': case 'other_session': case 'no_session': case 'disabled': return 'precondition_failed';
		case 'unknown': return 'internal_failure';
	}
}

type FinishKey = 'commands.finishFailed.stale' | 'commands.finishFailed.lease' | 'commands.finishFailed.clock' | 'commands.finishFailed.storage'
	| 'commands.finishFailed.note' | 'commands.finishFailed.other';
type DiscardKey = 'commands.discardFailed.stale' | 'commands.discardFailed.lease' | 'commands.discardFailed.clock' | 'commands.discardFailed.storage'
	| 'commands.discardFailed.other';

/** The notice key that tells the player what to do for each reason. */
export function liveStopFailureNoticeKey(error: Pick<LiveSessionStopError, 'code' | 'during'>): FinishKey | DiscardKey {
	if (error.during === 'discard') {
		switch (error.code) {
			case 'record_stale': return 'commands.discardFailed.stale';
			case 'lease_not_owned': return 'commands.discardFailed.lease';
			case 'clock_anomaly': return 'commands.discardFailed.clock';
			case 'storage_unavailable': return 'commands.discardFailed.storage';
			default: return 'commands.discardFailed.other';
		}
	}
	switch (error.code) {
		case 'record_stale': return 'commands.finishFailed.stale';
		case 'lease_not_owned': return 'commands.finishFailed.lease';
		case 'clock_anomaly': return 'commands.finishFailed.clock';
		case 'storage_unavailable': case 'journal_close_refused': return 'commands.finishFailed.storage';
		case 'note_not_saved': return 'commands.finishFailed.note';
		default: return 'commands.finishFailed.other';
	}
}
