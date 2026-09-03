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

// Inside the declared Halloween window. The curated pack is only trusted between
// its human activation and its TTL, and only advises while the festival is on.
const AS_OF = '2026-10-16T05:23:00.000Z';
const CAPTURED_AT = '2026-10-16T05:22:30.000Z';

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
			36_038, 36_041, 36_059, 36_060, 36_061, 79_673, 79_674, 79_677, 79_679,
			89_002, 89_007, 89_065, 89_070, 89_071,
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

	it('keeps the liquid-only result identical while an incomplete overlay has no personal EV or decision', () => {
		const withoutOverlay = evaluateInventoryContainerEconomy(fixture('open'));
		const value = fixture('open');
		value.personalValuation = { version: 1, values: [
			{ outcomeKey: 'item:36031', unitCopper: 0, origin: 'manual' },
		] };
		const result = evaluateInventoryContainerEconomy(value);
		expect(result.status).toBe('ready');
		expect(withoutOverlay.status).toBe('ready');
		if (result.status !== 'ready' || withoutOverlay.status !== 'ready') return;
		expect(result.liquidOnly).toEqual(withoutOverlay.liquidOnly);
		expect(result.personal).toMatchObject({
			valuation: { coverage: 'partial', knownAdjustment: 0, totalAdjustment: null },
			openEvPerContainerMicroCopper: null, totalExpectedMicroCopper: null,
			decision: null, comparison: null,
		});
		expect(result.recommendationBasis).toBe('liquid_only');
	});

	it.each([
		[10_000, 'open'],
		[0, 'sell'],
	] as const)('lets a complete personal overlay select %s copper outcomes as %s', (unitCopper, personalAction) => {
		const value = fixture('sell');
		value.personalValuation = {
			version: 1,
			values: value.economyPack.model.outcomes
				.filter((outcome) => outcome.valuationPolicy === 'excluded')
				.map((outcome) => ({ outcomeKey: outcome.key, unitCopper, origin: 'manual' as const })),
		};
		const result = evaluateInventoryContainerEconomy(value);
		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		expect(result.liquidOnly.decision.action).toBe('sell');
		expect(result.personal.valuation.coverage).toBe('complete');
		expect(result.personal.openEvPerContainerMicroCopper).not.toBeNull();
		expect(result.personal.decision?.action).toBe(personalAction);
		expect(result.decision.action).toBe(personalAction);
		expect(result.recommendationBasis).toBe('personal');
	});

	it('can move the personal decision from open back to sell when complete manual values change', () => {
		const value = fixture('sell');
		const values = value.economyPack.model.outcomes
			.filter((outcome) => outcome.valuationPolicy === 'excluded')
			.map((outcome) => ({ outcomeKey: outcome.key, unitCopper: 10_000, origin: 'manual' as const }));
		value.personalValuation = { version: 1, values };
		expect(evaluateInventoryContainerEconomy(value)).toMatchObject({
			status: 'ready', personal: { decision: { action: 'open' } },
		});
		value.personalValuation = { version: 1, values: values.map((entry) => ({ ...entry, unitCopper: 0 })) };
		expect(evaluateInventoryContainerEconomy(value)).toMatchObject({
			status: 'ready', personal: { decision: { action: 'sell' } },
		});
	});

	it('makes human activation effective at its exact timestamp, never before it', () => {
		const activatedAt = '2026-10-16T05:22:24.000Z';
		const before = activatedAtSeasonally(fixture('open'), activatedAt);
		before.asOf = '2026-10-16T05:22:23.999Z';
		expect(evaluateInventoryContainerEconomy(before)).toEqual({ status: 'review', reason: 'activation_expired' });
		const exact = activatedAtSeasonally(fixture('open'), activatedAt);
		exact.asOf = activatedAt;
		exact.prices.capturedAt = exact.asOf;
		exact.marketDepth!.capturedAt = exact.asOf;
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
		['stale batch', (value: InventoryContainerEconomyInputV1) => { value.prices.capturedAt = '2026-10-14T20:00:00.000Z'; }, 'price_stale'],
		['identity drift', (value: InventoryContainerEconomyInputV1) => { value.prices.snapshotId = 'snapshot-foreign'; }, 'price_incoherent'],
		['foreign schema', (value: InventoryContainerEconomyInputV1) => { value.prices.schemaVersion = 'foreign-schema'; }, 'price_incoherent'],
		// A quote without a bid is only unknown when the ORDER BOOK contradicts it.
		// The measured no-buyer case is covered by its own behaviour test below.
		['bid missing while the order book still shows buyers', (value: InventoryContainerEconomyInputV1) => {
			value.prices.items[1]!.bid = null;
		}, 'open_ev_partial'],
		['quote absent from a complete batch', (value: InventoryContainerEconomyInputV1) => {
			value.prices.items[1]!.itemId = 999_999;
			value.prices.requestedItemIds = value.prices.items.map((item) => item.itemId)
				.sort((left, right) => left - right);
		}, 'price_incoherent'],
		['missing listings port', (value: InventoryContainerEconomyInputV1) => { value.marketDepth = null; }, 'market_depth_missing'],
		['partial listings evidence', (value: InventoryContainerEconomyInputV1) => {
			value.marketDepth!.items[0] = { itemId: value.marketDepth!.items[0]!.itemId,
				coverage: 'unavailable', buys: [], sells: [] };
			value.marketDepth!.status = 'partial';
		}, 'market_depth_partial'],
		['insufficient sack depth', (value: InventoryContainerEconomyInputV1) => {
			value.marketDepth!.items.find((item) => item.itemId === 36_038)!.buys[0]!.quantity = 4;
		}, 'market_depth_partial'],
		['unknown binding', (value: InventoryContainerEconomyInputV1) => { value.container.binding = 'unknown'; }, 'binding_unknown'],
		['allocation overlap', (value: InventoryContainerEconomyInputV1) => { value.allocation.reservedQuantity = 6; }, 'allocation_incoherent'],
	] as const)('fails closed to review for %s', (_name, mutate, reason) => {
		const value = fixture('open');
		mutate(value);
		expect(evaluateInventoryContainerEconomy(value)).toEqual({ status: 'review', reason });
	});

	it('advises on the real market where six of the eight liquid outcomes have no buyer at all', () => {
		const result = evaluateInventoryContainerEconomy(todaysMarket());
		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		const explanation = result.liquidOnly.explanation;
		expect(explanation.routes.map((route) => route.saleBasis)).toEqual(['immediate', 'listing']);

		const immediate = explanation.routes[0]!;
		expect(immediate.execution).toBe('guaranteed_buyer');
		expect(immediate.open.coverage).toBe('declared_zero');
		expect(immediate.open.noCounterpartyItemIds).toEqual([36_059, 36_060, 36_061, 79_673, 79_677, 79_679, 89_002]);
		expect(immediate.sellNow).toMatchObject({ route: 'instant_sell', unitCopper: 358, netCopper: 304 });
		expect(immediate.open.evPerContainerMicroCopper).toBe(207_369_813);
		expect(immediate.threshold.requiredOpenMicroCopper).toBe('334400000');
		expect(immediate.decision).toEqual({ action: 'sell', sellRoute: 'instant_sell' });

		const listing = explanation.routes[1]!;
		expect(listing.execution).toBe('reference_listing');
		expect(listing.sellNow).toMatchObject({ route: 'listing', unitCopper: 400, netCopper: 340 });
		expect(listing.open.evPerContainerMicroCopper).toBe(308_402_590);
		expect(listing.threshold.requiredOpenMicroCopper).toBe('374000000');
		expect(listing.decision).toEqual({ action: 'sell', sellRoute: 'listing' });

		expect(explanation.preferredSaleBasis).toBe('immediate');
		expect(explanation.caveats).toContain('outcomes_without_counterparty_valued_at_zero');
		expect(explanation.caveats).toContain('listing_route_is_reference_not_demand');
		expect(result.decision).toMatchObject({ action: 'sell', quantity: 1 });
	});

	it('recommends through the listing route when the bag itself has no buyer, and says it is a reference', () => {
		const value = todaysMarket();
		const bag = value.prices.items.find((item) => item.itemId === 36_038)!;
		bag.bid = null;
		value.marketDepth!.items.find((item) => item.itemId === 36_038)!.buys = [];
		const result = evaluateInventoryContainerEconomy(value);
		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		const explanation = result.liquidOnly.explanation;
		expect(explanation.routes.map((route) => route.saleBasis)).toEqual(['listing']);
		expect(explanation.preferredSaleBasis).toBe('listing');
		expect(explanation.sellNow.route).toBe('listing');
		expect(explanation.caveats).toContain('no_immediate_sale_route');
		expect(result.decision).toMatchObject({ action: 'sell', quantity: 1 });
	});

	it('prices the excluded jackpot tail apart without moving the conservative recommendation', () => {
		const result = evaluateInventoryContainerEconomy(todaysMarket());
		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		const explanation = result.liquidOnly.explanation;
		expect(explanation.tail).toMatchObject({
			containerItemId: 36_038, bucketSampleUnits: 1_171, itemizedSampleUnits: 13,
		});
		expect(explanation.tail?.immediate.evPerContainerMicroCopper).toBe(78_574_569);
		const immediate = explanation.routes[0]!;
		// The tail is worth more than a third of the conservative figure and is
		// still not enough to open: both facts are visible, neither is inferred.
		expect(immediate.openIncludingTail?.evPerContainerMicroCopper).toBe(285_944_382);
		expect(immediate.openIncludingTail?.meetsThreshold).toBe(false);
		expect(immediate.open.evPerContainerMicroCopper).toBe(207_369_813);
		expect(immediate.decision.action).toBe('sell');
		expect(explanation.tail!.immediate.deviationPerContainerMicroCopper)
			.toBeGreaterThan(immediate.openIncludingTail!.evPerContainerMicroCopper * 30);
	});

	/**
	 * H13.2 inverted this deliberately.
	 *
	 * The advisor used to refuse outside the window, which meant refusing for
	 * eleven months of the year including every month in which the bag is worth
	 * the most. The bag quotes all year and selling it is an out-of-season act,
	 * so the calendar no longer gates the recommendation; it gates the hold.
	 */
	it('keeps advising outside the declared festival window, where the price peaks', () => {
		const value = todaysMarket();
		const outOfSeason = '2026-09-01T05:23:00.000Z';
		value.asOf = outOfSeason;
		value.prices.capturedAt = outOfSeason;
		value.marketDepth!.capturedAt = outOfSeason;

		const result = evaluateInventoryContainerEconomy(value);

		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		expect(result.decision.action).toBe('sell');
		expect(value.economyPack.season).toEqual({
			version: 1, seasonId: 'halloween', opensOn: '10-01', closesOn: '11-15', returnsInMonth: 10,
		});
	});

	/**
	 * An unreadable calendar still fails closed, one layer earlier than the
	 * seasonal check.
	 *
	 * The window is hashed into the pack, so a malformed one cannot reach the
	 * seasonal comparison at all: the pack fails validation first. The
	 * `undecidable` branch inside `evaluateInventoryContainerEconomy` is
	 * therefore defensive rather than reachable through a valid pack, and this
	 * case pins the outcome that IS reachable.
	 */
	it('refuses a pack whose window cannot be read, rather than assuming a season', () => {
		const value = todaysMarket();
		const outOfSeason = '2026-09-01T05:23:00.000Z';
		value.asOf = outOfSeason;
		value.prices.capturedAt = outOfSeason;
		value.marketDepth!.capturedAt = outOfSeason;
		(value.economyPack.season as { closesOn: string }).closesOn = 'not-a-day';

		expect(evaluateInventoryContainerEconomy(value)).toEqual({ status: 'invalid', reason: 'malformed_input' });
	});

	it('recommends `hold` inside the window when the annual series says today is the floor', () => {
		const value = todaysMarket();
		const inSeason = '2026-10-20T05:23:00.000Z';
		value.asOf = inSeason;
		value.prices.capturedAt = inSeason;
		value.marketDepth!.capturedAt = inSeason;
		value.sellSignal = {
			status: 'decided', signal: 'hold', dayUtc: '2026-10-20', bidCopper: 300,
			referenceMaxCopper: 451, referenceMinCopper: 300, referenceDayCount: 360,
			sellThresholdCopper: 406, inSeason: true, origin: 'seeded',
		};

		const result = evaluateInventoryContainerEconomy(value);

		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		expect(result.decision.action).toBe('hold');
		// The liquid economics stay visible underneath: the player is told what
		// holding is instead of, not only that it is advised.
		expect(result.liquidOnly.decision.action).toBe('sell');
	});

	it('ignores a hold signal raised outside the window', () => {
		const value = todaysMarket();
		const outOfSeason = '2026-09-01T05:23:00.000Z';
		value.asOf = outOfSeason;
		value.prices.capturedAt = outOfSeason;
		value.marketDepth!.capturedAt = outOfSeason;
		value.sellSignal = {
			status: 'decided', signal: 'hold', dayUtc: '2026-09-01', bidCopper: 300,
			referenceMaxCopper: 451, referenceMinCopper: 300, referenceDayCount: 360,
			sellThresholdCopper: 406, inSeason: false, origin: 'seeded',
		};

		const result = evaluateInventoryContainerEconomy(value);

		expect(result.status).toBe('ready');
		if (result.status !== 'ready') return;
		expect(result.decision.action).toBe('sell');
	});

	it('returns invalid instead of throwing for hostile or malformed inputs', () => {
		for (const value of [null, {}, { ...fixture('open'), prices: { then: () => { throw new Error('boom'); } } }]) {
			expect(() => evaluateInventoryContainerEconomy(value)).not.toThrow();
			expect(evaluateInventoryContainerEconomy(value)).toEqual({ status: 'invalid', reason: 'malformed_input' });
		}
	});
});

