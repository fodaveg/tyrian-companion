import { describe, expect, it } from 'vitest';

import { parseAchievementCategories, parseAchievementPage, type AchievementDetail } from './achievement-catalog-model';
import { KNOWN_SETS_API_SNAPSHOT } from './__fixtures__/known-sets-api-snapshot';
import { SWEEP_SAMPLE_CATEGORIES, SWEEP_SAMPLE_PAGE } from './__fixtures__/sweep-sample';
import { KNOWN_ACHIEVEMENT_SETS, knownBarUnitOf, knownSetMembersOf } from './known-achievement-sets';
import { buildTrackedAchievementsView, trackedReadingIds, type TrackedAchievementView } from './tracked-achievements-model';

describe('the known sets generated from the wiki (coherence)', () => {
	it('has a set per meta, none twice, with at least as many members as the bar asks for', () => {
		const metas = KNOWN_ACHIEVEMENT_SETS.map((set) => set.meta);
		expect(new Set(metas).size).toBe(metas.length);
		expect(metas.length).toBeGreaterThan(100);
		for (const set of KNOWN_ACHIEVEMENT_SETS) {
			// A bar that counts pieces is short of its list on purpose (223: 90 pieces from 7 achievements).
			if (set.barUnit === undefined) expect(set.members.length, `${String(set.meta)} ${set.name}`).toBeGreaterThanOrEqual(set.tierMax);
			else expect(set.members.length).toBeGreaterThan(0);
		}
	});

	it('lists each member once, never the meta itself, and every id exists in the API snapshot', () => {
		for (const set of KNOWN_ACHIEVEMENT_SETS) {
			expect(new Set(set.members).size, `${String(set.meta)} repeats a member`).toBe(set.members.length);
			expect(set.members, `${String(set.meta)} lists itself`).not.toContain(set.meta);
			expect(KNOWN_SETS_API_SNAPSHOT.has(set.meta), `meta ${String(set.meta)}`).toBe(true);
			for (const member of set.members) expect(KNOWN_SETS_API_SNAPSHOT.has(member), `${String(set.meta)} member ${String(member)}`).toBe(true);
		}
	});

	it('agrees with the API on the bar of each meta, and when the wiki says «all» the set is exactly the bar', () => {
		let all = 0;
		for (const set of KNOWN_ACHIEVEMENT_SETS) {
			expect(KNOWN_SETS_API_SNAPSHOT.get(set.meta), `${String(set.meta)} bar`).toBe(set.tierMax);
			if (set.wikiAll) { all += 1; expect(set.members.length, `${String(set.meta)} ${set.name}`).toBe(set.tierMax); }
		}
		expect(all).toBeGreaterThan(10);
	});

	it('answers a copy, and nothing for a meta without a set', () => {
		const members = knownSetMembersOf(5790)!;
		members.push(1);
		expect(knownSetMembersOf(5790)).toHaveLength(24);
		expect(knownSetMembersOf(5930)).toBeNull();
	});
});

