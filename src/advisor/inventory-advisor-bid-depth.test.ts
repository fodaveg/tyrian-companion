import { describe, expect, it } from 'vitest';

import { createInventoryRecommendationEnvelope } from '../economy/inventory-recommendation-envelope';
import type { ReservationGoal } from '../economy/reservation-model';
import { largeMarketFixture } from '../test/json-round-trip-corpus';
import { classifyInventoryAdvisor, classifyInventoryAdvisorDiagnosed } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1 } from './inventory-advisor-classifier-model';
import { sha256CanonicalValue } from './inventory-advisor-contract';
import { applyInventoryDiscardAllowlist } from './inventory-advisor-discard';
import type { InventoryAdvisorResultV1, InventoryPriceSideV1 } from './inventory-advisor-model';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';
import { isInventoryAdvisorResult, isInventoryAdvisorResultForInput } from './inventory-advisor-result';

/**
 * Audit 4d4445e4: one object holding more units than the bid buys, with the surplus still inside
 * that bid (bid < units <= 2 x bid), turned the analysis of the WHOLE account `invalid`.
 *
 * The classifier was right: on the prices route it sells what the bid absorbs and routes the rest
 * as if no bid were left (`sell:10` + `list:5` for 15 units against a bid of 10). The result
 * contract was the one that could not reproduce it: it walked the decisions in their public order,
 * where `list` sorts before `sell`, so it met the surplus while the bid still looked untouched and
 * demanded `sell` for it. Above 2 x bid the surplus no longer fitted in the untouched bid, which is
 * the only reason 21 and 25 units went through.
 *
 * The contract now reproduces the cuts the classifier makes of each position (the part the bid
 * absorbs with the instant sale open, the rest without it), so the order of the public decisions
 * no longer matters. A decision that is not one of those cuts answers to the bid the whole line
 * leaves unsold, and is refused when it was routed without a bid the route would have sold: that
 * is stricter than the running count, which let a whole stack be listed, or less be sold than the
 * bid takes.
 */

type Decision = readonly [action: string, quantity: number, positionRef: string];

const BID: InventoryPriceSideV1 = { unitCopper: 20, quantity: 10 };
const ASK: InventoryPriceSideV1 = { unitCopper: 21, quantity: 1 };
const AT = '2026-08-14T12:00:00.000Z';

