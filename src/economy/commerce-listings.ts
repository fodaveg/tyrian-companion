import { calculateTradingPostFees, createTradingPostValueWithPolicy } from './gw2-fees';

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
	// The game never pays out less than nothing: on a gross this small both
	// fees hit their one-copper floor and consume the whole sale, and the sale
	// still completes with nothing received, it is not refused. See
	// `calculateTradingPostFees` in `gw2-fees.ts` for the shared formula.
	const net = Math.max(0, gross - fees.fees.totalFeesCopper);
	return {
		status: remaining === 0 ? 'complete' : 'partial', requestedQuantity: quantity,
		coveredQuantity: covered, uncoveredQuantity: remaining, grossCopper: gross,
		netCopper: net, unitCopper: null,
	};
}

/**
 * Values probabilistic outcome units against real buy depth.
 *
 * The game only ever sells a whole number of units at a whole-copper price;
 * `requestedUnitsMillionths` is a fractional expectation over container
 * openings, not a real transaction, so there is no real gross to round. Each
 * depth level's fee is instead computed once, in whole copper, on that
 * level's real integer unit price via `calculateTradingPostFees` (the same
 * formula the session route uses), and the result is scaled by the
 * fractional micro-units actually drawn from that level. That scaling is an
 * exact bigint multiplication, so it introduces no rounding of its own: all
 * rounding happens once, inside the shared per-unit formula.
 *
 * This also means a rare drop is priced as if each unit sold on its own,
 * never as if it conveniently joined an existing large stack to dilute the
 * one-copper floor: nothing here knows whether that stack exists.
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
	let totalFees = 0n;
	for (const level of levels) {
		const capacity = BigInt(level.quantity) * scale;
		const take = remaining < capacity ? remaining : capacity;
		if (take === 0n) break;
		const fees = calculateTradingPostFees(level.unitCopper);
		if (fees.status !== 'ok') return invalidExpectedValue(requestedUnitsMillionths);
		gross += take * BigInt(level.unitCopper);
		totalFees += take * BigInt(fees.fees.totalFeesCopper);
		covered += take;
		remaining -= take;
	}
	if (covered === 0n) return unavailableExpectedValue(requestedUnitsMillionths);
	const net = gross > totalFees ? gross - totalFees : 0n;
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
	return fees.status === 'ok' && value.netCopper === Math.max(0, value.grossCopper - fees.fees.totalFeesCopper)
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
function strictIds(values: unknown[]): boolean { return values.every(positive) && values.every((value, index) => index === 0 || (values[index - 1] as number) < value); }
function strictItems(values: unknown[]): boolean { return values.every((value, index) => index === 0 || (values[index - 1] as InventoryItemMarketDepthV1).itemId < (value as InventoryItemMarketDepthV1).itemId); }
function sameIds(left: number[], right: number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function validQuantity(value: unknown): value is number { return positive(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function iso(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]); }
