import { describe, expect, it } from 'vitest';

import type { StorageDelta } from '../account/storage-delta-model';
import { afterSnapshot, embeddedHolding, looseHolding, walletCurrency, withoutDelivery } from '../account/__fixtures__/storage-delta';
import {
	buildReservationBalance,
	createReservationPlan,
	isReservationBalance,
	isReservationGoal,
	isReservationPlan,
	isSessionValuationReservationOverlay,
	partitionSessionValuation,
} from './reservation';
import type {
	IntendedUse,
	ReservationBalance,
	ReservationBasis,
	ReservationGoal,
	ReservationPlan,
} from './reservation-model';
import { valueInstantSellDepth } from './commerce-listings';
import { isSessionValuation, type SessionValuation } from './session-valuation';

describe('createReservationPlan', () => {
	it('leaves the complete available pool unreserved when there are no goals', () => {
		const plan = requirePlan(createReservationPlan({ goals: [], balance: balance(120, 120) }));
		expect(plan).toMatchObject({ coverage: 'complete', satisfaction: 'met', warnings: [] });
		expect(plan.assets[0]).toMatchObject({
			requested: 0, protectedAvailable: 0, unprotectedAvailable: 120, shortfall: 0,
			allocations: [],
			allowances: { liquidate: 120, open: 120, consume: 120, exchange: 120, spend: null },
		});
	});

	it('protects 100 of 120 available units for a hold goal', () => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('goal-a', 100)], balance: balance(120, 120) }));
		expect(plan.assets[0]).toMatchObject({
			requested: 100, protectedAvailable: 100, unprotectedAvailable: 20,
			allowances: { liquidate: 20, open: 20, consume: 20, exchange: 20 },
			allocations: [{ goalId: 'goal-a', reason: 'personal', required: 100, satisfied: 100,
				protectedAvailable: 100, shortfall: 0 }],
		});
	});

	it('protects only ten of a thirty-unit gain when the final balance has twenty unreserved units', () => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('goal-a', 100)], balance: balance(120, 120) }));
		const overlay = requireOverlay(partitionSessionValuation({
			valuation: valuation(ITEM_ID, 30), delta: delta(ITEM_ID, 30), plan, sackItemIds: [],
		}));
		expect(overlay.lines[0]).toEqual({
			itemId: ITEM_ID, gainedQuantity: 30, protectedFromLiquidation: 10,
			liquidationEligible: 20, openEligible: 20, consumeEligible: 20, exchangeEligible: 20,
		});
	});

	it.each([
		['open', 'open'],
		['consume', 'consume'],
		['exchange', 'exchange'],
	] as Array<['open' | 'consume' | 'exchange', 'open' | 'consume' | 'exchange']>)('re-adds protected quantities only to intended %s use', (use) => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('goal-a', 80, { intendedUse: use })], balance: balance(100, 100) }));
		const allowances = plan.assets[0]!.allowances;
		expect(allowances[use]).toBe(100);
		expect(allowances.liquidate).toBe(20);
		for (const other of ['open', 'consume', 'exchange'] as const) {
			if (other !== use) expect(allowances[other]).toBe(20);
		}
	});

	it('keeps currency namespace separate and permits only spend or hold', () => {
		const spend = goal('coins', 80, { namespace: 'currency', id: 1, intendedUse: 'spend' });
		const plan = requirePlan(createReservationPlan({ goals: [spend], balance: balance(100, 100, 'complete', 'currency', 1) }));
		expect(plan.assets[0]!.allowances).toEqual({ liquidate: null, open: null, consume: null, exchange: null, spend: 100 });
		const held = requirePlan(createReservationPlan({
			goals: [goal('held-coins', 80, { namespace: 'currency', id: 1, intendedUse: 'hold' })],
			balance: balance(100, 100, 'complete', 'currency', 1),
		}));
		expect(held.assets[0]!.allowances.spend).toBe(20);
		expect(isReservationGoal(goal('bad', 1, { namespace: 'currency', id: 1, intendedUse: 'open' }))).toBe(false);
	});

	it('uses non-available owned units before protecting available units', () => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('embedded', 100, { basis: 'owned' })], balance: balance(120, 20) }));
		expect(plan.assets[0]).toMatchObject({ protectedAvailable: 0, unprotectedAvailable: 20, shortfall: 0 });
	});

	it('allocates additively and exclusively across duplicate goals with a warning', () => {
		const plan = requirePlan(createReservationPlan({
			goals: [goal('high', 80, { priority: 10 }), goal('low', 50, { priority: 1 })],
			balance: balance(100, 100),
		}));
		expect(plan.assets[0]!.allocations).toMatchObject([
			{ goalId: 'high', satisfied: 80, shortfall: 0 },
			{ goalId: 'low', satisfied: 20, shortfall: 30 },
		]);
		expect(plan.warnings).toEqual(expect.arrayContaining([
			{ code: 'insufficient_quantity', key: `item:${ITEM_ID}` },
			{ code: 'multiple_goals_same_asset', key: `item:${ITEM_ID}` },
		]));
	});

	it('breaks equal-priority ties by goal id and ignores paused/completed/credited units', () => {
		const credited = goal('b', 70, { priority: 5, creditedQuantity: 20 });
		const active = goal('a', 60, { priority: 5 });
		const fullyCredited = goal('credited-out', 100, { creditedQuantity: 100, id: 999 });
		const paused = { ...goal('paused', 100), status: 'paused' as const };
		const completed = { ...goal('completed', 100), status: 'completed' as const };
		const plan = requirePlan(createReservationPlan({ goals: [credited, completed, paused, fullyCredited, active], balance: balance(100, 100) }));
		expect(plan.assets[0]!.allocations).toMatchObject([
			{ goalId: 'a', required: 60, satisfied: 60 },
			{ goalId: 'b', required: 50, satisfied: 40, shortfall: 10 },
		]);
		expect(plan.assets.some((asset) => asset.key === 'item:999')).toBe(false);
	});

	it.each([
		['limited', 'limited', 'limited_balance'],
		['unknown', 'blocked', 'unknown_balance'],
	] as const)('propagates %s evidence without inventing allowances', (coverage, global, warning) => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('a', 10)], balance: balance(20, 20, coverage) }));
		expect(plan.coverage).toBe(global);
		expect(plan.warnings).toContainEqual({ code: warning, key: `item:${ITEM_ID}` });
		if (coverage === 'unknown') expect(plan.assets[0]!.allowances.liquidate).toBeNull();
	});

	it('uses namespace coverage when a required asset is absent from the balance', () => {
		const empty = { ...balance(0, 0, 'limited'), assets: [] };
		const plan = requirePlan(createReservationPlan({ goals: [goal('a', 10)], balance: empty }));
		expect(plan).toMatchObject({ coverage: 'limited', satisfaction: 'shortfall' });
		expect(plan.assets[0]).toMatchObject({ coverage: 'limited', ownedQuantity: 0, shortfall: 10 });
	});

	it('is invariant to goal input permutation', () => {
		const goals = [goal('b', 30, { priority: 4 }), goal('a', 50, { priority: 8 })];
		const evidence = balance(100, 100);
		const before = JSON.stringify({ goals, evidence });
		const forward = requirePlan(createReservationPlan({ goals, balance: evidence }));
		const reverse = requirePlan(createReservationPlan({ goals: [...goals].reverse(), balance: balance(100, 100) }));
		expect(reverse).toEqual(forward);
		expect(JSON.stringify({ goals, evidence })).toBe(before);
	});

	it('fails closed for malformed data, duplicate requirements, and overflow', () => {
		expect(createReservationPlan(null)).toMatchObject({ status: 'invalid' });
		const duplicate = goal('a', 10);
		duplicate.requirements.push({ ...duplicate.requirements[0]! });
		expect(createReservationPlan({ goals: [duplicate], balance: balance(10, 10) })).toMatchObject({ status: 'invalid' });
		const duplicateTitle = { ...goal('b', 1), title: goal('a', 1).title };
		expect(createReservationPlan({ goals: [goal('a', 1), duplicateTitle], balance: balance(10, 10) }))
			.toEqual({ status: 'invalid', reason: 'duplicate_goal' });
		expect(createReservationPlan({
			goals: [goal('a', Number.MAX_SAFE_INTEGER), goal('b', Number.MAX_SAFE_INTEGER)],
			balance: balance(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
		})).toEqual({ status: 'invalid', reason: 'arithmetic_overflow' });
		expect(() => isReservationPlan({
			...requirePlan(createReservationPlan({ goals: [goal('safe', 1)], balance: balance(2, 2) })),
			assets: [{
				...requirePlan(createReservationPlan({ goals: [goal('safe', 1)], balance: balance(2, 2) })).assets[0],
				allocations: [{ goalId: 'x', priority: 0, required: Number.MAX_SAFE_INTEGER,
					satisfied: Number.MAX_SAFE_INTEGER, protectedAvailable: 0,
					shortfall: Number.MAX_SAFE_INTEGER, basis: 'owned', intendedUse: 'hold' }],
			}],
		})).not.toThrow();
	});

	it('retains basis and rejects allocations that claim the wrong pool', () => {
		const available = requirePlan(createReservationPlan({
			goals: [goal('available', 10, { basis: 'available' })], balance: balance(20, 10),
		}));
		expect(available.assets[0]!.allocations[0]).toMatchObject({
			basis: 'available', satisfied: 10, protectedAvailable: 10,
		});
		expect(isReservationPlan({
			...available,
			assets: [{ ...available.assets[0]!, allocations: [{
				...available.assets[0]!.allocations[0]!, basis: 'owned',
			}] }],
		})).toBe(false);

		const owned = requirePlan(createReservationPlan({
			goals: [goal('owned', 10, { basis: 'owned' })], balance: balance(20, 5),
		}));
		expect(owned.assets[0]!.allocations[0]).toMatchObject({
			basis: 'owned', satisfied: 10, protectedAvailable: 0,
		});
		expect(isReservationPlan({
			...owned,
			assets: [{ ...owned.assets[0]!, allocations: [{
				...owned.assets[0]!.allocations[0]!, basis: 'available',
			}] }],
		})).toBe(false);
	});

	it('rejects duplicate goal allocations even when aggregate pools still reconcile', () => {
		const plan = requirePlan(createReservationPlan({
			goals: [goal('same-goal', 10)], balance: balance(30, 30),
		}));
		const allocation = plan.assets[0]!.allocations[0]!;
		const manipulated = {
			...plan,
			assets: [{
				...plan.assets[0]!, requested: 20, protectedAvailable: 20,
				unprotectedAvailable: 10, allocations: [allocation, { ...allocation }],
				allowances: { liquidate: 10, open: 10, consume: 10, exchange: 10, spend: null },
			}],
		};
		expect(isReservationPlan(manipulated)).toBe(false);
	});

	it('maintains pool and allocation property invariants', () => {
		for (let owned = 0; owned <= 20; owned += 5) {
			for (let available = 0; available <= owned; available += 5) {
				const plan = requirePlan(createReservationPlan({ goals: [goal('a', 7), goal('b', 9)], balance: balance(owned, available) }));
				const asset = plan.assets[0]!;
				expect(asset.protectedAvailable + asset.unprotectedAvailable).toBe(available);
				expect(asset.allocations.reduce((sum, allocation) => sum + allocation.satisfied, 0)).toBeLessThanOrEqual(owned);
				expect(asset.allocations.every((allocation) => allocation.satisfied + allocation.shortfall === allocation.required)).toBe(true);
			}
		}
	});
});

