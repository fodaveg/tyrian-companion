import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN, PriceSeedBulkRefreshService } from './price-seed-bulk-refresh';
import type { PriceSeedResult } from './price-seed-model';

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
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
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
		expect(outcome).toEqual({ attempted: 3, seeded: 3, skippedCached: 0, failed: 0 });
	});

	it('never exceeds the named per-run cap, leaving the rest for the next sync', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
		});
		const itemIds = Array.from({ length: PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN + 10 }, (_unused, index) => index + 1);
		const outcome = await service.run(itemIds);
		expect(outcome.attempted).toBe(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(requested).toHaveLength(PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN);
		expect(requested).toEqual(itemIds.slice(0, PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN));
	});

	it('an item with a cache entry inside the 24h TTL is never requested', async () => {
		const requested: number[] = [];
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			factory: new IDBFactory(), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
		});
		const first = await service.run([1]);
		expect(requested).toEqual([1]);
		expect(first).toEqual({ attempted: 1, seeded: 1, skippedCached: 0, failed: 0 });
		now += 60_000; // one minute later, well inside 24h
		const second = await service.run([1, 2]);
		expect(requested).toEqual([1, 2]);
		expect(second).toEqual({ attempted: 1, seeded: 1, skippedCached: 1, failed: 0 });
	});

	it('a stale cache entry (past the 24h TTL) is requested again', async () => {
		const requested: number[] = [];
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			factory: new IDBFactory(), vaultId: 'vault', now: () => now,
			fetchSeed: async (itemId) => { requested.push(itemId); return seeded(itemId); },
		});
		await service.run([1]);
		now += 25 * 60 * 60 * 1000;
		const outcome = await service.run([1]);
		expect(requested).toEqual([1, 1]);
		expect(outcome).toEqual({ attempted: 1, seeded: 1, skippedCached: 0, failed: 0 });
	});

	it('a thrown failure on item k never stops item k+1 from being attempted', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				if (itemId === 2) throw new Error('datawars2 unreachable');
				return seeded(itemId);
			},
		});
		const outcome = await service.run([1, 2, 3]);
		expect(requested).toEqual([1, 2, 3]);
		expect(outcome).toEqual({ attempted: 3, seeded: 2, skippedCached: 0, failed: 1 });
	});

	it('a no_seed answer on item k also never stops item k+1', async () => {
		const requested: number[] = [];
		const service = new PriceSeedBulkRefreshService({
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				return itemId === 2 ? { status: 'no_seed', reason: 'unreachable' } : seeded(itemId);
			},
		});
		const outcome = await service.run([1, 2, 3]);
		expect(requested).toEqual([1, 2, 3]);
		expect(outcome).toEqual({ attempted: 3, seeded: 2, skippedCached: 0, failed: 1 });
	});

	it('never touches fetchSeed before run is called', () => {
		let calls = 0;
		new PriceSeedBulkRefreshService({
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => { calls += 1; return seeded(itemId); },
		});
		expect(calls).toBe(0);
	});
});
