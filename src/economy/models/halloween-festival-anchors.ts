import {
	isFestivalAnchorsTable,
	sha256FestivalAnchorsTable,
	type FestivalAnchorsTableV1,
} from '../seasonal-window';

/**
 * H18.20's curated replacement for the fixed-`MM-DD` guess `halloween-season.ts` still uses for
 * the bag's OWN wide season: the real, per-year first day of Shadow of the Mad King, one entry per
 * announced edition, straight from the wiki's own list (never computed, never interpolated).
 *
 * 2026 is the edition this table exists to get right: the festival opens 13 October, not the 5th
 * the plugin used to assume nor the 18th its widest historical edition needed. 2019-2025 line up
 * with the seven editions `docs/audit/2026-09-11-festivales-datawars2.md`'s backtest already used,
 * so the anchored windows below reproduce the SAME real start days that backtest measured against.
 *
 * A year missing from `entries` (2027 onward, until announced) is deliberate: `festivalAnchorStartMs`
 * returns `null` for it, and every caller downstream treats that as "no coverage", never a guess.
 */
const SOURCE_ID = 'gw2-wiki-halloween-editions';
const RETRIEVED_AT = '2026-09-24T00:00:00.000Z';
const PUBLISHED_AT = '2026-09-24T00:00:00.000Z';
const REVIEWED_AT = '2026-09-24T05:00:00.000Z';

const CANDIDATE: FestivalAnchorsTableV1 = {
	version: 1,
	festivalId: 'halloween',
	publishedAt: PUBLISHED_AT,
	reviewedAt: REVIEWED_AT,
	sources: [{
		id: SOURCE_ID,
		url: 'https://wiki.guildwars2.com/index.php?title=Halloween&oldid=3191894',
		retrievedAt: RETRIEVED_AT,
	}],
	entries: [
		{ year: 2019, startsOn: '2019-10-15', sourceId: SOURCE_ID },
		{ year: 2020, startsOn: '2020-10-13', sourceId: SOURCE_ID },
		{ year: 2021, startsOn: '2021-10-05', sourceId: SOURCE_ID },
		{ year: 2022, startsOn: '2022-10-18', sourceId: SOURCE_ID },
		{ year: 2023, startsOn: '2023-10-17', sourceId: SOURCE_ID },
		{ year: 2024, startsOn: '2024-10-15', sourceId: SOURCE_ID },
		{ year: 2025, startsOn: '2025-10-07', sourceId: SOURCE_ID },
		{ year: 2026, startsOn: '2026-10-13', sourceId: SOURCE_ID },
	],
	sha256: '',
};
CANDIDATE.sha256 = sha256FestivalAnchorsTable(CANDIDATE);

if (!isFestivalAnchorsTable(CANDIDATE)) throw new Error('Invalid built-in Halloween festival anchors table.');

export const HALLOWEEN_FESTIVAL_ANCHORS: FestivalAnchorsTableV1 = Object.freeze(CANDIDATE);
