import { describe, expect, it } from 'vitest';

import type { ItemHolding } from '../account/storage-snapshot-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import { classifyItemLiquidity, isItemLiquidityClassification } from './item-liquidity';

describe('item liquidity classification', () => {
	it('allows both routes for an available unbound priced stack', () => {
		const result = classifyItemLiquidity(holding({ quantity: 3 }), item({ vendorValue: 7 }), 'available');
		expect(result).toMatchObject({
			status: 'ok',
			classification: {
				binding: { kind: 'unbound', source: 'holding' },
				tradingPost: { status: 'eligible' },
				vendor: { status: 'eligible', value: { netCopper: 21 } },
				liquidGold: { status: 'eligible', routes: ['trading_post', 'vendor'], vendorFloor: { netCopper: 21 } },
			},
		});
	});

	it('never enables the Trading Post without valid price evidence', () => {
		for (const [priceStatus, reason] of [
			['missing', 'price_missing'],
			['invalid', 'price_invalid'],
			['unavailable', 'price_unavailable'],
		] as const) {
			const result = classifyItemLiquidity(holding(), item({ vendorValue: 7 }), priceStatus);
			expect(result).toMatchObject({
				status: 'ok',
				classification: {
					tradingPost: { status: 'excluded', reason },
					liquidGold: { status: 'eligible', routes: ['vendor'] },
				},
			});
		}
	});

	it('uses a non-liquid missing-data value when no price or vendor route exists', () => {
		const result = classifyItemLiquidity(
			holding({ quantity: 5 }),
			item({ flags: ['NoSell'], vendorValue: 0 }),
			'missing',
		);
		expect(result).toMatchObject({
			status: 'ok',
			classification: {
				tradingPost: { status: 'excluded', reason: 'price_missing' },
				vendor: { status: 'excluded', reason: 'vendor_sale_forbidden' },
				liquidGold: {
					status: 'excluded',
					routes: [],
					value: { kind: 'non_liquid', reason: 'missing_required_data', quantity: 5, netCopper: null },
				},
			},
		});
	});

	it('blocks Trading Post value for account binding while retaining a real vendor floor', () => {
		const result = classifyItemLiquidity(
			holding({ metadata: { binding: 'Account' }, quantity: 2 }),
			item({ vendorValue: 7 }),
			'available',
		);
		expect(result).toMatchObject({
			status: 'ok',
			classification: {
				binding: { kind: 'account_bound', source: 'holding' },
				tradingPost: { status: 'excluded', reason: 'account_bound' },
				vendor: { status: 'eligible', value: { netCopper: 14 } },
				liquidGold: { status: 'eligible', routes: ['vendor'], vendorFloor: { netCopper: 14 } },
			},
		});
	});

	it('keeps bound NoSell stacks out of liquid gold entirely', () => {
		const result = classifyItemLiquidity(
			holding({ metadata: { binding: 'Account' } }),
			item({ flags: ['NoSell'], vendorValue: 7 }),
			'available',
		);
		expect(result).toMatchObject({
			status: 'ok',
			classification: {
				tradingPost: { status: 'excluded', reason: 'account_bound' },
				vendor: { status: 'excluded', reason: 'vendor_sale_forbidden' },
				liquidGold: { status: 'excluded', value: { reason: 'no_eligible_route', netCopper: null } },
			},
		});
	});

	it('derives acquire-time binding from catalog flags conservatively', () => {
		const account = classifyItemLiquidity(holding(), item({ flags: ['AccountBound'] }), 'available');
		const character = classifyItemLiquidity(holding(), item({ flags: ['SoulbindOnAcquire'] }), 'available');
		expect(account).toMatchObject({
			classification: {
				binding: { kind: 'account_bound', source: 'catalog' },
				tradingPost: { status: 'excluded', reason: 'account_bound' },
			},
		});
		expect(character).toMatchObject({
			classification: {
				binding: { kind: 'character_bound', source: 'catalog' },
				tradingPost: { status: 'excluded', reason: 'character_bound' },
			},
		});
	});

	it('does not treat bind-on-use as already bound', () => {
		expect(classifyItemLiquidity(holding(), item({ flags: ['SoulBindOnUse'] }), 'available'))
			.toMatchObject({
				classification: {
					binding: { kind: 'unbound' },
					tradingPost: { status: 'eligible' },
				},
			});
	});

	it('treats character and future unknown binding values conservatively', () => {
		expect(classifyItemLiquidity(holding({ metadata: { binding: 'Character' } }), item(), 'available'))
			.toMatchObject({ classification: { tradingPost: { status: 'excluded', reason: 'character_bound' } } });
		expect(classifyItemLiquidity(
			holding({ metadata: { binding: 'FutureBinding' } }),
			item({ vendorValue: 7 }),
			'available',
		))
			.toMatchObject({
				classification: {
					binding: { kind: 'unknown', source: 'holding' },
					tradingPost: { status: 'excluded', reason: 'binding_unknown' },
					liquidGold: { status: 'eligible', routes: ['vendor'] },
				},
			});
	});

	it('excludes embedded items and equipped containers in their current state', () => {
		const embedded = holding({
			quantity: 1,
			state: 'embedded_upgrade',
			parentItemId: 99,
			embeddedKind: 'upgrade',
		});
		const bag = holding({
			quantity: 1,
			state: 'equipped_container',
			location: { source: 'character', character: 'Test', container: 'equipped_bag', bagIndex: 0 },
		});
		for (const candidate of [embedded, bag]) {
			expect(classifyItemLiquidity(candidate, item({ vendorValue: 7 }), 'available')).toMatchObject({
				classification: {
					access: 'current_state_unavailable',
					tradingPost: { status: 'excluded', reason: 'current_state_unavailable' },
					vendor: { status: 'excluded', reason: 'current_state_unavailable' },
					liquidGold: { status: 'excluded', value: { reason: 'no_eligible_route' } },
				},
			});
		}
	});

	it('marks delivery as claim-required without inventing an exclusion', () => {
		const pending = holding({
			state: 'pending_claim',
			location: { source: 'commerce_delivery', slot: 0 },
		});
		expect(classifyItemLiquidity(pending, item({ vendorValue: 7 }), 'available')).toMatchObject({
			classification: {
				access: 'claim_required',
				tradingPost: { status: 'eligible' },
				vendor: { status: 'eligible' },
			},
		});
	});

	it('fails closed when catalog metadata is missing', () => {
		const result = classifyItemLiquidity(holding(), null, 'available');
		expect(result).toMatchObject({
			status: 'ok',
			classification: {
				binding: { kind: 'unknown', source: 'catalog_missing' },
				tradingPost: { status: 'excluded', reason: 'binding_unknown' },
				vendor: { status: 'excluded', reason: 'catalog_missing' },
				liquidGold: { status: 'excluded', value: { reason: 'missing_required_data' } },
			},
		});
	});

	it('rejects malformed, mismatched and impossible normalized inputs', () => {
		expect(classifyItemLiquidity({}, item(), 'available'))
			.toEqual({ status: 'invalid', reason: 'invalid_holding' });
		expect(classifyItemLiquidity(holding(), {}, 'available'))
			.toEqual({ status: 'invalid', reason: 'invalid_catalog_item' });
		expect(classifyItemLiquidity(holding(), item({ id: 2 }), 'available'))
			.toEqual({ status: 'invalid', reason: 'catalog_item_mismatch' });
		expect(classifyItemLiquidity(holding(), item(), 'fresh'))
			.toEqual({ status: 'invalid', reason: 'invalid_price_status' });
		expect(classifyItemLiquidity(holding({ quantity: 0 }), item(), 'available'))
			.toEqual({ status: 'invalid', reason: 'invalid_holding' });
		expect(classifyItemLiquidity(holding({ metadata: { binding: '' } }), item(), 'available'))
			.toEqual({ status: 'invalid', reason: 'invalid_holding' });
		expect(classifyItemLiquidity(holding({ metadata: { statsAttributes: { Power: 10 } } }), item(), 'available'))
			.toEqual({ status: 'invalid', reason: 'invalid_holding' });
		expect(classifyItemLiquidity(holding({
			state: 'loose',
			location: { source: 'commerce_delivery', slot: 0 },
		}), item(), 'available')).toEqual({ status: 'invalid', reason: 'invalid_holding' });
	});

	it('strictly validates the derived route and arithmetic invariants', () => {
		const result = classifyItemLiquidity(holding({ quantity: 3 }), item({ vendorValue: 7 }), 'available');
		if (result.status !== 'ok') throw new Error('Expected a valid classification fixture.');
		expect(isItemLiquidityClassification(result.classification)).toBe(true);
		expect(isItemLiquidityClassification({
			...result.classification,
			liquidGold: { ...result.classification.liquidGold, routes: ['vendor', 'trading_post'] },
		})).toBe(false);
		expect(isItemLiquidityClassification({
			...result.classification,
			vendor: {
				status: 'eligible',
				value: { ...(result.classification.vendor as { status: 'eligible'; value: object }).value, netCopper: 22 },
			},
		})).toBe(false);
		expect(isItemLiquidityClassification({ ...result.classification, extra: true })).toBe(false);
		expect(isItemLiquidityClassification({
			...result.classification,
			access: 'available',
			vendor: { status: 'excluded', reason: 'current_state_unavailable' },
			liquidGold: { status: 'eligible', routes: ['trading_post'], vendorFloor: null },
		})).toBe(false);
	});
});

function holding(overrides: Partial<ItemHolding> = {}): ItemHolding {
	return {
		kind: 'item',
		itemId: 1,
		quantity: 1,
		state: 'loose',
		location: { source: 'bank', slot: 0 },
		metadata: {},
		...overrides,
	};
}

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
	return {
		kind: 'item',
		id: 1,
		name: 'Test item',
		type: 'CraftingMaterial',
		rarity: 'Basic',
		level: 0,
		vendorValue: 0,
		flags: [],
		gameTypes: [],
		restrictions: [],
		...overrides,
	};
}