describe('buildReservationBalance', () => {
	it('derives owned/available pools and full evidence from a clean final snapshot', () => {
		const location = { source: 'bank', slot: 0 } as const;
		const snapshot = afterSnapshot({ holdings: [
			looseHolding(999, 1, location), embeddedHolding(ITEM_ID, 999, location),
			looseHolding(ITEM_ID, 2, { source: 'bank', slot: 1 }),
		], currencies: [walletCurrency(1, 100)] });
		const value = requireBalance(buildReservationBalance(snapshot));
		expect(value.assets.find((asset) => asset.key === `item:${ITEM_ID}`)).toMatchObject({
			ownedQuantity: 3, availableQuantity: 2, coverage: 'complete',
		});
		expect(value.assets.find((asset) => asset.key === 'currency:1')).toMatchObject({
			ownedQuantity: 100, availableQuantity: 100, coverage: 'complete',
		});
	});

	it('marks delivery-limited items/currencies and wallet-unobserved currencies unknown', () => {
		const limited = requireBalance(buildReservationBalance(withoutDelivery(afterSnapshot())));
		expect(limited.assets.every((asset) => asset.coverage === 'limited')).toBe(true);
		expect(limited.coverage).toEqual({ item: 'limited', currency: 'limited' });
		const noWallet = afterSnapshot({ coverage: {
			...afterSnapshot().coverage,
			sources: { ...afterSnapshot().coverage.sources, wallet: { status: 'skipped', reason: 'missing_scope' } },
		} });
		const unknown = requireBalance(buildReservationBalance(noWallet));
		expect(unknown.assets.find((asset) => asset.namespace === 'currency')?.coverage).toBe('unknown');
		expect(unknown.coverage).toEqual({ item: 'complete', currency: 'unknown' });
	});

	it.each([
		['full item', afterSnapshot(), goal('missing-item', 1, { id: 987_001 }), 'complete'],
		['limited item', withoutDelivery(afterSnapshot()), goal('missing-item', 1, { id: 987_001 }), 'limited'],
		['full currency', afterSnapshot(), goal('missing-currency', 1, { namespace: 'currency', id: 987_002, intendedUse: 'hold' }), 'complete'],
		['unobserved currency', afterSnapshot({ coverage: {
			...afterSnapshot().coverage,
			sources: { ...afterSnapshot().coverage.sources, wallet: { status: 'skipped', reason: 'missing_scope' } },
		} }), goal('missing-currency', 1, { namespace: 'currency', id: 987_002, intendedUse: 'hold' }), 'unknown'],
	] as const)('synthesizes zero with %s namespace evidence for a missing ID', (_label, snapshot, missingGoal, coverage) => {
		const evidence = requireBalance(buildReservationBalance(snapshot));
		const plan = requirePlan(createReservationPlan({ goals: [missingGoal], balance: evidence }));
		expect(plan.assets.find((asset) => asset.key === missingGoal.requirements[0]!.key)).toMatchObject({
			ownedQuantity: 0, availableQuantity: 0, coverage, shortfall: 1,
		});
	});

	it('exports strict balance validators and rejects corrupt aggregates', () => {
		const value = requireBalance(buildReservationBalance(afterSnapshot()));
		expect(isReservationBalance(value)).toBe(true);
		expect(buildReservationBalance(afterSnapshot({ availableByItem: { '100': 999 } }))).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
		expect(buildReservationBalance(afterSnapshot({ ownedByItem: { '100': 999 } }))).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
		expect(buildReservationBalance(afterSnapshot({ quality: 'partial' }))).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
	});
});

