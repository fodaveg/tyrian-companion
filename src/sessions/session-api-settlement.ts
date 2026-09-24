/**
 * Grace window between «the player asked to stop» and «the final snapshot is captured».
 *
 * Guild Wars 2 does not serve account data live: the map server persists the character
 * periodically and an HTTP cache sits on top of that. Lawton Campbell, API developer at
 * ArenaNet, described the pair as «the cache time is 5-10 minutes (nested caches)», and the
 * public commerce endpoints still advertise the same order of magnitude today
 * (`/v2/commerce/prices` serves `max-age=120`, `/v2/commerce/listings` serves `max-age=1200`).
 *
 * Capturing the final snapshot the instant the button is pressed therefore misses the loot of
 * the last minutes and makes every session under-count. The window below is the documented
 * ceiling, not an average: waiting less is a measurable bias, waiting more only costs patience.
 */
export const API_SETTLEMENT_WINDOW_MS = 10 * 60 * 1_000;

/**
 * The authenticated endpoints the final snapshot reads (`storage-snapshot-service.ts`). The wait
 * only has to outlast the slowest of them, so it is kept per endpoint instead of as one number.
 */
export type SettlementEndpoint =
	| 'account_inventory'
	| 'account_bank'
	| 'account_materials'
	| 'account_wallet'
	| 'character_inventory'
	| 'commerce_delivery';

export const SETTLEMENT_ENDPOINTS: readonly SettlementEndpoint[] = Object.freeze([
	'account_inventory', 'account_bank', 'account_materials', 'account_wallet', 'character_inventory', 'commerce_delivery',
]);

/**
 * H18.11: the wait per endpoint. NONE of these values is measured. The only `max-age` headers the
 * repo recorded (docs/ARCHITECTURE.md, 2026-09-01) belong to public endpoints the snapshot never
 * reads (`/v2/build`, `/v2/commerce/prices`, `/v2/commerce/listings`), and the snapshot keeps no
 * cache header of its own. Every entry therefore stays at the documented ten-minute ceiling until a
 * reading of `cache-control`/`last-modified` on that endpoint replaces it; lowering one without
 * that measurement would bring back the under-count the window exists to prevent.
 */
export const API_SETTLEMENT_WINDOW_BY_ENDPOINT_MS: Readonly<Record<SettlementEndpoint, number>> = Object.freeze({
	account_inventory: API_SETTLEMENT_WINDOW_MS,
	account_bank: API_SETTLEMENT_WINDOW_MS,
	account_materials: API_SETTLEMENT_WINDOW_MS,
	account_wallet: API_SETTLEMENT_WINDOW_MS,
	character_inventory: API_SETTLEMENT_WINDOW_MS,
	commerce_delivery: API_SETTLEMENT_WINDOW_MS,
});

/**
 * The wait a final capture needs: the slowest endpoint it reads. An override that is not a
 * non-negative safe integer is ignored and that endpoint keeps its default, so a bad setting can
 * never shorten the wait by accident.
 */
export function settlementWindowMs(
	overrides: Partial<Record<SettlementEndpoint, number>> = {},
): number {
	let windowMs = 0;
	for (const endpoint of SETTLEMENT_ENDPOINTS) {
		const override = overrides[endpoint];
		const value = typeof override === 'number' && Number.isSafeInteger(override) && override >= 0
			? override : API_SETTLEMENT_WINDOW_BY_ENDPOINT_MS[endpoint];
		windowMs = Math.max(windowMs, value);
	}
	return windowMs;
}

/**
 * Upper bound of the same wait. Past this point a later snapshot is no longer «the same session
 * settling»: an hour after the stop request any further change is far more likely to be new
 * play than cache lag, so the capture still happens — losing the session would be worse — but
 * the measurement is declared degraded instead of exact.
 */
export const API_SETTLEMENT_STALE_AFTER_MS = 60 * 60 * 1_000;

/** Cadence of the countdown. One second is what the Companion already repaints while stopping. */
export const API_SETTLEMENT_TICK_MS = 1_000;

/** How the final snapshot relates to the documented grace window. */
export type SessionApiSettlement = 'settled' | 'skipped' | 'exceeded';

export const SESSION_API_SETTLEMENTS: readonly SessionApiSettlement[] = ['settled', 'skipped', 'exceeded'];

export interface SessionSettlementWait {
	status: 'waiting' | 'due';
	/** Configured window, so the UI never has to hardcode the number again. */
	windowMs: number;
	waitedMs: number;
	remainingMs: number;
	/** Epoch milliseconds at which the capture becomes due. */
	dueAt: number;
}

/**
 * Projects the wait for a session that already requested its stop. Returns `null` only when the
 * timestamp is unusable, so a corrupt state can never be read as «already due».
 */
export function settlementWait(
	stopRequestedAt: string,
	now: number,
	windowMs: number = API_SETTLEMENT_WINDOW_MS,
): SessionSettlementWait | null {
	const requestedAt = Date.parse(stopRequestedAt);
	if (!Number.isFinite(requestedAt) || !Number.isFinite(now) || !Number.isSafeInteger(windowMs) || windowMs < 0) {
		return null;
	}
	// A clock that jumped backwards must not shorten the wait, so the elapsed time never goes negative.
	const waitedMs = Math.max(0, now - requestedAt);
	const remainingMs = Math.max(0, windowMs - waitedMs);
	return {
		status: remainingMs === 0 ? 'due' : 'waiting',
		windowMs,
		waitedMs,
		remainingMs,
		dueAt: requestedAt + windowMs,
	};
}

/**
 * Declares how a captured snapshot relates to the window. `capturedAt` is the instant the
 * capture *started* reading the account, because that is what decides which data it could see.
 */
export function captureSettlement(
	stopRequestedAt: string,
	capturedAt: string,
	windowMs: number = API_SETTLEMENT_WINDOW_MS,
	staleAfterMs: number = API_SETTLEMENT_STALE_AFTER_MS,
): SessionApiSettlement {
	const requestedAt = Date.parse(stopRequestedAt);
	const readAt = Date.parse(capturedAt);
	if (!Number.isFinite(requestedAt) || !Number.isFinite(readAt)) return 'skipped';
	const waitedMs = readAt - requestedAt;
	if (waitedMs < windowMs) return 'skipped';
	return waitedMs > staleAfterMs ? 'exceeded' : 'settled';
}

/** Human-facing countdown, floored to whole seconds so the label never shows a partial tick. */
export function settlementRemainingSeconds(wait: SessionSettlementWait): number {
	return Math.ceil(wait.remainingMs / 1_000);
}
