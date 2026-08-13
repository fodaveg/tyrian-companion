import type { StorageDelta } from '../account/storage-delta-model';
import { isStorageDelta } from '../account/contamination';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import { createTradingPostValueWithPolicy } from './gw2-fees';
import { classifyItemLiquidity } from './item-liquidity';
import {
	isCopperValue,
	type TradingPostCopperValue,
	type VendorCopperValue,
} from './monetary';
import {
	isSessionPriceSnapshot,
	type SessionItemPrice,
	type SessionPriceSnapshot,
} from './session-price-snapshot';

export const SESSION_VALUATION_VERSION = 1 as const;
export const HALLOWEEN_TOT_BAG_ITEM_ID = 36038;

export type SessionBindingEvidence = 'unbound' | 'account_bound' | 'character_bound' | 'unknown';

export interface SessionValuationInput {
	sessionId: string;
	delta: StorageDelta;
	prices: SessionPriceSnapshot;
	catalogItems: Record<string, CatalogItem>;
	bindingByItem: Record<string, SessionBindingEvidence>;
	durationMs: number;
	sackItemIds: number[];
}

export interface SessionValuationLine {
	itemId: number;
	quantity: number;
	binding: SessionBindingEvidence;
	instantSell: TradingPostCopperValue | null;
	listing: TradingPostCopperValue | null;
	vendor: VendorCopperValue | null;
	immediateBestCopper: number | null;
	listingBestCopper: number | null;
	nonLiquid: boolean;
	reason: string | null;
}

export interface SessionValuation {
	version: typeof SESSION_VALUATION_VERSION;
	sessionId: string;
	priceCapturedAt: string;
	priceSource: SessionPriceSnapshot['source'];
	coverage: 'complete' | 'partial';
	durationMs: number;
	lines: SessionValuationLine[];
	totals: {
		itemImmediateCopper: number;
		itemListingCopper: number;
		coinNetCopper: number;
		observedImmediateCopper: number;
		observedListingCopper: number;
		nonLiquidItemKinds: number;
		nonLiquidQuantity: number;
	};
	rates: {
		sacks: number;
		sacksPerHourMilli: number;
		immediateCopperPerHour: number;
		listingCopperPerHour: number;
	};
	warnings: Array<'catalog_missing' | 'binding_unknown' | 'price_incomplete' | 'item_losses_not_valued'>;
}

export type SessionValuationResult =
	| { status: 'ok'; valuation: SessionValuation }
	| { status: 'invalid'; reason: string };

