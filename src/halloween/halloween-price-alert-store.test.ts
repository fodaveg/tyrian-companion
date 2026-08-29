import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type { HalloweenPriceValidProjection } from './halloween-price-alert';
import { IndexedDbHalloweenStore } from './halloween-store';

describe('Halloween price-alert durable crossing state', () => {
	it('enforces cooldown and one notice per UTC day without resetting state on settings changes', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), `h11-price-state-${crypto.randomUUID()}`);
		await store.commitPriceProjection('vault', 'account', projection('below', '2026-08-30', 100, 0), 24);
		const first = await store.commitPriceProjection('vault', 'account', projection('high', '2026-08-30', 120, 23 * 3_600_000), 24);
		expect(first.shouldNotify).toBe(true);
		await store.commitPriceProjection('vault', 'account', projection('below', '2026-08-30', 100, 23 * 3_600_000 + 1), 6);
		expect((await store.commitPriceProjection('vault', 'account', projection('high', '2026-08-30', 130, 23 * 3_600_000 + 2), 6)).shouldNotify)
			.toBe(false);
		await store.commitPriceProjection('vault', 'account', projection('below', '2026-08-31', 100, 6 * 3_600_000), 6);
		expect((await store.commitPriceProjection('vault', 'account', projection('high', '2026-08-31', 130, 7 * 3_600_000), 6)).shouldNotify)
			.toBe(false);
		await store.commitPriceProjection('vault', 'account', projection('below', '2026-09-01', 100, 0), 48);
		expect((await store.commitPriceProjection('vault', 'account', projection('high', '2026-09-01', 130, 1), 48))
			.shouldNotify).toBe(true);
		expect(await store.readPriceNotices('vault', 'account')).toHaveLength(2);
		store.close();
	});

	it('keeps the newest accepted projection when an older window commits after it', async () => {
		const factory = new IDBFactory();
		const databaseName = `h11-price-multiwindow-${crypto.randomUUID()}`;
		const first = await IndexedDbHalloweenStore.open(factory, databaseName);
		const second = await IndexedDbHalloweenStore.open(factory, databaseName);
		await first.commitPriceProjection('vault', 'account', projection('below', '2026-08-29', 90, 0), 24);
		const newest = await second.commitPriceProjection('vault', 'account', projection('high', '2026-08-31', 130, 12 * 3_600_000), 24);
		expect(newest.shouldNotify).toBe(true);
		const stale = await first.commitPriceProjection('vault', 'account', projection('below', '2026-08-31', 90, 11 * 3_600_000), 24);
		expect(stale).toMatchObject({ accepted: false, projection: newest.projection });
		const laterHigh = await first.commitPriceProjection('vault', 'account', projection('high', '2026-09-02', 140, 13 * 3_600_000), 24);
		expect(laterHigh.shouldNotify).toBe(false);
		expect(await first.readPriceNotices('vault', 'account')).toHaveLength(1);
		first.close(); second.close();
	});

	it('rejects a projection whose declared status contradicts its threshold', async () => {
		const store = await IndexedDbHalloweenStore.open(new IDBFactory(), `h11-price-invalid-${crypto.randomUUID()}`);
		const invalid = { ...projection('high', '2026-08-31', 130, 0), bidCopper: 90 };
		await expect(store.commitPriceProjection('vault', 'account', invalid, 24)).rejects.toMatchObject({ failure: 'corrupt' });
		store.close();
	});
});

function projection(status: 'below' | 'high', dayUtc: string, bidCopper: number, capturedAtMs: number): HalloweenPriceValidProjection {
	const timestamp = Date.parse(`${dayUtc}T00:00:00.000Z`) + capturedAtMs;
	return { status, dayUtc, bidCopper, p90Copper: 100, capturedAtMs: timestamp, referenceDays: 30, minimumAboveP90Bps: 0 };
}
