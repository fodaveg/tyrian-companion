import { describe, expect, it, vi } from 'vitest';

import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import { sha256CanonicalValue, sha256InventoryRulePack } from './inventory-advisor-contract';
import { sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import type { InventoryAdvisorEvidenceV1 } from './inventory-advisor-evidence-model';
import { inventoryAdvisorBuiltinBundleProvider } from './inventory-advisor-builtin-bundle';
import type { AccountSignalsV1, InventoryPriceSnapshotV1 } from './inventory-advisor-model';
import { INVENTORY_CONTAINER_PRICE_EVIDENCE_VERSION } from './inventory-container-economy';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';
import { ambientCapabilityUse } from '../test/ambient-capabilities';
import type { ContainerPersonalValuationV1 } from '../economy/container-personal-valuation';
import type {
	LocalDebugActionContext,
	LocalDebugEventContext,
	ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';
import {
	createInventoryAdvisorBuiltinRulesProvider,
	EMPTY_INVENTORY_ADVISOR_PREFERENCES,
	InventoryAdvisorWorkflow,
	type InventoryAdvisorRules,
} from './inventory-advisor-workflow';

describe('H5.11 inventory advisor workflow', () => {
	it('records a rate-limited refresh as retry with the caller action identity', async () => {
		const diagnostics = diagnosticHarness();
		const capture = vi.fn(async () => ({ status: 'unavailable' as const, evidence: null, failure: 'rate_limited' as const }));
		const parent: ResolvedLocalDebugActionContext = {
			component: 'ui', action: 'command_execute', actionId: 'refresh-action', correlationId: 'command-chain',
		};
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture },
			preferences: EMPTY_INVENTORY_ADVISOR_PREFERENCES,
			rules: { current: () => ({ status: 'available', value: {} as never }) },
			diagnostics,
		});

		await expect(workflow.refresh('es', parent)).resolves.toEqual({
			status: 'blocked', reason: 'capture_rate_limited',
		});
		expect(diagnostics.created).toBe(1);
		expect(diagnostics.events.map(({ phase }) => phase)).toEqual(['start', 'retry']);
		expect(diagnostics.events.at(-1)).toMatchObject({
			action: 'inventory_advisor_refresh', code: 'retry_scheduled', state: 'capture_rate_limited',
			actionId: 'generated-1', correlationId: 'command-chain',
		});
		expect(capture).toHaveBeenCalledWith(
			'es', undefined, undefined,
			expect.objectContaining({ actionId: 'generated-1', correlationId: 'command-chain' }),
		);
	});

	it('blocks on a missing reviewed rules bundle before capture or preference I/O', async () => {
		const capture = vi.fn();
		const preferences = vi.fn();
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture },
			preferences: { load: preferences },
			rules: { current: () => ({ status: 'unavailable' }) },
		});
		await expect(workflow.refresh('es')).resolves.toEqual({ status: 'blocked', reason: 'missing_rules' });
		expect(capture).not.toHaveBeenCalled();
		expect(preferences).not.toHaveBeenCalled();
	});

	it('captures exactly once and preserves unavailable evidence before preference I/O', async () => {
		const capture = vi.fn(async () => ({ status: 'unavailable' as const, evidence: null }));
		const preferences = vi.fn(async () => ({ status: 'ready' as const, value: { goals: [], keepExceptions: [] } }));
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture },
			preferences: { load: preferences },
			rules: { current: () => ({ status: 'available', value: {} as never }) },
		});
		await expect(workflow.refresh('en')).resolves.toEqual({ status: 'blocked', reason: 'capture_unavailable' });
		expect(capture).toHaveBeenCalledOnce();
		expect(capture).toHaveBeenCalledWith('en');
		expect(preferences).not.toHaveBeenCalled();
	});

	it('distinguishes invalid capture evidence from local preference failures', async () => {
		const preferences = vi.fn(async () => ({ status: 'ready' as const, value: { goals: [], keepExceptions: [] } }));
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture: async () => ({ status: 'invalid', evidence: null }) }, preferences: { load: preferences },
			rules: { current: () => ({ status: 'available', value: {} as never }) },
		});
		await expect(workflow.refresh('es')).resolves.toEqual({ status: 'blocked', reason: 'capture_invalid' });
		expect(preferences).not.toHaveBeenCalled();
	});

	it.each([
		['snapshot_coverage_incomplete', 'capture_snapshot_coverage_incomplete'],
		['snapshot_structure_invalid', 'capture_snapshot_structure_invalid'],
	] as const)('preserves the safe snapshot failure %s', async (failure, reason) => {
		const preferences = vi.fn();
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture: async () => ({ status: 'invalid', evidence: null, failure }) },
			preferences: { load: preferences },
			rules: { current: () => ({ status: 'available', value: {} as never }) },
		});
		await expect(workflow.refresh('es')).resolves.toEqual({ status: 'blocked', reason });
		expect(preferences).not.toHaveBeenCalled();
	});

	it('preserves a missing SecretStorage selection as a safe credential reason', async () => {
		const preferences = vi.fn();
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture: async () => ({ status: 'unavailable', evidence: null, failure: 'missing_key' }) },
			preferences: { load: preferences }, rules: { current: () => ({ status: 'available', value: {} as never }) },
		});
		await expect(workflow.refresh('es')).resolves.toEqual({ status: 'blocked', reason: 'credential_unavailable' });
		expect(preferences).not.toHaveBeenCalled();
	});

	it('loads the human-reviewed bundle but invents no action when economic evidence is unavailable', async () => {
		const fixture = reviewedDiscardFixture();
		rebaseEvidence(fixture.evidence, '2026-08-16T05:22:30.000Z');
		const expectedPriceItemIds = [
			36_038, 36_041, 36_059, 36_060, 36_061, 79_673, 79_674, 79_677, 79_679,
			89_002, 89_007, 89_065, 89_070, 89_071,
		];
		const capture = vi.fn(async () => ({ status: 'complete' as const, evidence: fixture.evidence, containerPrices: {
			version: INVENTORY_CONTAINER_PRICE_EVIDENCE_VERSION,
			accountId: fixture.evidence.accountId,
			snapshotId: fixture.evidence.snapshotId,
			schemaVersion: fixture.evidence.schemaVersion,
			capturedAt: '2026-08-16T05:22:30.000Z',
			source: 'gw2-commerce-prices' as const,
			requestedItemIds: expectedPriceItemIds,
			status: 'unavailable' as const,
			items: [],
			missingItemIds: expectedPriceItemIds,
		} }));
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture },
			preferences: EMPTY_INVENTORY_ADVISOR_PREFERENCES,
			rules: createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider),
			now: () => Date.parse('2026-08-16T05:23:00.000Z'),
		});
		const result = await workflow.refresh('es');
		expect(capture).toHaveBeenCalledOnce();
		expect(capture).toHaveBeenCalledWith('es', expectedPriceItemIds);
		expect(result.status).toBe('ready');
		if (result.status !== 'ready' || !('discardContext' in result.source)) throw new Error('Expected contextual workflow result.');
		expect(result.source.input).toMatchObject({ goals: [], keepExceptions: [] });
		const producerActions = result.source.discardContext.producerResult.report?.lines
			.flatMap((line) => line.decisions.map((decision) => decision.action)) ?? [];
		const finalActions = result.source.result.report?.lines
			.flatMap((line) => line.decisions.map((decision) => decision.action)) ?? [];
		expect(producerActions).toEqual(['keep']);
		expect(finalActions).toEqual(['keep']);
		expect(result.source.result.proofs).toEqual([]);
		const presentation = buildInventoryAdvisorPresentation(result.source);
		expect(presentation.status).toBe('ready');
		if (presentation.status !== 'ready') throw new Error('Expected ready no-action presentation.');
		expect(presentation.discardReview).toEqual({ status: 'unavailable' });
		expect(presentation.groups.flatMap((group) => group.rows.map((row) => row.action))).toEqual(['keep']);
		expect(JSON.stringify(presentation)).not.toMatch(/"(?:sell|list|vendor|salvage|use|open|discard_review|discard_candidate)"/u);
	});

	it('fails closed at built-in bundle expiry before capture or preference I/O', async () => {
		const capture = vi.fn();
		const preferences = vi.fn();
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture },
			preferences: { load: preferences },
			rules: createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider),
		now: () => Date.parse('2026-11-12T18:04:33.000Z'),
		});
		await expect(workflow.refresh('en')).resolves.toEqual({ status: 'blocked', reason: 'missing_rules' });
		expect(capture).not.toHaveBeenCalled();
		expect(preferences).not.toHaveBeenCalled();
	});

	it('composes one real capture through H4.15, H4.16 contextual proof and final presentation with empty H5.12 preferences', async () => {
		const fixture = reviewedDiscardFixture();
		const capture = vi.fn(async () => ({ status: 'complete' as const, evidence: fixture.evidence }));
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture },
			preferences: EMPTY_INVENTORY_ADVISOR_PREFERENCES,
			rules: { current: () => ({ status: 'available', value: fixture.rules }) },
			now: () => Date.parse('2026-08-14T12:00:00.000Z'),
		});
		const result = await workflow.refresh('es');
		expect(capture).toHaveBeenCalledOnce();
		expect(capture).toHaveBeenCalledWith('es');
		expect(result.status).toBe('ready');
		if (result.status !== 'ready' || !('discardContext' in result.source)) throw new Error('Expected contextual workflow result.');
		expect(result.source.input).toMatchObject({ goals: [], keepExceptions: [] });
		expect(result.source.discardContext.producerResult.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'keep' });
		expect(result.source.result.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'discard_candidate' });
		const proof = result.source.result.proofs[0];
		expect(proof).toMatchObject({ itemId: 10, discardRuleId: 'discard-10' });
		const presentation = buildInventoryAdvisorPresentation(result.source);
		expect(presentation).toMatchObject({
			status: 'ready', discardReview: { status: 'review_only', proofs: [proof] },
			groups: [{ group: 'review', rows: [{ action: 'discard_review', discardProof: proof }] }],
		});
		expect(JSON.stringify(presentation)).not.toContain('destroy');
	});

	it('loads preferences only after capture and reclassifies a fresh capture without a second API capture', async () => {
		const fixture = reviewedDiscardFixture();
		const capture = vi.fn(async () => ({ status: 'complete' as const, evidence: fixture.evidence }));
		const preferences = vi.fn(async () => ({ status: 'ready' as const, value: { goals: [], keepExceptions: [] } }));
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture }, preferences: { load: preferences }, rules: { current: () => ({ status: 'available', value: fixture.rules }) },
			now: () => Date.parse('2026-08-14T12:00:00.000Z'),
		});
		await expect(workflow.refresh('es')).resolves.toMatchObject({ status: 'ready' });
		await expect(workflow.reclassify()).resolves.toMatchObject({ status: 'ready' });
		expect(capture).toHaveBeenCalledOnce();
		expect(preferences).toHaveBeenCalledTimes(2);
		expect(preferences.mock.invocationCallOrder[0]).toBeGreaterThan(capture.mock.invocationCallOrder[0]!);
	});

	it('reads a newly saved personal overlay during in-memory reclassification without another capture', async () => {
		const fixture = reviewedDiscardFixture();
		rebaseEvidence(fixture.evidence, '2026-08-16T05:22:30.000Z');
		const loaded = inventoryAdvisorBuiltinBundleProvider.load('2026-08-16T05:23:00.000Z');
		if (loaded.status !== 'available') throw new Error('Expected built-in rules.');
		const expectedPriceItemIds = loaded.bundle.economyPack.expectedPriceItemIds;
		let overlay: ContainerPersonalValuationV1 = { version: 1, values: [] };
		const capture = vi.fn(async () => ({
			status: 'complete' as const,
			evidence: fixture.evidence,
			containerPrices: {
				version: INVENTORY_CONTAINER_PRICE_EVIDENCE_VERSION,
				accountId: fixture.evidence.accountId,
				snapshotId: fixture.evidence.snapshotId,
				schemaVersion: fixture.evidence.schemaVersion,
				capturedAt: '2026-08-16T05:22:30.000Z',
				source: 'gw2-commerce-prices' as const,
				requestedItemIds: structuredClone(expectedPriceItemIds),
				status: 'unavailable' as const,
				items: [],
				missingItemIds: structuredClone(expectedPriceItemIds),
			},
		}));
		const preferences = vi.fn(async () => ({ status: 'ready' as const, value: { goals: [], keepExceptions: [] } }));
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture }, preferences: { load: preferences },
			rules: createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider, () => overlay),
			now: () => Date.parse('2026-08-16T05:23:00.000Z'),
		});
		const first = await workflow.refresh('es');
		expect(first.status).toBe('ready');
		if (first.status !== 'ready' || !('discardContext' in first.source)) throw new Error('Expected contextual result.');
		expect(first.source.discardContext.engineInput.personalValuation).toEqual({ version: 1, values: [] });

		overlay = { version: 1, values: [{ outcomeKey: 'item:36031', unitCopper: 0, origin: 'manual' }] };
		const second = await workflow.reclassify();
		expect(second.status).toBe('ready');
		if (second.status !== 'ready' || !('discardContext' in second.source)) throw new Error('Expected contextual result.');
		expect(second.source.discardContext.engineInput.personalValuation).toEqual(overlay);
		expect(capture).toHaveBeenCalledOnce();
		expect(capture).toHaveBeenCalledWith('es', expectedPriceItemIds);
		expect(preferences).toHaveBeenCalledTimes(2);
	});

	it('invalidates stale retained evidence during reclassification rather than recapturing or composing defaults', async () => {
		const fixture = reviewedDiscardFixture();
		const capture = vi.fn(async () => ({ status: 'complete' as const, evidence: fixture.evidence }));
		const preferences = vi.fn(async () => ({ status: 'ready' as const, value: { goals: [], keepExceptions: [] } }));
		let now = Date.parse('2026-08-14T12:00:00.000Z');
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture }, preferences: { load: preferences }, rules: { current: () => ({ status: 'available', value: fixture.rules }) }, now: () => now,
		});
		await workflow.refresh('es');
		now += fixture.rules.policy.maxSnapshotAgeMs + 1;
		await expect(workflow.reclassify()).resolves.toEqual({ status: 'blocked', reason: 'stale_evidence' });
		expect(capture).toHaveBeenCalledOnce();
	});

	it('does not resurrect a captured account scope after invalidation while capture is pending', async () => {
		const fixture = reviewedDiscardFixture();
		const pending = deferred<{ status: 'complete'; evidence: InventoryAdvisorEvidenceV1 }>();
		const preferences = vi.fn(async () => ({ status: 'ready' as const, value: { goals: [], keepExceptions: [] } }));
		const workflow = new InventoryAdvisorWorkflow({
			capture: { capture: () => pending.promise }, preferences: { load: preferences },
			rules: { current: () => ({ status: 'available', value: fixture.rules }) }, now: () => Date.parse('2026-08-14T12:00:00.000Z'),
		});
		const refreshing = workflow.refresh('es');
		workflow.invalidate();
		pending.resolve({ status: 'complete', evidence: fixture.evidence });
		await expect(refreshing).resolves.toEqual({ status: 'blocked', reason: 'stale_evidence' });
		expect(preferences).not.toHaveBeenCalled();
		await expect(workflow.reclassify()).resolves.toEqual({ status: 'blocked', reason: 'stale_evidence' });
	});

	it('captures, classifies and reclassifies without reaching for a timer, network, storage or plugin global', async () => {
		const statuses: string[] = [];
		const used = await ambientCapabilityUse(async () => {
			const fixture = reviewedDiscardFixture();
			const workflow = new InventoryAdvisorWorkflow({
				capture: { capture: async () => ({ status: 'complete' as const, evidence: fixture.evidence }) },
				preferences: EMPTY_INVENTORY_ADVISOR_PREFERENCES,
				rules: { current: () => ({ status: 'available', value: fixture.rules }) },
				now: () => Date.parse('2026-08-14T12:00:00.000Z'),
			});
			statuses.push((await workflow.refresh('es')).status);
			statuses.push((await workflow.reclassify()).status);
			workflow.invalidate();
			statuses.push((await workflow.reclassify()).status);
		});
		expect(used).toEqual([]);
		expect(statuses).toEqual(['ready', 'ready', 'blocked']);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
	return { promise, resolve };
}

function reviewedDiscardFixture(): { evidence: InventoryAdvisorEvidenceV1; rules: InventoryAdvisorRules } {
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId: 10, quantity: 2, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }],
		currencies: [], availableByItem: { '10': 2 }, ownedByItem: { '10': 2 }, currencyById: {}, roster: [],
		coverage: completeSnapshotCoverage(), passCoverages: [completeSnapshotCoverage(), completeSnapshotCoverage()],
	};
	const rulePack = {
		schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		rules: [{ ruleId: 'discard-10', itemId: 10, action: 'discard_candidate' as const, status: 'approved' as const,
			assertion: 'applicable' as const, reason: 'curated_discard_review' as const, sourceIds: ['rule-source'] }],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledgePack: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z',
		reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '',
		sources: [{ id: 'knowledge-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [{ itemId: 10, use: notApplicable('use-none'), open: notApplicable('open-none'), salvage: notApplicable('salvage-none') }],
	};
	knowledgePack.sha256 = sha256InventoryKnowledgePack(knowledgePack);
	const catalog: CatalogResolution = {
		snapshotId: 'snapshot-1', locale: 'es' as const, schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z',
		items: { '10': { kind: 'item' as const, id: 10, name: 'No vendible', type: 'Trophy', rarity: 'Basic', level: 0,
			vendorValue: 0, flags: ['AccountBound', 'NoSell', 'NoSalvage'], gameTypes: [], restrictions: [] } },
		currencies: {}, materials: {}, warnings: [],
		coverage: { items: { '10': { status: 'resolved' as const, source: 'network' as const } }, currencies: {}, materials: {} },
	};
	const prices: InventoryPriceSnapshotV1 = {
		version: 1 as const, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z',
		source: 'gw2-commerce-prices' as const, schemaVersion: PINNED_SCHEMA, requestedItemIds: [10], status: 'complete' as const,
		items: [{ itemId: 10, whitelisted: false, bid: null, ask: null }], missingItemIds: [],
	};
	const accountSignals: AccountSignalsV1 = {
		version: 1 as const, source: 'gw2-account-api' as const, accountId: 'account-1',
		capturedAt: '2026-08-14T12:00:00.000Z', schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full' as const,
		endpointCoverage: { account: completeEndpoint(), recipes: completeEndpoint(), skins: completeEndpoint(), minis: completeEndpoint(), achievements: completeEndpoint() },
		unlockCoverage: 'complete' as const, unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
		achievementCoverage: 'complete' as const, completedAchievementBits: {}, achievementProgress: [],
	};
	const evidence: InventoryAdvisorEvidenceV1 = {
		version: 1, scope: 'supported_storage_v1', accountId: 'account-1', snapshotId: 'snapshot-1', schemaVersion: PINNED_SCHEMA,
		capturedAt: snapshot.completedAt, finishedAt: '2026-08-14T12:00:00.000Z', locale: 'es', snapshot,
		snapshotFingerprint: sha256CanonicalValue(snapshot),
		ttl: { snapshotMs: 900_000, catalogMs: 604_800_000, pricesMs: 900_000, accountSignalsMs: 86_400_000 },
		coverage: { snapshot: 'complete', catalog: 'complete', prices: 'complete', accountSignals: 'complete' },
		catalog, prices, accountSignals,
	};
	return { evidence, rules: { rulePack, knowledgePack, policy: {
		version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
		maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000,
		listingMinimumAdvantageBps: 1_000,
	} } };
}

function notApplicable(assertionId: string) {
	return { status: 'not_applicable' as const, assertionId, sourceIds: ['knowledge-source'] };
}

function completeEndpoint() {
	return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null };
}

