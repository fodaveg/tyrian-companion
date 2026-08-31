import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError } from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import {
	isCommerceListingLevels,
	type CommerceListingLevelV1,
	type InventoryItemMarketDepthV1,
	type InventoryMarketDepthEvidenceV1,
} from './commerce-listings';

export const COMMERCE_LISTINGS_BATCH_SIZE = 200;

type RateLimitGate = Pick<RateLimitCoordinator, 'status' | 'recordRateLimited'>;

/** Captures bounded public order-book depth; it never accepts or sends an API key. */
export async function captureInventoryMarketDepth(
	requestedItemIds: readonly number[],
	gateway: PublicCatalogGateway,
	capturedAt: number,
	rateLimit?: RateLimitGate,
	actionContext?: ResolvedLocalDebugActionContext,
): Promise<InventoryMarketDepthEvidenceV1> {
	const requested = normalizeIds(requestedItemIds);
	const items: InventoryItemMarketDepthV1[] = [];
	for (const batch of chunks(requested, COMMERCE_LISTINGS_BATCH_SIZE)) {
		if (rateLimit?.status().active === true) {
			items.push(...batch.map((itemId) => unavailable(itemId)));
			continue;
		}
		try {
			const response = await gateway.requestDetailed(`commerce/listings?ids=${batch.join(',')}`, actionContext);
			if (response.status !== 200 && response.status !== 206) {
				items.push(...batch.map((itemId) => unavailable(itemId)));
				continue;
			}
			items.push(...parseBatch(response.body, batch));
		} catch (error) {
			if (error instanceof HttpTransportError && error.status === 429) {
				rateLimit?.recordRateLimited(error.retryAfterMs);
			}
			items.push(...batch.map((itemId) => unavailable(itemId)));
		}
	}
	items.sort((left, right) => left.itemId - right.itemId);
	const complete = items.filter((item) => item.coverage === 'complete').length;
	return {
		version: 1,
		capturedAt: new Date(capturedAt).toISOString(),
		source: 'gw2-commerce-listings',
		requestedItemIds: requested,
		status: complete === items.length ? 'complete' : complete === 0 ? 'unavailable' : 'partial',
		items,
	};
}

function parseBatch(body: unknown, requested: number[]): InventoryItemMarketDepthV1[] {
	if (!Array.isArray(body)) return requested.map((itemId) => invalid(itemId));
	const requestedSet = new Set(requested);
	const seen = new Map<number, unknown>();
	for (const entry of body) {
		if (!record(entry) || !positive(entry.id) || !requestedSet.has(entry.id) || seen.has(entry.id)) {
			return requested.map((itemId) => invalid(itemId));
		}
		seen.set(entry.id, entry);
	}
	return requested.map((itemId) => {
		const entry = seen.get(itemId);
		if (!record(entry)) return missing(itemId);
		const buys = parseLevels(entry.buys, 'buys');
		const sells = parseLevels(entry.sells, 'sells');
		return buys === null || sells === null ? invalid(itemId)
			: { itemId, coverage: 'complete', buys, sells };
	});
}

function parseLevels(value: unknown, side: 'buys' | 'sells'): CommerceListingLevelV1[] | null {
	if (!Array.isArray(value)) return null;
	const levels: CommerceListingLevelV1[] = [];
	for (const entry of value) {
		if (!record(entry) || !exactKeys(entry, ['listings', 'unit_price', 'quantity'])
			|| !nonNegative(entry.listings) || !positive(entry.unit_price) || !positive(entry.quantity)) return null;
		levels.push({ unitCopper: entry.unit_price, quantity: entry.quantity });
	}
	return isCommerceListingLevels(levels, side) ? levels : null;
}

function unavailable(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'unavailable', buys: [], sells: [] }; }
function missing(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'missing', buys: [], sells: [] }; }
function invalid(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'invalid', buys: [], sells: [] }; }
function normalizeIds(values: readonly number[]): number[] { return [...new Set(values.filter(positive))].sort((a, b) => a - b); }
function chunks<T>(values: readonly T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
