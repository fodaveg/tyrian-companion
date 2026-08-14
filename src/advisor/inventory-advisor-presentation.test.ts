import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type StorageSnapshot } from '../account/storage-snapshot-model';
import { createInventoryRecommendationEnvelope } from '../economy/inventory-recommendation-envelope';
import { classifyInventoryAdvisor, sha256InventoryKnowledgePack } from './inventory-advisor-classifier';
import type { InventoryAdvisorEngineInputV1, InventoryKnowledgePackV1 } from './inventory-advisor-classifier-model';
import { sha256InventoryRulePack } from './inventory-advisor-contract';
import { buildInventoryAdvisorPresentation } from './inventory-advisor-presentation';

describe('H5.11 inventory advisor presentation', () => {
	it('uses the H4.2 policy for minimum fees and half-up rounding instead of duplicating fees', () => {
		const minimum = source();
		minimum.input.catalog.items['10'] = { ...minimum.input.catalog.items['10']!, flags: ['NoSell'] };
		minimum.input.prices.items[0] = { itemId: 10, whitelisted: true, bid: { unitCopper: 10, quantity: 1 }, ask: null };
		minimum.input.snapshot.holdings[0]!.quantity = 1;
		minimum.input.snapshot.ownedByItem = { '10': 1 };
		minimum.input.snapshot.availableByItem = { '10': 1 };
		const minimumRow = onlyRow(minimum);
		expect(minimumRow).toMatchObject({ action: 'sell', value: { status: 'available', copper: 8, route: 'instant_sell' } });

		const rounded = source();
		rounded.input.catalog.items['10'] = { ...rounded.input.catalog.items['10']!, flags: ['NoSell'] };
		rounded.input.prices.items[0] = { itemId: 10, whitelisted: true, bid: { unitCopper: 50, quantity: 1 }, ask: null };
		rounded.input.snapshot.holdings[0]!.quantity = 1;
		rounded.input.snapshot.ownedByItem = { '10': 1 };
		rounded.input.snapshot.availableByItem = { '10': 1 };
		expect(onlyRow(rounded)).toMatchObject({ action: 'sell', value: { status: 'available', copper: 42, route: 'instant_sell' } });
	});

	it('filters, groups, and deterministically orders validated H4.15 decisions', () => {
		const value = source();
		addVendorLine(value);
		const all = project(value);
		expect(all.status).toBe('ready');
		expect(all.groups.map((group) => group.group)).toEqual(['market']);
		expect(all.groups[0]?.rows.map((row) => row.itemId)).toEqual([11, 10]);

		const filtered = buildInventoryAdvisorPresentation({ input: value.input, result: classifyInventoryAdvisor(value) }, { filters: { actions: ['sell'] }, sort: 'action_asc' });
		expect(filtered.groups).toHaveLength(1);
		expect(filtered.groups[0]).toMatchObject({ group: 'market', rows: [{ itemId: 10, action: 'sell' }] });

		const none = buildInventoryAdvisorPresentation({ input: value.input, result: classifyInventoryAdvisor(value) }, { filters: { query: 'does not exist' } });
		expect(none).toMatchObject({ status: 'empty', groups: [] });
	});

	it('preserves multi-position allocations, every explanation reason, and non-economic value semantics', () => {
		const split = source();
		split.input.snapshot.holdings[0]!.quantity = 1;
		split.input.snapshot.holdings.push({
			kind: 'item', itemId: 10, quantity: 1, state: 'loose',
			location: { source: 'shared_inventory', slot: 0 }, metadata: {},
		});
		const result = classifyInventoryAdvisor(split);
		if (result.status === 'invalid') throw new Error('Expected a valid split fixture.');
		const merged = structuredClone(result);
		const line = merged.report.lines[0];
		if (line === undefined || line.decisions.length !== 2) throw new Error('Expected two producer decisions.');
		const [first, second] = line.decisions;
		if (first === undefined || second === undefined || first.action !== second.action) throw new Error('Expected mergeable decisions.');
		line.decisions = [{
			...first,
			quantity: first.quantity + second.quantity,
			allocations: [...first.allocations, ...second.allocations],
		}];
		merged.report.explanations = merged.report.explanations.filter((entry) => entry.ref !== second.explanationRef);
		const envelope = createInventoryRecommendationEnvelope(merged.report);
		if (envelope === null) throw new Error('Expected a valid merged envelope.');
		merged.envelope = envelope;
		const mergedRow = buildInventoryAdvisorPresentation({ input: split.input, result: merged }).groups[0]?.rows[0];
		expect(mergedRow).toMatchObject({ quantity: 2 });
		expect(mergedRow?.allocations).toEqual([
			{ positionRef: '#/positions/10/0', quantity: 1, location: { source: 'bank', slot: 0 } },
			{ positionRef: '#/positions/10/1', quantity: 1, location: { source: 'shared_inventory', slot: 0 } },
		]);
		const explanation = merged.report.explanations.find((entry) => entry.ref === mergedRow?.id);
		expect(mergedRow?.reasonCodes).toEqual(explanation?.reasonCodes);

		const reserved = source();
		reserved.input.goals = [{
			schemaVersion: 1, goalId: 'keep-two', title: 'Keep two', status: 'active', priority: 100, reason: 'personal',
			requirements: [{ key: 'item:10', namespace: 'item', id: 10, targetQuantity: 2, creditedQuantity: 0, basis: 'available', intendedUse: 'hold' }],
		}];
		const reservedResult = classifyInventoryAdvisor(reserved);
		if (reservedResult.status === 'invalid') throw new Error('Expected a valid reserved fixture.');
		reservedResult.report.explanations[0]!.reasonCodes = [];
		reservedResult.report.lines[0]!.reasons = [];
		reservedResult.report.reasons = [];
		const reservedEnvelope = createInventoryRecommendationEnvelope(reservedResult.report);
		if (reservedEnvelope === null) throw new Error('Expected an envelope with an empty reason set.');
		reservedResult.envelope = reservedEnvelope;
		const reservedRow = buildInventoryAdvisorPresentation({ input: reserved.input, result: reservedResult }).groups[0]?.rows[0];
		expect(reservedRow).toMatchObject({
			action: 'keep', quantity: 2, value: { status: 'not_applicable', route: null },
		});
		expect(reservedRow?.reasonCodes).toEqual([]);
	});

	it('does not let filters hide limited safety state and uses the catalog locale for deterministic names', () => {
		const limited = source();
		limited.input.rulePack = {
			...limited.input.rulePack,
			publishedAt: '2025-01-01T00:00:00.000Z', reviewedAt: '2025-01-02T00:00:00.000Z',
		};
		limited.input.rulePack.sha256 = sha256InventoryRulePack(limited.input.rulePack);
		const limitedResult = classifyInventoryAdvisor(limited);
		const hidden = buildInventoryAdvisorPresentation(
			{ input: limited.input, result: limitedResult }, { filters: { query: 'not-present' } },
		);
		expect(hidden).toMatchObject({ status: 'limited', groups: [] });
		const limitedRow = buildInventoryAdvisorPresentation({ input: limited.input, result: limitedResult }).groups[0]?.rows[0];
		expect(limitedRow?.reasonCodes).toEqual(limitedResult.report?.explanations[0]?.reasonCodes);

		const localized = source();
		localized.input.catalog.items['10'] = { ...localized.input.catalog.items['10']!, name: 'Zorro' };
		addVendorLine(localized);
		localized.input.catalog.items['11'] = { ...localized.input.catalog.items['11']!, name: 'Árbol' };
		const names = buildInventoryAdvisorPresentation(
			{ input: localized.input, result: classifyInventoryAdvisor(localized) }, { sort: 'name_asc' },
		).groups[0]?.rows.map((entry) => entry.name);
		expect(names).toEqual(['Árbol', 'Zorro']);
	});

	it('fails closed for mismatched identity or position references and keeps H4.16 unavailable', () => {
		const valid = source();
		const result = classifyInventoryAdvisor(valid);
		const identityMismatch = structuredClone(result);
		if (identityMismatch.status === 'invalid') throw new Error('Expected fixture result.');
		identityMismatch.report.accountId = 'other-account';
		expect(buildInventoryAdvisorPresentation({ input: valid.input, result: identityMismatch })).toMatchObject({ status: 'invalid', groups: [] });

		const movedHolding = structuredClone(valid.input);
		movedHolding.snapshot.holdings[0]!.quantity = 1;
		expect(buildInventoryAdvisorPresentation({ input: movedHolding, result })).toMatchObject({ status: 'invalid', groups: [] });

		const presentation = project(valid);
		expect(presentation.discardReview).toEqual({ status: 'unavailable' });
		expect(JSON.stringify(presentation)).not.toContain('discard_candidate');

		expect(buildInventoryAdvisorPresentation({ input: valid.input, result }, new Map() as never))
			.toMatchObject({ status: 'invalid', groups: [] });
		const mappedExplanations = structuredClone(result);
		if (mappedExplanations.status === 'invalid') throw new Error('Expected fixture result.');
		(mappedExplanations.report as unknown as { explanations: unknown }).explanations = new Map();
		expect(buildInventoryAdvisorPresentation({ input: valid.input, result: mappedExplanations }))
			.toMatchObject({ status: 'invalid', groups: [] });
		const mappedPrices = structuredClone(valid.input);
		(mappedPrices.prices as unknown as { items: unknown }).items = new Map();
		expect(buildInventoryAdvisorPresentation({ input: mappedPrices, result }))
			.toMatchObject({ status: 'invalid', groups: [] });
		expect(buildInventoryAdvisorPresentation(
			{ input: valid.input, result }, { filters: { actions: ['destroy'] } } as never,
		)).toMatchObject({ status: 'invalid', groups: [] });
		let getterRead = false;
		const capability = { input: valid.input, result } as Record<string, unknown>;
		Object.defineProperty(capability, 'executor', { enumerable: true, get() { getterRead = true; return () => undefined; } });
		expect(buildInventoryAdvisorPresentation(capability as never)).toMatchObject({ status: 'invalid', groups: [] });
		expect(getterRead).toBe(false);
		let optionGetterRead = 0;
		const hostileOptions = {};
		Object.defineProperty(hostileOptions, 'sort', {
			enumerable: true, get() { optionGetterRead += 1; return 'name_asc'; },
		});
		expect(buildInventoryAdvisorPresentation({ input: valid.input, result }, hostileOptions as never))
			.toMatchObject({ status: 'invalid', groups: [] });
		expect(optionGetterRead).toBe(0);
	});
});

