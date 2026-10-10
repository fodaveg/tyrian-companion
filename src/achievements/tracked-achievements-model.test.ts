import { describe, expect, it } from 'vitest';

import type { AccountAchievementEntry } from '../account/account-achievements';
import { parseAchievementCategories, parseAchievementPage, type AchievementCategory, type AchievementDetail } from './achievement-catalog-model';
import { SAME_NAME_CATEGORIES, SAME_NAME_PAGE, SEASONS_OF_THE_DRAGONS_CATEGORIES, SEASONS_OF_THE_DRAGONS_ID, SEASONS_OF_THE_DRAGONS_PAGE } from './api-fixtures';
import {
	achievementWikiAnchorUrl,
	achievementWikiSearchUrl,
	buildTrackedAchievementView,
	buildTrackedAchievementsView,
	itemChatLink,
	skinChatLink,
	trackedReadingIds,
	wikiChatLinkSearchUrl,
	type TrackedAchievementInput,
	type TrackedElement,
} from './tracked-achievements-model';

function detail(overrides: Partial<AchievementDetail> = {}): AchievementDetail {
	return {
		id: 10, name: 'Maestría de Tyria', description: 'Descubre todo.', requirement: 'Completa los objetivos.',
		flags: [], tiers: [{ count: 1, points: 5 }, { count: 4, points: 10 }],
		bits: [
			{ kind: 'text', text: 'Primero', refId: null },
			{ kind: 'item', text: null, refId: 19_721 },
			{ kind: 'skin', text: null, refId: 6 },
			{ kind: 'unknown', text: null, refId: null },
		],
		rewards: [], pointCap: null, icon: null,
		...overrides,
	};
}

function entry(overrides: Partial<AccountAchievementEntry> = {}): AccountAchievementEntry {
	return { id: 10, done: false, current: null, max: null, repeated: null, bits: null, ...overrides };
}

function input(overrides: Partial<TrackedAchievementInput> = {}): TrackedAchievementInput {
	return { id: 10, detail: detail(), englishName: 'Tyria Mastery', retired: false, reading: { trackedIds: [10, 11], entries: [] }, ...overrides };
}

const elements = (view: { elements: { items: TrackedElement[] } | null }) => view.elements?.items ?? [];
const states = (view: { elements: { items: TrackedElement[] } | null }) => elements(view).map((element) => element.state);

