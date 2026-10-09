import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { SerialTaskQueue, runSerialTaskUnqueued, type SerialTaskRunner } from '../core/serial-task-queue';
import { indexedDbPriceHistoryPort } from '../host/indexed-db-price-history';
import {
	PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN,
	PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS,
	PRICE_SEED_BULK_REFRESH_UNREACHABLE_WAIT_MS,
	PriceSeedBulkRefreshService,
} from './price-seed-bulk-refresh';
import type { PriceSeedResult } from './price-seed-model';
import { fetchPriceSeed } from './price-seed-source';
import { HttpTransportError, type HttpTransport } from '../core/http';

/** `fetchSeed` through the real source, with a transport that answers each item with `statusOf(itemId)` (non-2xx throws, as the real one does). */
function sourceAnswering(statusOf: (itemId: number) => number, requested: number[]) {
	const transport: HttpTransport = {
		send: async (request) => {
			const itemId = Number(new URL(request.url).searchParams.get('itemID'));
			requested.push(itemId);
			const status = statusOf(itemId);
			if (status >= 200 && status < 300) return { status, headers: {}, body: [] };
			throw new HttpTransportError('http', status, null, 'status');
		},
	} as HttpTransport;
	// A 2xx answer is not what these tests are about: it only has to count as an answered item.
	return async (itemId: number) => {
		const result = await fetchPriceSeed(itemId, { transport, now: () => NOW_MS });
		return result.status === 'no_seed' && result.reason === 'empty' ? seeded(itemId) : result;
	};
}

const NOW_MS = Date.parse('2026-09-11T00:00:00.000Z');

