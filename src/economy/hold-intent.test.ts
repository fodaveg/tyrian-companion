import { describe, expect, it } from 'vitest';

import {
	evaluateHoldIntents,
	isHoldIntent,
	isHoldPlan,
	type HoldIntentInput,
	type HoldIntentV1,
} from './hold-intent';

const AS_OF = '2026-08-13T10:00:00.000Z';

describe('evaluateHoldIntents', () => {
	it('holds below target before the deadline and projects exact H4.2 target net', () => {
		const result = plan(input({ intents: [intent()] }));
		expect(result.allocations[0]).toMatchObject({
			state: 'holding', requestedQuantity: 5, allocatedQuantity: 5, shortfallQuantity: 0,
			currentUnitGrossCopper: 100, targetUnitGrossCopper: 200, remainingMs: 3_600_000,
			projectedTargetNet: { route: 'instant_sell', grossCopper: 1_000, totalFeesCopper: 150, netCopper: 850 },
		});
		expect(result.items[0]).toEqual({ itemId: 1, inputFreeQuantity: 10, heldQuantity: 5, remainingFreeQuantity: 5 });
	});

	it('releases at target and exactly at the deadline', () => {
		const reached = input({ intents: [intent()] });
		reached.market.quotes[0]!.bidUnitCopper = 200;
		expect(plan(reached).allocations[0]).toMatchObject({ state: 'target_reached', allocatedQuantity: 0, shortfallQuantity: 0 });
		const expired = input({ intents: [intent({ deadlineAt: AS_OF })] });
		expect(plan(expired).allocations[0]).toMatchObject({ state: 'expired', allocatedQuantity: 0, remainingMs: 0 });
	});

	it('protects price-unavailable units until the deadline for both routes', () => {
		for (const route of ['instant_sell', 'listing'] as const) {
			const evidence = input({ intents: [intent({ target: { route, unitGrossCopper: 200 } })] });
			const quote = evidence.market.quotes[0]!;
			if (route === 'instant_sell') quote.bidUnitCopper = null;
			else quote.askUnitCopper = null;
			expect(plan(evidence).allocations[0]).toMatchObject({
				state: 'price_unavailable', allocatedQuantity: 5, currentUnitGrossCopper: null,
			});
		}
	});

	it('releases cancelled intents regardless of price', () => {
		const evidence = input({ intents: [intent({ status: 'cancelled' })] });
		evidence.market.quotes[0]!.bidUnitCopper = null;
		expect(plan(evidence).allocations[0])
			.toMatchObject({ state: 'cancelled', allocatedQuantity: 0, shortfallQuantity: 0, currentUnitGrossCopper: null });
		const expired = input({ intents: [intent({ deadlineAt: AS_OF })] });
		expired.market.quotes[0]!.bidUnitCopper = null;
		expect(plan(expired).allocations[0])
			.toMatchObject({ state: 'expired', allocatedQuantity: 0, currentUnitGrossCopper: null });
	});

	it('allocates an exclusive pool by deadline then intent id and reports shortfall', () => {
		const intents = [
			intent({ intentId: 'later', quantity: 6, deadlineAt: '2026-08-13T12:00:00.000Z' }),
			intent({ intentId: 'b', quantity: 7 }),
			intent({ intentId: 'a', quantity: 7 }),
		];
		const result = plan(input({ freeQuantity: 10, intents }));
		expect(result.allocations.map((entry) => [entry.intentId, entry.allocatedQuantity, entry.shortfallQuantity]))
			.toEqual([['a', 7, 0], ['b', 3, 4], ['later', 0, 6]]);
		expect(result.items[0]).toMatchObject({ heldQuantity: 10, remainingFreeQuantity: 0 });
	});

	it('keeps expired allocations ordered by their original deadlines even when remaining time is zero', () => {
		const result = plan(input({ intents: [
			intent({ intentId: 'a', deadlineAt: '2026-08-13T09:30:00.000Z' }),
			intent({ intentId: 'z', deadlineAt: '2026-08-13T09:00:00.000Z', createdAt: '2026-08-13T08:00:00.000Z' }),
		] }));
		expect(result.allocations.map((entry) => [entry.intentId, entry.deadlineAt, entry.remainingMs]))
			.toEqual([
				['z', '2026-08-13T09:00:00.000Z', 0],
				['a', '2026-08-13T09:30:00.000Z', 0],
			]);
	});

	it('keeps items separate and missing pools become a visible full shortfall', () => {
		const evidence = input({ intents: [intent({ itemId: 2, quantity: 3 })] });
		const result = plan(evidence);
		expect(result.items).toEqual([
			{ itemId: 1, inputFreeQuantity: 10, heldQuantity: 0, remainingFreeQuantity: 10 },
			{ itemId: 2, inputFreeQuantity: 0, heldQuantity: 0, remainingFreeQuantity: 0 },
		]);
		expect(result.allocations[0]).toMatchObject({ allocatedQuantity: 0, shortfallQuantity: 3 });
	});

	it('uses listing ask independently from the immediate bid', () => {
		const evidence = input({ intents: [intent({ target: { route: 'listing', unitGrossCopper: 200 } })] });
		evidence.market.quotes[0]!.bidUnitCopper = 300;
		evidence.market.quotes[0]!.askUnitCopper = 150;
		expect(plan(evidence).allocations[0]).toMatchObject({ state: 'holding', currentUnitGrossCopper: 150 });
	});

	it('rejects non-user origins, blank notes, identity mismatch and duplicate intent ids', () => {
		expect(isHoldIntent({ ...intent(), origin: 'system' })).toBe(false);
		expect(isHoldIntent({ ...intent(), reason: { category: 'personal', note: ' ' } })).toBe(false);
		expect(evaluateHoldIntents(input({ intents: [intent({ accountId: 'other' })] })))
			.toEqual({ status: 'invalid', reason: 'identity_mismatch' });
		expect(evaluateHoldIntents(input({ intents: [intent(), intent()] }))).toMatchObject({ status: 'invalid' });
	});

	it('rejects malformed maps, quotes, timestamps, extra keys and fee overflow', () => {
		for (const corrupt of [
			{ ...input(), freeQuantityByItem: { '01': 2 } },
			{ ...input(), asOf: 'today' },
			input({ intents: [intent({ createdAt: '2026-08-13T10:00:00.001Z' })] }),
			{ ...input(), extra: true },
			{ ...input(), market: { ...input().market, quotes: [input().market.quotes[0], input().market.quotes[0]] } },
		]) expect(evaluateHoldIntents(corrupt)).toMatchObject({ status: 'invalid' });
		const overflow = input({ intents: [intent({ quantity: Number.MAX_SAFE_INTEGER,
			target: { route: 'instant_sell', unitGrossCopper: Number.MAX_SAFE_INTEGER } })] });
		expect(evaluateHoldIntents(overflow)).toMatchObject({ status: 'invalid' });
	});

	it('has a strict standalone plan validator that rejects totals, order and projected fees', () => {
		const value = plan(input({ intents: [intent({ intentId: 'a' }), intent({ intentId: 'b' })] }));
		expect(isHoldPlan(value)).toBe(true);
		expect(isHoldPlan({ ...value, items: [{ ...value.items[0]!, heldQuantity: 9 }] })).toBe(false);
		expect(isHoldPlan({ ...value, allocations: [...value.allocations].reverse() })).toBe(false);
		expect(isHoldPlan({ ...value, items: [] })).toBe(false);
		const fees = structuredClone(value);
		fees.allocations[0]!.projectedTargetNet.netCopper += 1;
		expect(isHoldPlan(fees)).toBe(false);
		expect(isHoldPlan({ ...value, items: [{ ...value.items[0]!, heldQuantity: Number.MAX_SAFE_INTEGER }] }))
			.toBe(false);
	});

	it('is invariant to input order and never mutates evidence', () => {
		const evidence = input({ intents: [intent({ intentId: 'b' }), intent({ intentId: 'a' })] });
		const before = structuredClone(evidence);
		const forward = evaluateHoldIntents(evidence);
		const reverse = structuredClone(evidence);
		reverse.intents.reverse();
		expect(evaluateHoldIntents(reverse)).toEqual(forward);
		expect(evidence).toEqual(before);
	});
});