export function calculateSessionValuation(input: unknown): SessionValuationResult {
	if (!isInputShell(input)) return { status: 'invalid', reason: 'invalid_input' };
	const { sessionId, delta, prices, catalogItems, bindingByItem, durationMs, sackItemIds } = input;
	if (!isStorageDelta(delta) || delta.status === 'invalid' || !isSessionPriceSnapshot(prices, sessionId, delta)) {
		return { status: 'invalid', reason: 'evidence_mismatch' };
	}
	if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return { status: 'invalid', reason: 'invalid_duration' };
	if (!validIdList(sackItemIds)) return { status: 'invalid', reason: 'invalid_sack_ids' };
	if (!validCatalog(catalogItems) || !validBindings(bindingByItem)) return { status: 'invalid', reason: 'invalid_metadata' };

	const priceById = new Map(prices.items.map((price) => [price.itemId, price]));
	const missing = new Set(prices.missingItemIds);
	const warnings = new Set<SessionValuation['warnings'][number]>();
	if (prices.status !== 'complete') warnings.add('price_incomplete');
	if (delta.itemChanges.some((change) => change.delta < 0)) warnings.add('item_losses_not_valued');
	const lines: SessionValuationLine[] = [];
	for (const change of delta.itemChanges.filter((entry) => entry.delta > 0).sort((a, b) => a.id - b.id)) {
		const catalog = catalogItems[String(change.id)] ?? null;
		const binding = bindingByItem[String(change.id)] ?? 'unknown';
		const price = priceById.get(change.id) ?? null;
		if (catalog === null) warnings.add('catalog_missing');
		if (binding === 'unknown') warnings.add('binding_unknown');
		const line = valueLine(change.id, change.delta, catalog, binding, price, missing.has(change.id));
		if (!line) return { status: 'invalid', reason: 'valuation_arithmetic_invalid' };
		lines.push(line);
	}

	const itemImmediateCopper = sum(lines.map((line) => line.immediateBestCopper ?? 0));
	const itemListingCopper = sum(lines.map((line) => line.listingBestCopper ?? 0));
	const coinNetCopper = delta.currencyChanges.find((change) => change.id === 1)?.delta ?? 0;
	const observedImmediateCopper = addSigned(itemImmediateCopper, coinNetCopper);
	const observedListingCopper = addSigned(itemListingCopper, coinNetCopper);
	const sacks = sum(lines.filter((line) => sackItemIds.includes(line.itemId)).map((line) => line.quantity));
	const sacksScaled = sacks === null ? null : multiply(sacks, 1_000);
	const sacksPerHourMilli = sacksScaled === null ? null : rate(sacksScaled, durationMs);
	const immediateCopperPerHour = observedImmediateCopper === null ? null : rate(observedImmediateCopper, durationMs);
	const listingCopperPerHour = observedListingCopper === null ? null : rate(observedListingCopper, durationMs);
	if ([
		itemImmediateCopper, itemListingCopper, observedImmediateCopper, observedListingCopper,
		sacks, sacksPerHourMilli, immediateCopperPerHour, listingCopperPerHour,
	]
		.some((value) => value === null || !Number.isSafeInteger(value))) {
		return { status: 'invalid', reason: 'valuation_arithmetic_invalid' };
	}
	const valuation: SessionValuation = {
		version: SESSION_VALUATION_VERSION,
		sessionId,
		priceCapturedAt: prices.capturedAt,
		priceSource: prices.source,
		coverage: warnings.size === 0 ? 'complete' : 'partial',
		durationMs,
		lines,
		totals: {
			itemImmediateCopper: itemImmediateCopper!,
			itemListingCopper: itemListingCopper!,
			coinNetCopper,
			observedImmediateCopper: observedImmediateCopper!,
			observedListingCopper: observedListingCopper!,
			nonLiquidItemKinds: lines.filter((line) => line.nonLiquid).length,
			nonLiquidQuantity: lines.filter((line) => line.nonLiquid).reduce((total, line) => total + line.quantity, 0),
		},
		rates: {
			sacks: sacks!,
			sacksPerHourMilli: sacksPerHourMilli!,
			immediateCopperPerHour: immediateCopperPerHour!,
			listingCopperPerHour: listingCopperPerHour!,
		},
		warnings: [...warnings].sort(),
	};
	return isSessionValuation(valuation, delta, sackItemIds)
		? { status: 'ok', valuation }
		: { status: 'invalid', reason: 'valuation_arithmetic_invalid' };
}

export function isSessionValuation(
	value: unknown,
	delta: unknown,
	sackItemIds: unknown,
): value is SessionValuation {
	if (!isStorageDelta(delta) || delta.status === 'invalid' || !validIdList(sackItemIds) ||
		!isSessionValuationRecord(value, sackItemIds)) return false;
	const valuation = value;
	const positive = delta.itemChanges.filter((change) => change.delta > 0);
	const coinNetCopper = delta.currencyChanges.find((change) => change.id === 1)?.delta ?? 0;
	return valuation.lines.length === positive.length && valuation.lines.every((line, index) =>
		line.itemId === positive[index]!.id && line.quantity === positive[index]!.delta) &&
		valuation.totals.coinNetCopper === coinNetCopper &&
		valuation.warnings.includes('item_losses_not_valued') ===
			delta.itemChanges.some((change) => change.delta < 0);
}

