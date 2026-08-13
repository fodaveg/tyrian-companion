import { isContainerModel, type ContainerModelV1 } from './container-model';
import { createTradingPostValueWithPolicy, GW2_TRADING_POST_FEE_POLICY } from './gw2-fees';

export const CONTAINER_EXPECTED_VALUE_VERSION = 1 as const;
const MICRO_SCALE = 1_000_000n;

export interface ContainerMarketQuote {
	itemId: number;
	whitelisted: boolean;
	bidUnitCopper: number | null;
	askUnitCopper: number | null;
}

export interface ContainerExpectedValueLine {
	key: string;
	namespace: ContainerModelV1['outcomes'][number]['namespace'];
	id: number;
	label: string;
	expectedUnitsMillionths: number;
	policy: ContainerModelV1['outcomes'][number]['valuationPolicy'];
	instantNetMicroCopper: number | null;
	listingNetMicroCopper: number | null;
	excludedLiquidMicroCopper: number;
}

export interface ContainerExpectedValue {
	version: typeof CONTAINER_EXPECTED_VALUE_VERSION;
	modelId: string;
	modelVersion: number;
	containerItemId: number;
	feePolicyVersion: typeof GW2_TRADING_POST_FEE_POLICY.version;
	lines: ContainerExpectedValueLine[];
	instant: { coverage: 'complete' | 'partial'; knownNetMicroCopper: number; netMicroCopper: number | null };
	listing: { coverage: 'complete' | 'partial'; knownNetMicroCopper: number; netMicroCopper: number | null };
	excluded: { modeledUnitsMillionths: number; sampleUnits: number };
}

export type ContainerExpectedValueResult =
	| { status: 'ok'; value: ContainerExpectedValue }
	| { status: 'invalid'; reason: string };

