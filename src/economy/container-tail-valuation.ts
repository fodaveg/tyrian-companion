import type { ContainerMarketQuote, ContainerTradingAccess } from './container-expected-value';
import { isContainerModel, type ContainerModelV1 } from './container-model';
import { calculateTradingPostFees } from './gw2-fees';

export const CONTAINER_TAIL_VALUATION_VERSION = 1 as const;
const MICRO_SCALE = 1_000_000n;

/**
 * Prices the outcomes the conservative model deliberately excludes.
 *
 * Nothing here enters the recommendation. The exclusion is a product decision
 * and it is the right one for deciding about a single bag: five infusions in
 * 106.264 openings cannot justify an expected value for one bag. But declaring
 * that value as zero and never showing it is a different claim, and a false
 * one: measured today the named tail is worth about a third of what opening a
 * bag actually returns. Whoever opens ten thousand bags a season is deciding
 * with that number missing.
 *
 * So the tail is computed, kept apart, and shipped with its standard
 * deviation, which is the honest counterweight: the deviation of one bag's
 * tail payout is two orders of magnitude larger than its mean, so the mean
 * only becomes a usable prediction after a number of bags nobody opens by
 * hand.
 */
export interface ContainerTailBasisValuationV1 {
	basis: 'immediate' | 'listing';
	/** Net expected copper per container from the priced part of the tail, in micro-copper. */
	evPerContainerMicroCopper: number;
	/** Standard deviation of one container's tail payout, in micro-copper. */
	deviationPerContainerMicroCopper: number;
	/** Named tail items with no usable price on this route; each counts as zero. */
	unpricedItemIds: number[];
}

export interface ContainerTailValuationV1 {
	version: typeof CONTAINER_TAIL_VALUATION_VERSION;
	modelId: string;
	modelVersion: number;
	containerItemId: number;
	sampleContainers: number;
	/** Every sample unit the model excludes, itemized or not. */
	bucketSampleUnits: number;
	/** The itemized subset. The remainder stays unvalued and is visible as the difference. */
	itemizedSampleUnits: number;
	immediate: ContainerTailBasisValuationV1;
	listing: ContainerTailBasisValuationV1;
}

export type ContainerTailValuationResult =
	| { status: 'ok'; value: ContainerTailValuationV1 }
	| { status: 'invalid'; reason: 'invalid_input' | 'arithmetic_overflow' };

export function calculateContainerTailValuation(
	modelValue: unknown,
	quotesValue: unknown,
	tradingAccessValue: unknown = 'unknown',
): ContainerTailValuationResult {
	if (!isContainerModel(modelValue) || !Array.isArray(quotesValue) || !quotesValue.every(isQuote)
		|| !isTradingAccess(tradingAccessValue)) return { status: 'invalid', reason: 'invalid_input' };
	const model: ContainerModelV1 = modelValue;
	const quoteById = new Map<number, ContainerMarketQuote>();
	for (const quote of quotesValue) {
		if (quoteById.has(quote.itemId)) return { status: 'invalid', reason: 'invalid_input' };
		quoteById.set(quote.itemId, quote);
	}
	const items = model.excluded.flatMap((bucket) => bucket.items);
	const immediate = valueBasis('instant_sell', model, items, quoteById, tradingAccessValue);
	if (immediate === null) return { status: 'invalid', reason: 'arithmetic_overflow' };
	const listing = valueBasis('listing', model, items, quoteById, tradingAccessValue);
	if (listing === null) return { status: 'invalid', reason: 'arithmetic_overflow' };
	const bucketSampleUnits = model.excluded.reduce((sum, bucket) => sum + bucket.sampleUnits, 0);
	const itemizedSampleUnits = items.reduce((sum, item) => sum + item.sampleUnits, 0);
	if (!Number.isSafeInteger(bucketSampleUnits) || !Number.isSafeInteger(itemizedSampleUnits)) {
		return { status: 'invalid', reason: 'arithmetic_overflow' };
	}
	return {
		status: 'ok',
		value: {
			version: CONTAINER_TAIL_VALUATION_VERSION,
			modelId: model.modelId,
			modelVersion: model.modelVersion,
			containerItemId: model.containerItemId,
			sampleContainers: model.sample.containersOpened,
			bucketSampleUnits,
			itemizedSampleUnits,
			immediate,
			listing,
		},
	};
}

