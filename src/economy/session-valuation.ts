import type { StorageDelta } from '../account/storage-delta-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import { createTradingPostValueWithPolicy } from './gw2-fees';
import { classifyItemLiquidity } from './item-liquidity';
import type { TradingPostCopperValue, VendorCopperValue } from './monetary';
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
	if (delta.status === 'invalid' || !isSessionPriceSnapshot(prices, sessionId, delta)) {
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
	return { status: 'ok', valuation };
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

function validIdList(value: number[]): boolean {
	return value.every((id, index) => Number.isSafeInteger(id) && id > 0 && (index === 0 || value[index - 1]! < id));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
