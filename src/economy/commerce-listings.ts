import {
	calculateTradingPostFees,
	createTradingPostValueWithPolicy,
	GW2_TRADING_POST_FEE_POLICY,
} from './gw2-fees';

export interface CommerceListingLevelV1 {
	unitCopper: number;
	quantity: number;
}

export interface InventoryItemMarketDepthV1 {
	itemId: number;
	coverage: 'complete' | 'missing' | 'invalid' | 'unavailable';
	buys: CommerceListingLevelV1[];
	sells: CommerceListingLevelV1[];
}

export interface InventoryMarketDepthEvidenceV1 {
	version: 1;
	capturedAt: string;
	source: 'gw2-commerce-listings';
	requestedItemIds: number[];
	status: 'complete' | 'partial' | 'unavailable';
	items: InventoryItemMarketDepthV1[];
}

export interface DemonstratedMarketValueV1 {
	status: 'complete' | 'partial' | 'no_market' | 'invalid';
	requestedQuantity: number;
	coveredQuantity: number;
	uncoveredQuantity: number;
	grossCopper: number | null;
	netCopper: number | null;
	unitCopper: number | null;
}

export interface DemonstratedExpectedMarketValueV1 {
	status: 'complete' | 'partial' | 'no_market' | 'invalid';
	requestedUnitsMillionths: bigint;
	coveredUnitsMillionths: bigint;
	uncoveredUnitsMillionths: bigint;
	grossMicroCopper: bigint | null;
	netMicroCopper: bigint | null;
}

/** Values only the quantity matched by real buy levels, from best bid downwards. */
export function valueInstantSellDepth(
	levels: readonly CommerceListingLevelV1[],
	quantity: number,
	consumedQuantity = 0,
): DemonstratedMarketValueV1 {
	if (!validQuantity(quantity) || !nonNegative(consumedQuantity) || !isCommerceListingLevels(levels, 'buys')) {
		return invalidValue(quantity);
	}
	let remaining = quantity;
	let consumedRemaining = consumedQuantity;
	let covered = 0;
	let gross = 0;
	for (const level of levels) {
		const skipped = Math.min(consumedRemaining, level.quantity);
		consumedRemaining -= skipped;
		const take = Math.min(remaining, level.quantity - skipped);
		if (take === 0) continue;
		const slice = level.unitCopper * take;
		if (!Number.isSafeInteger(slice) || !Number.isSafeInteger(gross + slice)) return invalidValue(quantity);
		gross += slice;
		covered += take;
		remaining -= take;
		if (remaining === 0) break;
	}
	if (covered === 0) return unavailableValue(quantity);
	const fees = calculateTradingPostFees(gross);
	if (fees.status !== 'ok') return invalidValue(quantity);
	const net = gross - fees.fees.totalFeesCopper;
	if (!Number.isSafeInteger(net) || net < 0) return invalidValue(quantity);
	return {
		status: remaining === 0 ? 'complete' : 'partial', requestedQuantity: quantity,
		coveredQuantity: covered, uncoveredQuantity: remaining, grossCopper: gross,
		netCopper: net, unitCopper: null,
	};
}

/**
 * Values probabilistic outcome units against real buy depth. Fees are rounded
 * up in micro-copper, including each route's one-copper minimum, so the result
 * is a conservative realizable bound rather than a top-quote extrapolation.
 */
export function valueExpectedInstantSellDepth(
	levels: readonly CommerceListingLevelV1[],
	requestedUnitsMillionths: bigint,
): DemonstratedExpectedMarketValueV1 {
	if (requestedUnitsMillionths <= 0n || !isCommerceListingLevels(levels, 'buys')) {
		return invalidExpectedValue(requestedUnitsMillionths);
	}
	const scale = 1_000_000n;
	let remaining = requestedUnitsMillionths;
	let covered = 0n;
	let gross = 0n;
	for (const level of levels) {
		const capacity = BigInt(level.quantity) * scale;
		const take = remaining < capacity ? remaining : capacity;
		if (take === 0n) break;
		gross += take * BigInt(level.unitCopper);
		covered += take;
		remaining -= take;
	}
	if (covered === 0n) return unavailableExpectedValue(requestedUnitsMillionths);
	const listingFee = expectedFeeMicroCopper(gross, GW2_TRADING_POST_FEE_POLICY.listingFeeBasisPoints);
	const exchangeFee = expectedFeeMicroCopper(gross, GW2_TRADING_POST_FEE_POLICY.exchangeFeeBasisPoints);
	const net = gross > listingFee + exchangeFee ? gross - listingFee - exchangeFee : 0n;
	return {
		status: remaining === 0n ? 'complete' : 'partial',
		requestedUnitsMillionths,
		coveredUnitsMillionths: covered,
		uncoveredUnitsMillionths: remaining,
		grossMicroCopper: gross,
		netMicroCopper: net,
	};
}

/** Values one manual listing at the current best ask; sell-listing quantity is not buyer capacity. */
export function valueCompetitiveListing(
	levels: readonly CommerceListingLevelV1[],
	quantity: number,
): DemonstratedMarketValueV1 {
	if (!validQuantity(quantity) || !isCommerceListingLevels(levels, 'sells')) return invalidValue(quantity);
	const best = levels[0];
	if (best === undefined) return unavailableValue(quantity);
	const value = createTradingPostValueWithPolicy('listing', best.unitCopper, quantity);
	if (value.status !== 'ok') return invalidValue(quantity);
	return {
		status: 'complete', requestedQuantity: quantity, coveredQuantity: quantity, uncoveredQuantity: 0,
		grossCopper: value.value.grossCopper, netCopper: value.value.netCopper, unitCopper: best.unitCopper,
	};
}

