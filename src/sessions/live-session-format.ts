import { LIVE_SESSION_NOTE_WRITE_VERSION, livePriceBasisOf, type LiveSessionFormat } from './live-session-model';
import { keys, record } from './live-session-reducer';

/**
 * The format of a live session (`LiveSessionFormat`), saved beside the CLOSED runtime record, which cannot hold it (a 0.6.12
 * plugin that finds an extra key in that record refuses to load it, and no session can start). It lives under its own key of the
 * same runtime store, which no earlier plugin reads, and names the session it belongs to: the mark of one session says nothing
 * about another. It is written in the same transaction as the first record of the session, so a session never exists without
 * the mark it started with. The mark outlives its session, until the next one starts and writes its own.
 */
export const LIVE_SESSION_FORMAT_KEY = 'live-session-format';

export interface LiveSessionFormatMark extends LiveSessionFormat { version: 1; sessionId: string }

/**
 * A session with no mark: one started by a plugin from before the mark existed (up to 0.6.24). Those kept every sample and
 * valued in net per unit, and so do they until they are closed and their note saved, whatever this build starts new sessions in.
 */
export const LEGACY_LIVE_SESSION_FORMAT: LiveSessionFormat = Object.freeze({ noteVersion: 1, priceBasis: 'instant_sell_net' });

/** What a session this build starts is kept and written as: the one thing `LIVE_SESSION_NOTE_WRITE_VERSION` decides. */
export function newLiveSessionFormat(): LiveSessionFormat {
	return { noteVersion: LIVE_SESSION_NOTE_WRITE_VERSION, priceBasis: livePriceBasisOf(LIVE_SESSION_NOTE_WRITE_VERSION) };
}

/**
 * A note of version 1 states net per unit and nothing else (it is all a 0.6.16 reads), so a session kept in gross prices cannot
 * be a version 1 session: that pair is not a format. Version 2 goes with either basis.
 */
export function isLiveSessionFormat(value: unknown): value is LiveSessionFormat {
	return record(value) && (value.noteVersion === 1 && value.priceBasis === 'instant_sell_net'
		|| value.noteVersion === 2 && (value.priceBasis === 'instant_sell_net' || value.priceBasis === 'instant_sell_gross'));
}

export function isLiveSessionFormatMark(value: unknown): value is LiveSessionFormatMark {
	return record(value) && keys(value, ['version', 'sessionId', 'noteVersion', 'priceBasis']) && value.version === 1
		&& typeof value.sessionId === 'string' && value.sessionId.length > 0 && isLiveSessionFormat(value);
}

export function liveSessionFormatMark(sessionId: string, format: LiveSessionFormat): LiveSessionFormatMark {
	return { version: 1, sessionId, noteVersion: format.noteVersion, priceBasis: format.priceBasis };
}

/** A mark that names `sessionId` and cannot be read: nothing says what that session's journal and prices are. */
export class LiveSessionFormatUnreadableError extends Error {
	constructor() { super('The format of the live session cannot be read.'); this.name = 'LiveSessionFormatUnreadableError'; }
}

/**
 * The format of the session `sessionId`, from whatever is stored under `LIVE_SESSION_FORMAT_KEY`. No mark, or the mark of
 * another session, is a session from before the mark: `LEGACY_LIVE_SESSION_FORMAT`. A mark of THIS session that does not
 * validate (a later plugin's, or a damaged one) throws: guessing would read gross prices as net or look for samples the
 * journal never kept, so the session is left as it is on disk until something can read its mark.
 */
export function liveSessionFormatOf(stored: unknown, sessionId: string): LiveSessionFormat {
	if (!record(stored) || stored.sessionId !== sessionId) return { ...LEGACY_LIVE_SESSION_FORMAT };
	if (!isLiveSessionFormatMark(stored)) throw new LiveSessionFormatUnreadableError();
	return { noteVersion: stored.noteVersion, priceBasis: stored.priceBasis };
}