describe('inventory advisor: a stack larger than the bid', () => {
	it.each<[number, Decision[]]>([
		[10, [['sell', 10, '#/positions/10/0']]],
		[11, [['list', 1, '#/positions/10/0'], ['sell', 10, '#/positions/10/0']]],
		[15, [['list', 5, '#/positions/10/0'], ['sell', 10, '#/positions/10/0']]],
		[20, [['list', 10, '#/positions/10/0'], ['sell', 10, '#/positions/10/0']]],
		[21, [['list', 11, '#/positions/10/0'], ['sell', 10, '#/positions/10/0']]],
		[25, [['list', 15, '#/positions/10/0'], ['sell', 10, '#/positions/10/0']]],
	])('%i units against a bid of 10 sell what the bid absorbs and list the rest', (owned, expected) => {
		expect(analysed(stacks([owned]))).toEqual({ status: 'ready', cause: null, decisions: expected });
	});

	it('routes the whole stack without the instant sale when there is no bid', () => {
		expect(analysed(stacks([15], { bid: null }))).toEqual({
			status: 'ready', cause: null, decisions: [['list', 15, '#/positions/10/0']],
		});
	});

	it('refuses a bid of zero units at the input, before any routing', () => {
		expect(analysed(stacks([15], { bid: { unitCopper: 20, quantity: 0 } }))).toEqual({
			status: 'invalid', cause: 'classifier_input_shape', decisions: [],
		});
	});

	it('sells the whole stack when the bid is larger than it', () => {
		expect(analysed(stacks([7]))).toEqual({
			status: 'ready', cause: null, decisions: [['sell', 7, '#/positions/10/0']],
		});
	});

	it('cuts only the units a reservation leaves free', () => {
		const value = stacks([18]);
		value.input.goals = [reserve(3)];
		expect(analysed(value)).toEqual({ status: 'ready', cause: null, decisions: [
			['keep', 3, '#/positions/10/0'], ['list', 5, '#/positions/10/0'], ['sell', 10, '#/positions/10/0'],
		] });
		expect(classifyInventoryAdvisor(value).report?.lines[0]).toMatchObject({
			reservedQuantity: 3, exceptionQuantity: 0, actionedQuantity: 15,
		});
	});

	it('cuts only the units a keep exception leaves free', () => {
		const value = stacks([20]);
		value.input.keepExceptions = [{ version: 1, exceptionId: 'exception-a', itemId: 10, status: 'active',
			basis: 'owned', quantity: { mode: 'minimum', value: 5 }, reason: 'build' }];
		expect(analysed(value)).toEqual({ status: 'ready', cause: null, decisions: [
			['keep', 5, '#/positions/10/0'], ['list', 5, '#/positions/10/0'], ['sell', 10, '#/positions/10/0'],
		] });
		// The exception takes the surplus away entirely: nothing is left to list.
		value.input.keepExceptions[0]!.quantity = { mode: 'minimum', value: 12 };
		expect(analysed(value)).toEqual({ status: 'ready', cause: null, decisions: [
			['keep', 12, '#/positions/10/0'], ['sell', 8, '#/positions/10/0'],
		] });
	});

	it('no longer drags a second, ordinary object of the same analysis to invalid', () => {
		const value = stacks([15], {}, 2);
		const result = classifyInventoryAdvisor(value);
		expect(result.status).toBe('ready');
		expect(result.report?.lines.map((line) => [line.itemId, line.decisions.map((decision) => [decision.action, decision.quantity])]))
			.toEqual([[10, [['list', 5], ['sell', 10]]], [11, [['sell', 1]]]]);
		expect(isInventoryAdvisorResultForInput(result, value.input, value.knowledgePack)).toBe(true);
	});

	it.each<[string, number[], Decision[]]>([
		['8 + 8', [8, 8], [['list', 6, '#/positions/10/1'], ['sell', 8, '#/positions/10/0'], ['sell', 2, '#/positions/10/1']]],
		['15 + 5', [15, 5], [['list', 5, '#/positions/10/0'], ['list', 5, '#/positions/10/1'], ['sell', 10, '#/positions/10/0']]],
		['4 + 15', [4, 15], [['list', 9, '#/positions/10/1'], ['sell', 4, '#/positions/10/0'], ['sell', 6, '#/positions/10/1']]],
	])('spends the bid once across several stacks of the object: %s', (_name, quantities, expected) => {
		expect(analysed(stacks(quantities))).toEqual({ status: 'ready', cause: null, decisions: expected });
	});

	it('keeps the cut when every part is better listed, including a surplus as large as the bid', () => {
		const ask = { unitCopper: 100, quantity: 1 };
		expect(analysed(stacks([15], { ask })).decisions)
			.toEqual([['list', 10, '#/positions/10/0'], ['list', 5, '#/positions/10/0']]);
		expect(analysed(stacks([20], { ask })).decisions)
			.toEqual([['list', 10, '#/positions/10/0'], ['list', 10, '#/positions/10/0']]);
		expect(analysed(stacks([20], { ask })).status).toBe('ready');
	});

	it('sends the surplus to the vendor or keeps it when it cannot be listed', () => {
		expect(analysed(stacks([15], { ask: null }))).toEqual({ status: 'ready', cause: null, decisions: [
			['sell', 10, '#/positions/10/0'], ['vendor', 5, '#/positions/10/0'],
		] });
		expect(analysed(stacks([15], { ask: null, vendorValue: 0 }))).toEqual({ status: 'ready', cause: null, decisions: [
			['keep', 5, '#/positions/10/0'], ['sell', 10, '#/positions/10/0'],
		] });
	});

	it.each(['unavailable', 'invalid', 'missing'] as const)(
		'makes the same cut on the prices route when the requested depth of the object is %s',
		(coverage) => {
			const value = stacks([15]);
			value.marketDepth = { version: 1, capturedAt: AT, source: 'gw2-commerce-listings', requestedItemIds: [10],
				status: 'unavailable', items: [{ itemId: 10, coverage, buys: [], sells: [] }] };
			expect(analysed(value)).toEqual({ status: 'limited', cause: null, decisions: [
				['list', 5, '#/positions/10/0'], ['sell', 10, '#/positions/10/0'],
			] });
		});

	it('does not cut the stack when the real depth is complete: one decision for all of it', () => {
		const value = stacks([15]);
		value.marketDepth = { version: 1, capturedAt: AT, source: 'gw2-commerce-listings', requestedItemIds: [10],
			status: 'complete', items: [{ itemId: 10, coverage: 'complete',
				buys: [{ unitCopper: 20, quantity: 10 }], sells: [{ unitCopper: 21, quantity: 1 }] }] };
		expect(analysed(value)).toEqual({ status: 'ready', cause: null, decisions: [['list', 15, '#/positions/10/0']] });
	});

	it.each<[string, number[], Decision[]]>([
		['15', [15], [['list', 5, '#/positions/10/0'], ['review', 10, '#/positions/10/0']]],
		['8 + 8', [8, 8], [['list', 6, '#/positions/10/1'], ['review', 8, '#/positions/10/0'], ['review', 2, '#/positions/10/1']]],
	])('still lists the surplus when an active buy order withholds the instant sale: %s', (_name, quantities, expected) => {
		const value = stacks(quantities);
		const evidence = { status: 'complete' as const, capturedAt: AT, reason: null };
		value.activeOrders = { version: 1, accountId: 'account-1', capturedAt: AT, status: 'complete',
			endpointCoverage: { buy: evidence, sell: evidence }, orders: [{ side: 'buy', itemId: 10, quantity: 1 }] };
		expect(analysed(value)).toEqual({ status: 'ready', cause: null, decisions: expected });
	});
});

