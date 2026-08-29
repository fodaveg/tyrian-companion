export const TRADING_POST_EVIDENCE_VERSION = 1 as const;

export type TradingPostEvidenceSide = 'buy' | 'sell';
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

function aggregateStatus(
	buys: TradingPostEndpointCoverageV1,
	sells: TradingPostEndpointCoverageV1,
): 'complete' | 'partial' | 'unavailable' {
	if (buys.status === 'complete' && sells.status === 'complete') return 'complete';
	if (buys.status === 'complete' || sells.status === 'complete'
		|| buys.status === 'partial' || sells.status === 'partial') return 'partial';
	return 'unavailable';
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

function text(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function strictIso(value: unknown): value is string {
	return iso(value) && new Date(Date.parse(value)).toISOString() === value;
}
function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length
		&& actual.every((key, index) => key === sortedExpected[index]);
}
function sorted<T>(values: T[], compare: (left: T, right: T) => number): boolean {
	return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}