/** Internal H4.5 invariants that remain verifiable without the originating storage delta. */
export function isSessionValuationRecord(value: unknown, sackItemIds: unknown): value is SessionValuation {
	if (!(isRecord(value) && exactKeys(value, [
		'version', 'sessionId', 'priceCapturedAt', 'priceSource', 'coverage', 'durationMs',
		'lines', 'totals', 'rates', 'warnings',
	]) && value.version === SESSION_VALUATION_VERSION && trimmed(value.sessionId, 256) &&
		validIso(value.priceCapturedAt) && value.priceSource === 'gw2-commerce-prices' &&
		(value.coverage === 'complete' || value.coverage === 'partial') && isQuantity(value.durationMs) &&
		Array.isArray(value.lines) && value.lines.every(isSessionValuationLine) &&
		Array.isArray(value.warnings) && value.warnings.every(isSessionValuationWarning) &&
		validIdList(sackItemIds))) return false;
	const valuation = value as unknown as SessionValuation;
	if (!valuation.lines.every((line, index) => index === 0 || valuation.lines[index - 1]!.itemId < line.itemId) ||
		!unique(valuation.warnings) || canonical(valuation.warnings) !== canonical([...valuation.warnings].sort()) ||
		(valuation.coverage === 'complete' ? valuation.warnings.length !== 0 : valuation.warnings.length === 0) ||
		(valuation.lines.some((line) => line.binding === 'unknown') &&
			!valuation.warnings.includes('binding_unknown')) ||
		!isValuationTotals(valuation.totals) || !isValuationRates(valuation.rates)) return false;
	const itemImmediateCopper = sum(valuation.lines.map((line) => line.immediateBestCopper ?? 0));
	const itemListingCopper = sum(valuation.lines.map((line) => line.listingBestCopper ?? 0));
	const observedImmediateCopper = addSigned(itemImmediateCopper, valuation.totals.coinNetCopper);
	const observedListingCopper = addSigned(itemListingCopper, valuation.totals.coinNetCopper);
	const nonLiquid = valuation.lines.filter((line) => line.nonLiquid);
	const nonLiquidQuantity = sum(nonLiquid.map((line) => line.quantity));
	const sacks = sum(valuation.lines.filter((line) => sackItemIds.includes(line.itemId)).map((line) => line.quantity));
	const sacksScaled = sacks === null ? null : multiply(sacks, 1_000);
	const sacksPerHourMilli = sacksScaled === null ? null : rate(sacksScaled, valuation.durationMs);
	const immediateCopperPerHour = observedImmediateCopper === null ? null : rate(observedImmediateCopper, valuation.durationMs);
	const listingCopperPerHour = observedListingCopper === null ? null : rate(observedListingCopper, valuation.durationMs);
	return itemImmediateCopper !== null && itemListingCopper !== null &&
		observedImmediateCopper !== null && observedListingCopper !== null && nonLiquidQuantity !== null &&
		sacks !== null && sacksPerHourMilli !== null && immediateCopperPerHour !== null && listingCopperPerHour !== null &&
		valuation.totals.itemImmediateCopper === itemImmediateCopper &&
		valuation.totals.itemListingCopper === itemListingCopper &&
		valuation.totals.observedImmediateCopper === observedImmediateCopper &&
		valuation.totals.observedListingCopper === observedListingCopper &&
		valuation.totals.nonLiquidItemKinds === nonLiquid.length &&
		valuation.totals.nonLiquidQuantity === nonLiquidQuantity &&
		valuation.rates.sacks === sacks && valuation.rates.sacksPerHourMilli === sacksPerHourMilli &&
		valuation.rates.immediateCopperPerHour === immediateCopperPerHour &&
		valuation.rates.listingCopperPerHour === listingCopperPerHour;
}

