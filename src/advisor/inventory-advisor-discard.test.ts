import { describe, expect, it } from 'vitest';

import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { isInventoryAdvisorInput, sha256InventoryRulePack } from './inventory-advisor-contract';
import { classifyInventoryAdvisor, sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { applyInventoryDiscardAllowlist, isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';

describe('inventory discard allowlist H4.16', () => {
	it('converts only the reproduced no-supported-route producer result into a review-only candidate', () => {
		const engineInput = fixture();
		const producerResult = classifyInventoryAdvisor(engineInput);
		expect(producerResult).toMatchObject({ status: 'ready' });
		expect(producerResult.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'keep' });
		const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
		expect(result).toMatchObject({ status: 'ready', envelope: { execution: 'manual_in_game', sideEffects: 'none', requiresUserAction: true } });
		expect(result.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'discard_candidate', ruleId: 'discard-10', safety: 'irreversible_review_only' });
		expect(result.proofs).toHaveLength(1);
		expect(isInventoryDiscardAllowlistResultForInput(result, { engineInput, producerResult })).toBe(true);
		const presentation = buildInventoryAdvisorPresentation({
			input: engineInput.input, result, discardContext: { engineInput, producerResult },
		});
		expect(presentation).toMatchObject({
			status: 'ready', discardReview: { status: 'review_only', proofs: [{ discardRuleId: 'discard-10' }] },
			groups: [{ group: 'review', rows: [{ action: 'discard_review', irreversibleReviewOnly: true,
				discardProof: { discardRuleId: 'discard-10' }, value: { status: 'not_applicable', route: null } }] }],
		});
		expect(JSON.stringify(presentation)).not.toContain('destroy');
		const repeatedAssertions = structuredClone(result);
		if (repeatedAssertions.status !== 'invalid') repeatedAssertions.proofs[0]!.assertionIds.open = repeatedAssertions.proofs[0]!.assertionIds.use;
		expect(isInventoryDiscardAllowlistResultForInput(repeatedAssertions, { engineInput, producerResult })).toBe(false);
		const fakeSources = structuredClone(result);
		if (fakeSources.status !== 'invalid') fakeSources.proofs[0]!.assertionSourceIds.use = ['forged-source'];
		expect(isInventoryDiscardAllowlistResultForInput(fakeSources, { engineInput, producerResult })).toBe(false);
	});

	it('never mutates input or producer output and rejects a divergent producer result', () => {
		const engineInput = fixture(); const producerResult = classifyInventoryAdvisor(engineInput);
		const before = JSON.stringify({ engineInput, producerResult });
		applyInventoryDiscardAllowlist({ engineInput, producerResult });
		expect(JSON.stringify({ engineInput, producerResult })).toBe(before);
		const tampered = structuredClone(producerResult);
		if (tampered.report) tampered.report.lines[0]!.decisions[0]!.action = 'review';
		expect(applyInventoryDiscardAllowlist({ engineInput, producerResult: tampered }).status).toBe('invalid');
	});

	it('converts every no-supported-route slice of an eligible multi-position line exactly once', () => {
		const engineInput = fixture();
		engineInput.input.snapshot.holdings.push({ kind: 'item', itemId: 10, quantity: 1, state: 'loose', location: { source: 'materials', category: 1 }, metadata: {} });
		engineInput.input.snapshot.ownedByItem = { '10': 3 }; engineInput.input.snapshot.availableByItem = { '10': 3 };
		engineInput.input.prices.items[0] = { itemId: 10, whitelisted: false, bid: null, ask: null };
		const producerResult = classifyInventoryAdvisor(engineInput);
		const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
		expect(result.report?.lines[0]?.decisions).toHaveLength(2);
		expect(result.report?.lines[0]?.decisions.every((decision) => decision.action === 'discard_candidate')).toBe(true);
		expect(result.proofs).toHaveLength(2);
		expect(result.report?.lines[0]).toMatchObject({ retainedQuantity: 0, actionedQuantity: 3 });
	});

	it.each([
		['reservation', (value: InventoryAdvisorEngineInputV1) => { value.input.goals = [goal()]; }],
		['keep exception', (value: InventoryAdvisorEngineInputV1) => { value.input.keepExceptions = [{ version: 1, exceptionId: 'keep-10', itemId: 10, status: 'active', basis: 'available', quantity: { mode: 'minimum', value: 1 }, reason: 'user_keep' }]; }],
		['non-loose position', (value: InventoryAdvisorEngineInputV1) => { value.input.snapshot.holdings[0]!.state = 'pending_claim'; value.input.snapshot.holdings[0]!.location = { source: 'commerce_delivery', slot: 0 }; }],
		['delete warning', (value: InventoryAdvisorEngineInputV1) => { value.input.catalog.items['10']!.flags.push('DeleteWarning'); }],
		['applicable knowledge', (value: InventoryAdvisorEngineInputV1) => { value.knowledgePack.entries[0]!.use = { status: 'applicable', ruleId: 'use-10', sourceIds: ['knowledge-source'] }; value.input.rulePack.rules.unshift(rule('use-10', 'use', 'curated_use')); }],
		['duplicate discard rule', (value: InventoryAdvisorEngineInputV1) => { value.input.rulePack.rules.push(rule('discard-11', 'discard_candidate', 'curated_discard_review')); }],
	])('preserves keep when %s blocks the allowlist predicate', (_name, mutate) => {
		const engineInput = fixture(); mutate(engineInput); rehash(engineInput);
		if (_name === 'non-loose position') expect(isInventoryAdvisorInput(engineInput.input)).toBe(true);
		const producerResult = classifyInventoryAdvisor(engineInput);
		const result = applyInventoryDiscardAllowlist({ engineInput, producerResult });
		expect(result.status).not.toBe('invalid');
		expect(result.report?.lines[0]?.decisions.every((decision) => decision.action !== 'discard_candidate')).toBe(true);
	});

	it('fails closed for stale evidence, malformed sources, hostile proxies and invalid producer data', () => {
		const stale = fixture(); stale.input.prices.capturedAt = '2026-08-10T12:00:00.000Z';
		const staleProducer = classifyInventoryAdvisor(stale);
		expect(applyInventoryDiscardAllowlist({ engineInput: stale, producerResult: staleProducer }).status).not.toBe('ready');
		const badSources = fixture(); badSources.input.rulePack.rules[0]!.sourceIds = ['missing']; rehash(badSources);
		expect(applyInventoryDiscardAllowlist({ engineInput: badSources, producerResult: classifyInventoryAdvisor(badSources) }).status).toBe('invalid');
		const hostile = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
		expect(applyInventoryDiscardAllowlist(hostile).status).toBe('invalid');
	});
});

