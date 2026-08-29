import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { HttpTransportError } from '../core/http';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { parsePublicTradingPostPriceBatch } from './session-price-snapshot';
import {
	PRICE_HISTORY_MAX_BATCH_SIZE,
	priceHistoryIntervalMs,
	type PriceHistoryIntervalMinutes,
	type PriceHistorySnapshotV1,
	type PriceHistoryTuple,
} from './price-history-model';
import { PriceHistoryStoreError, type IndexedDbPriceHistoryStore } from './price-history-store';

export type PriceHistoryCaptureResult =
	| { status: 'complete' | 'partial' | 'already_captured'; snapshot: PriceHistorySnapshotV1 }
	| { status: 'busy' }
	| { status: 'rate_limited'; retryAfterMs: number | null }
	| { status: 'transient_failure' }
	| { status: 'invalid_payload' }
	| { status: 'store_unavailable' };

/** Sequential public-price capture. It records only unit bid/ask values, never listing quantities. */
export class PriceHistoryCaptureService {
	private readonly flights = new Map<string, Promise<PriceHistoryCaptureResult>>();

	constructor(
		private readonly gateway: PublicCatalogGateway,
		private readonly rateLimit: Pick<RateLimitCoordinator, 'status' | 'recordRateLimited'>,
		private readonly ownerId: string,
		private readonly now: () => number = Date.now,
	) {}

	capture(
		store: IndexedDbPriceHistoryStore,
		vaultId: string,
		slotStartMs: number,
		intervalMinutes: PriceHistoryIntervalMinutes,
	): Promise<PriceHistoryCaptureResult> {
		const key = `${vaultId}:${String(slotStartMs)}`;
		const existing = this.flights.get(key);
		if (existing) return existing;
		const flight = this.captureInternal(store, vaultId, slotStartMs, intervalMinutes)
			.finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
		this.flights.set(key, flight);
		return flight;
	}

	private async captureInternal(
		store: IndexedDbPriceHistoryStore,
		vaultId: string,
		slotStartMs: number,
		intervalMinutes: PriceHistoryIntervalMinutes,
	): Promise<PriceHistoryCaptureResult> {
		const cooldown = this.rateLimit.status();
		if (cooldown.active) return { status: 'rate_limited', retryAfterMs: cooldown.remainingMs };
		try {
			const claim = await store.claimSlot(vaultId, slotStartMs, this.ownerId, this.now());
			if (claim.status === 'captured') return { status: 'already_captured', snapshot: claim.snapshot };
			if (claim.status === 'busy') return { status: 'busy' };
			const watch = await store.ensureSeedWatchList(vaultId, this.now());
			const requestedIds = watch.map(({ itemId }) => itemId).sort((left, right) => left - right);
			const tuples: PriceHistoryTuple[] = [];
			const missing = new Set<number>();
			let incompleteSides = false;
			for (const batch of chunks(requestedIds, PRICE_HISTORY_MAX_BATCH_SIZE)) {
				const requested = new Set(batch);
				let response;
				try {
					response = await this.gateway.requestDetailed(`commerce/prices?ids=${batch.join(',')}`);
				} catch (error) {
					if (error instanceof HttpTransportError && error.status === 429) {
						this.rateLimit.recordRateLimited(error.retryAfterMs);
						return { status: 'rate_limited', retryAfterMs: error.retryAfterMs };
					}
					if (error instanceof HttpTransportError && error.status === 404) {
						batch.forEach((id) => missing.add(id));
						continue;
					}
					if (error instanceof HttpTransportError && (error.kind === 'network' || error.kind === 'timeout'
						|| (error.status !== null && [500, 502, 503, 504].includes(error.status)))) {
						return { status: 'transient_failure' };
					}
					return { status: 'invalid_payload' };
				}
				if (response.status !== 200 && response.status !== 206) {
					batch.forEach((id) => missing.add(id));
					continue;
				}
				if (!validPriceEnvelope(response.body, requested)) return { status: 'invalid_payload' };
				const parsed = parsePublicTradingPostPriceBatch(response.body, requested);
				incompleteSides ||= parsed.incompleteSides || parsed.items.some(({ bid, ask }) => bid === null || ask === null);
				const rawIds = new Set((response.body as Array<{ id: number }>).map(({ id }) => id));
				if (parsed.missing.some((id) => rawIds.has(id))) return { status: 'invalid_payload' };
				for (const item of parsed.items) tuples.push([item.itemId, item.bid?.unitCopper ?? null, item.ask?.unitCopper ?? null]);
				for (const id of parsed.missing) missing.add(id);
			}
			tuples.sort((left, right) => left[0] - right[0]);
			const missingItemIds = [...missing].sort((left, right) => left - right);
			const snapshot: PriceHistorySnapshotV1 = {
				version: 1, vaultId, slotStartMs, capturedAtMs: this.now(),
				intervalMs: priceHistoryIntervalMs(intervalMinutes),
				status: missingItemIds.length === 0 && !incompleteSides ? 'complete' : 'partial',
				items: tuples, missingItemIds,
			};
			const committed = await store.commitSlot(claim.lease, snapshot);
			if (committed.status === 'stale_fence') return { status: 'busy' };
			return committed.status === 'captured'
				? { status: 'already_captured', snapshot: committed.snapshot }
				: { status: snapshot.status, snapshot: committed.snapshot };
		} catch (error) {
			return { status: error instanceof PriceHistoryStoreError ? 'store_unavailable' : 'invalid_payload' };
		}
	}
}

function validPriceEnvelope(value: unknown, requested: ReadonlySet<number>): value is Array<{ id: number }> {
	if (!Array.isArray(value)) return false;
	const ids = new Set<number>();
	for (const entry of value) {
		if (!record(entry) || !Number.isSafeInteger(entry.id) || (entry.id as number) <= 0
			|| !requested.has(entry.id as number) || ids.has(entry.id as number)) return false;
		ids.add(entry.id as number);
	}
	return true;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
