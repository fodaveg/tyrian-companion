import { describe, expect, it } from 'vitest';

import { SAME_NAME_CATEGORIES, SAME_NAME_PAGE } from './__fixtures__/api-fixtures';
import {
	ACHIEVEMENT_CATEGORIES_SCHEMA,
	categoryMembersOf,
	isCategoryMetaAchievement,
	isPeriodicAchievement,
	normalizeAchievementSearchText,
	parseAchievementCategories,
	parseAchievementGroups,
	parseAchievementIndexEntries,
	parseAchievementPage,
	planAchievementIndex,
	searchAchievementIndex,
	toAchievementIndexEntry,
	type AchievementIndexEntry,
} from './achievement-catalog-model';

const GROUPS = [
	{ id: '65B4B678-607E-4D97-B458-076C3E96A810', name: 'Heart of Thorns', description: 'Mordremoth.', order: 20, categories: [1, 2] },
	{ id: '', name: 'Sin id', order: 1, categories: [3] },
	'garbage',
	{ id: 'B42E2379-9599-46CA-9D4A-40A27E192BBE', name: 'Historia', order: 1, categories: [3, 'x', -1] },
];

/** `achievements/categories?ids=all&v=2022-03-23T19:00:00.000Z`: the achievements come as objects. */
const CATEGORIES_2022 = [
	{
		id: 1, name: 'Cazador', description: '', order: 30, icon: 'https://render.guildwars2.com/file/1.png',
		achievements: [
			{ id: 10 },
			{ id: 11, flags: ['SpecialEvent'], level: [1, 80] },
			{ id: 12, required_access: { product: 'EndOfDragons', condition: 'HasAccess' } },
			12, { id: 0 }, 'garbage',
		],
		tomorrow: [{ id: 99 }],
	},
	{ id: 2, name: 'Exploración', order: 10, achievements: [{ id: 11 }, { id: 13 }] },
	{ id: -4, name: 'Rota', order: 1, achievements: [] },
	{ id: 3, name: 'Sin lista', order: 1 },
];

const PAGE = [
	{
		id: 10, name: 'Maestría de Tyria', description: 'Descubre <c=@flavor>todo</c>.', requirement: 'Completa  objetivos.',
		locked_text: '', type: 'ItemSet', flags: ['CategoryDisplay', 7],
		tiers: [{ count: 1, points: 5 }, { count: 3, points: 10 }],
		bits: [{ type: 'Text', text: 'Primero' }, { type: 'Item', id: 19_721 }, { type: 'Skin', id: 6 }, { type: 'Minipet', id: 3 }, { type: 'Nuevo' }, 'garbage'],
		rewards: [
			{ type: 'Coins', count: 50_000 }, { type: 'Item', id: 19_721, count: 2 }, { type: 'Mastery', id: 14, region: 'Tyria' },
			{ type: 'Title', id: 299 }, { type: 'Desconocida', id: 1 }, { type: 'Item', id: -1, count: 1 },
		],
	},
	{ id: 11, name: 'Cazador de centauros', requirement: 'Mata  centauros.', flags: ['Repeatable'], tiers: [{ count: 100, points: 1 }], point_cap: 10 },
	{ id: 12, name: 42 },
	'garbage',
];

describe('parseAchievementGroups', () => {
	it('reads each group with its category ids and skips the entries of an unknown shape', () => {
		expect(parseAchievementGroups(GROUPS)).toEqual([
			{ id: '65B4B678-607E-4D97-B458-076C3E96A810', name: 'Heart of Thorns', order: 20, categoryIds: [1, 2] },
			{ id: 'B42E2379-9599-46CA-9D4A-40A27E192BBE', name: 'Historia', order: 1, categoryIds: [3] },
		]);
	});

	it('refuses a body that is not a list', () => {
		expect(parseAchievementGroups({ text: 'no' })).toBeNull();
		expect(parseAchievementGroups(null)).toBeNull();
	});
});

describe('parseAchievementCategories (schema 2022-03-23)', () => {
	it('pins the schema that answers the achievements of a category as objects', () => {
		expect(ACHIEVEMENT_CATEGORIES_SCHEMA).toBe('2022-03-23T19:00:00.000Z');
	});

	it('reads the ids of the 2022 objects and ignores tomorrow, bare numbers and broken ids', () => {
		expect(parseAchievementCategories(CATEGORIES_2022)).toEqual([
			{ id: 1, name: 'Cazador', order: 30, icon: 'https://render.guildwars2.com/file/1.png', achievementIds: [10, 11, 12] },
			{ id: 2, name: 'Exploración', order: 10, icon: null, achievementIds: [11, 13] },
			{ id: 3, name: 'Sin lista', order: 1, icon: null, achievementIds: [] },
		]);
	});

	it('refuses a body that is not a list', () => {
		expect(parseAchievementCategories({ achievements: [] })).toBeNull();
	});
});

