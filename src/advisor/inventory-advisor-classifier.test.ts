import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import {
	classifyInventoryAdvisor, isInventoryAdvisorEngineResult,
	isInventoryKnowledgePack, sha256InventoryKnowledgePack,
} from './inventory-advisor-classifier';
import type {
	InventoryAdvisorEngineInputV1,
	InventoryAdvisorEngineResultV1,
	InventoryKnowledgePackV1,
} from './inventory-advisor-classifier-model';
import { isInventoryAdvisorInput, sha256InventoryRulePack } from './inventory-advisor-contract';
import { isInventoryAdvisorResultForInput } from './inventory-advisor-result';
import { createInventoryRecommendationEnvelope } from '../economy/inventory-recommendation-envelope';
import { EQUIPMENT_SALVAGE_POLICY_V1 } from '../economy/models/equipment-salvage-policy';
import { isEquipmentSalvagePolicy, isEquipmentSalvagePreferences } from '../economy/equipment-salvage-economy';
import { isInventoryContainerPriceEvidence } from './inventory-container-economy';

describe('H4.15 inventory advisor classifier', () => {
	it('partitions every owned loose position into a manual market decision', () => {
		const input = fixture();
		const result = classifyInventoryAdvisor(input);
		expect(result).toMatchObject({ status: 'ready', envelope: { execution: 'manual_in_game', sideEffects: 'none', requiresUserAction: true } });
		expect(result.report?.lines[0]?.decisions).toMatchObject([{ action: 'sell', quantity: 2, allocations: [{ positionRef: '#/positions/10/0', quantity: 2 }] }]);
		expect(isInventoryAdvisorResultForInput(result, input.input)).toBe(true);
	});

	it('keeps scoped inventory recommendations visible when optional account stores are skipped', () => {
		const stable = scopedInventoryFixture('stable');
		const stableResult = classifyInventoryAdvisor(stable);
		expect(stableResult).toMatchObject({ status: 'ready' });
		expect(stableResult.report?.lines[0]).toMatchObject({
			coverage: { snapshot: 'complete' },
			decisions: [{ action: 'sell', quantity: 2 }],
		});

		const changing = scopedInventoryFixture('unstable');
		expect(isInventoryAdvisorInput(changing.input)).toBe(true);
		const changingResult = classifyInventoryAdvisor(changing);
		expect(changingResult).toMatchObject({ status: 'limited' });
		expect(changingResult.report?.lines[0]).toMatchObject({
			coverage: { snapshot: 'limited' },
			decisions: [{ action: 'sell', quantity: 2 }],
		});
		expect(changingResult.report?.lines[0]?.decisions.every((decision) => decision.action !== 'review')).toBe(true);
		expect(isInventoryAdvisorResultForInput(changingResult, changing.input)).toBe(true);
	});

	it('classifies each item independently when the commerce batch is partial', () => {
		const partial = scopedInventoryFixture('unstable');
		partial.input.snapshot.holdings.push({
			kind: 'item', itemId: 11, quantity: 1, state: 'loose',
			location: { source: 'shared_inventory', slot: 1 }, metadata: {},
		});
		partial.input.snapshot.availableByItem = { '10': 2, '11': 1 };
		partial.input.snapshot.ownedByItem = { '10': 2, '11': 1 };
		partial.input.catalog.items['11'] = {
			...partial.input.catalog.items['10']!, id: 11, name: 'Item sin precio TP', vendorValue: 5,
		};
		partial.input.catalog.coverage.items['11'] = { status: 'resolved', source: 'network' };
		partial.input.prices = {
			...partial.input.prices,
			status: 'partial',
			requestedItemIds: [10, 11],
			missingItemIds: [11],
		};

		const result = classifyInventoryAdvisor(partial);

		expect(result).toMatchObject({ status: 'limited' });
		expect(result.report?.lines.find((line) => line.itemId === 10)?.decisions[0])
			.toMatchObject({ action: 'sell' });
		expect(result.report?.lines.find((line) => line.itemId === 11)?.decisions[0])
			.toMatchObject({ action: 'vendor' });
		expect(isInventoryAdvisorResultForInput(result, partial.input)).toBe(true);
	});

	it('keeps curated irreversible routes in review when scoped quantities are still changing', () => {
		const changing = scopedInventoryFixture('unstable');
		changing.input.rulePack.rules = [rule('use-10', 'approved')];
		changing.input.rulePack.sha256 = sha256InventoryRulePack(changing.input.rulePack);
		changing.knowledgePack.entries[0]!.use = {
			status: 'applicable', ruleId: 'use-10', sourceIds: ['source'],
		};
		changing.knowledgePack.sha256 = sha256InventoryKnowledgePack(changing.knowledgePack);

		const result = classifyInventoryAdvisor(changing);
		expect(result).toMatchObject({ status: 'limited' });
		expect(result.report?.lines[0]?.decisions).toEqual([
			expect.objectContaining({ action: 'review', quantity: 2 }),
		]);
		expect(result.report?.lines.flatMap((line) => line.decisions)
			.some((decision) => decision.action === 'use')).toBe(false);
	});

	it('uses the independently validated manual market route when curation is absent and still reviews non-loose positions', () => {
		const input = fixture();
		input.knowledgePack.entries = [];
		input.knowledgePack.sha256 = sha256InventoryKnowledgePack(input.knowledgePack);
		const missing = classifyInventoryAdvisor(input);
		expect(missing.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'sell' });
		expect(missing.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'alternative_route_exists' }));
		expect(isInventoryAdvisorResultForInput(missing, input.input)).toBe(true);
		const omittedCuratedKnowledge = fixture();
		omittedCuratedKnowledge.input.rulePack.rules = [rule('use-10', 'approved')];
		omittedCuratedKnowledge.input.rulePack.sha256 = sha256InventoryRulePack(omittedCuratedKnowledge.input.rulePack);
		omittedCuratedKnowledge.knowledgePack.entries = [];
		omittedCuratedKnowledge.knowledgePack.sha256 = sha256InventoryKnowledgePack(omittedCuratedKnowledge.knowledgePack);
		const omittedResult = classifyInventoryAdvisor(omittedCuratedKnowledge);
		expect(omittedResult.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'review' });
		expect(omittedResult.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'rule_missing' }));
		const embedded = fixture();
		embedded.input.snapshot.holdings[0] = {
			...embedded.input.snapshot.holdings[0]!, quantity: 1, state: 'embedded_upgrade',
			parentItemId: 11, embeddedKind: 'upgrade',
		};
		embedded.input.snapshot.holdings.push({
			kind: 'item', itemId: 11, quantity: 1, state: 'loose',
			location: { source: 'bank', slot: 0 }, metadata: {},
		});
		embedded.input.snapshot.availableByItem = { '11': 1 };
		embedded.input.snapshot.ownedByItem = { '10': 1, '11': 1 };
		embedded.input.catalog.items['11'] = { ...embedded.input.catalog.items['10']!, id: 11, name: 'Parent' };
		embedded.input.catalog.coverage.items['11'] = { status: 'resolved', source: 'network' };
		embedded.input.prices = {
			...embedded.input.prices, requestedItemIds: [11], items: [{ itemId: 11, whitelisted: true, bid: null, ask: null }],
		};
		const reviewed = classifyInventoryAdvisor(embedded);
		expect(reviewed.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'review' });
	});

	it('rejects forged output and never emits discard_candidate', () => {
		const input = fixture(); const result = classifyInventoryAdvisor(input);
		expect(isInventoryAdvisorResultForInput({ ...result, status: 'limited' }, input.input)).toBe(false);
		expect(JSON.stringify(result)).not.toContain('discard_candidate');
	});

	it('rejects action and reason tampering even after the public envelope is regenerated', () => {
		const value = fixture();
		const result = classifyInventoryAdvisor(value);
		if (result.status === 'invalid') throw new Error('Expected classifier result.');
		const actionTamper = structuredClone(result);
		actionTamper.report.lines[0]!.decisions[0]!.action = 'list';
		actionTamper.report.explanations[0]!.action = 'list';
		const actionEnvelope = createInventoryRecommendationEnvelope(actionTamper.report);
		expect(actionEnvelope).not.toBeNull();
		if (actionEnvelope === null) throw new Error('Expected envelope.');
		actionTamper.envelope = actionEnvelope;
		expect(isInventoryAdvisorResultForInput(actionTamper, value.input)).toBe(false);

		const reasonTamper = structuredClone(result);
		reasonTamper.report.lines[0]!.reasons[0]!.code = 'no_sell';
		reasonTamper.report.reasons[0]!.code = 'no_sell';
		reasonTamper.report.explanations[0]!.reasonCodes = ['no_sell'];
		const reasonEnvelope = createInventoryRecommendationEnvelope(reasonTamper.report);
		expect(reasonEnvelope).not.toBeNull();
		if (reasonEnvelope === null) throw new Error('Expected envelope.');
		reasonTamper.envelope = reasonEnvelope;
		expect(isInventoryAdvisorResultForInput(reasonTamper, value.input)).toBe(false);

		const emptyReasonTamper = structuredClone(result);
		emptyReasonTamper.report.lines[0]!.decisions[0]!.action = 'list';
		emptyReasonTamper.report.explanations[0]!.action = 'list';
		emptyReasonTamper.report.lines[0]!.reasons = [];
		emptyReasonTamper.report.reasons = [];
		emptyReasonTamper.report.explanations[0]!.reasonCodes = [];
		const emptyEnvelope = createInventoryRecommendationEnvelope(emptyReasonTamper.report);
		expect(emptyEnvelope).not.toBeNull();
		if (emptyEnvelope === null) throw new Error('Expected envelope.');
		emptyReasonTamper.envelope = emptyEnvelope;
		expect(isInventoryAdvisorResultForInput(emptyReasonTamper, value.input)).toBe(false);
	});

	it('splits a physical stack at the demonstrated bid depth and classifies excess conservatively', () => {
		const value = fixture();
		value.input.snapshot.holdings[0]!.quantity = 3;
		value.input.snapshot.availableByItem = { '10': 3 };
		value.input.snapshot.ownedByItem = { '10': 3 };
		value.input.prices.items[0] = { itemId: 10, whitelisted: true, bid: { unitCopper: 20, quantity: 1 }, ask: null };
		const result = classifyInventoryAdvisor(value);
		expect(result.status).not.toBe('invalid');
		if (result.status === 'invalid') throw new Error('Expected valid classifier result.');
		const line = result.report.lines[0]!;
		expect(line.decisions).toMatchObject([
			{ action: 'sell', quantity: 1, allocations: [{ positionRef: '#/positions/10/0', quantity: 1 }] },
			{ action: 'vendor', quantity: 2, allocations: [{ positionRef: '#/positions/10/0', quantity: 2 }] },
		]);
	});

	it('uses full buy depth for instant sale and never treats sell listings as buyer capacity', () => {
		const full = marketDepthFixture(4);
		full.marketDepth = depth([
			{ unitCopper: 100, quantity: 2 }, { unitCopper: 90, quantity: 2 },
		], [{ unitCopper: 101, quantity: 1 }]);
		expect(classifyInventoryAdvisor(full).report?.lines[0]?.decisions).toMatchObject([
			{ action: 'sell', quantity: 4 },
		]);

		const insufficient = marketDepthFixture(4);
		insufficient.marketDepth = depth([{ unitCopper: 100, quantity: 2 }], [{ unitCopper: 101, quantity: 1 }]);
		expect(classifyInventoryAdvisor(insufficient).report?.lines[0]?.decisions).toMatchObject([
			{ action: 'list', quantity: 4 },
		]);
	});

	it.each(['unavailable', 'invalid'] as const)(
		'keeps the legacy prices route but limits the result when requested depth is %s',
		(itemCoverage) => {
			const legacy = marketDepthFixture(4);
			legacy.input.prices.items[0] = { itemId: 10, whitelisted: true,
				bid: { unitCopper: 100, quantity: 2 }, ask: { unitCopper: 120, quantity: 1 } };
			const expected = classifyInventoryAdvisor(legacy);
			expect(expected.status).toBe('ready');
			if (expected.status === 'invalid') throw new Error('Expected legacy result.');

			const withFailedDepth = structuredClone(legacy);
			withFailedDepth.marketDepth = {
				...depth([], []), status: 'unavailable',
				items: [{ itemId: 10, coverage: itemCoverage, buys: [], sells: [] }],
			};
			const result = classifyInventoryAdvisor(withFailedDepth);
			expect(result.status).toBe('limited');
			if (result.status === 'invalid') throw new Error('Expected limited result.');
			expect(result.report.coverage).toBe('limited');
			expect(result.report.lines[0]?.decisions.map(({ action, quantity }) => ({ action, quantity })))
				.toEqual(expected.report.lines[0]?.decisions.map(({ action, quantity }) => ({ action, quantity })));
		});

	it('does not let unavailable market depth change a curated non-economic action', () => {
		const input = marketDepthFixture(2);
		input.input.rulePack.rules = [rule('use-10', 'approved')];
		input.input.rulePack.sha256 = sha256InventoryRulePack(input.input.rulePack);
		input.knowledgePack.entries[0]!.use = { status: 'applicable', ruleId: 'use-10', sourceIds: ['source'] };
		input.knowledgePack.sha256 = sha256InventoryKnowledgePack(input.knowledgePack);
		input.marketDepth = { ...depth([], []), status: 'unavailable', items: [
			{ itemId: 10, coverage: 'unavailable', buys: [], sells: [] },
		] };
		expect(classifyInventoryAdvisor(input).report?.lines[0]?.decisions[0]).toMatchObject({ action: 'use' });
	});

	it('uses top-bid depth globally across two positions and observes free-to-play whitelisting', () => {
		const split = fixture();
		split.input.snapshot.holdings[0]!.quantity = 1;
		split.input.snapshot.holdings.push({ kind: 'item', itemId: 10, quantity: 1, state: 'loose', location: { source: 'bank', slot: 1 }, metadata: {} });
		split.input.snapshot.availableByItem = { '10': 2 };
		split.input.snapshot.ownedByItem = { '10': 2 };
		split.input.prices.items[0] = { itemId: 10, whitelisted: true, bid: { unitCopper: 20, quantity: 1 }, ask: null };
		const actions = classifyInventoryAdvisor(split).report?.lines[0]?.decisions ?? [];
		expect(actions.filter((decision) => decision.action === 'sell')).toHaveLength(1);
		expect(actions.filter((decision) => decision.action === 'vendor')).toHaveLength(1);

		const f2p = fixture();
		f2p.input.accountSignals.tradingPostAccess = 'free_to_play';
		f2p.input.prices.items[0]!.whitelisted = false;
		expect(classifyInventoryAdvisor(f2p).report?.lines[0]?.decisions[0]).toMatchObject({ action: 'vendor' });
		f2p.input.prices.items[0]!.whitelisted = true;
		expect(classifyInventoryAdvisor(f2p).report?.lines[0]?.decisions[0]?.action).not.toBe('review');
	});

	it('keeps independent market routes visible while stale rules still block applicable curated routes', () => {
		const market = fixture();
		market.input.prices.items[0] = { itemId: 10, whitelisted: true, bid: { unitCopper: 100, quantity: 2 }, ask: { unitCopper: 105, quantity: 2 } };
		expect(classifyInventoryAdvisor(market).report?.lines[0]?.decisions[0]).toMatchObject({ action: 'sell' });

		const staleRules = fixture();
		staleRules.input.rulePack = { ...staleRules.input.rulePack, publishedAt: '2025-01-01T00:00:00.000Z', reviewedAt: '2025-01-02T00:00:00.000Z' };
		staleRules.input.rulePack.sha256 = sha256InventoryRulePack(staleRules.input.rulePack);
		const result = classifyInventoryAdvisor(staleRules);
		expect(result).toMatchObject({ status: 'limited' });
		expect(result.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'sell' });

		const curatedStale = fixture();
		const curatedStalePack = curatedStale.input.rulePack;
		if (curatedStalePack.schemaVersion !== 1) throw new Error('expected V1 fixture');
		curatedStalePack.publishedAt = '2025-01-01T00:00:00.000Z';
		curatedStalePack.reviewedAt = '2025-01-02T00:00:00.000Z';
		curatedStalePack.rules = [rule('use-10', 'approved')];
		curatedStalePack.sha256 = sha256InventoryRulePack(curatedStalePack);
		curatedStale.knowledgePack.entries[0]!.use = {
			status: 'applicable', ruleId: 'use-10', sourceIds: ['source'],
		};
		curatedStale.knowledgePack.sha256 = sha256InventoryKnowledgePack(curatedStale.knowledgePack);
		const curatedResult = classifyInventoryAdvisor(curatedStale);
		expect(curatedResult.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'review' });
		expect(curatedResult.report?.lines[0]?.reasons)
			.toContainEqual(expect.objectContaining({ code: 'rule_stale' }));
	});

	it('suppresses only the market recommendation corresponding to an active order side', () => {
		const selling = fixture();
		selling.activeOrders = activeOrders([
			{ side: 'sell', itemId: 10, quantity: 2 },
		]);
		expect(classifyInventoryAdvisor(selling).report?.lines[0]?.decisions[0])
			.toMatchObject({ action: 'sell' });
		selling.activeOrders = activeOrders([
			{ side: 'buy', itemId: 10, quantity: 2 },
		]);
		expect(classifyInventoryAdvisor(selling).report?.lines[0]?.decisions[0])
			.toMatchObject({ action: 'review' });

		const listing = fixture();
		listing.input.prices.items[0] = {
			itemId: 10, whitelisted: true, bid: null, ask: { unitCopper: 21, quantity: 2 },
		};
		listing.activeOrders = activeOrders([
			{ side: 'buy', itemId: 10, quantity: 2 },
		]);
		expect(classifyInventoryAdvisor(listing).report?.lines[0]?.decisions[0])
			.toMatchObject({ action: 'list' });
		listing.activeOrders = activeOrders([
			{ side: 'sell', itemId: 10, quantity: 2 },
		]);
		expect(classifyInventoryAdvisor(listing).report?.lines[0]?.decisions[0])
			.toMatchObject({ action: 'review' });
	});

	it.each([
		['missing_scope', 'missing_scope'],
		['url_restricted', 'url_restricted'],
		['unavailable', 'request_failed'],
		['partial', 'page_limit'],
	] as const)('keeps prior recommendations unchanged when active-order coverage is %s', (status, reason) => {
		const value = fixture();
		value.activeOrders = activeOrders(status === 'partial'
			? [{ side: 'buy', itemId: 10, quantity: 2 }]
			: []);
		value.activeOrders.status = 'partial';
		value.activeOrders.endpointCoverage.buy = { status, capturedAt: null, reason };

		const result = classifyInventoryAdvisor(value);

		expect(result).toMatchObject({ status: 'ready' });
		expect(result.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'sell' });
	});

	it('requires an approved applicable V1 assertion for use and treats revoked or conflicting claims as review', () => {
		const applicable = fixture();
		applicable.input.rulePack.rules = [rule('use-10', 'approved')];
		applicable.input.rulePack.sha256 = sha256InventoryRulePack(applicable.input.rulePack);
		applicable.knowledgePack.entries[0]!.use = { status: 'applicable', ruleId: 'use-10', sourceIds: ['source'] };
		applicable.knowledgePack.sha256 = sha256InventoryKnowledgePack(applicable.knowledgePack);
		expect(classifyInventoryAdvisor(applicable).report?.lines[0]?.decisions[0]).toMatchObject({ action: 'use', ruleId: 'use-10' });

		const withheld = fixture();
		withheld.input.rulePack.rules = [rule('use-10', 'revoked')];
		withheld.input.rulePack.sha256 = sha256InventoryRulePack(withheld.input.rulePack);
		withheld.knowledgePack.entries[0]!.use = { status: 'applicable', ruleId: 'use-10', sourceIds: ['source'] };
		withheld.knowledgePack.sha256 = sha256InventoryKnowledgePack(withheld.knowledgePack);
		expect(classifyInventoryAdvisor(withheld).report?.lines[0]?.decisions[0]).toMatchObject({ action: 'review' });

		const conflict = fixture();
		conflict.input.rulePack.rules = [rule('use-a', 'approved'), rule('use-b', 'approved')];
		conflict.input.rulePack.sha256 = sha256InventoryRulePack(conflict.input.rulePack);
		conflict.knowledgePack.entries[0]!.use = { status: 'applicable', ruleId: 'use-a', sourceIds: ['source'] };
		conflict.knowledgePack.sha256 = sha256InventoryKnowledgePack(conflict.knowledgePack);
		expect(classifyInventoryAdvisor(conflict).report?.lines[0]?.decisions[0]).toMatchObject({ action: 'review' });
	});

	it('fails closed when economic evidence is incomplete and rejects hostile public-validator inputs', () => {
		const limited = fixture();
		limited.input.accountSignals.endpointCoverage.skins = { status: 'missing_scope', capturedAt: null, reason: 'missing_scope' };
		limited.input.accountSignals.unlockCoverage = 'partial';
		limited.input.accountSignals.unlockedSkins = null;
		const result = classifyInventoryAdvisor(limited);
		expect(result).toMatchObject({ status: 'limited' });
		expect(result.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'review' });
		const hostile = new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
		expect(isInventoryKnowledgePack(hostile)).toBe(false);
		expect(isInventoryAdvisorEngineResult(hostile)).toBe(false);
	});

	it('blocks TP on bound holdings and a curated salvage route on NoSalvage evidence', () => {
		for (const binding of ['AccountBound', 'Soulbind']) {
			const bound = fixture();
			bound.input.snapshot.holdings[0]!.metadata.binding = binding;
			expect(classifyInventoryAdvisor(bound).report?.lines[0]?.decisions[0]?.action).toBe('vendor');
		}
		const noSalvage = fixture();
		noSalvage.input.catalog.items['10'] = { ...noSalvage.input.catalog.items['10']!, flags: ['NoSalvage'] };
		noSalvage.input.rulePack.rules = [{ ruleId: 'salvage-10', itemId: 10, action: 'salvage', status: 'approved', assertion: 'applicable', reason: 'curated_salvage', sourceIds: ['rule-source'] }];
		noSalvage.input.rulePack.sources = [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }];
		noSalvage.input.rulePack.sha256 = sha256InventoryRulePack(noSalvage.input.rulePack);
		noSalvage.knowledgePack.entries[0]!.salvage = { status: 'applicable', ruleId: 'salvage-10', sourceIds: ['source'] };
		noSalvage.knowledgePack.sha256 = sha256InventoryKnowledgePack(noSalvage.knowledgePack);
		const result = classifyInventoryAdvisor(noSalvage);
		expect(result.report?.lines[0]?.decisions[0]).toMatchObject({ action: 'review' });
		expect(result.report?.lines[0]?.reasons).toContainEqual(expect.objectContaining({ code: 'no_salvage' }));
	});

	it('treats a positive rule against a not-applicable knowledge claim and stale evidence as review', () => {
		const contradictory = fixture();
		contradictory.input.rulePack.rules = [rule('use-10', 'approved')];
		contradictory.input.rulePack.sha256 = sha256InventoryRulePack(contradictory.input.rulePack);
		expect(classifyInventoryAdvisor(contradictory).report?.lines[0]?.decisions[0])
			.toMatchObject({ action: 'review' });

		const stale = fixture();
		stale.input.prices = { ...stale.input.prices, capturedAt: '2026-08-13T00:00:00.000Z' };
		expect(classifyInventoryAdvisor(stale)).toMatchObject({ status: 'limited' });
		expect(classifyInventoryAdvisor(stale).report?.lines[0]?.decisions[0])
			.toMatchObject({ action: 'review' });
	});

	it('deposits only the loose quantity proven to fit under the guaranteed material-storage floor', () => {
		const input = materialStorageFixture(100, 225);
		input.materialStorageCapacity = { quantity: 250, source: 'minimum_guaranteed' };

		const result = classifyInventoryAdvisor(input);
		const decisions = result.report?.lines[0]?.decisions ?? [];
		expect(decisions.find((decision) => decision.action === 'deposit_material')).toMatchObject({
			action: 'deposit_material', quantity: 25,
			allocations: [{ positionRef: '#/positions/10/0', quantity: 25 }],
			materialStorage: {
				capacity: 250, capacitySource: 'minimum_guaranteed', storedQuantity: 225, spaceBefore: 25,
			},
		});
		expect(decisions.reduce((total, decision) => total + decision.quantity, 0)).toBe(325);
		expect(isInventoryAdvisorResultForInput(
			result, input.input, input.knowledgePack, undefined, undefined, undefined, input.materialStorageCapacity,
		)).toBe(true);
	});

	it('uses a configured cap but never recommends more than its demonstrated remaining space', () => {
		const input = materialStorageFixture(400, 200);
		input.materialStorageCapacity = { quantity: 500, source: 'configured' };

		const deposit = classifyInventoryAdvisor(input).report?.lines[0]?.decisions
			.find((decision) => decision.action === 'deposit_material');
		expect(deposit).toMatchObject({ quantity: 300, materialStorage: {
			capacity: 500, capacitySource: 'configured', storedQuantity: 200, spaceBefore: 300,
		} });
	});

	it('validates the aggregate material-deposit budget across multiple engine decisions', () => {
		expect(isInventoryAdvisorEngineResult(materialDepositEngineResult(25))).toBe(true);
		expect(isInventoryAdvisorEngineResult(materialDepositEngineResult(30))).toBe(false);
	});

	it.each([
		['capacity absent', (input: InventoryAdvisorEngineInputV1) => { delete input.materialStorageCapacity; }],
		['materials partial', (input: InventoryAdvisorEngineInputV1) => {
			input.input.snapshot.coverage.sources.materials = { status: 'partial', reason: 'unavailable' };
		}],
		['catalog partial', (input: InventoryAdvisorEngineInputV1) => {
			delete input.input.catalog.coverage.materials['7'];
		}],
		['item ineligible', (input: InventoryAdvisorEngineInputV1) => { input.input.catalog.materials['7']!.items = []; }],
		['storage full', (input: InventoryAdvisorEngineInputV1) => {
			input.input.snapshot.holdings[1]!.quantity = 250;
			input.input.snapshot.availableByItem['10'] = 350;
			input.input.snapshot.ownedByItem['10'] = 350;
		}],
		['snapshot unstable', (input: InventoryAdvisorEngineInputV1) => { input.input.snapshot.quality = 'unstable'; }],
	] as const)('fails closed when material deposit evidence is %s', (_name, mutate) => {
		const input = materialStorageFixture(100, 200);
		input.materialStorageCapacity = { quantity: 250, source: 'minimum_guaranteed' };
		mutate(input);
		expect(classifyInventoryAdvisor(input).report?.lines[0]?.decisions
			.some((decision) => decision.action === 'deposit_material') ?? false).toBe(false);
	});

	it('compares a Rare level-68+ salvage lower bound with current official prices', () => {
		const input = equipmentSalvageFixture('Rare');
		expect(isInventoryAdvisorInput(input.input)).toBe(true);
		expect(isEquipmentSalvagePolicy(input.equipmentSalvage?.policy)).toBe(true);
		expect(isEquipmentSalvagePreferences(input.equipmentSalvage?.preferences)).toBe(true);
		expect(isInventoryContainerPriceEvidence(input.equipmentSalvage?.prices)).toBe(true);
		const result = classifyInventoryAdvisor(input);

		expect(result).toMatchObject({
			status: 'ready',
			envelope: { execution: 'manual_in_game', sideEffects: 'none', requiresUserAction: true },
		});
		expect(result.report?.lines[0]?.decisions).toMatchObject([{
			action: 'salvage', quantity: 2, ruleId: 'rare-equipment-68-ecto-v1', safety: 'manual_only',
		}]);
		expect(isInventoryAdvisorResultForInput(
			result, input.input, input.knowledgePack, undefined, undefined, undefined, undefined, undefined,
			input.equipmentSalvage,
		)).toBe(true);
	});

	it('keeps Exotic and uncertain/forbidden equipment in explicit review', () => {
		const exotic = equipmentSalvageFixture('Exotic');
		expect(classifyInventoryAdvisor(exotic).report?.lines[0]).toMatchObject({
			decisions: [{ action: 'review' }], reasons: [{ code: 'salvage_exotic_rate_unverified' }],
		});
		const forbidden = equipmentSalvageFixture('Rare');
		forbidden.input.catalog.items['10']!.flags.push('NoSalvage');
		expect(classifyInventoryAdvisor(forbidden).report?.lines[0]).toMatchObject({
			decisions: [{ action: 'review' }], reasons: [{ code: 'no_salvage' }],
		});
		const futureType = equipmentSalvageFixture('Rare');
		futureType.input.catalog.items['10']!.type = 'FutureEquipment';
		expect(classifyInventoryAdvisor(futureType).report?.lines[0]).toMatchObject({
			decisions: [{ action: 'review' }], reasons: [{ code: 'salvage_item_evidence_uncertain' }],
		});
	});
});

