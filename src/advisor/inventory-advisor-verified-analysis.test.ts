import { describe, expect, it, vi } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import type { ReservationGoal } from '../economy/reservation-model';
import { InventoryAdvisorPresentationController } from '../ui/inventory-advisor-controller';
import { classifyInventoryAdvisor, sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from './inventory-advisor-contract';
import {
	applyInventoryDiscardAllowlist,
	applyInventoryDiscardAllowlistVerified,
	classifyInventoryAdvisorVerified,
	inventoryAdvisorVerifiedAnalysisContext,
	isInventoryDiscardAllowlistResultForInput,
	type InventoryAdvisorVerifiedAnalysis,
} from './inventory-advisor-discard';
import { buildInventoryAdvisorPresentation, type InventoryAdvisorContextualPresentationSource } from './inventory-advisor-presentation';

const counted = vi.hoisted(() => ({ classifications: 0 }));

// Pass-through spies on both exported classifier entries: each classification counts once, whoever asks.
vi.mock('./inventory-advisor-classifier', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./inventory-advisor-classifier')>();
	return {
		...actual,
		classifyInventoryAdvisor: (value: unknown) => {
			counted.classifications += 1;
			return actual.classifyInventoryAdvisor(value);
		},
		classifyInventoryAdvisorDiagnosed: (...args: Parameters<typeof actual.classifyInventoryAdvisorDiagnosed>) => {
			counted.classifications += 1;
			return actual.classifyInventoryAdvisorDiagnosed(...args);
		},
	};
});

/**
 * The verified internal analysis (audit 1.1/1.2): the advisor's own flow classifies a private frozen
 * copy of the engine input once, and the stages after it take the object that flow built instead of
 * reproducing it. What makes an object that analysis is its identity in a registry private to the
 * discard module. These tests fix the three things that has to mean: the internal route answers
 * byte for byte what the public route answers, nothing but the recorded object is ever taken on
 * trust, and what was recorded cannot be changed from outside, nor is anything of the caller frozen.
 */
describe('inventory advisor verified analysis: the internal route answers what the public route answers', () => {
	it.each([
		['reservations, keep exceptions, five positions and a surplus over the bid', multiLocationFixture],
		['a stack larger than its bid', () => accountFixture([{ itemId: 10, quantity: 15, location: { source: 'bank', slot: 0 } }], 10)],
		['two stacks over one bid', () => accountFixture([
			{ itemId: 10, quantity: 8, location: { source: 'bank', slot: 0 } },
			{ itemId: 10, quantity: 8, location: { source: 'bank', slot: 1 } },
		], 10)],
		['a curated discard candidate with its proof', discardFixture],
		['a limited analysis under an unavailable market depth', () => {
			const value = multiLocationFixture();
			const itemIds = value.input.prices.requestedItemIds;
			return { ...value, marketDepth: {
				version: 1 as const, capturedAt: value.input.asOf, source: 'gw2-commerce-listings' as const,
				requestedItemIds: [...itemIds], status: 'unavailable' as const,
				items: itemIds.map((itemId) => ({ itemId, coverage: 'missing' as const, buys: [], sells: [] })),
			} };
		}],
	] as const)('gives the same three digests for %s', (_name, fixture) => {
		const engineInput: InventoryAdvisorEngineInputV1 = fixture();
		const publicRoute = analysePublic(engineInput);
		const internal = analyseInternal(engineInput);
		expect(publicRoute.presentation.status).not.toBe('invalid');
		expect(inventoryAdvisorVerifiedAnalysisContext(internal.source)).toBeDefined();
		expect(digests(internal)).toEqual(digests(publicRoute));
		expect(internal.source.discardContext.producerResult).toEqual(publicRoute.producerResult);
		expect(internal.source.result).toEqual(publicRoute.result);
		expect(internal.presentation).toEqual(publicRoute.presentation);
		// And with options: the rows a filter and a sort leave are the same rows.
		const options = { sort: 'name_asc' as const, filters: { groups: ['market' as const, 'keep' as const] } };
		expect(buildInventoryAdvisorPresentation(internal.source, options))
			.toEqual(buildInventoryAdvisorPresentation(publicSource(engineInput, publicRoute), options));
	});

	it('gives the reference digests of the 1 371-object report by both routes', () => {
		const engineInput = accountFixture(Array.from({ length: 1_371 }, (_, index) => ({
			itemId: 10 + index, quantity: 1, location: { source: 'bank' as const, slot: index },
		})), 1);
		const reference = {
			producer: '8a3b012fadd046340599921e9041afd1957950ce4223ac12348561ce5cb81e74',
			discard: 'd34704f2e0265b98cb43dceacb622ee60c6407ed3f0e056f6f73502c946b5b29',
			presentation: '64a1f60b8ba5c4f42bf58882fa4fb2ea6ec10dcd639b081663429b80a5d29223',
		};
		expect(digests(analysePublic(engineInput))).toEqual(reference);
		const before = counted.classifications;
		expect(digests(analyseInternal(engineInput))).toEqual(reference);
		expect(counted.classifications - before).toBe(1);
	}, 120_000);

	it('answers invalid, and records nothing, for an engine input the classifier refuses', () => {
		const engineInput = multiLocationFixture();
		(engineInput.input as { version: number }).version = 2;
		const publicRoute = analysePublic(engineInput);
		const internal = analyseInternal(engineInput);
		expect(publicRoute.producerResult.status).toBe('invalid');
		expect(internal.source.discardContext.producerResult).toEqual(publicRoute.producerResult);
		expect(internal.source.result).toEqual(publicRoute.result);
		expect(internal.presentation).toEqual(publicRoute.presentation);
		expect(inventoryAdvisorVerifiedAnalysisContext(internal.source)).toBeUndefined();
	});

	it.each([
		['a class instance', (value: InventoryAdvisorEngineInputV1) => {
			class Snapshot { constructor(source: object) { Object.assign(this, source); } }
			value.input.snapshot = new Snapshot(value.input.snapshot) as never;
		}],
		['a getter', (value: InventoryAdvisorEngineInputV1) => {
			const goals = value.input.goals;
			Object.defineProperty(value.input, 'goals', { enumerable: true, configurable: true, get: () => goals });
		}],
		['a symbol key', (value: InventoryAdvisorEngineInputV1) => {
			(value.input.policy as unknown as Record<symbol, unknown>)[Symbol('extra')] = 1;
		}],
	] as const)('does not copy an engine input that holds %s: it gets the public answer and is not recorded', (_name, change) => {
		const engineInput = multiLocationFixture();
		change(engineInput);
		const publicRoute = analysePublic(engineInput);
		const classified = classifyInventoryAdvisorVerified(engineInput);
		// Not copied: the pair carries the caller's own object, so it cannot have been recorded as a frozen copy.
		expect(classified.engineInput).toBe(engineInput);
		const source = applyInventoryDiscardAllowlistVerified(classified);
		expect(classified.producerResult).toEqual(publicRoute.producerResult);
		expect(source.result).toEqual(publicRoute.result);
		expect(buildInventoryAdvisorPresentation(source)).toEqual(publicRoute.presentation);
		expect(inventoryAdvisorVerifiedAnalysisContext(source)).toBeUndefined();
	});
});

