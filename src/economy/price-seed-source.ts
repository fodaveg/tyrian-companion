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

import { HttpTransportError, type HttpOperationPolicies, type HttpTransport } from '../core/http';
import type { ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import {
	parseDatawars2History,
	PRICE_SEED_BASE_URL,
	PRICE_SEED_FIELDS,
	PRICE_SEED_MAX_DAYS,
	type PriceSeedResult,
} from './price-seed-model';

/**
 * Bytes of response body the plugin agrees to decode from this one host.
 *
 * The request's deadline is not set here: `HostRequestTransport` (`src/core/http.ts`) applies
 * its `timeoutMs`, 10_000 ms by default, and that deadline does not bound the size: it abandons
 * the promise without cancelling the transfer, so a host that answers slowly AND hugely is
 * answered by neither. This is the bound that is enforced, and the transport applies it
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

/**
 * One attempt per download, never a retry (1 oct 2026, task 0812d53e). The transport's default
 * is two retries, each after the host's own `Retry-After`, which has no ceiling. Every seed
 * download of the plugin takes its turn in ONE queue, so a download sleeping through that wait
 * would hold the panel, the note blocks and the passes behind it for as long as the host said.
 * With this a 429 or a 5xx is "no seed" on this occasion (the answer `fetchPriceSeed` already
 * gives to any status outside 2xx), and a request lasts at most the transport's timeout. The
 * timeout is left as the transport has it. Whoever builds the transport the seed rides declares
 * this next to its other operation policies.
 */
export const PRICE_SEED_OPERATION_POLICIES = Object.freeze({
	price_history_seed: Object.freeze({ maxRetries: 0 }),
}) satisfies HttpOperationPolicies;

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
		if (response.status < 200 || response.status >= 300) return { status: 'no_seed', reason: reasonForStatus(response.status) };
		body = response.body;
	} catch (error) {
		// The transport throws the non-2xx statuses it will not retry, carrying the status.
		if (error instanceof HttpTransportError && error.kind === 'http' && error.status !== null) {
			return { status: 'no_seed', reason: reasonForStatus(error.status) };
		}
		// Every throw is caught, not just `HttpTransportError`: a bug inside the
		// transport must not be able to fail activation for a service the plugin
		// does not depend on. "No seed" is a working state.
		return { status: 'no_seed', reason: 'unreachable' };
	}
	return parseDatawars2History(body, itemId, retrievedAt, options.maxDays ?? PRICE_SEED_MAX_DAYS);
}

/**
 * Z13 (9 oct 2026): which statuses mean "the host could not answer now" and which mean "the host
 * answered that there is nothing". Only the first are `unreachable` (no negative marker, they count
 * towards the pass's cut-off); any other non-2xx (404, 400, 403, 410...) is `unavailable`, which
 * does get the 24 h marker so an item without history does not crowd out its neighbours (H18.17).
 */
function reasonForStatus(status: number): 'unreachable' | 'unavailable' {
	return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599) ? 'unreachable' : 'unavailable';
}

function isoNow(now: () => number): string | null {
	try {
		const value = now();
		if (!Number.isSafeInteger(value) || value < 0) return null;
		return new Date(value).toISOString();
	} catch { return null; }
}