/**
 * The order book as `/v2/commerce/listings` really served it on 2026-09-01.
 *
 * Six of the eight liquid outcomes have zero buy orders and tens of millions of
 * units on sale at 30 copper: that is their normal state all year, not a glitch
 * of one capture. The two tonics the audit did not list are given the same
 * shape as their sibling, which is the conservative reading.
 */
const TODAYS_BOOK: ReadonlyArray<{ itemId: number; bid: number | null; ask: number | null }> = [
	{ itemId: 36_038, bid: 358, ask: 400 },
	{ itemId: 36_041, bid: 67, ask: 72 },
	{ itemId: 36_059, bid: null, ask: 30 },
	{ itemId: 36_060, bid: null, ask: 30 },
	{ itemId: 36_061, bid: null, ask: 30 },
	{ itemId: 79_673, bid: null, ask: 2 },
	{ itemId: 79_674, bid: 1_132_705, ask: 1_300_000 },
	{ itemId: 79_677, bid: null, ask: 2 },
	{ itemId: 79_679, bid: null, ask: 2 },
	{ itemId: 89_002, bid: null, ask: 6 },
	{ itemId: 89_007, bid: 320_307, ask: 360_000 },
	{ itemId: 89_065, bid: 2_900_120, ask: 3_100_000 },
	{ itemId: 89_070, bid: 266_276, ask: 300_000 },
	{ itemId: 89_071, bid: 270_038, ask: 305_000 },
];

