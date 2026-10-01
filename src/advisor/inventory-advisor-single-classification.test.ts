import { describe, expect, it, vi } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import type { ReservationGoal } from '../economy/reservation-model';
import { InventoryAdvisorPresentationController } from '../ui/inventory-advisor-controller';
import { sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from './inventory-advisor-contract';
import type { InventoryAdvisorEvidenceV1 } from './inventory-advisor-evidence-model';
import { InventoryAdvisorWorkflow, type InventoryAdvisorRules } from './inventory-advisor-workflow';

const counted = vi.hoisted(() => ({ classifications: 0, planBuilds: 0 }));

// Pass-through spies. Both exported classifier entries are wrapped and the public one reaches the
// diagnosed one inside its own module, past the wrapper, so each classification counts once whoever
// asks for it: the workflow, the discard allowlist or a presentation that reproduces its source.
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
vi.mock('../economy/reservation', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../economy/reservation')>();
	return {
		...actual,
		createReservationPlan: (input: unknown) => {
			counted.planBuilds += 1;
			return actual.createReservationPlan(input);
		},
	};
});

/**
 * Audit 1.1/1.2, counted and not timed. One analysis of the account, by the path the plugin runs
 * (workflow, then the controller that presents what the workflow returns), used to classify the
 * account three times: the producer, the discard allowlist reproducing the producer, and the
 * presentation reproducing the allowlist. And every later read of the same analysis with other
 * options classified it once more. The analysis the flow itself produced is now recognised as such
 * and consumed without being reproduced.
 */
describe('inventory advisor: one classification per analysis', () => {
	it('classifies once and builds one reservation plan from capture to the presented model', async () => {
		const { controller } = harness();
		const before = { ...counted };
		const model = await controller.refresh();
		expect(model.status).toBe('ready');
		expect(model.groups.flatMap((group) => group.rows).length).toBeGreaterThan(0);
		expect({
			classifications: counted.classifications - before.classifications,
			planBuilds: counted.planBuilds - before.planBuilds,
		}).toEqual({ classifications: 1, planBuilds: 1 });
	});

	it('classifies nothing and builds no plan when the same analysis is read again with other options', async () => {
		const { controller } = harness();
		const first = await controller.refresh();
		const before = { ...counted };
		const sorted = controller.current({ sort: 'name_asc' });
		const filtered = controller.current({ filters: { groups: ['market'] } });
		const again = controller.current();
		expect(sorted.status).toBe('ready');
		expect(filtered.groups.map((group) => group.key)).toEqual(['market']);
		expect(again.groups).toEqual(first.groups);
		expect({
			classifications: counted.classifications - before.classifications,
			planBuilds: counted.planBuilds - before.planBuilds,
		}).toEqual({ classifications: 0, planBuilds: 0 });
	});

	it('freezes nothing the caller handed in, and hands the notes a copy as free to change as before', async () => {
		const { workflow, controller, fixture, preferences } = harness();
		await controller.refresh();
		controller.current({ sort: 'name_asc' });
		expect(firstFrozen(fixture.evidence)).toBeNull();
		expect(firstFrozen(fixture.rules)).toBeNull();
		expect(firstFrozen(preferences)).toBeNull();
		// The source the workflow returns is the recorded analysis: frozen, and not one of the caller's objects.
		const result = await workflow.refresh('es');
		if (result.status !== 'ready') throw new Error('Expected a ready analysis.');
		expect(Object.isFrozen(result.source)).toBe(true);
		expect(result.source.input.snapshot).not.toBe(fixture.evidence.snapshot);
		expect(firstFrozen(fixture.evidence)).toBeNull();
		// What `analysis()` gives the inventory notes is a detached copy: not frozen, and changing it reaches nothing.
		const analysis = controller.analysis();
		if (analysis === null) throw new Error('Expected an analysis.');
		expect(firstFrozen(analysis)).toBeNull();
		const rows = controller.current().groups.flatMap((group) => group.rows).length;
		analysis.source.input.goals.length = 0;
		analysis.source.result.report!.lines.length = 0;
		analysis.source.discardContext.producerResult.report!.lines.length = 0;
		expect(controller.analysis()?.source.result.report?.lines.length).toBeGreaterThan(0);
		expect(controller.analysis()?.source.input.goals).toHaveLength(1);
		expect(controller.current({ sort: 'action_asc' }).groups.flatMap((group) => group.rows).length).toBe(rows);
		// The model a view reads is frozen below its top level, exactly as it was before this change.
		const model = controller.current();
		expect(Object.isFrozen(model)).toBe(false);
		expect(Object.isFrozen(model.groups)).toBe(true);
	});

	it('classifies once per reclassification, on the retained capture', async () => {
		const { controller } = harness();
		await controller.refresh();
		const before = { ...counted };
		const model = await controller.reclassify();
		expect(model.status).toBe('ready');
		expect({
			classifications: counted.classifications - before.classifications,
			planBuilds: counted.planBuilds - before.planBuilds,
		}).toEqual({ classifications: 1, planBuilds: 1 });
	});
});