function valueLine(
	itemId: number,
	quantity: number,
	catalog: CatalogItem | null,
	binding: SessionBindingEvidence,
	price: SessionItemPrice | null,
	missingPrice: boolean,
): SessionValuationLine | null {
	const metadataBinding = binding === 'account_bound' ? 'Account'
		: binding === 'character_bound' ? 'Character'
			: binding === 'unknown' ? 'Unknown' : undefined;
	const priceStatus = price ? 'available' : missingPrice ? 'missing' : 'unavailable';
	const classified = classifyItemLiquidity({
		kind: 'item', itemId, quantity, state: 'loose',
		location: { source: 'bank', slot: 0 },
		metadata: metadataBinding ? { binding: metadataBinding } : {},
	}, catalog, priceStatus);
	if (classified.status === 'invalid') return null;
	const instantSell = classified.classification.tradingPost.status === 'eligible' && price?.bid
		? createTradingPostValueWithPolicy('instant_sell', price.bid.unitCopper, quantity) : null;
	const listing = classified.classification.tradingPost.status === 'eligible' && price?.ask
		? createTradingPostValueWithPolicy('listing', price.ask.unitCopper, quantity) : null;
	if (instantSell?.status === 'invalid' || listing?.status === 'invalid') return null;
	const vendor = classified.classification.vendor.status === 'eligible'
		? classified.classification.vendor.value : null;
	const immediateBestCopper = maximum(instantSell?.value.netCopper ?? null, vendor?.netCopper ?? null);
	const listingBestCopper = maximum(listing?.value.netCopper ?? null, vendor?.netCopper ?? null);
	return {
		itemId,
		quantity,
		binding,
		instantSell: instantSell?.status === 'ok' ? instantSell.value : null,
		listing: listing?.status === 'ok' ? listing.value : null,
		vendor,
		immediateBestCopper,
		listingBestCopper,
		nonLiquid: immediateBestCopper === null && listingBestCopper === null,
		reason: classified.classification.liquidGold.status === 'excluded'
			? classified.classification.liquidGold.value.reason : null,
	};
}

function maximum(left: number | null, right: number | null): number | null {
	if (left === null) return right;
	if (right === null) return left;
	return Math.max(left, right);
}

