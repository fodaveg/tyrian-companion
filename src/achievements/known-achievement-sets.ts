/**
 * Metas whose elements the public API does not give: the achievements that count towards them
 * are fixed DATA taken from the official wiki, like `leyspring-set.ts`. The plugin never requests
 * the wiki (`docs/PLATFORM_POLICY.md`); a set is only a list of ids that the «Logros» section
 * reads as the elements of the followed meta (`tracked-achievements-model.ts`), with the same
 * checks, links and progress as the elements of a category.
 *
 * A meta with a known set uses it before the category rule (`plausibleCategoryMembers`).
 */

/**
 * «Seasons of the Dragons» (5790, «Temporadas de los dragones»): the bar asks for 24 of the Return
 * meta-achievements. Source: https://wiki.guildwars2.com/wiki/Current_Events?action=raw (the page
 * «Seasons of the Dragons» redirects there), the `objectives` of the achievement row `id = 5790`,
 * read on 10 oct 2026: «Complete all 24 Return meta-achievements», 23 «Return to …» metas plus
 * «End Conjecture» (5960), in the order of the wiki. Each id was crossed with
 * `/v2/achievements?ids=…` (en): all 24 exist, 23 flagged `CategoryDisplay`, and the wiki's
 * 24 equals the bar's last tier. One id differs: the wiki links «Return to Siren's Landing» with
 * `#achievement9991`, an id the API does not serve; the API's achievement of that name is 5748.
 */
const SEASONS_OF_THE_DRAGONS: readonly number[] = [
	5773, 5804, 5829, 5758, 5742, 5743, 5779, 5756, 5751, 5748, 5948, 5884,
	6005, 5901, 6023, 5995, 5888, 5991, 6024, 5886, 5869, 5926, 5861, 5960,
];

const KNOWN_SETS: ReadonlyMap<number, readonly number[]> = new Map([[5790, SEASONS_OF_THE_DRAGONS]]);

/** The ids that count towards the meta `id`, in the wiki's order; null when there is no known set for it. */
export function knownSetMembersOf(id: number): number[] | null {
	const members = KNOWN_SETS.get(id);
	return members === undefined ? null : [...members];
}
