import type { LiveSessionRuntimeRecord } from './live-session-model';

/**
 * The character an ACTIVE live session is playing now: the one of its current context, else the
 * last one it registered. A loading or character-select screen never reaches the record (the
 * lifecycle refuses it), so the last known character stays and nothing empties or flickers.
 * Null with no active live session: a closed one keeps showing what it showed.
 */
export function currentLiveSessionCharacter(record: LiveSessionRuntimeRecord | null): string | null {
	if (record === null || record.phase !== 'active') return null;
	return record.context?.character ?? null;
}
