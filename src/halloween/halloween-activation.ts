import { HALLOWEEN_SEASONAL_WINDOW } from '../economy/models/halloween-season';
import { seasonalWindowStatusAtMs } from '../economy/seasonal-window';

/**
 * When the Halloween observation surface is live.
 *
 * H13.3 removed the switch from the alert: David's own words were that he had
 * to turn on too many things to be told about a drop, so the calendar decides.
 * Inside the pack's window (1 October to 15 November UTC) the surface is on
 * whatever the setting says.
 *
 * The setting is not orphaned and is not migrated away: it stays as a manual
 * override that can only WIDEN the window, for the player who keeps farming the
 * labyrinth after the festival closes or who wants the collection surface in
 * March. It can no longer narrow it, which is the whole point of the change.
 *
 * `undecidable` is treated as out of season on purpose. The window is a frozen
 * built-in validated at module load, so the only way to reach `undecidable`
 * here is a clock that is not a safe integer; in that case the manual override
 * is the only honest evidence left, and inventing a festival from a broken
 * clock would be worse than staying quiet.
 */
export function halloweenObservationActive(manualOverride: boolean, nowMs: number): boolean {
	return manualOverride || seasonalWindowStatusAtMs(HALLOWEEN_SEASONAL_WINDOW, nowMs) === 'in_season';
}
