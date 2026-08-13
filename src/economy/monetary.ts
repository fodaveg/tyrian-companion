export const COPPER_VALUATION_VERSION = 1 as const;

export type CopperValueKind = 'gross' | 'instant_sell' | 'listing' | 'vendor' | 'non_liquid';
export type NonLiquidReason =
	| 'no_eligible_route'
	| 'missing_required_data'
	| 'not_applicable'
	| 'unknown';

export interface GrossCopperValue {
	version: typeof COPPER_VALUATION_VERSION;
	kind: 'gross';
	priceSource: 'reference';
	liquidity: 'reference_only';
	quantity: number;
	unitCopper: number;
	grossCopper: number;
}

export interface TradingPostCopperValue {
	version: typeof COPPER_VALUATION_VERSION;
	kind: 'instant_sell' | 'listing';
	priceSource: 'highest_buy_order' | 'listing_price';
	liquidity: 'immediate' | 'conditional';
	quantity: number;
	unitCopper: number;
	grossCopper: number;
	listingFeeCopper: number;
	exchangeFeeCopper: number;
	totalFeesCopper: number;
	netCopper: number;
}

export interface VendorCopperValue {
	version: typeof COPPER_VALUATION_VERSION;
	kind: 'vendor';
	priceSource: 'vendor_value';
	liquidity: 'immediate';
	quantity: number;
	unitCopper: number;
	grossCopper: number;
	netCopper: number;
}

export interface NonLiquidCopperValue {
	version: typeof COPPER_VALUATION_VERSION;
	kind: 'non_liquid';
	priceSource: 'none';
	liquidity: 'none';
	quantity: number;
	reason: NonLiquidReason;
	grossCopper: null;
	netCopper: null;
}

export type CopperValue =
	| GrossCopperValue
	| TradingPostCopperValue
	| VendorCopperValue
	| NonLiquidCopperValue;

export type CopperValueError =
	| 'invalid_quantity'
	| 'invalid_unit_price'
	| 'invalid_fee'
	| 'arithmetic_overflow'
	| 'fees_exceed_gross';

export type CopperValueResult<T extends CopperValue = CopperValue> =
	| { status: 'ok'; value: T }
	| { status: 'invalid'; reason: CopperValueError };

export function createGrossCopperValue(unitCopper: number, quantity: number): CopperValueResult<GrossCopperValue> {
	const input = validateBasis(unitCopper, quantity);
	if (input.status === 'invalid') return input;
	return {
		status: 'ok',
		value: {
			version: COPPER_VALUATION_VERSION,
			kind: 'gross',
			priceSource: 'reference',
			liquidity: 'reference_only',
			quantity,
			unitCopper,
			grossCopper: input.grossCopper,
		},
	};
}

export function createTradingPostCopperValue(
	kind: 'instant_sell' | 'listing',
	unitCopper: number,
	quantity: number,
	fees: { listingFeeCopper: number; exchangeFeeCopper: number },
): CopperValueResult<TradingPostCopperValue> {
	const input = validateBasis(unitCopper, quantity);
	if (input.status === 'invalid') return input;
	if (input.grossCopper === 0) return { status: 'invalid', reason: 'invalid_unit_price' };
	if (!isCopper(fees.listingFeeCopper) || !isCopper(fees.exchangeFeeCopper)) {
		return { status: 'invalid', reason: 'invalid_fee' };
	}
	const totalFeesCopper = safeAdd(fees.listingFeeCopper, fees.exchangeFeeCopper);
	if (totalFeesCopper === null) return { status: 'invalid', reason: 'arithmetic_overflow' };
	if (totalFeesCopper > input.grossCopper) return { status: 'invalid', reason: 'fees_exceed_gross' };
	return {
		status: 'ok',
		value: {
			version: COPPER_VALUATION_VERSION,
			kind,
			priceSource: kind === 'instant_sell' ? 'highest_buy_order' : 'listing_price',
			liquidity: kind === 'instant_sell' ? 'immediate' : 'conditional',
			quantity,
			unitCopper,
			grossCopper: input.grossCopper,
			listingFeeCopper: fees.listingFeeCopper,
			exchangeFeeCopper: fees.exchangeFeeCopper,
			totalFeesCopper,
			netCopper: input.grossCopper - totalFeesCopper,
		},
	};
}

export function createVendorCopperValue(unitCopper: number, quantity: number): CopperValueResult<VendorCopperValue> {
	const input = validateBasis(unitCopper, quantity);
	if (input.status === 'invalid') return input;
	return {
		status: 'ok',
		value: {
			version: COPPER_VALUATION_VERSION,
			kind: 'vendor',
			priceSource: 'vendor_value',
			liquidity: 'immediate',
			quantity,
			unitCopper,
			grossCopper: input.grossCopper,
			netCopper: input.grossCopper,
		},
	};
}