function onlyRow(value: InventoryAdvisorEngineInputV1) {
	const presentation = project(value);
	const row = presentation.groups[0]?.rows[0];
	if (row === undefined) throw new Error('Expected one presentation row.');
	return row;
}

function project(value: InventoryAdvisorEngineInputV1) {
	const result = classifyInventoryAdvisor(value);
	return buildInventoryAdvisorPresentation({ input: value.input, result });
}

function addVendorLine(value: InventoryAdvisorEngineInputV1): void {
	value.input.snapshot.holdings.push({ kind: 'item', itemId: 11, quantity: 1, state: 'loose', location: { source: 'bank', slot: 1 }, metadata: {} });
	value.input.snapshot.ownedByItem = { '10': 2, '11': 1 };
	value.input.snapshot.availableByItem = { '10': 2, '11': 1 };
	value.input.catalog.items['11'] = { ...value.input.catalog.items['10']!, id: 11, name: 'Zeta', vendorValue: 100 };
	value.input.catalog.coverage.items['11'] = { status: 'resolved', source: 'network' };
	value.input.prices.requestedItemIds = [10, 11];
	value.input.prices.items.push({ itemId: 11, whitelisted: true, bid: null, ask: null });
	value.knowledgePack.entries.push({ itemId: 11, use: { status: 'not_applicable', assertionId: 'use-none-11', sourceIds: ['source'] }, open: { status: 'not_applicable', assertionId: 'open-none-11', sourceIds: ['source'] }, salvage: { status: 'not_applicable', assertionId: 'salvage-none-11', sourceIds: ['source'] } });
	value.knowledgePack.sha256 = sha256InventoryKnowledgePack(value.knowledgePack);
}

