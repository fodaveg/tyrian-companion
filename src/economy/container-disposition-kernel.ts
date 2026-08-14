import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import {
	calculateContainerExpectedValue,
	type ContainerMarketQuote,
	type ContainerTradingAccess,
} from './container-expected-value';
import { isContainerModel, type ContainerModelV1 } from './container-model';
import { createCatalogVendorValue, createTradingPostValueWithPolicy } from './gw2-fees';
const MICRO_COPPER = 1_000_000n;
const BASIS_POINTS = 10_000n;
const DAY_MS = 86_400_000;

export const CONTAINER_DISPOSITION_KERNEL_VERSION = 1 as const;

export type ContainerBindingEvidence = 'unbound' | 'account_bound' | 'character_bound' | 'unknown';

export interface ContainerDispositionKernelPolicy {
	version: 1;
	openAdvantageBps: number;
	maxPriceAgeMs: number;
	maxFutureSkewMs: number;
	saleBasis: 'immediate';
}

export const DEFAULT_CONTAINER_DISPOSITION_KERNEL_POLICY: ContainerDispositionKernelPolicy = {
	version: 1,
	openAdvantageBps: 1_000,
	maxPriceAgeMs: 15 * 60_000,
	maxFutureSkewMs: 60_000,
	saleBasis: 'immediate',
};

export interface ContainerDispositionMarketBatch {
	version: 1;
	batchId: string;
	capturedAt: string;
	source: 'gw2-commerce-prices';
	quotes: ContainerMarketQuote[];
}

export interface ContainerDispositionKernelInput {
	version: typeof CONTAINER_DISPOSITION_KERNEL_VERSION;
	asOf: string;
	quantity: number;
	container: {
		itemId: number;
		catalogItem: CatalogItem;
		binding: ContainerBindingEvidence;
		tradingAccess: ContainerTradingAccess;
	};
	model: ContainerModelV1;
	market: ContainerDispositionMarketBatch;
	policy: ContainerDispositionKernelPolicy;
}

export type ContainerDispositionKernelReason =
	| 'malformed_input'
	| 'evidence_mismatch'
	| 'price_stale'
	| 'price_future'
	| 'price_missing'
	| 'open_ev_partial'
	| 'container_not_sellable'
	| 'binding_unknown'
	| 'trading_access_unknown'
	| 'arithmetic_overflow'
	| 'model_ev_inconsistent';

export interface ContainerDispositionKernelDecision {
	action: 'open' | 'sell';
	quantity: number;
	sellRoute: 'instant_sell' | 'vendor';
}

export interface ContainerDispositionKernelExplanation {
	sellNow: {
		route: 'instant_sell' | 'vendor';
		unitCopper: number;
		grossCopper: number;
		listingFeeCopper: number;
		exchangeFeeCopper: number;
		totalFeesCopper: number;
		netCopper: number;
	};
	open: {
		evPerContainerMicroCopper: number;
		totalExpectedMicroCopper: string;
		coverage: 'complete';
		modelId: string;
		modelVersion: number;
		sampleContainers: number;
		excludedSampleUnits: number;
		rareTreatment: ContainerModelV1['uncertainty']['rareDropTreatment'];
	};
	threshold: {
		marginBps: number;
		requiredOpenMicroCopper: string;
	};
	comparison: {
		differenceMicroCopper: string;
		advantageBps: number | null;
		rule: 'open_at_or_above_threshold';
	};
	freshness: {
		asOf: string;
		priceCapturedAt: string;
		priceAgeMs: number;
	};
	caveats: string[];
}

export type ContainerDispositionKernelResult =
	| { status: 'ready'; decision: ContainerDispositionKernelDecision; explanation: ContainerDispositionKernelExplanation }
	| { status: 'review'; reason: ContainerDispositionKernelReason }
	| { status: 'invalid'; reason: ContainerDispositionKernelReason };

/**
 * Session-independent H4.10 economic kernel. It compares only a complete,
 * fresh immediate-sale floor with conservative opening EV and has no I/O.
 */
