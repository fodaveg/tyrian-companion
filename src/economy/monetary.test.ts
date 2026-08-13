import { describe, expect, it } from 'vitest';

import {
	createGrossCopperValue,
	createNonLiquidCopperValue,
	createTradingPostCopperValue,
	createVendorCopperValue,
	isCopperValue,
} from './monetary';

describe('copper monetary contract', () => {
	it('defines gross as unit copper multiplied by positive quantity', () => {
		expect(createGrossCopperValue(123, 4)).toEqual({
			status: 'ok',
			value: {
				version: 1,
				kind: 'gross',
				priceSource: 'reference',
				liquidity: 'reference_only',
				quantity: 4,
				unitCopper: 123,
				grossCopper: 492,
			},
		});
	});

	it('defines instant sale from the highest buy order minus supplied fees', () => {
		expect(createTradingPostCopperValue('instant_sell', 1_000, 2, {
			listingFeeCopper: 100,
			exchangeFeeCopper: 200,
		})).toMatchObject({
			status: 'ok',
			value: {
				kind: 'instant_sell',
				priceSource: 'highest_buy_order',
				liquidity: 'immediate',
				grossCopper: 2_000,
				totalFeesCopper: 300,
				netCopper: 1_700,
			},
		});
	});

	it('defines listing from the chosen listing price minus supplied fees', () => {
		expect(createTradingPostCopperValue('listing', 1_200, 2, {
			listingFeeCopper: 120,
			exchangeFeeCopper: 240,
		})).toMatchObject({
			status: 'ok',
			value: {
				kind: 'listing',
				priceSource: 'listing_price',
				liquidity: 'conditional',
				grossCopper: 2_400,
				totalFeesCopper: 360,
				netCopper: 2_040,
			},
		});
	});

	it('defines vendor value without Trading Post fees', () => {
		expect(createVendorCopperValue(7, 3)).toMatchObject({
			status: 'ok',
			value: {
				kind: 'vendor',
				priceSource: 'vendor_value',
				liquidity: 'immediate',
				grossCopper: 21,
				netCopper: 21,
			},
		});
	});

	it('keeps non-liquid distinct from a real zero-copper quote', () => {
		expect(createNonLiquidCopperValue(5, 'no_eligible_route')).toEqual({
			status: 'ok',
			value: {
				version: 1,
				kind: 'non_liquid',
				priceSource: 'none',
				liquidity: 'none',
				quantity: 5,
				reason: 'no_eligible_route',
				grossCopper: null,
				netCopper: null,
			},
		});
		expect(createVendorCopperValue(0, 5)).toMatchObject({
			status: 'ok',
			value: { netCopper: 0 },
		});
	});

	it('rejects fractional, negative, zero-quantity and overflowing inputs', () => {
		expect(createGrossCopperValue(1.5, 1)).toEqual({ status: 'invalid', reason: 'invalid_unit_price' });
		expect(createGrossCopperValue(-1, 1)).toEqual({ status: 'invalid', reason: 'invalid_unit_price' });
		expect(createGrossCopperValue(1, 0)).toEqual({ status: 'invalid', reason: 'invalid_quantity' });
		expect(createGrossCopperValue(Number.MAX_SAFE_INTEGER, 2))
			.toEqual({ status: 'invalid', reason: 'arithmetic_overflow' });
	});

	it('rejects invalid fees, fee overflow and fees greater than gross', () => {
		expect(createTradingPostCopperValue('listing', 100, 1, {
			listingFeeCopper: -1,
			exchangeFeeCopper: 0,
		})).toEqual({ status: 'invalid', reason: 'invalid_fee' });
		expect(createTradingPostCopperValue('listing', Number.MAX_SAFE_INTEGER, 1, {
			listingFeeCopper: Number.MAX_SAFE_INTEGER,
			exchangeFeeCopper: 1,
		})).toEqual({ status: 'invalid', reason: 'arithmetic_overflow' });
		expect(createTradingPostCopperValue('listing', 100, 1, {
			listingFeeCopper: 60,
			exchangeFeeCopper: 50,
		})).toEqual({ status: 'invalid', reason: 'fees_exceed_gross' });
	});

	it('strictly validates persisted values and their arithmetic invariants', () => {
		const result = createTradingPostCopperValue('instant_sell', 1_000, 2, {
			listingFeeCopper: 100,
			exchangeFeeCopper: 200,
		});
		if (result.status !== 'ok') throw new Error('Expected value fixture.');
		expect(isCopperValue(result.value)).toBe(true);
		expect(isCopperValue({ ...result.value, netCopper: 1_701 })).toBe(false);
		expect(isCopperValue({ ...result.value, priceSource: 'listing_price' })).toBe(false);
		expect(isCopperValue({ ...result.value, liquidity: 'conditional' })).toBe(false);
		expect(isCopperValue({ ...result.value, extra: true })).toBe(false);
		for (const candidate of [
			createGrossCopperValue(1, 1),
			createTradingPostCopperValue('listing', 100, 1, { listingFeeCopper: 5, exchangeFeeCopper: 10 }),
			createVendorCopperValue(1, 1),
			createNonLiquidCopperValue(1, 'no_eligible_route'),
		]) {
			if (candidate.status !== 'ok') throw new Error('Expected value fixture.');
			expect(isCopperValue(candidate.value)).toBe(true);
		}
	});
});
