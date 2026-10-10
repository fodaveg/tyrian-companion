import type { AccountAchievementEntry } from '../account/account-achievements';
import { knownSetMembersOf } from './known-achievement-sets';
import {
	categoryMembersOf,
	isCategoryMetaAchievement,
	isPartialCategory,
	isPeriodicAchievement,
	plausibleCategoryMembers,
	type AchievementBit,
	type AchievementCategory,
	type AchievementDetail,
	type AchievementReward,
} from './achievement-catalog-model';

/**
 * The tracked list of the «Logros» section as the view shows it, built from data only: the catalog
 * details (`achievement-catalog-service.ts`) and the last reading of the account
 * (`tracked-progress-service.ts`). Pure, so Obsidian and Hebra render the same thing.
 *
 * Inside each tracked achievement, its ELEMENTS (L4, after the Leyspring note): a checklist of what
 * the account has done, pending first and done after, with a «done of N» count. For an achievement
 * with `bits` each bit is an element; for a meta of its category (`isCategoryMetaAchievement`) the
 * elements are the other achievements of the category.
 */

const WIKI_SEARCH_URL = 'https://wiki.guildwars2.com/index.php?search=';

export type TrackedAchievementStatus =
	/** No reading of the account yet: the catalog part is shown, the progress is not known. */
	| { kind: 'unread' }
	/** The API no longer serves the achievement (left out of a 206 or a 404). */
	| { kind: 'retired' }
	| { kind: 'completed' }
	| { kind: 'in_progress'; current: number; max: number }
	/** Not done and nothing to count it by: no number from the account, no tiers, no objectives. */
	| { kind: 'no_objectives' }
	/** «Hecho N veces» plus the progress of the current round. */
	| { kind: 'repeatable'; timesDone: number; current: number; max: number | null };

export type TrackedElementState = 'done' | 'pending' | 'unknown';

/** One element of a tracked achievement: a bit of its own, or an achievement of its category. */
export interface TrackedElement {
	/** `achievement` for an element of the category; a bit's own kind otherwise. */
	kind: 'achievement' | AchievementBit['kind'];
	/** The bit index, the one the account lists in `bits` when the objective is done; null for an achievement of the category. */
	index: number | null;
	/** The achievement, item, minipet or skin id; null for a text or unknown bit. */
	refId: number | null;
	/** The text of a text bit, or the catalog name of an achievement element (null: shown by id). Items, minipets and skins are named by the view. */
	text: string | null;
	/** `unknown` without a reading of the account that asked about it. */
	state: TrackedElementState;
	/** `current/max` of an achievement element half done; null otherwise. */
	progress: { current: number; max: number } | null;
	/** The achievement's icon as the API gives it (most have none); items, minipets and skins get theirs from the view's names. */
	icon: string | null;
	/**
	 * The wiki: the English search of an achievement's name with `#achievement<id>` (the anchor of
	 * its row on a category page), the chat-link search of an item or a skin. Null for a text bit,
	 * an achievement without an English name, and a minipet (the view links it by its item).
	 */
	wikiUrl: string | null;
}

export interface TrackedElements {
	source: 'bits' | 'category';
	/** Pending and unknown first, then done; each half in the catalog's order. */
	items: TrackedElement[];
	done: number;
	total: number;
	/** Only set (true) when the list is short of what the bar counts and the API does not give the rest. */
	partial?: true;
}

export type TrackedReward =
	| AchievementReward
	/** Achievement points (PL) of all the tiers; `pointCap` caps a repeatable one. */
	| { kind: 'achievement_points'; points: number; pointCap: number | null };

export interface TrackedAchievementView {
	id: number;
	/** Null when the catalog has no detail for it (retired, or never loaded). */
	name: string | null;
	description: string;
	requirement: string;
	status: TrackedAchievementStatus;
	/** Null when the achievement has neither bits nor a category to count: nothing to list. */
	elements: TrackedElements | null;
	rewards: TrackedReward[];
	/** Search on the English wiki by the English name; null without one. */
	wikiUrl: string | null;
}

