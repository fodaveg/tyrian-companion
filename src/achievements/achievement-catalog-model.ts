/**
 * The public achievement catalog of the «Logros» section, as data: the parsers of the three public
 * routes (`achievements/groups`, `achievements/categories`, `achievements?ids=`) and the pure search
 * over the light index. No I/O here; `achievement-catalog-service.ts` fetches and keeps.
 *
 * Every parser refuses a body that is not a list (`null`, which the service reports as
 * `invalid_response`) and skips an entry of an unknown shape, as `leyspring-capture.ts` does: one
 * odd achievement must not cost the player the other 8,000.
 */

/**
 * Schema of `achievements/categories`. From this one on, a category lists its achievements as
 * objects (`{ id, flags?, level?, required_access? }`) instead of bare ids, and adds `tomorrow`.
 */
export const ACHIEVEMENT_CATEGORIES_SCHEMA = '2022-03-23T19:00:00.000Z';

/** The most ids `achievements?ids=` answers in one request. */
export const ACHIEVEMENT_PAGE_SIZE = 200;

export interface AchievementGroup {
	/** A GUID: groups are the only part of the catalog without a numeric id. */
	id: string;
	name: string;
	order: number;
	categoryIds: number[];
}

export interface AchievementCategory {
	id: number;
	name: string;
	order: number;
	icon: string | null;
	/** Today's achievements of the category; the `tomorrow` list of dailies is not read. */
	achievementIds: number[];
}

export interface AchievementTier {
	count: number;
	points: number;
}

/**
 * One objective of an achievement. Its position in `AchievementDetail.bits` is the index the
 * account lists in `bits` when it is done, so a bit of a type this code does not know keeps its
 * slot as `unknown` instead of being dropped: dropping it would shift every later index.
 */
export interface AchievementBit {
	kind: 'text' | 'item' | 'minipet' | 'skin' | 'unknown';
	text: string | null;
	/** The item, mini or skin id, for those kinds. */
	refId: number | null;
}

export type AchievementReward =
	| { kind: 'coins'; copper: number }
	| { kind: 'item'; itemId: number; count: number }
	| { kind: 'mastery'; masteryId: number; region: string }
	| { kind: 'title'; titleId: number };

export interface AchievementDetail {
	id: number;
	name: string;
	description: string;
	requirement: string;
	flags: string[];
	tiers: AchievementTier[];
	bits: AchievementBit[];
	rewards: AchievementReward[];
	/** Most points a repeatable achievement can give; null when the API gives none. */
	pointCap: number | null;
	/** The achievement's own icon as the API gives it (most have none); the view validates the host before showing it. */
	icon: string | null;
}

/**
 * The flag of a category's meta achievement («Leyspring Hollows Mastery», 9417: «Complete N map
 * achievements throughout…»): the game shows it at the top of its category and counts the others.
 */
export const CATEGORY_META_FLAG = 'CategoryDisplay';

/** Periodic achievements come and go: they are never elements of a permanent meta. */
const PERIODIC_FLAGS = new Set(['Daily', 'Weekly', 'Monthly']);

/**
 * A meta achievement of its category: flagged `CategoryDisplay` and without `bits` of its own. Its
 * elements are the other achievements the category lists (`categoryMembersOf`). Measured on
 * 9417 (10 oct 2026): `bits: null`, flags `RepairOnLogin, CategoryDisplay, MoveToTop, Permanent`.
 */
export function isCategoryMetaAchievement(detail: AchievementDetail): boolean {
	return detail.bits.length === 0 && detail.flags.includes(CATEGORY_META_FLAG);
}

export function isPeriodicAchievement(detail: AchievementDetail): boolean {
	return detail.flags.some((flag) => PERIODIC_FLAGS.has(flag));
}

/**
 * The achievements of the first category that lists `id`, in the category's order and without `id`
 * itself; null when no category lists it. The same «first category» rule as `planAchievementIndex`.
 */
export function categoryMembersOf(categories: readonly AchievementCategory[], id: number): number[] | null {
	const category = categories.find((candidate) => candidate.achievementIds.includes(id));
	return category === undefined ? null : category.achievementIds.filter((member) => member !== id);
}

/** The least share of a meta's last tier that its category must list to be taken as where the count comes from. */
export const MIN_CATEGORY_SHARE = 0.4;