describe('partitionSessionValuation', () => {
	it('rejects identity and line evidence mismatch', () => {
		const plan = requirePlan(createReservationPlan({ goals: [], balance: balance(30, 30) }));
		expect(partitionSessionValuation({ valuation: valuation(ITEM_ID, 30), delta: { ...delta(ITEM_ID, 30), accountId: 'other' }, plan, sackItemIds: [] }))
			.toEqual({ status: 'invalid', reason: 'identity_mismatch' });
		expect(partitionSessionValuation({ valuation: valuation(ITEM_ID, 29), delta: delta(ITEM_ID, 30), plan, sackItemIds: [] }))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
		const twoGains = { ...delta(ITEM_ID, 30), itemChanges: [
			{ id: ITEM_ID, before: 0, after: 30, delta: 30 },
			{ id: ITEM_ID + 1, before: 0, after: 1, delta: 1 },
		] };
		expect(partitionSessionValuation({ valuation: valuation(ITEM_ID, 30), delta: twoGains, plan, sackItemIds: [] }))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
		expect(partitionSessionValuation({ valuation: valuation(ITEM_ID, 30), delta: { ...delta(ITEM_ID, 30), extra: true }, plan, sackItemIds: [] }))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
		expect(partitionSessionValuation({
			valuation: { ...valuation(ITEM_ID, 30), lines: [{ ...valuation(ITEM_ID, 30).lines[0]!, instantSell: {} }] },
			delta: delta(ITEM_ID, 30), plan, sackItemIds: [],
		})).toEqual({ status: 'invalid', reason: 'invalid_input' });
	});

	it('keeps valuation byte-semantic unchanged and does not prorate money or fees', () => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('a', 100)], balance: balance(120, 120) }));
		const original = valuation(ITEM_ID, 30);
		const bytes = JSON.stringify(original);
		const overlay = requireOverlay(partitionSessionValuation({ valuation: original, delta: delta(ITEM_ID, 30), plan, sackItemIds: [] }));
		expect(overlay.valuation).toBe(original);
		expect(JSON.stringify(overlay.valuation)).toBe(bytes);
		expect(overlay.valuation.totals.observedImmediateCopper).toBe(300);
		expect(overlay.lines[0]).toMatchObject({ liquidationEligible: 20, protectedFromLiquidation: 10 });
		expect(isSessionValuationReservationOverlay(overlay)).toBe(true);
	});

	it('preserves null-aware allowances for unknown evidence', () => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('a', 10)], balance: balance(30, 30, 'unknown') }));
		const overlay = requireOverlay(partitionSessionValuation({ valuation: valuation(ITEM_ID, 30), delta: delta(ITEM_ID, 30), plan, sackItemIds: [] }));
		expect(overlay.lines[0]).toMatchObject({
			protectedFromLiquidation: null, liquidationEligible: null, openEligible: null,
		});
	});

	it('exports a strict plan validator', () => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('a', 10)], balance: balance(30, 30) }));
		expect(isReservationPlan(plan)).toBe(true);
		expect(isReservationPlan({ ...plan, assets: [{ ...plan.assets[0], protectedAvailable: 999 }] })).toBe(false);
	});

	it('rejects internally corrupt H4.5 valuation evidence', () => {
		const valid = valuation(ITEM_ID, 30);
		expect(isSessionValuation(valid, delta(ITEM_ID, 30), [])).toBe(true);
		const corrupt = { ...valid, totals: { ...valid.totals, observedImmediateCopper: 12_345 } };
		expect(isSessionValuation(corrupt, delta(ITEM_ID, 30), [])).toBe(false);
		expect(isSessionValuation({
			...valid, lines: [{ ...valid.lines[0]!, immediateBestCopper: 12_345 }],
		}, delta(ITEM_ID, 30), [])).toBe(false);
		expect(isSessionValuation({
			...valid, rates: { ...valid.rates, immediateCopperPerHour: 12_345 },
		}, delta(ITEM_ID, 30), [])).toBe(false);
		const plan = requirePlan(createReservationPlan({ goals: [], balance: balance(30, 30) }));
		expect(partitionSessionValuation({ valuation: corrupt, delta: delta(ITEM_ID, 30), plan, sackItemIds: [] }))
			.toEqual({ status: 'invalid', reason: 'invalid_input' });
	});

	it('requires every non-null action allowance to include liquidation eligibility', () => {
		const plan = requirePlan(createReservationPlan({ goals: [goal('a', 10)], balance: balance(30, 30) }));
		const overlay = requireOverlay(partitionSessionValuation({
			valuation: valuation(ITEM_ID, 30), delta: delta(ITEM_ID, 30), plan, sackItemIds: [],
		}));
		expect(isSessionValuationReservationOverlay({
			...overlay,
			lines: [{ ...overlay.lines[0]!, openEligible: overlay.lines[0]!.liquidationEligible! - 1 }],
		})).toBe(false);
	});

	it('rejects malformed delta reasons and composition through the authoritative H2.7 validator', () => {
		const plan = requirePlan(createReservationPlan({ goals: [], balance: balance(30, 30) }));
		for (const malformed of [
			{ ...delta(ITEM_ID, 30), reasons: [{}] },
			{ ...delta(ITEM_ID, 30), compositionChanges: [{}] },
		]) {
			expect(isSessionValuation(valuation(ITEM_ID, 30), malformed, [])).toBe(false);
			expect(partitionSessionValuation({
				valuation: valuation(ITEM_ID, 30), delta: malformed, plan, sackItemIds: [],
			})).toEqual({ status: 'invalid', reason: 'invalid_input' });
		}
	});

	it('rejects zero-fee TP, bound TP, and sack rates without matching provenance', () => {
		const valid = valuationWithInstantSell(ITEM_ID, 30);
		expect(isSessionValuation(valid, delta(ITEM_ID, 30), [])).toBe(true);
		const route = valid.lines[0]!.instantSell!;
		const zeroFeeRoute = { ...route, netCopper: route.grossCopper };
		const zeroFee = withImmediateRoute(valid, zeroFeeRoute);
		expect(isSessionValuation(zeroFee, delta(ITEM_ID, 30), [])).toBe(false);
		expect(isSessionValuation({
			...valid, lines: [{ ...valid.lines[0]!, binding: 'account_bound' }],
		}, delta(ITEM_ID, 30), [])).toBe(false);
		expect(isSessionValuation(valuation(ITEM_ID, 30), delta(ITEM_ID, 30), [ITEM_ID])).toBe(false);
	});
});

