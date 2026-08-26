import type { ItemHolding, ItemLocation, ItemMetadata } from '../account/storage-snapshot-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { isNormalizedCatalogItem } from '../catalog/public-catalog-validators';
import { createCatalogVendorValue } from './gw2-fees';
import {
	createNonLiquidCopperValue,
	isCopperValue,
	type NonLiquidCopperValue,
	type VendorCopperValue,
} from './monetary';

export const ITEM_LIQUIDITY_CLASSIFICATION_VERSION = 1 as const;

export type TradingPostPriceStatus = 'available' | 'missing' | 'invalid' | 'unavailable';
export type BindingClassification =
	| { kind: 'unbound'; source: 'holding' }
	| { kind: 'account_bound'; source: 'holding' | 'catalog' }
	| { kind: 'character_bound'; source: 'holding' | 'catalog' }
	| { kind: 'unknown'; source: 'holding' | 'catalog_missing' };

export type TradingPostExclusionReason =
	| 'current_state_unavailable'
	| 'account_bound'
	| 'character_bound'
	| 'binding_unknown'
	| 'catalog_missing'
	| 'price_missing'
	| 'price_invalid'
	| 'price_unavailable';

export type VendorExclusionReason =
	| 'current_state_unavailable'
	| 'catalog_missing'
	| 'vendor_sale_forbidden'
	| 'no_vendor_value';

export type TradingPostEligibility =
	| { status: 'eligible' }
	| { status: 'excluded'; reason: TradingPostExclusionReason };

export type VendorEligibility =
	| { status: 'eligible'; value: VendorCopperValue }
	| { status: 'excluded'; reason: VendorExclusionReason };

export type LiquidGoldRoute = 'trading_post' | 'vendor';

export type LiquidGoldClassification =
	| {
		status: 'eligible';
		routes: LiquidGoldRoute[];
		vendorFloor: VendorCopperValue | null;
	}
	| {
		status: 'excluded';
		routes: [];
		value: NonLiquidCopperValue;
	};

export interface ItemLiquidityClassification {
	version: typeof ITEM_LIQUIDITY_CLASSIFICATION_VERSION;
	itemId: number;
	quantity: number;
	access: 'available' | 'claim_required' | 'current_state_unavailable';
	binding: BindingClassification;
	tradingPost: TradingPostEligibility;
	vendor: VendorEligibility;
	liquidGold: LiquidGoldClassification;
}

export type ItemLiquidityClassificationResult =
	| { status: 'ok'; classification: ItemLiquidityClassification }
	| {
		status: 'invalid';
		reason:
			| 'invalid_holding'
			| 'invalid_catalog_item'
			| 'catalog_item_mismatch'
			| 'invalid_price_status';
	};

export function classifyItemLiquidity(
	holding: unknown,
	catalogItem: unknown,
	tradingPostPriceStatus: unknown,
): ItemLiquidityClassificationResult {
	if (!isNormalizedItemHolding(holding)) {
		return { status: 'invalid', reason: 'invalid_holding' };
	}
	const normalizedHolding = holding;
	if (catalogItem !== null && !isNormalizedCatalogItem(catalogItem)) {
		return { status: 'invalid', reason: 'invalid_catalog_item' };
	}
	if (catalogItem !== null && catalogItem.id !== normalizedHolding.itemId) {
		return { status: 'invalid', reason: 'catalog_item_mismatch' };
	}
	if (!isTradingPostPriceStatus(tradingPostPriceStatus)) {
		return { status: 'invalid', reason: 'invalid_price_status' };
	}

	const access = classifyAccess(normalizedHolding.state);
	const binding = classifyBinding(normalizedHolding.metadata.binding, catalogItem);
	const tradingPost = classifyTradingPost(access, binding, catalogItem, tradingPostPriceStatus);
	const vendor = classifyVendor(access, normalizedHolding.quantity, catalogItem);
	const routes: LiquidGoldRoute[] = [];
	if (tradingPost.status === 'eligible') routes.push('trading_post');
	if (vendor.status === 'eligible') routes.push('vendor');
	const liquidGold = routes.length > 0
		? {
			status: 'eligible' as const,
			routes,
			vendorFloor: vendor.status === 'eligible' ? vendor.value : null,
		}
		: excludedLiquidGold(normalizedHolding.quantity, tradingPost, vendor);

	return {
		status: 'ok',
		classification: {
			version: ITEM_LIQUIDITY_CLASSIFICATION_VERSION,
			itemId: normalizedHolding.itemId,
			quantity: normalizedHolding.quantity,
			access,
			binding,
			tradingPost,
			vendor,
			liquidGold,
		},
	};
}

