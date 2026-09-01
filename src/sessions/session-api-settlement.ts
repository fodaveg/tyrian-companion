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
