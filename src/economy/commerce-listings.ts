import { HttpTransportError } from '../core/http';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { calculateTradingPostFees, createTradingPostValueWithPolicy } from './gw2-fees';

export const COMMERCE_LISTINGS_BATCH_SIZE = 200;

export interface CommerceListingLevelV1 {
	unitCopper: number;
	quantity: number;
}

export interface InventoryItemMarketDepthV1 {
	itemId: number;
	coverage: 'complete' | 'missing' | 'invalid' | 'unavailable';
	buys: CommerceListingLevelV1[];
	sells: CommerceListingLevelV1[];
}

export interface InventoryMarketDepthEvidenceV1 {
	version: 1;
	capturedAt: string;
	source: 'gw2-commerce-listings';
	requestedItemIds: number[];
	status: 'complete' | 'partial' | 'unavailable';
	items: InventoryItemMarketDepthV1[];
}

export interface DemonstratedMarketValueV1 {
	status: 'complete' | 'partial' | 'no_market' | 'invalid';
	requestedQuantity: number;
	coveredQuantity: number;
	uncoveredQuantity: number;
	grossCopper: number | null;
	netCopper: number | null;
	unitCopper: number | null;
}

type RateLimitGate = Pick<RateLimitCoordinator, 'status' | 'recordRateLimited'>;

