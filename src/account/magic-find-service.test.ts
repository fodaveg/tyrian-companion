import { describe, expect, it } from 'vitest';

import { HttpTransportError } from '../core/http';
import { MAGICAL_ENRICHMENT_ITEM_ID, magicFindFromAchievementPoints } from './magic-find-model';
import { MagicFindService, type MagicFindDerivationResult } from './magic-find-service';

interface FakeOperation {
	request: (path: string) => Promise<unknown>;
}

/** A fake `operation.request` router for the service's GW2 endpoints, overridable per test. */
function fakeOperation(overrides: Record<string, (path: string) => Promise<unknown>> = {}): FakeOperation {
	return {
		request: async (path: string) => {
			for (const [prefix, handler] of Object.entries(overrides)) {
				if (path.startsWith(prefix)) return handler(path);
			}
			if (path.startsWith('account/luck')) return [{ id: 'luck', value: 100 }];
			if (path.startsWith('characters/') && path.includes('/equipmenttabs/active')) {
				return {
					is_active: true,
					equipment: [{ slot: 'Amulet', location: 'Equipped', infusions: [MAGICAL_ENRICHMENT_ITEM_ID] }],
				};
			}
			if (path.startsWith('achievements?ids=')) {
				return [
					{ id: 1, tiers: [{ count: 10, points: 5 }, { count: 60, points: 10 }] },
					{ id: 2, tiers: [{ count: 1, points: 3 }, { count: 2, points: 4 }] },
				];
			}
			if (path.startsWith('account/achievements')) {
				return [
					{ id: 1, current: 50, done: false },
					{ id: 2, current: null, done: true },
				];
			}
			if (path.startsWith('account?')) return { daily_ap: 488 };
			throw new Error(`unexpected path in fakeOperation: ${path}`);
		},
	};
}

