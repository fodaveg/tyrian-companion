/**
 * Pure Magic Find math: three account-wide, API-observable components (Luck, achievement
 * points, and amulet enrichment) plus a caller-supplied consumables bonus the API never exposes
 * (food, utility, reinforcements, guild banners, Guild Item Research, map effects).
 *
 * Every constant below is game data, not plugin behavior, and is cited so a maintainer can tell
 * what would invalidate it:
 * - `LUCK_MAGIC_FIND_CUMULATIVE_THRESHOLDS` is the "Total luck required" column of the wiki's
 *   Luck progression table (https://wiki.guildwars2.com/wiki/Luck#Progression, fetched
 *   2026-09-18). It is transcribed as a table, not a closed formula, because ArenaNet's own
 *   scaling is not smooth level to level. The 300th (last) entry, 4,295,450, is the number the
 *   same page cites in prose as "reaching the cap of 300% costs 4,295,450 luck" — the account
 *   measured against this module on 17 sep 2026 had consumed 4,297,255, past that cap. It goes
 *   stale only if ArenaNet reshapes the Luck curve or raises the 300% cap; neither has ever
 *   happened.
 * - The achievement-points rule (`magicFindFromAchievementPoints`) is the wiki's own prose on the
 *   Magic Find page's "Static bonuses" section
 *   (https://wiki.guildwars2.com/wiki/Magic_Find#Static_bonuses, fetched 2026-09-18): "increase
 *   Magic Find by 1% starting at 500 AP and at each increment of 2,500 AP thereafter; an
 *   additional 1% is awarded for every 5,000 AP." It goes stale if ArenaNet changes that reward
 *   schedule.
 * - `MAGICAL_ENRICHMENT_ITEM_ID` (39333) is "Magical Enrichment": the wiki's name
 *   (https://wiki.guildwars2.com/wiki/Magic_Find#Static_bonuses) and the live GW2 API's own name
 *   for it (`GET https://api.guildwars2.com/v2/items/39333`, fetched 2026-09-18), the only PvE
 *   amulet enrichment that grants +20% Magic Find; the wiki notes it is ignored in PvP. It goes
 *   stale only if ArenaNet retires this specific item id for a new one.
 */

/** The magic find from Luck alone never exceeds this, no matter how much Luck is consumed. */
export const MAGIC_FIND_FROM_LUCK_CAP = 300;

/** "Magical Enrichment": the amulet infusion-slot item that grants +20% Magic Find in PvE. */
export const MAGICAL_ENRICHMENT_ITEM_ID = 39333;
export const MAGICAL_ENRICHMENT_MAGIC_FIND = 20;

/**
 * Cumulative Luck required to reach magic find level `n` (1-indexed): index `n - 1` holds the
 * total Luck needed for `n`% base magic find from Luck alone. Exactly 300 entries, one per
 * percentage point up to the 300% cap.
 */
export const LUCK_MAGIC_FIND_CUMULATIVE_THRESHOLDS: readonly number[] = Object.freeze([
	100, 200, 300, 400, 500, 600, 700, 800, 910, 1020,
	1130, 1240, 1360, 1480, 1600, 1730, 1860, 2000, 2150, 2300,
	2460, 2630, 2810, 3000, 3200, 3410, 3630, 3860, 4110, 4370,
	4640, 4930, 5240, 5560, 5900, 6260, 6640, 7040, 7460, 7900,
	8370, 8860, 9380, 9920, 10490, 11090, 11720, 12380, 13070, 13790,
	14550, 15340, 16170, 17030, 17930, 18870, 19850, 20870, 21940, 23050,
	24200, 25400, 26650, 27950, 29300, 30700, 32150, 33660, 35220, 36840,
	38510, 40240, 42030, 43890, 45810, 47790, 49840, 51960, 54150, 56410,
	58740, 61140, 63620, 66170, 68800, 71510, 74300, 77170, 80130, 83170,
	86300, 89520, 92830, 96230, 99720, 103300, 106980, 110760, 114640, 118620,
	122700, 126890, 131180, 135580, 140090, 144710, 149440, 154290, 159250, 164330,
	169530, 174850, 180300, 185870, 191570, 197400, 203360, 209450, 215670, 222030,
	228530, 235160, 241940, 248860, 255920, 263130, 270490, 278000, 285660, 293480,
	301460, 309590, 317880, 326340, 334960, 343750, 352710, 361840, 371140, 380610,
	390260, 400090, 410100, 420290, 430660, 441220, 451970, 462910, 474040, 485370,
	496890, 508610, 520530, 532660, 544990, 557530, 570280, 583240, 596420, 609810,
	623420, 637250, 651310, 665590, 680100, 694840, 709810, 725010, 740450, 756130,
	772050, 788210, 804620, 821270, 838170, 855330, 872740, 890410, 908340, 926530,
	944980, 963700, 982690, 1001950, 1021480, 1041290, 1061380, 1081750, 1102400, 1123340,
	1144560, 1166070, 1187880, 1209980, 1232380, 1255080, 1278080, 1301390, 1325000, 1348920,
	1373160, 1397710, 1422580, 1447770, 1473280, 1499120, 1525280, 1551780, 1578610, 1605770,
	1633270, 1661110, 1689290, 1717820, 1746700, 1775930, 1805510, 1835450, 1865450, 1895450,
	1925450, 1955450, 1985450, 2015450, 2045450, 2075450, 2105450, 2135450, 2165450, 2195450,
	2225450, 2255450, 2285450, 2315450, 2345450, 2375450, 2405450, 2435450, 2465450, 2495450,
	2525450, 2555450, 2585450, 2615450, 2645450, 2675450, 2705450, 2735450, 2765450, 2795450,
	2825450, 2855450, 2885450, 2915450, 2945450, 2975450, 3005450, 3035450, 3065450, 3095450,
	3125450, 3155450, 3185450, 3215450, 3245450, 3275450, 3305450, 3335450, 3365450, 3395450,
	3425450, 3455450, 3485450, 3515450, 3545450, 3575450, 3605450, 3635450, 3665450, 3695450,
	3725450, 3755450, 3785450, 3815450, 3845450, 3875450, 3905450, 3935450, 3965450, 3995450,
	4025450, 4055450, 4085450, 4115450, 4145450, 4175450, 4205450, 4235450, 4265450, 4295450,
]);

