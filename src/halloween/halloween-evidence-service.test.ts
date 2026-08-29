import { describe, expect, it } from 'vitest';
import { itemPayload } from '../catalog/__fixtures__/public-catalog';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError, type HttpResponse } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { HalloweenEvidenceService } from './halloween-evidence-service';
import { HalloweenUnlockService } from './halloween-unlocks';

describe('Halloween evidence service', () => {
	it('batches official catalog and price evidence and keeps unlock grant metadata distinct', async () => {
		const calls: string[] = [];
		const gateway: PublicCatalogGateway = { requestDetailed: async (path) => {
			calls.push(path);
			const ids = idsFrom(path);
			if (path.startsWith('items?')) return response(ids.map((id) => ({
				...itemPayload(id),
				rarity: id === 1 ? 'Rare' : 'Basic',
				vendor_value: id === 1 ? 20 : 0,
				details: id === 1 ? { skins: [800, 800, 799], minipet_id: 700 } : {},
			})));
			return response(ids.map((id) => ({
				id, whitelisted: true,
				buys: { quantity: 1, unit_price: id === 1 ? 100 : 10 },
				sells: { quantity: 1, unit_price: id === 1 ? 120 : 12 },
			})));
		} };
		const service = new HalloweenEvidenceService(gateway, unlocks({
			'account/skins': [799], 'account/minis': [700],
		}), new RateLimitCoordinator());
		const gains = Array.from({ length: 201 }, (_, index) => ({ itemId: index + 1, quantity: 2 }));

		const evidence = await service.resolve({
			gains, firstSeenItemIds: [1], learning: false, scopes: ['unlocks'], locale: 'es',
		});

		expect(calls).toHaveLength(4);
		expect(calls.filter((path) => path.startsWith('items?')).map(idsFrom)).toEqual([
			Array.from({ length: 200 }, (_, index) => index + 1), [201],
		]);
		expect(calls.filter((path) => path.startsWith('commerce/prices?')).map(idsFrom)).toEqual([
			Array.from({ length: 200 }, (_, index) => index + 1), [201],
		]);
		expect(evidence[0]).toMatchObject({
			itemId: 1, quantity: 2, catalogStatus: 'complete', netUnitCopper: 85, priceStatus: 'quote', bound: false, firstSeen: true,
			catalog: { details: { skins: [799, 800], minipetId: 700 } },
			unlocks: { status: 'complete', unlockedSkinIds: [799], unlockedMiniIds: [700] },
		});
	});

	it('fails closed for malformed public payloads while retaining the observed gain', async () => {
		const service = new HalloweenEvidenceService({ requestDetailed: async (path) =>
			response(path.startsWith('items?') ? [{ id: 1 }] : [{ id: 1, whitelisted: 'yes' }])
		}, unlocks({ 'account/skins': [], 'account/minis': [] }), new RateLimitCoordinator());

		await expect(service.resolve({
			gains: [{ itemId: 1, quantity: 3 }], firstSeenItemIds: [], learning: true,
			scopes: ['unlocks'], locale: 'en',
		})).resolves.toMatchObject([{
			itemId: 1, quantity: 3, catalog: null, catalogStatus: 'invalid', netUnitCopper: null, priceStatus: 'invalid', bound: false,
		}]);
	});

	it('records public 429s in the coordinator shared with authenticated calls', async () => {
		let now = 1_000;
		const rateLimit = new RateLimitCoordinator({ now: () => now });
		const service = new HalloweenEvidenceService({ requestDetailed: async () => {
			throw new HttpTransportError('http', 429, 4_000, 'limited');
		} }, unlocks({ 'account/skins': [], 'account/minis': [] }, rateLimit), rateLimit);

		const evidence = await service.resolve({
			gains: [{ itemId: 1, quantity: 1 }], firstSeenItemIds: [], learning: false,
			scopes: ['unlocks'], locale: 'en',
		});
		expect(evidence[0]?.priceStatus).toBe('rate_limited');
		expect(evidence[0]?.catalogStatus).toBe('rate_limited');
		expect(rateLimit.status()).toMatchObject({ active: true, remainingMs: 4_000 });
		now += 4_000;
	});

	it('distinguishes no quote, opt-out, invalid payload and offline coverage', async () => {
		const gateway: PublicCatalogGateway = { requestDetailed: async (path) => {
			if (path.startsWith('items?')) return response(idsFrom(path).map(itemPayload));
			const ids = idsFrom(path);
			if (ids.includes(4)) throw new HttpTransportError('network', null, null, 'offline');
			return response([
				{ id: 2, whitelisted: false, buys: { quantity: 1, unit_price: 50_000 }, sells: { quantity: 1, unit_price: 60_000 } },
				{ id: 3, whitelisted: true, buys: { quantity: 1 }, sells: { quantity: 1, unit_price: 1 } },
			]);
		} };
		const service = new HalloweenEvidenceService(gateway, unlocks({
			'account/skins': [], 'account/minis': [],
		}), new RateLimitCoordinator());
		const first = await service.resolve({ gains: [1, 2, 3].map((itemId) => ({ itemId, quantity: 1 })),
			firstSeenItemIds: [], learning: false, scopes: ['unlocks'], locale: 'en' });
		expect(first.map(({ priceStatus }) => priceStatus)).toEqual(['no_quote', 'no_quote', 'invalid']);
		expect(first[1]?.netUnitCopper).toBe(12); // vendor only; whitelisted=false TP bid is ignored
		const offline = await service.resolve({ gains: [{ itemId: 4, quantity: 1 }], firstSeenItemIds: [],
			learning: false, scopes: ['unlocks'], locale: 'en' });
		expect(offline[0]?.priceStatus).toBe('unavailable');
	});

	it('does not turn an ambiguously malformed batch entry into demonstrated no-quote evidence', async () => {
		const service = new HalloweenEvidenceService({ requestDetailed: async (path) => response(
			path.startsWith('items?') ? [itemPayload(1)] : [{ id: '1', whitelisted: true }],
		) }, unlocks({ 'account/skins': [], 'account/minis': [] }), new RateLimitCoordinator());
		const evidence = await service.resolve({ gains: [{ itemId: 1, quantity: 1 }], firstSeenItemIds: [],
			learning: false, scopes: ['unlocks'], locale: 'en' });
		expect(evidence[0]?.priceStatus).toBe('invalid');
	});

	it('keeps an ask-only market as quote coverage without inventing an instant-sale value', async () => {
		const service = new HalloweenEvidenceService({ requestDetailed: async (path) => response(path.startsWith('items?')
			? [itemPayload(1)] : [{ id: 1, whitelisted: true, buys: { quantity: 0, unit_price: 0 },
				sells: { quantity: 1, unit_price: 20_000 } }]) }, unlocks({
			'account/skins': [], 'account/minis': [],
		}), new RateLimitCoordinator());
		const evidence = await service.resolve({ gains: [{ itemId: 1, quantity: 1 }], firstSeenItemIds: [],
			learning: false, scopes: ['unlocks'], locale: 'en' });
		expect(evidence[0]).toMatchObject({ priceStatus: 'quote', netUnitCopper: 12 });
	});
});

function unlocks(
	responses: Record<string, unknown>,
	rateLimit = new RateLimitCoordinator(),
): HalloweenUnlockService {
	return new HalloweenUnlockService({ rateLimit, client: { beginOperation: () => ({
		request: async (path: string) => responses[path],
	}) } });
}

function response(body: unknown): HttpResponse {
	return { status: 200, headers: {}, body };
}

function idsFrom(path: string): number[] {
	const query = path.slice(path.indexOf('?') + 1);
	return new URLSearchParams(query).get('ids')!.split(',').map(Number);
}
