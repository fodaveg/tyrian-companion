import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import {
	calculateContainerExpectedValue,
	type ContainerExpectedValue,
	type ContainerMarketQuote,
	type ContainerTradingAccess,
} from './container-expected-value';
import { containerModelPriceItemIds, isContainerModel, type ContainerModelV1 } from './container-model';
import {
	isInventoryMarketDepthEvidence,
	valueCompetitiveListing,
	valueExpectedInstantSellDepth,
	valueInstantSellDepth,
	type InventoryItemMarketDepthV1,
	type InventoryMarketDepthEvidenceV1,
} from './commerce-listings';
import {
	calculateContainerTailValuation,
	type ContainerTailValuationV1,
} from './container-tail-valuation';
import { calculateTradingPostFees, createCatalogVendorValue } from './gw2-fees';
const MICRO_COPPER = 1_000_000n;
const BASIS_POINTS = 10_000n;
const DAY_MS = 86_400_000;

export const CONTAINER_DISPOSITION_KERNEL_VERSION = 1 as const;

export type ContainerBindingEvidence = 'unbound' | 'account_bound' | 'character_bound' | 'unknown';

/**
 * `immediate` keeps the original single-route behaviour. `immediate_and_listing`
 * asks for the second basis as well, so the comparison is published as data
 * rather than as a version bump nobody can opt out of.
 */
export type ContainerSaleBasisPolicy = 'immediate' | 'immediate_and_listing';

export interface ContainerDispositionKernelPolicy {
	version: 1;
	openAdvantageBps: number;
	maxPriceAgeMs: number;
	maxFutureSkewMs: number;
	saleBasis: ContainerSaleBasisPolicy;
}

export const DEFAULT_CONTAINER_DISPOSITION_KERNEL_POLICY: ContainerDispositionKernelPolicy = {
	version: 1,
	openAdvantageBps: 1_000,
	maxPriceAgeMs: 15 * 60_000,
	maxFutureSkewMs: 60_000,
	saleBasis: 'immediate_and_listing',
};

