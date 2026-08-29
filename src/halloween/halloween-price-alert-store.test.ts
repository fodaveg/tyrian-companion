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
});

function projection(status: 'below' | 'high', dayUtc: string, bidCopper: number, capturedAtMs: number): HalloweenPriceValidProjection {
	const timestamp = Date.parse(`${dayUtc}T00:00:00.000Z`) + capturedAtMs;
	return { status, dayUtc, bidCopper, p90Copper: 100, capturedAtMs: timestamp, referenceDays: 30, minimumAboveP90Bps: 0 };
}