describe('inventory advisor verified analysis: only the recorded object is taken on trust', () => {
	it('presents the recorded source without classifying, and classifies again for anything that only looks like it', () => {
		const { source } = analyseInternal(multiLocationFixture());
		const presentation = buildInventoryAdvisorPresentation(source);
		const lookAlikes: Array<[string, InventoryAdvisorContextualPresentationSource]> = [
			['a structured clone', structuredClone(source)],
			['a shallow copy', { ...source }],
			['a clone frozen in depth', freezeDeep(structuredClone(source))],
			['an object that inherits from it', Object.create(source) as InventoryAdvisorContextualPresentationSource],
			// Same recorded parts, another outer object.
			['its own parts in a new object', { input: source.input, result: source.result, discardContext: source.discardContext }],
		];
		let before = counted.classifications;
		expect(buildInventoryAdvisorPresentation(source)).toEqual(presentation);
		expect(buildInventoryAdvisorPresentation(source, { sort: 'action_asc' }).status).toBe('ready');
		expect(counted.classifications - before).toBe(0);
		for (const [name, lookAlike] of lookAlikes) {
			expect(inventoryAdvisorVerifiedAnalysisContext(lookAlike), name).toBeUndefined();
			before = counted.classifications;
			const presented = buildInventoryAdvisorPresentation(lookAlike);
			// An honest copy is still a valid source: it is reproduced, as any caller's data is. One that
			// is not plain own data (the inheriting object has no own keys) is refused outright.
			if (name === 'an object that inherits from it') {
				expect(presented.status, name).toBe('invalid');
			} else {
				expect(presented, name).toEqual(presentation);
				expect(counted.classifications - before, name).toBe(1);
			}
		}
	});

	it('refuses a look-alike of a recorded source that carries a manipulated result', () => {
		const engineInput = multiLocationFixture();
		const { source } = analyseInternal(engineInput);
		const withoutGoals = multiLocationFixture();
		withoutGoals.input.goals = [];
		const forged = analyseInternal(withoutGoals).source;
		// Every part comes from a recorded analysis; the combination was never produced.
		for (const lookAlike of [
			{ input: source.input, result: forged.result, discardContext: source.discardContext },
			{ input: source.input, result: forged.result,
				discardContext: { engineInput: source.discardContext.engineInput, producerResult: forged.discardContext.producerResult } },
			{ input: source.input, result: source.result,
				discardContext: { engineInput: source.discardContext.engineInput, producerResult: forged.discardContext.producerResult } },
			{ input: source.input, result: forged.result, discardContext: forged.discardContext },
			{ ...structuredClone(source), result: structuredClone(forged.result) },
		]) {
			expect(inventoryAdvisorVerifiedAnalysisContext(lookAlike)).toBeUndefined();
			expect(buildInventoryAdvisorPresentation(lookAlike).status).toBe('invalid');
		}
	});

	it('does not accept the verified analysis of another input for this one', () => {
		const engineInput = multiLocationFixture();
		for (const change of [
			(value: InventoryAdvisorEngineInputV1) => { value.input.goals = [reserve('goal-b', 'Objetivo B', 2)]; },
			(value: InventoryAdvisorEngineInputV1) => {
				value.input.snapshot.accountId = 'account-2';
				value.input.prices.accountId = 'account-2';
				value.input.accountSignals.accountId = 'account-2';
			},
			(value: InventoryAdvisorEngineInputV1) => {
				value.input.snapshot.snapshotId = 'snapshot-2';
				value.input.catalog.snapshotId = 'snapshot-2';
				value.input.prices.snapshotId = 'snapshot-2';
			},
		]) {
			const otherInput = multiLocationFixture();
			change(otherInput);
			const other = analyseInternal(otherInput);
			expect(inventoryAdvisorVerifiedAnalysisContext(other.source)).toBeDefined();
			// On its own it presents its own input, exactly as the public route does for that input...
			expect(other.presentation).toEqual(analysePublic(otherInput).presentation);
			// ...and nothing built from it stands for this input.
			const discardContext = { engineInput, producerResult: other.source.discardContext.producerResult };
			expect(applyInventoryDiscardAllowlistVerified(discardContext).result.status).toBe('invalid');
			expect(isInventoryDiscardAllowlistResultForInput(other.source.result, discardContext)).toBe(false);
			for (const lookAlike of [
				{ input: engineInput.input, result: other.source.result, discardContext },
				{ input: engineInput.input, result: other.source.result, discardContext: other.source.discardContext },
			]) {
				expect(inventoryAdvisorVerifiedAnalysisContext(lookAlike)).toBeUndefined();
				expect(buildInventoryAdvisorPresentation(lookAlike).status).toBe('invalid');
			}
		}
	});

	it('gives the second stage of the flow nothing to trust but a pair the first stage built', () => {
		const engineInput = multiLocationFixture();
		const classified = classifyInventoryAdvisorVerified(engineInput);
		const withoutGoals = multiLocationFixture();
		withoutGoals.input.goals = [];
		const forged = classifyInventoryAdvisorVerified(withoutGoals).producerResult;
		// A pair with a result the first stage did not produce for that engine input is reproduced and refused.
		for (const pair of [
			{ engineInput, producerResult: forged },
			{ engineInput: classified.engineInput, producerResult: forged },
			{ ...classified, producerResult: forged },
		]) {
			const source = applyInventoryDiscardAllowlistVerified(pair);
			expect(source.result.status).toBe('invalid');
			expect(inventoryAdvisorVerifiedAnalysisContext(source)).toBeUndefined();
		}
		// An equal copy of the recorded pair is honest data: it is reproduced, answers the same and is not recorded.
		const before = counted.classifications;
		const copy = applyInventoryDiscardAllowlistVerified(structuredClone(classified));
		expect(counted.classifications - before).toBe(1);
		expect(copy.result).toEqual(applyInventoryDiscardAllowlistVerified(classified).result);
		expect(inventoryAdvisorVerifiedAnalysisContext(copy)).toBeUndefined();
		// The public allowlist takes the recorded pair for what it is, and still reproduces a copy of it.
		const direct = counted.classifications;
		expect(applyInventoryDiscardAllowlist(classified)).toEqual(copy.result);
		expect(counted.classifications - direct).toBe(0);
	});
});

