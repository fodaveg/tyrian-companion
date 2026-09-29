import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import { classifyInventoryAdvisor, sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256InventoryRulePack, validDecisionAgainstInput, validDecisionAgainstValidatedInput } from './inventory-advisor-contract';
import { isInventoryAdvisorResultForInput } from './inventory-advisor-result';

/**
 * Regression for the 29 sep 2026 freeze: on David's real account (1230 lines, 1632 decisions) the
 * classification phase blocked Obsidian's renderer for 453 s. 95 % of it was
 * `isInventoryAdvisorResultForInput` re-validating the WHOLE input (catalog, signals and a canonical
 * JSON round trip of several MB) once per sell/list/vendor decision, through
 * `validDecisionAgainstInput`: O(decisions × input size). The result contract now validates the
 * input once and checks each decision against the already-validated input.
 *
 * The threshold is deliberately loose (the same fixture cost 10-20 s before the fix on this
 * machine, and well under a second after it), so it separates the complexity classes rather than
 * timing a machine.
 */
describe('inventory advisor result validation scales with the account', () => {
	it('validates one large classification in bounded time', () => {
		const engineInput = largeMarketFixture(600);
		const startedAt = performance.now();
		const result = classifyInventoryAdvisor(engineInput);
		const elapsedMs = performance.now() - startedAt;
		expect(result.status).toBe('ready');
		expect(result.report?.lines.length).toBe(600);
		expect(result.envelope?.decisions.filter((decision) => decision.action === 'sell').length).toBe(600);
		expect(isInventoryAdvisorResultForInput(result, engineInput.input, engineInput.knowledgePack)).toBe(true);
		expect(elapsedMs).toBeLessThan(4_000);
	});

	it('keeps the public per-decision check equal to the validated-input one', () => {
		const engineInput = largeMarketFixture(3);
		const result = classifyInventoryAdvisor(engineInput);
		const decision = result.envelope!.decisions[0]!;
		expect(validDecisionAgainstValidatedInput(engineInput.input, decision)).toBe(true);
		expect(validDecisionAgainstInput(engineInput.input, decision)).toBe(true);
		const stale = { ...engineInput.input, catalog: { ...engineInput.input.catalog, coverage: {
			...engineInput.input.catalog.coverage,
			items: { ...engineInput.input.catalog.coverage.items, '10': { status: 'resolved' as const, source: 'cache_stale' as const } },
		} } };
		expect(validDecisionAgainstValidatedInput(stale, decision)).toBe(false);
		expect(validDecisionAgainstInput(stale, decision)).toBe(false);
		// The public check still refuses an input it cannot validate; the validated variant trusts its caller.
		expect(validDecisionAgainstInput({ ...engineInput.input, version: 2 }, decision)).toBe(false);
	});
});

/** `count` distinct items, one loose bank stack each, every one priced so the classifier sells it. */
function largeMarketFixture(count: number): InventoryAdvisorEngineInputV1 {
	const itemIds = Array.from({ length: count }, (_, index) => 10 + index);
	const holdings: StorageSnapshot['holdings'] = itemIds.map((itemId, slot) => ({
		kind: 'item', itemId, quantity: 1, state: 'loose', location: { source: 'bank', slot }, metadata: {},
	}));
	const quantities = Object.fromEntries(itemIds.map((itemId) => [String(itemId), 1]));
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z',
		completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings, currencies: [], availableByItem: { ...quantities }, ownedByItem: { ...quantities }, currencyById: {},
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

function coverage(): SnapshotCoverage {
	return { sources: {
		characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' },
		materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' },
	}, characters: {} };
}
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
