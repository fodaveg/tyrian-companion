import { PINNED_SCHEMA } from './storage-snapshot-model';
import { allowsEndpoint } from './storage-snapshot-service';
import { parseAccountProfile, parseTokenInfo, type TokenInfo } from './account-service';
import { MissingApiKeyError, type GuildWars2Operation } from './guild-wars-2-client';
import type { TradingPostEvent } from './contamination-model';

export const TRADING_POST_EVIDENCE_VERSION = 1 as const;

const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const HISTORY_HORIZON_MS = 90 * 86_400_000;
const CURRENT_ENDPOINTS = {
	buy: 'commerce/transactions/current/buys',
	sell: 'commerce/transactions/current/sells',
} as const;
const HISTORY_ENDPOINTS = {
	buy: 'commerce/transactions/history/buys',
	sell: 'commerce/transactions/history/sells',
} as const;

export type TradingPostEvidenceSide = keyof typeof CURRENT_ENDPOINTS;
export type TradingPostEndpointStatus =
	| 'complete'
	| 'partial'
	| 'missing_scope'
	| 'url_restricted'
	| 'unavailable'
	| 'invalid';

export interface TradingPostEndpointCoverageV1 {
	status: TradingPostEndpointStatus;
	capturedAt: string | null;
	reason: 'page_limit' | 'partial_response' | 'missing_scope' | 'url_restricted'
		| 'request_failed' | 'invalid_payload' | null;
}

export interface ActiveTradingPostOrderV1 {
	side: TradingPostEvidenceSide;
	itemId: number;
	quantity: number;
}

/** Identity-bound current-order evidence. Raw transaction IDs never leave capture. */
export interface ActiveTradingPostOrdersEvidenceV1 {
	version: typeof TRADING_POST_EVIDENCE_VERSION;
	accountId: string;
	capturedAt: string;
	status: 'complete' | 'partial' | 'unavailable';
	endpointCoverage: Record<TradingPostEvidenceSide, TradingPostEndpointCoverageV1>;
	orders: ActiveTradingPostOrderV1[];
}

/** Bounded 90-day history projection. It contains no transaction or API-key identifier. */
export interface TradingPostHistoryEvidenceV1 {
	version: typeof TRADING_POST_EVIDENCE_VERSION;
	accountId: string;
	capturedAt: string;
	window: { from: string; to: string };
	status: 'complete' | 'partial' | 'unavailable' | 'invalid';
	endpointCoverage: Record<TradingPostEvidenceSide, TradingPostEndpointCoverageV1>;
	events: TradingPostEvent[];
}

export interface TradingPostHistoryEvidenceClient {
	beginOperation(): GuildWars2Operation;
}

export function isActiveTradingPostOrdersEvidence(
	value: unknown,
): value is ActiveTradingPostOrdersEvidenceV1 {
	if (!record(value) || !exactKeys(value, [
		'version', 'accountId', 'capturedAt', 'status', 'endpointCoverage', 'orders',
	]) || value.version !== TRADING_POST_EVIDENCE_VERSION || !text(value.accountId)
		|| !strictIso(value.capturedAt) || !['complete', 'partial', 'unavailable'].includes(String(value.status))
		|| !endpointCoverage(value.endpointCoverage) || !Array.isArray(value.orders)
		|| !value.orders.every(activeOrder)) return false;
	const typed = value as unknown as ActiveTradingPostOrdersEvidenceV1;
	return typed.status === aggregateStatus(typed.endpointCoverage.buy, typed.endpointCoverage.sell)
		&& sorted(typed.orders, (left, right) => left.itemId - right.itemId
			|| left.side.localeCompare(right.side))
		&& new Set(typed.orders.map((order) => `${order.side}:${order.itemId}`)).size === typed.orders.length
		&& typed.orders.every((order) => typed.endpointCoverage[order.side].status === 'complete'
			|| typed.endpointCoverage[order.side].status === 'partial');
}

