import { describe, expect, it } from 'vitest';

import {
	calculateContainerTailValuation,
	integerSquareRoot,
} from './container-tail-valuation';
import type { ContainerMarketQuote } from './container-expected-value';
import { halloweenTrickOrTreatBagModel } from './models/halloween-trick-or-treat-bag';

/** Best bid served by `/v2/commerce/listings` on 2026-09-01 for the named tail. */
const JACKPOT_BIDS: ReadonlyArray<[number, number]> = [
	[79_674, 1_132_705],
	[89_007, 320_307],
	[89_065, 2_900_120],
	[89_070, 266_276],
	[89_071, 270_038],
];

describe('container tail valuation', () => {
	it('prices the jackpots the conservative model declares as zero', () => {
		const result = calculateContainerTailValuation(halloweenTrickOrTreatBagModel(), quotes(), 'full');
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(result).toMatchObject({ value: { containerItemId: 36_038, sampleContainers: 106_264 } });
		expect(result.value.bucketSampleUnits).toBe(1_171);
		expect(result.value.itemizedSampleUnits).toBe(13);
		// 78,57 copper per bag: the tail the model reports as unvalued is worth
		// more than a third of the 207,37 copper it does report.
		expect(result.value.immediate.evPerContainerMicroCopper).toBe(78_574_569);
		expect(result.value.immediate.unpricedItemIds).toEqual([]);
	});

	it('carries a deviation two orders of magnitude above its own mean', () => {
		const result = calculateContainerTailValuation(halloweenTrickOrTreatBagModel(), quotes(), 'full');
		if (result.status !== 'ok') throw new Error('Expected a valued tail.');
		const { evPerContainerMicroCopper, deviationPerContainerMicroCopper } = result.value.immediate;
		expect(deviationPerContainerMicroCopper).toBeGreaterThan(evPerContainerMicroCopper * 100);
		// Which is the whole point: the mean only becomes a prediction after more
		// bags than anybody opens in a season.
		const bagsToHalveRelativeError = (deviationPerContainerMicroCopper / evPerContainerMicroCopper) ** 2;
		expect(bagsToHalveRelativeError).toBeGreaterThan(10_000);
	});

	it('declares a jackpot with no price on a route as zero instead of inventing one', () => {
		const withoutAsks = quotes().map((quote) => ({ ...quote, askUnitCopper: null }));
		const result = calculateContainerTailValuation(halloweenTrickOrTreatBagModel(), withoutAsks, 'full');
		if (result.status !== 'ok') throw new Error('Expected a valued tail.');
		expect(result.value.listing.evPerContainerMicroCopper).toBe(0);
		expect(result.value.listing.unpricedItemIds).toEqual([79_674, 89_007, 89_065, 89_070, 89_071]);
		expect(result.value.immediate.unpricedItemIds).toEqual([]);
	});

	it('skips a jackpot the account cannot trade instead of counting a price it cannot reach', () => {
		const restricted = quotes().map((quote) => ({ ...quote, whitelisted: false }));
		const result = calculateContainerTailValuation(halloweenTrickOrTreatBagModel(), restricted, 'free_to_play');
		if (result.status !== 'ok') throw new Error('Expected a valued tail.');
		expect(result.value.immediate.evPerContainerMicroCopper).toBe(0);
		expect(result.value.immediate.unpricedItemIds).toHaveLength(5);
	});

	it('rejects malformed models, duplicate quotes and unknown trading access', () => {
		expect(calculateContainerTailValuation(null, quotes(), 'full')).toEqual({ status: 'invalid', reason: 'invalid_input' });
		expect(calculateContainerTailValuation(halloweenTrickOrTreatBagModel(), 'nope', 'full'))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
		expect(calculateContainerTailValuation(halloweenTrickOrTreatBagModel(), [...quotes(), quotes()[0]!], 'full'))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
		expect(calculateContainerTailValuation(halloweenTrickOrTreatBagModel(), quotes(), 'paid'))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
	});

	it('takes an exact integer square root where a double would already have drifted', () => {
		expect(integerSquareRoot(0n)).toBe(0n);
		expect(integerSquareRoot(1n)).toBe(1n);
		expect(integerSquareRoot(15n)).toBe(3n);
		expect(integerSquareRoot(16n)).toBe(4n);
		const huge = 12_345_678_901_234_567_890n;
		expect(integerSquareRoot(huge * huge)).toBe(huge);
		expect(integerSquareRoot(huge * huge - 1n)).toBe(huge - 1n);
		expect(() => integerSquareRoot(-1n)).toThrow();
	});
});

function quotes(): ContainerMarketQuote[] {
	return JACKPOT_BIDS.map(([itemId, bidUnitCopper]) => ({
		itemId, whitelisted: true, bidUnitCopper, askUnitCopper: bidUnitCopper * 2,
	}));
}
