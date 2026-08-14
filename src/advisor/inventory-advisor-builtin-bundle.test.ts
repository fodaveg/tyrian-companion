import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type StorageSnapshot } from '../account/storage-snapshot-model';
import { createInventoryRecommendationEnvelope } from '../economy/inventory-recommendation-envelope';
import {
	createInventoryAdvisorBuiltinBundleProvider,
	inventoryAdvisorBuiltinBundleProvider,
	type InventoryAdvisorBuiltinBundleV2,
} from './inventory-advisor-builtin-bundle';
import {
	isInventoryAdvisorInput,
	isInventoryAdvisorPolicy,
	isInventoryAdvisorRulePackAny,
	isInventoryAdvisorRulePackV2,
	sha256StandardCanonicalValue,
	sha256InventoryRulePack,
} from './inventory-advisor-contract';
import {
	classifyInventoryAdvisor,
	isInventoryKnowledgePack,
	sha256InventoryKnowledgePack,
} from './inventory-advisor-classifier';
import { applyInventoryDiscardAllowlist, isInventoryDiscardAllowlistResultForInput } from './inventory-advisor-discard';
import { isInventoryAdvisorResultForInput } from './inventory-advisor-result';

const BEFORE_EXPIRY = '2026-11-11T23:59:59.999Z';

