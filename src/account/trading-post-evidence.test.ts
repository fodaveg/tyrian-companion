import { describe, expect, it, vi } from 'vitest';

import type { GuildWars2Operation } from './guild-wars-2-client';
import {
	captureActiveTradingPostOrders,
	isActiveTradingPostOrdersEvidence,
	isTradingPostHistoryEvidence,
	TradingPostHistoryEvidenceService,
} from './trading-post-evidence';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');
const WINDOW = { from: '2026-08-29T10:00:00.000Z', to: '2026-08-29T11:00:00.000Z' };

describe('trading post evidence', () => {
	it('captures current buys and sells without retaining raw transaction identifiers', async () => {
		const requestDetailed = vi.fn(async (path: string) => response([
			transaction(path.includes('/buys'), path.includes('/buys') ? 10 : 11, 2),
		]));
		const evidence = await captureActiveTradingPostOrders(operation(requestDetailed), 'account-1', token(), () => NOW);

		expect(evidence).toEqual({
			version: 1,
			accountId: 'account-1',
			capturedAt: '2026-08-29T12:00:00.000Z',
			status: 'complete',
			endpointCoverage: {
				buy: { status: 'complete', capturedAt: '2026-08-29T12:00:00.000Z', reason: null },
				sell: { status: 'complete', capturedAt: '2026-08-29T12:00:00.000Z', reason: null },
			},
			orders: [
				{ side: 'buy', itemId: 10, quantity: 2 },
				{ side: 'sell', itemId: 11, quantity: 2 },
			],
		});
		expect(isActiveTradingPostOrdersEvidence(evidence)).toBe(true);
		expect(JSON.stringify(evidence)).not.toMatch(/transaction|"id"|created/u);
		expect(requestDetailed.mock.calls.map(([path]) => path)).toEqual([
			expect.stringContaining('commerce/transactions/current/buys?page=0&page_size=200'),
			expect.stringContaining('commerce/transactions/current/sells?page=0&page_size=200'),
		]);
	});

	it('reports missing tradingpost scope and URL restrictions without requesting either endpoint', async () => {
		const missingRequest = vi.fn();
		const missing = await captureActiveTradingPostOrders(operation(missingRequest), 'account-1', token({
			permissions: ['account'],
		}), () => NOW);
		expect(missing).toMatchObject({ status: 'unavailable', endpointCoverage: {
			buy: { status: 'missing_scope', reason: 'missing_scope' },
			sell: { status: 'missing_scope', reason: 'missing_scope' },
		} });
		expect(missingRequest).not.toHaveBeenCalled();

		const restrictedRequest = vi.fn(async () => response([]));
		const restricted = await captureActiveTradingPostOrders(operation(restrictedRequest), 'account-1', token({
			urls: ['/v2/commerce/transactions/current/buys'],
		}), () => NOW);
		expect(restricted).toMatchObject({ status: 'partial', endpointCoverage: {
			buy: { status: 'complete' },
			sell: { status: 'url_restricted', reason: 'url_restricted' },
		} });
		expect(restrictedRequest).toHaveBeenCalledOnce();
	});

	it('marks HTTP partials and request failures explicitly instead of treating them as empty orders', async () => {
		const requestDetailed = vi.fn(async (path: string) => path.includes('/buys')
			? { status: 206, headers: {}, body: [transaction(true, 10, 1)] }
			: Promise.reject(new Error('offline')));
		const evidence = await captureActiveTradingPostOrders(operation(requestDetailed), 'account-1', token(), () => NOW);

		expect(evidence).toMatchObject({ status: 'partial', orders: [], endpointCoverage: {
			buy: { status: 'partial', reason: 'partial_response' },
			sell: { status: 'unavailable', reason: 'request_failed' },
		} });
	});

	it('caps pagination at ten pages and exposes truncation instead of silently claiming completeness', async () => {
		const requestDetailed = vi.fn(async (path: string) => response(
			Array.from({ length: 200 }, (_, index) => transaction(path.includes('/buys'), page(path) * 200 + index + 1, 1)),
			{ 'X-Page-Total': '11' },
		));
		const evidence = await captureActiveTradingPostOrders(operation(requestDetailed), 'account-1', token(), () => NOW);

		expect(evidence.status).toBe('partial');
		expect(evidence.endpointCoverage).toEqual({
			buy: { status: 'partial', capturedAt: null, reason: 'page_limit' },
			sell: { status: 'partial', capturedAt: null, reason: 'page_limit' },
		});
		expect(requestDetailed).toHaveBeenCalledTimes(20);
	});

	it('captures complete in-window history as a proposal-safe projection', async () => {
		const requestDetailed = vi.fn(async (path: string) => {
			if (path === 'tokeninfo') return response(token());
			if (path === 'account') return response(account());
			if (path.includes('/history/buys')) return response([
				transaction(true, 10, 2, '2026-08-29T10:30:00.000Z'),
				transaction(true, 12, 1, '2026-08-29T09:30:00.000Z'),
			]);
			return response([transaction(false, 11, 3, '2026-08-29T10:45:00.000Z')]);
		});
		const service = new TradingPostHistoryEvidenceService(client(requestDetailed), () => NOW);
		const evidence = await service.capture('account-1', WINDOW);

		expect(evidence).toMatchObject({
			status: 'complete',
			events: [
				{ kind: 'buy', itemId: 10, quantity: 2, coins: 200, occurredAt: '2026-08-29T10:30:00.000Z' },
				{ kind: 'sell', itemId: 11, quantity: 3, coins: 300, occurredAt: '2026-08-29T10:45:00.000Z' },
			],
		});
		expect(isTradingPostHistoryEvidence(evidence)).toBe(true);
		expect(JSON.stringify(evidence)).not.toMatch(/"id"|created/u);
	});

	it('fails closed on truncated history and keeps account identity exact', async () => {
		const requestDetailed = vi.fn(async (path: string) => {
			if (path === 'tokeninfo') return response(token());
			if (path === 'account') return response(account());
			return response(Array.from({ length: 200 }, (_, index) => transaction(
				path.includes('/buys'), page(path) * 200 + index + 1, 1, '2026-08-29T10:30:00.000Z',
			)), { 'x-page-total': '11' });
		});
		const service = new TradingPostHistoryEvidenceService(client(requestDetailed), () => NOW);
		const evidence = await service.capture('account-1', WINDOW);

		expect(evidence).toMatchObject({ status: 'partial', endpointCoverage: {
			buy: { status: 'partial', reason: 'page_limit' },
			sell: { status: 'partial', reason: 'page_limit' },
		} });
		expect((await service.capture('other-account', WINDOW)).status).toBe('invalid');
	});
});

function operation(requestDetailed: (path: string) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>): GuildWars2Operation {
	return { request: async (path) => (await requestDetailed(path)).body, requestDetailed };
}
function client(requestDetailed: (path: string) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>) {
	return { beginOperation: () => operation(requestDetailed) };
}
function response(body: unknown, headers: Record<string, string> = {}) {
	return { status: 200, headers, body };
}
function token(overrides: { permissions?: string[]; urls?: string[] } = {}) {
	return { id: 'token-secret-id', name: 'test', permissions: overrides.permissions ?? ['account', 'tradingpost'],
		...(overrides.urls === undefined ? {} : { urls: overrides.urls }) };
}
function account() {
	return { id: 'account-1', name: 'Account.1234', world: 1, created: '2020-01-01T00:00:00.000Z', access: ['GuildWars2'], commander: false };
}
function transaction(buy: boolean, itemId: number, quantity: number, purchased?: string) {
	return { id: (buy ? 1_000_000 : 2_000_000) + itemId, item_id: itemId, price: 100, quantity,
		created: '2026-08-29T09:00:00.000Z', ...(purchased === undefined ? {} : { purchased }) };
}
function page(path: string): number { return Number(new URLSearchParams(path.split('?')[1]).get('page')); }
