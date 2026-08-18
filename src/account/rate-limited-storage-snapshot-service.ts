import { HttpTransportError } from '../core/http';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { GuildWars2Operation } from './guild-wars-2-client';
import type { StorageSnapshot } from './storage-snapshot-model';
import type { StorageSnapshotService } from './storage-snapshot-service';

export type RateLimitGate = Pick<RateLimitCoordinator, 'status' | 'recordRateLimited'>;

type SnapshotCaptureOperations = Pick<
	StorageSnapshotService,
	'capture' | 'captureWithOperation' | 'captureInventoryWithOperation'
>;

/**
 * Gates the three snapshot capture entry points behind one shared cooldown. A 429 observed
 * through any wrapped instance extends the same cooldown that blocks the others; the inner
 * service's own bounded per-request retries are untouched.
 */
export class RateLimitedStorageSnapshotService implements SnapshotCaptureOperations {
	constructor(
		private readonly inner: SnapshotCaptureOperations,
		private readonly rateLimit: RateLimitGate,
	) {}

	capture(): Promise<StorageSnapshot> {
		return this.guarded(() => this.inner.capture());
	}

	captureWithOperation(operation: GuildWars2Operation): Promise<StorageSnapshot> {
		return this.guarded(() => this.inner.captureWithOperation(operation));
	}

	captureInventoryWithOperation(operation: GuildWars2Operation): Promise<StorageSnapshot> {
		return this.guarded(() => this.inner.captureInventoryWithOperation(operation));
	}

	private async guarded(run: () => Promise<StorageSnapshot>): Promise<StorageSnapshot> {
		const status = this.rateLimit.status();
		if (status.active) {
			throw new HttpTransportError(
				'http',
				429,
				status.remainingMs,
				'A shared Guild Wars 2 rate limit cooldown is active.',
			);
		}
		try {
			return await run();
		} catch (error) {
			if (error instanceof HttpTransportError && error.status === 429) {
				this.rateLimit.recordRateLimited(error.retryAfterMs);
			}
			throw error;
		}
	}
}