function input(options: { freeQuantity?: number; intents?: HoldIntentV1[] } = {}): HoldIntentInput {
	return {
		version: 1,
		asOf: AS_OF,
		accountId: 'account-1',
		snapshotId: 'snapshot-1',
		sessionId: 'session-1',
		freeQuantityByItem: { '1': options.freeQuantity ?? 10 },
		intents: options.intents ?? [],
		market: {
			version: 1, batchId: 'batch-1', capturedAt: AS_OF, source: 'gw2-commerce-prices',
			quotes: [{ itemId: 1, whitelisted: true, bidUnitCopper: 100, askUnitCopper: 120 }],
		},
	};
}

function intent(overrides: Partial<HoldIntentV1> = {}): HoldIntentV1 {
	return {
		version: 1,
		intentId: 'intent-1',
		accountId: 'account-1',
		itemId: 1,
		quantity: 5,
		target: { route: 'instant_sell', unitGrossCopper: 200 },
		reason: { category: 'market_target', note: 'Wait for the rebound.' },
		createdAt: '2026-08-13T09:00:00.000Z',
		deadlineAt: '2026-08-13T11:00:00.000Z',
		status: 'active',
		origin: 'user',
		...overrides,
	};
}

function plan(value: HoldIntentInput) {
	const result = evaluateHoldIntents(value);
	if (result.status !== 'ok') throw new Error(result.reason);
	return result.plan;
}
