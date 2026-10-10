/**
 * The fixed set of Leyspring Hollows achievements the player follows, in the order of their own
 * checklist, with the wiki page that documents each one. The links are DATA: the plugin never
 * requests the wiki (`docs/PLATFORM_POLICY.md`), it only writes these addresses into the note.
 */

/** Achievement "Leyspring Hollows Mastery": its last tier's `count` is the threshold of the mastery. */
export const LEYSPRING_MASTERY_ACHIEVEMENT_ID = 9417;

const WIKI_PAGE_BASE = 'https://wiki.guildwars2.com/wiki/';
const LEYSPRING_PAGE = 'Leyspring_Hollows_%28achievements%29';
const CASTORAN_PAGE = 'Castoran_Culture';
const RENOWN_PAGE = 'Renown_Hearts_%28Visions_of_Eternity%29';

/** `[achievement id, wiki page]`; the anchor is always `#achievement<id>`. */
const LEYSPRING_ENTRIES: readonly (readonly [number, string])[] = [
	[9368, CASTORAN_PAGE],
	[9470, LEYSPRING_PAGE],
	[9401, LEYSPRING_PAGE],
	[9377, LEYSPRING_PAGE],
	[9393, LEYSPRING_PAGE],
	[9438, LEYSPRING_PAGE],
	[9372, LEYSPRING_PAGE],
	[9355, LEYSPRING_PAGE],
	[9431, LEYSPRING_PAGE],
	[9464, LEYSPRING_PAGE],
	[9446, LEYSPRING_PAGE],
	[9360, LEYSPRING_PAGE],
	[9351, LEYSPRING_PAGE],
	[9383, LEYSPRING_PAGE],
	[9407, LEYSPRING_PAGE],
	[9443, LEYSPRING_PAGE],
	[9420, LEYSPRING_PAGE],
	[9408, LEYSPRING_PAGE],
	[9378, RENOWN_PAGE],
	[9369, RENOWN_PAGE],
	[9462, LEYSPRING_PAGE],
	[9366, LEYSPRING_PAGE],
	[9439, LEYSPRING_PAGE],
	[9399, LEYSPRING_PAGE],
	[9415, LEYSPRING_PAGE],
	[9392, LEYSPRING_PAGE],
	[9448, LEYSPRING_PAGE],
	[9465, LEYSPRING_PAGE],
	[9397, CASTORAN_PAGE],
	[9390, LEYSPRING_PAGE],
	[9367, LEYSPRING_PAGE],
	[9442, LEYSPRING_PAGE],
	[9468, LEYSPRING_PAGE],
	[9424, LEYSPRING_PAGE],
	[9457, LEYSPRING_PAGE],
	[9466, LEYSPRING_PAGE],
	[9455, LEYSPRING_PAGE],
	[9452, LEYSPRING_PAGE],
	[9425, LEYSPRING_PAGE],
	[9430, LEYSPRING_PAGE],
	[9428, LEYSPRING_PAGE],
	[9441, LEYSPRING_PAGE],
	[9433, CASTORAN_PAGE],
	[9356, LEYSPRING_PAGE],
	[9434, LEYSPRING_PAGE],
	[9374, LEYSPRING_PAGE],
];

export interface TrackedAchievement {
	id: number;
	/** Exact wiki address (page and anchor). */
	url: string;
}

export const LEYSPRING_TRACKED_ACHIEVEMENTS: readonly TrackedAchievement[] = Object.freeze(
	LEYSPRING_ENTRIES.map(([id, page]) => Object.freeze({ id, url: `${WIKI_PAGE_BASE}${page}#achievement${String(id)}` })),
);
