import type {
	LocalDebugActionPort,
	ResolvedLocalDebugActionContext,
} from './local-debug-action-runner';

export interface RateLimitCoordinatorOptions {
	now?: () => number;
	/** Cooldown used when a 429 arrives without a usable `Retry-After`. */
	fallbackCooldownMs?: number;
	diagnostics?: LocalDebugActionPort;
}

export type RateLimitStatus =
	| { active: false }
	| { active: true; retryAt: number; remainingMs: number };

const DEFAULT_FALLBACK_COOLDOWN_MS = 60_000;

/**
 * Shared, source-agnostic 429 cooldown. Any caller can register a rate limit and any caller can
 * ask how long remains before a request is safe. It never retries; per-request retries stay owned
 * by the HTTP transport, and its optional diagnostic event is strictly fail-open.
 */
export class RateLimitCoordinator {
	private readonly now: () => number;
	private readonly fallbackCooldownMs: number;
	private readonly diagnostics: LocalDebugActionPort | undefined;
	private retryAt: number | null = null;

	constructor(options: RateLimitCoordinatorOptions = {}) {
		this.now = options.now ?? Date.now;
		this.fallbackCooldownMs = positiveInteger(
			options.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS,
			'fallbackCooldownMs',
		);
		this.diagnostics = options.diagnostics;
	}

	/**
	 * Registers a 429 observed by any caller. A missing or non-positive `Retry-After`
	 * falls back to a bounded delay. Never shortens a cooldown already in effect.
	 */
	recordRateLimited(
		retryAfterMs: number | null,
		actionContext?: ResolvedLocalDebugActionContext,
	): void {
		const delay = normalizedDelay(retryAfterMs) ?? this.fallbackCooldownMs;
		const candidate = this.now() + delay;
		this.retryAt = this.retryAt === null ? candidate : Math.max(this.retryAt, candidate);
		this.recordDiagnostic(delay, actionContext);
	}

	/** How long remains before a new request is safe to attempt. */
	status(): RateLimitStatus {
		if (this.retryAt === null) return { active: false };
		const remainingMs = this.retryAt - this.now();
		if (remainingMs <= 0) return { active: false };
		return { active: true, retryAt: this.retryAt, remainingMs };
	}

	/** Emits only the effective cooldown and reuses a provided action identity. */
	private recordDiagnostic(delay: number, parent: ResolvedLocalDebugActionContext | undefined): void {
		if (this.diagnostics === undefined) return;
		try {
			const context = this.diagnostics.createContext({
				component: 'http', action: 'http_request',
				...(parent === undefined ? {} : {
					actionId: parent.actionId,
					correlationId: parent.correlationId,
				}),
			});
			this.diagnostics.event({
				...context,
				level: 'warn', phase: 'retry', code: 'rate_limited', state: 'active',
				details: { retryAfterMs: delay },
			});
		} catch {
			// The local diagnostic port is fail-open by contract.
		}
	}
}

function normalizedDelay(value: number | null): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`);
	return value;
}