function sum(values: number[]): number | null {
	let total = 0;
	for (const value of values) {
		total += value;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}

function addSigned(left: number | null, right: number): number | null {
	if (left === null || !Number.isSafeInteger(right)) return null;
	const total = left + right;
	return Number.isSafeInteger(total) ? total : null;
}

function multiply(left: number, right: number): number | null {
	const result = left * right;
	return Number.isSafeInteger(result) ? result : null;
}

function rate(amount: number, durationMs: number): number | null {
	const scaled = multiply(amount, 3_600_000);
	if (scaled === null) return null;
	const result = Math.round(scaled / durationMs);
	return Number.isSafeInteger(result) ? result : null;
}

function isSessionValuationLine(value: unknown): value is SessionValuationLine {
	if (!(isRecord(value) && exactKeys(value, [
		'itemId', 'quantity', 'binding', 'instantSell', 'listing', 'vendor',
		'immediateBestCopper', 'listingBestCopper', 'nonLiquid', 'reason',
	]) && isPositiveId(value.itemId) && isQuantity(value.quantity) &&
		['unbound', 'account_bound', 'character_bound', 'unknown'].includes(String(value.binding)) &&
		(value.immediateBestCopper === null || isCopper(value.immediateBestCopper)) &&
		(value.listingBestCopper === null || isCopper(value.listingBestCopper)) &&
		typeof value.nonLiquid === 'boolean' &&
		(value.reason === null || trimmed(value.reason, 256)) &&
		isTradingPostRoute(value.instantSell, 'instant_sell', value.quantity) &&
		isTradingPostRoute(value.listing, 'listing', value.quantity) &&
		isVendorRoute(value.vendor, value.quantity))) return false;
	const line = value as unknown as SessionValuationLine;
	if (line.binding !== 'unbound' && (line.instantSell !== null || line.listing !== null)) return false;
	const immediateBestCopper = maximum(line.instantSell?.netCopper ?? null, line.vendor?.netCopper ?? null);
	const listingBestCopper = maximum(line.listing?.netCopper ?? null, line.vendor?.netCopper ?? null);
	return line.immediateBestCopper === immediateBestCopper && line.listingBestCopper === listingBestCopper &&
		line.nonLiquid === (immediateBestCopper === null && listingBestCopper === null);
}

function isTradingPostRoute(
	value: unknown,
	kind: 'instant_sell' | 'listing',
	quantity: number,
): value is TradingPostCopperValue | null {
	if (value === null) return true;
	if (!isCopperValue(value) || value.kind !== kind || value.quantity !== quantity) return false;
	const expected = createTradingPostValueWithPolicy(kind, value.unitCopper, quantity);
	return expected.status === 'ok' && canonical(expected.value) === canonical(value);
}

function isVendorRoute(value: unknown, quantity: number): value is VendorCopperValue | null {
	return value === null ||
		(isCopperValue(value) && value.kind === 'vendor' && value.quantity === quantity);
}

function isValuationTotals(value: unknown): value is SessionValuation['totals'] {
	return isRecord(value) && exactKeys(value, [
		'itemImmediateCopper', 'itemListingCopper', 'coinNetCopper', 'observedImmediateCopper',
		'observedListingCopper', 'nonLiquidItemKinds', 'nonLiquidQuantity',
	]) && isCopper(value.itemImmediateCopper) && isCopper(value.itemListingCopper) &&
		Number.isSafeInteger(value.coinNetCopper) && Number.isSafeInteger(value.observedImmediateCopper) &&
		Number.isSafeInteger(value.observedListingCopper) && isNonNegativeInteger(value.nonLiquidItemKinds) &&
		isNonNegativeInteger(value.nonLiquidQuantity);
}

function isValuationRates(value: unknown): value is SessionValuation['rates'] {
	return isRecord(value) && exactKeys(value, [
		'sacks', 'sacksPerHourMilli', 'immediateCopperPerHour', 'listingCopperPerHour',
	]) && isNonNegativeInteger(value.sacks) && isNonNegativeInteger(value.sacksPerHourMilli) &&
		Number.isSafeInteger(value.immediateCopperPerHour) && Number.isSafeInteger(value.listingCopperPerHour);
}

function isSessionValuationWarning(value: unknown): value is SessionValuation['warnings'][number] {
	return typeof value === 'string' &&
		['catalog_missing', 'binding_unknown', 'price_incomplete', 'item_losses_not_valued'].includes(value);
}

function isInputShell(value: unknown): value is SessionValuationInput {
	return isRecord(value)
		&& exactKeys(value, ['sessionId', 'delta', 'prices', 'catalogItems', 'bindingByItem', 'durationMs', 'sackItemIds'])
		&& typeof value.sessionId === 'string' && value.sessionId.length > 0
		&& isRecord(value.delta) && isRecord(value.prices)
		&& isRecord(value.catalogItems) && isRecord(value.bindingByItem)
		&& Array.isArray(value.sackItemIds);
}

function validCatalog(value: Record<string, CatalogItem>): boolean {
	return Object.entries(value).every(([key, item]) => String(item.id) === key && isNormalizedCatalogItem(item));
}

function validBindings(value: Record<string, SessionBindingEvidence>): boolean {
	return Object.entries(value).every(([key, binding]) => /^(?:0|[1-9]\d*)$/u.test(key)
		&& ['unbound', 'account_bound', 'character_bound', 'unknown'].includes(binding));
}

function validIdList(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((id, index) =>
		Number.isSafeInteger(id) && id > 0 && (index === 0 || value[index - 1]! < id));
}

function validIso(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function trimmed(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function isPositiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isQuantity(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCopper(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function unique<T>(values: T[]): boolean {
	return new Set(values).size === values.length;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (isRecord(value)) {
		return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
