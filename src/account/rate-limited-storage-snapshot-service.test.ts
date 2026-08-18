import { describe, expect, it, vi } from 'vitest';

import { HttpTransportError } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { RateLimitedStorageSnapshotService } from './rate-limited-storage-snapshot-service';
import type { StorageSnapshot } from './storage-snapshot-model';

function clock(startAt: number): { now: () => number; advance: (ms: number) => void } {
	let current = startAt;
	return { now: () => current, advance: (ms) => { current += ms; } };
}

function snapshot(): StorageSnapshot {
	return { accountId: 'a', snapshotId: 's' } as unknown as StorageSnapshot;
}

describe('RateLimitedStorageSnapshotService', () => {
	it('passes captures through untouched while no cooldown is active', async () => {
		const inner = { capture: vi.fn().mockResolvedValue(snapshot()) };
		const coordinator = new RateLimitCoordinator({ now: () => 0 });
		const gated = new RateLimitedStorageSnapshotService(inner as never, coordinator);

		await expect(gated.capture()).resolves.toEqual(snapshot());
		expect(inner.capture).toHaveBeenCalledTimes(1);
	});

	it('records a 429 with its Retry-After and blocks the very next capture', async () => {
		const time = clock(0);
		const inner = {
			capture: vi
				.fn()
				.mockRejectedValueOnce(new HttpTransportError('http', 429, 5_000, 'Limited.'))
				.mockResolvedValue(snapshot()),
		};
		const coordinator = new RateLimitCoordinator({ now: time.now });
		const gated = new RateLimitedStorageSnapshotService(inner as never, coordinator);

		await expect(gated.capture()).rejects.toMatchObject({ status: 429 });
		expect(inner.capture).toHaveBeenCalledTimes(1);

		await expect(gated.capture()).rejects.toMatchObject({ status: 429, retryAfterMs: 5_000 });
		// The guard rejected before reaching the inner service a second time.
		expect(inner.capture).toHaveBeenCalledTimes(1);

		time.advance(5_000);
		await expect(gated.capture()).resolves.toEqual(snapshot());
		expect(inner.capture).toHaveBeenCalledTimes(2);
	});

	it('falls back to a bounded cooldown when Retry-After is missing', async () => {
		const time = clock(0);
		const inner = { capture: vi.fn().mockRejectedValue(new HttpTransportError('http', 429, null, 'Limited.')) };
		const coordinator = new RateLimitCoordinator({ now: time.now, fallbackCooldownMs: 12_000 });
		const gated = new RateLimitedStorageSnapshotService(inner as never, coordinator);

		await expect(gated.capture()).rejects.toMatchObject({ status: 429 });
		expect(coordinator.status()).toEqual({ active: true, retryAt: 12_000, remainingMs: 12_000 });
	});

	it('does not record or gate on non-429 failures, and never retries itself', async () => {
		const inner = { capture: vi.fn().mockRejectedValue(new HttpTransportError('http', 500, null, 'Broken.')) };
		const coordinator = new RateLimitCoordinator({ now: () => 0 });
		const gated = new RateLimitedStorageSnapshotService(inner as never, coordinator);

		await expect(gated.capture()).rejects.toMatchObject({ status: 500 });
		expect(inner.capture).toHaveBeenCalledTimes(1);
		expect(coordinator.status()).toEqual({ active: false });
	});

	it('makes two distinct consumers observe the SAME shared cooldown', async () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		const sessionCapture = { capture: vi.fn().mockRejectedValueOnce(new HttpTransportError('http', 429, 8_000, 'Limited.')) };
		const detectionCapture = { capture: vi.fn().mockResolvedValue(snapshot()) };

		// Two independent consumers, wired to the SAME coordinator instance, as main.ts must do.
		const sessionSnapshots = new RateLimitedStorageSnapshotService(sessionCapture as never, coordinator);
		const detectionSnapshots = new RateLimitedStorageSnapshotService(detectionCapture as never, coordinator);

		await expect(sessionSnapshots.capture()).rejects.toMatchObject({ status: 429 });

		// The OTHER consumer must see the cooldown too, without ever attempting its own request.
		await expect(detectionSnapshots.capture()).rejects.toMatchObject({ status: 429, retryAfterMs: 8_000 });
		expect(detectionCapture.capture).not.toHaveBeenCalled();
	});
});
