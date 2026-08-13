import type { ContainerMarketBatch } from './container-recommendation';
import { createTradingPostValueWithPolicy } from './gw2-fees';

export const HOLD_INTENT_VERSION = 1 as const;
export const HOLD_PLAN_VERSION = 1 as const;

export type HoldIntentRoute = 'instant_sell' | 'listing';
export type HoldIntentCategory = 'seasonal_rebound' | 'market_target' | 'personal';
export type HoldIntentState = 'holding' | 'target_reached' | 'expired' | 'price_unavailable' | 'cancelled';

export interface HoldIntentV1 {
	version: typeof HOLD_INTENT_VERSION;
	intentId: string;
	accountId: string;
	itemId: number;
	quantity: number;
	target: { route: HoldIntentRoute; unitGrossCopper: number };
	reason: { category: HoldIntentCategory; note: string };
	createdAt: string;
	deadlineAt: string;
	status: 'active' | 'cancelled';
	origin: 'user';
}

export interface HoldProjectedTargetNet {
	policyVersion: 1;
	route: HoldIntentRoute;
	quantity: number;
	unitGrossCopper: number;
	grossCopper: number;
	listingFeeCopper: number;
	exchangeFeeCopper: number;
	totalFeesCopper: number;
	netCopper: number;
}

export interface HoldAllocation {
	intentId: string;
	itemId: number;
	deadlineAt: string;
	state: HoldIntentState;
	reason: HoldIntentV1['reason'];
	requestedQuantity: number;
	allocatedQuantity: number;
	shortfallQuantity: number;
	currentUnitGrossCopper: number | null;
	targetUnitGrossCopper: number;
	projectedTargetNet: HoldProjectedTargetNet;
	remainingMs: number;
}

export interface HoldPlanItem {
	itemId: number;
	inputFreeQuantity: number;
	heldQuantity: number;
	remainingFreeQuantity: number;
}

export interface HoldPlan {
	version: typeof HOLD_PLAN_VERSION;
	asOf: string;
	accountId: string;
	snapshotId: string;
	sessionId: string;
	marketBatchId: string;
	items: HoldPlanItem[];
	allocations: HoldAllocation[];
}

export interface HoldIntentInput {
	version: 1;
	asOf: string;
	accountId: string;
	snapshotId: string;
	sessionId: string;
	freeQuantityByItem: Record<string, number>;
	intents: HoldIntentV1[];
	market: ContainerMarketBatch;
}

export type HoldPlanResult =
	| { status: 'ok'; plan: HoldPlan }
	| { status: 'invalid'; reason: 'invalid_input' | 'identity_mismatch' | 'arithmetic_overflow' };

