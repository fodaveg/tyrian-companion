import { describe, expect, it } from 'vitest';

import { HttpTransportError, ResilientHttpTransport, type HttpRequest, type HttpResponse, type HttpTransport } from '../core/http';
import { PRICE_SEED_MAX_RESPONSE_BYTES, PRICE_SEED_OPERATION_POLICIES, fetchPriceSeed } from './price-seed-source';

/**
 * The measured size of the real `v2` answer restricted to `PRICE_SEED_FIELDS`:
 * 688,848 bytes for 4.962 daily records of item 36038 on 2026-09-04.
 *
 * It is a floor, not a constant: the series gains a record a day, some 139
 * bytes, so it grows about 51 kB a year and never shrinks. That is why the
 * assertion below is a ratio and not an equality.
 */
const REAL_RESPONSE_BYTES = 688_000;

const NOW_MS = Date.UTC(2026, 8, 3);

describe('price seed response size cap', () => {
	it('declares the cap on the request instead of hoping the host is polite', async () => {
		const sent: HttpRequest[] = [];
		const transport = respondWith(sent, { status: 200, headers: {}, body: [] });

		await fetchPriceSeed(36_038, { transport, now: () => NOW_MS });

		expect(sent).toHaveLength(1);
		expect(sent[0]?.maxResponseBytes).toBe(PRICE_SEED_MAX_RESPONSE_BYTES);
	});

	/**
	 * A cap that refused the real answer would be worse than none: it would turn
	 * the working case into "no seed" on every session and nothing would say why.
	 */
	it('leaves the real answer several times over inside the cap', () => {
		expect(PRICE_SEED_MAX_RESPONSE_BYTES).toBeGreaterThan(REAL_RESPONSE_BYTES * 3);
	});

	/**
	 * The refusal travels as the transport failure the adapter throws, so what is
	 * asserted here is that it lands on the path datawars2 failures already take
	 * rather than escaping into the activation that called this.
	 */
	it('answers an oversized body with no seed, like any other bad answer', async () => {
		const transport: HttpTransport = {
			send: async () => {
				throw new HttpTransportError(
					'network', null, null,
					`Response body of ${String(PRICE_SEED_MAX_RESPONSE_BYTES + 1)} bytes exceeds the ${String(PRICE_SEED_MAX_RESPONSE_BYTES)} byte cap declared for this request.`,
				);
			},
		};

		await expect(fetchPriceSeed(36_038, { transport, now: () => NOW_MS }))
			.resolves.toEqual({ status: 'no_seed', reason: 'unreachable' });
	});
});

/**
 * Every seed download takes its turn in one queue, so a download that slept through a
 * `Retry-After` would hold the panel, the note blocks and the passes behind it for as long as
 * the host said. With `PRICE_SEED_OPERATION_POLICIES` the transport asks once: a 429 or a 5xx is
 * "no seed" this time, and the request lasts no longer than its timeout.
 */
describe('price seed download policy: one attempt, never a retry', () => {
	function retryingTransport(status: number, headers: Record<string, string>) {
		const requests: string[] = [];
		const sleeps: number[] = [];
		const transport = new ResilientHttpTransport({
			operationPolicies: PRICE_SEED_OPERATION_POLICIES,
			request: async (request) => { requests.push(request.url); return { status, headers, json: null }; },
			sleep: async (milliseconds) => { sleeps.push(milliseconds); },
			now: () => NOW_MS,
			random: () => 0,
			scheduleTimeout: () => 0,
			cancelTimeout: () => undefined,
		});
		return { transport, requests, sleeps };
	}

	it.each([
		['a 429 with Retry-After: 3600', 429, { 'Retry-After': '3600' }],
		['a 503 with no Retry-After', 503, {}],
	] as const)('%s is asked for once and answered "no seed" without sleeping', async (_name, status, headers) => {
		const { transport, requests, sleeps } = retryingTransport(status, { ...headers });

		const result = await fetchPriceSeed(36_038, { transport, now: () => NOW_MS });

		expect(result).toEqual({ status: 'no_seed', reason: 'unreachable' });
		expect(requests).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	it.each([
		[408, 'unreachable'], [425, 'unreachable'], [429, 'unreachable'], [500, 'unreachable'], [503, 'unreachable'], [520, 'unreachable'],
		[400, 'unavailable'], [403, 'unavailable'], [404, 'unavailable'], [410, 'unavailable'],
	] as const)('Z13: status %i is answered "no seed" for the reason %s', async (status, reason) => {
		const { transport } = retryingTransport(status, {});
		expect(await fetchPriceSeed(36_038, { transport, now: () => NOW_MS })).toEqual({ status: 'no_seed', reason });
	});

	it('names the seed endpoint and nothing else, so no ArenaNet route loses its retries', () => {
		expect(PRICE_SEED_OPERATION_POLICIES).toEqual({ price_history_seed: { maxRetries: 0 } });
	});
});

function respondWith(sent: HttpRequest[], response: HttpResponse): HttpTransport {
	return {
		send: async (request) => {
			sent.push(request);
			return await Promise.resolve(response);
		},
	};
}