function seeded(itemId: number): PriceSeedResult {
	return {
		status: 'seeded',
		seed: { version: 1, itemId, source: 'datawars2', retrievedAt: '2026-09-11T00:00:00.000Z', days: [{ dayUtc: '2026-09-10', bidCopper: 100, askCopper: 110 }] },
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe('PriceSeedBulkRefreshService (SPEC-recomendacion-por-objeto, decision 4, M2)', () => {
	it('requests one item at a time: no two fetchSeed calls are ever in flight together', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const calls: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				calls.push(itemId);
				await sleep(5);
				inFlight -= 1;
				return seeded(itemId);
			},
		});
		const outcome = await service.run([1, 2, 3]);
		expect(maxInFlight).toBe(1);
		expect(calls).toEqual([1, 2, 3]);
		expect(outcome).toEqual({
			attempted: 3, seeded: 3, skippedCached: 0, skippedNoSeedCooldown: 0, noSeed: 0, failed: 0,
			queueCoverage: { total: 3, seeded: 3, noData: 0, pending: 0 },
		});
	});

	it('serializes overlapping Sync and Sale runs, reusing the first run cache', async () => {
		const requests: number[] = [];
		let active = 0;
		let maximum = 0;
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'overlap', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requests.push(itemId); active += 1; maximum = Math.max(maximum, active);
				await sleep(5); active -= 1;
				return seeded(itemId);
			},
		});
		const outcomes = await Promise.all([service.run([1, 2]), service.run([2, 3])]);
		expect(maximum).toBe(1);
		expect(requests).toEqual([1, 2, 3]);
		expect(outcomes[1]).toMatchObject({ seeded: 1, skippedCached: 1 });
		service.dispose();
	});

	it('never exceeds the named per-run cap, leaving the rest for the next sync', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
		});
		const itemIds = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN + 10 }, (_unused, index) => index + 1);
		const outcome = await service.run(itemIds);
		expect(outcome.attempted).toBe(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(requested).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(requested).toEqual(itemIds.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN));
		// H18.17: the cap on attempts must never hide the rest of the watch list from the caller.
		expect(outcome.queueCoverage).toEqual({
			total: itemIds.length, seeded: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN, noData: 0, pending: 10,
		});
	});

	it('an item with a cache entry inside the 24h TTL is never requested', async () => {
		const requested: number[] = [];
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
		});
		const first = await service.run([1]);
		expect(requested).toEqual([1]);
		expect(first).toMatchObject({ attempted: 1, seeded: 1, skippedCached: 0, failed: 0 });
		now += 60_000; // one minute later, well inside 24h
		const second = await service.run([1, 2]);
		expect(requested).toEqual([1, 2]);
		expect(second).toMatchObject({ attempted: 1, seeded: 1, skippedCached: 1, failed: 0 });
	});

	it('reads each cached seed once per pass: the coverage reuses what the loop already read', async () => {
		const port = indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() });
		const reads: number[] = [];
		const counted: typeof port = {
			...port,
			openSeedCache: async () => {
				const cache = await port.openSeedCache();
				return {
					get: async (vaultId, itemId) => { reads.push(itemId); return await cache.get(vaultId, itemId); },
					put: cache.put.bind(cache), close: cache.close.bind(cache),
				};
			},
		};
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued, priceHistory: counted, vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => seeded(itemId),
		});
		const outcome = await service.run([1, 2, 3]);

		expect(outcome.queueCoverage).toEqual({ total: 3, seeded: 3, noData: 0, pending: 0 });
		expect(reads, 'a seed was read twice in one pass').toEqual([1, 2, 3]);
		service.dispose();
	});

	it('Z12: a 400-day pass keeps the older days of a longer copy already cached, and its own days win on the overlap', async () => {
		const dayAt = (index: number): string => new Date(Date.parse('2024-01-01T00:00:00.000Z') + index * 86_400_000).toISOString().slice(0, 10);
		const seedOf = (from: number, count: number, bid: number): Extract<PriceSeedResult, { status: 'seeded' }>['seed'] => ({
			version: 1, itemId: 7, source: 'datawars2', retrievedAt: '2026-09-11T00:00:00.000Z',
			days: Array.from({ length: count }, (_unused, offset) => ({ dayUtc: dayAt(from + offset), bidCopper: bid, askCopper: null })),
		});
		const factory = new IDBFactory();
		const first = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		await first.put('vault', 7, seedOf(0, 700, 100), NOW_MS - 25 * 60 * 60 * 1000);
		first.close();
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async () => ({ status: 'seeded', seed: seedOf(400, 400, 200) }),
		});

		await service.run([7]);
		service.dispose();

		const cache = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		const kept = (await cache.get('vault', 7))!.seed.days;
		cache.close();
		// The union is 800 days, but the copy never grows past the longer input (700): the 100
		// oldest go, the longer copy is still not cut down to the 400 the pass downloaded.
		expect(kept).toHaveLength(700);
		expect(kept[0]).toMatchObject({ dayUtc: dayAt(100), bidCopper: 100 });
		expect(kept[299]).toMatchObject({ dayUtc: dayAt(399), bidCopper: 100 });
		expect(kept[300]).toMatchObject({ dayUtc: dayAt(400), bidCopper: 200 });
		expect(kept[699]).toMatchObject({ dayUtc: dayAt(799), bidCopper: 200 });
		expect(new Set(kept.map((day) => day.dayUtc)).size).toBe(700);
	});

	it('a 400-day copy refreshed with a pass shifted one day stays at 400 days and ends on the newest day', async () => {
		const dayAt = (index: number): string => new Date(Date.parse('2024-01-01T00:00:00.000Z') + index * 86_400_000).toISOString().slice(0, 10);
		const seedOf = (from: number, count: number, bid: number): Extract<PriceSeedResult, { status: 'seeded' }>['seed'] => ({
			version: 1, itemId: 7, source: 'datawars2', retrievedAt: '2026-09-11T00:00:00.000Z',
			days: Array.from({ length: count }, (_unused, offset) => ({ dayUtc: dayAt(from + offset), bidCopper: bid, askCopper: null })),
		});
		const factory = new IDBFactory();
		const first = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		await first.put('vault', 7, seedOf(0, 400, 100), NOW_MS - 25 * 60 * 60 * 1000);
		first.close();
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async () => ({ status: 'seeded', seed: seedOf(1, 400, 200) }),
		});

		await service.run([7]);
		service.dispose();

		const cache = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		const kept = (await cache.get('vault', 7))!.seed.days;
		cache.close();
		expect(kept).toHaveLength(400);
		expect(kept[0]).toMatchObject({ dayUtc: dayAt(1) });
		expect(kept[399]).toMatchObject({ dayUtc: dayAt(400), bidCopper: 200 });
	});

	it('a stale cache entry (past the 24h TTL) is requested again', async () => {
		const requested: number[] = [];
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
		});
		await service.run([1]);
		now += 25 * 60 * 60 * 1000;
		const outcome = await service.run([1]);
		expect(requested).toEqual([1, 1]);
		expect(outcome).toMatchObject({ attempted: 1, seeded: 1, skippedCached: 0, failed: 0 });
	});

	it('a thrown failure on item k never stops item k+1 from being attempted', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				if (itemId === 2) throw new Error('datawars2 unreachable');
				return seeded(itemId);
			},
		});
		const outcome = await service.run([1, 2, 3]);
		expect(requested).toEqual([1, 2, 3]);
		expect(outcome).toMatchObject({ attempted: 3, seeded: 2, skippedCached: 0, noSeed: 0, failed: 1 });
		// A thrown download (unlike a `no_seed` answer) leaves no record: item 2 stays "pending", not "sin datos".
		expect(outcome.queueCoverage).toEqual({ total: 3, seeded: 2, noData: 0, pending: 1 });
	});

	it('a no_seed answer on item k also never stops item k+1, and is no longer counted as a failure', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				return itemId === 2 ? { status: 'no_seed', reason: 'empty' } : seeded(itemId);
			},
		});
		const outcome = await service.run([1, 2, 3]);
		expect(requested).toEqual([1, 2, 3]);
		expect(outcome).toEqual({
			attempted: 3, seeded: 2, skippedCached: 0, skippedNoSeedCooldown: 0, noSeed: 1, failed: 0,
			queueCoverage: { total: 3, seeded: 2, noData: 1, pending: 0 },
		});
	});

	/**
	 * H18.17 (auditoría 24 sep 2026, §3.E): the exact bug named there. Before this fix a `no_seed`
	 * answer was never cached, so every one of the first 25 items re-spent its slot on the very
	 * same `no_seed` answer on the next sync too, and the trailing items were NEVER reached.
	 */
	it('items with no_seed at the start of the list no longer block the rest of the watch list on the next sync', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				return itemId <= PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN
					? { status: 'no_seed', reason: 'empty' }
					: seeded(itemId);
			},
		});
		const itemIds = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN + 5 }, (_unused, index) => index + 1);
		const first = await service.run(itemIds);
		expect(first.attempted).toBe(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(first.noSeed).toBe(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(requested).toEqual(itemIds.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN));

		requested.length = 0;
		const second = await service.run(itemIds);
		expect(second.skippedNoSeedCooldown).toBe(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(second.attempted).toBe(5);
		expect(requested).toEqual(itemIds.slice(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN));
	});

	/**
	 * Z13 (audit, 9 oct 2026): a pass made while the host limits (429 -> `unreachable`) used to mark
	 * all 25 items, and a minute later, with the host healthy, skipped them all for 24 h.
	 */
	it('Z13: an unreachable answer writes no 24 h marker, so a healthy host is asked again after the short wait', async () => {
		const requested: number[] = [];
		let healthy = false;
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				return healthy ? seeded(itemId) : { status: 'no_seed', reason: 'unreachable' };
			},
		});
		const first = await service.run([1, 2]);
		expect(first).toMatchObject({ attempted: 2, noSeed: 0, failed: 2, skippedNoSeedCooldown: 0 });
		expect(first.queueCoverage).toEqual({ total: 2, seeded: 0, noData: 0, pending: 2 });

		now += PRICE_SEED_BULK_REFRESH_UNREACHABLE_WAIT_MS;
		healthy = true;
		const second = await service.run([1, 2]);
		expect(second).toMatchObject({ attempted: 2, seeded: 2, skippedNoSeedCooldown: 0 });
		expect(requested).toEqual([1, 2, 1, 2]);
		service.dispose();
	});

	it('Z13: the pass ends after 3 unreachable answers in a row instead of spending all 25 requests', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { requested.push(itemId); return { status: 'no_seed', reason: 'unreachable' }; },
		});
		const itemIds = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN }, (_unused, index) => index + 1);
		const outcome = await service.run(itemIds);
		expect(requested).toEqual([1, 2, 3]);
		expect(outcome).toMatchObject({ attempted: 3, failed: 3, stoppedUnreachable: true });
		service.dispose();
	});

	it('Z13 (a): 25 items the host answers 404 for are all requested and marked, the pass is not cut, and a minute later all 25 are skipped', async () => {
		const requested: number[] = [];
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => now,
			fetchSeed: sourceAnswering(() => 404, requested),
		});
		const itemIds = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN }, (_unused, index) => index + 1);
		const first = await service.run(itemIds);
		expect(first).toMatchObject({ attempted: 25, noSeed: 25, failed: 0 });
		expect(first.stoppedUnreachable).toBeUndefined();
		now += 60_000;
		const second = await service.run(itemIds);
		expect(second).toMatchObject({ attempted: 0, skippedNoSeedCooldown: 25 });
		expect(requested).toHaveLength(25);
		service.dispose();
	});

	it('Z13 (b): three 404 at the start of the list do not keep the healthy items behind them from being requested', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: sourceAnswering((itemId) => (itemId <= 3 ? 404 : 200), requested),
		});
		const outcome = await service.run([1, 2, 3, 4, 5]);
		expect(requested).toEqual([1, 2, 3, 4, 5]);
		expect(outcome).toMatchObject({ attempted: 5, noSeed: 3 });
		expect(outcome.stoppedUnreachable).toBeUndefined();
		service.dispose();
	});

	it('Z13 (c): 429, 404, 429, 429 does not cut the pass (the 404 breaks the streak) and only the 404 is marked', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: sourceAnswering((itemId) => (itemId === 2 ? 404 : 429), requested),
		});
		const first = await service.run([1, 2, 3, 4]);
		expect(requested).toEqual([1, 2, 3, 4]);
		expect(first).toMatchObject({ attempted: 4, noSeed: 1, failed: 3 });
		expect(first.stoppedUnreachable).toBeUndefined();
		// The 404 sits in its 24 h cooldown and the three 429 in their short wait: nothing is asked.
		const second = await service.run([1, 2, 3, 4]);
		expect(second).toMatchObject({ skippedNoSeedCooldown: 1, attempted: 0 });
		service.dispose();
	});

	it('Z13: three items that stay unreachable do not starve the rest of the list across passes', async () => {
		let now = NOW_MS;
		const requestedPerPass: number[][] = [];
		let current: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { current.push(itemId); return itemId <= 3 ? { status: 'no_seed', reason: 'unreachable' } : seeded(itemId); },
		});
		const itemIds = Array.from({ length: 30 }, (_unused, index) => index + 1);
		const seededAfter: number[] = [];
		for (let pass = 0; pass < 5; pass += 1) {
			current = [];
			const outcome = await service.run(itemIds);
			requestedPerPass.push(current);
			seededAfter.push(outcome.queueCoverage.seeded);
			now += 60_000;
		}
		// Pass 1 spends 3 requests on the failing ones; every later pass skips them (15 min wait) and serves the next 25.
		expect(requestedPerPass.map((ids) => ids.length)).toEqual([3, 25, 2, 0, 0]);
		expect(requestedPerPass[1]).toEqual(itemIds.slice(3, 28));
		expect(seededAfter).toEqual([0, 25, 27, 27, 27]);
		service.dispose();
	});

	it('Z13: with the whole host down a pass costs at most 3 requests, and everything is served as soon as it is back, within the short wait', async () => {
		let now = NOW_MS;
		let up = false;
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return up ? seeded(itemId) : { status: 'no_seed', reason: 'unreachable' }; },
		});
		const itemIds = Array.from({ length: 10 }, (_unused, index) => index + 1);
		const perPass: number[] = [];
		for (let pass = 0; pass < 4; pass += 1) {
			requested.length = 0;
			await service.run(itemIds);
			perPass.push(requested.length);
			now += 60_000;
		}
		expect(perPass.every((count) => count <= 3)).toBe(true);
		expect(perPass).toEqual([3, 3, 3, 1]);
		up = true;
		now += PRICE_SEED_BULK_REFRESH_UNREACHABLE_WAIT_MS;
		requested.length = 0;
		const recovered = await service.run(itemIds);
		expect(recovered).toMatchObject({ seeded: 10, skippedNoSeedCooldown: 0 });
		expect(recovered.queueCoverage).toEqual({ total: 10, seeded: 10, noData: 0, pending: 0 });
		service.dispose();
	});

	it('Z13: an item inside its short wait is still pending in the coverage', async () => {
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async () => ({ status: 'no_seed', reason: 'unreachable' }),
		});
		await service.run([1]);
		const second = await service.run([1]);
		expect(second).toMatchObject({ attempted: 0, failed: 0 });
		expect(second.queueCoverage).toEqual({ total: 1, seeded: 0, noData: 0, pending: 1 });
		service.dispose();
	});

	it('Z13: an answer in between breaks the streak, so two failures, a seed and two more do not stop the pass', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				return itemId === 3 ? seeded(itemId) : { status: 'no_seed', reason: 'unreachable' };
			},
		});
		const outcome = await service.run([1, 2, 3, 4, 5]);
		expect(requested).toEqual([1, 2, 3, 4, 5]);
		expect(outcome.stoppedUnreachable).toBeUndefined();
		service.dispose();
	});

	it('Z13: with a host that hangs for 10 s per request, the pass lasts 30 s instead of 250 s', async () => {
		vi.useFakeTimers();
		try {
			let requests = 0;
			const service = new PriceSeedBulkRefreshService({
				serialize: runSerialTaskUnqueued,
				priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => Date.now(),
				fetchSeed: async () => {
					requests += 1;
					await new Promise<void>((resolve) => { setTimeout(resolve, 10_000); });
					return { status: 'no_seed', reason: 'unreachable' };
				},
			});
			const itemIds = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN }, (_unused, index) => index + 1);
			const startedAt = Date.now();
			const run = service.run(itemIds);
			let finished = false;
			void run.then(() => { finished = true; });
			let elapsedMs = 0;
			while (!finished && elapsedMs < 300_000) { await vi.advanceTimersByTimeAsync(100); elapsedMs += 100; }
			await run;
			// The polling step above is 0.1 s, so the measured time is 30 s to within that step.
			const seconds = (Date.now() - startedAt) / 1000;
			expect(requests).toBe(3);
			expect(seconds).toBeGreaterThanOrEqual(30);
			expect(seconds).toBeLessThanOrEqual(30.1);
			service.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('a no_seed answer is retried after its spaced cooldown elapses, but not before', async () => {
		const requested: number[] = [];
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return { status: 'no_seed', reason: 'empty' }; },
		});
		await service.run([1]);
		expect(requested).toEqual([1]);

		now += 60_000; // one minute later, well inside the cooldown
		const withinCooldown = await service.run([1]);
		expect(withinCooldown).toMatchObject({ attempted: 0, noSeed: 0, skippedNoSeedCooldown: 1 });
		expect(requested).toEqual([1]);

		now += PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS + 1;
		const afterCooldown = await service.run([1]);
		expect(afterCooldown).toMatchObject({ attempted: 1, noSeed: 1, skippedNoSeedCooldown: 0 });
		expect(requested).toEqual([1, 1]);
	});

	it('reports queue coverage across the whole watch list, not just the items this run reached', async () => {
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => (itemId === 2 ? { status: 'no_seed', reason: 'empty' } : seeded(itemId)),
		});
		const outcome = await service.run([1, 2, 3]);
		expect(outcome.queueCoverage).toEqual({ total: 3, seeded: 2, noData: 1, pending: 0 });
	});

	it('never touches fetchSeed before run is called', () => {
		let calls = 0;
		new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { calls += 1; return seeded(itemId); },
		});
		expect(calls).toBe(0);
	});
});