export function calculateContainerExpectedValue(
	modelValue: unknown,
	quotesValue: unknown,
): ContainerExpectedValueResult {
	if (!isContainerModel(modelValue) || !Array.isArray(quotesValue) || !quotesValue.every(isQuote)) {
		return { status: 'invalid', reason: 'invalid_input' };
	}
	const model = modelValue;
	const quotes = quotesValue;
	const quoteById = new Map<number, ContainerMarketQuote>();
	for (const quote of quotes) {
		if (quoteById.has(quote.itemId)) return { status: 'invalid', reason: 'duplicate_quote' };
		quoteById.set(quote.itemId, quote);
	}

	let instantKnown = 0;
	let listingKnown = 0;
	let instantComplete = true;
	let listingComplete = true;
	let excludedUnits = 0;
	const lines: ContainerExpectedValueLine[] = [];
	for (const outcome of model.outcomes) {
		let instant: number | null = 0;
		let listing: number | null = 0;
		let excludedLiquidMicroCopper = 0;
		if (outcome.sampleUnits === 0) {
			// An unobserved outcome contributes exactly zero to this sample model and
			// does not need a market quote to make that zero complete.
		} else if (outcome.valuationPolicy === 'liquid_market') {
			const quote = quoteById.get(outcome.id);
			const instantResult = quote?.whitelisted === true && quote.bidUnitCopper !== null
				? marketSampleMicroCopper('instant_sell', outcome.sampleUnits, model.sample.containersOpened, quote.bidUnitCopper)
				: { status: 'missing' as const };
			const listingResult = quote?.whitelisted === true && quote.askUnitCopper !== null
				? marketSampleMicroCopper('listing', outcome.sampleUnits, model.sample.containersOpened, quote.askUnitCopper)
				: { status: 'missing' as const };
			if (instantResult.status === 'invalid') return instantResult;
			if (listingResult.status === 'invalid') return listingResult;
			instant = instantResult.status === 'ok' ? instantResult.value : null;
			listing = listingResult.status === 'ok' ? listingResult.value : null;
			if (instant === null) instantComplete = false;
			if (listing === null) listingComplete = false;
		} else if (outcome.valuationPolicy === 'direct_currency') {
			if (outcome.namespace === 'currency' && outcome.id === 1) {
				instant = outcome.expectedUnitsMillionths;
				listing = outcome.expectedUnitsMillionths;
			} else {
				instant = null;
				listing = null;
				instantComplete = false;
				listingComplete = false;
			}
		} else if (outcome.valuationPolicy === 'vendor_only' || outcome.valuationPolicy === 'defer') {
			instant = null;
			listing = null;
			instantComplete = false;
			listingComplete = false;
		} else {
			excludedUnits = safeAdd(excludedUnits, outcome.expectedUnitsMillionths) ?? Number.NaN;
		}
		if (instant !== null) instantKnown = safeAdd(instantKnown, instant) ?? Number.NaN;
		if (listing !== null) listingKnown = safeAdd(listingKnown, listing) ?? Number.NaN;
		if (!Number.isSafeInteger(instantKnown) || !Number.isSafeInteger(listingKnown)
			|| !Number.isSafeInteger(excludedUnits)) return { status: 'invalid', reason: 'arithmetic_overflow' };
		lines.push({
			key: outcome.key,
			namespace: outcome.namespace,
			id: outcome.id,
			label: outcome.label,
			expectedUnitsMillionths: outcome.expectedUnitsMillionths,
			policy: outcome.valuationPolicy,
			instantNetMicroCopper: instant,
			listingNetMicroCopper: listing,
			excludedLiquidMicroCopper,
		});
	}
	return {
		status: 'ok',
		value: {
			version: CONTAINER_EXPECTED_VALUE_VERSION,
			modelId: model.modelId,
			modelVersion: model.modelVersion,
			containerItemId: model.containerItemId,
			feePolicyVersion: GW2_TRADING_POST_FEE_POLICY.version,
			lines,
			instant: {
				coverage: instantComplete ? 'complete' : 'partial',
				knownNetMicroCopper: instantKnown,
				netMicroCopper: instantComplete ? instantKnown : null,
			},
			listing: {
				coverage: listingComplete ? 'complete' : 'partial',
				knownNetMicroCopper: listingKnown,
				netMicroCopper: listingComplete ? listingKnown : null,
			},
			excluded: {
				modeledUnitsMillionths: excludedUnits,
				sampleUnits: model.excluded.reduce((sum, entry) => sum + entry.sampleUnits, 0),
			},
		},
	};
}

function marketSampleMicroCopper(
	kind: 'instant_sell' | 'listing',
	sampleUnits: number,
	containersOpened: number,
	unitCopper: number,
): { status: 'ok'; value: number } | { status: 'invalid'; reason: 'arithmetic_overflow' | 'fees_exceed_gross' } {
	const valued = createTradingPostValueWithPolicy(kind, unitCopper, sampleUnits);
	if (valued.status !== 'ok') {
		return {
			status: 'invalid',
			reason: valued.reason === 'arithmetic_overflow' ? 'arithmetic_overflow' : 'fees_exceed_gross',
		};
	}
	const numerator = BigInt(valued.value.netCopper) * MICRO_SCALE;
	const divisor = BigInt(containersOpened);
	const quotient = numerator / divisor;
	const remainder = numerator % divisor;
	const result = Number(remainder * 2n >= divisor ? quotient + 1n : quotient);
	return Number.isSafeInteger(result)
		? { status: 'ok', value: result }
		: { status: 'invalid', reason: 'arithmetic_overflow' };
}

function isQuote(value: unknown): value is ContainerMarketQuote {
	return isRecord(value)
		&& exactKeys(value, ['itemId', 'whitelisted', 'bidUnitCopper', 'askUnitCopper'])
		&& positiveInteger(value.itemId)
		&& typeof value.whitelisted === 'boolean'
		&& (value.bidUnitCopper === null || positiveInteger(value.bidUnitCopper))
		&& (value.askUnitCopper === null || positiveInteger(value.askUnitCopper));
}

function safeAdd(left: number, right: number): number | null {
	const result = left + right;
	return Number.isSafeInteger(result) ? result : null;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