/**
 * The mean uses the same estimator as the rest of the model —fees applied to
 * the whole sample, then divided by the containers opened— so the tail can be
 * added to the conservative figure without mixing two rounding conventions.
 * The deviation instead needs the value of ONE unit, because the payout of a
 * single bag is a count of whole units, never a fraction of the sample.
 */
function valueBasis(
	kind: 'instant_sell' | 'listing',
	model: ContainerModelV1,
	items: ReadonlyArray<{ id: number; label: string; sampleUnits: number }>,
	quoteById: ReadonlyMap<number, ContainerMarketQuote>,
	tradingAccess: ContainerTradingAccess,
): ContainerTailBasisValuationV1 | null {
	const containers = BigInt(model.sample.containersOpened);
	const unpricedItemIds: number[] = [];
	let netSampleMicro = 0n;
	let secondMomentMicro = 0n;
	for (const item of items) {
		const quote = quoteById.get(item.id);
		const usable = quote !== undefined && (tradingAccess === 'full' || quote.whitelisted) ? quote : null;
		const unitCopper = kind === 'instant_sell' ? usable?.bidUnitCopper ?? null : usable?.askUnitCopper ?? null;
		if (unitCopper === null) {
			unpricedItemIds.push(item.id);
			continue;
		}
		const sample = netAfterFees(unitCopper, item.sampleUnits);
		const unit = netAfterFees(unitCopper, 1);
		if (sample === null || unit === null) return null;
		netSampleMicro += sample * MICRO_SCALE;
		const unitMicro = unit * MICRO_SCALE;
		secondMomentMicro += BigInt(item.sampleUnits) * unitMicro * unitMicro;
	}
	const evPerContainer = divideRoundHalfUp(netSampleMicro, containers);
	const variance = divideRoundHalfUp(secondMomentMicro, containers);
	const deviation = integerSquareRoot(variance);
	const ev = safeNumber(evPerContainer);
	const sigma = safeNumber(deviation);
	if (ev === null || sigma === null) return null;
	return {
		basis: kind === 'instant_sell' ? 'immediate' : 'listing',
		evPerContainerMicroCopper: ev,
		deviationPerContainerMicroCopper: sigma,
		unpricedItemIds: [...unpricedItemIds].sort((left, right) => left - right),
	};
}

/**
 * Net copper for `units` at `unitCopper`, floored at zero.
 *
 * A drop worth less than the two one-copper minimum fees nets nothing; that is
 * a real answer, not an error. The shared helper refuses such a sale outright,
 * which is correct when somebody is about to press sell and wrong here, where
 * the question is what a probability distribution is worth.
 */
function netAfterFees(unitCopper: number, units: number): bigint | null {
	const gross = unitCopper * units;
	if (!Number.isSafeInteger(gross) || gross <= 0) return null;
	const fees = calculateTradingPostFees(gross);
	if (fees.status !== 'ok') return null;
	const net = BigInt(gross) - BigInt(fees.fees.totalFeesCopper);
	return net > 0n ? net : 0n;
}

/**
 * Floor of the square root of a non-negative bigint, by Newton's method. The
 * variance of a jackpot tail overflows a double long before it overflows a
 * bigint, and `Math.sqrt` on a converted double would quietly return a number
 * that is right in its first fifteen digits and wrong afterwards.
 */
export function integerSquareRoot(value: bigint): bigint {
	if (value < 0n) throw new Error('Integer square root is undefined for negative values.');
	if (value < 2n) return value;
	let guess = value;
	let next = (guess + 1n) / 2n;
	while (next < guess) {
		guess = next;
		next = (guess + value / guess) / 2n;
	}
	return guess;
}

function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
	const quotient = numerator / denominator;
	const remainder = numerator % denominator;
	return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function safeNumber(value: bigint): number | null {
	if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	return Number(value);
}

function isTradingAccess(value: unknown): value is ContainerTradingAccess {
	return value === 'full' || value === 'free_to_play' || value === 'unknown';
}

function isQuote(value: unknown): value is ContainerMarketQuote {
	return isRecord(value) && exactKeys(value, ['itemId', 'whitelisted', 'bidUnitCopper', 'askUnitCopper'])
		&& positiveInteger(value.itemId) && typeof value.whitelisted === 'boolean'
		&& (value.bidUnitCopper === null || positiveInteger(value.bidUnitCopper))
		&& (value.askUnitCopper === null || positiveInteger(value.askUnitCopper));
}

function positiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
