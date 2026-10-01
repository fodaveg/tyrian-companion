import { describe, expect, it, vi } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import type { ReservationGoal } from '../economy/reservation-model';
import {
	classifyInventoryAdvisor, classifyInventoryAdvisorDiagnosed, sha256InventoryKnowledgePack,
} from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from './inventory-advisor-contract';
import { applyInventoryDiscardAllowlist } from './inventory-advisor-discard';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';
import { createInventoryAdvisorAnalysisContext, isInventoryAdvisorResultForAnalysis } from './inventory-advisor-result';

const reservation = vi.hoisted(() => ({ planBuilds: 0 }));

// Pass-through spy: the real plan is built and returned, only the number of builds is observed.
vi.mock('../economy/reservation', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../economy/reservation')>();
	return {
		...actual,
		createReservationPlan: (input: unknown) => {
			reservation.planBuilds += 1;
			return actual.createReservationPlan(input);
		},
	};
});

/**
 * Audit 1.6/1.7: one analysis used to sweep the whole inventory once per line (twice, counting the
 * result contract) and to rebuild the reservation plan in every stage. The position index and the
 * plan now live in a context that lasts one entry point, never longer: nothing is keyed by
 * `snapshotId`, so the goals of one analysis cannot leak into the next.
 */
describe('inventory advisor analysis context', () => {
	it('fixes the whole result for one object held in several places and states', () => {
		const analysis = analyse(multiLocationFixture());
		const line = analysis.producerResult.report?.lines.find((entry) => entry.itemId === 10);
		expect(line?.positions).toEqual([
			{ ref: '#/positions/10/0', holdingIndex: 0, itemId: 10, quantity: 5, source: 'character', state: 'loose' },
			{ ref: '#/positions/10/2', holdingIndex: 2, itemId: 10, quantity: 7, source: 'bank', state: 'loose' },
			{ ref: '#/positions/10/4', holdingIndex: 4, itemId: 10, quantity: 20, source: 'materials', state: 'loose' },
			{ ref: '#/positions/10/5', holdingIndex: 5, itemId: 10, quantity: 3, source: 'shared_inventory', state: 'loose' },
			{ ref: '#/positions/10/6', holdingIndex: 6, itemId: 10, quantity: 2, source: 'commerce_delivery', state: 'pending_claim' },
		]);
		expect(line).toMatchObject({
			ownedQuantity: 37, availableQuantity: 37, reservedQuantity: 6, exceptionQuantity: 9,
			retainedQuantity: 0, actionedQuantity: 20, unclassifiedQuantity: 2,
		});
		expect(line?.decisions.map((decision) => ({
			action: decision.action, quantity: decision.quantity, allocations: decision.allocations,
		}))).toEqual([
			{ action: 'keep', quantity: 5, allocations: [{ positionRef: '#/positions/10/0', quantity: 5 }] },
			{ action: 'keep', quantity: 1, allocations: [{ positionRef: '#/positions/10/2', quantity: 1 }] },
			{ action: 'keep', quantity: 6, allocations: [{ positionRef: '#/positions/10/2', quantity: 6 }] },
			{ action: 'keep', quantity: 3, allocations: [{ positionRef: '#/positions/10/4', quantity: 3 }] },
			{ action: 'list', quantity: 15, allocations: [{ positionRef: '#/positions/10/4', quantity: 15 }] },
			{ action: 'list', quantity: 3, allocations: [{ positionRef: '#/positions/10/5', quantity: 3 }] },
			{ action: 'review', quantity: 2, allocations: [{ positionRef: '#/positions/10/6', quantity: 2 }] },
			{ action: 'sell', quantity: 2, allocations: [{ positionRef: '#/positions/10/4', quantity: 2 }] },
		]);
		expect(analysis.producerResult.report?.lines.find((entry) => entry.itemId === 11)).toMatchObject({
			ownedQuantity: 4, reservedQuantity: 0, exceptionQuantity: 4, actionedQuantity: 0,
		});
		expect(hashes(analysis)).toEqual({
			producer: '69057f056177c545c37d987ff23796f902b47b53e216b3b7e6b098ee3a9efdfe',
			discard: 'c6971790f32d520e1b0e9509efde8f5392c957d040dc13ef6969f915f7e6fb44',
			presentation: '260c39e5bd7024a1558fa5e4cc1a6160fe255de2a345ba580e2e38033911d4ec',
		});
	});

	it('does not carry the plan of one analysis into the next when the goals of the same snapshot change', () => {
		const engineInput = multiLocationFixture();
		const first = analyse(engineInput);
		// Same input object, same snapshot and snapshotId: only the preferences move.
		engineInput.input.goals = [reserve('goal-b', 'Objetivo B', 2)];
		const second = analyse(engineInput);
		const fresh = multiLocationFixture();
		fresh.input.goals = [reserve('goal-b', 'Objetivo B', 2)];
		const expected = analyse(fresh);

		expect(first.producerResult.report?.lines.find((line) => line.itemId === 10)?.reservedQuantity).toBe(6);
		expect(second.producerResult.report?.lines.find((line) => line.itemId === 10)?.reservedQuantity).toBe(2);
		expect(second.producerResult).toEqual(expected.producerResult);
		expect(second.result).toEqual(expected.result);
		expect(second.presentation).toEqual(expected.presentation);
		expect(hashes(second)).toEqual(hashes(expected));
		expect(hashes(second).producer).not.toBe(hashes(first).producer);
		const goalIds = (analysis: Analysis) => analysis.presentation.groups.flatMap((group) => group.rows)
			.flatMap((row) => row.protectionReasons).filter((reason) => reason.kind === 'reservation_goal')
			.map((reason) => reason.id);
		expect(new Set(goalIds(first))).toEqual(new Set(['goal-a']));
		expect(new Set(goalIds(second))).toEqual(new Set(['goal-b']));
	});

	it('shares a context only for its own input and refuses one that was not created by the result contract', () => {
		const engineInput = multiLocationFixture();
		const other = multiLocationFixture();
		other.input.goals = [reserve('goal-b', 'Objetivo B', 2)];
		const result = classifyInventoryAdvisor(engineInput);
		const own = createInventoryAdvisorAnalysisContext(engineInput.input);
		expect(isInventoryAdvisorResultForAnalysis(result, own, engineInput.knowledgePack)).toBe(true);
		// The context of another input verifies against THAT input: its plan reserves 2, not 6.
		expect(isInventoryAdvisorResultForAnalysis(
			result, createInventoryAdvisorAnalysisContext(other.input), other.knowledgePack,
		)).toBe(false);
		// A look-alike that carries the right input but its own answers is not a context.
		const forged = { ...own };
		expect(isInventoryAdvisorResultForAnalysis(result, forged, engineInput.knowledgePack)).toBe(false);
		// A context of another input handed to the classifier is ignored, not trusted.
		expect(classifyInventoryAdvisorDiagnosed(engineInput, createInventoryAdvisorAnalysisContext(other.input)).result)
			.toEqual(result);
	});

	it('never sweeps the whole inventory per line and builds the reservation plan once per entry point', () => {
		const small = countedAnalysis(60);
		const large = countedAnalysis(120);
		// One build per public entry point. Each one receives its own `unknown` and validates it
		// before deriving anything, so the three do not share a plan; inside each, every stage does.
		// The number of whole-inventory passes is a constant of the code, not a function of the
		// account: doubling the lines must leave it where it was.
		expect({ planBuilds: small.planBuilds, sweepsAtTwiceTheLines: large.sweeps }).toEqual({
			planBuilds: { classify: 1, discard: 1, presentation: 1 },
			sweepsAtTwiceTheLines: small.sweeps,
		});
		expect(large.planBuilds).toEqual(small.planBuilds);
	});
});