describe('inventory advisor verified analysis: what was recorded cannot be changed, and nothing of the caller is frozen', () => {
	it('is frozen in depth: the source, its input, both results and the plan of its context', () => {
		const { source } = analyseInternal(multiLocationFixture());
		const context = inventoryAdvisorVerifiedAnalysisContext(source)!;
		expect(firstUnfrozen(source)).toBeNull();
		expect(firstUnfrozen(context.reservation())).toBeNull();
		expect(Object.isFrozen(context)).toBe(true);
		expect(context.input).toBe(source.input);
		expect(source.discardContext.engineInput.input).toBe(source.input);
		const digest = sha256CanonicalValue(JSON.parse(JSON.stringify(buildInventoryAdvisorPresentation(source))));
		const line = source.result.report!.lines.find((entry) => entry.itemId === 10)!;
		const plan = context.reservation().plan;
		attempt(() => { (source as { result: unknown }).result = null; });
		attempt(() => { source.input.goals.length = 0; });
		attempt(() => { source.input.goals[0]!.requirements[0]!.targetQuantity = 0; });
		attempt(() => { source.input.snapshot.holdings[0]!.quantity = 500; });
		attempt(() => { line.decisions.find((decision) => decision.action === 'keep')!.action = 'sell'; });
		attempt(() => { line.reservedQuantity = 0; });
		attempt(() => { source.discardContext.producerResult.report!.lines.length = 0; });
		attempt(() => { if (plan.status === 'ok') plan.plan.assets.length = 0; });
		expect(line.reservedQuantity).toBe(6);
		expect(source.input.goals).toHaveLength(1);
		expect(sha256CanonicalValue(JSON.parse(JSON.stringify(buildInventoryAdvisorPresentation(source))))).toBe(digest);
	});

	it('reads its own copy of the input: adding a goal to the caller\'s input afterwards does not make a result that sells the reserved units acceptable', () => {
		// The account with no goal: nothing is reserved and every free unit goes to the market.
		const engineInput = multiLocationFixture();
		engineInput.input.goals = [];
		const { source } = analyseInternal(engineInput);
		const digest = sha256CanonicalValue(JSON.parse(JSON.stringify(buildInventoryAdvisorPresentation(source))));
		expect(source.input).not.toBe(engineInput.input);
		expect(source.result.report?.lines.find((line) => line.itemId === 10)?.reservedQuantity).toBe(0);

		// The caller now adds the goal that reserves 6 units, to the object it passed in.
		engineInput.input.goals = [reserve('goal-a', 'Objetivo A', 6)];

		// The recorded analysis did not move: it still describes, and says it describes, the input without the goal.
		expect(source.input.goals).toEqual([]);
		const before = counted.classifications;
		expect(sha256CanonicalValue(JSON.parse(JSON.stringify(buildInventoryAdvisorPresentation(source))))).toBe(digest);
		expect(counted.classifications - before).toBe(0);
		// And the result that sells the reserved units is not accepted for the input that now has the goal,
		// whichever way the recorded parts are put next to it.
		const honest = analysePublic(engineInput);
		expect(honest.result.report?.lines.find((line) => line.itemId === 10)?.reservedQuantity).toBe(6);
		for (const discardContext of [
			{ engineInput, producerResult: source.discardContext.producerResult },
			source.discardContext,
		]) {
			expect(buildInventoryAdvisorPresentation({ input: engineInput.input, result: source.result, discardContext }).status)
				.toBe('invalid');
		}
		expect(isInventoryDiscardAllowlistResultForInput(
			source.result, { engineInput, producerResult: source.discardContext.producerResult },
		)).toBe(false);
		expect(applyInventoryDiscardAllowlistVerified({ engineInput, producerResult: source.discardContext.producerResult })
			.result.status).toBe('invalid');
		// A new analysis of the changed input reserves them.
		expect(analyseInternal(engineInput).source.result).toEqual(honest.result);
	});

	it('changing the caller\'s input between the two stages does not reach the analysis either', () => {
		const engineInput = multiLocationFixture();
		const expected = analysePublic(multiLocationFixture());
		const classified = classifyInventoryAdvisorVerified(engineInput);
		engineInput.input.goals = [];
		engineInput.input.snapshot.holdings[0]!.quantity = 1;
		engineInput.knowledgePack.version = 99;
		const source = applyInventoryDiscardAllowlistVerified(classified);
		expect(source.result).toEqual(expected.result);
		expect(buildInventoryAdvisorPresentation(source)).toEqual(expected.presentation);
	});

	it('freezes nothing of what the caller passed in', () => {
		const engineInput = { ...discardFixture(), materialStorageCapacity: { quantity: 250, source: 'minimum_guaranteed' as const } };
		const { source, presentation } = analyseInternal(engineInput);
		expect(inventoryAdvisorVerifiedAnalysisContext(source)).toBeDefined();
		expect(presentation.status).toBe('ready');
		expect(firstFrozen(engineInput)).toBeNull();
		// Still the caller's to change.
		engineInput.input.goals = [reserve('goal-a', 'Objetivo A', 1)];
		engineInput.input.snapshot.holdings[0]!.quantity = 3;
		engineInput.knowledgePack.entries.length = 0;
		// What the presentation hands out is its own data, as before: not frozen, and not the recorded objects.
		expect(firstFrozen(presentation)).toBeNull();
		const row = presentation.groups[0]!.rows[0]!;
		row.allocations[0]!.location = { source: 'bank', slot: 99 };
		row.reasonCodes.length = 0;
		expect(source.input.snapshot.holdings[0]!.location).toEqual({ source: 'bank', slot: 0 });
	});
});