/**
 * The members that can be the elements of a category meta, or null when the category cannot be
 * where its count comes from. A meta counts up to its last tier (`tiers`). A category that lists
 * far fewer achievements than that is not what it counts: «Temporadas de los dragones» (5790,
 * 10 oct 2026) asks for 24 «Return» metas and its category «Eventos actuales» lists five unrelated
 * achievements (21 %), as the Rush champions (3 to 9 of 100, 5 of 30) and «The Emperor's New
 * Wardrobe» (7 of 90) do. A small gap is different: «Code of Creation Mastery» (9354) has 24 of 25,
 * «Act 2 Mastery» (8908) 18 of 21, «Master of the Four Winds» (4274) 13 of 25. The API then lacks
 * some of them, but the list is still worth showing (`isPartialCategory` says it is short). Measured
 * on the 209 metas without bits of the API (10 oct 2026): no meta sits between 21 % and 47 %, so
 * `MIN_CATEGORY_SHARE` (40 %) separates the two groups.
 */
export function plausibleCategoryMembers(detail: AchievementDetail, members: readonly number[]): number[] | null {
	const tierMax = lastTierCount(detail);
	return tierMax !== null && members.length < tierMax * MIN_CATEGORY_SHARE ? null : [...members];
}

/** True when the category lists fewer achievements than the meta's last tier: the API does not give all of them. */
export function isPartialCategory(detail: AchievementDetail, members: readonly number[]): boolean {
	const tierMax = lastTierCount(detail);
	return tierMax !== null && members.length < tierMax;
}

function lastTierCount(detail: AchievementDetail): number | null {
	return detail.tiers.length === 0 ? null : Math.max(...detail.tiers.map((tier) => tier.count));
}

/** What the search needs of each achievement, and nothing else: about 8,355 of them per language. */
export interface AchievementIndexEntry {
	id: number;
	name: string;
	/** The first category that lists it; null when no category does. */
	categoryId: number | null;
	flags: string[];
	/** `count` of the last tier, the number the achievement is complete at; null without tiers. */
	tierMax: number | null;
}

export interface AchievementSearchFilter {
	query: string;
	categoryId: number | null;
}

export function parseAchievementGroups(body: unknown): AchievementGroup[] | null {
	if (!Array.isArray(body)) return null;
	const groups: AchievementGroup[] = [];
	for (const raw of body as unknown[]) {
		if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.name !== 'string') continue;
		groups.push({
			id: raw.id,
			name: raw.name,
			order: safeInteger(raw.order) ? raw.order : 0,
			categoryIds: Array.isArray(raw.categories) ? (raw.categories as unknown[]).filter(isPositive) : [],
		});
	}
	return groups;
}

/** Reads the 2022 schema (`ACHIEVEMENT_CATEGORIES_SCHEMA`); a bare-number achievement is skipped. */
export function parseAchievementCategories(body: unknown): AchievementCategory[] | null {
	if (!Array.isArray(body)) return null;
	const categories: AchievementCategory[] = [];
	for (const raw of body as unknown[]) {
		if (!isRecord(raw) || !isPositive(raw.id) || typeof raw.name !== 'string') continue;
		const achievements = Array.isArray(raw.achievements) ? raw.achievements as unknown[] : [];
		categories.push({
			id: raw.id,
			name: raw.name,
			order: safeInteger(raw.order) ? raw.order : 0,
			icon: typeof raw.icon === 'string' && raw.icon.length > 0 ? raw.icon : null,
			achievementIds: achievements.flatMap((entry) => isRecord(entry) && isPositive(entry.id) ? [entry.id] : []),
		});
	}
	return categories;
}

/**
 * Reads one answer of `achievements?ids=`, a 200 or a 206 alike: a 206 only means some requested
 * id did not come. `presentIds` holds every id the body carries, including those of entries this
 * parser could not read, so that only an id the API truly left out is ever taken for retired.
 */
export function parseAchievementPage(body: unknown): { details: AchievementDetail[]; presentIds: Set<number> } | null {
	if (!Array.isArray(body)) return null;
	const details: AchievementDetail[] = [];
	const presentIds = new Set<number>();
	for (const raw of body as unknown[]) {
		if (!isRecord(raw) || !isPositive(raw.id)) continue;
		presentIds.add(raw.id);
		const detail = parseDetail(raw);
		if (detail !== null) details.push(detail);
	}
	return { details, presentIds };
}

export function toAchievementIndexEntry(detail: AchievementDetail, categoryId: number | null): AchievementIndexEntry {
	return {
		id: detail.id,
		name: detail.name,
		categoryId,
		flags: [...detail.flags],
		tierMax: detail.tiers.length === 0 ? null : Math.max(...detail.tiers.map((tier) => tier.count)),
	};
}

/** Validates the light entries as they were kept; a single broken entry refuses the whole page. */
export function parseAchievementIndexEntries(value: unknown): AchievementIndexEntry[] | null {
	if (!Array.isArray(value)) return null;
	const entries: AchievementIndexEntry[] = [];
	for (const raw of value as unknown[]) {
		if (!isRecord(raw) || !isPositive(raw.id) || typeof raw.name !== 'string'
			|| !(raw.categoryId === null || isPositive(raw.categoryId))
			|| !Array.isArray(raw.flags) || !(raw.flags as unknown[]).every((flag) => typeof flag === 'string')
			|| !(raw.tierMax === null || isPositive(raw.tierMax))) return null;
		entries.push({ id: raw.id, name: raw.name, categoryId: raw.categoryId, flags: [...raw.flags as string[]], tierMax: raw.tierMax });
	}
	return entries;
}

