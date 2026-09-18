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
});
