import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import type { CatalogItem, CatalogLocale } from '../catalog/public-catalog-model';
import { parseCatalogItems } from '../catalog/public-catalog-parsers';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError, type HttpResponse } from '../core/http';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import { parsePublicTradingPostPriceBatch, type PublicTradingPostItemPrice } from '../economy/session-price-snapshot';
import type { HalloweenItemEvidence } from './halloween-model';
import type { HalloweenUnlockService } from './halloween-unlocks';

const MAX_BATCH = 200;

interface PriceCoverage {
	status: HalloweenItemEvidence['priceStatus'];
	price: PublicTradingPostItemPrice | null;
}

interface CatalogCoverage {
	status: HalloweenItemEvidence['catalogStatus'];
	item: CatalogItem | null;
}

export class HalloweenEvidenceService {
	constructor(
		private readonly publicGateway: PublicCatalogGateway,
		private readonly unlocks: HalloweenUnlockService,
		private readonly rateLimit: RateLimitCoordinator,
		private readonly diagnostics?: LocalDebugActionPort,
	) {}

	async resolve(input: {
		gains: readonly { itemId: number; quantity: number }[];
		firstSeenItemIds: readonly number[];
		learning: boolean;
		scopes: readonly string[];
		locale: CatalogLocale;
	}, parent?: ResolvedLocalDebugActionContext): Promise<HalloweenItemEvidence[]> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'halloween', action: 'halloween_refresh', ...inheritedIds(parent),
			details: { itemCount: input.gains.length },
		});
		try {
			const result = await this.resolveUnobserved(input);
			const rateLimited = result.some((entry) => entry.catalogStatus === 'rate_limited'
				|| entry.priceStatus === 'rate_limited'
				|| entry.unlocks.skinsStatus === 'rate_limited' || entry.unlocks.minisStatus === 'rate_limited');
			const invalid = result.some((entry) => entry.catalogStatus === 'invalid' || entry.priceStatus === 'invalid');
			const unavailable = result.some((entry) => entry.catalogStatus === 'unavailable'
				|| entry.priceStatus === 'unavailable');
			if (rateLimited) span.retry('backoff', { itemCount: result.length });
			else if (invalid) span.failure(new Error('halloween_evidence_invalid'), 'validation_failed', 'partial', { itemCount: result.length });
			else if (unavailable) span.failure(new Error('halloween_evidence_unavailable'), 'network_failure', 'partial', { itemCount: result.length });
			else span.success('complete', { itemCount: result.length });
			return result;
		} catch (error) {
			span.failure(error, 'unknown_failure', 'unavailable', { itemCount: input.gains.length });
			throw error;
		}
	}

	private async resolveUnobserved(input: {
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
			const catalogEvidence = catalog.get(itemId) ?? { status: 'unavailable' as const, item: null };
			const item = catalogEvidence.item;
			const price = prices.get(itemId) ?? { status: 'unavailable' as const, price: null };
			const bound = item !== null && item.flags.some((flag) =>
				flag === 'AccountBound' || flag === 'SoulbindOnAcquire');
			const instantUnit = !bound && price.status === 'quote' && price.price?.bid
				? safePercent(price.price.bid.unitCopper, 85) : null;
			const vendorUnit = item !== null && item.vendorValue > 0 && !item.flags.includes('NoSell') ? item.vendorValue : null;
			return {
				itemId, quantity, catalog: item, catalogStatus: catalogEvidence.status,
				netUnitCopper: maximum(instantUnit, vendorUnit), priceStatus: price.status, bound,
				firstSeen: firstSeen.has(itemId), learning: input.learning, unlocks,
			};
		});
	}

	private async captureCatalog(ids: number[], locale: CatalogLocale): Promise<Map<number, CatalogCoverage>> {
		const items = new Map<number, CatalogCoverage>();
		for (const batch of chunks(ids, MAX_BATCH)) {
			try {
				const response = await this.requestDetailed(
					`items?ids=${batch.join(',')}&lang=${locale}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				);
				if (response.status !== 200 && response.status !== 206) {
					for (const id of batch) items.set(id, { status: 'unavailable', item: null });
					continue;
				}
				const parsed = classifyCatalogBatch(response.body, batch);
				for (const [id, coverage] of parsed) items.set(id, coverage);
			} catch (error) {
				const status = error instanceof HttpTransportError && error.status === 429 ? 'rate_limited' : 'unavailable';
				for (const id of batch) items.set(id, { status, item: null });
			}
		}
		return items;
	}

	private async capturePrices(ids: number[]): Promise<Map<number, PriceCoverage>> {
		const items = new Map<number, PriceCoverage>();
		for (const batch of chunks(ids, MAX_BATCH)) {
			try {
				const response = await this.requestDetailed(
					`commerce/prices?ids=${batch.join(',')}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
				);
				if (response.status !== 200 && response.status !== 206) {
					for (const id of batch) items.set(id, { status: 'unavailable', price: null });
					continue;
				}
				const parsed = classifyPriceBatch(response.body, batch);
				for (const [id, coverage] of parsed) items.set(id, coverage);
			} catch (error) {
				const status = error instanceof HttpTransportError && error.status === 429 ? 'rate_limited' : 'unavailable';
				for (const id of batch) items.set(id, { status, price: null });
			}
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

function classifyCatalogBatch(body: unknown, ids: number[]): Map<number, CatalogCoverage> {
	const invalid = (): Map<number, CatalogCoverage> => new Map(ids.map((id) => [id, { status: 'invalid', item: null }]));
	if (!Array.isArray(body)) return invalid();
	let parsed: CatalogItem[];
	try { parsed = parseCatalogItems(body); } catch { return invalid(); }
	const requested = new Set(ids);
	const byId = new Map(parsed.filter(({ id }) => requested.has(id)).map((item) => [item.id, item]));
	const result = new Map<number, CatalogCoverage>(ids.map((id) => {
		const item = byId.get(id) ?? null;
		return [id, { status: item === null ? 'unavailable' : 'complete', item }];
	}));
	const seen = new Set<number>();
	let ambiguousInvalid = false;
	for (const entry of body) {
		if (!isRecord(entry) || !positiveInteger(entry.id)) { ambiguousInvalid = true; continue; }
		if (!requested.has(entry.id)) continue;
		if (seen.has(entry.id) || !byId.has(entry.id)) result.set(entry.id, { status: 'invalid', item: null });
		seen.add(entry.id);
	}
	if (ambiguousInvalid) {
		for (const id of ids) if (result.get(id)?.item === null) result.set(id, { status: 'invalid', item: null });
	}
	return result;
}

function classifyPriceBatch(body: unknown, ids: number[]): Map<number, PriceCoverage> {
	const result = new Map<number, PriceCoverage>(ids.map((id) => [id, { status: 'no_quote', price: null }]));
	if (!Array.isArray(body)) return new Map<number, PriceCoverage>(ids.map((id) => [id, { status: 'invalid', price: null }]));
	const requested = new Set(ids);
	const seen = new Set<number>();
	let ambiguousInvalid = false;
	for (const entry of body) {
		if (!isRecord(entry) || !positiveInteger(entry.id)) { ambiguousInvalid = true; continue; }
		if (!requested.has(entry.id)) continue;
		const id = entry.id;
		if (seen.has(id)) { result.set(id, { status: 'invalid', price: null }); continue; }
		seen.add(id);
		const parsed = parsePublicTradingPostPriceBatch([entry], new Set([id])).items[0];
		if (!parsed) { result.set(id, { status: 'invalid', price: null }); continue; }
		if (!parsed.whitelisted || (parsed.bid === null && parsed.ask === null)) result.set(id, { status: 'no_quote', price: null });
		else result.set(id, { status: 'quote', price: parsed });
	}
	if (ambiguousInvalid) {
		for (const id of ids) if (result.get(id)?.status === 'no_quote') result.set(id, { status: 'invalid', price: null });
	}
	return result;
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

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inheritedIds(parent: ResolvedLocalDebugActionContext | undefined):
	{ parent: Pick<ResolvedLocalDebugActionContext, 'actionId' | 'correlationId'> } | Record<string, never> {
	return parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } };
}