describe('inventory advisor H4.18 built-in curated review bundle', () => {
	it('loads the exact deterministic policy and source-backed curated packs', () => {
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		expect(result.status).toBe('available');
		if (result.status !== 'available') return;
		expect(result.bundle).toEqual({
			version: 2,
			policy: {
				version: 1,
				maxSnapshotAgeMs: 900_000,
				maxPriceAgeMs: 900_000,
				maxCatalogAgeMs: 604_800_000,
				maxAccountSignalsAgeMs: 86_400_000,
				maxRulePackAgeMs: 7_776_000_000,
				maxFutureSkewMs: 300_000,
				listingMinimumAdvantageBps: 1_000,
			},
			rulePack: {
				schemaVersion: 2,
				id: 'tc.inventory-rules.curated-v2',
				version: 2,
				publishedAt: '2026-08-14T18:04:33.000Z',
				reviewedAt: null,
				reviewStatus: 'pending_human_review',
				knowledgePackSha256: '505dbf960ec582614b9ffcba5b8432d3da5f31666678c5bcd06840a1db8fc686',
				validUntil: '2026-11-12T18:04:33.000Z',
				sha256: 'f5c82cb440b101497e52f078f4a5b00573cd1015b5b5d112989fa3e2869f1eff',
				sources: sources(),
				rules: [{ ruleId: 'open-36038-capability-v1', itemId: 36038, action: 'open', status: 'approved', capability: 'applicable',
					recommendation: { status: 'review_only', reason: 'economic_comparison_missing' }, reason: 'curated_open',
					sourceIds: ['gw2-api-item-36038', 'gw2-api-items-v2', 'gw2-wiki-trick-or-treat-bag'] }],
			},
			knowledgePack: {
				schemaVersion: 1,
				id: 'tc.inventory-knowledge.curated-v2',
				version: 2,
				publishedAt: '2026-08-14T18:04:33.000Z',
				reviewedAt: '2026-08-14T18:04:33.000Z',
				validUntil: '2026-11-12T18:04:33.000Z',
				sha256: '505dbf960ec582614b9ffcba5b8432d3da5f31666678c5bcd06840a1db8fc686',
				sources: sources(),
				entries: [{ itemId: 36038,
					use: { status: 'not_applicable', assertionId: 'use-excludes-open-v1', sourceIds: ['gw2-api-item-36038', 'gw2-wiki-trick-or-treat-bag'] },
					open: { status: 'applicable', ruleId: 'open-36038-capability-v1', sourceIds: ['gw2-api-item-36038', 'gw2-wiki-trick-or-treat-bag'] },
					salvage: { status: 'not_applicable', assertionId: 'no-salvage-36038-v1', sourceIds: ['gw2-api-item-36038', 'gw2-api-items-v2', 'gw2-wiki-trick-or-treat-bag'] },
				}],
			},
		});
	});

	it('passes the authoritative validators and content hashes', () => {
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (result.status !== 'available') throw new Error('expected built-in bundle');
		expect(isInventoryAdvisorPolicy(result.bundle.policy)).toBe(true);
		expect(isInventoryAdvisorRulePackV2(result.bundle.rulePack)).toBe(true);
		expect(isInventoryAdvisorRulePackAny(result.bundle.rulePack)).toBe(true);
		expect(isInventoryKnowledgePack(result.bundle.knowledgePack)).toBe(true);
		expect(sha256InventoryRulePack(result.bundle.rulePack)).toBe(result.bundle.rulePack.sha256);
		expect(sha256InventoryKnowledgePack(result.bundle.knowledgePack)).toBe(result.bundle.knowledgePack.sha256);
		expect(result.bundle.rulePack).toMatchObject({
			publishedAt: '2026-08-14T18:04:33.000Z', reviewedAt: null, reviewStatus: 'pending_human_review',
			validUntil: '2026-11-12T18:04:33.000Z',
		});
		expect(result.bundle.knowledgePack).toMatchObject({
			publishedAt: '2026-08-14T18:04:33.000Z', reviewedAt: '2026-08-14T18:04:33.000Z',
			validUntil: '2026-11-12T18:04:33.000Z',
		});
	});

	it('uses standard SHA-256 rather than a self-consistent local fingerprint', () => {
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (result.status !== 'available') throw new Error('expected built-in bundle');
		expect(sha256StandardCanonicalValue('abc')).toBe('6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25');
		const { sha256: _ignored, ...content } = result.bundle.rulePack;
		expect(sha256StandardCanonicalValue(content)).toBe(createHash('sha256').update(canonical(content)).digest('hex'));
	});

	it('keeps the curated open capability under review until its economic comparison exists', () => {
		const asOf = '2026-08-14T18:05:00.000Z';
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(asOf);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const input = advisorInput(loaded.bundle, asOf, 36038);
		expect(isInventoryAdvisorInput(input)).toBe(true);

		const engineInput = { input, knowledgePack: loaded.bundle.knowledgePack };
		const producerResult = classifyInventoryAdvisor(engineInput);
		expect(producerResult.status).toBe('limited');
		expect(isInventoryAdvisorResultForInput(producerResult, input, loaded.bundle.knowledgePack)).toBe(true);
		const producerDecisions = producerResult.report?.lines.flatMap((line) => line.decisions) ?? [];
		expect(producerDecisions.length).toBeGreaterThan(0);
		expect(producerDecisions).toEqual([expect.objectContaining({ action: 'review', ruleId: null })]);
		expect(producerResult.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'economic_comparison_missing' }));

		const allowlistResult = applyInventoryDiscardAllowlist({ engineInput, producerResult });
		expect(allowlistResult.status).toBe('limited');
		expect(isInventoryDiscardAllowlistResultForInput(allowlistResult, { engineInput, producerResult })).toBe(true);
		const finalActions = allowlistResult.report?.lines.flatMap((line) => line.decisions.map((decision) => decision.action)) ?? [];
		expect(finalActions).toEqual(['review']);
		expect(finalActions).not.toContain('discard_candidate');
		expect(finalActions.some((action) => ['sell', 'list', 'vendor', 'salvage', 'use', 'open'].includes(action))).toBe(false);
	});

	it('enforces V2 validUntil exclusively in classifier, result validation, and contextual discard', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const beforeExpiry = rebaseInput(advisorInput(loaded.bundle, '2026-11-12T18:04:32.999Z', 36038), '2026-11-12T18:04:32.999Z');
		const beforeEngine = { input: beforeExpiry, knowledgePack: loaded.bundle.knowledgePack };
		const beforeResult = classifyInventoryAdvisor(beforeEngine);
		expect(beforeResult.status).toBe('limited');
		expect(isInventoryAdvisorResultForInput(beforeResult, beforeExpiry, loaded.bundle.knowledgePack)).toBe(true);
		expect(applyInventoryDiscardAllowlist({ engineInput: beforeEngine, producerResult: beforeResult }).status).toBe('limited');

		const atExpiry = rebaseInput(advisorInput(loaded.bundle, '2026-11-12T18:04:33.000Z', 36038), '2026-11-12T18:04:33.000Z');
		const atExpiryEngine = { input: atExpiry, knowledgePack: loaded.bundle.knowledgePack };
		const rejectedByClassifier = classifyInventoryAdvisor(atExpiryEngine);
		expect(rejectedByClassifier.status).toBe('limited');
		expect(rejectedByClassifier.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'rule_stale' }));
		expect(isInventoryAdvisorResultForInput(rejectedByClassifier, atExpiry, loaded.bundle.knowledgePack)).toBe(true);
		const forgedAtExpiry = forgeEconomicReason(rejectedByClassifier);
		expect(isInventoryAdvisorResultForInput(forgedAtExpiry, atExpiry, loaded.bundle.knowledgePack)).toBe(false);
		expect(applyInventoryDiscardAllowlist({ engineInput: atExpiryEngine, producerResult: forgedAtExpiry }).status).toBe('invalid');
		const beforePublished = rebaseInput(advisorInput(loaded.bundle, '2026-08-14T18:04:32.999Z', 36038), '2026-08-14T18:04:32.999Z');
		const beforePublishedEngine = { input: beforePublished, knowledgePack: loaded.bundle.knowledgePack };
		const rejectedBeforePublished = classifyInventoryAdvisor(beforePublishedEngine);
		expect(rejectedBeforePublished.status).toBe('limited');
		expect(rejectedBeforePublished.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'rule_stale' }));
		expect(isInventoryAdvisorResultForInput(rejectedBeforePublished, beforePublished, loaded.bundle.knowledgePack)).toBe(true);
		const forgedBeforePublished = forgeEconomicReason(rejectedBeforePublished);
		expect(isInventoryAdvisorResultForInput(forgedBeforePublished, beforePublished, loaded.bundle.knowledgePack)).toBe(false);
		expect(applyInventoryDiscardAllowlist({ engineInput: beforePublishedEngine, producerResult: forgedBeforePublished }).status).toBe('invalid');
	});

	it('rejects a forged economic reason when duplicate V2 capabilities conflict', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load('2026-08-14T18:05:00.000Z');
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const bundle = structuredClone(loaded.bundle);
		bundle.rulePack.rules.push({ ...bundle.rulePack.rules[0]!, ruleId: 'open-36038-capability-duplicate-v1' });
		bundle.rulePack.rules.sort((left, right) => left.itemId - right.itemId || left.action.localeCompare(right.action) || left.ruleId.localeCompare(right.ruleId));
		bundle.rulePack.sha256 = sha256InventoryRulePack(bundle.rulePack);
		const input = advisorInput(bundle, '2026-08-14T18:05:00.000Z', 36038);
		const engineInput = { input, knowledgePack: bundle.knowledgePack };
		const producer = classifyInventoryAdvisor(engineInput);
		expect(producer.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'rule_conflict' }));
		expect(isInventoryAdvisorResultForInput(producer, input, bundle.knowledgePack)).toBe(true);
		const forged = structuredClone(producer);
		if (forged.status === 'invalid' || forged.report === null) throw new Error('expected contextual conflict result');
		forged.report.reasons = [{ code: 'economic_comparison_missing', itemId: 36038, goalId: null, ruleId: null }];
		forged.report.lines[0]!.reasons = structuredClone(forged.report.reasons);
		forged.report.explanations[0]!.reasonCodes = ['economic_comparison_missing'];
		const forgedEnvelope = createInventoryRecommendationEnvelope(forged.report);
		if (forgedEnvelope === null) throw new Error('expected forged envelope');
		forged.envelope = forgedEnvelope;
		expect(isInventoryAdvisorResultForInput(forged, input, bundle.knowledgePack)).toBe(false);
	});

	it('returns isolated clones and remains deterministic across providers', () => {
		const first = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		const second = createInventoryAdvisorBuiltinBundleProvider().load(BEFORE_EXPIRY);
		expect(second).toEqual(first);
		if (first.status !== 'available') throw new Error('expected built-in bundle');
		first.bundle.policy.maxSnapshotAgeMs = 1;
			first.bundle.rulePack.sources.push({ id: 'mutated', url: 'https://example.invalid', retrievedAt: '2026-08-14T18:04:33.000Z' });
		const reloaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		expect(reloaded.status).toBe('available');
		if (reloaded.status === 'available') {
			expect(reloaded.bundle.policy.maxSnapshotAgeMs).toBe(900_000);
			expect(reloaded.bundle.rulePack.sources).toEqual(sources());
		}
	});

	it('captures its source once and ignores later caller mutation', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const source = loaded.bundle;
		const expected = structuredClone(source);
		const provider = createInventoryAdvisorBuiltinBundleProvider(source);
		source.policy.maxRulePackAgeMs = 86_400_000;
		source.rulePack.id = 'mutated-after-create';
		source.knowledgePack.entries.push({ itemId: 10, use: null, open: null, salvage: null });
		expect(provider.load(BEFORE_EXPIRY)).toEqual({ status: 'available', bundle: expected });
	});

	it('rejects foreign packs even when their authoritative hashes and generic contracts are valid', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const foreign = structuredClone(loaded.bundle);
		foreign.rulePack.id = 'foreign.inventory-rules';
		foreign.rulePack.sha256 = sha256InventoryRulePack(foreign.rulePack);
		foreign.knowledgePack.id = 'foreign.inventory-knowledge';
		foreign.knowledgePack.sha256 = sha256InventoryKnowledgePack(foreign.knowledgePack);
		expect(isInventoryAdvisorRulePackV2(foreign.rulePack)).toBe(true);
		expect(isInventoryKnowledgePack(foreign.knowledgePack)).toBe(true);
		expect(createInventoryAdvisorBuiltinBundleProvider(foreign).load(BEFORE_EXPIRY)).toEqual({
			status: 'unavailable', reason: 'invalid', bundle: null,
		});
	});

	it.each(['es', 'en'])('is locale-neutral for %s', (locale) => {
		const result = createInventoryAdvisorBuiltinBundleProvider().load(BEFORE_EXPIRY);
		if (result.status !== 'available') throw new Error(`expected bundle for ${locale}`);
		expect(JSON.stringify(result.bundle)).not.toContain('locale');
		expect(result.bundle.rulePack.sha256).toBe('f5c82cb440b101497e52f078f4a5b00573cd1015b5b5d112989fa3e2869f1eff');
		expect(result.bundle.knowledgePack.sha256).toBe('505dbf960ec582614b9ffcba5b8432d3da5f31666678c5bcd06840a1db8fc686');
	});

	it('treats validUntil as an exclusive boundary and rejects invalid clocks', () => {
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-08-14T18:04:32.999Z')).toEqual({ status: 'unavailable', reason: 'invalid', bundle: null });
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-08-14T18:04:33.000Z').status).toBe('available');
		expect(inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY).status).toBe('available');
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-11-12T18:04:33.000Z')).toEqual({
			status: 'unavailable', reason: 'expired', bundle: null,
		});
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-11-12T18:04:33.001Z')).toEqual({
			status: 'unavailable', reason: 'expired', bundle: null,
		});
		expect(inventoryAdvisorBuiltinBundleProvider.load('not-a-date')).toEqual({
			status: 'unavailable', reason: 'invalid', bundle: null,
		});
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-11-11T23:59:59Z')).toEqual({
			status: 'unavailable', reason: 'invalid', bundle: null,
		});
	});

	it('fails closed for altered, extra-field and hostile sources without mutating them', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const alteredHash = structuredClone(loaded.bundle);
		alteredHash.rulePack.sha256 = '0'.repeat(64);
		expect(createInventoryAdvisorBuiltinBundleProvider(alteredHash).load(BEFORE_EXPIRY)).toEqual({
			status: 'unavailable', reason: 'invalid', bundle: null,
		});
		const extraField = { ...loaded.bundle, executor: 'forbidden' };
		expect(createInventoryAdvisorBuiltinBundleProvider(extraField).load(BEFORE_EXPIRY).status).toBe('unavailable');

		let writes = 0;
		const hostile = new Proxy({}, {
			get() { throw new Error('hostile get'); },
			ownKeys() { throw new Error('hostile ownKeys'); },
			set() { writes += 1; return false; },
		});
		expect(createInventoryAdvisorBuiltinBundleProvider(hostile).load(BEFORE_EXPIRY)).toEqual({
			status: 'unavailable', reason: 'invalid', bundle: null,
		});
		expect(writes).toBe(0);
	});

	it('never mutates a frozen valid source', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const source = deepFreeze(structuredClone(loaded.bundle));
		const before = JSON.stringify(source);
		expect(createInventoryAdvisorBuiltinBundleProvider(source).load(BEFORE_EXPIRY).status).toBe('available');
		expect(JSON.stringify(source)).toBe(before);
	});

	it('contains no execution, clock read, or I/O capability', () => {
		const source = readFileSync('src/advisor/inventory-advisor-builtin-bundle.ts', 'utf8');
		expect(source).not.toContain('free_to_play');
		expect(source).not.toContain('whitelist');
		expect(source).not.toContain('Date.now');
		expect(source).not.toMatch(/\b(?:fetch|requestUrl|XMLHttpRequest|WebSocket|destroyItem|deleteItem|salvageItem|openContainer)\b/u);
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		expect(JSON.stringify(result)).not.toMatch(/"(?:executor|execution|sideEffects|requiresUserAction)"/u);
	});
});