/** What the view needs of one reading of the account. */
export interface TrackedReadingEntries {
	/** The ids that reading asked about (tracked ones and their elements): one tracked later is `unread`, not "not started". */
	trackedIds: readonly number[];
	entries: readonly AccountAchievementEntry[];
}

/** The category of a meta achievement, with what the catalog knows of its members. */
export interface TrackedCategoryInput {
	/** The other achievements of the category, in its order. */
	members: readonly number[];
	details: ReadonlyMap<number, AchievementDetail>;
	englishNames: ReadonlyMap<number, string>;
}

export interface TrackedAchievementInput {
	id: number;
	detail: AchievementDetail | null;
	englishName: string | null;
	retired: boolean;
	/** Null while the account has never been read. */
	reading: TrackedReadingEntries | null;
	/** For a meta of its category: the category; null (or absent) otherwise. */
	category?: TrackedCategoryInput | null;
}

export function buildTrackedAchievementsView(input: {
	trackedIds: readonly number[];
	/** Details of the tracked ids and of the members of their categories. */
	details: ReadonlyMap<number, AchievementDetail>;
	englishNames: ReadonlyMap<number, string>;
	retired: ReadonlySet<number>;
	reading: TrackedReadingEntries | null;
	/** The public categories, to find the members of a meta's category; none lists nothing. */
	categories?: readonly AchievementCategory[];
}): TrackedAchievementView[] {
	return input.trackedIds.map((id) => {
		const detail = input.details.get(id) ?? null;
		const members = detail !== null && !input.retired.has(id) && isCategoryMetaAchievement(detail)
			? metaMembersOf(detail, input.categories ?? []) : null;
		return buildTrackedAchievementView({
			id,
			detail,
			englishName: input.englishNames.get(id) ?? null,
			retired: input.retired.has(id),
			reading: input.reading,
			category: members === null ? null : { members, details: input.details, englishNames: input.englishNames },
		});
	});
}

export function buildTrackedAchievementView(input: TrackedAchievementInput): TrackedAchievementView {
	const detail = input.retired ? null : input.detail;
	const entry = input.reading?.entries.find((candidate) => candidate.id === input.id) ?? null;
	const status = statusOf(input, detail, entry);
	return {
		id: input.id,
		name: detail?.name ?? null,
		description: detail?.description ?? '',
		requirement: detail?.requirement ?? '',
		status,
		elements: elementsOf(input, detail, status, entry),
		rewards: detail === null ? [] : rewardsOf(detail),
		wikiUrl: input.englishName === null || input.englishName.trim().length === 0 ? null : achievementWikiSearchUrl(input.englishName.trim()),
	};
}

/** The English wiki's search: it lands on the page when the name is an exact title. */
export function achievementWikiSearchUrl(englishName: string): string {
	return `${WIKI_SEARCH_URL}${encodeURIComponent(englishName)}`;
}

/**
 * The search by English name with the anchor of the achievement's row (`#achievement<id>`, as the
 * Leyspring note links them): when the search lands on a category page the row is scrolled to;
 * on an achievement's own page the anchor is harmless.
 */
export function achievementWikiAnchorUrl(englishName: string, id: number): string {
	return `${achievementWikiSearchUrl(englishName)}#achievement${String(id)}`;
}

/**
 * The wiki resolves a chat link typed in its search (`MediaWiki:ChatLinkSearch.js`, loaded on
 * `Special:Search`) to the page of what it names, so an item or a skin can be linked by id alone,
 * in any interface language.
 */
export function wikiChatLinkSearchUrl(chatLink: string): string {
	return `${WIKI_SEARCH_URL}${encodeURIComponent(chatLink)}`;
}

/** `[&AgFErgEA]` for item 110148: type 0x02, quantity 1, the id in three bytes little-endian, no upgrades. */
export function itemChatLink(itemId: number): string {
	return chatLink([0x02, 0x01, ...littleEndian(itemId, 3), 0x00]);
}