export function calculateContainerDispositionKernel(value: unknown): ContainerDispositionKernelResult {
	try {
		if (!isKernelInput(value)) return invalid('malformed_input');
		const input = value;
		const priceAgeMs = Date.parse(input.asOf) - Date.parse(input.market.capturedAt);
		if (priceAgeMs < -input.policy.maxFutureSkewMs) return review('price_future');
		if (priceAgeMs > input.policy.maxPriceAgeMs) return review('price_stale');

		const quote = input.market.quotes.find((entry) => entry.itemId === input.container.itemId) ?? null;
		const priceStatus = quote === null || quote.bidUnitCopper === null ? 'missing' : 'available';
		if (input.container.binding === 'unknown') return review('binding_unknown');
		const tpBindingEligible = input.container.binding === 'unbound'
			&& !input.container.catalogItem.flags.includes('AccountBound')
			&& !input.container.catalogItem.flags.includes('SoulbindOnAcquire');
		const tpAccessEligible = quote !== null
			&& (input.container.tradingAccess === 'full' || quote.whitelisted);
		if (input.container.tradingAccess === 'unknown' && quote !== null
			&& !quote.whitelisted && tpBindingEligible) return review('trading_access_unknown');
		const bidUnitCopper = quote?.bidUnitCopper ?? null;
		const tp = tpBindingEligible && tpAccessEligible && priceStatus === 'available' && bidUnitCopper !== null
			? createTradingPostValueWithPolicy('instant_sell', bidUnitCopper, input.quantity) : null;
		if (tp?.status === 'invalid') return invalid(tp.reason === 'arithmetic_overflow'
			? 'arithmetic_overflow' : 'model_ev_inconsistent');
		const vendor = createCatalogVendorValue(input.container.catalogItem, input.quantity);
		if (vendor.status === 'invalid') return invalid(vendor.reason === 'arithmetic_overflow'
			? 'arithmetic_overflow' : 'malformed_input');
		const tpValue = tp?.status === 'ok' ? tp.value : null;
		const vendorValue = vendor.status === 'ok' ? vendor.value : null;
		if (tpValue === null && vendorValue === null) return review(quote === null || quote.bidUnitCopper === null
			? 'price_missing' : 'container_not_sellable');
		const sell = tpValue !== null && (vendorValue === null || tpValue.netCopper >= vendorValue.netCopper)
			? {
				route: 'instant_sell' as const,
				unitCopper: tpValue.unitCopper,
				grossCopper: tpValue.grossCopper,
				listingFeeCopper: tpValue.listingFeeCopper,
				exchangeFeeCopper: tpValue.exchangeFeeCopper,
				totalFeesCopper: tpValue.totalFeesCopper,
				netCopper: tpValue.netCopper,
			} : {
				route: 'vendor' as const,
				unitCopper: vendorValue!.unitCopper,
				grossCopper: vendorValue!.grossCopper,
				listingFeeCopper: 0,
				exchangeFeeCopper: 0,
				totalFeesCopper: 0,
				netCopper: vendorValue!.netCopper,
			};

		const ev = calculateContainerExpectedValue(input.model, input.market.quotes, input.container.tradingAccess);
		if (ev.status === 'invalid') return invalid(ev.reason === 'arithmetic_overflow'
			? 'arithmetic_overflow' : 'model_ev_inconsistent');
		if (ev.value.modelId !== input.model.modelId || ev.value.modelVersion !== input.model.modelVersion
			|| ev.value.containerItemId !== input.container.itemId) return invalid('model_ev_inconsistent');
		if (ev.value.instant.coverage !== 'complete' || ev.value.instant.netMicroCopper === null) {
			return review('open_ev_partial');
		}
		const openTotal = BigInt(ev.value.instant.netMicroCopper) * BigInt(input.quantity);
		const sellMicro = BigInt(sell.netCopper) * MICRO_COPPER;
		const thresholdNumerator = sellMicro * (BASIS_POINTS + BigInt(input.policy.openAdvantageBps));
		const requiredOpen = divideRoundUp(thresholdNumerator, BASIS_POINTS);
		const opens = openTotal * BASIS_POINTS >= thresholdNumerator;
		const difference = openTotal - requiredOpen;
		const advantage = sellMicro === 0n ? null
			: safeBigIntNumber((openTotal - sellMicro) * BASIS_POINTS / sellMicro);
		return {
			status: 'ready',
			decision: { action: opens ? 'open' : 'sell', quantity: input.quantity, sellRoute: sell.route },
			explanation: {
				sellNow: sell,
				open: {
					evPerContainerMicroCopper: ev.value.instant.netMicroCopper,
					totalExpectedMicroCopper: openTotal.toString(),
					coverage: 'complete',
					modelId: input.model.modelId,
					modelVersion: input.model.modelVersion,
					sampleContainers: input.model.sample.containersOpened,
					excludedSampleUnits: ev.value.excluded.sampleUnits,
					rareTreatment: input.model.uncertainty.rareDropTreatment,
				},
				threshold: {
					marginBps: input.policy.openAdvantageBps,
					requiredOpenMicroCopper: requiredOpen.toString(),
				},
				comparison: {
					differenceMicroCopper: difference.toString(),
					advantageBps: advantage,
					rule: 'open_at_or_above_threshold',
				},
				freshness: { asOf: input.asOf, priceCapturedAt: input.market.capturedAt, priceAgeMs: Math.max(0, priceAgeMs) },
				caveats: [
					`model:${input.model.uncertainty.method}`,
					`rare_drops:${input.model.uncertainty.rareDropTreatment}`,
					...(input.model.excluded.length > 0 ? ['excluded_outcomes_not_valued'] : []),
					...(ev.value.listing.coverage === 'partial' ? ['listing_route_partial'] : []),
				].sort(),
			},
		};
	} catch {
		return invalid('malformed_input');
	}
}

