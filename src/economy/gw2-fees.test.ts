import { describe, expect, it } from 'vitest';

import type { CatalogItem } from '../catalog/public-catalog-model';
import {
	calculateTradingPostFees,
	createCatalogVendorValue,
	createTradingPostValueWithPolicy,
	GW2_TRADING_POST_FEE_POLICY,
} from './gw2-fees';

describe('Guild Wars 2 fees and vendor values', () => {
	it('pins the versioned 5% plus 10% Trading Post policy', () => {
		expect(GW2_TRADING_POST_FEE_POLICY).toEqual({
			version: 1,
			listingFeeBasisPoints: 500,
			exchangeFeeBasisPoints: 1_000,
			minimumFeeCopper: 1,
			rounding: 'nearest_copper_half_up',
			basis: 'total_sale_price',
		});
	});

	it('calculates both fees from the total stack sale price', () => {
		expect(calculateTradingPostFees(2_000)).toEqual({
			status: 'ok',
			fees: {
				policyVersion: 1,
				grossCopper: 2_000,
				listingFeeCopper: 100,
				exchangeFeeCopper: 200,
				totalFeesCopper: 300,
			},
		});
		expect(createTradingPostValueWithPolicy('instant_sell', 1_000, 2)).toMatchObject({
			status: 'ok',
			policyVersion: 1,
			value: { grossCopper: 2_000, netCopper: 1_700 },
		});
	});

	it('rounds each fee to nearest copper, half up, with a one-copper minimum', () => {
		expect(calculateTradingPostFees(1)).toMatchObject({
			fees: { listingFeeCopper: 1, exchangeFeeCopper: 1 },
		});
		expect(calculateTradingPostFees(10)).toMatchObject({
			fees: { listingFeeCopper: 1, exchangeFeeCopper: 1 },
		});
		expect(calculateTradingPostFees(15)).toMatchObject({
			fees: { listingFeeCopper: 1, exchangeFeeCopper: 2 },
		});
		expect(calculateTradingPostFees(30)).toMatchObject({
			fees: { listingFeeCopper: 2, exchangeFeeCopper: 3 },
		});
	});

	it('rounds once on the total sale rather than once per item', () => {
		const stack = createTradingPostValueWithPolicy('listing', 10, 3);
		const singles = [1, 2, 3].map(() => createTradingPostValueWithPolicy('listing', 10, 1));
		expect(stack).toMatchObject({ status: 'ok', value: { totalFeesCopper: 5, netCopper: 25 } });
		const singleFees = singles.map((result) => {
			if (result.status !== 'ok') throw new Error('Expected a valid single-item sale.');
			return result.value.totalFeesCopper;
		});
		expect(singleFees).toEqual([2, 2, 2]);
		expect(singleFees.reduce((total, fee) => total + fee, 0)).toBe(6);
	});

	it('rejects a quote when the two minimum fees exceed its gross value', () => {
		expect(createTradingPostValueWithPolicy('instant_sell', 1, 1))
			.toEqual({ status: 'invalid', reason: 'fees_exceed_gross' });
	});

	it('rejects absent, fractional, negative and zero gross prices', () => {
		for (const gross of [0, -1, 1.5, Number.NaN]) {
			expect(calculateTradingPostFees(gross)).toEqual({ status: 'invalid', reason: 'invalid_gross' });
		}
		expect(createTradingPostValueWithPolicy('listing', 0, 1))
			.toEqual({ status: 'invalid', reason: 'invalid_gross' });
	});

	it('uses vendor value only when catalog metadata allows the sale', () => {
		expect(createCatalogVendorValue(item({ vendorValue: 7 }), 3)).toMatchObject({
			status: 'ok',
			value: { kind: 'vendor', grossCopper: 21, netCopper: 21 },
		});
		expect(createCatalogVendorValue(item({ vendorValue: 7, flags: ['NoSell'] }), 3))
			.toEqual({ status: 'unavailable', reason: 'vendor_sale_forbidden' });
		expect(createCatalogVendorValue(item({ vendorValue: 0 }), 3))
			.toEqual({ status: 'unavailable', reason: 'no_vendor_value' });
	});

	it('does not treat binding flags alone as a vendor prohibition', () => {
		expect(createCatalogVendorValue(item({ vendorValue: 7, flags: ['AccountBound'] }), 1))
			.toMatchObject({ status: 'ok', value: { netCopper: 7 } });
	});

	it('fails closed for malformed catalog items and invalid quantities', () => {
		expect(createCatalogVendorValue({ vendorValue: 7 }, 1))
			.toEqual({ status: 'invalid', reason: 'invalid_catalog_item' });
		expect(createCatalogVendorValue(item({ vendorValue: 7 }), 0))
			.toEqual({ status: 'invalid', reason: 'invalid_quantity' });
		expect(createCatalogVendorValue(item({ vendorValue: 7, flags: ['NoSell'] }), 0))
			.toEqual({ status: 'invalid', reason: 'invalid_quantity' });
	});
});

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
	return {
		kind: 'item',
		id: 1,
		name: 'Test item',
		type: 'CraftingMaterial',
		rarity: 'Basic',
		level: 0,
		vendorValue: 1,
		flags: [],
		gameTypes: [],
		restrictions: [],
		...overrides,
	};
}