/**
 * Whether an item that trading-post/binding classification already marks eligible can
 * actually be sold or listed by THIS account. A free-to-play account is restricted to
 * the game's trading-post whitelist; a full account trades anything the trading post
 * itself allows. This is the single source of truth for that rule: the Inventory
 * Advisor's market route and the durable Vault sync both call it instead of
 * re-deriving the whitelist condition by hand, which is what let the Vault sync apply
 * the free-to-play whitelist to full accounts too.
 */
export function isTradingPostAccessible(
	tradingPost: TradingPostEligibility,
	tradingPostAccess: 'full' | 'free_to_play' | 'unknown',
	whitelisted: boolean,
): boolean {
	return tradingPost.status === 'eligible'
		&& (tradingPostAccess === 'full' || (tradingPostAccess === 'free_to_play' && whitelisted));
}

export function isItemLiquidityClassification(value: unknown): value is ItemLiquidityClassification {
	if (!isRecord(value)
		|| !exactKeys(value, [
			'version', 'itemId', 'quantity', 'access', 'binding', 'tradingPost', 'vendor', 'liquidGold',
		])
		|| value.version !== ITEM_LIQUIDITY_CLASSIFICATION_VERSION
		|| !isPositiveInteger(value.itemId)
		|| !isPositiveInteger(value.quantity)
		|| !isAccess(value.access)
		|| !isBindingClassification(value.binding)
		|| !isTradingPostEligibility(value.tradingPost)
		|| !isVendorEligibility(value.vendor)
		|| !isLiquidGoldClassification(value.liquidGold)) return false;
	if (value.access === 'current_state_unavailable') {
		if (value.tradingPost.status !== 'excluded'
			|| value.tradingPost.reason !== 'current_state_unavailable'
			|| value.vendor.status !== 'excluded'
			|| value.vendor.reason !== 'current_state_unavailable') return false;
	} else {
		if ((value.tradingPost.status === 'excluded' && value.tradingPost.reason === 'current_state_unavailable')
			|| (value.vendor.status === 'excluded' && value.vendor.reason === 'current_state_unavailable')) return false;
		if (!bindingMatchesTradingPost(value.binding, value.tradingPost)) return false;
	}
	if (value.binding.source === 'catalog_missing') {
		if (value.tradingPost.status !== 'excluded'
			|| value.tradingPost.reason !== 'binding_unknown'
			|| value.vendor.status !== 'excluded'
			|| value.vendor.reason !== 'catalog_missing') return false;
	}
	if (value.vendor.status === 'eligible' && value.vendor.value.quantity !== value.quantity) return false;
	const expectedRoutes: LiquidGoldRoute[] = [];
	if (value.tradingPost.status === 'eligible') expectedRoutes.push('trading_post');
	if (value.vendor.status === 'eligible') expectedRoutes.push('vendor');
	if (value.liquidGold.status === 'excluded') {
		return expectedRoutes.length === 0
			&& value.liquidGold.value.quantity === value.quantity
			&& value.liquidGold.value.reason === expectedNonLiquidReason(value.tradingPost, value.vendor);
	}
	return sameRoutes(value.liquidGold.routes, expectedRoutes)
		&& (value.vendor.status === 'eligible'
			? sameVendorValue(value.liquidGold.vendorFloor, value.vendor.value)
			: value.liquidGold.vendorFloor === null);
}

