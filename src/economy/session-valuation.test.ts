import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { SessionPriceSnapshot } from './session-price-snapshot';
import {
	calculateSessionValuation,
	HALLOWEEN_TOT_BAG_ITEM_ID,
	isSessionValuation,
	type SessionValuationInput,
} from './session-valuation';

function item(id: number, overrides: Partial<CatalogItem> = {}): CatalogItem {
	return {
		kind: 'item', id, name: `Item ${id}`, type: 'Consumable', rarity: 'Basic', level: 0,
		vendorValue: 0, flags: [], gameTypes: [], restrictions: [], ...overrides,
	};
}

function delta(): StorageDelta {
	return {
		version: 1, status: 'comparable', accountId: 'account-1',
		beforeSnapshotId: 'before', afterSnapshotId: 'after',
		window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T09:30:00.000Z' },
		surface: 'core_and_delivery', currencySurface: 'wallet_and_delivery', reasons: [], warnings: [],
		itemChanges: [
			{ id: 2, before: 0, after: 2, delta: 2 },
			{ id: HALLOWEEN_TOT_BAG_ITEM_ID, before: 0, after: 100, delta: 100 },
		],
		currencyChanges: [{ id: 1, before: 1_000, after: 1_140, delta: 140 }],
		availabilityChanges: [], compositionChanges: [],
	};
}

function prices(storageDelta = delta()): SessionPriceSnapshot {
	return {
		version: 1, sessionId: 'session-1', capturedAt: '2026-08-13T09:30:01.000Z',
		source: 'gw2-commerce-prices', schemaVersion: '2024-07-20T01:00:00.000Z', status: 'complete',
		items: storageDelta.itemChanges.filter((change) => change.delta > 0)
			.sort((left, right) => left.id - right.id).map((change) => ({
			itemId: change.id,
			quantityGained: change.delta,
			whitelisted: true,
			bid: { quantity: 1_000, unitCopper: change.id === HALLOWEEN_TOT_BAG_ITEM_ID ? 10 : 20 },
			ask: { quantity: 1_000, unitCopper: change.id === HALLOWEEN_TOT_BAG_ITEM_ID ? 20 : 30 },
			})),
		missingItemIds: [],
		marketDepth: {
			version: 1, capturedAt: '2026-08-13T09:30:01.000Z', source: 'gw2-commerce-listings',
			requestedItemIds: storageDelta.itemChanges.filter((change) => change.delta > 0)
				.map((change) => change.id).sort((left, right) => left - right),
			status: 'complete',
			items: storageDelta.itemChanges.filter((change) => change.delta > 0)
				.sort((left, right) => left.id - right.id).map((change) => ({
					itemId: change.id, coverage: 'complete' as const,
					buys: change.id === HALLOWEEN_TOT_BAG_ITEM_ID
						? [{ unitCopper: 10, quantity: 50 }, { unitCopper: 8, quantity: 50 }]
						: [{ unitCopper: 20, quantity: 1_000 }],
					sells: [{ unitCopper: change.id === HALLOWEEN_TOT_BAG_ITEM_ID ? 20 : 30, quantity: 1_000 }],
				})),
		},
	};
}

function input(): SessionValuationInput {
	return {
		sessionId: 'session-1',
		delta: delta(),
		prices: prices(),
		catalogItems: {
			[String(HALLOWEEN_TOT_BAG_ITEM_ID)]: item(HALLOWEEN_TOT_BAG_ITEM_ID, { vendorValue: 2 }),
			'2': item(2, { vendorValue: 5, flags: ['AccountBound'] }),
		},
		bindingByItem: { [String(HALLOWEEN_TOT_BAG_ITEM_ID)]: 'unbound', '2': 'account_bound' },
		sackItemIds: [HALLOWEEN_TOT_BAG_ITEM_ID],
	};
}

