import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import {
	createGrossCopperValue,
	createTradingPostCopperValue,
	createVendorCopperValue,
	type CopperValueError,
	type TradingPostCopperValue,
	type VendorCopperValue,
} from './monetary';

export const GW2_TRADING_POST_FEE_POLICY = {
	version: 1,
	listingFeeBasisPoints: 500,
	exchangeFeeBasisPoints: 1_000,
	minimumFeeCopper: 1,
	rounding: 'nearest_copper_half_up',
	basis: 'total_sale_price',
} as const;

interface TradingPostFeeBreakdown {
	policyVersion: typeof GW2_TRADING_POST_FEE_POLICY.version;
	grossCopper: number;
	listingFeeCopper: number;
	exchangeFeeCopper: number;
	totalFeesCopper: number;
}

type TradingPostFeeResult =
	| { status: 'ok'; fees: TradingPostFeeBreakdown }
	| { status: 'invalid'; reason: 'invalid_gross' | 'arithmetic_overflow' };

type TradingPostValueWithPolicyResult =
	| {
		status: 'ok';
		policyVersion: typeof GW2_TRADING_POST_FEE_POLICY.version;
		value: TradingPostCopperValue;
	}
	| { status: 'invalid'; reason: CopperValueError | 'invalid_gross' };

type CatalogVendorValueResult =
	| { status: 'ok'; value: VendorCopperValue }
	| { status: 'unavailable'; reason: 'vendor_sale_forbidden' | 'no_vendor_value' }
	| { status: 'invalid'; reason: 'invalid_catalog_item' | CopperValueError };

export function calculateTradingPostFees(grossCopper: number): TradingPostFeeResult {
	if (!Number.isSafeInteger(grossCopper) || grossCopper <= 0) {
		return { status: 'invalid', reason: 'invalid_gross' };
	}
	const listingFeeCopper = percentageFee(
		grossCopper,
		GW2_TRADING_POST_FEE_POLICY.listingFeeBasisPoints,
	);
	const exchangeFeeCopper = percentageFee(
		grossCopper,
		GW2_TRADING_POST_FEE_POLICY.exchangeFeeBasisPoints,
	);
	if (listingFeeCopper === null || exchangeFeeCopper === null) {
		return { status: 'invalid', reason: 'arithmetic_overflow' };
	}
	const totalFeesCopper = listingFeeCopper + exchangeFeeCopper;
	if (!Number.isSafeInteger(totalFeesCopper)) {
		return { status: 'invalid', reason: 'arithmetic_overflow' };
	}
	return {
		status: 'ok',
		fees: {
			policyVersion: GW2_TRADING_POST_FEE_POLICY.version,
			grossCopper,
			listingFeeCopper,
			exchangeFeeCopper,
			totalFeesCopper,
		},
	};
}

export function createTradingPostValueWithPolicy(
	kind: 'instant_sell' | 'listing',
	unitCopper: number,
	quantity: number,
): TradingPostValueWithPolicyResult {
	const gross = createGrossCopperValue(unitCopper, quantity);
	if (gross.status === 'invalid') return gross;
	const fees = calculateTradingPostFees(gross.value.grossCopper);
	if (fees.status === 'invalid') return fees;
	const value = createTradingPostCopperValue(kind, unitCopper, quantity, fees.fees);
	if (value.status === 'invalid') return value;
	return {
		status: 'ok',
		policyVersion: fees.fees.policyVersion,
		value: value.value,
	};
}

export function createCatalogVendorValue(
	item: unknown,
	quantity: number,
): CatalogVendorValueResult {
	if (!isNormalizedCatalogItem(item)) return { status: 'invalid', reason: 'invalid_catalog_item' };
	const value = createVendorCopperValue(item.vendorValue, quantity);
	if (value.status === 'invalid') return value;
	if (hasNoSellFlag(item)) return { status: 'unavailable', reason: 'vendor_sale_forbidden' };
	if (item.vendorValue === 0) return { status: 'unavailable', reason: 'no_vendor_value' };
	return { status: 'ok', value: value.value };
}

function hasNoSellFlag(item: CatalogItem): boolean {
	return item.flags.includes('NoSell');
}

function percentageFee(grossCopper: number, basisPoints: number): number | null {
	const denominator = 10_000;
	const quotient = Math.floor(grossCopper / denominator);
	const remainder = grossCopper % denominator;
	const base = quotient * basisPoints;
	const roundedRemainder = Math.floor((remainder * basisPoints + denominator / 2) / denominator);
	const fee = base + roundedRemainder;
	if (!Number.isSafeInteger(fee)) return null;
	return Math.max(GW2_TRADING_POST_FEE_POLICY.minimumFeeCopper, fee);
}

/**
 * Net copper of selling `quantity` units (e.g. a loot alert's pile), the best of two routes: instant sale to the best buy order and
 * the vendor.
 *
 * The trading-post commission applies over the TOTAL of the sale (`quantity x bidUnitCopper`, the
 * `total_sale_price` basis of `GW2_TRADING_POST_FEE_POLICY`), never to one unit and then multiplied. The
 * vendor takes no commission, so it is linear in the quantity. A sale whose two minimum fees swallow the
 * whole gross nets zero, not a negative. Returns null when no route has a price or the arithmetic would
 * leave the safe-integer range.
 */
export function bestSaleNetCopper(
	bidUnitCopper: number | null | undefined,
	vendorUnitCopper: number | null | undefined,
	quantity: number,
): number | null {
	if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
	const instant = bidUnitCopper === null || bidUnitCopper === undefined ? null : instantNet(bidUnitCopper, quantity);
	const vendor = vendorUnitCopper === null || vendorUnitCopper === undefined ? null : product(vendorUnitCopper, quantity);
	if (instant === null) return vendor;
	return vendor === null ? instant : Math.max(instant, vendor);
}

function instantNet(unitCopper: number, quantity: number): number | null {
	const gross = product(unitCopper, quantity);
	if (gross === null) return null;
	const fees = calculateTradingPostFees(gross);
	return fees.status === 'ok' ? Math.max(0, gross - fees.fees.totalFeesCopper) : null;
}

function product(unitCopper: number, quantity: number): number | null {
	const value = unitCopper * quantity;
	return Number.isSafeInteger(unitCopper) && unitCopper >= 0 && Number.isSafeInteger(value) ? value : null;
}