export function isTradingPostHistoryEvidence(value: unknown): value is TradingPostHistoryEvidenceV1 {
	if (!record(value) || !exactKeys(value, [
		'version', 'accountId', 'capturedAt', 'window', 'status', 'endpointCoverage', 'events',
	]) || value.version !== TRADING_POST_EVIDENCE_VERSION || !text(value.accountId)
		|| !strictIso(value.capturedAt) || !['complete', 'partial', 'unavailable', 'invalid'].includes(String(value.status))
		|| !record(value.window) || !exactKeys(value.window, ['from', 'to'])
		|| !validWindow(value.window as unknown as { from: string; to: string })
		|| !endpointCoverage(value.endpointCoverage) || !Array.isArray(value.events)
		|| !value.events.every(historyEvent)) return false;
	const typed = value as unknown as TradingPostHistoryEvidenceV1;
	if (!recoverableWindow(typed.window, typed.capturedAt)) return false;
	if (typed.status !== 'invalid'
		&& typed.status !== aggregateStatus(typed.endpointCoverage.buy, typed.endpointCoverage.sell)) return false;
	return sorted(typed.events, (left, right) => left.occurredAt.localeCompare(right.occurredAt)
		|| left.kind.localeCompare(right.kind) || left.itemId - right.itemId)
		&& typed.events.every((event) => Date.parse(event.occurredAt) >= Date.parse(typed.window.from)
			&& Date.parse(event.occurredAt) <= Date.parse(typed.window.to));
}

/** Reads only the two current-order endpoints over an already pinned operation. */
export async function captureActiveTradingPostOrders(
	operation: GuildWars2Operation,
	accountId: string,
	token: TokenInfo,
	now: () => number = Date.now,
): Promise<ActiveTradingPostOrdersEvidenceV1> {
	const capturedAt = new Date(now()).toISOString();
	const [buys, sells] = await Promise.all([
		capturePages(operation, token, CURRENT_ENDPOINTS.buy, 'buy', false, capturedAt),
		capturePages(operation, token, CURRENT_ENDPOINTS.sell, 'sell', false, capturedAt),
	]);
	return {
		version: TRADING_POST_EVIDENCE_VERSION,
		accountId,
		capturedAt,
		status: aggregateStatus(buys.coverage, sells.coverage),
		endpointCoverage: { buy: buys.coverage, sell: sells.coverage },
		orders: aggregateOrders([...buys.transactions, ...sells.transactions]),
	};
}

/**
 * Captures a bounded historical window for one already-known account. The service
 * has no persistence port, so vault separation remains at its caller/service instance.
 */
export class TradingPostHistoryEvidenceService {
	constructor(
		private readonly client: TradingPostHistoryEvidenceClient,
		private readonly now: () => number = Date.now,
	) {}

	async capture(
		expectedAccountId: string,
		window: { from: string; to: string },
	): Promise<TradingPostHistoryEvidenceV1> {
		const capturedAt = new Date(this.now()).toISOString();
		if (!text(expectedAccountId) || !recoverableWindow(window, capturedAt)) {
			return historyFailure(expectedAccountId, window, capturedAt, 'invalid');
		}
		let operation: GuildWars2Operation;
		try { operation = this.client.beginOperation(); }
		catch (error) {
			return historyFailure(expectedAccountId, window, capturedAt,
				error instanceof MissingApiKeyError ? 'unavailable' : 'unavailable');
		}
		let token: TokenInfo;
		try {
			const [tokenBody, accountBody] = await Promise.all([
				requestBody(operation, 'tokeninfo'),
				requestBody(operation, 'account'),
			]);
			token = parseTokenInfo(tokenBody);
			if (parseAccountProfile(accountBody).id !== expectedAccountId) {
				return historyFailure(expectedAccountId, window, capturedAt, 'invalid');
			}
		} catch {
			return historyFailure(expectedAccountId, window, capturedAt, 'unavailable');
		}
		const [buys, sells] = await Promise.all([
			capturePages(operation, token, HISTORY_ENDPOINTS.buy, 'buy', true, capturedAt),
			capturePages(operation, token, HISTORY_ENDPOINTS.sell, 'sell', true, capturedAt),
		]);
		const status = aggregateStatus(buys.coverage, sells.coverage);
		return {
			version: TRADING_POST_EVIDENCE_VERSION,
			accountId: expectedAccountId,
			capturedAt,
			window: structuredClone(window),
			status,
			endpointCoverage: { buy: buys.coverage, sell: sells.coverage },
			events: historyEvents([...buys.transactions, ...sells.transactions], window),
		};
	}
}

interface CapturedTransaction {
	id: number;
	side: TradingPostEvidenceSide;
	itemId: number;
	price: number;
	quantity: number;
	createdAt: string;
	purchasedAt: string | null;
}