describe('the state of a tracked achievement', () => {
	it('is unread while there is no reading of the account', () => {
		const view = buildTrackedAchievementView(input({ reading: null }));
		expect(view.status).toEqual({ kind: 'unread' });
		expect(states(view)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
	});

	it('is in progress n/m with the account numbers, and 0/m from the catalog when the account has no entry yet', () => {
		expect(buildTrackedAchievementView(input({ reading: { trackedIds: [10, 11], entries: [entry({ current: 2, max: 4, bits: [0, 2] })] } })).status)
			.toEqual({ kind: 'in_progress', current: 2, max: 4 });
		expect(buildTrackedAchievementView(input()).status).toEqual({ kind: 'in_progress', current: 0, max: 4 });
	});

	it('is unread when it was tracked after the last refresh, even if the reading exists', () => {
		const view = buildTrackedAchievementView(input({ reading: { trackedIds: [11], entries: [entry({ id: 11, done: true })] } }));
		expect(view.status).toEqual({ kind: 'unread' });
		expect(states(view).every((state) => state === 'unknown')).toBe(true);
	});

	it('is in progress 0/max when it was asked about and the account has no entry: the API omits the not started', () => {
		const view = buildTrackedAchievementView(input({ reading: { trackedIds: [10], entries: [entry({ id: 11, done: true })] } }));
		expect(view.status).toEqual({ kind: 'in_progress', current: 0, max: 4 });
		expect(states(view).every((state) => state === 'pending')).toBe(true);
	});

	it('counts the done bits as the progress of an entry with bits and no current, also when the catalog has tiers', () => {
		const view = buildTrackedAchievementView(input({ reading: { trackedIds: [10], entries: [entry({ bits: [0, 2, 3] })] } }));
		expect(view.status).toEqual({ kind: 'in_progress', current: 3, max: 4 });
		const repeatable = detail({ flags: ['Repeatable'] });
		expect(buildTrackedAchievementView(input({ detail: repeatable, reading: { trackedIds: [10], entries: [entry({ repeated: 2, bits: [1] })] } })).status)
			.toEqual({ kind: 'repeatable', timesDone: 2, current: 1, max: 4 });
	});

	it('is completed when the account says done', () => {
		expect(buildTrackedAchievementView(input({ reading: { trackedIds: [10, 11], entries: [entry({ done: true, current: 4, max: 4 })] } })).status)
			.toEqual({ kind: 'completed' });
	});

	it('has no objectives when neither the account nor the catalog give anything to count', () => {
		const view = buildTrackedAchievementView(input({ detail: detail({ tiers: [], bits: [] }) }));
		expect(view.status).toEqual({ kind: 'no_objectives' });
		expect(view.elements).toBeNull();
	});

	it('counts the bits when there is no other number to show', () => {
		const view = buildTrackedAchievementView(input({ detail: detail({ tiers: [] }), reading: { trackedIds: [10, 11], entries: [entry({ bits: [1, 3] })] } }));
		expect(view.status).toEqual({ kind: 'in_progress', current: 2, max: 4 });
	});

	it('is repeatable: done N times plus the progress of the current round', () => {
		const repeatable = detail({ flags: ['Repeatable'], tiers: [{ count: 100, points: 1 }], bits: [], pointCap: 10 });
		expect(buildTrackedAchievementView(input({ detail: repeatable, reading: { trackedIds: [10, 11], entries: [entry({ done: true, repeated: 3, current: 40, max: 100 })] } })).status)
			.toEqual({ kind: 'repeatable', timesDone: 3, current: 40, max: 100 });
		expect(buildTrackedAchievementView(input({ detail: repeatable })).status)
			.toEqual({ kind: 'repeatable', timesDone: 0, current: 0, max: 100 });
	});

	it('is retired when the API no longer serves it, whatever the account says', () => {
		const view = buildTrackedAchievementView(input({ detail: null, retired: true, reading: { trackedIds: [10, 11], entries: [entry({ done: true })] } }));
		expect(view.status).toEqual({ kind: 'retired' });
		expect(view.name).toBeNull();
		expect(view.elements).toBeNull();
	});
});

describe('the elements of an achievement with bits', () => {
	it('marks done the indices the account lists and pending the rest, pending first, each bit keeping its index', () => {
		const view = buildTrackedAchievementView(input({ reading: { trackedIds: [10, 11], entries: [entry({ current: 2, max: 4, bits: [0, 3] })] } }));
		expect(view.elements).toEqual({
			source: 'bits', done: 2, total: 4,
			items: [
				{ kind: 'item', index: 1, refId: 19_721, text: null, state: 'pending', progress: null, icon: null, wikiUrl: 'https://wiki.guildwars2.com/index.php?search=%5B%26AgEJTQAA%5D' },
				{ kind: 'skin', index: 2, refId: 6, text: null, state: 'pending', progress: null, icon: null, wikiUrl: 'https://wiki.guildwars2.com/index.php?search=%5B%26CgYAAAA%3D%5D' },
				{ kind: 'text', index: 0, refId: null, text: 'Primero', state: 'done', progress: null, icon: null, wikiUrl: null },
				{ kind: 'unknown', index: 3, refId: null, text: null, state: 'done', progress: null, icon: null, wikiUrl: null },
			],
		});
	});

	it('links an item or a skin by chat link, and leaves a minipet to the view (its item arrives with its name)', () => {
		const view = buildTrackedAchievementView(input({ detail: detail({ bits: [{ kind: 'minipet', text: null, refId: 88 }, { kind: 'item', text: null, refId: 110_148 }] }) }));
		expect(elements(view).map((element) => element.wikiUrl)).toEqual([null, wikiChatLinkSearchUrl('[&AgFErgEA]')]);
	});

	it('marks all done for a completed achievement whose entry carries no bits', () => {
		const view = buildTrackedAchievementView(input({ reading: { trackedIds: [10, 11], entries: [entry({ done: true })] } }));
		expect(states(view).every((state) => state === 'done')).toBe(true);
		expect(view.elements).toMatchObject({ done: 4, total: 4 });
	});

	it('ignores an index the catalog does not have', () => {
		const view = buildTrackedAchievementView(input({ reading: { trackedIds: [10, 11], entries: [entry({ bits: [9] })] } }));
		expect(states(view)).toEqual(['pending', 'pending', 'pending', 'pending']);
		expect(view.elements).toMatchObject({ done: 0, total: 4 });
	});
});

/** 9417 «Leyspring Hollows Mastery» as the API gives it (10 oct 2026): `CategoryDisplay`, no bits, 36 of the category's achievements. */
const META_ID = 9417;
function meta(overrides: Partial<AchievementDetail> = {}): AchievementDetail {
	return detail({
		id: META_ID, name: 'Dominio de las Hondonadas', flags: ['RepairOnLogin', 'CategoryDisplay', 'MoveToTop', 'Permanent'],
		// The real tiers go to 36 of the 47 members of its category; the fixture lists 5, so it asks for 5 (`plausibleCategoryMembers`).
		tiers: [{ count: 1, points: 1 }, { count: 3, points: 2 }, { count: 5, points: 5 }], bits: [],
		rewards: [{ kind: 'item', itemId: 110_148, count: 1 }, { kind: 'mastery', masteryId: 956, region: 'Magic' }], ...overrides,
	});
}
const MEMBERS = [9351, 9410, 9417, 9460, 9468, 9470];
const CATEGORIES: AchievementCategory[] = [
	{ id: 1, name: 'Otra', order: 1, icon: null, achievementIds: [1, 2] },
	{ id: 486, name: 'Leyspring Hollows', order: 4, icon: null, achievementIds: MEMBERS },
];
const MEMBER_DETAILS = new Map<number, AchievementDetail>([
	[META_ID, meta()],
	[9351, detail({ id: 9351, name: 'Logro 9351', tiers: [{ count: 13, points: 5 }], bits: [], icon: 'https://render.guildwars2.com/file/ABC/1.png' })],
	[9410, detail({ id: 9410, name: 'Diario', flags: ['Daily'], bits: [] })],
	[9460, detail({ id: 9460, name: 'Escondido', flags: ['Hidden', 'Permanent'], bits: [] })],
	[9468, detail({ id: 9468, name: 'Puzle', tiers: [{ count: 4, points: 10 }], bits: [] })],
]);
const ENGLISH = new Map<number, string>([[META_ID, 'Leyspring Hollows Mastery'], [9351, 'Achievement 9351'], [9468, 'Coleopteran Cavern Jumping Puzzle']]);

describe('the elements of a meta of its category (CategoryDisplay without bits)', () => {
	const views = (reading: TrackedAchievementInput['reading'], details = MEMBER_DETAILS) => buildTrackedAchievementsView({
		trackedIds: [META_ID], details, englishNames: ENGLISH, retired: new Set(), reading, categories: CATEGORIES,
	});

	it('lists the other achievements of the category: pending first, then done; the daily and the untouched hidden one are left out', () => {
		const [view] = views({
			trackedIds: [META_ID, ...MEMBERS],
			entries: [entry({ id: META_ID, current: 23, max: 36 }), entry({ id: 9351, current: 6, max: 13 }), entry({ id: 9468, done: true, current: 4, max: 4 })],
		});
		expect(view!.status).toEqual({ kind: 'in_progress', current: 23, max: 36 });
		expect(view!.elements).toEqual({
			source: 'category', done: 1, total: 3,
			items: [
				{ kind: 'achievement', index: null, refId: 9351, text: 'Logro 9351', state: 'pending', progress: { current: 6, max: 13 }, icon: 'https://render.guildwars2.com/file/ABC/1.png', wikiUrl: 'https://wiki.guildwars2.com/index.php?search=Achievement%209351#achievement9351' },
				{ kind: 'achievement', index: null, refId: 9470, text: null, state: 'pending', progress: null, icon: null, wikiUrl: null },
				{ kind: 'achievement', index: null, refId: 9468, text: 'Puzle', state: 'done', progress: null, icon: null, wikiUrl: 'https://wiki.guildwars2.com/index.php?search=Coleopteran%20Cavern%20Jumping%20Puzzle#achievement9468' },
			],
		});
	});

	it('shows a hidden achievement once the account has an entry for it', () => {
		const [view] = views({ trackedIds: [META_ID, ...MEMBERS], entries: [entry({ id: 9460, done: true })] });
		expect(elements(view!).map((element) => [element.refId, element.state])).toEqual([[9351, 'pending'], [9468, 'pending'], [9470, 'pending'], [9460, 'done']]);
	});

	it('knows nothing of the elements until a reading asks about them: a reading of the meta alone leaves them unknown', () => {
		const [view] = views({ trackedIds: [META_ID], entries: [entry({ id: META_ID, current: 23, max: 36 })] });
		expect(states(view!)).toEqual(['unknown', 'unknown', 'unknown']);
		expect(view!.elements).toMatchObject({ done: 0, total: 3 });
		expect(states(views(null)[0]!)).toEqual(['unknown', 'unknown', 'unknown']);
	});

	it('lists by id the members whose detail is not loaded, so a failed catalog read never empties the list', () => {
		const [view] = views(null, new Map([[META_ID, meta()]]));
		expect(elements(view!).map((element) => [element.refId, element.text, element.wikiUrl !== null])).toEqual([
			[9351, null, true], [9410, null, false], [9460, null, false], [9468, null, true], [9470, null, false],
		]);
	});

	it('is not a meta with bits of its own, without the flag, or when no category lists it', () => {
		const withBits = buildTrackedAchievementsView({ trackedIds: [META_ID], details: new Map([[META_ID, meta({ bits: detail().bits })]]), englishNames: ENGLISH, retired: new Set(), reading: null, categories: CATEGORIES });
		expect(withBits[0]!.elements?.source).toBe('bits');
		const noFlag = buildTrackedAchievementsView({ trackedIds: [META_ID], details: new Map([[META_ID, meta({ flags: ['Permanent'] })]]), englishNames: ENGLISH, retired: new Set(), reading: null, categories: CATEGORIES });
		expect(noFlag[0]!.elements).toBeNull();
		const unlisted = buildTrackedAchievementsView({ trackedIds: [META_ID], details: MEMBER_DETAILS, englishNames: ENGLISH, retired: new Set(), reading: null, categories: [CATEGORIES[0]!] });
		expect(unlisted[0]!.elements).toBeNull();
		const noCategories = buildTrackedAchievementsView({ trackedIds: [META_ID], details: MEMBER_DETAILS, englishNames: ENGLISH, retired: new Set(), reading: null });
		expect(noCategories[0]!.elements).toBeNull();
	});
});

describe('trackedReadingIds', () => {
	it('asks about each tracked id and every member of a meta\'s category, the hidden and daily ones included, once each', () => {
		expect(trackedReadingIds({ trackedIds: [META_ID, 9468, 10], details: MEMBER_DETAILS, retired: new Set(), categories: CATEGORIES }))
			.toEqual([META_ID, 9468, 10, 9351, 9410, 9460, 9470]);
	});

	it('asks nothing more for a retired meta, one without detail or one with bits', () => {
		expect(trackedReadingIds({ trackedIds: [META_ID], details: MEMBER_DETAILS, retired: new Set([META_ID]), categories: CATEGORIES })).toEqual([META_ID]);
		expect(trackedReadingIds({ trackedIds: [META_ID], details: new Map(), retired: new Set(), categories: CATEGORIES })).toEqual([META_ID]);
		expect(trackedReadingIds({ trackedIds: [10], details: new Map([[10, detail()]]), retired: new Set(), categories: [{ id: 2, name: 'X', order: 1, icon: null, achievementIds: [10, 11] }] })).toEqual([10]);
	});
});

describe('a meta whose category cannot be what its bar counts («Temporadas de los dragones», 5790)', () => {
	// The API as it answered on 10 oct 2026: the bar asks for 24 «Return» metas, its category lists five other achievements.
	const details = new Map(parseAchievementPage(SEASONS_OF_THE_DRAGONS_PAGE)!.details.map((each) => [each.id, each]));
	const categories = parseAchievementCategories(SEASONS_OF_THE_DRAGONS_CATEGORIES)!;
	const read = { trackedIds: [SEASONS_OF_THE_DRAGONS_ID], entries: [entry({ id: SEASONS_OF_THE_DRAGONS_ID, current: 3, max: 24 })] };

	it('keeps the bar at 24 and lists no elements instead of the five of a category that is not its own', () => {
		const [view] = buildTrackedAchievementsView({ trackedIds: [SEASONS_OF_THE_DRAGONS_ID], details, englishNames: new Map(), retired: new Set(), reading: read, categories });
		expect(view!.status).toEqual({ kind: 'in_progress', current: 3, max: 24 });
		expect(view!.elements).toEqual({ source: 'category', items: [], done: 0, total: 0 });
	});

	it('does not ask the account about the members of that category either', () => {
		expect(trackedReadingIds({ trackedIds: [SEASONS_OF_THE_DRAGONS_ID], details, retired: new Set(), categories })).toEqual([SEASONS_OF_THE_DRAGONS_ID]);
	});

	it('still lists the category when it can hold what the bar counts', () => {
		const small = new Map(details);
		small.set(SEASONS_OF_THE_DRAGONS_ID, { ...details.get(SEASONS_OF_THE_DRAGONS_ID)!, tiers: [{ count: 5, points: 25 }] });
		const [view] = buildTrackedAchievementsView({ trackedIds: [SEASONS_OF_THE_DRAGONS_ID], details: small, englishNames: new Map(), retired: new Set(), reading: read, categories });
		expect(view!.elements).toMatchObject({ source: 'category', total: 5 });
	});
});

describe('achievements that share a name are never merged', () => {
	const details = new Map(parseAchievementPage(SAME_NAME_PAGE)!.details.map((each) => [each.id, each]));
	const categories = parseAchievementCategories(SAME_NAME_CATEGORIES)!;

	it('tracks «Portero de bar» (8903, 9307) and «Muerte al Dominio» (5391, 5403) as four separate achievements, each with its own detail', () => {
		const views = buildTrackedAchievementsView({ trackedIds: [8903, 9307, 5391, 5403], details, englishNames: new Map(), retired: new Set(), reading: null, categories });
		expect(views.map((view) => [view.id, view.name])).toEqual([[8903, 'Portero de bar'], [9307, 'Portero de bar'], [5391, 'Muerte al Dominio'], [5403, 'Muerte al Dominio']]);
	});

	it('lists both as elements of a category meta', () => {
		const metaDetail = meta({ tiers: [{ count: 2, points: 5 }] });
		const [view] = buildTrackedAchievementsView({
			trackedIds: [META_ID], details: new Map([...details, [META_ID, metaDetail]]), englishNames: new Map(), retired: new Set(), reading: null,
			categories: [{ id: 1, name: 'Meta', order: 1, icon: null, achievementIds: [META_ID, 5391, 5403] }],
		});
		expect(elements(view!).map((element) => [element.refId, element.text])).toEqual([[5391, 'Muerte al Dominio'], [5403, 'Muerte al Dominio']]);
	});
});

describe('the rewards', () => {
	it('lists coins, item, mastery, title and the achievement points of the tiers', () => {
		const view = buildTrackedAchievementView(input({
			detail: detail({
				pointCap: 20,
				rewards: [
					{ kind: 'coins', copper: 50_000 }, { kind: 'item', itemId: 19_721, count: 2 },
					{ kind: 'mastery', masteryId: 14, region: 'Tyria' }, { kind: 'title', titleId: 299 },
				],
			}),
		}));
		expect(view.rewards).toEqual([
			{ kind: 'coins', copper: 50_000 },
			{ kind: 'item', itemId: 19_721, count: 2 },
			{ kind: 'mastery', masteryId: 14, region: 'Tyria' },
			{ kind: 'title', titleId: 299 },
			{ kind: 'achievement_points', points: 15, pointCap: 20 },
		]);
	});

	it('omits the achievement points when the tiers give none', () => {
		const view = buildTrackedAchievementView(input({ detail: detail({ tiers: [{ count: 1, points: 0 }] }) }));
		expect(view.rewards).toEqual([]);
	});
});

describe('the wiki links', () => {
	it('searches the English wiki with the English name', () => {
		expect(achievementWikiSearchUrl('Tyria Mastery: Part 1')).toBe('https://wiki.guildwars2.com/index.php?search=Tyria%20Mastery%3A%20Part%201');
		expect(buildTrackedAchievementView(input()).wikiUrl).toBe('https://wiki.guildwars2.com/index.php?search=Tyria%20Mastery');
	});

	it('gives no link without an English name', () => {
		expect(buildTrackedAchievementView(input({ englishName: null })).wikiUrl).toBeNull();
		expect(buildTrackedAchievementView(input({ englishName: '   ' })).wikiUrl).toBeNull();
	});

	it('anchors an element of a category to its row, as the Leyspring note does', () => {
		expect(achievementWikiAnchorUrl('Coleopteran Cavern Jumping Puzzle', 9468))
			.toBe('https://wiki.guildwars2.com/index.php?search=Coleopteran%20Cavern%20Jumping%20Puzzle#achievement9468');
	});

	it('writes the chat links the wiki search resolves: the API\'s own for item 110148, and the skin type for a skin', () => {
		expect(itemChatLink(110_148)).toBe('[&AgFErgEA]');
		expect(itemChatLink(46_762)).toBe('[&AgGqtgAA]');
		expect(skinChatLink(5)).toBe('[&CgUAAAA=]');
		expect(skinChatLink(3_709)).toBe('[&Cn0OAAA=]');
		expect(wikiChatLinkSearchUrl('[&AgFErgEA]')).toBe('https://wiki.guildwars2.com/index.php?search=%5B%26AgFErgEA%5D');
	});
});

describe('buildTrackedAchievementsView', () => {
	it('keeps the order of the tracked list and finds each entry of the reading by id', () => {
		const views = buildTrackedAchievementsView({
			trackedIds: [11, 10, 12],
			details: new Map([[10, detail()], [11, detail({ id: 11, name: 'Otro' })]]),
			englishNames: new Map([[10, 'Tyria Mastery']]),
			retired: new Set([12]),
			reading: { trackedIds: [10, 11], entries: [entry({ id: 11, done: true })] },
		});
		expect(views.map((view) => [view.id, view.status.kind])).toEqual([[11, 'completed'], [10, 'in_progress'], [12, 'retired']]);
		expect(views[0]!.wikiUrl).toBeNull();
	});
});
