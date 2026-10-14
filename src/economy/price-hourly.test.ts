import { describe, expect, it } from 'vitest';

import type { HttpRequest, HttpResponse, HttpTransport } from '../core/http';
import { HttpTransportError } from '../core/http';
import { parseDatawars2Hourly } from './price-hourly-model';
import { PRICE_HOURLY_CACHE_TTL_MS, PriceHourlyService } from './price-hourly-source';

/** Real answer, trimmed to its last 12 records: `v2/history/hourly/json?itemID=36038&fields=date,sell_price_min`, 14 oct 2026. */
const REAL_TAIL = [
	{ date: '2026-10-13T17:00:00Z', sell_price_min: 316 }, { date: '2026-10-13T18:00:00Z', sell_price_min: 310 },
	{ date: '2026-10-13T19:00:00Z', sell_price_min: 323 }, { date: '2026-10-13T20:00:00Z', sell_price_min: 349 },
	{ date: '2026-10-13T21:00:00Z', sell_price_min: 338 }, { date: '2026-10-13T22:00:00Z', sell_price_min: 346 },
	{ date: '2026-10-13T23:00:00Z', sell_price_min: 307 }, { date: '2026-10-14T00:00:00Z', sell_price_min: 318 },
	{ date: '2026-10-14T01:00:00Z', sell_price_min: 313 }, { date: '2026-10-14T02:00:00Z', sell_price_min: 348 },
	{ date: '2026-10-14T03:00:00Z', sell_price_min: 318 }, { date: '2026-10-14T04:00:00Z', sell_price_min: 323 },
];

describe('parseDatawars2Hourly', () => {
	it('reads the real answer: one ascending point per UTC hour with the lowest sell offer', () => {
		const result = parseDatawars2Hourly(REAL_TAIL);
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result.points).toHaveLength(12);
		expect(result.points[0]).toEqual({ hourUtc: '2026-10-13T17:00:00.000Z', askCopper: 316 });
		expect(result.points.at(-1)).toEqual({ hourUtc: '2026-10-14T04:00:00.000Z', askCopper: 323 });
	});

	it('keeps only the newest hours, drops unreadable records and never bridges a gap', () => {
		const messy = [
			{ date: '2026-10-14T04:00:00Z', sell_price_min: 5 }, null, 'x', { date: 'nope', sell_price_min: 1 },
			{ date: '2026-10-14T01:00:00Z', sell_price_min: null }, { date: '2026-10-14T02:00:00Z', sell_price_min: 0 },
			{ date: '2026-10-14T00:00:00Z', sell_price_min: 9 },
		];
		expect(parseDatawars2Hourly(messy, 2)).toEqual({ status: 'ok', points: [
			{ hourUtc: '2026-10-14T00:00:00.000Z', askCopper: 9 }, { hourUtc: '2026-10-14T04:00:00.000Z', askCopper: 5 },
		] });
	});

	it('declares malformed and empty answers instead of throwing', () => {
		expect(parseDatawars2Hourly({ a: 1 })).toEqual({ status: 'no_data', reason: 'malformed' });
		expect(parseDatawars2Hourly([])).toEqual({ status: 'no_data', reason: 'empty' });
	});
});

describe('PriceHourlyService', () => {
	it('sends nothing while the price history is off, however often it is asked', async () => {
		const sent: HttpRequest[] = [];
		const service = new PriceHourlyService({ transport: transport(sent, { status: 200, headers: {}, body: REAL_TAIL }), now: () => 0, isEnabled: () => false });
		await service.ensure(36_038);
		await service.ensure(36_038);
		expect(sent).toHaveLength(0);
		expect(service.getState(36_038).status).toBe('idle');
	});

	it('asks only on ensure, through the closed endpoint, and serves the cache until the TTL passes', async () => {
		const sent: HttpRequest[] = [];
		let now = 1_000;
		const service = new PriceHourlyService({ transport: transport(sent, { status: 200, headers: {}, body: REAL_TAIL }), now: () => now, isEnabled: () => true });
		expect(sent).toHaveLength(0);
		const first = service.ensure(36_038);
		expect(service.getState(36_038).status).toBe('loading');
		await Promise.all([first, service.ensure(36_038)]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ endpoint: 'price_history_hourly', method: 'GET' });
		expect(sent[0]!.url).toBe('https://api.datawars2.ie/gw2/v2/history/hourly/json?itemID=36038&fields=date,sell_price_min');
		expect(service.getState(36_038).status).toBe('ready');
		await service.ensure(36_038);
		expect(sent).toHaveLength(1);
		now += PRICE_HOURLY_CACHE_TTL_MS;
		await service.ensure(36_038);
		expect(sent).toHaveLength(2);
	});

	it('remembers a failure as failed but asks again on the next click', async () => {
		const sent: HttpRequest[] = [];
		const failing = {
			send: (request: HttpRequest) => { sent.push(request); return Promise.reject(new HttpTransportError('http', 429, null, 'boom')); },
		} as unknown as HttpTransport;
		const service = new PriceHourlyService({ transport: failing, now: () => 0, isEnabled: () => true });
		await service.ensure(1);
		expect(service.getState(1).status).toBe('failed');
		await service.ensure(1);
		expect(sent).toHaveLength(2);
	});
});

function transport(sent: HttpRequest[], response: HttpResponse): HttpTransport {
	return { send: (request: HttpRequest) => { sent.push(request); return Promise.resolve(response); } };
}