const ITEM_ID = 42;

function goal(
	goalId: string,
	targetQuantity: number,
	overrides: Partial<{ priority: number; creditedQuantity: number; basis: ReservationBasis; intendedUse: IntendedUse; namespace: 'item' | 'currency'; id: number }> = {},
): ReservationGoal {
	const namespace = overrides.namespace ?? 'item';
	const id = overrides.id ?? ITEM_ID;
	return {
		schemaVersion: 1, goalId, title: `Goal ${goalId}`, status: 'active',
		priority: overrides.priority ?? 0, reason: 'personal',
		requirements: [{
			key: `${namespace}:${id}`, namespace, id, targetQuantity,
			creditedQuantity: overrides.creditedQuantity ?? 0,
			basis: overrides.basis ?? 'available', intendedUse: overrides.intendedUse ?? 'hold',
		}],
	};
}

function balance(
	ownedQuantity: number,
	availableQuantity: number,
	coverage: 'complete' | 'limited' | 'unknown' = 'complete',
	namespace: 'item' | 'currency' = 'item',
	id = ITEM_ID,
): ReservationBalance {
	return {
		accountId: 'account-1', snapshotId: 'after', capturedAt: '2026-08-13T09:30:00.000Z',
		coverage: { item: coverage, currency: coverage },
		assets: [{ key: `${namespace}:${id}`, namespace, id, ownedQuantity, availableQuantity, coverage }],
	};
}