function deepFreeze<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

// Compile-time fixture: the public boundary returns data, not an execution interface.
const _bundleShape: InventoryAdvisorBuiltinBundleV2 | null = null;
void _bundleShape;

function advisorInput(bundle: InventoryAdvisorBuiltinBundleV2, asOf: string, itemId = 10) {
	const capturedAt = '2026-08-14T18:04:00.000Z';
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-builtin', accountId: 'account-builtin',
		startedAt: capturedAt, completedAt: capturedAt, schemaVersion: PINNED_SCHEMA,
		quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId, quantity: 2, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }],
		currencies: [], availableByItem: { [String(itemId)]: 2 }, ownedByItem: { [String(itemId)]: 2 }, currencyById: {}, roster: [],
		coverage: completeCoverage(), passCoverages: [completeCoverage(), completeCoverage()],
	};
	const endpoint = { status: 'complete' as const, capturedAt, reason: null };
	return {
		version: 1 as const, asOf, snapshot,
		catalog: {
			snapshotId: snapshot.snapshotId, locale: 'es' as const, schemaVersion: PINNED_SCHEMA, resolvedAt: capturedAt,
			items: { [String(itemId)]: { kind: 'item' as const, id: itemId, name: itemId === 36038 ? 'Trick-or-Treat Bag' : 'Objeto sin regla', type: itemId === 36038 ? 'Container' : 'Trophy', rarity: 'Basic', level: 0,
				vendorValue: 100, flags: itemId === 36038 ? ['NoSalvage', 'BulkConsume'] : [], gameTypes: [], restrictions: [] } },
			currencies: {}, materials: {}, warnings: [],
			coverage: { items: { [String(itemId)]: { status: 'resolved' as const, source: 'network' as const } }, currencies: {}, materials: {} },
		},
		prices: {
			version: 1 as const, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
			capturedAt, source: 'gw2-commerce-prices' as const, schemaVersion: PINNED_SCHEMA,
			requestedItemIds: [itemId], status: 'complete' as const,
			items: [{ itemId, whitelisted: true, bid: { unitCopper: 200, quantity: 2 }, ask: { unitCopper: 250, quantity: 2 } }],
			missingItemIds: [],
		},
		goals: [], keepExceptions: [],
		accountSignals: {
			version: 1 as const, source: 'gw2-account-api' as const, accountId: snapshot.accountId, capturedAt,
			schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full' as const,
			endpointCoverage: { account: endpoint, recipes: endpoint, skins: endpoint, minis: endpoint, achievements: endpoint },
			unlockCoverage: 'complete' as const, unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
			achievementCoverage: 'complete' as const, completedAchievementBits: {}, achievementProgress: [],
		},
		rulePack: bundle.rulePack, policy: bundle.policy,
	};
}

