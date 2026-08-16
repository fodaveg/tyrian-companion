import { describe, expect, it } from 'vitest';

import {
	createInventoryAdvisorBuiltinBundleProvider,
} from './inventory-advisor-builtin-bundle';
import { sha256InventoryRulePack } from './inventory-advisor-contract';
import {
	evaluateInventoryContainerEconomy,
	isInventoryContainerEconomyPack,
	isInventoryContainerPriceEvidence,
	pendingHalloweenContainerEconomyPack,
	sha256InventoryContainerEconomyPack,
	type InventoryContainerEconomyInputV1,
} from './inventory-container-economy';

const AS_OF = '2026-08-16T05:23:00.000Z';

describe('H4.19 inventory container economy', () => {
	it('retains a complete pending fixture that fails closed before human activation', () => {
		const value = fixture('open');
		value.economyPack = pendingHalloweenContainerEconomyPack({
			rulePack: {
				id: value.rulePack.id,
				version: value.rulePack.version,
				sha256: value.rulePack.sha256,
				ruleId: value.rulePack.rules[0]!.ruleId,
			},
			knowledgePackSha256: value.rulePack.knowledgePackSha256,
		});
		expect(isInventoryContainerEconomyPack(value.economyPack)).toBe(true);
		expect(value.economyPack.expectedPriceItemIds).toEqual([
			36_038, 36_041, 36_059, 36_060, 36_061, 79_673, 79_677, 79_679, 89_002,
		]);
		expect(isInventoryContainerPriceEvidence(value.prices)).toBe(true);
		expect(evaluateInventoryContainerEconomy(value)).toEqual({ status: 'review', reason: 'activation_pending' });
	});

	it.each([
		['open', 'open'],
		['sell', 'sell'],
		['vendor', 'vendor'],
	] as const)('recommends manual %s only after explicit activation and exact evidence', (route, action) => {
		const value = fixture(route);
		const result = evaluateInventoryContainerEconomy(value);
		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		expect(result.decision).toMatchObject({ action, quantity: 5 });
		expect(result.decision.ruleId).toBe(action === 'open' ? 'open-36038-capability-v1' : null);
		expect(result.explanation.threshold).toMatchObject({ marginBps: 1_000 });
		expect(result.explanation.comparison.rule).toBe('open_at_or_above_threshold');
		expect(JSON.stringify(result.decision)).not.toMatch(/listing|executor|background|discard/u);
	});

	it('makes human activation effective at its exact timestamp, never before it', () => {
		const before = fixture('open');
		before.asOf = '2026-08-16T05:22:23.999Z';
		expect(evaluateInventoryContainerEconomy(before)).toEqual({ status: 'review', reason: 'activation_expired' });
		const exact = fixture('open');
		exact.asOf = '2026-08-16T05:22:24.000Z';
		exact.prices.capturedAt = exact.asOf;
		expect(evaluateInventoryContainerEconomy(exact)).toMatchObject({ status: 'ready', decision: { action: 'open' } });
	});

	it('keeps reservations and exceptions outside the economic quantity', () => {
		const value = fixture('open');
		value.allocation = {
			ownedQuantity: 10,
			availableQuantity: 10,
			reservedQuantity: 3,
			exceptionQuantity: 2,
			reviewQuantity: 0,
			freeQuantity: 5,
		};
		const result = evaluateInventoryContainerEconomy(value);
		expect(result).toMatchObject({ status: 'ready', decision: { action: 'open', quantity: 5 } });
	});

	it('requires an exact available partition and represents review/no-action remainder', () => {
		const represented = fixture('open');
		represented.allocation.freeQuantity = 4;
		represented.allocation.reviewQuantity = 1;
		expect(evaluateInventoryContainerEconomy(represented)).toMatchObject({
			status: 'ready', decision: { action: 'open', quantity: 4 },
		});
		const silentRemainder = fixture('open');
		silentRemainder.allocation.freeQuantity = 4;
		expect(evaluateInventoryContainerEconomy(silentRemainder)).toEqual({
			status: 'review', reason: 'allocation_incoherent',
		});
	});

	it.each([
		['revoked activation', (value: InventoryContainerEconomyInputV1) => {
			value.economyPack.activation = { status: 'revoked', activatedAt: '2026-08-14T20:30:30.000Z' };
			value.economyPack.sha256 = sha256InventoryContainerEconomyPack(value.economyPack);
		}, 'activation_revoked'],
		['expired activation', (value: InventoryContainerEconomyInputV1) => { value.asOf = value.economyPack.validUntil; }, 'activation_expired'],
		['revoked rule', (value: InventoryContainerEconomyInputV1) => {
			value.rulePack.rules[0]!.status = 'revoked'; value.rulePack.sha256 = sha256InventoryRulePack(value.rulePack);
		}, 'rule_incoherent'],
		['rule hash drift', (value: InventoryContainerEconomyInputV1) => {
			value.rulePack.version += 1; value.rulePack.sha256 = sha256InventoryRulePack(value.rulePack);
		}, 'rule_incoherent'],
		['partial batch', (value: InventoryContainerEconomyInputV1) => {
			const missing = value.prices.items.pop()!; value.prices.missingItemIds = [missing.itemId]; value.prices.status = 'partial';
		}, 'price_partial'],
		['stale batch', (value: InventoryContainerEconomyInputV1) => { value.prices.capturedAt = '2026-08-14T20:00:00.000Z'; }, 'price_stale'],
		['identity drift', (value: InventoryContainerEconomyInputV1) => { value.prices.snapshotId = 'snapshot-foreign'; }, 'price_incoherent'],
		['foreign schema', (value: InventoryContainerEconomyInputV1) => { value.prices.schemaVersion = 'foreign-schema'; }, 'price_incoherent'],
		['missing outcome bid', (value: InventoryContainerEconomyInputV1) => { value.prices.items[1]!.bid = null; }, 'price_missing'],
		['insufficient sack depth', (value: InventoryContainerEconomyInputV1) => { value.prices.items[0]!.bid!.quantity = 4; }, 'price_partial'],
		['unknown binding', (value: InventoryContainerEconomyInputV1) => { value.container.binding = 'unknown'; }, 'binding_unknown'],
		['allocation overlap', (value: InventoryContainerEconomyInputV1) => { value.allocation.reservedQuantity = 6; }, 'allocation_incoherent'],
	] as const)('fails closed to review for %s', (_name, mutate, reason) => {
		const value = fixture('open');
		mutate(value);
		expect(evaluateInventoryContainerEconomy(value)).toEqual({ status: 'review', reason });
	});

	it('returns invalid instead of throwing for hostile or malformed inputs', () => {
		for (const value of [null, {}, { ...fixture('open'), prices: { then: () => { throw new Error('boom'); } } }]) {
			expect(() => evaluateInventoryContainerEconomy(value)).not.toThrow();
			expect(evaluateInventoryContainerEconomy(value)).toEqual({ status: 'invalid', reason: 'malformed_input' });
		}
	});
});