describe('inventory advisor result contract: a manipulated market split is refused', () => {
	it('accepts the classifier result and an untouched rebuild of it (the forge itself changes nothing)', () => {
		for (const owned of [10, 21, 25]) {
			const value = stacks([owned]);
			const result = classifyInventoryAdvisor(value);
			expect(isInventoryAdvisorResultForInput(result, value.input, value.knowledgePack)).toBe(true);
			// In the order the classifier decided them, which is the one their explanation refs number.
			const rebuilt = forged(result, [...result.report!.lines[0]!.decisions]
				.sort((left, right) => left.explanationRef.localeCompare(right.explanationRef))
				.map((decision) => [decision.action, decision.quantity]));
			expect(rebuilt).toEqual(result);
			expect(isInventoryAdvisorResultForInput(rebuilt, value.input, value.knowledgePack)).toBe(true);
		}
	});

	it.each<[string, number, Array<[string, number]>]>([
		['the whole stack sold to a bid of 10', 25, [['sell', 25]]],
		['one unit more than the bid sold', 25, [['list', 14], ['sell', 11]]],
		['one unit more than the bid sold, in two sales', 25, [['list', 14], ['sell', 10], ['sell', 1]]],
		['a list where the bid absorbs the whole stack', 10, [['list', 10]]],
		['a list for half of a stack the bid absorbs', 10, [['list', 5], ['sell', 5]]],
		['a vendor sale where the bid absorbs the stack', 10, [['vendor', 10]]],
		['the surplus sent to the vendor instead of listed', 25, [['sell', 10], ['vendor', 15]]],
		['less sold than the bid absorbs', 25, [['list', 16], ['sell', 9]]],
		['nothing sold although the bid absorbs ten', 25, [['list', 25]]],
		['a piece of the surplus sold beyond the bid', 25, [['list', 10], ['sell', 10], ['sell', 5]]],
	])('refuses %s', (_name, owned, decisions) => {
		const value = stacks([owned]);
		const manipulated = forged(classifyInventoryAdvisor(value), decisions);
		// Coherent on its own (totals, explanations, report hash, envelope): only the input refutes it.
		expect(isInventoryAdvisorResult(manipulated)).toBe(true);
		expect(isInventoryAdvisorResultForInput(manipulated, value.input, value.knowledgePack)).toBe(false);
	});

	/**
	 * A limit, pinned so that it is a known one: the contract does not demand that the decisions BE
	 * the classifier's cuts, only that each one is the route of its units. The same surplus listed in
	 * two pieces is the same recommendation (same action, same units, same ask) and passes, as a
	 * decision that merges several positions always has (`inventory-advisor-presentation.test.ts`,
	 * "preserves multi-position allocations").
	 */
	it('does not tell a surplus listed in two pieces from the same surplus listed whole', () => {
		const value = stacks([25]);
		const pieces = forged(classifyInventoryAdvisor(value), [['list', 10], ['list', 5], ['sell', 10]]);
		expect(isInventoryAdvisorResultForInput(pieces, value.input, value.knowledgePack)).toBe(true);
	});

	it('refuses a sale where listing was due, and a sale of the surplus', () => {
		const dearAsk = stacks([15], { ask: { unitCopper: 100, quantity: 1 } });
		const listed = classifyInventoryAdvisor(dearAsk);
		expect(listed.report?.lines[0]?.decisions.map((decision) => [decision.action, decision.quantity]))
			.toEqual([['list', 10], ['list', 5]]);
		const sold = forged(listed, [['list', 5], ['sell', 10]]);
		expect(isInventoryAdvisorResult(sold)).toBe(true);
		expect(isInventoryAdvisorResultForInput(sold, dearAsk.input, dearAsk.knowledgePack)).toBe(false);
	});

	it('refuses quantities that do not add up to the stack', () => {
		const value = stacks([25]);
		const result = classifyInventoryAdvisor(value);
		for (const decisions of [[['list', 14], ['sell', 10]], [['list', 16], ['sell', 10]]] as Array<Array<[string, number]>>) {
			const manipulated = forged(result, decisions);
			expect(isInventoryAdvisorResultForInput(manipulated, value.input, value.knowledgePack)).toBe(false);
		}
	});

	it('refuses the right split attributed to the wrong stack', () => {
		const value = stacks([8, 8]);
		const result = classifyInventoryAdvisor(stacks([4, 15]));
		expect(result.status).toBe('ready');
		expect(isInventoryAdvisorResultForInput(result, value.input, value.knowledgePack)).toBe(false);
	});
});