describe('a sample of the sweep over the API (10 oct 2026): what each kind of meta shows', () => {
	const details = new Map(parseAchievementPage(SWEEP_SAMPLE_PAGE)!.details.map((each) => [each.id, each]));
	const categories = parseAchievementCategories(SWEEP_SAMPLE_CATEGORIES)!;
	const view = (id: number, withDetails: Map<number, AchievementDetail> = details, withCategories = categories): TrackedAchievementView =>
		buildTrackedAchievementsView({ trackedIds: [id], details: withDetails, englishNames: new Map(), retired: new Set(), reading: null, categories: withCategories })[0]!;
	/** The real data of a meta under another id, so that it has no known set and the category rule is what is measured. */
	const asUnknownMeta = (id: number) => {
		const copy = 900_000 + id;
		const category = categories.find((each) => each.achievementIds.includes(id))!;
		return {
			id: copy,
			details: new Map([...details, [copy, { ...details.get(id)!, id: copy }]]),
			categories: [{ ...category, achievementIds: category.achievementIds.map((member) => (member === id ? copy : member)) }],
		};
	};

	it('(b) Leyspring 9417: the wiki\'s 46 (Castoran Culture and the hearts included), not the 47 of the category', () => {
		const category = categories.find((each) => each.id === 486)!;
		const shown = view(9417).elements!;
		expect(category.achievementIds.length - 1).toBe(47);
		// The hidden ones the account has not touched are left out (the game lists them only once found).
		const hidden = knownSetMembersOf(9417)!.filter((id) => details.get(id)?.flags.includes('Hidden') === true);
		expect(knownSetMembersOf(9417)).toHaveLength(46);
		expect(shown.total).toBe(46 - hidden.length);
		expect(shown.items.map((element) => element.refId)).toEqual(knownSetMembersOf(9417)!.filter((id) => !hidden.includes(id)));
		expect(knownSetMembersOf(9417)).toEqual(expect.arrayContaining([9397, 9433, 9368]));
		expect(shown.partial).toBeUndefined();
	});

	it('(a) 5790 Seasons of the Dragons: the 24 of the wiki, including «End Conjecture» and Siren\'s Landing 5748', () => {
		const shown = view(5790).elements!;
		expect(shown.total).toBe(24);
		expect(shown.items.map((element) => element.refId)).toEqual(expect.arrayContaining([5960, 5748]));
	});

	it('(a) 9354 and 8908, short by one to four in the API: the wiki completes them (25 of 25, 22 for 21)', () => {
		expect(view(9354).elements).toMatchObject({ total: 25 });
		expect(view(8908).elements).toMatchObject({ total: 22 });
		expect(view(4274).elements).toMatchObject({ total: 25 });
	});

	it('(a) without a set, a category short by a few is listed anyway and says it is partial: 9354 (24 of 25) and 8908 (18 of 21)', () => {
		for (const [id, listed] of [[9354, 24], [8908, 18]] as const) {
			const copy = asUnknownMeta(id);
			const shown = view(copy.id, copy.details, copy.categories).elements!;
			expect(shown.total, String(id)).toBe(listed);
			expect(shown.partial, String(id)).toBe(true);
		}
	});

	it('(a) without a set, a category far below the bar is not its list: 5930 (5 of 30) and 5790 (5 of 24)', () => {
		for (const id of [5930]) {
			expect(view(id).elements, String(id)).toEqual({ source: 'category', items: [], done: 0, total: 0 });
			expect(trackedReadingIds({ trackedIds: [id], details, retired: new Set(), categories }), String(id)).toEqual([id]);
		}
		const copy = asUnknownMeta(5790);
		expect(view(copy.id, copy.details, copy.categories).elements).toEqual({ source: 'category', items: [], done: 0, total: 0 });
	});

	it('(a) 223 «The Emperor\'s New Wardrobe» (bar 90 = 5 armors x 18 pieces): the five Specialty Armors, flagged as a bar of pieces; Fashion Forward and Lunatic\'s Fashion count something else and stay out', () => {
		const shown = view(223).elements!;
		expect(shown.items.map((element) => element.refId)).toEqual([93, 94, 95, 96, 97]);
		expect(shown.barUnit).toBe('pieces');
		expect(shown.partial).toBeUndefined();
		expect(shown.items.map((element) => element.refId)).not.toContain(1567);
		expect(knownBarUnitOf(223)).toBe('pieces');
		expect(knownBarUnitOf(9417)).toBeNull();
	});

	it('(a) 6832 «(Weekly) Mist War Hero»: its nine members are weekly, so the section says they are periodic, not that the API lists none', () => {
		expect(view(6832).elements).toMatchObject({ source: 'category', total: 0, periodicOnly: true });
		expect(view(6832).elements!.hiddenOnly).toBeUndefined();
		// A category with some members that do show is not «periodic only».
		expect(view(9417).elements!.periodicOnly).toBeUndefined();
	});

	it('(a) a meta with neither category nor set (8415 «Return to Season 4», bar 14) has an empty section, not none', () => {
		expect(view(8415).elements).toEqual({ source: 'category', items: [], done: 0, total: 0 });
	});

	it('(a) a category whose 12 members are all hidden (1003 «A Sweet Friend», bar 13) says so; once the account has an entry the element shows', () => {
		const hiddenOnly = view(1003).elements!;
		expect(hiddenOnly).toMatchObject({ total: 0, hiddenOnly: true });
		const touched = [...categories.find((each) => each.achievementIds.includes(1003))!.achievementIds].find((id) => id !== 1003)!;
		const shown = buildTrackedAchievementsView({
			trackedIds: [1003], details, englishNames: new Map(), retired: new Set(), categories,
			reading: { trackedIds: [1003, touched], entries: [{ id: touched, done: false, current: 1, max: 2, repeated: null, bits: null }] },
		})[0]!.elements!;
		expect(shown.total).toBe(1);
		expect(shown.hiddenOnly).toBeUndefined();
	});

	it('(c) achievements with more bits than their bar are listed whole: Text, Minipet and Skin', () => {
		expect(view(3323).elements).toMatchObject({ source: 'bits', total: 2 });
		expect(view(1708).elements).toMatchObject({ source: 'bits', total: 46 });
		expect(view(4902).elements).toMatchObject({ source: 'bits', total: 15 });
		expect(view(3323).elements!.items.every((element) => element.kind === 'text' && element.text !== null && element.wikiUrl === null)).toBe(true);
	});

	it('asks the account about the members of a known set', () => {
		const ids = trackedReadingIds({ trackedIds: [9354], details, retired: new Set(), categories });
		expect(ids).toEqual([9354, ...knownSetMembersOf(9354)!]);
	});
});
