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

export interface TradingPostFeeBreakdown {
	policyVersion: typeof GW2_TRADING_POST_FEE_POLICY.version;
	grossCopper: number;
	listingFeeCopper: number;
	exchangeFeeCopper: number;
	totalFeesCopper: number;
}

export type TradingPostFeeResult =
	| { status: 'ok'; fees: TradingPostFeeBreakdown }
	| { status: 'invalid'; reason: 'invalid_gross' | 'arithmetic_overflow' };

export type TradingPostValueWithPolicyResult =
	| {
		status: 'ok';
		policyVersion: typeof GW2_TRADING_POST_FEE_POLICY.version;
		value: TradingPostCopperValue;
	}
	| { status: 'invalid'; reason: CopperValueError | 'invalid_gross' };

export type CatalogVendorValueResult =
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