function rule(ruleId: string, status: 'approved' | 'revoked') {
	return { ruleId, itemId: 10, action: 'use' as const, status, assertion: 'applicable' as const,
		reason: 'curated_use' as const, sourceIds: ['rule-source'] };
}

function fixture(): InventoryAdvisorEngineInputV1 {
	const snapshot: StorageSnapshot = { snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z', completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId: 10, quantity: 2, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }], currencies: [], availableByItem: { '10': 2 }, ownedByItem: { '10': 2 }, currencyById: {}, roster: [],
		coverage: coverage(), passCoverages: [coverage(), coverage()] };
	const rulePack = { schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '', sources: [{ id: 'rule-source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }], rules: [] };
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledge: InventoryKnowledgePackV1 = { schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '', sources: [{ id: 'source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }], entries: [{ itemId: 10, use: { status: 'not_applicable', assertionId: 'use-none', sourceIds: ['source'] }, open: { status: 'not_applicable', assertionId: 'open-none', sourceIds: ['source'] }, salvage: { status: 'not_applicable', assertionId: 'salvage-none', sourceIds: ['source'] } }] };
	knowledge.sha256 = sha256InventoryKnowledgePack(knowledge);
	return { input: { version: 1, asOf: '2026-08-14T12:00:00.000Z', snapshot, catalog: { snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z', items: { '10': { kind: 'item', id: 10, name: 'Item', type: 'Trophy', rarity: 'Basic', level: 0, vendorValue: 1, flags: [], gameTypes: [], restrictions: [] } }, currencies: {}, materials: {}, warnings: [], coverage: { items: { '10': { status: 'resolved', source: 'network' } }, currencies: {}, materials: {} } }, prices: { version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z', source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: [10], status: 'complete', items: [{ itemId: 10, whitelisted: true, bid: { unitCopper: 20, quantity: 2 }, ask: { unitCopper: 21, quantity: 2 } }], missingItemIds: [] }, goals: [], keepExceptions: [], accountSignals: { version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z', schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full', endpointCoverage: { account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence() }, unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [], achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [] }, rulePack, policy: { version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000, maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000, listingMinimumAdvantageBps: 1_000 } }, knowledgePack: knowledge };
}

function equipmentSalvageFixture(rarity: 'Rare' | 'Exotic'): InventoryAdvisorEngineInputV1 {
	const value = fixture();
	const asOf = '2026-08-29T12:00:00.000Z';
	value.input.asOf = asOf;
	value.input.snapshot.startedAt = '2026-08-29T11:59:00.000Z';
	value.input.snapshot.completedAt = '2026-08-29T11:59:01.000Z';
	value.input.catalog.resolvedAt = asOf;
	value.input.prices.capturedAt = asOf;
	value.input.accountSignals.capturedAt = asOf;
	for (const endpoint of Object.values(value.input.accountSignals.endpointCoverage)) endpoint.capturedAt = asOf;
	value.input.snapshot.holdings[0] = {
		kind: 'item', itemId: 10, quantity: 2, state: 'loose',
		location: { source: 'shared_inventory', slot: 0 }, metadata: {},
	};
	value.input.catalog.items['10'] = {
		kind: 'item', id: 10, name: `${rarity} sword`, type: 'Weapon', rarity, level: 80,
		vendorValue: 50, flags: [], gameTypes: [], restrictions: [],
	};
	value.input.prices.requestedItemIds = [10];
	value.input.prices.items = [
		{ itemId: 10, whitelisted: true, bid: { unitCopper: 100, quantity: 2 }, ask: { unitCopper: 110, quantity: 2 } },
	];
	value.equipmentSalvage = {
		policy: structuredClone(EQUIPMENT_SALVAGE_POLICY_V1),
		preferences: { version: 1, kit: null, saleStrategy: null, time: null },
		prices: {
			version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', schemaVersion: PINNED_SCHEMA,
			capturedAt: asOf, source: 'gw2-commerce-prices', requestedItemIds: [19_721], status: 'complete',
			items: [{ itemId: 19_721, whitelisted: true, bid: { unitCopper: 1_000, quantity: 10_000 },
				ask: { unitCopper: 1_050, quantity: 10_000 } }], missingItemIds: [],
		},
	};
	return value;
}

function materialStorageFixture(looseQuantity: number, storedQuantity: number): InventoryAdvisorEngineInputV1 {
	const value = fixture();
	value.input.snapshot.holdings = [
		{ kind: 'item', itemId: 10, quantity: looseQuantity, state: 'loose',
			location: { source: 'shared_inventory', slot: 0 }, metadata: {} },
		{ kind: 'item', itemId: 10, quantity: storedQuantity, state: 'loose',
			location: { source: 'materials', category: 7 }, metadata: {} },
	];
	value.input.snapshot.availableByItem = { '10': looseQuantity + storedQuantity };
	value.input.snapshot.ownedByItem = { '10': looseQuantity + storedQuantity };
	value.input.catalog.materials['7'] = {
		kind: 'material_category', id: 7, name: 'Common materials', items: [10], order: 7,
	};
	value.input.catalog.coverage.materials['7'] = { status: 'resolved', source: 'network' };
	return value;
}

function marketDepthFixture(quantity: number): InventoryAdvisorEngineInputV1 {
	const value = fixture();
	value.input.snapshot.holdings[0]!.quantity = quantity;
	value.input.snapshot.availableByItem = { '10': quantity };
	value.input.snapshot.ownedByItem = { '10': quantity };
	value.input.prices.items[0] = { itemId: 10, whitelisted: true,
		bid: { unitCopper: 100, quantity }, ask: { unitCopper: 101, quantity: 1 } };
	return value;
}

function depth(
	buys: Array<{ unitCopper: number; quantity: number }>,
	sells: Array<{ unitCopper: number; quantity: number }>,
): NonNullable<InventoryAdvisorEngineInputV1['marketDepth']> {
	return { version: 1, capturedAt: '2026-08-14T12:00:00.000Z', source: 'gw2-commerce-listings',
		requestedItemIds: [10], status: 'complete', items: [{ itemId: 10, coverage: 'complete', buys, sells }] };
}

function materialDepositEngineResult(quantity: number): InventoryAdvisorEngineResultV1 {
	const materialStorage = {
		capacity: 250, capacitySource: 'minimum_guaranteed' as const, storedQuantity: 200, spaceBefore: 50,
	};
	return {
		status: 'ready',
		report: {
			version: 1, scope: 'supported_storage_v1', accountId: 'account-1', snapshotId: 'snapshot-1',
			asOf: '2026-08-14T12:00:00.000Z', knowledgePack: { id: 'knowledge', version: 1, sha256: '0'.repeat(64) },
			lines: [{
				itemId: 10, name: 'Material', ownedQuantity: quantity * 2,
				positions: [0, 1].map((holdingIndex) => ({
					ref: `#/positions/10/${String(holdingIndex)}`, holdingIndex, itemId: 10, quantity,
					source: 'shared_inventory' as const, state: 'loose' as const,
				})),
				decisions: [0, 1].map((holdingIndex) => ({
					action: 'deposit_material' as const, itemId: 10, quantity,
					allocations: [{ positionRef: `#/positions/10/${String(holdingIndex)}`, quantity }],
					reason: 'material_storage_space_available', ruleId: null, materialStorage,
				})),
			}],
		},
		envelope: { execution: 'manual_in_game', sideEffects: 'none', requiresUserAction: true },
	};
}
function scopedInventoryFixture(quality: 'stable' | 'unstable'): InventoryAdvisorEngineInputV1 {
	const value = fixture();
	const scopedCoverage = coverage();
	scopedCoverage.sources.bank = { status: 'skipped', reason: 'not_requested' };
	scopedCoverage.sources.materials = { status: 'skipped', reason: 'not_requested' };
	scopedCoverage.sources.wallet = { status: 'skipped', reason: 'not_requested' };
	scopedCoverage.sources.commerce_delivery = { status: 'skipped', reason: 'not_requested' };
	value.input.snapshot = {
		...value.input.snapshot,
		quality,
		passes: quality === 'unstable' ? 3 : 2,
		holdings: [{
			...value.input.snapshot.holdings[0]!,
			location: { source: 'shared_inventory', slot: 0 },
		}],
		coverage: scopedCoverage,
		passCoverages: quality === 'unstable'
			? [structuredClone(scopedCoverage), structuredClone(scopedCoverage), structuredClone(scopedCoverage)]
			: [structuredClone(scopedCoverage), structuredClone(scopedCoverage)],
	};
	return value;
}
function coverage(): SnapshotCoverage { return { sources: { characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' }, materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' } }, characters: {} }; }
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
function activeOrders(orders: NonNullable<InventoryAdvisorEngineInputV1['activeOrders']>['orders']): NonNullable<InventoryAdvisorEngineInputV1['activeOrders']> {
	return {
		version: 1,
		accountId: 'account-1',
		capturedAt: '2026-08-14T12:00:00.000Z',
		status: 'complete',
		endpointCoverage: { buy: evidence(), sell: evidence() },
		orders,
	};
}