interface Analysed {
	producerResult: ReturnType<typeof classifyInventoryAdvisor>;
	result: ReturnType<typeof applyInventoryDiscardAllowlist>;
	presentation: ReturnType<typeof buildInventoryAdvisorPresentation>;
}

function analysePublic(engineInput: InventoryAdvisorEngineInputV1): Analysed {
	const producerResult = classifyInventoryAdvisor(engineInput);
	const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
	const presentation = buildInventoryAdvisorPresentation(publicSource(engineInput, { producerResult, result }));
	return { producerResult, result, presentation };
}

function publicSource(
	engineInput: InventoryAdvisorEngineInputV1,
	analysed: Pick<Analysed, 'producerResult' | 'result'>,
): InventoryAdvisorContextualPresentationSource {
	return { input: engineInput.input, result: analysed.result, discardContext: { engineInput, producerResult: analysed.producerResult } };
}

function analyseInternal(engineInput: InventoryAdvisorEngineInputV1): Analysed & { source: InventoryAdvisorVerifiedAnalysis } {
	const source = applyInventoryDiscardAllowlistVerified(classifyInventoryAdvisorVerified(engineInput));
	return {
		source, producerResult: source.discardContext.producerResult, result: source.result,
		presentation: buildInventoryAdvisorPresentation(source),
	};
}

