import type { ItemHolding } from '../account/storage-snapshot-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { createCatalogVendorValue, createTradingPostValueWithPolicy } from '../economy/gw2-fees';
import { classifyItemLiquidity, isTradingPostAccessible } from '../economy/item-liquidity';
import type { InventoryItemPriceV1 } from './inventory-advisor-model';
import {
	valueCompetitiveListing,
	valueInstantSellDepth,
	type InventoryItemMarketDepthV1,
} from '../economy/commerce-listings';

export type InventoryMarketActionV1 = 'sell' | 'list' | 'vendor' | 'keep' | 'review';
export interface InventoryMarketSelectionInputV1 {
	holding: ItemHolding;
	item: CatalogItem;
	price: InventoryItemPriceV1 | undefined;
	marketDepth?: InventoryItemMarketDepthV1;
	tradingPostAccess: 'full' | 'free_to_play' | 'unknown';
	quantity: number;
	allowSell: boolean;
	listingMinimumAdvantageBps: number;
}

/** Selects one conservative manual market route for an exact physical slice. */
export function selectInventoryMarketRoute(input: InventoryMarketSelectionInputV1): { action: InventoryMarketActionV1; reason: 'alternative_route_exists' | 'no_sell' | 'catalog_invalid' | 'tp_access_unknown' } {
	if (input.tradingPostAccess === 'unknown') return { action: 'review', reason: 'tp_access_unknown' };
	const liquidity = classifyItemLiquidity(input.holding, input.item, 'available');
	if (liquidity.status !== 'ok') return { action: 'review', reason: 'catalog_invalid' };
	const vendorValue = createCatalogVendorValue(input.item, input.quantity);
	const vendor = vendorValue.status === 'ok' ? vendorValue.value.netCopper : null;
	const tradingPost = isTradingPostAccessible(liquidity.classification.tradingPost, input.tradingPostAccess, input.price?.whitelisted === true);
	const depthReady = input.marketDepth?.coverage === 'complete';
	const depthSell = depthReady ? valueInstantSellDepth(input.marketDepth!.buys, input.quantity) : null;
	const depthList = depthReady ? valueCompetitiveListing(input.marketDepth!.sells, input.quantity) : null;
	const sell = !depthReady && tradingPost && input.allowSell && input.price?.bid !== null
		&& input.price !== undefined && input.price.bid.quantity >= input.quantity
		? createTradingPostValueWithPolicy('instant_sell', input.price.bid.unitCopper, input.quantity) : null;
	const list = !depthReady && tradingPost && input.price?.ask !== null && input.price !== undefined
		? createTradingPostValueWithPolicy('listing', input.price.ask.unitCopper, input.quantity) : null;
	const sellNet = !tradingPost || !input.allowSell ? null
		: depthSell?.status === 'complete' ? depthSell.netCopper
			: sell?.status === 'ok' ? sell.value.netCopper : null;
	const listNet = !tradingPost ? null
		: depthList?.status === 'complete' ? depthList.netCopper
			: list?.status === 'ok' ? list.value.netCopper : null;
	const baseline = Math.max(vendor ?? 0, sellNet ?? 0);
	if (listNet !== null && baseline > 0 && listNet * 10_000 >= baseline * (10_000 + input.listingMinimumAdvantageBps)) return { action: 'list', reason: 'alternative_route_exists' };
	if (vendor !== null && (sellNet === null || vendor >= sellNet)) return { action: 'vendor', reason: 'alternative_route_exists' };
	if (sellNet !== null) return { action: 'sell', reason: 'alternative_route_exists' };
	if (listNet !== null) return { action: 'list', reason: 'alternative_route_exists' };
	return { action: 'keep', reason: 'no_sell' };
}