export interface ContainerDispositionMarketBatch {
	version: 1;
	batchId: string;
	capturedAt: string;
	source: 'gw2-commerce-prices';
	quotes: ContainerMarketQuote[];
	depth: InventoryMarketDepthEvidenceV1 | null;
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
	| 'market_depth_missing'
	| 'market_depth_partial'
	| 'market_depth_stale'
	| 'market_depth_future'
	| 'open_ev_partial'
	| 'container_not_sellable'
	| 'binding_unknown'
	| 'trading_access_unknown'
	| 'arithmetic_overflow'
	| 'model_ev_inconsistent';

export type ContainerSaleRoute = 'instant_sell' | 'listing' | 'vendor';

export interface ContainerDispositionKernelDecision {
	action: 'open' | 'sell';
	quantity: number;
	sellRoute: ContainerSaleRoute;
}

export interface ContainerDispositionSaleValue {
	route: ContainerSaleRoute;
	unitCopper: number;
	grossCopper: number;
	listingFeeCopper: number;
	exchangeFeeCopper: number;
	totalFeesCopper: number;
	netCopper: number;
}

export interface ContainerDispositionOpenValue {
	evPerContainerMicroCopper: number;
	totalExpectedMicroCopper: string;
	/**
	 * `complete` means every modelled outcome had a counterparty. `declared_zero`
	 * means at least one outcome was MEASURED to have none —no buy order at all,
	 * or no listing to reference— and was therefore counted as exactly zero. That
	 * is a fact about the market, not missing evidence, and it is the difference
	 * between recommending and staying silent for an item whose six most common
	 * drops have zero demand all year.
	 */
	coverage: 'complete' | 'declared_zero';
	noCounterpartyItemIds: number[];
	modelId: string;
	modelVersion: number;
	sampleContainers: number;
	excludedSampleUnits: number;
	rareTreatment: ContainerModelV1['uncertainty']['rareDropTreatment'];
}

export interface ContainerDispositionThreshold {
	marginBps: number;
	requiredOpenMicroCopper: string;
}

export interface ContainerDispositionComparison {
	differenceMicroCopper: string;
	advantageBps: number | null;
	rule: 'open_at_or_above_threshold';
}

/** Disclosure only. It never moves the recommendation, which stays conservative. */
export interface ContainerDispositionOpenWithTail {
	evPerContainerMicroCopper: number;
	totalExpectedMicroCopper: string;
	deviationPerContainerMicroCopper: number;
	meetsThreshold: boolean;
}

export interface ContainerDispositionRoute {
	saleBasis: 'immediate' | 'listing';
	/**
	 * `guaranteed_buyer` consumed real buy orders level by level.
	 * `reference_listing` only read the best ask, which is a current asking
	 * price and neither demand nor a promise of execution.
	 */
	execution: 'guaranteed_buyer' | 'reference_listing';
	sellNow: ContainerDispositionSaleValue;
	open: ContainerDispositionOpenValue;
	threshold: ContainerDispositionThreshold;
	comparison: ContainerDispositionComparison;
	decision: { action: 'open' | 'sell'; sellRoute: ContainerSaleRoute };
	openIncludingTail: ContainerDispositionOpenWithTail | null;
}

export interface ContainerDispositionKernelExplanation {
	sellNow: ContainerDispositionSaleValue;
	open: ContainerDispositionOpenValue;
	threshold: ContainerDispositionThreshold;
	comparison: ContainerDispositionComparison;
	freshness: {
		asOf: string;
		priceCapturedAt: string;
		priceAgeMs: number;
	};
	caveats: string[];
	/** The basis the headline decision came from; a reference route only wins when nothing executable exists. */
	preferredSaleBasis: 'immediate' | 'listing';
	routes: ContainerDispositionRoute[];
	tail: ContainerTailValuationV1 | null;
}

export type ContainerDispositionKernelResult =
	| { status: 'ready'; decision: ContainerDispositionKernelDecision; explanation: ContainerDispositionKernelExplanation }
	| { status: 'review'; reason: ContainerDispositionKernelReason }
	| { status: 'invalid'; reason: ContainerDispositionKernelReason };

/**
 * Session-independent H4.10 economic kernel. It has no I/O and compares
 * conservative opening EV against every fresh sale basis its policy declares.
 */
export function calculateContainerDispositionKernel(value: unknown): ContainerDispositionKernelResult {
	try {
		if (!isKernelInput(value)) return invalid('malformed_input');
		const input = value;
		const priceAgeMs = Date.parse(input.asOf) - Date.parse(input.market.capturedAt);
		if (priceAgeMs < -input.policy.maxFutureSkewMs) return review('price_future');
		if (priceAgeMs > input.policy.maxPriceAgeMs) return review('price_stale');
		if (input.market.depth === null) return review('market_depth_missing');
		const depthAgeMs = Date.parse(input.asOf) - Date.parse(input.market.depth.capturedAt);
		if (depthAgeMs < -input.policy.maxFutureSkewMs) return review('market_depth_future');
		if (depthAgeMs > input.policy.maxPriceAgeMs) return review('market_depth_stale');
		if (!depthBinding(input.market.depth, input.model)) return review('market_depth_partial');

		const quote = input.market.quotes.find((entry) => entry.itemId === input.container.itemId) ?? null;
		if (input.container.binding === 'unknown') return review('binding_unknown');
		const tpBindingEligible = input.container.binding === 'unbound'
			&& !input.container.catalogItem.flags.includes('AccountBound')
			&& !input.container.catalogItem.flags.includes('SoulbindOnAcquire');
		const tpAccessEligible = quote !== null
			&& (input.container.tradingAccess === 'full' || quote.whitelisted);
		if (input.container.tradingAccess === 'unknown' && quote !== null
			&& !quote.whitelisted && tpBindingEligible) return review('trading_access_unknown');
		const containerDepth = input.market.depth.items.find((entry) => entry.itemId === input.container.itemId)!;
		const tradeable = tpBindingEligible && tpAccessEligible;
		const hasQuotedSide = quote !== null && (quote.bidUnitCopper !== null || quote.askUnitCopper !== null);
		if (tradeable && hasQuotedSide && containerDepth.coverage !== 'complete') return review('market_depth_partial');
		const vendor = createCatalogVendorValue(input.container.catalogItem, input.quantity);
		if (vendor.status === 'invalid') return invalid(vendor.reason === 'arithmetic_overflow'
			? 'arithmetic_overflow' : 'malformed_input');
		const vendorValue = vendor.status === 'ok' ? {
			route: 'vendor' as const,
			unitCopper: vendor.value.unitCopper,
			grossCopper: vendor.value.grossCopper,
			listingFeeCopper: 0,
			exchangeFeeCopper: 0,
			totalFeesCopper: 0,
			netCopper: vendor.value.netCopper,
		} : null;

		const immediateSale = instantSaleValue(
			tradeable && quote !== null && quote.bidUnitCopper !== null, containerDepth, input.quantity,
		);
		if (immediateSale === 'invalid') return invalid('arithmetic_overflow');
		if (immediateSale === 'partial') return review('market_depth_partial');
		const listingSale = input.policy.saleBasis === 'immediate_and_listing'
			? listingSaleValue(tradeable && quote !== null && quote.askUnitCopper !== null, containerDepth, input.quantity)
			: null;
		if (listingSale === 'invalid') return invalid('arithmetic_overflow');
		// The vendor is an instant counter, so it competes inside the immediate
		// basis only. The listing basis is exactly what publishing at the best ask
		// returns; folding a vendor sale into it would label an instant sale as a
		// listing and hide the very difference this second row exists to show.
		const immediateSell = bestSale(immediateSale, vendorValue);
		const listingSell = listingSale;
		if (immediateSell === null && listingSell === null) {
			return review(quote === null || !hasQuotedSide ? 'price_missing' : 'container_not_sellable');
		}

		const ev = calculateContainerExpectedValue(input.model, input.market.quotes, input.container.tradingAccess);
		if (ev.status === 'invalid') return invalid(ev.reason === 'arithmetic_overflow'
			? 'arithmetic_overflow' : 'model_ev_inconsistent');
		if (ev.value.modelId !== input.model.modelId || ev.value.modelVersion !== input.model.modelVersion
			|| ev.value.containerItemId !== input.container.itemId) return invalid('model_ev_inconsistent');
		const tailResult = calculateContainerTailValuation(
			input.model, input.market.quotes, input.container.tradingAccess,
		);
		if (tailResult.status === 'invalid') return invalid(tailResult.reason === 'arithmetic_overflow'
			? 'arithmetic_overflow' : 'model_ev_inconsistent');
		const tail = input.policy.saleBasis === 'immediate_and_listing' ? tailResult.value : null;

		const immediateOpen = openAtDepth(
			input.model, input.market.quotes, input.container.tradingAccess, input.market.depth, input.quantity,
		);
		if (immediateOpen === 'invalid') return invalid('arithmetic_overflow');
		const listingOpen = input.policy.saleBasis === 'immediate_and_listing'
			? openAtListing(ev.value, input.container.tradingAccess, input.market.quotes, input.quantity)
			: null;
		if (listingOpen === 'invalid') return invalid('arithmetic_overflow');

		const routes: ContainerDispositionRoute[] = [];
		const immediateRoute = immediateSell === null || !isOpenTotal(immediateOpen) ? null : buildRoute(
			'immediate', 'guaranteed_buyer', immediateSell, immediateOpen, input, ev.value,
			tailResult.value.immediate.evPerContainerMicroCopper,
			tailResult.value.immediate.deviationPerContainerMicroCopper, tail !== null,
		);
		if (immediateRoute === 'invalid') return invalid('arithmetic_overflow');
		if (immediateRoute !== null) routes.push(immediateRoute);
		const listingRoute = listingSell === null || !isOpenTotal(listingOpen) ? null : buildRoute(
			'listing', 'reference_listing', listingSell, listingOpen, input, ev.value,
			tailResult.value.listing.evPerContainerMicroCopper,
			tailResult.value.listing.deviationPerContainerMicroCopper, tail !== null,
		);
		if (listingRoute === 'invalid') return invalid('arithmetic_overflow');
		if (listingRoute !== null) routes.push(listingRoute);
		if (routes.length === 0) {
			const blocked = immediateSell !== null ? partialKind(immediateOpen)
				: listingSell !== null ? partialKind(listingOpen) : null;
			return review(blocked === 'depth' ? 'market_depth_partial'
				: blocked === 'quote' ? 'open_ev_partial' : 'container_not_sellable');
		}

		// An asking price is a reference, never demand. The executable basis wins
		// whenever it exists; the listing basis only leads when nothing can be sold
		// on the spot, and it says so through `preferredSaleBasis`.
		const preferred = immediateRoute ?? listingRoute!;
		return {
			status: 'ready',
			decision: {
				action: preferred.decision.action,
				quantity: input.quantity,
				sellRoute: preferred.decision.sellRoute,
			},
			explanation: {
				sellNow: preferred.sellNow,
				open: preferred.open,
				threshold: preferred.threshold,
				comparison: preferred.comparison,
				freshness: { asOf: input.asOf, priceCapturedAt: input.market.capturedAt, priceAgeMs: Math.max(0, priceAgeMs) },
				caveats: [
					`model:${input.model.uncertainty.method}`,
					`rare_drops:${input.model.uncertainty.rareDropTreatment}`,
					...(input.model.excluded.length > 0 ? ['excluded_outcomes_not_valued'] : []),
					...(ev.value.listing.coverage === 'partial' ? ['listing_route_partial'] : []),
					...(routes.some((route) => route.open.coverage === 'declared_zero')
						? ['outcomes_without_counterparty_valued_at_zero'] : []),
					...(listingRoute === null ? [] : ['listing_route_is_reference_not_demand']),
					...(preferred.saleBasis === 'listing' ? ['no_immediate_sale_route'] : []),
				].sort(),
				preferredSaleBasis: preferred.saleBasis,
				routes,
				tail,
			},
		};
	} catch {
		return invalid('malformed_input');
	}
}

function buildRoute(
	saleBasis: 'immediate' | 'listing',
	execution: 'guaranteed_buyer' | 'reference_listing',
	sell: ContainerDispositionSaleValue,
	open: OpenTotal,
	input: ContainerDispositionKernelInput,
	ev: ContainerExpectedValue,
	tailPerContainerMicro: number,
	tailDeviationMicro: number,
	withTail: boolean,
): ContainerDispositionRoute | 'invalid' {
	const openTotal = open.totalMicroCopper;
	const perContainer = openTotal / BigInt(input.quantity);
	const perContainerNumber = safeBigIntNumber(perContainer);
	if (perContainerNumber === null || perContainerNumber < 0) return 'invalid';
	const sellMicro = BigInt(sell.netCopper) * MICRO_COPPER;
	const thresholdNumerator = sellMicro * (BASIS_POINTS + BigInt(input.policy.openAdvantageBps));
	const requiredOpen = divideRoundUp(thresholdNumerator, BASIS_POINTS);
	const opens = openTotal * BASIS_POINTS >= thresholdNumerator;
	const advantage = sellMicro === 0n ? null
		: safeBigIntNumber((openTotal - sellMicro) * BASIS_POINTS / sellMicro);
	const tailTotal = BigInt(tailPerContainerMicro) * BigInt(input.quantity);
	const withTailPerContainer = safeBigIntNumber(perContainer + BigInt(tailPerContainerMicro));
	if (withTail && withTailPerContainer === null) return 'invalid';
	return {
		saleBasis,
		execution,
		sellNow: sell,
		open: {
			evPerContainerMicroCopper: perContainerNumber,
			totalExpectedMicroCopper: openTotal.toString(),
			coverage: open.noCounterpartyItemIds.length === 0 ? 'complete' : 'declared_zero',
			noCounterpartyItemIds: [...open.noCounterpartyItemIds].sort((left, right) => left - right),
			modelId: input.model.modelId,
			modelVersion: input.model.modelVersion,
			sampleContainers: input.model.sample.containersOpened,
			excludedSampleUnits: ev.excluded.sampleUnits,
			rareTreatment: input.model.uncertainty.rareDropTreatment,
		},
		threshold: {
			marginBps: input.policy.openAdvantageBps,
			requiredOpenMicroCopper: requiredOpen.toString(),
		},
		comparison: {
			differenceMicroCopper: (openTotal - requiredOpen).toString(),
			advantageBps: advantage,
			rule: 'open_at_or_above_threshold',
		},
		decision: { action: opens ? 'open' : 'sell', sellRoute: sell.route },
		openIncludingTail: withTail && withTailPerContainer !== null ? {
			evPerContainerMicroCopper: withTailPerContainer,
			totalExpectedMicroCopper: (openTotal + tailTotal).toString(),
			deviationPerContainerMicroCopper: tailDeviationMicro,
			meetsThreshold: (openTotal + tailTotal) * BASIS_POINTS >= thresholdNumerator,
		} : null,
	};
}

function bestSale(
	market: ContainerDispositionSaleValue | null,
	vendor: ContainerDispositionSaleValue | null,
): ContainerDispositionSaleValue | null {
	if (market === null) return vendor;
	if (vendor === null) return market;
	return market.netCopper >= vendor.netCopper ? market : vendor;
}

function instantSaleValue(
	eligible: boolean,
	depth: InventoryItemMarketDepthV1,
	quantity: number,
): ContainerDispositionSaleValue | null | 'partial' | 'invalid' {
	if (!eligible) return null;
	const valued = valueInstantSellDepth(depth.buys, quantity);
	if (valued.status === 'invalid') return 'invalid';
	if (valued.status === 'partial') return 'partial';
	if (valued.status !== 'complete' || valued.grossCopper === null || valued.netCopper === null) return null;
	const fees = calculateTradingPostFees(valued.grossCopper);
	if (fees.status !== 'ok') return 'invalid';
	return {
		route: 'instant_sell',
		unitCopper: depth.buys[0]!.unitCopper,
		grossCopper: valued.grossCopper,
		listingFeeCopper: fees.fees.listingFeeCopper,
		exchangeFeeCopper: fees.fees.exchangeFeeCopper,
		totalFeesCopper: fees.fees.totalFeesCopper,
		netCopper: valued.netCopper,
	};
}

/**
 * A listing does not consume the sell side: the quantity already on offer is
 * competition, not buyer capacity. So the whole free stack is valued at the
 * single best ask, exactly as H9.2 already does elsewhere.
 */
function listingSaleValue(
	eligible: boolean,
	depth: InventoryItemMarketDepthV1,
	quantity: number,
): ContainerDispositionSaleValue | null | 'invalid' {
	if (!eligible) return null;
	const valued = valueCompetitiveListing(depth.sells, quantity);
	if (valued.status === 'invalid') return 'invalid';
	if (valued.status !== 'complete' || valued.grossCopper === null || valued.netCopper === null
		|| valued.unitCopper === null) return null;
	const fees = calculateTradingPostFees(valued.grossCopper);
	if (fees.status !== 'ok') return 'invalid';
	return {
		route: 'listing',
		unitCopper: valued.unitCopper,
		grossCopper: valued.grossCopper,
		listingFeeCopper: fees.fees.listingFeeCopper,
		exchangeFeeCopper: fees.fees.exchangeFeeCopper,
		totalFeesCopper: fees.fees.totalFeesCopper,
		netCopper: valued.netCopper,
	};
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
	return record(value) && exactKeys(value, ['version', 'batchId', 'capturedAt', 'source', 'quotes', 'depth'])
		&& value.version === 1 && text(value.batchId, 256) && iso(value.capturedAt)
		&& value.source === 'gw2-commerce-prices' && Array.isArray(value.quotes)
		&& value.quotes.every(isQuote)
		&& new Set(value.quotes.map((quote) => quote.itemId)).size === value.quotes.length
		&& (value.depth === null || isInventoryMarketDepthEvidence(value.depth));
}

function depthBinding(depth: InventoryMarketDepthEvidenceV1, model: ContainerModelV1): boolean {
	return sameNumbers(depth.requestedItemIds, containerModelPriceItemIds(model));
}

interface OpenTotal {
	totalMicroCopper: bigint;
	noCounterpartyItemIds: number[];
}

/**
 * Two different partials. `depth` means the order book itself was incomplete;
 * `quote` means the price batch was. They map to different review reasons
 * because they send the user to different evidence, and collapsing them would
 * report a stale listings capture as a broken model.
 */
type OpenOutcome = OpenTotal | { partial: 'depth' | 'quote' } | 'invalid';

function isOpenTotal(value: OpenOutcome | null): value is OpenTotal {
	return value !== null && value !== 'invalid' && !('partial' in value);
}

function partialKind(value: OpenOutcome | null): 'depth' | 'quote' | null {
	return value !== null && value !== 'invalid' && 'partial' in value ? value.partial : null;
}

/**
 * Immediate opening EV against real buy depth.
 *
 * An outcome whose quote is present, usable and complete but carries no bid AND
 * no buy level is not missing evidence: it is a measured absence of demand, so
 * it contributes exactly zero and is named. An outcome whose two captures
 * disagree —a bid with no levels, or levels with no bid— stays partial, because
 * that is genuinely unknown.
 */
function openAtDepth(
	model: ContainerModelV1,
	quotes: ContainerMarketQuote[],
	tradingAccess: ContainerTradingAccess,
	depth: InventoryMarketDepthEvidenceV1,
	quantity: number,
): OpenOutcome {
	const quoteById = new Map(quotes.map((quote) => [quote.itemId, quote]));
	const depthById = new Map(depth.items.map((item) => [item.itemId, item]));
	const noCounterpartyItemIds: number[] = [];
	let total = 0n;
	for (const outcome of model.outcomes) {
		if (outcome.sampleUnits === 0 || outcome.valuationPolicy === 'excluded') continue;
		if (outcome.valuationPolicy === 'direct_currency' && outcome.namespace === 'currency' && outcome.id === 1) {
			total += BigInt(outcome.expectedUnitsMillionths) * BigInt(quantity);
			continue;
		}
		if (outcome.valuationPolicy !== 'liquid_market') return { partial: 'quote' };
		const quote = quoteById.get(outcome.id);
		const itemDepth = depthById.get(outcome.id);
		if (quote === undefined || (tradingAccess !== 'full' && !quote.whitelisted)) return { partial: 'quote' };
		if (itemDepth?.coverage !== 'complete') return { partial: 'depth' };
		if (quote.bidUnitCopper === null) {
			if (itemDepth.buys.length > 0) return { partial: 'quote' };
			noCounterpartyItemIds.push(outcome.id);
			continue;
		}
		const requested = BigInt(outcome.expectedUnitsMillionths) * BigInt(quantity);
		const demonstrated = valueExpectedInstantSellDepth(itemDepth.buys, requested);
		if (demonstrated.status === 'invalid') return 'invalid';
		if (demonstrated.status !== 'complete' || demonstrated.netMicroCopper === null) return { partial: 'depth' };
		total += demonstrated.netMicroCopper;
	}
	return { totalMicroCopper: total, noCounterpartyItemIds };
}

/**
 * Listing opening EV at the best ask of every outcome. It reuses the already
 * validated per-sample arithmetic instead of consuming sell depth, for the same
 * reason the container itself is not consumed: sell levels are competition.
 */
function openAtListing(
	ev: ContainerExpectedValue,
	tradingAccess: ContainerTradingAccess,
	quotes: ContainerMarketQuote[],
	quantity: number,
): OpenOutcome {
	const quoteById = new Map(quotes.map((quote) => [quote.itemId, quote]));
	const noCounterpartyItemIds: number[] = [];
	let perContainer = 0n;
	for (const line of ev.lines) {
		if (line.policy === 'excluded') continue;
		if (line.listingNetMicroCopper !== null) {
			perContainer += BigInt(line.listingNetMicroCopper);
			continue;
		}
		if (line.policy !== 'liquid_market') return { partial: 'quote' };
		const quote = quoteById.get(line.id);
		// An ask that exists must have produced a number upstream; if it did not,
		// the two readings disagree and the total stays unknown instead of zero.
		if (quote === undefined || (tradingAccess !== 'full' && !quote.whitelisted)
			|| quote.askUnitCopper !== null) return { partial: 'quote' };
		noCounterpartyItemIds.push(line.id);
	}
	return { totalMicroCopper: perContainer * BigInt(quantity), noCounterpartyItemIds };
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
		&& integerRange(value.maxFutureSkewMs, 0, 15 * 60_000)
		&& (value.saleBasis === 'immediate' || value.saleBasis === 'immediate_and_listing');
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
	return (numerator + denominator - 1n) / denominator;
}

function safeBigIntNumber(value: bigint): number | null {
	return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function sameNumbers(left: number[], right: number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
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