function bindingMatchesTradingPost(
	binding: BindingClassification,
	tradingPost: TradingPostEligibility,
): boolean {
	if (binding.kind === 'account_bound') {
		return tradingPost.status === 'excluded' && tradingPost.reason === 'account_bound';
	}
	if (binding.kind === 'character_bound') {
		return tradingPost.status === 'excluded' && tradingPost.reason === 'character_bound';
	}
	if (binding.kind === 'unknown') {
		return tradingPost.status === 'excluded' && tradingPost.reason === 'binding_unknown';
	}
	return tradingPost.status === 'eligible'
		|| (tradingPost.status === 'excluded' && [
			'catalog_missing',
			'price_missing',
			'price_invalid',
			'price_unavailable',
		].includes(tradingPost.reason));
}

function classifyAccess(state: ItemHolding['state']): ItemLiquidityClassification['access'] {
	if (state === 'pending_claim') return 'claim_required';
	if (state === 'loose') return 'available';
	return 'current_state_unavailable';
}

function classifyBinding(binding: string | undefined, item: CatalogItem | null): BindingClassification {
	if (binding === 'Account') return { kind: 'account_bound', source: 'holding' };
	if (binding === 'Character') return { kind: 'character_bound', source: 'holding' };
	if (binding !== undefined) return { kind: 'unknown', source: 'holding' };
	if (item === null) return { kind: 'unknown', source: 'catalog_missing' };
	if (item.flags.includes('AccountBound')) return { kind: 'account_bound', source: 'catalog' };
	if (item.flags.includes('SoulbindOnAcquire')) return { kind: 'character_bound', source: 'catalog' };
	return { kind: 'unbound', source: 'holding' };
}

function classifyTradingPost(
	access: ItemLiquidityClassification['access'],
	binding: BindingClassification,
	item: CatalogItem | null,
	priceStatus: TradingPostPriceStatus,
): TradingPostEligibility {
	if (access === 'current_state_unavailable') {
		return { status: 'excluded', reason: 'current_state_unavailable' };
	}
	if (binding.kind === 'account_bound') return { status: 'excluded', reason: 'account_bound' };
	if (binding.kind === 'character_bound') return { status: 'excluded', reason: 'character_bound' };
	if (binding.kind === 'unknown') return { status: 'excluded', reason: 'binding_unknown' };
	if (item === null) return { status: 'excluded', reason: 'catalog_missing' };
	if (priceStatus === 'missing') return { status: 'excluded', reason: 'price_missing' };
	if (priceStatus === 'invalid') return { status: 'excluded', reason: 'price_invalid' };
	if (priceStatus === 'unavailable') return { status: 'excluded', reason: 'price_unavailable' };
	return { status: 'eligible' };
}

function classifyVendor(
	access: ItemLiquidityClassification['access'],
	quantity: number,
	item: CatalogItem | null,
): VendorEligibility {
	if (access === 'current_state_unavailable') {
		return { status: 'excluded', reason: 'current_state_unavailable' };
	}
	if (item === null) return { status: 'excluded', reason: 'catalog_missing' };
	const result = createCatalogVendorValue(item, quantity);
	if (result.status === 'ok') return { status: 'eligible', value: result.value };
	if (result.status === 'unavailable') return { status: 'excluded', reason: result.reason };
	return { status: 'excluded', reason: 'catalog_missing' };
}

function excludedLiquidGold(
	quantity: number,
	tradingPost: TradingPostEligibility,
	vendor: VendorEligibility,
): LiquidGoldClassification {
	const value = createNonLiquidCopperValue(
		quantity,
		expectedNonLiquidReason(tradingPost, vendor),
	);
	if (value.status !== 'ok') throw new Error('Normalized quantity produced an invalid non-liquid value.');
	return { status: 'excluded', routes: [], value: value.value };
}

