import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import type { CatalogItem } from '../catalog/public-catalog-model';
import type { SessionPriceSnapshot } from './session-price-snapshot';
import {
	calculateSessionValuation,
	HALLOWEEN_TOT_BAG_ITEM_ID,
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
			{ id: HALLOWEEN_TOT_BAG_ITEM_ID, before: 0, after: 100, delta: 100 },
			{ id: 2, before: 0, after: 2, delta: 2 },
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
		durationMs: 30 * 60 * 1_000,
		sackItemIds: [HALLOWEEN_TOT_BAG_ITEM_ID],
	};
}

describe('calculateSessionValuation', () => {
	it('reproduces immediate, listing, vendor, sacks/hour and copper/hour', () => {
		const result = calculateSessionValuation(input());
		expect(result).toMatchObject({
			status: 'ok',
			valuation: {
				coverage: 'complete',
				lines: [
					{
						itemId: 2, quantity: 2, instantSell: null, listing: null,
						vendor: { netCopper: 10 }, immediateBestCopper: 10, listingBestCopper: 10,
					},
					{
						itemId: HALLOWEEN_TOT_BAG_ITEM_ID, quantity: 100,
						instantSell: { grossCopper: 1_000, netCopper: 850 },
						listing: { grossCopper: 2_000, netCopper: 1_700 },
						vendor: { netCopper: 200 }, immediateBestCopper: 850, listingBestCopper: 1_700,
					},
				],
				totals: {
					itemImmediateCopper: 860, itemListingCopper: 1_710, coinNetCopper: 140,
					observedImmediateCopper: 1_000, observedListingCopper: 1_850,
				},
				rates: {
					sacks: 100, sacksPerHourMilli: 200_000,
					immediateCopperPerHour: 2_000, listingCopperPerHour: 3_700,
				},
				warnings: [],
			},
		});
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

	it('reports item losses as an explicit limitation and never subtracts an invented value', () => {
		const value = input();
		value.delta.itemChanges.push({ id: 99, before: 3, after: 1, delta: -2 });
		const result = calculateSessionValuation(value);
		expect(result).toMatchObject({
			status: 'ok',
			valuation: { coverage: 'partial', warnings: ['item_losses_not_valued'] },
		});
	});

	it('rejects mismatched price evidence, invalid duration and unsafe rate arithmetic', () => {
		const mismatched = input();
		mismatched.prices = { ...mismatched.prices, sessionId: 'other' };
		expect(calculateSessionValuation(mismatched)).toEqual({ status: 'invalid', reason: 'evidence_mismatch' });
		expect(calculateSessionValuation({ ...input(), durationMs: 0 }))
			.toEqual({ status: 'invalid', reason: 'invalid_duration' });
		expect(calculateSessionValuation({ ...input(), sackItemIds: [2, 2] }))
			.toEqual({ status: 'invalid', reason: 'invalid_sack_ids' });
	});
});