describe('calculateSessionValuation', () => {
	it('derives farming duration from the delta window, not the later price capture', () => {
		const result = calculateSessionValuation(input());
		expect(result).toMatchObject({
			status: 'ok',
			valuation: {
				coverage: 'complete',
				durationMs: 30 * 60 * 1_000,
				lines: [
					{
						itemId: 2, quantity: 2, instantSell: null, listing: null,
						vendor: { netCopper: 10 }, immediateBestCopper: 10, listingBestCopper: 10,
					},
					{
						itemId: HALLOWEEN_TOT_BAG_ITEM_ID, quantity: 100,
						instantSell: { status: 'complete', grossCopper: 900, netCopper: 765 },
						instantSellDepthCoverage: 'complete',
						listing: { grossCopper: 2_000, netCopper: 1_700 },
						vendor: { netCopper: 200 }, immediateBestCopper: 765, listingBestCopper: 1_700,
					},
				],
				totals: {
					itemImmediateCopper: 775, itemListingCopper: 1_710, coinNetCopper: 140,
					observedImmediateCopper: 915, observedListingCopper: 1_850,
				},
				rates: {
					sacks: 100, sacksPerHourMilli: 200_000,
					immediateCopperPerHour: 1_830, listingCopperPerHour: 3_700,
				},
				warnings: [],
			},
		});
	});

	it('withholds an exhausted instant-sale total and marks depth coverage partial', () => {
		const value = input();
		const sackDepth = value.prices.marketDepth.items.find((entry) => entry.itemId === HALLOWEEN_TOT_BAG_ITEM_ID)!;
		sackDepth.buys = [{ unitCopper: 10, quantity: 40 }];
		const result = calculateSessionValuation(value);
		expect(result).toMatchObject({
			status: 'ok',
			valuation: {
				coverage: 'partial',
				lines: [{}, {
					itemId: HALLOWEEN_TOT_BAG_ITEM_ID,
					instantSell: { status: 'partial', coveredQuantity: 40, uncoveredQuantity: 60 },
					immediateBestCopper: 200,
				}],
				warnings: ['market_depth_incomplete'],
			},
		});
	});

	it('rejects a complete depth label without a demonstrated instant-sale value', () => {
		const result = calculateSessionValuation(input());
		if (result.status !== 'ok') throw new Error('Expected a valid valuation fixture.');
		const tampered = structuredClone(result.valuation);
		tampered.lines[0]!.instantSellDepthCoverage = 'complete';

		expect(isSessionValuation(tampered, delta(), [HALLOWEEN_TOT_BAG_ITEM_ID])).toBe(false);
	});

	it('rejects partial market depth hidden by removing its warning and promoting coverage', () => {
		const value = input();
		value.prices.marketDepth.items.find((entry) => entry.itemId === HALLOWEEN_TOT_BAG_ITEM_ID)!.buys = [
			{ unitCopper: 10, quantity: 40 },
		];
		const result = calculateSessionValuation(value);
		if (result.status !== 'ok') throw new Error('Expected a valid partial-depth fixture.');
		const tampered = structuredClone(result.valuation);
		tampered.warnings = [];
		tampered.coverage = 'complete';

		expect(isSessionValuation(tampered, value.delta, [HALLOWEEN_TOT_BAG_ITEM_ID])).toBe(false);
	});

	it('keeps unknown binding and missing metadata non-liquid instead of zero-valued', () => {
		const value = input();
		value.bindingByItem[String(HALLOWEEN_TOT_BAG_ITEM_ID)] = 'unknown';
		delete value.catalogItems[String(HALLOWEEN_TOT_BAG_ITEM_ID)];
		const result = calculateSessionValuation(value);
		expect(result).toMatchObject({
			status: 'ok',
			valuation: {
				coverage: 'partial',
				lines: [
					{},
					{ itemId: HALLOWEEN_TOT_BAG_ITEM_ID, nonLiquid: true, immediateBestCopper: null, listingBestCopper: null },
				],
				totals: { nonLiquidItemKinds: 1, nonLiquidQuantity: 100 },
				warnings: ['binding_unknown', 'catalog_missing'],
			},
		});
	});

	it('uses vendor as the immediate floor when it beats the current bid', () => {
		const value = input();
		value.catalogItems[String(HALLOWEEN_TOT_BAG_ITEM_ID)] = item(HALLOWEEN_TOT_BAG_ITEM_ID, { vendorValue: 15 });
		const result = calculateSessionValuation(value);
		expect(result).toMatchObject({
			valuation: { lines: [{}, { itemId: HALLOWEEN_TOT_BAG_ITEM_ID, immediateBestCopper: 1_500 }] },
		});
	});

	it('preserves unavailable prices as partial while retaining a proven vendor floor', () => {
		const value = input();
		value.prices = { ...value.prices, status: 'unavailable', items: [], missingItemIds: [2, HALLOWEEN_TOT_BAG_ITEM_ID] };
		const result = calculateSessionValuation(value);
		expect(result).toMatchObject({
			status: 'ok',
			valuation: {
				coverage: 'partial',
				totals: { itemImmediateCopper: 210, itemListingCopper: 210 },
				warnings: ['price_incomplete'],
			},
		});
	});

	it('keeps a zero-priced TP vertical null and makes the valuation partial', () => {
		const value = input();
		value.prices = {
			...value.prices,
			status: 'partial',
			items: value.prices.items.map((entry) => entry.itemId === HALLOWEEN_TOT_BAG_ITEM_ID
				? { ...entry, bid: null }
				: entry),
		};

		const result = calculateSessionValuation(value);

		expect(result).toMatchObject({
			status: 'ok',
			valuation: {
				coverage: 'partial',
				lines: [{}, { itemId: HALLOWEEN_TOT_BAG_ITEM_ID, instantSell: null }],
				warnings: ['price_incomplete'],
			},
		});
	});

	it('reports item losses as an explicit limitation and never subtracts an invented value', () => {
		const value = input();
		value.delta.itemChanges.splice(1, 0, { id: 99, before: 3, after: 1, delta: -2 });
		const result = calculateSessionValuation(value);
		expect(result).toMatchObject({
			status: 'ok',
			valuation: { coverage: 'partial', warnings: ['item_losses_not_valued'] },
		});
	});

	it('rejects mismatched evidence, invalid delta duration and unsafe rate arithmetic', () => {
		const mismatched = input();
		mismatched.prices = { ...mismatched.prices, sessionId: 'other' };
		expect(calculateSessionValuation(mismatched)).toEqual({ status: 'invalid', reason: 'evidence_mismatch' });
		const noWindow = input();
		noWindow.delta.window = null;
		expect(calculateSessionValuation(noWindow)).toEqual({ status: 'invalid', reason: 'evidence_mismatch' });
		expect(calculateSessionValuation({ ...input(), sackItemIds: [2, 2] }))
			.toEqual({ status: 'invalid', reason: 'invalid_sack_ids' });
	});
});