/** Achievement-point-rewards Magic Find rule (wiki: "Static bonuses", see module doc). */
const ACHIEVEMENT_MAGIC_FIND_START_AP = 500;
const ACHIEVEMENT_MAGIC_FIND_STEP_AP = 2_500;
const ACHIEVEMENT_MAGIC_FIND_EXTRA_STEP_AP = 5_000;

export interface MagicFindBreakdown {
	luck: number;
	achievements: number;
	enrichment: number;
}

/** Magic find granted by consumed Luck, saturating at `MAGIC_FIND_FROM_LUCK_CAP`. */
export function magicFindFromLuck(totalLuck: number): number {
	if (!Number.isFinite(totalLuck) || totalLuck < 0) return 0;
	let level = 0;
	for (const threshold of LUCK_MAGIC_FIND_CUMULATIVE_THRESHOLDS) {
		if (totalLuck < threshold) break;
		level += 1;
	}
	return Math.min(level, MAGIC_FIND_FROM_LUCK_CAP);
}

/**
 * Magic find granted by total account achievement points: +1% starting at 500 AP and at each
 * further increment of 2,500 AP, plus an additional +1% for every 5,000 AP.
 */
export function magicFindFromAchievementPoints(points: number): number {
	if (!Number.isSafeInteger(points) || points < 0) return 0;
	const base = points >= ACHIEVEMENT_MAGIC_FIND_START_AP
		? Math.floor((points - ACHIEVEMENT_MAGIC_FIND_START_AP) / ACHIEVEMENT_MAGIC_FIND_STEP_AP) + 1
		: 0;
	const extra = Math.floor(points / ACHIEVEMENT_MAGIC_FIND_EXTRA_STEP_AP);
	return base + extra;
}

/**
 * Magic find granted by the amulet's enrichment slot on the character's ACTIVE PvE equipment
 * tab (`GET characters/:id/equipmenttabs/active`). Only an equipped (not Armory-stored) amulet
 * carrying `MAGICAL_ENRICHMENT_ITEM_ID` in its infusion slot counts; every other slot and every
 * other enrichment grants no PvE Magic Find (stat prefixes never do, per the wiki).
 */
export function magicFindFromActiveEquipment(equipmentTabActive: unknown): number {
	return hasMagicalEnrichmentOnAmulet(equipmentTabActive) ? MAGICAL_ENRICHMENT_MAGIC_FIND : 0;
}

/** Sums the three derivable components with a caller-supplied, API-unobservable consumables bonus. */
export function composeMagicFind(breakdown: MagicFindBreakdown, consumablesBonus = 0): number {
	return breakdown.luck + breakdown.achievements + breakdown.enrichment + consumablesBonus;
}

function hasMagicalEnrichmentOnAmulet(value: unknown): boolean {
	if (!isRecord(value) || !Array.isArray(value.equipment)) return false;
	return value.equipment.some((entry) =>
		isRecord(entry)
		&& entry.slot === 'Amulet'
		&& entry.location === 'Equipped'
		&& Array.isArray(entry.infusions)
		&& entry.infusions.includes(MAGICAL_ENRICHMENT_ITEM_ID));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