function source(): InventoryAdvisorEngineInputV1 {
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z', completedAt: '2026-08-14T11:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId: 10, quantity: 2, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }], currencies: [], availableByItem: { '10': 2 }, ownedByItem: { '10': 2 }, currencyById: {}, roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
	const rulePack = { schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '', sources: [], rules: [] };
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	const knowledge: InventoryKnowledgePackV1 = {
		schemaVersion: 1, id: 'knowledge', version: 1, publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '', sources: [{ id: 'source', url: 'https://wiki.guildwars2.com', retrievedAt: '2026-08-02T00:00:00.000Z' }],
		entries: [{ itemId: 10, use: { status: 'not_applicable', assertionId: 'use-none', sourceIds: ['source'] }, open: { status: 'not_applicable', assertionId: 'open-none', sourceIds: ['source'] }, salvage: { status: 'not_applicable', assertionId: 'salvage-none', sourceIds: ['source'] } }],
	};
	knowledge.sha256 = sha256InventoryKnowledgePack(knowledge);
	return { input: {
		version: 1, asOf: '2026-08-14T12:00:00.000Z', snapshot,
		catalog: { snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: '2026-08-14T12:00:00.000Z', items: { '10': { kind: 'item', id: 10, name: 'Alpha', type: 'Trophy', rarity: 'Basic', level: 0, vendorValue: 1, flags: [], gameTypes: [], restrictions: [] } }, currencies: {}, materials: {}, warnings: [], coverage: { items: { '10': { status: 'resolved', source: 'network' } }, currencies: {}, materials: {} } },
		prices: { version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: '2026-08-14T12:00:00.000Z', source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA, requestedItemIds: [10], status: 'complete', items: [{ itemId: 10, whitelisted: true, bid: { unitCopper: 20, quantity: 2 }, ask: { unitCopper: 21, quantity: 2 } }], missingItemIds: [] }, goals: [], keepExceptions: [],
		accountSignals: { version: 1, source: 'gw2-account-api', accountId: 'account-1', capturedAt: '2026-08-14T12:00:00.000Z', schemaVersion: PINNED_SCHEMA, tradingPostAccess: 'full', endpointCoverage: { account: evidence(), recipes: evidence(), skins: evidence(), minis: evidence(), achievements: evidence() }, unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [], achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [] }, rulePack,
		policy: { version: 1, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000, maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000, listingMinimumAdvantageBps: 1_000 },
	}, knowledgePack: knowledge };
}

function coverage() { return { sources: { characters: { status: 'complete' as const }, shared_inventory: { status: 'complete' as const }, bank: { status: 'complete' as const }, materials: { status: 'complete' as const }, wallet: { status: 'complete' as const }, commerce_delivery: { status: 'complete' as const } }, characters: {} }; }
function evidence() { return { status: 'complete' as const, capturedAt: '2026-08-14T12:00:00.000Z', reason: null }; }
