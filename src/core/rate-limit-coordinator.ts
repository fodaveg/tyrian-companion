export interface RateLimitCoordinatorOptions {
	now?: () => number;
	/** Cooldown used when a 429 arrives without a usable `Retry-After`. */
	fallbackCooldownMs?: number;
}

export type RateLimitStatus =
	| { active: false }
	| { active: true; retryAt: number; remainingMs: number };

const DEFAULT_FALLBACK_COOLDOWN_MS = 60_000;

/**
 * Shared, source-agnostic 429 cooldown. Pure aside from the injected clock: any caller can
 * register a rate limit and any caller can ask how long remains before a request is safe.
 * It never retries or performs I/O; per-request retries stay owned by the HTTP transport.
 */
export class RateLimitCoordinator {
	private readonly now: () => number;
	private readonly fallbackCooldownMs: number;
	private retryAt: number | null = null;

	constructor(options: RateLimitCoordinatorOptions = {}) {
		this.now = options.now ?? Date.now;
		this.fallbackCooldownMs = positiveInteger(
			options.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS,
			'fallbackCooldownMs',
		);
	}

	/**
	 * Registers a 429 observed by any caller. A missing or non-positive `Retry-After`
	 * falls back to a bounded delay. Never shortens a cooldown already in effect.
	 */
	recordRateLimited(retryAfterMs: number | null): void {
		const delay = normalizedDelay(retryAfterMs) ?? this.fallbackCooldownMs;
		const candidate = this.now() + delay;
		this.retryAt = this.retryAt === null ? candidate : Math.max(this.retryAt, candidate);
	}

	/** How long remains before a new request is safe to attempt. */
	status(): RateLimitStatus {
		if (this.retryAt === null) return { active: false };
		const remainingMs = this.retryAt - this.now();
		if (remainingMs <= 0) return { active: false };
		return { active: true, retryAt: this.retryAt, remainingMs };
	}
}

function normalizedDelay(value: number | null): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
	return value;
}