function expectedNonLiquidReason(
	tradingPost: TradingPostEligibility,
	vendor: VendorEligibility,
): 'missing_required_data' | 'no_eligible_route' {
	const missingRequiredData = (tradingPost.status === 'excluded' && [
		'binding_unknown',
		'catalog_missing',
		'price_missing',
		'price_invalid',
		'price_unavailable',
	].includes(tradingPost.reason))
		|| (vendor.status === 'excluded' && vendor.reason === 'catalog_missing');
	return missingRequiredData ? 'missing_required_data' : 'no_eligible_route';
}

function isNormalizedItemHolding(value: unknown): value is ItemHolding {
	if (!isRecord(value)
		|| value.kind !== 'item'
		|| !isPositiveInteger(value.itemId)
		|| !isPositiveInteger(value.quantity)
		|| !isItemState(value.state)
		|| !isItemLocation(value.location)
		|| !isItemMetadata(value.metadata)) return false;
	const embedded = value.state === 'embedded_upgrade' || value.state === 'embedded_infusion';
	if (embedded) {
		return exactKeys(value, [
			'kind', 'itemId', 'quantity', 'state', 'location', 'metadata', 'parentItemId', 'embeddedKind',
		])
			&& value.quantity === 1
			&& isPositiveInteger(value.parentItemId)
			&& value.embeddedKind === (value.state === 'embedded_upgrade' ? 'upgrade' : 'infusion')
			&& !isEquippedBag(value.location);
	}
	if (value.parentItemId !== undefined || value.embeddedKind !== undefined) return false;
	if (!exactKeys(value, ['kind', 'itemId', 'quantity', 'state', 'location', 'metadata'])) return false;
	if (value.state === 'equipped_container') return isEquippedBag(value.location) && value.quantity === 1;
	if (value.state === 'pending_claim') return value.location.source === 'commerce_delivery';
	return !isEquippedBag(value.location) && value.location.source !== 'commerce_delivery';
}

function isItemLocation(value: unknown): value is ItemLocation {
	if (!isRecord(value)) return false;
	if (value.source === 'character') {
		if (!isNonEmptyString(value.character) || !isNonNegativeInteger(value.bagIndex)) return false;
		if (value.container === 'equipped_bag') {
			return exactKeys(value, ['source', 'character', 'container', 'bagIndex']);
		}
		return value.container === 'bag'
			&& exactKeys(value, ['source', 'character', 'container', 'bagIndex', 'slot'])
			&& isNonNegativeInteger(value.slot);
	}
	if (value.source === 'shared_inventory' || value.source === 'bank' || value.source === 'commerce_delivery') {
		return exactKeys(value, ['source', 'slot']) && isNonNegativeInteger(value.slot);
	}
	return value.source === 'materials'
		&& exactKeys(value, ['source', 'category'])
		&& isNonNegativeInteger(value.category);
}

function isItemMetadata(value: unknown): value is ItemMetadata {
	if (!isRecord(value)) return false;
	return Object.keys(value).every((key) => [
		'binding', 'boundTo', 'skin', 'statsId', 'statsAttributes', 'charges',
	].includes(key))
		&& optionalNonEmptyString(value.binding)
		&& optionalString(value.boundTo)
		&& optionalPositiveInteger(value.skin)
		&& optionalPositiveInteger(value.statsId)
		&& optionalNonNegativeInteger(value.charges)
		&& (value.statsAttributes === undefined
			|| (value.statsId !== undefined && isStatsAttributes(value.statsAttributes)));
}

function isStatsAttributes(value: unknown): value is Record<string, number> {
	return isRecord(value)
		&& Object.entries(value).every(([key, amount]) => key.length > 0 && Number.isFinite(amount));
}

function isBindingClassification(value: unknown): value is BindingClassification {
	if (!isRecord(value) || !exactKeys(value, ['kind', 'source'])) return false;
	if (value.kind === 'unbound') return value.source === 'holding';
	if (value.kind === 'account_bound' || value.kind === 'character_bound') {
		return value.source === 'holding' || value.source === 'catalog';
	}
	return value.kind === 'unknown'
		&& (value.source === 'holding' || value.source === 'catalog_missing');
}