function fixture(route: 'open' | 'sell' | 'vendor'): InventoryContainerEconomyInputV1 {
	const loaded = createInventoryAdvisorBuiltinBundleProvider().load(AS_OF);
	if (loaded.status !== 'available') throw new Error('Expected built-in bundle.');
	const rulePack = structuredClone(loaded.bundle.rulePack);
	const economyPack = structuredClone(loaded.bundle.economyPack);
	const outcomeBid = route === 'open' ? 100 : 1;
	const sackBid = route === 'open' ? 1 : route === 'sell' ? 10_000 : 1;
	const items = economyPack.expectedPriceItemIds.map((itemId) => ({
		itemId,
		whitelisted: true,
		bid: { unitCopper: itemId === 36_038 ? sackBid : outcomeBid, quantity: 1_000 },
		ask: null,
	}));
	return {
		version: 1,
		asOf: AS_OF,
		accountId: 'account-1',
		snapshotId: 'snapshot-1',
		schemaVersion: '2024-07-20T01:00:00.000Z',
		allocation: { ownedQuantity: 10, availableQuantity: 10, reservedQuantity: 3, exceptionQuantity: 2,
			reviewQuantity: 0, freeQuantity: 5 },
		container: {
			itemId: 36_038,
			catalogItem: {
				kind: 'item', id: 36_038, name: 'Trick-or-Treat Bag', type: 'Container', rarity: 'Basic', level: 0,
				vendorValue: route === 'vendor' ? 100 : 0, flags: ['BulkConsume', 'NoSalvage'], gameTypes: [], restrictions: [],
			},
			binding: 'unbound',
			tradingAccess: 'full',
		},
		rulePack,
		knowledgePackSha256: rulePack.knowledgePackSha256,
		economyPack,
		prices: {
			version: 1,
			accountId: 'account-1',
			snapshotId: 'snapshot-1',
			schemaVersion: '2024-07-20T01:00:00.000Z',
			capturedAt: '2026-08-16T05:22:30.000Z',
			source: 'gw2-commerce-prices',
			requestedItemIds: structuredClone(economyPack.expectedPriceItemIds),
			status: 'complete',
			items,
			missingItemIds: [],
		},
	};
}
