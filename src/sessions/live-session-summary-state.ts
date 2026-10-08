import { LIVE_SESSION_MAX_CHARACTERS, type LiveSessionCharacterV1 } from './live-session-model';
import { date, keys, record } from './live-session-reducer';

/**
 * Local facts about a live session that the CLOSED runtime record cannot hold (a 0.6.12 plugin that
 * finds an extra key in that record refuses to load it, and no session can start): the characters it
 * saw, and whether its summary note was already written. They live under their own key of the same
 * runtime store, which 0.6.12 never reads. A name is measured in code points, like the context the reducer validates. Losing or failing to read it only costs the character line
 * and one extra attempt at the summary; nothing else depends on it.
 */
export const LIVE_SUMMARY_STATE_KEY = 'live-session-summary-state';

export interface LiveSessionSummaryState {
	version: 1;
	sessionId: string;
	characters: LiveSessionCharacterV1[];
	/** True once the list reached its cap and later names were dropped. */
	capped: boolean;
	/** The summary note of this session was written (or found already there): never written again. */
	summaryWritten: boolean;
}

export function isLiveSessionSummaryState(value: unknown): value is LiveSessionSummaryState {
	return record(value) && keys(value, ['version', 'sessionId', 'characters', 'capped', 'summaryWritten']) && value.version === 1
		&& typeof value.sessionId === 'string' && value.sessionId.length > 0 && typeof value.capped === 'boolean' && typeof value.summaryWritten === 'boolean'
		&& Array.isArray(value.characters) && value.characters.length <= LIVE_SESSION_MAX_CHARACTERS
		&& value.characters.every((entry) => record(entry) && keys(entry, ['name', 'fromAt']) && typeof entry.name === 'string'
			&& entry.name.length > 0 && [...entry.name].length <= 32 && date(entry.fromAt));
}

/** Adds a character seen at `at` when it differs from the last one; at the cap the list stops and says so. */
export function withCharacter(state: LiveSessionSummaryState, name: string, at: string): LiveSessionSummaryState {
	if (state.characters.at(-1)?.name === name) return state;
	if (state.characters.length >= LIVE_SESSION_MAX_CHARACTERS) return { ...state, capped: true };
	return { ...state, characters: [...state.characters, { name, fromAt: at }] };
}