function isTradingPostEligibility(value: unknown): value is TradingPostEligibility {
	if (!isRecord(value)) return false;
	return value.status === 'eligible'
		? exactKeys(value, ['status'])
		: value.status === 'excluded'
			&& exactKeys(value, ['status', 'reason'])
			&& isTradingPostExclusionReason(value.reason);
}

function isVendorEligibility(value: unknown): value is VendorEligibility {
	if (!isRecord(value)) return false;
	return value.status === 'eligible'
		? exactKeys(value, ['status', 'value']) && isVendorValue(value.value)
		: value.status === 'excluded'
			&& exactKeys(value, ['status', 'reason'])
			&& isVendorExclusionReason(value.reason);
}

function isLiquidGoldClassification(value: unknown): value is LiquidGoldClassification {
	if (!isRecord(value) || !Array.isArray(value.routes)) return false;
	if (value.status === 'eligible') {
		return exactKeys(value, ['status', 'routes', 'vendorFloor'])
			&& value.routes.length > 0
			&& value.routes.every(isLiquidGoldRoute)
			&& (value.vendorFloor === null || isVendorValue(value.vendorFloor));
	}
	return value.status === 'excluded'
		&& exactKeys(value, ['status', 'routes', 'value'])
		&& value.routes.length === 0
		&& isNonLiquidValue(value.value);
}

function isVendorValue(value: unknown): value is VendorCopperValue {
	return isCopperValue(value) && value.kind === 'vendor';
}

function isNonLiquidValue(value: unknown): value is NonLiquidCopperValue {
	return isCopperValue(value)
		&& value.kind === 'non_liquid'
		&& (value.reason === 'no_eligible_route' || value.reason === 'missing_required_data');
}

function sameRoutes(actual: LiquidGoldRoute[], expected: LiquidGoldRoute[]): boolean {
	return actual.length === expected.length && actual.every((route, index) => route === expected[index]);
}

function sameVendorValue(a: VendorCopperValue | null, b: VendorCopperValue): boolean {
	return a !== null
		&& a.version === b.version
		&& a.kind === b.kind
		&& a.priceSource === b.priceSource
		&& a.liquidity === b.liquidity
		&& a.quantity === b.quantity
		&& a.unitCopper === b.unitCopper
		&& a.grossCopper === b.grossCopper
		&& a.netCopper === b.netCopper;
}

function isTradingPostPriceStatus(value: unknown): value is TradingPostPriceStatus {
	return value === 'available' || value === 'missing' || value === 'invalid' || value === 'unavailable';
}

function isTradingPostExclusionReason(value: unknown): value is TradingPostExclusionReason {
	return value === 'current_state_unavailable'
		|| value === 'account_bound'
		|| value === 'character_bound'
		|| value === 'binding_unknown'
		|| value === 'catalog_missing'
		|| value === 'price_missing'
		|| value === 'price_invalid'
		|| value === 'price_unavailable';
}

function isVendorExclusionReason(value: unknown): value is VendorExclusionReason {
	return value === 'current_state_unavailable'
		|| value === 'catalog_missing'
		|| value === 'vendor_sale_forbidden'
		|| value === 'no_vendor_value';
}

function isLiquidGoldRoute(value: unknown): value is LiquidGoldRoute {
	return value === 'trading_post' || value === 'vendor';
}

function isAccess(value: unknown): value is ItemLiquidityClassification['access'] {
	return value === 'available' || value === 'claim_required' || value === 'current_state_unavailable';
}

function isItemState(value: unknown): value is ItemHolding['state'] {
	return value === 'loose'
		|| value === 'equipped_container'
		|| value === 'embedded_upgrade'
		|| value === 'embedded_infusion'
		|| value === 'pending_claim';
}

function isEquippedBag(location: ItemLocation): boolean {
	return location.source === 'character' && location.container === 'equipped_bag';
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function optionalNonEmptyString(value: unknown): boolean {
	return value === undefined || isNonEmptyString(value);
}

function optionalPositiveInteger(value: unknown): boolean {
	return value === undefined || isPositiveInteger(value);
}

function optionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || isNonNegativeInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