interface Analysis {
	producerResult: ReturnType<typeof classifyInventoryAdvisor>;
	result: ReturnType<typeof applyInventoryDiscardAllowlist>;
	presentation: ReturnType<typeof buildInventoryAdvisorPresentation>;
}

function analyse(engineInput: InventoryAdvisorEngineInputV1): Analysis {
	const producerResult = classifyInventoryAdvisor(engineInput);
	const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
	const presentation = buildInventoryAdvisorPresentation({
		input: engineInput.input, result, discardContext: { engineInput, producerResult },
	});
	expect(producerResult.status).toBe('ready');
	expect(result.status).toBe('ready');
	expect(presentation.status).toBe('ready');
	return { producerResult, result, presentation };
}

function hashes(analysis: Analysis): { producer: string; discard: string; presentation: string } {
	return {
		producer: sha256CanonicalValue(analysis.producerResult),
		discard: sha256CanonicalValue(analysis.result),
		presentation: sha256CanonicalValue(JSON.parse(JSON.stringify(analysis.presentation))),
	};
}

/**
 * Runs the three entry points over `count` single-stack items while a proxy counts every read of a
 * holding by index. `sweeps` is those reads divided by the number of holdings: the whole-inventory
 * passes each entry point is worth, whatever mix of loops and direct lookups produced them.
 */
function countedAnalysis(count: number): {
	planBuilds: Record<'classify' | 'discard' | 'presentation', number>;
	sweeps: Record<'classify' | 'discard' | 'presentation', number>;
} {
	const engineInput = accountFixture(Array.from({ length: count }, (_, index) => ({
		itemId: 10 + index, quantity: 1, location: { source: 'bank' as const, slot: index },
	})));
	let reads = 0;
	engineInput.input.snapshot.holdings = new Proxy(engineInput.input.snapshot.holdings, {
		get(target, property, receiver) {
			if (typeof property === 'string' && /^\d+$/u.test(property)) reads += 1;
			return Reflect.get(target, property, receiver) as unknown;
		},
	});
	const measure = <T>(run: () => T): { value: T; planBuilds: number; sweeps: number } => {
		const before = { reads, planBuilds: reservation.planBuilds };
		const value = run();
		return { value, planBuilds: reservation.planBuilds - before.planBuilds, sweeps: (reads - before.reads) / count };
	};
	const classify = measure(() => classifyInventoryAdvisor(engineInput));
	const discard = measure(() => applyInventoryDiscardAllowlist({ engineInput, producerResult: classify.value }));
	const presentation = measure(() => buildInventoryAdvisorPresentation({
		input: engineInput.input, result: discard.value,
		discardContext: { engineInput, producerResult: classify.value },
	}));
	expect(classify.value.report?.lines.length).toBe(count);
	expect(presentation.value.status).toBe('ready');
	return {
		planBuilds: { classify: classify.planBuilds, discard: discard.planBuilds, presentation: presentation.planBuilds },
		sweeps: { classify: classify.sweeps, discard: discard.sweeps, presentation: presentation.sweeps },
	};
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
	]);
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

/** A stable two-pass account holding exactly `stacks`, every item priced and resolved. */
function accountFixture(stacks: FixtureStack[]): InventoryAdvisorEngineInputV1 {
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
					itemId, whitelisted: true, bid: { unitCopper: 20, quantity: 1 }, ask: { unitCopper: 21, quantity: 1 },
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