async function capturePages(
	operation: GuildWars2Operation,
	token: TokenInfo,
	endpoint: string,
	side: TradingPostEvidenceSide,
	history: boolean,
	capturedAt: string,
): Promise<{ coverage: TradingPostEndpointCoverageV1; transactions: CapturedTransaction[] }> {
	const permission = endpointPermission(token, endpoint);
	if (permission !== null) return { coverage: permission, transactions: [] };
	const transactions: CapturedTransaction[] = [];
	const seenIds = new Set<number>();
	for (let page = 0; page < MAX_PAGES; page += 1) {
		let response;
		try {
			response = await operation.requestDetailed(
				`${endpoint}?page=${page}&page_size=${PAGE_SIZE}&v=${encodeURIComponent(PINNED_SCHEMA)}`,
			);
		} catch {
			return { coverage: evidence('unavailable', null, 'request_failed'), transactions };
		}
		if (response.status === 206) {
			return { coverage: evidence('partial', null, 'partial_response'), transactions };
		}
		if (response.status !== 200 || !Array.isArray(response.body)) {
			return { coverage: evidence('invalid', null, 'invalid_payload'), transactions };
		}
		const parsed = response.body.map((entry) => parseTransaction(entry, side, history));
		if (parsed.some((entry) => entry === null)
			|| parsed.some((entry) => seenIds.has(entry!.id))) {
			return { coverage: evidence('invalid', null, 'invalid_payload'), transactions: [] };
		}
		for (const entry of parsed) {
			seenIds.add(entry!.id);
			transactions.push(entry!);
		}
		const pageTotal = positiveHeader(response.headers, 'x-page-total');
		if ((pageTotal !== null && page + 1 >= pageTotal) || parsed.length < PAGE_SIZE) {
			return { coverage: evidence('complete', capturedAt, null), transactions };
		}
	}
	return { coverage: evidence('partial', null, 'page_limit'), transactions };
}

function endpointPermission(token: TokenInfo, endpoint: string): TradingPostEndpointCoverageV1 | null {
	if (!token.permissions.includes('tradingpost')) {
		return evidence('missing_scope', null, 'missing_scope');
	}
	if (token.urls !== undefined && token.urls.length > 0
		&& !allowsEndpoint(token.urls, `/v2/${endpoint}`)) {
		return evidence('url_restricted', null, 'url_restricted');
	}
	return null;
}

function parseTransaction(
	value: unknown,
	side: TradingPostEvidenceSide,
	history: boolean,
): CapturedTransaction | null {
	if (!record(value) || !positive(value.id) || !positive(value.item_id)
		|| !positive(value.price) || !positive(value.quantity) || !iso(value.created)
		|| (history ? !iso(value.purchased) : value.purchased !== undefined)) return null;
	return {
		id: value.id,
		side,
		itemId: value.item_id,
		price: value.price,
		quantity: value.quantity,
		createdAt: normalizedIso(value.created),
		purchasedAt: history ? normalizedIso(value.purchased as string) : null,
	};
}

function aggregateOrders(transactions: CapturedTransaction[]): ActiveTradingPostOrderV1[] {
	const totals = new Map<string, ActiveTradingPostOrderV1>();
	for (const transaction of transactions) {
		const key = `${transaction.side}:${transaction.itemId}`;
		const previous = totals.get(key)?.quantity ?? 0;
		const quantity = previous + transaction.quantity;
		if (!Number.isSafeInteger(quantity)) continue;
		totals.set(key, { side: transaction.side, itemId: transaction.itemId, quantity });
	}
	return [...totals.values()].sort((left, right) => left.itemId - right.itemId
		|| left.side.localeCompare(right.side));
}

function historyEvents(
	transactions: CapturedTransaction[],
	window: { from: string; to: string },
): TradingPostEvent[] {
	const from = Date.parse(window.from);
	const to = Date.parse(window.to);
	const totals = new Map<string, TradingPostEvent>();
	for (const transaction of transactions) {
		if (transaction.purchasedAt === null) continue;
		const occurredAt = Date.parse(transaction.purchasedAt);
		if (occurredAt < from || occurredAt > to) continue;
		const coins = transaction.price * transaction.quantity;
		if (!Number.isSafeInteger(coins)) continue;
		const key = `${transaction.side}:${transaction.itemId}:${transaction.purchasedAt}`;
		const previous = totals.get(key);
		const quantity = (previous?.quantity ?? 0) + transaction.quantity;
		const totalCoins = (previous?.coins ?? 0) + coins;
		if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(totalCoins)) continue;
		totals.set(key, { kind: transaction.side, itemId: transaction.itemId,
			quantity, coins: totalCoins, occurredAt: transaction.purchasedAt });
	}
	return [...totals.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
		|| left.kind.localeCompare(right.kind) || left.itemId - right.itemId);
}