/** Pure H4.11 allocator. Only explicit user intents may protect quantities. */
export function evaluateHoldIntents(value: unknown): HoldPlanResult {
	try {
		if (!isHoldIntentInput(value)) return { status: 'invalid', reason: 'invalid_input' };
		if (value.intents.some((intent) => intent.accountId !== value.accountId)) {
			return { status: 'invalid', reason: 'identity_mismatch' };
		}
		const quoteById = new Map(value.market.quotes.map((quote) => [quote.itemId, quote]));
		const remaining = new Map(Object.entries(value.freeQuantityByItem)
			.map(([itemId, quantity]) => [Number(itemId), quantity]));
		const allocations: HoldAllocation[] = [];
		for (const intent of [...value.intents].sort(compareIntents)) {
			const current = currentUnitPrice(intent.target.route, quoteById.get(intent.itemId));
			const state = intentState(intent, value.asOf, current);
			const protects = state === 'holding' || state === 'price_unavailable';
			const available = remaining.get(intent.itemId) ?? 0;
			const allocatedQuantity = protects ? Math.min(intent.quantity, available) : 0;
			const shortfallQuantity = protects ? safeSubtract(intent.quantity, allocatedQuantity) : 0;
			remaining.set(intent.itemId, safeSubtract(available, allocatedQuantity));
			const projected = createTradingPostValueWithPolicy(
				intent.target.route,
				intent.target.unitGrossCopper,
				intent.quantity,
			);
			if (projected.status !== 'ok') return { status: 'invalid', reason: projected.reason === 'arithmetic_overflow'
				? 'arithmetic_overflow' : 'invalid_input' };
			allocations.push({
				intentId: intent.intentId,
				itemId: intent.itemId,
				deadlineAt: intent.deadlineAt,
				state,
				reason: structuredClone(intent.reason),
				requestedQuantity: intent.quantity,
				allocatedQuantity,
				shortfallQuantity,
				currentUnitGrossCopper: current,
				targetUnitGrossCopper: intent.target.unitGrossCopper,
				projectedTargetNet: {
					policyVersion: projected.policyVersion,
					route: intent.target.route,
					quantity: intent.quantity,
					unitGrossCopper: intent.target.unitGrossCopper,
					grossCopper: projected.value.grossCopper,
					listingFeeCopper: projected.value.listingFeeCopper,
					exchangeFeeCopper: projected.value.exchangeFeeCopper,
					totalFeesCopper: projected.value.totalFeesCopper,
					netCopper: projected.value.netCopper,
				},
				remainingMs: Math.max(0, safeSubtract(Date.parse(intent.deadlineAt), Date.parse(value.asOf))),
			});
		}
		const ids = [...new Set([
			...Object.keys(value.freeQuantityByItem).map(Number),
			...value.intents.map((intent) => intent.itemId),
		])].sort((left, right) => left - right);
		const items = ids.map((itemId) => {
			const inputFreeQuantity = value.freeQuantityByItem[String(itemId)] ?? 0;
			const remainingFreeQuantity = remaining.get(itemId) ?? inputFreeQuantity;
			return {
				itemId,
				inputFreeQuantity,
				heldQuantity: safeSubtract(inputFreeQuantity, remainingFreeQuantity),
				remainingFreeQuantity,
			};
		});
		const plan: HoldPlan = {
			version: HOLD_PLAN_VERSION,
			asOf: value.asOf,
			accountId: value.accountId,
			snapshotId: value.snapshotId,
			sessionId: value.sessionId,
			marketBatchId: value.market.batchId,
			items,
			allocations,
		};
		return isHoldPlan(plan) ? { status: 'ok', plan } : { status: 'invalid', reason: 'arithmetic_overflow' };
	} catch {
		return { status: 'invalid', reason: 'arithmetic_overflow' };
	}
}

export function isHoldIntent(value: unknown): value is HoldIntentV1 {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'intentId', 'accountId', 'itemId', 'quantity', 'target', 'reason',
		'createdAt', 'deadlineAt', 'status', 'origin',
	])) return false;
	return value.version === HOLD_INTENT_VERSION && trimmed(value.intentId, 128) &&
		trimmed(value.accountId, 256) && positive(value.itemId) && positive(value.quantity) &&
		isTarget(value.target) && isReason(value.reason) && iso(value.createdAt) && iso(value.deadlineAt) &&
		Date.parse(value.deadlineAt) > Date.parse(value.createdAt) &&
		(value.status === 'active' || value.status === 'cancelled') && value.origin === 'user';
}

export function isHoldPlan(value: unknown): value is HoldPlan {
	try {
		if (!isRecord(value) || !exactKeys(value, [
			'version', 'asOf', 'accountId', 'snapshotId', 'sessionId', 'marketBatchId', 'items', 'allocations',
		]) || value.version !== HOLD_PLAN_VERSION || !iso(value.asOf) || !trimmed(value.accountId, 256) ||
			!trimmed(value.snapshotId, 256) || !trimmed(value.sessionId, 256) || !trimmed(value.marketBatchId, 256) ||
			!Array.isArray(value.items) || !value.items.every(isPlanItem) || !Array.isArray(value.allocations) ||
			!value.allocations.every(isAllocation)) return false;
		const plan = value as unknown as HoldPlan;
		const itemIds = new Set(plan.items.map((item) => item.itemId));
		if (!plan.items.every((item, index) => index === 0 || plan.items[index - 1]!.itemId < item.itemId) ||
			!plan.allocations.every((allocation, index) => index === 0 ||
				compareAllocationOrder(plan.allocations[index - 1]!, allocation) < 0) ||
			new Set(plan.allocations.map((allocation) => allocation.intentId)).size !== plan.allocations.length ||
			!plan.allocations.every((allocation) => itemIds.has(allocation.itemId) && allocation.remainingMs ===
				Math.max(0, safeSubtract(Date.parse(allocation.deadlineAt), Date.parse(plan.asOf))))) return false;
		return plan.items.every((item) => {
			const held = plan.allocations.filter((allocation) => allocation.itemId === item.itemId)
				.reduce((sum, allocation) => safeAdd(sum, allocation.allocatedQuantity), 0);
			return held === item.heldQuantity &&
				safeAdd(item.heldQuantity, item.remainingFreeQuantity) === item.inputFreeQuantity;
		});
	} catch {
		return false;
	}
}

