import { PINNED_SCHEMA } from './storage-snapshot-model';
import { allowsEndpoint } from './storage-snapshot-service';
import type { TokenInfo } from './account-service';
import type { GuildWars2Operation } from './guild-wars-2-client';
import {
	isActiveTradingPostOrdersEvidence,
	TRADING_POST_EVIDENCE_VERSION,
	type ActiveTradingPostOrderV1,
	type ActiveTradingPostOrdersEvidenceV1,
	type TradingPostEndpointCoverageV1,
	type TradingPostEndpointStatus,
	type TradingPostEvidenceSide,
} from './trading-post-orders-model';

export { isActiveTradingPostOrdersEvidence, TRADING_POST_EVIDENCE_VERSION };
export type {
	ActiveTradingPostOrderV1,
	ActiveTradingPostOrdersEvidenceV1,
	TradingPostEndpointCoverageV1,
	TradingPostEndpointStatus,
	TradingPostEvidenceSide,
};

const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const CURRENT_ENDPOINTS = {
	buy: 'commerce/transactions/current/buys',
	sell: 'commerce/transactions/current/sells',
} as const;

/** Reads only the two current-order endpoints over an already pinned operation. */
export async function captureActiveTradingPostOrders(
	operation: GuildWars2Operation,
	accountId: string,
	token: TokenInfo,
	now: () => number = Date.now,
): Promise<ActiveTradingPostOrdersEvidenceV1> {
	const capturedAt = new Date(now()).toISOString();
	const [buys, sells] = await Promise.all([
		capturePages(operation, token, CURRENT_ENDPOINTS.buy, 'buy', capturedAt)
			.then(keepPagesAlreadyRead),
		capturePages(operation, token, CURRENT_ENDPOINTS.sell, 'sell', capturedAt)
			.then(keepPagesAlreadyRead),
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

interface CapturedTransaction {
	id: number;
	side: TradingPostEvidenceSide;
	itemId: number;
	quantity: number;
}

/**
 * A failure after at least one page was read leaves that side `partial` with its reason and the
 * orders already read (like `page_limit`), instead of `unavailable`/`invalid`, which the evidence
 * validator rejects together with orders. A failure on page 0 reads no order and stays as it was.
 * `capturePages` returns orders only on an incomplete read when page 0 succeeded (invalid pages
 * come back empty), so their presence is what tells a later page from the first.
 */
function keepPagesAlreadyRead(
	result: { coverage: TradingPostEndpointCoverageV1; transactions: CapturedTransaction[] },
): { coverage: TradingPostEndpointCoverageV1; transactions: CapturedTransaction[] } {
	const { coverage, transactions } = result;
	if (transactions.length === 0) return result;
	if (coverage.status === 'unavailable' && coverage.reason === 'request_failed') {
		return { coverage: evidence('partial', null, 'request_failed'), transactions };
	}
	if (coverage.status === 'invalid' && coverage.reason === 'invalid_payload') {
		return { coverage: evidence('partial', null, 'invalid_payload'), transactions };
	}
	return result;
}

async function capturePages(
	operation: GuildWars2Operation,
	token: TokenInfo,
	endpoint: string,
	side: TradingPostEvidenceSide,
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
		const parsed = response.body.map((entry) => parseTransaction(entry, side));
		// An id seen on an earlier page, or earlier on this one, invalidates the whole side.
		const pageTransactions: CapturedTransaction[] = [];
		let valid = true;
		for (const entry of parsed) {
			if (entry === null || seenIds.has(entry.id)) {
				valid = false;
				break;
			}
			seenIds.add(entry.id);
			pageTransactions.push(entry);
		}
		if (!valid) {
			return { coverage: evidence('invalid', null, 'invalid_payload'), transactions: [] };
		}
		transactions.push(...pageTransactions);
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

function parseTransaction(value: unknown, side: TradingPostEvidenceSide): CapturedTransaction | null {
	if (!record(value) || !positive(value.id) || !positive(value.item_id)
		|| !positive(value.price) || !positive(value.quantity) || !iso(value.created)
		|| value.purchased !== undefined) return null;
	return { id: value.id, side, itemId: value.item_id, quantity: value.quantity };
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

function aggregateStatus(
	buys: TradingPostEndpointCoverageV1,
	sells: TradingPostEndpointCoverageV1,
): 'complete' | 'partial' | 'unavailable' {
	if (buys.status === 'complete' && sells.status === 'complete') return 'complete';
	if (buys.status === 'complete' || sells.status === 'complete'
		|| buys.status === 'partial' || sells.status === 'partial') return 'partial';
	return 'unavailable';
}

function evidence(
	status: TradingPostEndpointStatus,
	capturedAt: string | null,
	reason: TradingPostEndpointCoverageV1['reason'],
): TradingPostEndpointCoverageV1 {
	return { status, capturedAt, reason };
}

function positiveHeader(headers: Readonly<Record<string, string>>, name: string): number | null {
	const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
