import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
	PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN,
	PRICE_SEED_BULK_REFRESH_NO_SEED_RETRY_MS,
	PriceSeedBulkRefreshService,
} from './price-seed-bulk-refresh';
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
			factory: new IDBFactory(), vaultId: 'overlap', now: () => NOW_MS,
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
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
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
			factory: new IDBFactory(), vaultId: 'vault', now: () => now,
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
		expect(outcome).toMatchObject({ attempted: 1, seeded: 1, skippedCached: 0, failed: 0 });
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
		expect(outcome).toMatchObject({ attempted: 3, seeded: 2, skippedCached: 0, noSeed: 0, failed: 1 });
		// A thrown download (unlike a `no_seed` answer) leaves no record: item 2 stays "pending", not "sin datos".
		expect(outcome.queueCoverage).toEqual({ total: 3, seeded: 2, noData: 0, pending: 1 });
	});

	it('a no_seed answer on item k also never stops item k+1, and is no longer counted as a failure', async () => {
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
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => {
				requested.push(itemId);
				return itemId <= PRICE_SEED_BULK_REFRESH_MAX_ITEMS_PER_RUN
					? { status: 'no_seed', reason: 'unreachable' }
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

	it('a no_seed answer is retried after its spaced cooldown elapses, but not before', async () => {
		const requested: number[] = [];
		let now = NOW_MS;
		const service = new PriceSeedBulkRefreshService({
			factory: new IDBFactory(), vaultId: 'vault', now: () => now,
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
			factory: new IDBFactory(), vaultId: 'vault', now: () => NOW_MS,
			fetchSeed: async (itemId) => (itemId === 2 ? { status: 'no_seed', reason: 'empty' } : seeded(itemId)),
		});
		const outcome = await service.run([1, 2, 3]);
		expect(outcome.queueCoverage).toEqual({ total: 3, seeded: 2, noData: 1, pending: 0 });
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