function fixture(): InventoryAdvisorEngineInputV1 {
	const snapshot: StorageSnapshot = { snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z', completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId: 10, quantity: 2, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }], currencies: [], availableByItem: { '10': 2 }, ownedByItem: { '10': 2 }, currencyById: {}, roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()] };
	const rulePack = { schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '', sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }], rules: [rule('discard-10', 'discard_candidate', 'curated_discard_review')] };
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledgePack: InventoryKnowledgePackV1 = { schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '', sources: [{ id: 'knowledge-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }], entries: [{ itemId: 10, use: notApplicable('use-none'), open: notApplicable('open-none'), salvage: notApplicable('salvage-none') }] };
	knowledgePack.sha256 = sha256InventoryKnowledgePack(knowledgePack);
	return { input: { version: 1, asOf: '2026-08-14T12:00:00.000Z', snapshot, catalog: { snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z', items: { '10': { kind: 'item', id: 10, name: 'No vendible', type: 'Trophy', rarity: 'Basic', level: 0, vendorValue: 0, flags: ['AccountBound', 'NoSell', 'NoSalvage'], gameTypes: [], restrictions: [] } }, currencies: {}, materials: {}, warnings: [], coverage: { items: { '10': { status: 'resolved', source: 'network' } }, currencies: {}, materials: {} } }, prices: { version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z', source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: [10], status: 'complete', items: [{ itemId: 10, whitelisted: false, bid: null, ask: null }], missingItemIds: [] }, goals: [], keepExceptions: [], accountSignals: { version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z', schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full', endpointCoverage: { account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence() }, unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [], achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [] }, rulePack, policy: { version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000, maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000, listingMinimumAdvantageBps: 1_000 } }, knowledgePack };
}
function rule(ruleId: string, action: 'use' | 'open' | 'salvage' | 'discard_candidate', reason: 'curated_use' | 'curated_open' | 'curated_salvage' | 'curated_discard_review') { return { ruleId, itemId: 10, action, status: 'approved' as const, assertion: 'applicable' as const, reason, sourceIds: ['rule-source'] }; }
function notApplicable(assertionId: string) { return { status: 'not_applicable' as const, assertionId, sourceIds: ['knowledge-source'] }; }
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
function coverage() { return { sources: { characters: { status: 'complete' as const }, shared_inventory: { status: 'complete' as const }, bank: { status: 'complete' as const }, materials: { status: 'complete' as const }, wallet: { status: 'complete' as const }, commerce_delivery: { status: 'complete' as const } }, characters: {} }; }
function goal() { return { schemaVersion: 1 as const, goalId: 'goal-10', title: 'Guardar', status: 'active' as const, priority: 1, reason: 'personal' as const, requirements: [{ key: 'item:10', namespace: 'item' as const, id: 10, targetQuantity: 1, creditedQuantity: 0, basis: 'available' as const, intendedUse: 'hold' as const }] }; }
function rehash(value: InventoryAdvisorEngineInputV1) { value.input.rulePack.rules.sort((left, right) => left.itemId - right.itemId || left.action.localeCompare(right.action) || left.ruleId.localeCompare(right.ruleId)); value.input.rulePack.sha256 = sha256InventoryRulePack(value.input.rulePack); value.knowledgePack.sha256 = sha256InventoryKnowledgePack(value.knowledgePack); }