/** Captures bounded public order-book depth; it never accepts or sends an API key. */
export async function captureInventoryMarketDepth(
	requestedItemIds: readonly number[],
	gateway: PublicCatalogGateway,
	capturedAt: number,
	rateLimit?: RateLimitGate,
): Promise<InventoryMarketDepthEvidenceV1> {
	const requested = normalizeIds(requestedItemIds);
	const items: InventoryItemMarketDepthV1[] = [];
	for (const batch of chunks(requested, COMMERCE_LISTINGS_BATCH_SIZE)) {
		if (rateLimit?.status().active === true) {
			items.push(...batch.map((itemId) => unavailable(itemId)));
			continue;
		}
		try {
			const response = await gateway.requestDetailed(`commerce/listings?ids=${batch.join(',')}`);
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

/** Values only the quantity matched by real buy levels, from best bid downwards. */
export function valueInstantSellDepth(
	levels: readonly CommerceListingLevelV1[],
	quantity: number,
): DemonstratedMarketValueV1 {
	if (!validQuantity(quantity) || !validLevels(levels, 'buys')) return invalidValue(quantity);
	let remaining = quantity;
	let covered = 0;
	let gross = 0;
	for (const level of levels) {
		const take = Math.min(remaining, level.quantity);
		if (take === 0) break;
		const slice = level.unitCopper * take;
		if (!Number.isSafeInteger(slice) || !Number.isSafeInteger(gross + slice)) return invalidValue(quantity);
		gross += slice;
		covered += take;
		remaining -= take;
	}
	if (covered === 0) return unavailableValue(quantity);
	const fees = calculateTradingPostFees(gross);
	if (fees.status !== 'ok') return invalidValue(quantity);
	const net = gross - fees.fees.totalFeesCopper;
	if (!Number.isSafeInteger(net) || net < 0) return invalidValue(quantity);
	return {
		status: remaining === 0 ? 'complete' : 'partial', requestedQuantity: quantity,
		coveredQuantity: covered, uncoveredQuantity: remaining, grossCopper: gross,
		netCopper: net, unitCopper: null,
	};
}

/** Values one manual listing at the current best ask; sell-listing quantity is not buyer capacity. */
export function valueCompetitiveListing(
	levels: readonly CommerceListingLevelV1[],
	quantity: number,
): DemonstratedMarketValueV1 {
	if (!validQuantity(quantity) || !validLevels(levels, 'sells')) return invalidValue(quantity);
	const best = levels[0];
	if (best === undefined) return unavailableValue(quantity);
	const value = createTradingPostValueWithPolicy('listing', best.unitCopper, quantity);
	if (value.status !== 'ok') return invalidValue(quantity);
	return {
		status: 'complete', requestedQuantity: quantity, coveredQuantity: quantity, uncoveredQuantity: 0,
		grossCopper: value.value.grossCopper, netCopper: value.value.netCopper, unitCopper: best.unitCopper,
	};
}

export function isInventoryMarketDepthEvidence(value: unknown): value is InventoryMarketDepthEvidenceV1 {
	if (!record(value) || !exactKeys(value, ['version', 'capturedAt', 'source', 'requestedItemIds', 'status', 'items'])
		|| value.version !== 1 || !iso(value.capturedAt) || value.source !== 'gw2-commerce-listings'
		|| !Array.isArray(value.requestedItemIds) || !strictIds(value.requestedItemIds)
		|| !['complete', 'partial', 'unavailable'].includes(String(value.status))
		|| !Array.isArray(value.items) || !value.items.every(isItem)
		|| !strictItems(value.items)) return false;
	const evidence = value as unknown as InventoryMarketDepthEvidenceV1;
	if (!sameIds(evidence.requestedItemIds, evidence.items.map((item) => item.itemId))) return false;
	const complete = evidence.items.filter((item) => item.coverage === 'complete').length;
	return evidence.status === (complete === evidence.items.length ? 'complete' : complete === 0 ? 'unavailable' : 'partial');
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
	return validLevels(levels, side) ? levels : null;
}

function validLevels(levels: readonly CommerceListingLevelV1[], side: 'buys' | 'sells'): boolean {
	return levels.every((level, index) => positive(level.unitCopper) && positive(level.quantity)
		&& (index === 0 || (side === 'buys'
			? levels[index - 1]!.unitCopper > level.unitCopper
			: levels[index - 1]!.unitCopper < level.unitCopper)));
}

function isItem(value: unknown): boolean {
	return record(value) && exactKeys(value, ['itemId', 'coverage', 'buys', 'sells']) && positive(value.itemId)
		&& ['complete', 'missing', 'invalid', 'unavailable'].includes(String(value.coverage))
		&& Array.isArray(value.buys) && Array.isArray(value.sells)
		&& (value.coverage === 'complete'
			? validLevels(value.buys as CommerceListingLevelV1[], 'buys') && validLevels(value.sells as CommerceListingLevelV1[], 'sells')
			: value.buys.length === 0 && value.sells.length === 0);
}

function unavailable(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'unavailable', buys: [], sells: [] }; }
function missing(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'missing', buys: [], sells: [] }; }
function invalid(itemId: number): InventoryItemMarketDepthV1 { return { itemId, coverage: 'invalid', buys: [], sells: [] }; }
function unavailableValue(quantity: number): DemonstratedMarketValueV1 { return { status: 'no_market', requestedQuantity: quantity, coveredQuantity: 0, uncoveredQuantity: quantity, grossCopper: null, netCopper: null, unitCopper: null }; }
function invalidValue(quantity: number): DemonstratedMarketValueV1 { return { status: 'invalid', requestedQuantity: validQuantity(quantity) ? quantity : 0, coveredQuantity: 0, uncoveredQuantity: validQuantity(quantity) ? quantity : 0, grossCopper: null, netCopper: null, unitCopper: null }; }
function normalizeIds(values: readonly number[]): number[] { return [...new Set(values.filter(positive))].sort((a, b) => a - b); }
function chunks<T>(values: readonly T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function strictIds(values: unknown[]): boolean { return values.every(positive) && values.every((value, index) => index === 0 || (values[index - 1] as number) < value); }
function strictItems(values: unknown[]): boolean { return values.every((value, index) => index === 0 || (values[index - 1] as InventoryItemMarketDepthV1).itemId < (value as InventoryItemMarketDepthV1).itemId); }
function sameIds(left: number[], right: number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function validQuantity(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function iso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