/**
 * 1 oct 2026: an action waits only for the items that have NO seed at all; a copy past its 24 h is
 * still read by the analysis and is refreshed after the result, out of what the action's cap left.
 */
describe('PriceSeedBulkRefreshService phases: missing seeds first, stale copies afterwards', () => {
	const DAY_AND_AN_HOUR_MS = 25 * 60 * 60 * 1000;

	/** A service whose cache already holds a seed past its TTL for every one of `staleItemIds`. */
	async function withStaleSeeds(staleItemIds: readonly number[]) {
		const requested: number[] = [];
		let now = NOW_MS - DAY_AND_AN_HOUR_MS;
		const factory = new IDBFactory();
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
			// Wider than any list below, so the preload is never the thing the cap cuts.
			maxItemsPerRun: 100,
		});
		await service.run(staleItemIds);
		service.dispose();
		requested.length = 0;
		now = NOW_MS;
		const phased = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
		});
		return { requested, service: phased };
	}

	it('the missing phase requests only the items without any seed and counts the stale copies it left', async () => {
		const { requested, service } = await withStaleSeeds([1, 3]);
		const outcome = await service.run([1, 2, 3, 4], undefined, { scope: 'missing' });
		expect(requested).toEqual([2, 4]);
		expect(outcome).toMatchObject({ attempted: 2, seeded: 2, staleSkipped: 2 });
		expect(outcome.deferredBudget).toBe(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 2);
		// A stale copy is still a seed: the coverage of the whole list is already complete.
		expect(outcome.queueCoverage).toEqual({ total: 4, seeded: 4, noData: 0, pending: 0 });
		service.dispose();
	});

	it('the stale phase requests only the stale copies, never an item without a seed, within its budget', async () => {
		const { requested, service } = await withStaleSeeds([1, 3, 5]);
		const outcome = await service.run([1, 2, 3, 4, 5], undefined, { scope: 'stale', budget: 2 });
		expect(requested).toEqual([1, 3]);
		expect(outcome).toMatchObject({ attempted: 2, seeded: 2 });
		service.dispose();
	});

	it('shares one cap between the two phases: the missing items first, the stale copies out of what is left', async () => {
		const stale = Array.from({ length: 10 }, (_unused, index) => index + 1);
		const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN - 5 }, (_unused, index) => index + 11);
		const { requested, service } = await withStaleSeeds(stale);
		const first = await service.run([...stale, ...missing], undefined, { scope: 'missing' });
		expect(requested).toEqual(missing);
		expect(first.deferredBudget).toBe(5);
		const second = await service.run([...stale, ...missing], undefined, { scope: 'stale', budget: first.deferredBudget ?? 0 });
		expect(second.attempted).toBe(5);
		expect(requested).toEqual([...missing, ...stale.slice(0, 5)]);
		expect(requested).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		service.dispose();
	});

	it('leaves no budget for the stale copies when the missing items alone reach the cap', async () => {
		const stale = [1, 2, 3];
		const missing = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN + 4 }, (_unused, index) => index + 11);
		const { requested, service } = await withStaleSeeds(stale);
		const outcome = await service.run([...stale, ...missing], undefined, { scope: 'missing' });
		expect(requested).toEqual(missing.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN));
		expect(outcome.deferredBudget).toBe(0);
		service.dispose();
	});

	it('the missing phase of a later analysis of the same action spends only the budget it is given', async () => {
		const { requested, service } = await withStaleSeeds([1]);
		const outcome = await service.run([1, 2, 3, 4], undefined, { scope: 'missing', budget: 2 });
		expect(requested).toEqual([2, 3]);
		expect(outcome).toMatchObject({ attempted: 2, staleSkipped: 1, deferredBudget: 0 });
		service.dispose();
	});

	it('the stale phase stops at the next item once the caller no longer allows it', async () => {
		const { requested, service } = await withStaleSeeds([1, 2, 3]);
		// Allowed until the first download has been made, as when the opt-in is switched off mid-pass.
		const outcome = await service.run([1, 2, 3], undefined, { scope: 'stale', budget: 3, allowed: () => requested.length === 0 });
		expect(requested).toEqual([1]);
		expect(outcome).toMatchObject({ attempted: 1, seeded: 1 });
		service.dispose();
	});

	it('the missing phase stops at the next item once the caller no longer allows it', async () => {
		const { requested, service } = await withStaleSeeds([]);
		const outcome = await service.run([5, 6, 7], undefined, { scope: 'missing', allowed: () => requested.length === 0 });
		expect(requested).toEqual([5]);
		expect(outcome).toMatchObject({ attempted: 1, seeded: 1 });
		service.dispose();
	});

	it('writes nothing once disposed: a download that answers after dispose is dropped, not stored', async () => {
		const factory = new IDBFactory();
		let started!: () => void;
		const inFlight = new Promise<void>((resolve) => { started = resolve; });
		let answer!: () => void;
		const gate = new Promise<void>((resolve) => { answer = resolve; });
		const service = new PriceSeedBulkRefreshService({
			serialize: runSerialTaskUnqueued,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { started(); await gate; return seeded(itemId); },
		});
		const run = service.run([1, 2]);
		await inFlight;
		service.dispose();
		answer();
		const outcome = await run;
		// Before the guard the answer was written to the store `dispose` had just closed, and that
		// write's own failure was recorded as a `storage_failure` nobody could act on.
		expect(outcome.failed).toBe(0);
		expect(outcome).toMatchObject({ attempted: 1, seeded: 0 });
		const reader = await indexedDbPriceHistoryPort({ indexedDB: factory }).openSeedCache();
		expect(await reader.get('vault', 1)).toBeNull();
		reader.close();
	});
});