function todaysMarket(): InventoryContainerEconomyInputV1 {
	const value = fixture('sell');
	// One free bag, so every figure below is per bag and comparable line by line
	// with the audited order book instead of with a stack multiple.
	value.allocation = { ownedQuantity: 10, availableQuantity: 10, reservedQuantity: 3, exceptionQuantity: 2,
		reviewQuantity: 4, freeQuantity: 1 };
	value.prices.items = TODAYS_BOOK.map((entry) => ({
		itemId: entry.itemId,
		whitelisted: true,
		bid: entry.bid === null ? null : { unitCopper: entry.bid, quantity: 100_000 },
		ask: entry.ask === null ? null : { unitCopper: entry.ask, quantity: 30_000_000 },
	}));
	value.marketDepth!.items = TODAYS_BOOK.map((entry) => ({
		itemId: entry.itemId,
		coverage: 'complete' as const,
		buys: entry.bid === null ? [] : [{ unitCopper: entry.bid, quantity: 100_000 }],
		sells: entry.ask === null ? [] : [{ unitCopper: entry.ask, quantity: 30_000_000 }],
	}));
	return value;
}

/** Re-activates the pack inside the declared season and reseals its hash. */
function activatedAtSeasonally(
	value: InventoryContainerEconomyInputV1,
	activatedAt: string,
): InventoryContainerEconomyInputV1 {
	value.economyPack.activation = { status: 'enabled', activatedAt };
	value.economyPack.sha256 = sha256InventoryContainerEconomyPack(value.economyPack);
	return value;
}

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
			capturedAt: CAPTURED_AT,
			source: 'gw2-commerce-prices',
			requestedItemIds: structuredClone(economyPack.expectedPriceItemIds),
			status: 'complete',
			items,
			missingItemIds: [],
		},
		marketDepth: {
			version: 1,
			capturedAt: CAPTURED_AT,
			source: 'gw2-commerce-listings',
			requestedItemIds: structuredClone(economyPack.expectedPriceItemIds),
			status: 'complete',
			items: items.map((item) => ({
				itemId: item.itemId,
				coverage: 'complete',
				buys: [{ unitCopper: item.bid.unitCopper, quantity: 1_000_000 }],
				sells: [],
			})),
		},
	};
}
