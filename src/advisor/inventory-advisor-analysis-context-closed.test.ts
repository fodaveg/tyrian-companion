import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import { classifyInventoryAdvisor, classifyInventoryAdvisorDiagnosed, sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256InventoryRulePack } from './inventory-advisor-contract';
import { applyInventoryDiscardAllowlist, isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';
import {
	createInventoryAdvisorAnalysisContext,
	isInventoryAdvisorResultForAnalysis,
	type InventoryAdvisorAnalysisContext,
} from './inventory-advisor-result';

/**
 * The analysis context is the one thing three exported functions take on trust besides the data:
 * the result contract, the classifier and the discard contract each accept the context of a caller
 * that already works on the same input. The set of contexts is by identity, so what has to hold is
 * that a context this module created cannot be turned, by whoever holds it, into one that serves
 * another plan or another index. The account below holds 10 units and a goal that reserves 6; the
 * forgery is the result of the same account without the goal, which sells all 10.
 */
describe('inventory advisor analysis context cannot be altered by its holder', () => {
	it('control: the forged result sells the 6 reserved units, and every door without a context refuses it', () => {
		const { engineInput, honest, forged } = setup();
		expect(honest.producerResult.report?.lines[0]?.reservedQuantity).toBe(6);
		expect(forged.producerResult.report?.lines[0]?.reservedQuantity).toBe(0);
		expect(isInventoryAdvisorResultForAnalysis(
			forged.producerResult, createInventoryAdvisorAnalysisContext(engineInput.input), engineInput.knowledgePack,
		)).toBe(false);
		expect(isInventoryDiscardAllowlistResultForInput(forged.result, { engineInput, producerResult: forged.producerResult }))
			.toBe(false);
		expect(buildInventoryAdvisorPresentation({
			input: engineInput.input, result: forged.result,
			discardContext: { engineInput, producerResult: forged.producerResult },
		}).status).toBe('invalid');
	});

	it('is frozen: a method cannot be replaced and a property cannot be added', () => {
		const { engineInput, donor } = setup();
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		const method = (): unknown => Object.getOwnPropertyDescriptor(context, 'reservation')?.value;
		const reservation = method();
		expect(Object.isFrozen(context)).toBe(true);
		attempt(() => Object.assign(context, { ...planOf(donor), extra: 1 }));
		expect(method()).toBe(reservation);
		expect('extra' in context).toBe(false);
	});

	it('the result contract refuses the forged result against a context whose methods a caller tried to replace', () => {
		const { engineInput, forged, tampered } = setup();
		expect(isInventoryAdvisorResultForAnalysis(forged.producerResult, tampered, engineInput.knowledgePack)).toBe(false);
	});

	it('the classifier does not classify with the plan a caller tried to put in the context', () => {
		const { engineInput, honest, tampered } = setup();
		expect(classifyInventoryAdvisorDiagnosed(engineInput, tampered).result).toEqual(honest.producerResult);
	});

	it('the discard contract refuses the forged discard result against that context', () => {
		const { engineInput, forged, tampered } = setup();
		expect(isInventoryDiscardAllowlistResultForInput(
			forged.result, { engineInput, producerResult: forged.producerResult }, tampered,
		)).toBe(false);
	});

	it('replacing one method does not reach another: the plan asset still comes from this context\'s own plan', () => {
		const { engineInput, donor } = setup();
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		// Only `reservation` is swapped, before anything was derived; `planAsset` must not go through it.
		attempt(() => Object.assign(context, { reservation: planOf(donor).reservation }));
		expect(context.planAsset('item:10')?.protectedAvailable).toBe(6);
	});

	it('serves the same plan again after a caller edits the one it was given', () => {
		const { engineInput, forged } = setup();
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		const first = context.reservation();
		if (first.plan.status !== 'ok') throw new Error('Expected a valid plan.');
		const plan = first.plan.plan;
		attempt(() => { plan.assets.find((asset) => asset.key === 'item:10')!.protectedAvailable = 0; });
		attempt(() => { plan.assets.length = 0; });
		attempt(() => { (first as { plan: unknown }).plan = { status: 'invalid' }; });
		attempt(() => { context.planAsset('item:10')!.protectedAvailable = 0; });
		const again = context.reservation();
		expect(again.plan.status === 'ok' && again.plan.plan.assets.find((asset) => asset.key === 'item:10')?.protectedAvailable)
			.toBe(6);
		expect(context.planAsset('item:10')?.protectedAvailable).toBe(6);
		expect(isInventoryAdvisorResultForAnalysis(forged.producerResult, context, engineInput.knowledgePack)).toBe(false);
	});

	it('serves the same positions again after a caller edits the list it was given', () => {
		const { engineInput, honest } = setup();
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		const list = context.positions(10) as InventoryAdvisorAnalysisContext['positions'] extends (itemId: number) => readonly (infer Entry)[]
			? Entry[] : never;
		expect(list.map((entry) => entry.holdingIndex)).toEqual([0]);
		attempt(() => { list[0]!.holdingIndex = 7; });
		attempt(() => { list.push({ holding: list[0]!.holding, holdingIndex: 1 }); });
		attempt(() => { list.length = 0; });
		const missing = context.positions(999) as unknown[];
		attempt(() => { missing.push(list[0]); });
		expect(context.positions(10).map((entry) => entry.holdingIndex)).toEqual([0]);
		expect(context.positions(999)).toEqual([]);
		expect(createInventoryAdvisorAnalysisContext(engineInput.input).positions(999)).toEqual([]);
		// The honest result still verifies against it: the index the contract reads was not touched.
		expect(isInventoryAdvisorResultForAnalysis(honest.producerResult, context, engineInput.knowledgePack)).toBe(true);
	});

	it.each([
		['an object that inherits from a context', (context: InventoryAdvisorAnalysisContext, donor: InventoryAdvisorAnalysisContext) =>
			Object.create(context, {
				reservation: { value: planOf(donor).reservation }, planAsset: { value: planOf(donor).planAsset },
			}) as InventoryAdvisorAnalysisContext],
		['a proxy over a context', (context: InventoryAdvisorAnalysisContext, donor: InventoryAdvisorAnalysisContext) =>
			new Proxy(context, {
				get: (target, property, receiver) => property === 'reservation' ? planOf(donor).reservation
					: property === 'planAsset' ? planOf(donor).planAsset : Reflect.get(target, property, receiver) as unknown,
				// A frozen target must report its real own properties; a proxy answers `get` as it likes.
				getOwnPropertyDescriptor: (target, property) => Reflect.getOwnPropertyDescriptor(target, property),
			})],
		['a copy of a context', (context: InventoryAdvisorAnalysisContext, donor: InventoryAdvisorAnalysisContext) =>
			({ ...context, ...planOf(donor) })],
	] as const)('refuses %s that answers with another plan: it is not one of the contexts created here', (_name, wrap) => {
		const { engineInput, honest, forged, donor } = setup();
		const fake = wrap(createInventoryAdvisorAnalysisContext(engineInput.input), donor);
		expect(fake.input).toBe(engineInput.input);
		// Not even the honest result verifies against it: the look-alike is refused, not read.
		expect(isInventoryAdvisorResultForAnalysis(honest.producerResult, fake, engineInput.knowledgePack)).toBe(false);
		expect(isInventoryAdvisorResultForAnalysis(forged.producerResult, fake, engineInput.knowledgePack)).toBe(false);
		expect(classifyInventoryAdvisorDiagnosed(engineInput, fake).result.status).toBe('invalid');
		expect(isInventoryDiscardAllowlistResultForInput(
			forged.result, { engineInput, producerResult: forged.producerResult }, fake,
		)).toBe(false);
		expect(isInventoryDiscardAllowlistResultForInput(
			honest.result, { engineInput, producerResult: honest.producerResult }, fake,
		)).toBe(false);
	});

	it('freezes what it derives and nothing of the caller\'s input', () => {
		const { engineInput } = setup();
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		const derived = context.reservation();
		const entry = context.positions(10)[0]!;
		expect(Object.isFrozen(derived)).toBe(true);
		expect(Object.isFrozen(derived.plan)).toBe(true);
		expect(Object.isFrozen(context.planAsset('item:10'))).toBe(true);
		expect(Object.isFrozen(context.positions(10))).toBe(true);
		expect(Object.isFrozen(entry)).toBe(true);
		// The holding inside the entry is the caller's own object, as mutable as before.
		expect(entry.holding).toBe(engineInput.input.snapshot.holdings[0]);
		const input = engineInput.input;
		for (const value of [input, input.snapshot, input.snapshot.holdings, input.snapshot.holdings[0], input.snapshot.ownedByItem,
			input.goals, input.goals[0], input.goals[0]!.requirements, input.goals[0]!.requirements[0], input.rulePack]) {
			expect(Object.isFrozen(value)).toBe(false);
		}
	});
});

/**
 * Known limit, fixed here so that a change to it is a decision. A context derives its plan and its
 * index once. A caller that changes the input afterwards and keeps using the context is checked
 * against the plan of the input as it was. Every stage of this module's flow creates its context
 * and uses it inside one synchronous call, on an input nothing changes meanwhile; the doors that
 * take no context (`isInventoryAdvisorResultForInput`, `applyInventoryDiscardAllowlist`, the
 * presentation) always derive from the input as it is.
 */
describe('inventory advisor analysis context: known limit when the input changes after a derivation', () => {
	it('keeps the plan of the input as it was when a goal is removed afterwards', () => {
		const { engineInput, honest, forged } = setup();
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		expect(isInventoryAdvisorResultForAnalysis(honest.producerResult, context, engineInput.knowledgePack)).toBe(true);
		engineInput.input.goals = [];
		// The input now equals the one the forgery was produced from, which a new context confirms...
		expect(isInventoryAdvisorResultForAnalysis(
			forged.producerResult, createInventoryAdvisorAnalysisContext(engineInput.input), engineInput.knowledgePack,
		)).toBe(true);
		// ...but the old context still holds the plan with the goal: it refuses that result and accepts the stale one.
		expect(isInventoryAdvisorResultForAnalysis(forged.producerResult, context, engineInput.knowledgePack)).toBe(false);
		expect(isInventoryAdvisorResultForAnalysis(honest.producerResult, context, engineInput.knowledgePack)).toBe(true);
	});

	it('keeps the plan of the input as it was when a goal is added afterwards, so the reserved units go unprotected', () => {
		const { engineInput, honest, forged } = setup();
		const goals = engineInput.input.goals;
		engineInput.input.goals = [];
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		expect(isInventoryAdvisorResultForAnalysis(forged.producerResult, context, engineInput.knowledgePack)).toBe(true);
		engineInput.input.goals = goals;
		// Through the same context the result that sells the reserved units is still accepted, by the
		// result contract and by the discard contract, and the result that protects them is refused.
		expect(isInventoryAdvisorResultForAnalysis(forged.producerResult, context, engineInput.knowledgePack)).toBe(true);
		expect(isInventoryDiscardAllowlistResultForInput(
			forged.result, { engineInput, producerResult: forged.producerResult }, context,
		)).toBe(true);
		expect(isInventoryAdvisorResultForAnalysis(honest.producerResult, context, engineInput.knowledgePack)).toBe(false);
		// Without the context, or with a new one, the same call refuses it.
		expect(isInventoryDiscardAllowlistResultForInput(forged.result, { engineInput, producerResult: forged.producerResult }))
			.toBe(false);
		expect(isInventoryAdvisorResultForAnalysis(
			forged.producerResult, createInventoryAdvisorAnalysisContext(engineInput.input), engineInput.knowledgePack,
		)).toBe(false);
	});

	it('derives on first use, so a change before any derivation is simply the input the context reads', () => {
		const { engineInput, forged } = setup();
		const context = createInventoryAdvisorAnalysisContext(engineInput.input);
		engineInput.input.goals = [];
		expect(isInventoryAdvisorResultForAnalysis(forged.producerResult, context, engineInput.knowledgePack)).toBe(true);
	});
});

/** Runs an edit a frozen object refuses by throwing; what matters is the state afterwards. */
function attempt(edit: () => void): void {
	try { edit(); } catch { /* frozen: the edit did not happen */ }
}

/** The two methods a forger would put in place of a context's own, answering with the plan of `donor`. */
function planOf(donor: InventoryAdvisorAnalysisContext): Pick<InventoryAdvisorAnalysisContext, 'reservation' | 'planAsset'> {
	return { reservation: () => donor.reservation(), planAsset: (key) => donor.planAsset(key) };
}

function analyse(engineInput: InventoryAdvisorEngineInputV1) {
	const producerResult = classifyInventoryAdvisor(engineInput);
	return { producerResult, result: applyInventoryDiscardAllowlist({ engineInput, producerResult }) };
}

/** The account, its honest analysis, the forgery, a context of the forgery's input and one a caller tried to alter. */
function setup() {
	const engineInput = fixture();
	const withoutGoals = fixture();
	withoutGoals.input.goals = [];
	const donor = createInventoryAdvisorAnalysisContext(withoutGoals.input);
	const tampered = createInventoryAdvisorAnalysisContext(engineInput.input);
	attempt(() => Object.assign(tampered, planOf(donor)));
	return { engineInput, honest: analyse(engineInput), forged: analyse(withoutGoals), donor, tampered };
}

/** Ten loose units of item 10 in the bank, a bid that takes them all, and a goal that reserves six. */
function fixture(): InventoryAdvisorEngineInputV1 {
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId: 10, quantity: 10, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }],
		currencies: [], availableByItem: { '10': 10 }, ownedByItem: { '10': 10 }, currencyById: {},
		roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
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
				items: { '10': {
					kind: 'item', id: 10, name: 'Item 10', type: 'Trophy', rarity: 'Basic', level: 0,
					vendorValue: 1, flags: [], gameTypes: [], restrictions: [],
				} },
				currencies: {}, materials: {}, warnings: [],
				coverage: { items: { '10': { status: 'resolved', source: 'network' } }, currencies: {}, materials: {} },
			},
			prices: {
				version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z',
				source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: [10], status: 'complete',
				items: [{ itemId: 10, whitelisted: true, bid: { unitCopper: 20, quantity: 100 }, ask: { unitCopper: 21, quantity: 1 } }],
				missingItemIds: [],
			},
			goals: [{
				schemaVersion: 1, goalId: 'goal-a', title: 'Objetivo A', status: 'active', priority: 100, reason: 'purchase',
				requirements: [{ key: 'item:10', namespace: 'item', id: 10, targetQuantity: 6, creditedQuantity: 0,
					basis: 'available', intendedUse: 'consume' }],
			}],
			keepExceptions: [],
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

function coverage(): SnapshotCoverage {
	return { sources: {
		characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' },
		materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' },
	}, characters: {} };
}
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