describe('parseAchievementPage', () => {
	it('reads tiers, flags, rewards and every bit, keeping the slot of a bit it does not know', () => {
		const page = parseAchievementPage(PAGE);
		expect(page).not.toBeNull();
		const first = page!.details[0]!;
		expect(first).toEqual({
			id: 10, name: 'Maestría de Tyria', description: 'Descubre <c=@flavor>todo</c>.', requirement: 'Completa  objetivos.',
			flags: ['CategoryDisplay'],
			tiers: [{ count: 1, points: 5 }, { count: 3, points: 10 }],
			bits: [
				{ kind: 'text', text: 'Primero', refId: null },
				{ kind: 'item', text: null, refId: 19_721 },
				{ kind: 'skin', text: null, refId: 6 },
				{ kind: 'minipet', text: null, refId: 3 },
				{ kind: 'unknown', text: null, refId: null },
				{ kind: 'unknown', text: null, refId: null },
			],
			rewards: [
				{ kind: 'coins', copper: 50_000 },
				{ kind: 'item', itemId: 19_721, count: 2 },
				{ kind: 'mastery', masteryId: 14, region: 'Tyria' },
				{ kind: 'title', titleId: 299 },
			],
			pointCap: null,
			icon: null,
		});
		expect(page!.details[1]).toMatchObject({ id: 11, flags: ['Repeatable'], pointCap: 10, bits: [], rewards: [], description: '' });
	});

	it('counts as present an id whose entry it could not read, so it is never taken for retired', () => {
		const page = parseAchievementPage(PAGE)!;
		expect(page.details.map((detail) => detail.id)).toEqual([10, 11]);
		expect([...page.presentIds].sort((left, right) => left - right)).toEqual([10, 11, 12]);
	});

	it('reads the body of a 206 the same as a 200: only the ids that came are present', () => {
		const page = parseAchievementPage([PAGE[1]])!;
		expect(page.details.map((detail) => detail.id)).toEqual([11]);
		expect([...page.presentIds]).toEqual([11]);
	});

	it('refuses a body that is not a list', () => {
		expect(parseAchievementPage({ text: 'all ids provided are invalid' })).toBeNull();
	});
});

describe('the icon and the meta of a category', () => {
	it('keeps the icon when the API gives a non-empty string, null otherwise', () => {
		const page = parseAchievementPage([
			{ id: 1, name: 'Con icono', icon: 'https://render.guildwars2.com/file/ABC/1.png' },
			{ id: 2, name: 'Sin icono', icon: null }, { id: 3, name: 'Vacío', icon: '' }, { id: 4, name: 'Raro', icon: 7 },
		]);
		expect(page!.details.map((detail) => detail.icon)).toEqual(['https://render.guildwars2.com/file/ABC/1.png', null, null, null]);
	});

	it('takes for a meta of its category what carries CategoryDisplay and no bits, as 9417 does', () => {
		const page = parseAchievementPage([
			{ id: 9417, name: 'Leyspring Hollows Mastery', flags: ['RepairOnLogin', 'CategoryDisplay', 'MoveToTop', 'Permanent'], bits: null, tiers: [{ count: 36, points: 5 }] },
			{ id: 9468, name: 'Puzle', flags: ['Permanent'], bits: [{ type: 'Text', text: 'Uno' }] },
			{ id: 1, name: 'Con bits y la marca', flags: ['CategoryDisplay'], bits: [{ type: 'Text', text: 'Uno' }] },
			{ id: 9410, name: 'Diario', flags: ['Daily'], bits: [] },
		]);
		expect(page!.details.map(isCategoryMetaAchievement)).toEqual([true, false, false, false]);
		expect(page!.details.map(isPeriodicAchievement)).toEqual([false, false, false, true]);
	});

	it('lists the members of the first category that lists an id, in its order and without the id itself', () => {
		const categories = parseAchievementCategories([
			{ id: 1, name: 'Otra', order: 1, achievements: [{ id: 5 }, { id: 9417 }] },
			{ id: 486, name: 'Leyspring Hollows', order: 4, achievements: [{ id: 9351 }, { id: 9417 }, { id: 9468 }] },
		])!;
		expect(categoryMembersOf(categories, 9417)).toEqual([5]);
		expect(categoryMembersOf(categories, 9468)).toEqual([9351, 9417]);
		expect(categoryMembersOf(categories, 99)).toBeNull();
		expect(categoryMembersOf([], 9417)).toBeNull();
	});
});

