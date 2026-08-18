import { HttpTransportError } from '../core/http';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';
import type { GuildWars2Operation } from './guild-wars-2-client';
import type { SnapshotCoverage, SourceCoverage, StorageSnapshot } from './storage-snapshot-model';
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
			const result = await run();
			this.recordCoverageRateLimits(result.coverage);
			return result;
		} catch (error) {
			if (error instanceof HttpTransportError && error.status === 429) {
				this.rateLimit.recordRateLimited(error.retryAfterMs);
			}
			throw error;
		}
	}

	/**
	 * A resolved capture can still carry a 429 as partial coverage on one or more sources
	 * (`captureSource` only rethrows 401/403 for required sources). Scan every source and
	 * character entry and arm the shared cooldown for each 429 found, letting the
	 * coordinator itself keep the longest cooldown across all of them.
	 */
	private recordCoverageRateLimits(coverage: SnapshotCoverage): void {
		for (const entry of Object.values(coverage.sources)) this.recordIfRateLimited(entry);
		for (const entry of Object.values(coverage.characters)) this.recordIfRateLimited(entry);
	}

	private recordIfRateLimited(entry: SourceCoverage): void {
		if (entry.diagnostic?.status === 429) this.rateLimit.recordRateLimited(entry.diagnostic.retryAfterMs);
	}
}