/** `[&CgUAAAA=]` for skin 5: type 0x0A and the id in three bytes little-endian. */
export function skinChatLink(skinId: number): string {
	return chatLink([0x0a, ...littleEndian(skinId, 3), 0x00]);
}

function chatLink(bytes: readonly number[]): string {
	return `[&${btoa(String.fromCharCode(...bytes))}]`;
}

function littleEndian(value: number, width: number): number[] {
	return Array.from({ length: width }, (_, index) => (value >>> (8 * index)) & 0xff);
}

function statusOf(
	input: TrackedAchievementInput,
	detail: AchievementDetail | null,
	entry: AccountAchievementEntry | null,
): TrackedAchievementStatus {
	if (input.retired) return { kind: 'retired' };
	// No reading, or one made before this id was tracked: nothing is known of it yet. An id the
	// reading asked about and got no entry for is a different case: the API omits the not started.
	if (input.reading === null || !input.reading.trackedIds.includes(input.id)) return { kind: 'unread' };
	const tierMax = tierMaxOf(detail);
	const bits = detail?.bits.length ?? 0;
	const current = entry?.current ?? doneBitCount(entry, bits);
	if (detail?.flags.includes('Repeatable') === true) {
		return { kind: 'repeatable', timesDone: entry?.repeated ?? 0, current, max: entry?.max ?? tierMax };
	}
	if (entry?.done === true) return { kind: 'completed' };
	const max = entry?.max ?? tierMax;
	if (max !== null) return { kind: 'in_progress', current, max };
	if (bits > 0) return { kind: 'in_progress', current, max: bits };
	return { kind: 'no_objectives' };
}

function tierMaxOf(detail: AchievementDetail | null): number | null {
	return detail === null || detail.tiers.length === 0 ? null : Math.max(...detail.tiers.map((tier) => tier.count));
}

function elementsOf(
	input: TrackedAchievementInput,
	detail: AchievementDetail | null,
	status: TrackedAchievementStatus,
	entry: AccountAchievementEntry | null,
): TrackedElements | null {
	if (detail === null) return null;
	if (detail.bits.length > 0) return sortedElements('bits', detail.bits.map((bit, index) => bitElement(bit, index, status, entry)));
	const category = input.category ?? null;
	if (category === null) return null;
	// Looked up once for the whole category, not once per member (a category lists some 50).
	const reading = input.reading === null ? null : {
		asked: new Set(input.reading.trackedIds),
		entries: new Map(input.reading.entries.map((entry) => [entry.id, entry])),
	};
	const elements: TrackedElement[] = [];
	for (const id of category.members) {
		const element = categoryElement(id, category, reading);
		if (element !== null) elements.push(element);
	}
	const sorted = sortedElements('category', elements);
	return sorted.total > 0 && isPartialCategory(detail, category.members) ? { ...sorted, partial: true } : sorted;
}

/** One reading of the account, indexed for the members of a category. */
interface IndexedReading {
	asked: ReadonlySet<number>;
	entries: ReadonlyMap<number, AccountAchievementEntry>;
}

function sortedElements(source: TrackedElements['source'], elements: readonly TrackedElement[]): TrackedElements {
	const pending = elements.filter((element) => element.state !== 'done');
	const done = elements.filter((element) => element.state === 'done');
	return { source, items: [...pending, ...done], done: done.length, total: elements.length };
}

function bitElement(bit: AchievementBit, index: number, status: TrackedAchievementStatus, entry: AccountAchievementEntry | null): TrackedElement {
	return {
		kind: bit.kind,
		index,
		refId: bit.refId,
		text: bit.text,
		state: objectiveState(index, status, entry),
		progress: null,
		icon: null,
		wikiUrl: bit.refId === null ? null
			: bit.kind === 'item' ? wikiChatLinkSearchUrl(itemChatLink(bit.refId))
				: bit.kind === 'skin' ? wikiChatLinkSearchUrl(skinChatLink(bit.refId)) : null,
	};
}

