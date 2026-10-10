import type { AccountAchievementEntry } from '../account/account-achievements';
import type { AchievementBit, AchievementDetail, AchievementReward } from './achievement-catalog-model';

/**
 * The tracked list of the «Logros» section as the view shows it, built from data only: the catalog
 * details (`achievement-catalog-service.ts`) and the last reading of the account
 * (`tracked-progress-service.ts`). Pure, so Obsidian and Hebra render the same thing.
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

export interface TrackedObjective {
	/** The bit index, the one the account lists in `bits` when the objective is done. */
	index: number;
	kind: AchievementBit['kind'];
	text: string | null;
	refId: number | null;
	/** `unknown` without a reading of the account. */
	state: 'done' | 'pending' | 'unknown';
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
	objectives: TrackedObjective[];
	rewards: TrackedReward[];
	/** Search on the English wiki by the English name; null without one. */
	wikiUrl: string | null;
}

/** What the view needs of one reading of the account. */
export interface TrackedReadingEntries {
	/** The ids that reading asked about: one tracked later is `unread`, not "not started". */
	trackedIds: readonly number[];
	entries: readonly AccountAchievementEntry[];
}

export interface TrackedAchievementInput {
	id: number;
	detail: AchievementDetail | null;
	englishName: string | null;
	retired: boolean;
	/** Null while the account has never been read. */
	reading: TrackedReadingEntries | null;
}

export function buildTrackedAchievementsView(input: {
	trackedIds: readonly number[];
	details: ReadonlyMap<number, AchievementDetail>;
	englishNames: ReadonlyMap<number, string>;
	retired: ReadonlySet<number>;
	reading: TrackedReadingEntries | null;
}): TrackedAchievementView[] {
	return input.trackedIds.map((id) => buildTrackedAchievementView({
		id,
		detail: input.details.get(id) ?? null,
		englishName: input.englishNames.get(id) ?? null,
		retired: input.retired.has(id),
		reading: input.reading,
	}));
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
		objectives: (detail?.bits ?? []).map((bit, index) => ({
			index,
			kind: bit.kind,
			text: bit.text,
			refId: bit.refId,
			state: objectiveState(index, status, entry),
		})),
		rewards: detail === null ? [] : rewardsOf(detail),
		wikiUrl: input.englishName === null || input.englishName.trim().length === 0 ? null : achievementWikiSearchUrl(input.englishName.trim()),
	};
}

/** The English wiki's search: it lands on the page when the name is an exact title. */
export function achievementWikiSearchUrl(englishName: string): string {
	return `${WIKI_SEARCH_URL}${encodeURIComponent(englishName)}`;
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
	const tierMax = detail === null || detail.tiers.length === 0 ? null : Math.max(...detail.tiers.map((tier) => tier.count));
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

function objectiveState(index: number, status: TrackedAchievementStatus, entry: AccountAchievementEntry | null): TrackedObjective['state'] {
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
