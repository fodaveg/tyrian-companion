import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import type { CatalogItem, CatalogLocale } from '../catalog/public-catalog-model';
import { parseCatalogItems } from '../catalog/public-catalog-parsers';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError, type HttpResponse } from '../core/http';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { parsePublicTradingPostPriceBatch } from '../economy/session-price-snapshot';
import type { HalloweenItemEvidence } from './halloween-model';
import type { HalloweenUnlockService } from './halloween-unlocks';

const MAX_BATCH = 200;

export class HalloweenEvidenceService {
	constructor(
		private readonly publicGateway: PublicCatalogGateway,
		private readonly unlocks: HalloweenUnlockService,
		private readonly rateLimit: RateLimitCoordinator,
	) {}

	async resolve(input: {
		gains: readonly { itemId: number; quantity: number }[];
		firstSeenItemIds: readonly number[];
		learning: boolean;
		scopes: readonly string[];
		locale: CatalogLocale;
	}): Promise<HalloweenItemEvidence[]> {
		const ids = [...new Set(input.gains.map(({ itemId }) => itemId))].sort((a, b) => a - b);
		const [catalog, prices, unlocks] = await Promise.all([
			this.captureCatalog(ids, input.locale), this.capturePrices(ids), this.unlocks.capture(input.scopes),
		]);
		const firstSeen = new Set(input.firstSeenItemIds);
		return input.gains.map(({ itemId, quantity }) => {
			const item = catalog.get(itemId) ?? null;
			const price = prices.get(itemId) ?? null;
			const bound = item !== null && item.flags.some((flag) =>
				flag === 'AccountBound' || flag === 'SoulbindOnAcquire');
			const instantUnit = !bound && price?.bid ? safePercent(price.bid.unitCopper, 85) : null;
			const vendorUnit = item !== null && item.vendorValue > 0 && !item.flags.includes('NoSell') ? item.vendorValue : null;
			return {
				itemId, quantity, catalog: item,
				netUnitCopper: maximum(instantUnit, vendorUnit), bound,
				firstSeen: firstSeen.has(itemId), learning: input.learning, unlocks,
			};
		});
	}

	private async captureCatalog(ids: number[], locale: CatalogLocale): Promise<Map<number, CatalogItem>> {
		const items = new Map<number, CatalogItem>();
		for (const batch of chunks(ids, MAX_BATCH)) {
			try {
				const response = await this.requestDetailed(
					`items?ids=${batch.join(',')}&lang=${locale}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				);
				if (response.status !== 200 && response.status !== 206) continue;
				for (const item of parseCatalogItems(response.body)) if (batch.includes(item.id)) items.set(item.id, item);
			} catch { /* unresolved catalog evidence stays null */ }
		}
		return items;
	}

	private async capturePrices(ids: number[]): Promise<Map<number, ReturnType<typeof parsePublicTradingPostPriceBatch>['items'][number]>> {
		const items = new Map<number, ReturnType<typeof parsePublicTradingPostPriceBatch>['items'][number]>();
		for (const batch of chunks(ids, MAX_BATCH)) {
			try {
				const response = await this.requestDetailed(
					`commerce/prices?ids=${batch.join(',')}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				);
				if (response.status !== 200 && response.status !== 206) continue;
				for (const price of parsePublicTradingPostPriceBatch(response.body, new Set(batch)).items) items.set(price.itemId, price);
			} catch { /* unresolved price evidence stays null */ }
		}
		return items;
	}

	private async requestDetailed(path: string): Promise<HttpResponse> {
		const cooldown = this.rateLimit.status();
		if (cooldown.active) throw new HttpTransportError('http', 429, cooldown.remainingMs, 'Shared rate limit is active.');
		try { return await this.publicGateway.requestDetailed(path); }
		catch (error) {
			if (error instanceof HttpTransportError && error.status === 429) this.rateLimit.recordRateLimited(error.retryAfterMs);
			throw error;
		}
	}
}

function safePercent(value: number, percent: number): number | null {
	const result = BigInt(value) * BigInt(percent) / 100n;
	return result > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(result);
}
function maximum(left: number | null, right: number | null): number | null {
	return left === null ? right : right === null ? left : Math.max(left, right);
}
function chunks<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}