function delta(itemId: number, quantity: number): StorageDelta {
	return {
		version: 1, status: 'comparable', accountId: 'account-1', beforeSnapshotId: 'before', afterSnapshotId: 'after',
		window: { from: '2026-08-13T09:00:00.000Z', to: '2026-08-13T09:30:00.000Z' },
		surface: 'core_and_delivery', currencySurface: 'wallet_and_delivery', reasons: [], warnings: [],
		itemChanges: [{ id: itemId, before: 0, after: quantity, delta: quantity }],
		currencyChanges: [], availabilityChanges: [], compositionChanges: [],
	};
}

function valuation(itemId: number, quantity: number): SessionValuation {
	const vendor = { version: 1 as const, kind: 'vendor' as const, priceSource: 'vendor_value' as const,
		liquidity: 'immediate' as const, quantity, unitCopper: 10, grossCopper: quantity * 10,
		netCopper: quantity * 10 };
	const total = quantity * 10;
	return {
		version: 1, sessionId: 'session-1', priceCapturedAt: '2026-08-13T09:30:01.000Z',
		priceSource: 'gw2-commerce-prices', coverage: 'complete', durationMs: 30 * 60_000,
		lines: [{ itemId, quantity, binding: 'unbound', instantSell: null,
			instantSellDepthCoverage: 'not_applicable', listing: null, vendor,
			immediateBestCopper: total, listingBestCopper: total, nonLiquid: false, reason: null }],
		totals: { itemImmediateCopper: total, itemListingCopper: total, coinNetCopper: 0,
			observedImmediateCopper: total, observedListingCopper: total,
			nonLiquidItemKinds: 0, nonLiquidQuantity: 0 },
		rates: { sacks: 0, sacksPerHourMilli: 0, immediateCopperPerHour: total * 2,
			listingCopperPerHour: total * 2 }, warnings: [],
	};
}