function digests(analysed: Analysed): { producer: string; discard: string; presentation: string } {
	return {
		producer: sha256CanonicalValue(analysed.producerResult),
		discard: sha256CanonicalValue(analysed.result),
		presentation: sha256CanonicalValue(JSON.parse(JSON.stringify(analysed.presentation))),
	};
}

/** Runs an edit a frozen object refuses by throwing; what matters is the state afterwards. */
function attempt(edit: () => void): void {
	try { edit(); } catch { /* frozen: the edit did not happen */ }
}

function freezeDeep<T>(value: T): T {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
	return value;
}

/** The path of the first object inside `value` that is frozen, or null when none is. */
function firstFrozen(value: unknown, path = '$'): string | null {
	return firstWhere(value, path, true);
}

/** The path of the first object inside `value` that is NOT frozen, or null when all are. */
function firstUnfrozen(value: unknown, path = '$'): string | null {
	return firstWhere(value, path, false);
}

function firstWhere(value: unknown, path: string, frozen: boolean): string | null {
	if (value === null || typeof value !== 'object') return null;
	if (Object.isFrozen(value) === frozen) return path;
	for (const [key, child] of Object.entries(value)) {
		const found = firstWhere(child, `${path}.${key}`, frozen);
		if (found !== null) return found;
	}
	return null;
}

/** Item 10 in a character bag, the bank, material storage, the shared slots and the delivery box. */
function multiLocationFixture(): InventoryAdvisorEngineInputV1 {
	const value = accountFixture([
		{ itemId: 10, quantity: 5, location: { source: 'character', character: 'Hero', container: 'bag', bagIndex: 0, slot: 0 } },
		{ itemId: 11, quantity: 4, location: { source: 'bank', slot: 0 } },
		{ itemId: 10, quantity: 7, location: { source: 'bank', slot: 1 } },
		{ itemId: 12, quantity: 1, location: { source: 'bank', slot: 2 } },
		{ itemId: 10, quantity: 20, location: { source: 'materials', category: 7 } },
		{ itemId: 10, quantity: 3, location: { source: 'shared_inventory', slot: 0 } },
		{ itemId: 10, quantity: 2, state: 'pending_claim', location: { source: 'commerce_delivery', slot: 0 } },
	], 1);
	// A bid two deep: the free quantity splits into an instant sale and two listings.
	value.input.prices.items[0]!.bid = { unitCopper: 20, quantity: 2 };
	value.input.goals = [reserve('goal-a', 'Objetivo A', 6)];
	value.input.keepExceptions = [
		{ version: 1, exceptionId: 'exception-a', itemId: 10, status: 'active', basis: 'owned',
			quantity: { mode: 'minimum', value: 9 }, reason: 'build' },
		{ version: 1, exceptionId: 'exception-b', itemId: 11, status: 'active', basis: 'available',
			quantity: { mode: 'all' }, reason: 'gift' },
	];
	return value;
}

