import { describe, expect, it } from 'vitest';
import { bestSaleNetCopper } from './gw2-fees';

describe('bestSaleNetCopper: the commission is over the total of the sale', () => {
	it('250 units at 8c nets 1_700c over the total (1_500c when it was floor(0.85 x 8) x 250)', () => {
		expect(bestSaleNetCopper(8, null, 250)).toBe(1_700);
	});

	it('1 unit at 1c: both minimum fees swallow the gross and the net is zero, not negative (85 % also gave 0)', () => {
		expect(bestSaleNetCopper(1, null, 1)).toBe(0);
	});

	it('1 unit at 8c nets 6c (the same as the 85 % rule: floor(6.8) = 6)', () => {
		expect(bestSaleNetCopper(8, null, 1)).toBe(6);
	});

	it('takes the better of the instant sale and the vendor, the vendor having no commission', () => {
		expect(bestSaleNetCopper(8, 7, 250)).toBe(1_750);
		expect(bestSaleNetCopper(null, 7, 3)).toBe(21);
		expect(bestSaleNetCopper(8, 1, 250)).toBe(1_700);
	});

	it('returns null with no route, a bad quantity or an unsafe product', () => {
		expect(bestSaleNetCopper(null, null, 2)).toBeNull();
		expect(bestSaleNetCopper(8, null, 0)).toBeNull();
		expect(bestSaleNetCopper(Number.MAX_SAFE_INTEGER, null, 2)).toBeNull();
	});
});