export function isDemonstratedMarketValue(value: unknown): value is DemonstratedMarketValueV1 {
	if (!record(value) || !exactKeys(value, [
		'status', 'requestedQuantity', 'coveredQuantity', 'uncoveredQuantity',
		'grossCopper', 'netCopper', 'unitCopper',
	]) || !['complete', 'partial', 'no_market', 'invalid'].includes(String(value.status))
		|| !validQuantity(value.requestedQuantity) || !nonNegative(value.coveredQuantity)
		|| !nonNegative(value.uncoveredQuantity)
		|| value.coveredQuantity + value.uncoveredQuantity !== value.requestedQuantity
		|| value.unitCopper !== null) return false;
	if (value.status === 'no_market' || value.status === 'invalid') {
		return value.coveredQuantity === 0 && value.uncoveredQuantity === value.requestedQuantity
			&& value.grossCopper === null && value.netCopper === null;
	}
	if (!positive(value.coveredQuantity) || !positive(value.grossCopper) || !nonNegative(value.netCopper)) return false;
	const fees = calculateTradingPostFees(value.grossCopper);
	return fees.status === 'ok' && value.netCopper === value.grossCopper - fees.fees.totalFeesCopper
		&& (value.status === 'complete' ? value.uncoveredQuantity === 0 : value.uncoveredQuantity > 0);
}

export function isInventoryMarketDepthEvidence(value: unknown): value is InventoryMarketDepthEvidenceV1 {
	if (!record(value) || !exactKeys(value, ['version', 'capturedAt', 'source', 'requestedItemIds', 'status', 'items'])
		|| value.version !== 1 || !iso(value.capturedAt) || value.source !== 'gw2-commerce-listings'
		|| !Array.isArray(value.requestedItemIds) || !strictIds(value.requestedItemIds)
		|| !['complete', 'partial', 'unavailable'].includes(String(value.status))
		|| !Array.isArray(value.items) || !value.items.every(isItem)
		|| !strictItems(value.items)) return false;
	const evidence = value as unknown as InventoryMarketDepthEvidenceV1;
	if (!sameIds(evidence.requestedItemIds, evidence.items.map((item) => item.itemId))) return false;
	const complete = evidence.items.filter((item) => item.coverage === 'complete').length;
	return evidence.status === (complete === evidence.items.length ? 'complete' : complete === 0 ? 'unavailable' : 'partial');
}

export function isCommerceListingLevels(levels: readonly CommerceListingLevelV1[], side: 'buys' | 'sells'): boolean {
	return levels.every((level, index) => positive(level.unitCopper) && positive(level.quantity)
		&& (index === 0 || (side === 'buys'
			? levels[index - 1]!.unitCopper > level.unitCopper
			: levels[index - 1]!.unitCopper < level.unitCopper)));
}

function isItem(value: unknown): boolean {
	return record(value) && exactKeys(value, ['itemId', 'coverage', 'buys', 'sells']) && positive(value.itemId)
		&& ['complete', 'missing', 'invalid', 'unavailable'].includes(String(value.coverage))
		&& Array.isArray(value.buys) && Array.isArray(value.sells)
		&& (value.coverage === 'complete'
			? isCommerceListingLevels(value.buys as CommerceListingLevelV1[], 'buys') && isCommerceListingLevels(value.sells as CommerceListingLevelV1[], 'sells')
			: value.buys.length === 0 && value.sells.length === 0);
}

function unavailableValue(quantity: number): DemonstratedMarketValueV1 { return { status: 'no_market', requestedQuantity: quantity, coveredQuantity: 0, uncoveredQuantity: quantity, grossCopper: null, netCopper: null, unitCopper: null }; }
function invalidValue(quantity: number): DemonstratedMarketValueV1 { return { status: 'invalid', requestedQuantity: validQuantity(quantity) ? quantity : 0, coveredQuantity: 0, uncoveredQuantity: validQuantity(quantity) ? quantity : 0, grossCopper: null, netCopper: null, unitCopper: null }; }
function unavailableExpectedValue(quantity: bigint): DemonstratedExpectedMarketValueV1 { return { status: 'no_market', requestedUnitsMillionths: quantity, coveredUnitsMillionths: 0n, uncoveredUnitsMillionths: quantity, grossMicroCopper: null, netMicroCopper: null }; }
function invalidExpectedValue(quantity: bigint): DemonstratedExpectedMarketValueV1 { return { status: 'invalid', requestedUnitsMillionths: quantity > 0n ? quantity : 0n, coveredUnitsMillionths: 0n, uncoveredUnitsMillionths: quantity > 0n ? quantity : 0n, grossMicroCopper: null, netMicroCopper: null }; }
function expectedFeeMicroCopper(gross: bigint, basisPoints: number): bigint {
	const numerator = gross * BigInt(basisPoints);
	const denominator = 10_000n;
	const roundedUp = (numerator + denominator - 1n) / denominator;
	return roundedUp > 1_000_000n ? roundedUp : 1_000_000n;
}
function strictIds(values: unknown[]): boolean { return values.every(positive) && values.every((value, index) => index === 0 || (values[index - 1] as number) < value); }
function strictItems(values: unknown[]): boolean { return values.every((value, index) => index === 0 || (values[index - 1] as InventoryItemMarketDepthV1).itemId < (value as InventoryItemMarketDepthV1).itemId); }
function sameIds(left: number[], right: number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function validQuantity(value: unknown): value is number { return positive(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function iso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