/**
 * Task 0812d53e. The pass keeps its own order, cap and phases; each of its requests takes a turn in
 * the queue it shares with the other seed downloads of the plugin, where it may wait behind them.
 */
describe('PriceSeedBulkRefreshService requests through the queue it was handed', () => {
	/** A queue whose turn is taken by something else until the test ends it. */
	function busyQueue() {
		const queue = new SerialTaskQueue();
		let endOther!: () => void;
		const other = queue.run('interactive', () => new Promise<void>((resolve) => { endOther = resolve; }));
		let waiting = 0;
		return {
			queue,
			serialize: (async (task) => { waiting += 1; return await queue.run('background', task); }) as SerialTaskRunner,
			/** Resolves once the pass has an item waiting for its turn, or has requested one without waiting. */
			itemReachedItsRequest: async (calls: readonly number[]) => {
				await vi.waitFor(() => { expect(waiting + calls.length).toBeGreaterThan(0); });
			},
			endOther: async () => { endOther(); await other; },
		};
	}

	it('an item whose permission is withdrawn while it waits for its turn is not requested, and the pass ends there', async () => {
		const calls: number[] = [];
		let allowed = true;
		const { serialize, itemReachedItsRequest, endOther } = busyQueue();
		const service = new PriceSeedBulkRefreshService({
			serialize,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { calls.push(itemId); return seeded(itemId); },
		});

		const run = service.run([1, 2, 3], undefined, { scope: 'missing', allowed: () => allowed });
		await itemReachedItsRequest(calls);
		expect(calls).toEqual([]);
		allowed = false;
		await endOther();
		const outcome = await run;

		expect(calls).toEqual([]);
		expect(outcome).toMatchObject({ attempted: 0, seeded: 0, noSeed: 0, failed: 0, deferredBudget: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN });
		service.dispose();
	});

	it('an item still allowed when its turn comes is requested then, and the pass goes on in order', async () => {
		const calls: number[] = [];
		const { serialize, itemReachedItsRequest, endOther } = busyQueue();
		const service = new PriceSeedBulkRefreshService({
			serialize,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: new IDBFactory() }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { calls.push(itemId); return seeded(itemId); },
		});

		const run = service.run([1, 2, 3], undefined, { scope: 'missing', allowed: () => true });
		await itemReachedItsRequest(calls);
		expect(calls).toEqual([]);
		await endOther();
		const outcome = await run;

		expect(calls).toEqual([1, 2, 3]);
		expect(outcome).toMatchObject({ attempted: 3, seeded: 3 });
		service.dispose();
	});

	it('a turn the queue dropped is an item not attempted: no request, no failure, no cache and no no_seed cooldown', async () => {
		const calls: number[] = [];
		const factory = new IDBFactory();
		const { queue, serialize, itemReachedItsRequest, endOther } = busyQueue();
		const service = new PriceSeedBulkRefreshService({
			serialize,
			priceHistory: indexedDbPriceHistoryPort({ indexedDB: factory }), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { calls.push(itemId); return { status: 'no_seed', reason: 'unreachable' }; },
		});

		const run = service.run([1, 2]);
		await itemReachedItsRequest(calls);
		expect(calls).toEqual([]);
		queue.dispose();
		const outcome = await run;
		await endOther();

		expect(calls).toEqual([]);
		expect(outcome).toMatchObject({
			attempted: 0, seeded: 0, noSeed: 0, failed: 0, skippedNoSeedCooldown: 0,
			queueCoverage: { total: 2, seeded: 0, noData: 0, pending: 2 },
		});
		service.dispose();
		const port = indexedDbPriceHistoryPort({ indexedDB: factory });
		const seeds = await port.openSeedCache();
		const noSeeds = await port.openNoSeedCache();
		expect(await seeds.get('vault', 1)).toBeNull();
		expect(await noSeeds.get('vault', 1)).toBeNull();
		expect(await noSeeds.get('vault', 2)).toBeNull();
		seeds.close();
		noSeeds.close();
	});
});
