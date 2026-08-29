import { describe, expect, it } from 'vitest';
import { HttpTransportError } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { HalloweenUnlockService } from './halloween-unlocks';

describe('Halloween unlock evidence', () => {
	it('returns complete normalized skins and minis only with unlocks scope', async () => {
		const service = create({ 'account/skins': [3, 1, 3], 'account/minis': [9, 8] });
		await expect(service.capture(['account', 'unlocks'])).resolves.toEqual({
			status: 'complete', unlockedSkinIds: [1, 3], unlockedMiniIds: [8, 9], retryAfterMs: null,
		});
	});

	it('distinguishes missing scope, partial and malformed coverage', async () => {
		await expect(create({}).capture(['account'])).resolves.toMatchObject({ status: 'missing_scope' });
		await expect(create({ 'account/skins': [1], 'account/minis': new Error('offline') }).capture(['unlocks']))
			.resolves.toMatchObject({ status: 'partial', unlockedSkinIds: [1], unlockedMiniIds: [] });
		await expect(create({ 'account/skins': ['bad'], 'account/minis': ['bad'] }).capture(['unlocks']))
			.resolves.toMatchObject({ status: 'invalid' });
	});

	it('records a 429 in the shared coordinator and fails closed', async () => {
		let now = 10;
		const rateLimit = new RateLimitCoordinator({ now: () => now });
		const service = create({ 'account/skins': new HttpTransportError('http', 429, 5_000, 'limited'), 'account/minis': [] }, rateLimit);
		await expect(service.capture(['unlocks'])).resolves.toMatchObject({ status: 'rate_limited', retryAfterMs: 5_000 });
		expect(rateLimit.status()).toMatchObject({ active: true, remainingMs: 5_000 });
		now += 5_000;
	});
});

function create(responses: Record<string, unknown>, rateLimit = new RateLimitCoordinator()): HalloweenUnlockService {
	return new HalloweenUnlockService({ rateLimit, client: { beginOperation: () => ({
		request: async (path: string) => {
			const value = responses[path];
			if (value instanceof Error) throw value;
			return value;
		},
	}) } });
}