describe('inventory advisor: a large report without the case keeps its digests', () => {
	it('keeps the producer, discard and presentation digests of 1 371 one-unit objects', () => {
		const engineInput = largeMarketFixture(1_371);
		const producerResult = classifyInventoryAdvisor(engineInput);
		const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
		const presentation = buildInventoryAdvisorPresentation({
			input: engineInput.input, result, discardContext: { engineInput, producerResult },
		});
		expect([producerResult.status, result.status, presentation.status]).toEqual(['ready', 'ready', 'ready']);
		expect({
			producer: sha256CanonicalValue(producerResult),
			discard: sha256CanonicalValue(result),
			presentation: sha256CanonicalValue(JSON.parse(JSON.stringify(presentation))),
		}).toEqual({
			producer: '8a3b012fadd046340599921e9041afd1957950ce4223ac12348561ce5cb81e74',
			discard: 'd34704f2e0265b98cb43dceacb622ee60c6407ed3f0e056f6f73502c946b5b29',
			presentation: '64a1f60b8ba5c4f42bf58882fa4fb2ea6ec10dcd639b081663429b80a5d29223',
		});
	}, 60_000);
});

/** Item 10 held in one loose bank stack per quantity; `count` > 1 adds ordinary one-unit objects after it. */
function stacks(
	quantities: number[],
	market: { bid?: InventoryPriceSideV1 | null; ask?: InventoryPriceSideV1 | null; vendorValue?: number } = {},
	count = 1,
): InventoryAdvisorEngineInputV1 {
	const value = largeMarketFixture(count);
	const others = value.input.snapshot.holdings.slice(1);
	value.input.snapshot.holdings = [
		...quantities.map((quantity, slot) => ({
			kind: 'item' as const, itemId: 10, quantity, state: 'loose' as const,
			location: { source: 'bank' as const, slot: 100 + slot }, metadata: {},
		})),
		...others,
	];
	const total = quantities.reduce((sum, quantity) => sum + quantity, 0);
	value.input.snapshot.ownedByItem['10'] = total;
	value.input.snapshot.availableByItem['10'] = total;
	value.input.prices.items[0] = {
		itemId: 10, whitelisted: true,
		bid: market.bid === undefined ? BID : market.bid, ask: market.ask === undefined ? ASK : market.ask,
	};
	value.input.catalog.items['10']!.vendorValue = market.vendorValue ?? 1;
	return value;
}