/** Two units nothing can be done with, a curated discard rule and the three explicit `not_applicable` claims. */
function discardFixture(): InventoryAdvisorEngineInputV1 {
	const value = accountFixture([{ itemId: 10, quantity: 2, location: { source: 'bank', slot: 0 } }], 1);
	Object.assign(value.input.catalog.items['10']!, { vendorValue: 0, flags: ['AccountBound', 'NoSell', 'NoSalvage'] });
	value.input.prices.items = [{ itemId: 10, whitelisted: false, bid: null, ask: null }];
	value.input.rulePack.rules = [{ ruleId: 'discard-10', itemId: 10, action: 'discard_candidate', status: 'approved',
		assertion: 'applicable', reason: 'curated_discard_review', sourceIds: ['rule-source'] }];
	value.input.rulePack.sha256 = sha256InventoryRulePack(value.input.rulePack);
	const claim = (assertionId: string) => ({ status: 'not_applicable' as const, assertionId, sourceIds: ['source'] });
	value.knowledgePack.entries = [{ itemId: 10, use: claim('use-none'), open: claim('open-none'), salvage: claim('salvage-none') }];
	value.knowledgePack.sha256 = sha256InventoryKnowledgePack(value.knowledgePack);
	return value;
}

function reserve(goalId: string, title: string, targetQuantity: number): ReservationGoal {
	return {
		schemaVersion: 1, goalId, title, status: 'active', priority: 100, reason: 'purchase',
		requirements: [{ key: 'item:10', namespace: 'item', id: 10, targetQuantity, creditedQuantity: 0,
			basis: 'available', intendedUse: 'consume' }],
	};
}

interface FixtureStack {
	itemId: number;
	quantity: number;
	state?: StorageSnapshot['holdings'][number]['state'];
	location: StorageSnapshot['holdings'][number]['location'];
}

/** A stable two-pass account holding exactly `stacks`, every item resolved and priced with a bid `bidQuantity` deep. */
function accountFixture(stacks: FixtureStack[], bidQuantity: number): InventoryAdvisorEngineInputV1 {
	const holdings: StorageSnapshot['holdings'] = stacks.map((stack) => ({
		kind: 'item', itemId: stack.itemId, quantity: stack.quantity, state: stack.state ?? 'loose',
		location: stack.location, metadata: {},
	}));
	const itemIds = [...new Set(stacks.map((stack) => stack.itemId))].sort((left, right) => left - right);
	const quantities = Object.fromEntries(itemIds.map((itemId) => [String(itemId), stacks
		.filter((stack) => stack.itemId === itemId).reduce((total, stack) => total + stack.quantity, 0)]));
	const roster = [...new Set(stacks.flatMap((stack) => stack.location.source === 'character'
		? [stack.location.character] : []))];
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings, currencies: [], availableByItem: { ...quantities }, ownedByItem: { ...quantities }, currencyById: {},
		roster, coverage: coverage(roster), passCoverages: [coverage(roster), coverage(roster)],
	};
	const rulePack: InventoryAdvisorEngineInputV1['input']['rulePack'] = {
		schemaVersion: 1, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: [],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledge: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [],
	};
	knowledge.sha256 = sha256InventoryKnowledgePack(knowledge);
	return {
		input: {
			version: 1, asOf: '2026-08-14T12:00:00.000Z', snapshot,
			catalog: {
				snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z',
				items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), {
					kind: 'item', id: itemId, name: `Item ${String(itemId)}`, type: 'Trophy', rarity: 'Basic', level: 0,
					vendorValue: 1, flags: [], gameTypes: [], restrictions: [],
				}])),
				currencies: {}, materials: {}, warnings: [],
				coverage: {
					items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), { status: 'resolved', source: 'network' }])),
					currencies: {}, materials: {},
				},
			},
			prices: {
				version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z',
				source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: itemIds, status: 'complete',
				items: itemIds.map((itemId) => ({
					itemId, whitelisted: true, bid: { unitCopper: 20, quantity: bidQuantity }, ask: { unitCopper: 21, quantity: 1 },
				})),
				missingItemIds: [],
			},
			goals: [], keepExceptions: [],
			accountSignals: {
				version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z',
				schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full',
				endpointCoverage: { account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence() },
				unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
				achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
			},
			rulePack,
			policy: {
				version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
				maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
				listingMinimumAdvantageBps: 1_000,
			},
		},
		knowledgePack: knowledge,
	};
}

function coverage(roster: string[]): SnapshotCoverage {
	return { sources: {
		characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' },
		materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' },
	}, characters: Object.fromEntries(roster.map((character) => [character, { status: 'complete' as const }])) };
}
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }

