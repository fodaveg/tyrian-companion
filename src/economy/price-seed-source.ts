import type { HttpTransport } from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import {
	parseDatawars2History,
	PRICE_SEED_BASE_URL,
	PRICE_SEED_FIELDS,
	PRICE_SEED_MAX_DAYS,
	type PriceSeedResult,
} from './price-seed-model';

/**
 * The one outbound call that is not to ArenaNet.
 *
 * It is deliberately small and deliberately rare: a single unauthenticated GET,
 * at most once per activated session, for a series the official API does not
 * publish (`/v2/commerce/history` is a 404 and `/v2/commerce/prices/36038`
 * returns only the current quote). No account identifier, no API key and no
 * snapshot leaves through here; the request carries an item id that is a
 * public catalogue number.
 *
 * Failure is a first-class answer, never an exception. The plugin declaring
 * "no seed" and falling back to what it captured itself is a working state; a
 * throw here would take the whole activation down for a service the plugin
 * does not depend on.
 */
export const PRICE_SEED_TIMEOUT_MS = 10_000;

/**
 * Bytes of response body the plugin agrees to decode from this one host.
 *
 * The deadline above does not bound the size: it abandons the promise without
 * cancelling the transfer, so a host that answers slowly AND hugely is answered
 * by neither. This is the bound that is enforced, and the transport applies it
 * before the body is parsed at all.
 *
 * Eight mebibytes is deliberately far above the real answer and far below what
 * hurts. `price-seed-model` records the measurement this is sized against: the
 * `v2` request with `PRICE_SEED_FIELDS` answered 688,848 bytes for 4.962 daily
 * records on 2026-09-04, some 139 bytes per day, so the cap holds well over a
 * century of the same series, chart callers included: whichever `maxDays` the
 * caller passes only trims what `parseDatawars2History` keeps AFTER decoding,
 * never what this cap allows onto the wire in the first place.
 */
export const PRICE_SEED_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface PriceSeedSourceOptions {
	transport: HttpTransport;
	now: () => number;
	maxDays?: number;
	actionContext?: ResolvedLocalDebugActionContext;
}

/**
 * Downloads and trims the daily history of one item.
 *
 * The response body is handed straight to the parser rather than being kept:
 * the 2.2 MB array is alive only for the duration of this call, and what the
 * caller receives is the trimmed seed.
 *
 * How big that array is allowed to get is declared here, on the request, and a
 * body over the cap comes back as a transport failure. It needs no branch of
 * its own: "no seed" is already the answer to everything this host can do
 * wrong, and an oversized answer is one more way of answering badly.
 */
export async function fetchPriceSeed(itemId: number, options: PriceSeedSourceOptions): Promise<PriceSeedResult> {
	if (!Number.isSafeInteger(itemId) || itemId <= 0) return { status: 'no_seed', reason: 'malformed' };
	const retrievedAt = isoNow(options.now);
	if (retrievedAt === null) return { status: 'no_seed', reason: 'malformed' };
	let body: unknown;
	try {
		const response = await options.transport.send({
			url: `${PRICE_SEED_BASE_URL}?itemID=${String(itemId)}&fields=${PRICE_SEED_FIELDS}`,
			method: 'GET',
			endpoint: 'price_history_seed',
			maxResponseBytes: PRICE_SEED_MAX_RESPONSE_BYTES,
		}, options.actionContext);
		if (response.status < 200 || response.status >= 300) return { status: 'no_seed', reason: 'unreachable' };
		body = response.body;
	} catch {
		// Every throw is caught, not just `HttpTransportError`: a bug inside the
		// transport must not be able to fail activation for a service the plugin
		// does not depend on. "No seed" is a working state.
		return { status: 'no_seed', reason: 'unreachable' };
	}
	return parseDatawars2History(body, itemId, retrievedAt, options.maxDays ?? PRICE_SEED_MAX_DAYS);
}

function isoNow(now: () => number): string | null {
	try {
		const value = now();
		if (!Number.isSafeInteger(value) || value < 0) return null;
		return new Date(value).toISOString();
	} catch { return null; }
}
