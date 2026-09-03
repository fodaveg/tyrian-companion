import { describe, expect, it } from 'vitest';

import { valueExpectedInstantSellDepth, valueInstantSellDepth } from './commerce-listings';

/**
 * The session route (`valueInstantSellDepth`) and the advisor route
 * (`valueExpectedInstantSellDepth`) used to run two different fee
 * arithmetics: the session rounded to nearest copper, half up, with a
 * one-copper floor per fee; the advisor rounded UP in micro-copper with the
 * same floor. They now share one formula, `calculateTradingPostFees` in
 * `gw2-fees.ts`: the session calls it on the whole gross, the advisor calls
 * it once per depth level on that level's real integer unit price and scales
 * the result by the fractional expected units, exactly, with no further
 * rounding. This test is what breaks if either route stops calling that
 * shared formula, or calls it at the wrong granularity.
 *
 * The first seven gross->net pairs are verified IN GAME: they come from the
 * test suite of `t-mw/gw2-arbitrage`, whose author ran them against the live
 * Trading Post and left them with the comment "all prices verified in
 * game". `1 -> 0` is not from that suite; it is the one-copper floor case,
 * where both fees hit their one-copper minimum and consume the whole gross.
 * The game accepts that sale and pays out nothing, it does not refuse it,
 * which is also asserted below.
 */
const VERIFIED_IN_GAME_PAIRS: ReadonlyArray<readonly [grossCopper: number, netCopper: number]> = [
	[2, 0],
	[6, 4],
	[12, 10],
	[18, 15],
	[51, 43],
	[68, 58],
	[11, 9],
	[1, 0],
];

const MICRO_SCALE = 1_000_000n;

describe('Trading Post fee arithmetic: session route and advisor route agree', () => {
	it.each(VERIFIED_IN_GAME_PAIRS)(
		'nets %i copper from a gross of %i on both routes',
		(grossCopper, netCopper) => {
			const levels = [{ unitCopper: grossCopper, quantity: 1 }];
			const session = valueInstantSellDepth(levels, 1);
			const advisor = valueExpectedInstantSellDepth(levels, MICRO_SCALE);
			expect(session).toMatchObject({ status: 'complete', netCopper });
			expect(advisor).toMatchObject({ status: 'complete', netMicroCopper: BigInt(netCopper) * MICRO_SCALE });
		},
	);

	it('agrees on status too: a one-copper sale completes on both routes instead of being refused', () => {
		const levels = [{ unitCopper: 1, quantity: 1 }];
		expect(valueInstantSellDepth(levels, 1)).toMatchObject({ status: 'complete', netCopper: 0 });
		expect(valueExpectedInstantSellDepth(levels, MICRO_SCALE)).toMatchObject({
			status: 'complete', netMicroCopper: 0n,
		});
	});
});