/**
 * One achievement of the meta's category, or null when it is not an element: a periodic one
 * (daily, weekly, monthly), or a hidden one the account has not touched (the game lists it only
 * once found). An achievement whose detail is not loaded is listed by id, so a failed catalog
 * read never empties the list.
 */
function categoryElement(id: number, category: TrackedCategoryInput, reading: IndexedReading | null): TrackedElement | null {
	const detail = category.details.get(id) ?? null;
	const asked = reading !== null && reading.asked.has(id);
	const entry = asked ? reading.entries.get(id) ?? null : null;
	if (detail !== null && isPeriodicAchievement(detail)) return null;
	if (detail?.flags.includes('Hidden') === true && entry === null) return null;
	const done = entry?.done === true;
	const max = entry?.max ?? tierMaxOf(detail);
	const current = entry?.current ?? null;
	const englishName = category.englishNames.get(id)?.trim() ?? '';
	return {
		kind: 'achievement',
		index: null,
		refId: id,
		text: detail === null || detail.name.length === 0 ? null : detail.name,
		state: !asked ? 'unknown' : done ? 'done' : 'pending',
		progress: !done && current !== null && current > 0 && max !== null && max > 0 ? { current, max } : null,
		icon: detail?.icon ?? null,
		wikiUrl: englishName.length === 0 ? null : achievementWikiAnchorUrl(englishName, id),
	};
}

function objectiveState(index: number, status: TrackedAchievementStatus, entry: AccountAchievementEntry | null): TrackedElementState {
	if (status.kind === 'unread') return 'unknown';
	// A completed achievement often comes without `bits`: all its objectives are done.
	if (status.kind === 'completed') return 'done';
	return entry?.bits?.includes(index) === true ? 'done' : 'pending';
}

/**
 * The progress an entry without `current` shows: its done bits. Counted within the catalog's
 * `catalogBits` when the catalog lists them, so an index the catalog does not have adds nothing.
 */
function doneBitCount(entry: AccountAchievementEntry | null, catalogBits: number): number {
	const done = entry?.bits ?? [];
	return catalogBits > 0 ? done.filter((index) => index < catalogBits).length : done.length;
}

function rewardsOf(detail: AchievementDetail): TrackedReward[] {
	const rewards: TrackedReward[] = detail.rewards.map((reward) => ({ ...reward }));
	const points = detail.tiers.reduce((sum, tier) => sum + tier.points, 0);
	if (points > 0) rewards.push({ kind: 'achievement_points', points, pointCap: detail.pointCap });
	return rewards;
}

/**
 * The achievement ids a reading («Actualizar progreso») must ask about: each tracked one and, for
 * a meta of its category, every member of the category, the hidden ones included, so that a
 * hidden achievement the account has found appears as an element after the next reading.
 */
export function trackedReadingIds(input: {
	trackedIds: readonly number[];
	details: ReadonlyMap<number, AchievementDetail>;
	retired: ReadonlySet<number>;
	categories: readonly AchievementCategory[];
}): number[] {
	const ids = new Set<number>(input.trackedIds);
	for (const id of input.trackedIds) {
		const detail = input.details.get(id);
		if (detail === undefined || input.retired.has(id) || !isCategoryMetaAchievement(detail)) continue;
		for (const member of metaMembersOf(detail, input.categories) ?? []) ids.add(member);
	}
	return [...ids];
}

/**
 * The elements of a meta of its category: the wiki's known set when there is one (the API does not
 * list them), else the members of its category when that can be what the bar counts; a category
 * too small for it lists nothing («La API no lista los elementos de este logro»). Null: no category.
 */
function metaMembersOf(detail: AchievementDetail, categories: readonly AchievementCategory[]): number[] | null {
	const known = knownSetMembersOf(detail.id);
	if (known !== null) return known.filter((member) => member !== detail.id);
	const listed = categoryMembersOf(categories, detail.id);
	return listed === null ? null : plausibleCategoryMembers(detail, listed) ?? [];
}