function aggregateStatus(
	buys: TradingPostEndpointCoverageV1,
	sells: TradingPostEndpointCoverageV1,
): 'complete' | 'partial' | 'unavailable' {
	if (buys.status === 'complete' && sells.status === 'complete') return 'complete';
	if (buys.status === 'complete' || sells.status === 'complete'
		|| buys.status === 'partial' || sells.status === 'partial') return 'partial';
	return 'unavailable';
}

function historyFailure(
	accountId: string,
	window: { from: string; to: string },
	capturedAt: string,
	status: 'unavailable' | 'invalid',
): TradingPostHistoryEvidenceV1 {
	const coverageStatus = status === 'invalid' ? 'invalid' : 'unavailable';
	const reason = status === 'invalid' ? 'invalid_payload' : 'request_failed';
	return {
		version: TRADING_POST_EVIDENCE_VERSION,
		accountId,
		capturedAt,
		window: structuredClone(window),
		status,
		endpointCoverage: {
			buy: evidence(coverageStatus, null, reason),
			sell: evidence(coverageStatus, null, reason),
		},
		events: [],
	};
}

function evidence(
	status: TradingPostEndpointStatus,
	capturedAt: string | null,
	reason: TradingPostEndpointCoverageV1['reason'],
): TradingPostEndpointCoverageV1 {
	return { status, capturedAt, reason };
}

async function requestBody(operation: GuildWars2Operation, path: string): Promise<unknown> {
	const response = await operation.requestDetailed(path);
	if (response.status !== 200) throw new Error('trading_post_context_unavailable');
	return response.body;
}

function positiveHeader(headers: Readonly<Record<string, string>>, name: string): number | null {
	const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validWindow(value: { from: string; to: string }): boolean {
	return strictIso(value.from) && strictIso(value.to) && Date.parse(value.from) <= Date.parse(value.to);
}
function recoverableWindow(value: { from: string; to: string }, capturedAt: string): boolean {
	if (!validWindow(value) || !strictIso(capturedAt)) return false;
	const from = Date.parse(value.from);
	const to = Date.parse(value.to);
	const captured = Date.parse(capturedAt);
	return to <= captured && to - from <= HISTORY_HORIZON_MS && from >= captured - HISTORY_HORIZON_MS;
}
function endpointCoverage(value: unknown): value is Record<TradingPostEvidenceSide, TradingPostEndpointCoverageV1> {
	return record(value) && exactKeys(value, ['buy', 'sell'])
		&& endpointEvidence(value.buy) && endpointEvidence(value.sell);
}
function endpointEvidence(value: unknown): value is TradingPostEndpointCoverageV1 {
	if (!record(value) || !exactKeys(value, ['status', 'capturedAt', 'reason'])
		|| !['complete', 'partial', 'missing_scope', 'url_restricted', 'unavailable', 'invalid'].includes(String(value.status))) return false;
	if (value.status === 'complete') return strictIso(value.capturedAt) && value.reason === null;
	return value.capturedAt === null && [
		'page_limit', 'partial_response', 'missing_scope', 'url_restricted', 'request_failed', 'invalid_payload',
	].includes(String(value.reason));
}
function activeOrder(value: unknown): value is ActiveTradingPostOrderV1 {
	return record(value) && exactKeys(value, ['side', 'itemId', 'quantity'])
		&& (value.side === 'buy' || value.side === 'sell') && positive(value.itemId) && positive(value.quantity);
}
function historyEvent(value: unknown): value is TradingPostEvent {
	return record(value) && exactKeys(value, ['kind', 'itemId', 'quantity', 'coins', 'occurredAt'])
		&& (value.kind === 'buy' || value.kind === 'sell') && positive(value.itemId)
		&& positive(value.quantity) && positive(value.coins) && strictIso(value.occurredAt);
}
function normalizedIso(value: string): string { return new Date(Date.parse(value)).toISOString(); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function strictIso(value: unknown): value is string { return iso(value) && new Date(Date.parse(value)).toISOString() === value; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length
		&& actual.every((key, index) => key === sortedExpected[index]);
}
function sorted<T>(values: T[], compare: (left: T, right: T) => number): boolean {
	return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}
