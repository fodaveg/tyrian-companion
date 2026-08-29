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
import {
	isInventoryContainerEconomyPack,
	isInventoryContainerPriceEvidence,
	sha256InventoryContainerEconomyPack,
	type InventoryContainerPriceEvidenceV1,
} from './inventory-container-economy';
import type { InventoryAdvisorInputV1 } from './inventory-advisor-model';

const BEFORE_EXPIRY = '2026-11-11T23:59:59.999Z';

describe('inventory advisor H4.18 built-in human-reviewed bundle', () => {
	it('loads the exact deterministic policy and source-backed curated packs', () => {
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		expect(result.status).toBe('available');
		if (result.status !== 'available') return;
		expect(result.bundle).toMatchObject({
			version: 3,
			policy: { version: 1, maxPriceAgeMs: 900_000, listingMinimumAdvantageBps: 1_000 },
			rulePack: {
				id: 'tc.inventory-rules.curated-v2', version: 2,
				reviewStatus: 'human_reviewed', reviewedAt: '2026-08-16T05:22:24.000Z',
				sha256: 'dd6c60dfe745e7914ddaf4e46ee21ef1a0d8b00d266ac79246283b62ec2e191c',
				rules: [{ ruleId: 'open-36038-capability-v1', recommendation: { status: 'enabled' } }],
			},
			knowledgePack: { id: 'tc.inventory-knowledge.curated-v2', version: 2 },
			economyPack: {
				packId: 'tc.inventory-container-economy.halloween-v1',
				activation: { status: 'enabled', activatedAt: '2026-08-16T05:22:24.000Z' },
				modelFingerprint: '7501839c02bbbcf5e07e6fe662d1ae3ceaf5e6b5a423f9d6a09432b1ab524fc1',
				expectedPriceItemIds: [36_038, 36_041, 36_059, 36_060, 36_061, 79_673, 79_677, 79_679, 89_002],
				policy: { openAdvantageBps: 1_000, saleBasis: 'immediate' },
				sha256: 'ba445d034b605d9c5db6219c1a8a689f334a62816aed75ba70b2f17d99dc0f5f',
			},
		});
		expect(result.bundle.rulePack.sources).toEqual(sources());
	});

	it('passes the authoritative validators and content hashes', () => {
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (result.status !== 'available') throw new Error('expected built-in bundle');
		expect(isInventoryAdvisorPolicy(result.bundle.policy)).toBe(true);
		expect(isInventoryAdvisorRulePackV2(result.bundle.rulePack)).toBe(true);
		expect(isInventoryAdvisorRulePackAny(result.bundle.rulePack)).toBe(true);
		expect(isInventoryKnowledgePack(result.bundle.knowledgePack)).toBe(true);
		expect(isInventoryContainerEconomyPack(result.bundle.economyPack)).toBe(true);
		expect(sha256InventoryRulePack(result.bundle.rulePack)).toBe(result.bundle.rulePack.sha256);
		expect(sha256InventoryKnowledgePack(result.bundle.knowledgePack)).toBe(result.bundle.knowledgePack.sha256);
		expect(sha256InventoryContainerEconomyPack(result.bundle.economyPack)).toBe(result.bundle.economyPack.sha256);
		expect(result.bundle.rulePack).toMatchObject({
			publishedAt: '2026-08-14T18:04:33.000Z', reviewedAt: '2026-08-16T05:22:24.000Z', reviewStatus: 'human_reviewed',
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

	it('keeps the activated capability under review when its economic evidence is absent', () => {
		const asOf = '2026-08-16T05:23:00.000Z';
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(asOf);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const input = advisorInput(loaded.bundle, asOf, 36038);
		expect(isInventoryAdvisorInput(input)).toBe(true);

		const engineInput = { input, knowledgePack: loaded.bundle.knowledgePack };
		const producerResult = classifyInventoryAdvisor(engineInput);
		expect(producerResult.status).toBe('ready');
		expect(isInventoryAdvisorResultForInput(producerResult, input, loaded.bundle.knowledgePack)).toBe(true);
		const producerDecisions = producerResult.report?.lines.flatMap((line) => line.decisions) ?? [];
		expect(producerDecisions.length).toBeGreaterThan(0);
		expect(producerDecisions).toEqual([expect.objectContaining({ action: 'review', ruleId: null })]);
		expect(producerResult.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'price_partial' }));

		const allowlistResult = applyInventoryDiscardAllowlist({ engineInput, producerResult });
		expect(allowlistResult.status).toBe('ready');
		expect(isInventoryDiscardAllowlistResultForInput(allowlistResult, { engineInput, producerResult })).toBe(true);
		const finalActions = allowlistResult.report?.lines.flatMap((line) => line.decisions.map((decision) => decision.action)) ?? [];
		expect(finalActions).toEqual(['review']);
		expect(finalActions).not.toContain('discard_candidate');
		expect(finalActions.some((action) => ['sell', 'list', 'vendor', 'salvage', 'use', 'open'].includes(action))).toBe(false);
	});

	it('does not let the curated pack hide independent market routes for other items', () => {
		const asOf = '2026-08-16T05:23:00.000Z';
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(asOf);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const input = advisorInput(loaded.bundle, asOf, 10);
		input.snapshot.quality = 'unstable';
		input.snapshot.passes = 1;
		input.snapshot.passCoverages = [input.snapshot.coverage];
		input.snapshot.holdings.push({
			kind: 'item', itemId: 11, quantity: 1, state: 'loose',
			location: { source: 'shared_inventory', slot: 1 }, metadata: {},
		});
		input.snapshot.availableByItem['11'] = 1;
		input.snapshot.ownedByItem['11'] = 1;
		input.catalog.items['11'] = {
			...input.catalog.items['10']!, id: 11, name: 'Objeto sin precio TP', vendorValue: 5,
		};
		input.catalog.coverage.items['11'] = { status: 'resolved', source: 'network' };
		input.prices.status = 'partial';
		input.prices.requestedItemIds = [10, 11];
		input.prices.missingItemIds = [11];

		const result = classifyInventoryAdvisor({ input, knowledgePack: loaded.bundle.knowledgePack });

		expect(result).toMatchObject({ status: 'limited' });
		expect(result.report?.lines.find((line) => line.itemId === 10)?.decisions[0])
			.toMatchObject({ action: 'list' });
		expect(result.report?.lines.find((line) => line.itemId === 11)?.decisions[0])
			.toMatchObject({ action: 'vendor' });
		expect(result.report?.lines.find((line) => line.itemId === 10)?.reasons)
			.toContainEqual(expect.objectContaining({ code: 'alternative_route_exists' }));
		expect(result.report?.lines.flatMap((line) => line.decisions)
			.every((decision) => decision.action !== 'review')).toBe(true);
		expect(isInventoryAdvisorResultForInput(result, input, loaded.bundle.knowledgePack)).toBe(true);
	});

	it('routes the human-enabled built-in through the H4.19 kernel and reproduces its result', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load('2026-08-16T05:23:00.000Z');
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const bundle = structuredClone(loaded.bundle);
		const input = advisorInput(bundle, '2026-08-16T05:23:00.000Z', 36_038);
		const prices: InventoryContainerPriceEvidenceV1 = {
			version: 1 as const,
			accountId: input.snapshot.accountId,
			snapshotId: input.snapshot.snapshotId,
			schemaVersion: PINNED_SCHEMA,
			capturedAt: '2026-08-16T05:22:30.000Z',
			source: 'gw2-commerce-prices' as const,
			requestedItemIds: structuredClone(bundle.economyPack.expectedPriceItemIds),
			status: 'complete' as const,
			items: bundle.economyPack.expectedPriceItemIds.map((itemId) => ({
				itemId, whitelisted: true,
				bid: { unitCopper: itemId === 36_038 ? 200 : 100, quantity: 1_000 }, ask: null,
			})),
			missingItemIds: [],
		};
		const engineInput = { input, knowledgePack: bundle.knowledgePack,
			containerEconomy: { pack: bundle.economyPack, prices } };
		const result = classifyInventoryAdvisor(engineInput);
		expect(result.report?.lines[0]?.decisions).toEqual([
			expect.objectContaining({ action: 'open', quantity: 2, ruleId: 'open-36038-capability-v1' }),
		]);
		expect(isInventoryAdvisorResultForInput(result, input, bundle.knowledgePack, engineInput.containerEconomy)).toBe(true);
		expect(isInventoryAdvisorResultForInput(result, input, bundle.knowledgePack)).toBe(false);
		const partialPersonalValuation = { version: 1 as const, values: [
			{ outcomeKey: 'item:36031', unitCopper: 0, origin: 'manual' as const },
		] };
		const personalResult = classifyInventoryAdvisor({ ...engineInput, personalValuation: partialPersonalValuation });
		expect(personalResult.report?.lines[0]?.decisions).toEqual([
			expect.objectContaining({ action: 'open', quantity: 2 }),
		]);
		expect(isInventoryAdvisorResultForInput(
			personalResult, input, bundle.knowledgePack, engineInput.containerEconomy, partialPersonalValuation,
		)).toBe(true);
		expect(classifyInventoryAdvisor({ ...engineInput, personalValuation: {
			version: 1, values: [{ outcomeKey: 'item:999999', unitCopper: 1, origin: 'manual' }],
		} })).toMatchObject({ status: 'invalid', report: null, envelope: null });
		for (const [action, sackBid, outcomeBid] of [
			['sell', 10_000, 1],
			['vendor', 1, 1],
		] as const) {
			const routed = structuredClone(engineInput);
			for (const item of routed.containerEconomy.prices.items) {
				item.bid!.unitCopper = item.itemId === 36_038 ? sackBid : outcomeBid;
			}
			const routedResult = classifyInventoryAdvisor(routed);
			expect(routedResult.report?.lines[0]?.decisions).toEqual([
				expect.objectContaining({ action, quantity: 2 }),
			]);
			expect(isInventoryAdvisorResultForInput(routedResult, input, bundle.knowledgePack,
				routed.containerEconomy)).toBe(true);
			expect(isInventoryAdvisorResultForInput(routedResult, input, bundle.knowledgePack)).toBe(false);
		}
		const revokedEconomy = structuredClone(engineInput.containerEconomy);
		revokedEconomy.pack.activation = { status: 'revoked', activatedAt: '2026-08-16T05:22:24.000Z' };
		revokedEconomy.pack.sha256 = sha256InventoryContainerEconomyPack(revokedEconomy.pack);
		expect(isInventoryAdvisorResultForInput(result, input, bundle.knowledgePack, revokedEconomy)).toBe(false);
		const revokedResult = classifyInventoryAdvisor({ ...engineInput, containerEconomy: revokedEconomy });
		expect(revokedResult.report?.lines[0]?.decisions).toEqual([expect.objectContaining({ action: 'review' })]);
		expect(isInventoryAdvisorResultForInput(revokedResult, input, bundle.knowledgePack, revokedEconomy)).toBe(true);
		const partial = structuredClone(engineInput);
		partial.containerEconomy.prices.status = 'partial';
		partial.containerEconomy.prices.missingItemIds = [89_002];
		partial.containerEconomy.prices.items.pop();
		expect(isInventoryContainerPriceEvidence(partial.containerEconomy.prices)).toBe(true);
		const reviewed = classifyInventoryAdvisor(partial);
		expect(reviewed.report?.lines[0]?.decisions).toEqual([expect.objectContaining({ action: 'review' })]);
		expect(reviewed.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'price_partial' }));
	});

	it('enforces V2 validUntil exclusively in classifier, result validation, and contextual discard', () => {
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const beforeExpiry = rebaseInput(advisorInput(loaded.bundle, '2026-11-12T18:04:32.999Z', 36038), '2026-11-12T18:04:32.999Z');
		const beforeEngine = { input: beforeExpiry, knowledgePack: loaded.bundle.knowledgePack };
		const beforeResult = classifyInventoryAdvisor(beforeEngine);
		expect(beforeResult.status).toBe('ready');
		expect(isInventoryAdvisorResultForInput(beforeResult, beforeExpiry, loaded.bundle.knowledgePack)).toBe(true);
		expect(applyInventoryDiscardAllowlist({ engineInput: beforeEngine, producerResult: beforeResult }).status).toBe('ready');

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
		const loaded = inventoryAdvisorBuiltinBundleProvider.load('2026-08-16T05:23:00.000Z');
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const bundle = structuredClone(loaded.bundle);
		bundle.rulePack.rules.push({ ...bundle.rulePack.rules[0]!, ruleId: 'open-36038-capability-duplicate-v1' });
		bundle.rulePack.rules.sort((left, right) => left.itemId - right.itemId || left.action.localeCompare(right.action) || left.ruleId.localeCompare(right.ruleId));
		bundle.rulePack.sha256 = sha256InventoryRulePack(bundle.rulePack);
		const input = advisorInput(bundle, '2026-08-16T05:23:00.000Z', 36038);
		const engineInput = { input, knowledgePack: bundle.knowledgePack };
		const producer = classifyInventoryAdvisor(engineInput);
		expect(producer.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'rule_conflict' }));
		expect(isInventoryAdvisorResultForInput(producer, input, bundle.knowledgePack)).toBe(true);
		const forged = structuredClone(producer);
		if (forged.status === 'invalid' || forged.report === null) throw new Error('expected contextual conflict result');
		forged.report.reasons = [{ code: 'economic_activation_pending', itemId: 36038, goalId: null, ruleId: null }];
		forged.report.lines[0]!.reasons = structuredClone(forged.report.reasons);
		forged.report.explanations[0]!.reasonCodes = ['economic_activation_pending'];
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
		expect(result.bundle.rulePack.sha256).toBe('dd6c60dfe745e7914ddaf4e46ee21ef1a0d8b00d266ac79246283b62ec2e191c');
		expect(result.bundle.knowledgePack.sha256).toBe('505dbf960ec582614b9ffcba5b8432d3da5f31666678c5bcd06840a1db8fc686');
	});

	it('treats human activation as inclusive and validUntil as exclusive', () => {
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-08-16T05:22:23.999Z')).toEqual({ status: 'unavailable', reason: 'invalid', bundle: null });
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-08-16T05:22:24.000Z').status).toBe('available');
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
		const approvalRemoved = structuredClone(loaded.bundle);
		approvalRemoved.rulePack.reviewStatus = 'pending_human_review';
		approvalRemoved.rulePack.reviewedAt = null;
		approvalRemoved.rulePack.rules[0]!.recommendation = {
			status: 'review_only', reason: 'economic_activation_pending',
		};
		approvalRemoved.rulePack.sha256 = sha256InventoryRulePack(approvalRemoved.rulePack);
		approvalRemoved.economyPack.rulePack.sha256 = approvalRemoved.rulePack.sha256;
		approvalRemoved.economyPack.activation = { status: 'pending_human_review', activatedAt: null };
		approvalRemoved.economyPack.sha256 = sha256InventoryContainerEconomyPack(approvalRemoved.economyPack);
		expect(createInventoryAdvisorBuiltinBundleProvider(approvalRemoved).load(BEFORE_EXPIRY)).toEqual({
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

function advisorInput(
	bundle: InventoryAdvisorBuiltinBundleV2,
	asOf: string,
	itemId = 10,
): InventoryAdvisorInputV1 {
	const capturedAt = asOf;
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
	const reason = { code: 'economic_activation_pending' as const, itemId: 36038, goalId: null, ruleId: null };
	forged.report.reasons = [reason];
	forged.report.lines[0]!.reasons = [reason];
	forged.report.explanations[0]!.reasonCodes = ['economic_activation_pending'];
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
