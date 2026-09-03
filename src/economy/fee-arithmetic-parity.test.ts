import { describe, expect, it } from 'vitest';

import { valueExpectedInstantSellDepth, valueInstantSellDepth } from './commerce-listings';

/**
 * Two fee arithmetics price the same sale. This measures the gap, it does not close it.
 *
 * The session route (`calculateTradingPostFees`, reached through
 * `valueInstantSellDepth`) charges each of the two fees in WHOLE copper, rounded
 * to nearest, half up, with a one-copper floor per fee. The advisor route
 * (`expectedFeeMicroCopper`, reached through `valueExpectedInstantSellDepth`)
 * charges the same basis points in micro-copper, rounded UP, with the same
 * one-copper floor per fee.
 *
 * On a gross of a whole number of copper the advisor route carries no rounding at
 * all: ten thousand basis points divide a million micro-copper exactly, so its
 * ceiling never has a remainder to climb. The session route is therefore the only
 * one that rounds, and every divergence below is the session's rounding to copper.
 *
 * The two are NOT interchangeable and this suite deliberately does not unify them.
 * It pins the gap so that changing either arithmetic turns a test red and names
 * the change, instead of silently moving copper in notes already written.
 *
 * The seed is fixed and written down so any counterexample reported by a failure
 * can be reproduced by rerunning this file unchanged.
 */
const SEED = 0x5eed_1a11;
const RANDOM_CASES = 20_000;
const MICRO_SCALE = 1_000_000n;

/**
 * Above this gross, neither route's one-copper floor can bind: the smaller fee is
 * five percent, and five percent of twenty copper is exactly one copper.
 */
const FLOOR_FREE_GROSS_COPPER = 20;

/** Mulberry32: a deterministic PRNG in nine lines, so no dependency is added for this. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b_79f5) >>> 0;
		let drawn = state;
		drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1);
		drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61);
		return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * Gross values spread over magnitudes rather than uniformly, because a uniform
 * draw up to a trillion copper never lands on the small sales where the
 * one-copper floor governs, and those are most of a real inventory.
 */
function grossCopperSamples(): number[] {
	const random = mulberry32(SEED);
	const dense = Array.from({ length: 500 }, (_unused, index) => index + 1);
	const spread = Array.from({ length: RANDOM_CASES }, () => Math.max(1, Math.floor(10 ** (random() * 12))));
	return [...new Set([...dense, ...spread])].sort((left, right) => left - right);
}

interface Divergence {
	grossCopper: number;
	sessionNetMicroCopper: bigint;
	advisorNetMicroCopper: bigint;
	deltaMicroCopper: bigint;
}

/**
 * Prices one gross both ways and returns the gap, or null when the two agree.
 *
 * Both routes are driven through their public entry points rather than through
 * the private fee helpers, because what matters is the number the user is shown.
 * One buy level of `grossCopper` for a single unit makes the two grosses equal by
 * construction: the session sees `grossCopper` copper, the advisor sees the same
 * amount expressed as `grossCopper` million micro-copper.
 */
function compareRoutes(grossCopper: number): Divergence | 'status_divergence' | null {
	const levels = [{ unitCopper: grossCopper, quantity: 1 }];
	const session = valueInstantSellDepth(levels, 1);
	const advisor = valueExpectedInstantSellDepth(levels, MICRO_SCALE);
	if (session.netCopper === null || advisor.netMicroCopper === null) {
		return session.netCopper === null && advisor.netMicroCopper === null ? null : 'status_divergence';
	}
	const sessionNetMicroCopper = BigInt(session.netCopper) * MICRO_SCALE;
	if (sessionNetMicroCopper === advisor.netMicroCopper) return null;
	return {
		grossCopper,
		sessionNetMicroCopper,
		advisorNetMicroCopper: advisor.netMicroCopper,
		deltaMicroCopper: sessionNetMicroCopper - advisor.netMicroCopper,
	};
}

function census() {
	const samples = grossCopperSamples();
	const outcomes = samples.map(compareRoutes);
	const divergences = outcomes.filter((entry): entry is Divergence => entry !== null && entry !== 'status_divergence');
	const deltas = divergences.map((entry) => entry.deltaMicroCopper);
	return {
		comparedCases: samples.length,
		agreeingCases: outcomes.filter((entry) => entry === null).length,
		divergentCases: divergences.length,
		statusDivergentCases: outcomes.filter((entry) => entry === 'status_divergence').length,
		smallestDivergentGrossCopper: divergences[0]?.grossCopper ?? null,
		minDeltaMicroCopper: deltas.reduce((left, right) => (left < right ? left : right), 0n),
		maxDeltaMicroCopper: deltas.reduce((left, right) => (left > right ? left : right), 0n),
	};
}

