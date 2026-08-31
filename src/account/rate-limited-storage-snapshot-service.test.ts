import { describe, expect, it, vi } from 'vitest';

import { HttpTransportError } from '../core/http';
import { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import { RateLimitedStorageSnapshotService } from './rate-limited-storage-snapshot-service';
import type { SnapshotCoverage, SourceCoverage, StorageSnapshot } from './storage-snapshot-model';

function clock(startAt: number): { now: () => number; advance: (ms: number) => void } {
	let current = startAt;
	return { now: () => current, advance: (ms) => { current += ms; } };
}

interface PartialCoverage {
	sources?: Partial<SnapshotCoverage['sources']>;
	characters?: Partial<SnapshotCoverage['characters']>;
}

function snapshot(coverage?: PartialCoverage): StorageSnapshot {
	return {
		accountId: 'a',
		snapshotId: 's',
		coverage: {
			sources: coverage?.sources ?? {},
			characters: coverage?.characters ?? {},
		},
	} as unknown as StorageSnapshot;
}

function rateLimitedSourceCoverage(retryAfterMs: number | null): SourceCoverage {
	return {
		status: 'partial',
		reason: 'unavailable',
		diagnostic: { kind: 'http', status: 429, retryAfterMs },
	};
}

describe('RateLimitedStorageSnapshotService', () => {
	it('passes captures through untouched while no cooldown is active', async () => {
		const inner = { capture: vi.fn().mockResolvedValue(snapshot()) };
		const coordinator = new RateLimitCoordinator({ now: () => 0 });
		const gated = new RateLimitedStorageSnapshotService(inner as never, coordinator);

		await expect(gated.capture()).resolves.toEqual(snapshot());
		expect(inner.capture).toHaveBeenCalledTimes(1);
	});

	it('forwards advisor progress through the shared cooldown gate', async () => {
		const progress = {
			roster: { completed: 1, total: 2 },
			accountStores: { completed: 3, total: 6 },
			characters: { completed: 1, total: 2 },
		};
		const operation = {} as never;
		const inner = {
			captureInventoryWithOperation: vi.fn(async (
				_operation: never,
				onProgress?: (value: typeof progress) => void,
			) => {
				onProgress?.(progress);
				return snapshot();
			}),
		};
		const onProgress = vi.fn();
		const gated = new RateLimitedStorageSnapshotService(inner as never,
			new RateLimitCoordinator({ now: () => 0 }));

		await gated.captureInventoryWithOperation(operation, onProgress);

		expect(inner.captureInventoryWithOperation).toHaveBeenCalledWith(operation, onProgress);
		expect(onProgress).toHaveBeenCalledWith(progress);
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

	it('arms the cooldown from a 429 that only surfaces as partial coverage on a RESOLVED capture', async () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		const optionalSourceLimited = snapshot({
			sources: { bank: rateLimitedSourceCoverage(7_000) },
		});
		const sessionCapture = { capture: vi.fn().mockResolvedValue(optionalSourceLimited) };
		const detectionCapture = { capture: vi.fn().mockResolvedValue(snapshot()) };
		const sessionSnapshots = new RateLimitedStorageSnapshotService(sessionCapture as never, coordinator);
		const detectionSnapshots = new RateLimitedStorageSnapshotService(detectionCapture as never, coordinator);

		// The capture itself RESOLVES: consumers still get their partial snapshot untouched.
		await expect(sessionSnapshots.capture()).resolves.toEqual(optionalSourceLimited);
		expect(coordinator.status()).toMatchObject({ active: true, remainingMs: 7_000 });

		// A different consumer, sharing the same coordinator, must be blocked next.
		await expect(detectionSnapshots.capture()).rejects.toMatchObject({ status: 429, retryAfterMs: 7_000 });
		expect(detectionCapture.capture).not.toHaveBeenCalled();
	});

	it('arms the cooldown from the LONGEST 429 found across several sources and characters', async () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		const multipleLimited = snapshot({
			sources: {
				bank: rateLimitedSourceCoverage(3_000),
				materials: rateLimitedSourceCoverage(9_000),
			},
			characters: {
				Zenya: rateLimitedSourceCoverage(4_000),
			},
		});
		const inner = { capture: vi.fn().mockResolvedValue(multipleLimited) };
		const gated = new RateLimitedStorageSnapshotService(inner as never, coordinator);

		await expect(gated.capture()).resolves.toEqual(multipleLimited);
		expect(coordinator.status()).toMatchObject({ active: true, remainingMs: 9_000 });
	});

	it('does not double-record when the same 429 arrives BOTH as an exception and inside coverage', async () => {
		const time = clock(0);
		const coordinator = new RateLimitCoordinator({ now: time.now });
		const thrown = new HttpTransportError('http', 429, 5_000, 'Limited.');
		const inner = { capture: vi.fn().mockRejectedValue(thrown) };
		const gated = new RateLimitedStorageSnapshotService(inner as never, coordinator);

		await expect(gated.capture()).rejects.toMatchObject({ status: 429, retryAfterMs: 5_000 });
		// Only the thrown 429 is observed; coverage scanning never runs on a rejected capture.
		expect(coordinator.status()).toMatchObject({ active: true, remainingMs: 5_000 });

		// A longer 429 that arrives entirely inside a later, RESOLVED coverage still wins.
		const longerFromCoverage = snapshot({ sources: { bank: rateLimitedSourceCoverage(20_000) } });
		inner.capture.mockResolvedValue(longerFromCoverage);
		time.advance(5_000);
		await expect(gated.capture()).resolves.toEqual(longerFromCoverage);
		expect(coordinator.status()).toMatchObject({ active: true, remainingMs: 20_000 });
	});
});