describe('the light index', () => {
	it('keeps only id, name, category, flags and the threshold of the last tier', () => {
		const [detail] = parseAchievementPage(PAGE)!.details;
		expect(toAchievementIndexEntry(detail!, 1)).toEqual({ id: 10, name: 'Maestría de Tyria', categoryId: 1, flags: ['CategoryDisplay'], tierMax: 3 });
		expect(toAchievementIndexEntry({ ...detail!, tiers: [] }, null).tierMax).toBeNull();
	});

	it('validates a stored page and refuses one with a broken entry', () => {
		const entries: AchievementIndexEntry[] = [{ id: 10, name: 'A', categoryId: 1, flags: [], tierMax: 3 }];
		expect(parseAchievementIndexEntries(entries)).toEqual(entries);
		expect(parseAchievementIndexEntries([{ ...entries[0], id: 'diez' }])).toBeNull();
		expect(parseAchievementIndexEntries('nope')).toBeNull();
	});

	it('plans the ids once each, in category order, with the first category that lists them', () => {
		const plan = planAchievementIndex(parseAchievementCategories(CATEGORIES_2022)!);
		expect(plan.ids).toEqual([10, 11, 12, 13]);
		expect(plan.categoryOf.get(11)).toBe(1);
		expect(plan.categoryOf.get(13)).toBe(2);
	});
});

describe('searchAchievementIndex', () => {
	const INDEX: AchievementIndexEntry[] = [
		{ id: 1, name: 'Explorador de Tyria Central', categoryId: 2, flags: [], tierMax: 1 },
		{ id: 2, name: 'Maestría de Tyria', categoryId: 1, flags: [], tierMax: 3 },
		{ id: 3, name: 'Cazador de centauros', categoryId: 1, flags: ['Repeatable'], tierMax: 100 },
		{ id: 4, name: 'Tyria al completo', categoryId: 1, flags: [], tierMax: 1 },
		{ id: 5, name: 'Pingüino ártico', categoryId: 3, flags: [], tierMax: 1 },
	];

	it('normalizes with NFD, without accents, in lower case', () => {
		expect(normalizeAchievementSearchText('  MAESTRÍA   Pingüino ')).toBe('maestria pinguino');
	});

	it('finds the name that contains the text, with or without accents on either side', () => {
		expect(searchAchievementIndex(INDEX, { query: 'maestria', categoryId: null }).map((entry) => entry.id)).toEqual([2]);
		expect(searchAchievementIndex(INDEX, { query: 'MAESTRÍA', categoryId: null }).map((entry) => entry.id)).toEqual([2]);
		expect(searchAchievementIndex(INDEX, { query: 'pingüino artico', categoryId: null }).map((entry) => entry.id)).toEqual([5]);
	});

	it('puts the names that start with the text first and keeps the index order inside each group', () => {
		expect(searchAchievementIndex(INDEX, { query: 'tyria', categoryId: null }).map((entry) => entry.id)).toEqual([4, 1, 2]);
	});

	it('combines the text with the category filter', () => {
		expect(searchAchievementIndex(INDEX, { query: 'tyria', categoryId: 1 }).map((entry) => entry.id)).toEqual([4, 2]);
		expect(searchAchievementIndex(INDEX, { query: '', categoryId: 1 }).map((entry) => entry.id)).toEqual([2, 3, 4]);
	});

	it('answers nothing for an empty text without a category, and honours the limit', () => {
		expect(searchAchievementIndex(INDEX, { query: '   ', categoryId: null })).toEqual([]);
		expect(searchAchievementIndex(INDEX, { query: 'de', categoryId: null }, 2)).toHaveLength(2);
	});
});

describe('achievements with the same name (real ids of the API, 10 oct 2026)', () => {
	it('are all indexed and all found: the index is by id, never by name', () => {
		const plan = planAchievementIndex(parseAchievementCategories(SAME_NAME_CATEGORIES)!);
		expect(plan.ids).toEqual([5391, 5403, 8903, 9307]);
		const entries = parseAchievementPage(SAME_NAME_PAGE)!.details.map((detail) => toAchievementIndexEntry(detail, plan.categoryOf.get(detail.id) ?? null));
		expect(searchAchievementIndex(entries, { query: 'portero de bar', categoryId: null }).map((entry) => [entry.id, entry.categoryId])).toEqual([[8903, 463], [9307, 482]]);
		expect(searchAchievementIndex(entries, { query: 'muerte al dominio', categoryId: null }).map((entry) => entry.id)).toEqual([5403, 5391]);
	});
});