describe('MagicFindService.deriveMagicFind', () => {
	it('sums Luck, completed achievement tiers, daily AP, and amulet enrichment from the real endpoints', async () => {
		const service = new MagicFindService();

		const result = await service.deriveMagicFind(fakeOperation(), 'Astra Uno');

		// tier 1 contributes only its <=50 tier (5), tier 2 is done so all its tiers count (3+4=7);
		// 488 daily AP + 12 tier points = 500, which is exactly the achievement magic find threshold.
		expect(result).toEqual({
			status: 'ok',
			breakdown: { luck: 1, achievements: magicFindFromAchievementPoints(500), enrichment: 20 },
		});
	});

	it('returns a typed missing_scope failure instead of throwing when the key lacks the luck scope (403)', async () => {
		const operation = fakeOperation({
			'account/luck': async () => { throw new HttpTransportError('http', 403, null, 'Forbidden.'); },
		});
		const service = new MagicFindService();

		const result: MagicFindDerivationResult = await service.deriveMagicFind(operation, 'Astra Uno');

		expect(result).toEqual({ status: 'failed', reason: 'missing_scope' });
	});

	it('returns a typed request_failed failure instead of throwing when a request times out', async () => {
		const operation = fakeOperation({
			'characters/': async () => { throw new HttpTransportError('timeout', null, null, 'Request timed out.'); },
		});
		const service = new MagicFindService();

		const result = await service.deriveMagicFind(operation, 'Astra Uno');

		expect(result).toEqual({ status: 'failed', reason: 'request_failed' });
	});

	it('returns a typed invalid_response failure instead of throwing when a response is malformed', async () => {
		const operation = fakeOperation({
			'account/achievements': async () => ({ not: 'an array' }),
		});
		const service = new MagicFindService();

		const result = await service.deriveMagicFind(operation, 'Astra Uno');

		expect(result).toEqual({ status: 'failed', reason: 'invalid_response' });
	});

	it('returns a typed missing_scope failure instead of throwing when daily_ap is absent (progression scope missing)', async () => {
		const operation = fakeOperation({
			'account?': async () => ({}),
		});
		const service = new MagicFindService();

		const result = await service.deriveMagicFind(operation, 'Astra Uno');

		expect(result).toEqual({ status: 'failed', reason: 'missing_scope' });
	});

	describe('repeatable achievements', () => {
		/** Derives the achievement part for one catalog entry and one account entry, with a chosen daily AP. */
		async function achievementsFor(
			catalogEntry: Record<string, unknown>,
			accountEntry: Record<string, unknown>,
			dailyAp = 0,
		): Promise<number> {
			const operation = fakeOperation({
				'achievements?ids=': async () => [{ id: 7, ...catalogEntry }],
				'account/achievements': async () => [{ id: 7, ...accountEntry }],
				'account?': async () => ({ daily_ap: dailyAp }),
			});
			const result = await new MagicFindService().deriveMagicFind(operation, 'Astra Uno');
			if (result.status !== 'ok') throw new Error(`derivation failed: ${result.reason}`);
			return result.breakdown.achievements;
		}

		it('caps the repeated points at point_cap when the cap binds', async () => {
			// Base 2 + 335 * 2 = 672 would exceed the cap, so the logro contributes exactly 250 (+ 488 daily).
			const achievements = await achievementsFor(
				{ tiers: [{ count: 1, points: 2 }], point_cap: 250 },
				{ current: 1, done: true, repeated: 335 },
				488,
			);

			expect(achievements).toBe(magicFindFromAchievementPoints(488 + 250));
		});

		it('adds every repetition when the cap does not bind', async () => {
			// Base 2 (only the count 1 tier is reached), 3 repeats of a 5-point lap: 2 + 15 = 17.
			const achievements = await achievementsFor(
				{ tiers: [{ count: 1, points: 2 }, { count: 10, points: 3 }], point_cap: 100 },
				{ current: 5, done: false, repeated: 3 },
				483,
			);

			expect(achievements).toBe(magicFindFromAchievementPoints(483 + 17));
		});

		it('ignores repetitions when point_cap is -1', async () => {
			const achievements = await achievementsFor(
				{ tiers: [{ count: 1, points: 2 }], point_cap: -1 },
				{ current: 1, done: true, repeated: 400 },
				498,
			);

			expect(achievements).toBe(magicFindFromAchievementPoints(498 + 2));
		});

		it('ignores repetitions when point_cap is not a positive integer without discarding the catalog entry', async () => {
			for (const pointCap of [0, 2.5, '250', null]) {
				const achievements = await achievementsFor(
					{ tiers: [{ count: 1, points: 2 }], point_cap: pointCap },
					{ current: 1, done: true, repeated: 400 },
					498,
				);
				expect(achievements).toBe(magicFindFromAchievementPoints(498 + 2));
			}
		});

		it('behaves as before when repeated is absent or zero', async () => {
			for (const repeated of [undefined, 0]) {
				const achievements = await achievementsFor(
					{ tiers: [{ count: 1, points: 2 }], point_cap: 250 },
					{ current: 1, done: true, repeated },
					498,
				);
				expect(achievements).toBe(magicFindFromAchievementPoints(498 + 2));
			}
		});

		it('rejects a repeated that is not a non-negative integer like any other invalid entry field', async () => {
			for (const repeated of [-1, 1.5, '3']) {
				const operation = fakeOperation({
					'account/achievements': async () => [{ id: 7, current: 1, done: true, repeated }],
				});
				const result = await new MagicFindService().deriveMagicFind(operation, 'Astra Uno');
				expect(result).toEqual({ status: 'failed', reason: 'invalid_response' });
			}
		});

		it('moves to the next magic find step when the repetitions are counted', async () => {
			const catalogEntry = { tiers: [{ count: 1, points: 2 }], point_cap: 100 };
			// 488 daily + base 2 = 490 (below the 500 threshold); 5 repeats of 2 points make it 500.
			const without = await achievementsFor(catalogEntry, { current: 1, done: true }, 488);
			const withRepeats = await achievementsFor(catalogEntry, { current: 1, done: true, repeated: 5 }, 488);

			expect(without).toBe(magicFindFromAchievementPoints(490));
			expect(withRepeats).toBe(magicFindFromAchievementPoints(500));
			expect(withRepeats).toBe(without + 1);
		});
	});
});