function isHoldIntentInput(value: unknown): value is HoldIntentInput {
	if (!isRecord(value) || !exactKeys(value, [
		'version', 'asOf', 'accountId', 'snapshotId', 'sessionId', 'freeQuantityByItem', 'intents', 'market',
	]) || value.version !== 1 || !iso(value.asOf) || !trimmed(value.accountId, 256) ||
		!trimmed(value.snapshotId, 256) || !trimmed(value.sessionId, 256) ||
		!isFreeQuantityMap(value.freeQuantityByItem) || !Array.isArray(value.intents) ||
		!value.intents.every(isHoldIntent) || !isMarket(value.market)) return false;
	const asOf = value.asOf;
	return new Set(value.intents.map((intent) => intent.intentId)).size === value.intents.length &&
		value.intents.every((intent) => Date.parse(intent.createdAt) <= Date.parse(asOf));
}

function isMarket(value: unknown): value is ContainerMarketBatch {
	if (!isRecord(value) || !exactKeys(value, ['version', 'batchId', 'capturedAt', 'source', 'quotes']) ||
		value.version !== 1 || !trimmed(value.batchId, 256) || !iso(value.capturedAt) ||
		value.source !== 'gw2-commerce-prices' || !Array.isArray(value.quotes) || !value.quotes.every((quote) =>
			isRecord(quote) && exactKeys(quote, ['itemId', 'whitelisted', 'bidUnitCopper', 'askUnitCopper']) &&
			positive(quote.itemId) && typeof quote.whitelisted === 'boolean' &&
			(quote.bidUnitCopper === null || positive(quote.bidUnitCopper)) &&
			(quote.askUnitCopper === null || positive(quote.askUnitCopper)))) return false;
	const quotes = value.quotes as Array<{ itemId: number }>;
	return new Set(quotes.map((quote) => quote.itemId)).size === quotes.length;
}

function isFreeQuantityMap(value: unknown): value is Record<string, number> {
	if (!isRecord(value)) return false;
	const entries = Object.entries(value);
	return entries.every(([key, quantity]) => /^[1-9]\d*$/u.test(key) && positive(Number(key)) && nonNegative(quantity)) &&
		entries.every(([key], index) => index === 0 || Number(entries[index - 1]![0]) < Number(key));
}

function isTarget(value: unknown): value is HoldIntentV1['target'] {
	return isRecord(value) && exactKeys(value, ['route', 'unitGrossCopper']) &&
		(value.route === 'instant_sell' || value.route === 'listing') && positive(value.unitGrossCopper);
}

function isReason(value: unknown): value is HoldIntentV1['reason'] {
	return isRecord(value) && exactKeys(value, ['category', 'note']) &&
		['seasonal_rebound', 'market_target', 'personal'].includes(String(value.category)) && trimmed(value.note, 1_024);
}

function isPlanItem(value: unknown): value is HoldPlanItem {
	return isRecord(value) && exactKeys(value, ['itemId', 'inputFreeQuantity', 'heldQuantity', 'remainingFreeQuantity']) &&
		positive(value.itemId) && nonNegative(value.inputFreeQuantity) && nonNegative(value.heldQuantity) &&
		nonNegative(value.remainingFreeQuantity) &&
		safeAdd(value.heldQuantity, value.remainingFreeQuantity) === value.inputFreeQuantity;
}