function rebaseEvidence(evidence: InventoryAdvisorEvidenceV1, capturedAt: string): void {
	evidence.snapshot.startedAt = capturedAt;
	evidence.snapshot.completedAt = capturedAt;
	evidence.catalog.resolvedAt = capturedAt;
	evidence.prices.capturedAt = capturedAt;
	evidence.accountSignals.capturedAt = capturedAt;
	for (const endpoint of Object.values(evidence.accountSignals.endpointCoverage)) endpoint.capturedAt = capturedAt;
	evidence.capturedAt = capturedAt;
	evidence.finishedAt = capturedAt;
	evidence.snapshotFingerprint = sha256CanonicalValue(evidence.snapshot);
}

function completeSnapshotCoverage() {
	return { sources: {
		characters: { status: 'complete' as const }, shared_inventory: { status: 'complete' as const },
		bank: { status: 'complete' as const }, materials: { status: 'complete' as const },
		wallet: { status: 'complete' as const }, commerce_delivery: { status: 'complete' as const },
	}, characters: {} };
}

function diagnosticHarness(): {
	createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext;
	event(context: LocalDebugEventContext): void;
	events: LocalDebugEventContext[];
	created: number;
} {
	const harness = {
		events: [] as LocalDebugEventContext[],
		created: 0,
		createContext(context: LocalDebugActionContext): ResolvedLocalDebugActionContext {
			if (context.actionId === undefined) this.created += 1;
			const actionId = context.actionId ?? `generated-${this.created}`;
			return {
				...context, actionId,
				correlationId: context.correlationId ?? context.parent?.correlationId ?? context.parent?.actionId ?? actionId,
			};
		},
		event(context: LocalDebugEventContext): void { this.events.push(context); },
	};
	return harness;
}
