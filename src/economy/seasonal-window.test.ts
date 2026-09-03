import { describe, expect, it } from 'vitest';

import { HALLOWEEN_SEASONAL_WINDOW } from './models/halloween-season';
import {
	isSeasonalWindow,
	seasonalWindowClosesAfterMs,
	seasonalWindowStatusAt,
	seasonalWindowStatusAtMs,
	type SeasonalWindowV1,
} from './seasonal-window';

describe('seasonal window', () => {
	it('opens and closes the declared Halloween window on its exact boundary days', () => {
		expect(isSeasonalWindow(HALLOWEEN_SEASONAL_WINDOW)).toBe(true);
		expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, '2026-09-30T23:59:59.999Z')).toBe('out_of_season');
		expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, '2026-10-01T00:00:00.000Z')).toBe('in_season');
		expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, '2026-10-31T23:00:00.000Z')).toBe('in_season');
		expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, '2026-11-15T23:59:59.999Z')).toBe('in_season');
		expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, '2026-11-16T00:00:00.000Z')).toBe('out_of_season');
		// The months the plugin used to keep polling for a festival that was over.
		for (const month of ['01', '03', '06', '09', '12']) {
			expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, `2026-${month}-15T12:00:00.000Z`)).toBe('out_of_season');
		}
	});

	it('reads a window that wraps across new year without inverting it', () => {
		const wintersday: SeasonalWindowV1 = {
			version: 1, seasonId: 'wintersday', opensOn: '12-15', closesOn: '01-05', returnsInMonth: 12,
		};
		expect(isSeasonalWindow(wintersday)).toBe(true);
		expect(seasonalWindowStatusAt(wintersday, '2026-12-14T00:00:00.000Z')).toBe('out_of_season');
		expect(seasonalWindowStatusAt(wintersday, '2026-12-31T23:00:00.000Z')).toBe('in_season');
		expect(seasonalWindowStatusAt(wintersday, '2027-01-05T12:00:00.000Z')).toBe('in_season');
		expect(seasonalWindowStatusAt(wintersday, '2027-01-06T00:00:00.000Z')).toBe('out_of_season');
		expect(seasonalWindowStatusAt(wintersday, '2027-07-01T00:00:00.000Z')).toBe('out_of_season');
	});

	it('rejects 29 February as a boundary because it exists one year in four', () => {
		expect(isSeasonalWindow({ ...HALLOWEEN_SEASONAL_WINDOW, opensOn: '02-29', returnsInMonth: 2 })).toBe(false);
		expect(isSeasonalWindow({ ...HALLOWEEN_SEASONAL_WINDOW, closesOn: '02-29' })).toBe(false);
		expect(isSeasonalWindow({ ...HALLOWEEN_SEASONAL_WINDOW, closesOn: '02-28' })).toBe(true);
		expect(isSeasonalWindow({ ...HALLOWEEN_SEASONAL_WINDOW, closesOn: '04-31' })).toBe(false);
	});

	it('answers undecidable instead of in_season for an unreadable window or clock', () => {
		expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, 'not-a-date')).toBe('undecidable');
		expect(seasonalWindowStatusAt(HALLOWEEN_SEASONAL_WINDOW, null)).toBe('undecidable');
		expect(seasonalWindowStatusAtMs(HALLOWEEN_SEASONAL_WINDOW, Number.NaN)).toBe('undecidable');
		expect(seasonalWindowStatusAtMs({ opensOn: '10-01' }, Date.parse('2026-10-16T00:00:00.000Z'))).toBe('undecidable');
	});

	it('binds the month named to the player to the month the window opens', () => {
		expect(HALLOWEEN_SEASONAL_WINDOW.returnsInMonth).toBe(10);
		expect(isSeasonalWindow({ ...HALLOWEEN_SEASONAL_WINDOW, returnsInMonth: 11 })).toBe(false);
		expect(isSeasonalWindow({ ...HALLOWEEN_SEASONAL_WINDOW, seasonId: 'Halloween' })).toBe(false);
		expect(isSeasonalWindow({ ...HALLOWEEN_SEASONAL_WINDOW, version: 2 })).toBe(false);
	});
});

/**
 * H13.7 measures "the pack must outlive its own window" against this instant,
 * so the instant has to be the END of the closing day, not its start.
 *
 * A pack expiring at 2026-11-15T00:00:00Z would die at midnight with the last
 * day of the festival still to run, and comparing against the start of the day
 * would call that acceptable. The difference is one day and it is the entire
 * defect the ticket exists to remove, so it is asserted directly rather than
 * inferred from a pack whose margin is wide enough to hide it.
 */
describe('H13.7 end of the window', () => {
	it('lands at midnight AFTER the closing day, counting that day in full', () => {
		const closes = seasonalWindowClosesAfterMs(HALLOWEEN_SEASONAL_WINDOW, Date.parse('2026-08-14T18:04:33.000Z'));

		expect(closes).toBe(Date.parse('2026-11-16T00:00:00.000Z'));
		expect(closes).not.toBe(Date.parse('2026-11-15T00:00:00.000Z'));
		// The last minute of the festival is still inside the window it closes.
		expect(seasonalWindowStatusAtMs(HALLOWEEN_SEASONAL_WINDOW, Date.parse('2026-11-15T23:59:59.999Z')))
			.toBe('in_season');
		expect(seasonalWindowStatusAtMs(HALLOWEEN_SEASONAL_WINDOW, closes ?? 0)).toBe('out_of_season');
	});

	it('rolls to next year once this year\'s window has already closed', () => {
		expect(seasonalWindowClosesAfterMs(HALLOWEEN_SEASONAL_WINDOW, Date.parse('2026-12-01T00:00:00.000Z')))
			.toBe(Date.parse('2027-11-16T00:00:00.000Z'));
	});

	it('returns the same year when asked from inside the window', () => {
		expect(seasonalWindowClosesAfterMs(HALLOWEEN_SEASONAL_WINDOW, Date.parse('2026-10-20T00:00:00.000Z')))
			.toBe(Date.parse('2026-11-16T00:00:00.000Z'));
	});

	it('answers null for an unreadable window or clock rather than guessing', () => {
		expect(seasonalWindowClosesAfterMs({ opensOn: '10-01' }, Date.parse('2026-10-16T00:00:00.000Z'))).toBeNull();
		expect(seasonalWindowClosesAfterMs(HALLOWEEN_SEASONAL_WINDOW, Number.NaN)).toBeNull();
		expect(seasonalWindowClosesAfterMs(HALLOWEEN_SEASONAL_WINDOW, 'today')).toBeNull();
	});
});