function isKernelInput(value: unknown): value is ContainerDispositionKernelInput {
	if (!record(value) || !exactKeys(value, ['version', 'asOf', 'quantity', 'container', 'model', 'market', 'policy'])
		|| value.version !== CONTAINER_DISPOSITION_KERNEL_VERSION || !iso(value.asOf) || !positive(value.quantity)
		|| !record(value.container) || !exactKeys(value.container, ['itemId', 'catalogItem', 'binding', 'tradingAccess'])
		|| !positive(value.container.itemId) || !isNormalizedCatalogItem(value.container.catalogItem)
		|| value.container.catalogItem.id !== value.container.itemId
		|| !['unbound', 'account_bound', 'character_bound', 'unknown'].includes(String(value.container.binding))
		|| !['full', 'free_to_play', 'unknown'].includes(String(value.container.tradingAccess))
		|| !isContainerModel(value.model) || value.model.containerItemId !== value.container.itemId
		|| !isMarket(value.market) || !isPolicy(value.policy)) return false;
	return true;
}

function isMarket(value: unknown): value is ContainerDispositionMarketBatch {
	return record(value) && exactKeys(value, ['version', 'batchId', 'capturedAt', 'source', 'quotes'])
		&& value.version === 1 && text(value.batchId, 256) && iso(value.capturedAt)
		&& value.source === 'gw2-commerce-prices' && Array.isArray(value.quotes)
		&& value.quotes.every(isQuote)
		&& new Set(value.quotes.map((quote) => quote.itemId)).size === value.quotes.length;
}

function isQuote(value: unknown): value is ContainerMarketQuote {
	return record(value) && exactKeys(value, ['itemId', 'whitelisted', 'bidUnitCopper', 'askUnitCopper'])
		&& positive(value.itemId) && typeof value.whitelisted === 'boolean'
		&& (value.bidUnitCopper === null || positive(value.bidUnitCopper))
		&& (value.askUnitCopper === null || positive(value.askUnitCopper));
}

function isPolicy(value: unknown): value is ContainerDispositionKernelPolicy {
	return record(value) && exactKeys(value, ['version', 'openAdvantageBps', 'maxPriceAgeMs', 'maxFutureSkewMs', 'saleBasis'])
		&& value.version === 1 && nonNegative(value.openAdvantageBps) && value.openAdvantageBps <= 10_000
		&& integerRange(value.maxPriceAgeMs, 60_000, DAY_MS)
		&& integerRange(value.maxFutureSkewMs, 0, 15 * 60_000) && value.saleBasis === 'immediate';
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
	return (numerator + denominator - 1n) / denominator;
}

function safeBigIntNumber(value: bigint): number | null {
	return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function review(reason: ContainerDispositionKernelReason): ContainerDispositionKernelResult {
	return { status: 'review', reason };
}

function invalid(reason: ContainerDispositionKernelReason): ContainerDispositionKernelResult {
	return { status: 'invalid', reason };
}

function iso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function text(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim();
}

function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function integerRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
