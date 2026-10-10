import { describe, expect, it } from 'vitest';

import type { AccountAchievementEntry } from '../account/account-achievements';
import type { AchievementDetail } from './achievement-catalog-model';
import {
	achievementWikiSearchUrl,
	buildTrackedAchievementView,
	buildTrackedAchievementsView,
	type TrackedAchievementInput,
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
		rewards: [], pointCap: null,
		...overrides,
	};
}

function entry(overrides: Partial<AccountAchievementEntry> = {}): AccountAchievementEntry {
	return { id: 10, done: false, current: null, max: null, repeated: null, bits: null, ...overrides };
}

function input(overrides: Partial<TrackedAchievementInput> = {}): TrackedAchievementInput {
	return { id: 10, detail: detail(), englishName: 'Tyria Mastery', retired: false, reading: { entries: [] }, ...overrides };
}

describe('the state of a tracked achievement', () => {
	it('is unread while there is no reading of the account', () => {
		const view = buildTrackedAchievementView(input({ reading: null }));
		expect(view.status).toEqual({ kind: 'unread' });
		expect(view.objectives.map((objective) => objective.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
	});

	it('is in progress n/m with the account numbers, and 0/m from the catalog when the account has no entry yet', () => {
		expect(buildTrackedAchievementView(input({ reading: { entries: [entry({ current: 2, max: 4, bits: [0, 2] })] } })).status)
			.toEqual({ kind: 'in_progress', current: 2, max: 4 });
		expect(buildTrackedAchievementView(input()).status).toEqual({ kind: 'in_progress', current: 0, max: 4 });
	});

	it('is completed when the account says done', () => {
		expect(buildTrackedAchievementView(input({ reading: { entries: [entry({ done: true, current: 4, max: 4 })] } })).status)
			.toEqual({ kind: 'completed' });
	});

	it('has no objectives when neither the account nor the catalog give anything to count', () => {
		const view = buildTrackedAchievementView(input({ detail: detail({ tiers: [], bits: [] }) }));
		expect(view.status).toEqual({ kind: 'no_objectives' });
	});

	it('counts the bits when there is no other number to show', () => {
		const view = buildTrackedAchievementView(input({ detail: detail({ tiers: [] }), reading: { entries: [entry({ bits: [1, 3] })] } }));
		expect(view.status).toEqual({ kind: 'in_progress', current: 2, max: 4 });
	});

	it('is repeatable: done N times plus the progress of the current round', () => {
		const repeatable = detail({ flags: ['Repeatable'], tiers: [{ count: 100, points: 1 }], bits: [], pointCap: 10 });
		expect(buildTrackedAchievementView(input({ detail: repeatable, reading: { entries: [entry({ done: true, repeated: 3, current: 40, max: 100 })] } })).status)
			.toEqual({ kind: 'repeatable', timesDone: 3, current: 40, max: 100 });
		expect(buildTrackedAchievementView(input({ detail: repeatable })).status)
			.toEqual({ kind: 'repeatable', timesDone: 0, current: 0, max: 100 });
	});

	it('is retired when the API no longer serves it, whatever the account says', () => {
		const view = buildTrackedAchievementView(input({ detail: null, retired: true, reading: { entries: [entry({ done: true })] } }));
		expect(view.status).toEqual({ kind: 'retired' });
		expect(view.name).toBeNull();
		expect(view.objectives).toEqual([]);
	});
});

describe('the objectives (bits)', () => {
	it('marks done the indices the account lists and pending the rest, keeping each bit in its slot', () => {
		const view = buildTrackedAchievementView(input({ reading: { entries: [entry({ current: 2, max: 4, bits: [0, 3] })] } }));
		expect(view.objectives).toEqual([
			{ index: 0, kind: 'text', text: 'Primero', refId: null, state: 'done' },
			{ index: 1, kind: 'item', text: null, refId: 19_721, state: 'pending' },
			{ index: 2, kind: 'skin', text: null, refId: 6, state: 'pending' },
			{ index: 3, kind: 'unknown', text: null, refId: null, state: 'done' },
		]);
	});

	it('marks all done for a completed achievement whose entry carries no bits', () => {
		const view = buildTrackedAchievementView(input({ reading: { entries: [entry({ done: true })] } }));
		expect(view.objectives.every((objective) => objective.state === 'done')).toBe(true);
	});

	it('ignores an index the catalog does not have', () => {
		const view = buildTrackedAchievementView(input({ reading: { entries: [entry({ bits: [9] })] } }));
		expect(view.objectives.map((objective) => objective.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
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

describe('the wiki link', () => {
	it('searches the English wiki with the English name', () => {
		expect(achievementWikiSearchUrl('Tyria Mastery: Part 1')).toBe('https://wiki.guildwars2.com/index.php?search=Tyria%20Mastery%3A%20Part%201');
		expect(buildTrackedAchievementView(input()).wikiUrl).toBe('https://wiki.guildwars2.com/index.php?search=Tyria%20Mastery');
	});

	it('gives no link without an English name', () => {
		expect(buildTrackedAchievementView(input({ englishName: null })).wikiUrl).toBeNull();
		expect(buildTrackedAchievementView(input({ englishName: '   ' })).wikiUrl).toBeNull();
	});
});

describe('buildTrackedAchievementsView', () => {
	it('keeps the order of the tracked list and finds each entry of the reading by id', () => {
		const views = buildTrackedAchievementsView({
			trackedIds: [11, 10, 12],
			details: new Map([[10, detail()], [11, detail({ id: 11, name: 'Otro' })]]),
			englishNames: new Map([[10, 'Tyria Mastery']]),
			retired: new Set([12]),
			reading: { entries: [entry({ id: 11, done: true })] },
		});
		expect(views.map((view) => [view.id, view.status.kind])).toEqual([[11, 'completed'], [10, 'in_progress'], [12, 'retired']]);
		expect(views[0]!.wikiUrl).toBeNull();
	});
});