export function createNonLiquidCopperValue(
	quantity: number,
	reason: NonLiquidReason,
): CopperValueResult<NonLiquidCopperValue> {
	if (!isQuantity(quantity)) return { status: 'invalid', reason: 'invalid_quantity' };
	return {
		status: 'ok',
		value: {
			version: COPPER_VALUATION_VERSION,
			kind: 'non_liquid',
			priceSource: 'none',
			liquidity: 'none',
			quantity,
			reason,
			grossCopper: null,
			netCopper: null,
		},
	};
}

export function isCopperValue(value: unknown): value is CopperValue {
	if (!isRecord(value) || value.version !== COPPER_VALUATION_VERSION || !isQuantity(value.quantity)) return false;
	if (value.kind === 'gross') {
		return exactKeys(value, ['version', 'kind', 'priceSource', 'liquidity', 'quantity', 'unitCopper', 'grossCopper'])
			&& value.priceSource === 'reference'
			&& value.liquidity === 'reference_only'
			&& validBasis(value.unitCopper, value.quantity, value.grossCopper);
	}
	if (value.kind === 'instant_sell' || value.kind === 'listing') {
		if (!exactKeys(value, [
			'version', 'kind', 'priceSource', 'liquidity', 'quantity', 'unitCopper', 'grossCopper',
			'listingFeeCopper', 'exchangeFeeCopper', 'totalFeesCopper', 'netCopper',
		])) return false;
		const expectedSource = value.kind === 'instant_sell' ? 'highest_buy_order' : 'listing_price';
		const expectedLiquidity = value.kind === 'instant_sell' ? 'immediate' : 'conditional';
		const grossCopper = value.grossCopper;
		if (value.priceSource !== expectedSource
			|| value.liquidity !== expectedLiquidity
			|| !isCopper(grossCopper)
			|| grossCopper === 0
			|| !validBasis(value.unitCopper, value.quantity, grossCopper)
			|| !isCopper(value.listingFeeCopper)
			|| !isCopper(value.exchangeFeeCopper)
			|| !isCopper(value.totalFeesCopper)
			|| !isCopper(value.netCopper)) return false;
		const totalFees = safeAdd(value.listingFeeCopper, value.exchangeFeeCopper);
		return totalFees !== null
			&& totalFees === value.totalFeesCopper
			&& totalFees <= grossCopper
			&& value.netCopper === grossCopper - totalFees;
	}
	if (value.kind === 'vendor') {
		return exactKeys(value, [
			'version', 'kind', 'priceSource', 'liquidity', 'quantity', 'unitCopper', 'grossCopper', 'netCopper',
		])
			&& value.priceSource === 'vendor_value'
			&& value.liquidity === 'immediate'
			&& validBasis(value.unitCopper, value.quantity, value.grossCopper)
			&& value.netCopper === value.grossCopper;
	}
	return value.kind === 'non_liquid'
		&& exactKeys(value, ['version', 'kind', 'priceSource', 'liquidity', 'quantity', 'reason', 'grossCopper', 'netCopper'])
		&& value.priceSource === 'none'
		&& value.liquidity === 'none'
		&& isNonLiquidReason(value.reason)
		&& value.grossCopper === null
		&& value.netCopper === null;
}

function validateBasis(
	unitCopper: number,
	quantity: number,
): { status: 'ok'; grossCopper: number } | { status: 'invalid'; reason: CopperValueError } {
	if (!isQuantity(quantity)) return { status: 'invalid', reason: 'invalid_quantity' };
	if (!isCopper(unitCopper)) return { status: 'invalid', reason: 'invalid_unit_price' };
	const grossCopper = safeMultiply(unitCopper, quantity);
	return grossCopper === null
		? { status: 'invalid', reason: 'arithmetic_overflow' }
		: { status: 'ok', grossCopper };
}

function validBasis(unitCopper: unknown, quantity: number, grossCopper: unknown): boolean {
	return isCopper(unitCopper)
		&& isCopper(grossCopper)
		&& safeMultiply(unitCopper, quantity) === grossCopper;
}

function safeMultiply(a: number, b: number): number | null {
	const result = a * b;
	return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function safeAdd(a: number, b: number): number | null {
	const result = a + b;
	return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function isCopper(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isQuantity(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonLiquidReason(value: unknown): value is NonLiquidReason {
	return value === 'no_eligible_route'
		|| value === 'missing_required_data'
		|| value === 'not_applicable'
		|| value === 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