function sources() {
	return [
		{ id: 'gw2-api-item-36038', url: 'https://api.guildwars2.com/v2/items/36038?lang=en', retrievedAt: '2026-08-14T18:04:33.000Z' },
		{ id: 'gw2-api-items-v2', url: 'https://wiki.guildwars2.com/index.php?title=API:2/items&oldid=3009031', retrievedAt: '2026-08-14T18:04:33.000Z' },
		{ id: 'gw2-wiki-trick-or-treat-bag', url: 'https://wiki.guildwars2.com/index.php?title=Trick-or-Treat_Bag&oldid=3071874', retrievedAt: '2026-08-14T18:04:33.000Z' },
	];
}

function rebaseInput<T extends ReturnType<typeof advisorInput>>(input: T, asOf: string): T {
	const rebased = structuredClone(input);
	rebased.snapshot.startedAt = asOf; rebased.snapshot.completedAt = asOf;
	rebased.catalog.resolvedAt = asOf; rebased.prices.capturedAt = asOf;
	rebased.accountSignals.capturedAt = asOf;
	for (const endpoint of Object.values(rebased.accountSignals.endpointCoverage)) endpoint.capturedAt = asOf;
	return rebased;
}

function forgeEconomicReason<T extends ReturnType<typeof classifyInventoryAdvisor>>(result: T): T {
	const forged = structuredClone(result);
	if (forged.status === 'invalid' || forged.report === null) throw new Error('expected contextual stale result');
	const reason = { code: 'economic_comparison_missing' as const, itemId: 36038, goalId: null, ruleId: null };
	forged.report.reasons = [reason];
	forged.report.lines[0]!.reasons = [reason];
	forged.report.explanations[0]!.reasonCodes = ['economic_comparison_missing'];
	const envelope = createInventoryRecommendationEnvelope(forged.report);
	if (envelope === null) throw new Error('expected forged envelope');
	forged.envelope = envelope;
	return forged;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}

function completeCoverage() {
	return { sources: {
		characters: { status: 'complete' as const }, shared_inventory: { status: 'complete' as const },
		bank: { status: 'complete' as const }, materials: { status: 'complete' as const },
		wallet: { status: 'complete' as const }, commerce_delivery: { status: 'complete' as const },
	}, characters: {} };
}