function isAllocation(value: unknown): value is HoldAllocation {
	if (!isRecord(value) || !exactKeys(value, [
		'intentId', 'itemId', 'deadlineAt', 'state', 'reason', 'requestedQuantity', 'allocatedQuantity',
		'shortfallQuantity', 'currentUnitGrossCopper', 'targetUnitGrossCopper', 'projectedTargetNet', 'remainingMs',
	]) || !trimmed(value.intentId, 128) || !positive(value.itemId) || !iso(value.deadlineAt) ||
		!['holding', 'target_reached', 'expired', 'price_unavailable', 'cancelled'].includes(String(value.state)) ||
		!isReason(value.reason) || !positive(value.requestedQuantity) || !nonNegative(value.allocatedQuantity) ||
		!nonNegative(value.shortfallQuantity) || value.allocatedQuantity > value.requestedQuantity ||
		(value.currentUnitGrossCopper !== null && !positive(value.currentUnitGrossCopper)) ||
		!positive(value.targetUnitGrossCopper) || !isProjected(value.projectedTargetNet) || !nonNegative(value.remainingMs)) return false;
	const protects = value.state === 'holding' || value.state === 'price_unavailable';
	if (!(protects
		? safeAdd(value.allocatedQuantity, value.shortfallQuantity) === value.requestedQuantity
		: value.allocatedQuantity === 0 && value.shortfallQuantity === 0)) return false;
	const stateMatchesPrice =
		(value.state === 'holding' && value.remainingMs > 0 && value.currentUnitGrossCopper !== null &&
			value.currentUnitGrossCopper < value.targetUnitGrossCopper) ||
		(value.state === 'target_reached' && value.remainingMs > 0 && value.currentUnitGrossCopper !== null &&
			value.currentUnitGrossCopper >= value.targetUnitGrossCopper) ||
		(value.state === 'price_unavailable' && value.remainingMs > 0 && value.currentUnitGrossCopper === null) ||
		(value.state === 'expired' && value.remainingMs === 0) || value.state === 'cancelled';
	return stateMatchesPrice &&
		value.projectedTargetNet.route !== undefined &&
		value.projectedTargetNet.unitGrossCopper === value.targetUnitGrossCopper &&
		value.projectedTargetNet.quantity === value.requestedQuantity;
}

function isProjected(value: unknown): value is HoldProjectedTargetNet {
	if (!isRecord(value) || !exactKeys(value, [
		'policyVersion', 'route', 'quantity', 'unitGrossCopper', 'grossCopper', 'listingFeeCopper',
		'exchangeFeeCopper', 'totalFeesCopper', 'netCopper',
	]) || value.policyVersion !== 1 || (value.route !== 'instant_sell' && value.route !== 'listing') ||
		!positive(value.quantity) || !positive(value.unitGrossCopper)) return false;
	const expected = createTradingPostValueWithPolicy(value.route, value.unitGrossCopper, value.quantity);
	return expected.status === 'ok' && canonical(expected.value) === canonical({
		version: 1, kind: value.route, priceSource: value.route === 'instant_sell' ? 'highest_buy_order' : 'listing_price',
		liquidity: value.route === 'instant_sell' ? 'immediate' : 'conditional', quantity: value.quantity,
		unitCopper: value.unitGrossCopper, grossCopper: value.grossCopper, listingFeeCopper: value.listingFeeCopper,
		exchangeFeeCopper: value.exchangeFeeCopper, totalFeesCopper: value.totalFeesCopper, netCopper: value.netCopper,
	});
}

function intentState(intent: HoldIntentV1, asOf: string, current: number | null): HoldIntentState {
	if (intent.status === 'cancelled') return 'cancelled';
	if (Date.parse(asOf) >= Date.parse(intent.deadlineAt)) return 'expired';
	if (current === null) return 'price_unavailable';
	return current >= intent.target.unitGrossCopper ? 'target_reached' : 'holding';
}

function currentUnitPrice(route: HoldIntentRoute, quote: ContainerMarketBatch['quotes'][number] | undefined): number | null {
	return route === 'instant_sell' ? quote?.bidUnitCopper ?? null : quote?.askUnitCopper ?? null;
}

function compareIntents(left: HoldIntentV1, right: HoldIntentV1): number {
	return Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt) || compareText(left.intentId, right.intentId);
}

function compareAllocationOrder(left: HoldAllocation, right: HoldAllocation): number {
	return Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt) || compareText(left.intentId, right.intentId);
}

function compareText(left: string, right: string): number {
	return left.localeCompare(right) || (left < right ? -1 : left > right ? 1 : 0);
}

function safeAdd(left: number, right: number): number {
	const result = left + right;
	if (!Number.isSafeInteger(result)) throw new Error('Unsafe hold sum.');
	return result;
}

function safeSubtract(left: number, right: number): number {
	const result = left - right;
	if (!Number.isSafeInteger(result)) throw new Error('Unsafe hold subtraction.');
	return result;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (isRecord(value)) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function trimmed(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function positive(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