/** A market depth the classifier reads as incomplete: with it on the engine input the analysis is `limited`. */
function unavailableDepth(value: InventoryAdvisorEngineInputV1): NonNullable<InventoryAdvisorEngineInputV1['marketDepth']> {
	const itemIds = value.input.prices.requestedItemIds;
	return {
		version: 1, capturedAt: value.input.asOf, source: 'gw2-commerce-listings', requestedItemIds: [...itemIds],
		status: 'unavailable', items: itemIds.map((itemId) => ({ itemId, coverage: 'missing' as const, buys: [], sells: [] })),
	};
}

/** Redefines an own property as non-enumerable: every read still finds it, a structured clone leaves it behind. */
function hide(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: false, configurable: true, writable: true });
}

/**
 * Three hardenings a security review of the verified analysis asked for. None of them is a way to
 * pass something off as verified; each closes a place where the internal route could part from the
 * public one, throw where it answers, or keep something it did not check.
 */
describe('inventory advisor verified analysis: a property a structured clone would leave behind', () => {
	const hidden = [
		['a market depth on the engine input', (value: InventoryAdvisorEngineInputV1) => {
			hide(value, 'marketDepth', unavailableDepth(value));
		}],
		['the goals inside the input', (value: InventoryAdvisorEngineInputV1) => {
			hide(value.input, 'goals', value.input.goals);
		}],
		['the holdings inside the snapshot', (value: InventoryAdvisorEngineInputV1) => {
			hide(value.input.snapshot, 'holdings', value.input.snapshot.holdings);
		}],
		['the quantity of a holding', (value: InventoryAdvisorEngineInputV1) => {
			const holding = value.input.snapshot.holdings[0]!;
			hide(holding, 'quantity', holding.quantity);
		}],
		// The length of an array is the one non-enumerable own property a plain tree has; nothing else on it is.
		['an extra property on the holdings array', (value: InventoryAdvisorEngineInputV1) => {
			hide(value.input.snapshot.holdings, 'extra', 1);
		}],
	] as const;

	it.each(hidden)('answers what the public route answers for an engine input with a non-enumerable property: %s', (_name, change) => {
		const engineInput = multiLocationFixture();
		change(engineInput);
		const producerResult = classifyInventoryAdvisor(engineInput);
		const classified = classifyInventoryAdvisorVerified(engineInput);
		expect({ status: classified.producerResult.status, coverage: classified.producerResult.report?.coverage ?? null })
			.toEqual({ status: producerResult.status, coverage: producerResult.report?.coverage ?? null });
		expect(classified.producerResult).toEqual(producerResult);
		expect(applyInventoryDiscardAllowlistVerified(classified).result)
			.toEqual(applyInventoryDiscardAllowlist({ engineInput, producerResult }));
	});

	it.each(hidden)('does not copy nor record an engine input with a non-enumerable property: %s', (_name, change) => {
		const engineInput = multiLocationFixture();
		change(engineInput);
		const classified = classifyInventoryAdvisorVerified(engineInput);
		expect(classified.engineInput).toBe(engineInput);
		expect(inventoryAdvisorVerifiedAnalysisContext(applyInventoryDiscardAllowlistVerified(classified))).toBeUndefined();
	});

	it('sends an array with an extra non-enumerable property through the public route: three classifications, the public answer', () => {
		const engineInput = multiLocationFixture();
		hide(engineInput.input.snapshot.holdings, 'extra', 1);
		const publicRoute = analysePublic(engineInput);
		expect(publicRoute.presentation.status).not.toBe('invalid');
		const before = counted.classifications;
		const internal = analyseInternal(engineInput);
		expect(counted.classifications - before).toBe(3);
		expect(internal.source.discardContext.engineInput).toBe(engineInput);
		expect(inventoryAdvisorVerifiedAnalysisContext(internal.source)).toBeUndefined();
		expect(digests(internal)).toEqual(digests(publicRoute));
		expect(internal.presentation).toEqual(publicRoute.presentation);
	});

	it('still copies and records an engine input made of arrays and plain objects only, and classifies it once', () => {
		const engineInput = { ...multiLocationFixture(), materialStorageCapacity: { quantity: 250, source: 'minimum_guaranteed' as const } };
		const before = counted.classifications;
		const classified = classifyInventoryAdvisorVerified(engineInput);
		expect(classified.engineInput).not.toBe(engineInput);
		const source = applyInventoryDiscardAllowlistVerified(classified);
		expect(inventoryAdvisorVerifiedAnalysisContext(source)).toBeDefined();
		expect(buildInventoryAdvisorPresentation(source).status).not.toBe('invalid');
		expect(counted.classifications - before).toBe(1);
	});
});

