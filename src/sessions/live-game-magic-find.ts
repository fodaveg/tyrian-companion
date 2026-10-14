/**
 * The game's Magic Find for the «En vivo» panel (David, 14 Oct 2026): the last figure the Nexus addon reported over `mf1`
 * (`alerts/magic-find-ingame-state.ts`), held in memory only. Nothing of it is persisted: after a reload the panel shows the
 * account's figure until the addon reports again.
 *
 * A figure counts for `GAME_MAGIC_FIND_FRESH_MS` from the addon's reading. The addon itself reports again every minute while the
 * figure holds and says `null` when it has none, and the bridge says `null` when the connection that reported it closes, so the
 * window only matters for an addon that stops talking without either. Nothing here arms a timer: whoever asks passes the clock.
 * The collector (`tyrian-companion-core.ts`) arms ONE timeout from `msUntilStale` so the views and the note repaint when the
 * figure goes, instead of waiting for the next repaint that something else causes.
 */

import type { MagicFindIngameReading } from '../alerts/magic-find-ingame-state';

/** How long after its reading a figure from the game still counts. */
export const GAME_MAGIC_FIND_FRESH_MS = 120_000;

export class LiveGameMagicFind {
	private latest: MagicFindIngameReading | null = null;

	/**
	 * Takes one report. A figure replaces whatever was held; a `null` drops only a figure of the same connection (one connection
	 * closing does not take away the figure another one reported later). Answers whether `current(nowMs)` changed.
	 */
	observe(reading: MagicFindIngameReading, nowMs: number): boolean {
		const before = this.current(nowMs);
		if (reading.value !== null) this.latest = reading;
		else if (this.latest?.connectionId === reading.connectionId) this.latest = null;
		return this.current(nowMs) !== before;
	}

	/** The game's figure in whole points while it is fresh, otherwise null (the panel then shows the account's). */
	current(nowMs: number): number | null {
		const latest = this.latest;
		if (latest === null || latest.value === null) return null;
		const age = nowMs - latest.observedAtMs;
		return age >= 0 && age <= GAME_MAGIC_FIND_FRESH_MS ? latest.value : null;
	}

	/**
	 * How long until the figure now held stops counting (the first millisecond at which `current` answers null), or null when
	 * there is none to expire. A figure already past its window has none.
	 */
	msUntilStale(nowMs: number): number | null {
		const latest = this.latest;
		if (this.current(nowMs) === null || latest === null) return null;
		return latest.observedAtMs + GAME_MAGIC_FIND_FRESH_MS - nowMs + 1;
	}
}