describe('Trading Post fee arithmetic: session route against advisor route', () => {
	/**
	 * The headline number. Nineteen of every twenty gross values are priced
	 * differently by the two routes; the seed makes the figure reproducible.
	 */
	it('pins how many gross values the two routes price differently', () => {
		expect(census()).toEqual({
			comparedCases: 15_706,
			agreeingCases: 778,
			divergentCases: 14_927,
			statusDivergentCases: 1,
			smallestDivergentGrossCopper: 11,
			minDeltaMicroCopper: -750_000n,
			maxDeltaMicroCopper: 600_000n,
		});
	});

	/**
	 * Stronger than the sample: above the one-copper floor the gap depends only on
	 * the gross modulo twenty, so this table is exhaustive rather than sampled. The
	 * two routes agree on exactly one residue out of twenty.
	 */
	it('pins the whole divergence law: the gap is a function of the gross modulo twenty', () => {
		const base = 1_000_000;
		const law = Array.from({ length: 20 }, (_unused, residue) => {
			const outcome = compareRoutes(base + residue);
			return outcome === null || outcome === 'status_divergence' ? 0n : outcome.deltaMicroCopper;
		});
		expect(law).toEqual([
			0n, 150_000n, 300_000n, 450_000n, 600_000n,
			-250_000n, -100_000n, 50_000n, 200_000n, 350_000n,
			-500_000n, -350_000n, -200_000n, -50_000n, 100_000n,
			-750_000n, -600_000n, -450_000n, -300_000n, -150_000n,
		]);
		expect(law.filter((delta) => delta === 0n)).toHaveLength(1);
	});

	/**
	 * The gap is bounded. Each route charges two fees and the session rounds each
	 * by less than half a copper, so no gross can drift the two answers a whole
	 * copper apart. A regression that made the divergence unbounded would land here
	 * rather than on the pinned census, which only samples.
	 */
	it('keeps the divergence strictly under one copper on every sampled gross', () => {
		const oversized = grossCopperSamples()
			.filter((gross) => gross >= FLOOR_FREE_GROSS_COPPER)
			.map(compareRoutes)
			.filter((entry): entry is Divergence => entry !== null && entry !== 'status_divergence')
			.filter((entry) => entry.deltaMicroCopper <= -MICRO_SCALE || entry.deltaMicroCopper >= MICRO_SCALE);
		expect(oversized).toEqual([]);
	});

	/**
	 * The only place the two routes disagree about whether a sale exists at all.
	 * A one-copper gross owes two one-copper minimum fees: the session refuses the
	 * sale outright, the advisor floors the net at zero and calls it complete.
	 */
	it('pins the single gross where the two routes disagree on status, not on amount', () => {
		const frontier = Array.from({ length: 200 }, (_unused, index) => index + 1)
			.filter((gross) => compareRoutes(gross) === 'status_divergence');
		expect(frontier).toEqual([1]);
		expect(valueInstantSellDepth([{ unitCopper: 1, quantity: 1 }], 1)).toMatchObject({
			status: 'invalid',
			netCopper: null,
		});
		expect(valueExpectedInstantSellDepth([{ unitCopper: 1, quantity: 1 }], MICRO_SCALE)).toMatchObject({
			status: 'complete',
			netMicroCopper: 0n,
		});
	});

	/**
	 * The advisor's ceiling only shows itself on a gross that is NOT a whole number
	 * of copper. On whole copper the basis points divide a million micro-copper
	 * exactly, so rounding up is indistinguishable from rounding down and every
	 * assertion above stays green while the ceiling is deleted; this case was added
	 * after exactly that hole let a deliberate break through. A fractional expected
	 * quantity is the only thing that produces such a gross, and it is the normal
	 * case for a container outcome. The ceiling costs one micro-copper per fee.
	 */
	it('pins the advisor rounding UP on a gross that is not a whole copper', () => {
		const levels = [{ unitCopper: 1, quantity: 200 }];
		const netFor = (millionths: bigint) => valueExpectedInstantSellDepth(levels, millionths).netMicroCopper;
		expect(netFor(20_000_001n)).toBe(16_999_999n);
		expect(netFor(33_333_333n)).toBe(28_333_332n);
		expect(netFor(99_999_999n)).toBe(84_999_999n);
	});

	/**
	 * The advisor's floor is charged per fee on the WHOLE expected gross, so a
	 * sliver of a unit still owes two full copper. On cheap outcomes that is not a
	 * rounding difference but a total write-off, and it is the documented
	 * conservative bound rather than an accident.
	 */
	it('pins what the advisor floor does to fractional expected units', () => {
		const levels = [{ unitCopper: 100, quantity: 1_000 }];
		const netFor = (millionths: bigint) => valueExpectedInstantSellDepth(levels, millionths).netMicroCopper;
		expect(netFor(10_000n)).toBe(0n);
		expect(netFor(100_000n)).toBe(8_000_000n);
		expect(netFor(1_000_000n)).toBe(85_000_000n);
	});
});