function analysed(value: InventoryAdvisorEngineInputV1): { status: string; cause: string | null; decisions: Decision[] } {
	const { result, cause } = classifyInventoryAdvisorDiagnosed(value);
	const decisions = (result.report?.lines.find((line) => line.itemId === 10)?.decisions ?? [])
		.map((decision): Decision => [decision.action, decision.quantity, decision.allocations.map((allocation) => allocation.positionRef).join('+')]);
	if (result.status !== 'invalid') {
		// The public verifier agrees with the classifier's own check, and so does every later stage.
		expect(isInventoryAdvisorResultForInput(result, value.input, value.knowledgePack, value.containerEconomy,
			value.personalValuation, value.activeOrders, value.materialStorageCapacity, value.marketDepth)).toBe(true);
		expect(applyInventoryDiscardAllowlist({ engineInput: value, producerResult: result }).status).toBe(result.status);
	}
	return { status: result.status, cause, decisions };
}

/**
 * The same result with the market decisions of its only stack replaced, and everything that hangs
 * from them rebuilt (totals, explanations, report digest, envelope), so it is refused for what it
 * recommends and not for a broken seal.
 */
function forged(result: InventoryAdvisorResultV1, decisions: Array<[string, number]>): InventoryAdvisorResultV1 {
	if (result.status === 'invalid') throw new Error('Expected a result to manipulate.');
	const report = structuredClone(result.report);
	const line = report.lines[0]!;
	const template = line.decisions[0]!;
	const explanation = report.explanations[0]!;
	const built = decisions.map(([action, quantity], index) => ({
		...template, action: action as typeof template.action, quantity,
		allocations: [{ positionRef: line.positions[0]!.ref, quantity }],
		explanationRef: `#/explanations/${String(line.itemId)}/${String(index)}`,
	})).sort((left, right) => left.action.localeCompare(right.action) || left.explanationRef.localeCompare(right.explanationRef));
	line.decisions = built;
	line.actionedQuantity = built.reduce((sum, decision) => sum + decision.quantity, 0);
	report.explanations = built.map((decision) => ({
		...explanation, ref: decision.explanationRef, action: decision.action,
	})).sort((left, right) => left.ref.localeCompare(right.ref));
	const envelope = createInventoryRecommendationEnvelope(report);
	// A total that does not add up cannot be sealed; it travels with the envelope of the honest result.
	return { status: result.status, report, envelope: envelope ?? result.envelope };
}

function reserve(targetQuantity: number): ReservationGoal {
	return {
		schemaVersion: 1, goalId: 'goal-a', title: 'Objetivo A', status: 'active', priority: 100, reason: 'purchase',
		requirements: [{ key: 'item:10', namespace: 'item', id: 10, targetQuantity, creditedQuantity: 0,
			basis: 'available', intendedUse: 'consume' }],
	};
}