/**
 * The ids the index covers, each once, in the order of the categories, with the first category that
 * lists it. An achievement that no category lists is not searchable, which is also how the game
 * shows it: nowhere.
 */
export function planAchievementIndex(categories: readonly AchievementCategory[]): {
	ids: number[];
	categoryOf: ReadonlyMap<number, number>;
} {
	const categoryOf = new Map<number, number>();
	for (const category of categories) {
		for (const id of category.achievementIds) if (!categoryOf.has(id)) categoryOf.set(id, category.id);
	}
	return { ids: [...categoryOf.keys()], categoryOf };
}

/** NFD, without combining marks (accents, diaeresis), lower case, single spaces. */
export function normalizeAchievementSearchText(text: string): string {
	return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * The entries whose name contains the text, within the category when one is chosen. The names
 * that start with the text come first; inside each half the index order stays. An empty text lists
 * the whole category, and nothing when there is no category either.
 */
export function searchAchievementIndex(
	entries: readonly AchievementIndexEntry[],
	filter: AchievementSearchFilter,
	limit = Number.POSITIVE_INFINITY,
): AchievementIndexEntry[] {
	const query = normalizeAchievementSearchText(filter.query);
	if (query.length === 0 && filter.categoryId === null) return [];
	const starts: AchievementIndexEntry[] = [];
	const contains: AchievementIndexEntry[] = [];
	for (const entry of entries) {
		if (filter.categoryId !== null && entry.categoryId !== filter.categoryId) continue;
		const name = normalizeAchievementSearchText(entry.name);
		if (name.startsWith(query)) starts.push(entry);
		else if (name.includes(query)) contains.push(entry);
	}
	return [...starts, ...contains].slice(0, limit);
}

function parseDetail(raw: Record<string, unknown>): AchievementDetail | null {
	if (!isPositive(raw.id) || typeof raw.name !== 'string') return null;
	const tiers = Array.isArray(raw.tiers) ? (raw.tiers as unknown[]).flatMap((tier) =>
		isRecord(tier) && isPositive(tier.count) && nonNegative(tier.points) ? [{ count: tier.count, points: tier.points }] : []) : [];
	return {
		id: raw.id,
		name: raw.name.trim(),
		description: typeof raw.description === 'string' ? raw.description : '',
		requirement: typeof raw.requirement === 'string' ? raw.requirement : '',
		flags: Array.isArray(raw.flags) ? (raw.flags as unknown[]).filter((flag): flag is string => typeof flag === 'string') : [],
		tiers,
		bits: Array.isArray(raw.bits) ? (raw.bits as unknown[]).map(parseBit) : [],
		rewards: Array.isArray(raw.rewards) ? (raw.rewards as unknown[]).flatMap(parseReward) : [],
		pointCap: nonNegative(raw.point_cap) ? raw.point_cap : null,
		icon: typeof raw.icon === 'string' && raw.icon.length > 0 ? raw.icon : null,
	};
}

function parseBit(raw: unknown): AchievementBit {
	if (isRecord(raw)) {
		if (raw.type === 'Text' && typeof raw.text === 'string') return { kind: 'text', text: raw.text, refId: null };
		if (isPositive(raw.id)) {
			if (raw.type === 'Item') return { kind: 'item', text: null, refId: raw.id };
			if (raw.type === 'Minipet') return { kind: 'minipet', text: null, refId: raw.id };
			if (raw.type === 'Skin') return { kind: 'skin', text: null, refId: raw.id };
		}
	}
	return { kind: 'unknown', text: null, refId: null };
}

function parseReward(raw: unknown): AchievementReward[] {
	if (!isRecord(raw)) return [];
	if (raw.type === 'Coins' && isPositive(raw.count)) return [{ kind: 'coins', copper: raw.count }];
	if (raw.type === 'Item' && isPositive(raw.id) && isPositive(raw.count)) return [{ kind: 'item', itemId: raw.id, count: raw.count }];
	if (raw.type === 'Mastery' && isPositive(raw.id) && typeof raw.region === 'string') return [{ kind: 'mastery', masteryId: raw.id, region: raw.region }];
	if (raw.type === 'Title' && isPositive(raw.id)) return [{ kind: 'title', titleId: raw.id }];
	return [];
}

function safeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function isPositive(value: unknown): value is number { return safeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return safeInteger(value) && value >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
