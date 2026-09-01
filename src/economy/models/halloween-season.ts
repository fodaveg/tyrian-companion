import { isSeasonalWindow, type SeasonalWindowV1 } from '../seasonal-window';

/**
 * Declared window for Shadow of the Mad King.
 *
 * ArenaNet has run the festival inside the second half of October and the
 * first days of November every year since 2012; the exact dates move a little
 * and are announced per year. The window is therefore widened deliberately to
 * 1 October - 15 November UTC: it covers every announced edition so far plus
 * the shoulder in which the bag is still being liquidated, and it errs towards
 * staying open rather than muting a surface while the festival is live.
 *
 * It is a window, not a hardcoded date check: it lives inside the curated
 * economy pack, is hashed with it, and can be widened by publishing data.
 */
const CANDIDATE: SeasonalWindowV1 = {
	version: 1,
	seasonId: 'halloween',
	opensOn: '10-01',
	closesOn: '11-15',
	returnsInMonth: 10,
};

if (!isSeasonalWindow(CANDIDATE)) throw new Error('Invalid built-in Halloween seasonal window.');

export const HALLOWEEN_SEASONAL_WINDOW: SeasonalWindowV1 = Object.freeze(CANDIDATE);