describe('inventory advisor verified analysis: a value that is not an engine input, nor a pair', () => {
	const values: Array<[string, unknown]> = [
		['null', null], ['undefined', undefined], ['an empty object', {}], ['a number', 5], ['a string', 'engine'], ['an array', []],
	];

	it.each(values)('classifies %s as the public route does, without throwing', (_name, value) => {
		const expected = classifyInventoryAdvisor(value);
		expect(expected.status).toBe('invalid');
		const classified = classifyInventoryAdvisorVerified(value as InventoryAdvisorEngineInputV1);
		expect(classified.producerResult).toEqual(expected);
		expect(classified.engineInput).toEqual(value);
	});

	it.each(values)('applies the allowlist to %s as the public route does, without throwing', (_name, value) => {
		const expected = applyInventoryDiscardAllowlist(value);
		expect(expected.status).toBe('invalid');
		const source = applyInventoryDiscardAllowlistVerified(value as InventoryAdvisorVerifiedAnalysis['discardContext']);
		expect(source.result).toEqual(expected);
		expect(source.discardContext).toBe(value);
		// There is no engine input to take an input from.
		expect(source.input).toBeUndefined();
		expect(inventoryAdvisorVerifiedAnalysisContext(source)).toBeUndefined();
		expect(buildInventoryAdvisorPresentation(source)).toEqual(buildInventoryAdvisorPresentation(
			{ input: undefined, result: expected, discardContext: value } as unknown as InventoryAdvisorContextualPresentationSource,
		));
	});

	it.each(values)('runs both stages on %s as the public route does, without throwing', (_name, value) => {
		const producerResult = classifyInventoryAdvisor(value);
		const expected = applyInventoryDiscardAllowlist({ engineInput: value, producerResult });
		expect(expected.status).toBe('invalid');
		const source = applyInventoryDiscardAllowlistVerified(classifyInventoryAdvisorVerified(value as InventoryAdvisorEngineInputV1));
		expect(source.discardContext.producerResult).toEqual(producerResult);
		expect(source.result).toEqual(expected);
		expect(inventoryAdvisorVerifiedAnalysisContext(source)).toBeUndefined();
	});
});

describe('inventory advisor verified analysis: the controller keeps the source it checked', () => {
	it('reads the source of a workflow result once: a second, different answer cannot be kept in place of the recorded one', async () => {
		const { source } = analyseInternal(multiLocationFixture());
		// Equal to the recorded source, not recorded, and still the caller's to change.
		const lookAlike = structuredClone(source);
		const reads = { source: 0, status: 0 };
		const result = {
			get status() { reads.status += 1; return 'ready' as const; },
			get source() { reads.source += 1; return reads.source === 1 ? source : lookAlike; },
		};
		const controller = new InventoryAdvisorPresentationController({ load: () => Promise.resolve(result) });
		expect((await controller.refresh()).status).toBe('ready');
		expect(reads).toEqual({ source: 1, status: 1 });
		// What the cache keeps is out of reach of whoever returned it: emptying the look-alike's goals,
		// which then no longer match its result, changes no later read.
		lookAlike.input.goals.length = 0;
		const before = counted.classifications;
		expect(controller.current({ sort: 'name_asc' }).status).toBe('ready');
		expect(counted.classifications - before).toBe(0);
		expect(controller.analysis()?.source.input.goals).toHaveLength(1);
	});

	it('detaches a source that is not the recorded one, read once as well', async () => {
		const { source } = analyseInternal(multiLocationFixture());
		const lookAlike = structuredClone(source);
		const reads = { source: 0, status: 0 };
		const result = {
			get status() { reads.status += 1; return 'ready' as const; },
			get source() { reads.source += 1; return reads.source === 1 ? lookAlike : source; },
		};
		const controller = new InventoryAdvisorPresentationController({ load: () => Promise.resolve(result) });
		expect((await controller.refresh()).status).toBe('ready');
		expect(reads).toEqual({ source: 1, status: 1 });
		lookAlike.input.goals.length = 0;
		// The look-alike it read is what it keeps, as a copy of its own, and a copy is reproduced on each read.
		const before = counted.classifications;
		expect(controller.current({ sort: 'name_asc' }).status).toBe('ready');
		expect(counted.classifications - before).toBe(1);
		expect(controller.analysis()?.source.input.goals).toHaveLength(1);
	});

	it('does not take a result for ready on one reading of its status and for something else on the next', async () => {
		const { source } = analyseInternal(multiLocationFixture());
		let reads = 0;
		const result = {
			get status() { reads += 1; return reads === 1 ? 'ready' as const : 'blocked' as const; },
			source,
		} as unknown as { status: 'ready'; source: typeof source };
		const controller = new InventoryAdvisorPresentationController({ load: () => Promise.resolve(result) });
		expect((await controller.refresh()).status).toBe('ready');
		expect(reads).toBe(1);
	});
});