function harness() {
	const fixture = captureFixture();
	const preferences = { goals: [reserve()], keepExceptions: [] };
	const workflow = new InventoryAdvisorWorkflow({
		capture: { capture: async () => ({ status: 'complete' as const, evidence: fixture.evidence }) },
		preferences: { load: async () => ({ status: 'ready' as const, value: preferences }) },
		rules: { current: () => ({ status: 'available', value: fixture.rules }) },
		now: () => Date.parse('2026-08-14T12:00:00.000Z'),
	});
	const controller = new InventoryAdvisorPresentationController({
		load: (parent) => workflow.refresh('es', parent),
		reclassify: (parent) => workflow.reclassify(parent),
	});
	return { workflow, controller, fixture, preferences };
}

/** The path of the first object inside `value` that is frozen, or null when none is. */
function firstFrozen(value: unknown, path = '$'): string | null {
	if (value === null || typeof value !== 'object') return null;
	if (Object.isFrozen(value)) return path;
	for (const [key, child] of Object.entries(value)) {
		const found = firstFrozen(child, `${path}.${key}`);
		if (found !== null) return found;
	}
	return null;
}

function reserve(): ReservationGoal {
	return {
		schemaVersion: 1, goalId: 'goal-a', title: 'Objetivo A', status: 'active', priority: 100, reason: 'purchase',
		requirements: [{ key: 'item:10', namespace: 'item', id: 10, targetQuantity: 6, creditedQuantity: 0,
			basis: 'available', intendedUse: 'consume' }],
	};
}

/** A stable capture of three objects over four stacks, every one priced: reservations, a sale and listings. */
function captureFixture(): { evidence: InventoryAdvisorEvidenceV1; rules: InventoryAdvisorRules } {
	const stacks = [
		{ itemId: 10, quantity: 12, location: { source: 'bank' as const, slot: 0 } },
		{ itemId: 11, quantity: 4, location: { source: 'bank' as const, slot: 1 } },
		{ itemId: 10, quantity: 8, location: { source: 'shared_inventory' as const, slot: 0 } },
		{ itemId: 12, quantity: 1, location: { source: 'bank' as const, slot: 2 } },
	];
	const itemIds = [10, 11, 12];
	const quantities = { '10': 20, '11': 4, '12': 1 };
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: stacks.map((stack) => ({ kind: 'item', ...stack, state: 'loose', metadata: {} })),
		currencies: [], availableByItem: { ...quantities }, ownedByItem: { ...quantities }, currencyById: {},
		roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: [],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledgePack: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [],
	};
	knowledgePack.sha256 = sha256InventoryKnowledgePack(knowledgePack);
	const evidence: InventoryAdvisorEvidenceV1 = {
		version: 1, scope: 'supported_storage_v1', accountId: 'account-1', snapshotId: 'snapshot-1', schemaVersion: PINNED_SCHEMA,
		capturedAt: snapshot.completedAt, finishedAt: '2026-08-14T12:00:00.000Z', locale: 'es', snapshot,
		snapshotFingerprint: sha256CanonicalValue(snapshot),
		ttl: { snapshotMs: 900_000, catalogMs: 604_800_000, pricesMs: 900_000, accountSignalsMs: 86_400_000 },
		coverage: { snapshot: 'complete', catalog: 'complete', prices: 'complete', accountSignals: 'complete' },
		catalog: {
			snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z',
			items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), {
				kind: 'item' as const, id: itemId, name: `Item ${String(itemId)}`, type: 'Trophy', rarity: 'Basic', level: 0,
				vendorValue: 1, flags: [], gameTypes: [], restrictions: [],
			}])),
			currencies: {}, materials: {}, warnings: [],
			coverage: {
				items: Object.fromEntries(itemIds.map((itemId) => [String(itemId), { status: 'resolved' as const, source: 'network' as const }])),
				currencies: {}, materials: {},
			},
		},
		prices: {
			version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z',
			source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: itemIds, status: 'complete',
			items: itemIds.map((itemId) => ({
				itemId, whitelisted: true, bid: { unitCopper: 20, quantity: 10 }, ask: { unitCopper: 21, quantity: 1 },
			})),
			missingItemIds: [],
		},
		accountSignals: {
			version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z',
			schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full',
			endpointCoverage: { account: endpoint(), recipes: endpoint(), skins: endpoint(), minis: endpoint(), achievements: endpoint() },
			unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
			achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
		},
	};
	return { evidence, rules: { rulePack, knowledgePack, policy: {
		version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
		maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
		listingMinimumAdvantageBps: 1_000,
	} } };
}

function coverage(): SnapshotCoverage {
	return { sources: {
		characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' },
		materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' },
	}, characters: {} };
}
function endpoint() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