function valuationWithInstantSell(itemId: number, quantity: number): SessionValuation {
	const result = valueInstantSellDepth([{ unitCopper: 100, quantity }], quantity);
	if (result.status !== 'complete') throw new Error('Expected complete Trading Post depth.');
	return withImmediateRoute(valuation(itemId, quantity), result);
}

function withImmediateRoute(
	value: SessionValuation,
	route: NonNullable<SessionValuation['lines'][number]['instantSell']>,
): SessionValuation {
	if (route.status !== 'complete' || route.netCopper === null) throw new Error('Expected a complete instant-sell route.');
	const immediate = Math.max(route.netCopper, value.lines[0]!.vendor?.netCopper ?? 0);
	return {
		...value,
		lines: [{ ...value.lines[0]!, instantSell: route, instantSellDepthCoverage: 'complete',
			immediateBestCopper: immediate }],
		totals: { ...value.totals, itemImmediateCopper: immediate, observedImmediateCopper: immediate },
		rates: { ...value.rates, immediateCopperPerHour: immediate * 2 },
	};
}

function requirePlan(result: ReturnType<typeof createReservationPlan>): ReservationPlan {
	if (result.status !== 'ok') throw new Error(`Expected plan, received ${result.reason}.`);
	return result.plan;
}

function requireBalance(result: ReturnType<typeof buildReservationBalance>): ReservationBalance {
	if (result.status !== 'ok') throw new Error(`Expected balance, received ${result.reason}.`);
	return result.balance;
}

function requireOverlay(result: ReturnType<typeof partitionSessionValuation>) {
	if (result.status !== 'ok') throw new Error(`Expected overlay, received ${result.reason}.`);
	return result.overlay;
}
