import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import {
	createInventoryRecommendationEnvelope,
	isInventoryRecommendationEnvelope,
} from '../economy/inventory-recommendation-envelope';
import {
	isAccountSignals,
	isCatalogResolution,
	isInventoryAdvisorInput,
	isInventoryAdvisorReport,
	isInventoryAdvisorRulePack,
	isInventoryPriceSnapshot,
	sha256InventoryRulePack,
	validDecisionAgainstInput,
} from './inventory-advisor-contract';
import type {
	InventoryAdvisorInputV1,
	InventoryAdvisorReportV1,
	InventoryAdvisorRulePackV1,
	InventoryRecommendationDecisionV1,
} from './inventory-advisor-model';
import { isInventoryAdvisorResult, isInventoryAdvisorResultForInput } from './inventory-advisor-result';

describe('inventory advisor H4.13 contract', () => {
	it('accepts a canonical, identity-bound supported-storage input', () => {
		const input = inputFixture();
		expect(isInventoryAdvisorInput(input)).toBe(true);
		expect(isInventoryPriceSnapshot(input.prices)).toBe(true);
		expect(isAccountSignals(input.accountSignals)).toBe(true);
		expect(isInventoryAdvisorRulePack(input.rulePack)).toBe(true);
	});

	it('accepts a character/shared-only snapshot while the full-account validator remains strict', () => {
		const input = inputFixture();
		const coverage: SnapshotCoverage = {
			sources: {
				characters: { status: 'complete' },
				shared_inventory: { status: 'complete' },
				bank: { status: 'skipped', reason: 'not_requested' },
				materials: { status: 'skipped', reason: 'not_requested' },
				wallet: { status: 'skipped', reason: 'not_requested' },
				commerce_delivery: { status: 'skipped', reason: 'not_requested' },
			},
			characters: {},
		};
		const snapshot: StorageSnapshot = {
			...input.snapshot,
			holdings: [{ ...input.snapshot.holdings[0]!, location: { source: 'shared_inventory', slot: 0 } }],
			coverage,
			passCoverages: [coverage, coverage],
		};
		expect(isInventoryAdvisorInput({ ...input, snapshot })).toBe(true);
	});

	it('keeps a frozen V1 rule-pack digest valid without silently migrating it', () => {
		const legacy = {
			schemaVersion: 1 as const, id: 'legacy-rules', version: 1,
			publishedAt: '2026-08-14T18:04:33.000Z', reviewedAt: '2026-08-14T18:04:33.000Z', validUntil: '2026-11-12T18:04:33.000Z',
			sha256: 'dcc91250efbef1f92a900e880c26b61f59e2c02cd25202f3ead7382713be0158',
			sources: [{ id: 'source', url: 'https://example.invalid', retrievedAt: '2026-08-14T18:04:33.000Z' }],
			rules: [{ ruleId: 'open-1', itemId: 1, action: 'open' as const, status: 'approved' as const, assertion: 'applicable' as const, reason: 'curated_open' as const, sourceIds: ['source'] }],
		};
		expect(isInventoryAdvisorRulePack(legacy)).toBe(true);
		expect(sha256InventoryRulePack(legacy)).toBe(legacy.sha256);
	});

	it('requires per-endpoint signal provenance, preserves completed achievements without bits and bounds snapshot age', () => {
		const input = inputFixture();
		const progress = { achievementId: 42, done: true, current: 1, max: 1, repeated: 0, bits: [] };
		expect(isAccountSignals({ ...input.accountSignals, completedAchievementBits: { '42': [] }, achievementProgress: [progress] })).toBe(true);
		expect(isAccountSignals({ ...input.accountSignals, endpointCoverage: { ...input.accountSignals.endpointCoverage, recipes: 'missing_scope' } })).toBe(false);
		expect(isInventoryAdvisorInput({ ...input, asOf: '2026-09-20T09:05:00.000Z' })).toBe(false);
	});

	it('rejects cross-account, cross-snapshot and incomplete price partitions', () => {
		const input = inputFixture();
		expect(isInventoryAdvisorInput({ ...input, prices: { ...input.prices, accountId: 'other' } })).toBe(false);
		expect(isInventoryAdvisorInput({ ...input, catalog: { ...input.catalog, snapshotId: 'other' } })).toBe(false);
		expect(isInventoryPriceSnapshot({ ...input.prices, requestedItemIds: [10, 11] })).toBe(false);
		expect(isInventoryPriceSnapshot({ ...input.prices, missingItemIds: [10], status: 'complete' })).toBe(false);
		expect(isInventoryPriceSnapshot({ ...input.prices,
			items: [{ ...input.prices.items[0]!, bid: null, ask: null }],
		})).toBe(true);
	});

	it('requires a network or fresh-cache catalog source for every economic decision', () => {
		const input = inputFixture();
		const decision = reportFixture().lines[0]!.decisions[1]!;
		expect(validDecisionAgainstInput(input, decision)).toBe(true);
		expect(validDecisionAgainstInput({ ...input, catalog: { ...input.catalog, coverage: {
			...input.catalog.coverage, items: { '10': { status: 'resolved', source: 'cache_stale' } },
		} } }, decision)).toBe(false);
	});

	it('binds catalog entities one-to-one with resolved coverage', () => {
		const catalog = inputFixture().catalog;
		expect(isCatalogResolution({ ...catalog, items: {} })).toBe(false);
		expect(isCatalogResolution({ ...catalog, coverage: { ...catalog.coverage,
			items: { '10': { status: 'missing', source: 'network', reason: 'missing_response' } },
		} })).toBe(false);
	});

	it('requires canonical user exceptions, unlock evidence and a content-bound rule pack', () => {
		const input = inputFixture();
		const exception = {
			version: 1, exceptionId: 'keep-10', itemId: 10, status: 'active', basis: 'available',
			quantity: { mode: 'minimum', value: 1 }, reason: 'user_keep',
		} as const;
		expect(isInventoryAdvisorInput({ ...input, keepExceptions: [exception] })).toBe(true);
		expect(isInventoryAdvisorInput({ ...input, keepExceptions: [exception, exception] })).toBe(false);
		expect(isAccountSignals({ ...input.accountSignals, unlockCoverage: 'complete', unlockedSkins: null })).toBe(false);
		expect(isInventoryAdvisorRulePack({ ...input.rulePack, validUntil: '2027-02-01T00:00:00.000Z' })).toBe(false);
	});

	it('validates the report partition and manual envelope one-to-one', () => {
		const report = reportFixture();
		expect(isInventoryAdvisorReport(report)).toBe(true);
		const envelope = createInventoryRecommendationEnvelope(report);
		expect(envelope).not.toBeNull();
		expect(isInventoryRecommendationEnvelope(envelope)).toBe(true);
		expect(isInventoryAdvisorResult({ status: 'ready', report, envelope })).toBe(true);
		const baseInput = inputFixture();
		const input = { ...baseInput, prices: { ...baseInput.prices,
			items: [{ itemId: 10, whitelisted: true, bid: { unitCopper: 1, quantity: 50 }, ask: { unitCopper: 1, quantity: 30 } }],
		} };
		const goal = { schemaVersion: 1 as const, goalId: 'goal-1', title: 'Guardar uno',
			status: 'active' as const, priority: 100, reason: 'personal' as const,
			requirements: [{ key: 'item:10', namespace: 'item' as const, id: 10, targetQuantity: 1,
				creditedQuantity: 0, basis: 'available' as const, intendedUse: 'hold' as const }] };
		expect(isInventoryAdvisorResultForInput({ status: 'ready', report, envelope }, { ...input, goals: [goal] }))
			.toBe(true);
		expect(isInventoryAdvisorResultForInput({ status: 'ready', report, envelope }, {
			...input, goals: [goal], accountSignals: { ...input.accountSignals,
				capturedAt: '2026-01-01T00:00:00.000Z' },
		})).toBe(false);
		expect(isInventoryAdvisorResult({ status: 'limited', report, envelope })).toBe(false);
	});

	it('rejects quantity tampering, non-actionable positions and incomplete destructive evidence', () => {
		const report = reportFixture();
		const line = report.lines[0]!;
		expect(isInventoryAdvisorReport({
			...report, lines: [{ ...line, unclassifiedQuantity: 1 }],
		})).toBe(false);
		const vendor = line.decisions[1]!;
		expect(isInventoryAdvisorReport({
			...report,
			lines: [{ ...line, positions: line.positions.map((position) =>
				({ ...position, state: 'pending_claim' as const })) }],
		})).toBe(false);
		expect(isInventoryAdvisorReport({
			...report,
			lines: [{ ...line, coverage: { ...line.coverage, prices: 'unknown' as const }, decisions: [line.decisions[0]!, vendor] }],
			coverage: 'limited',
		})).toBe(false);
	});

	it('makes discard_candidate review-only, rule-bound and never exposes destroy', () => {
		const input = inputFixture();
		const catalogItem = input.catalog.items['10']!;
		const discardInput: InventoryAdvisorInputV1 = {
			...input,
			catalog: { ...input.catalog, items: { '10': { ...catalogItem, vendorValue: 0,
				flags: ['NoSalvage', 'NoSell'] } } },
			prices: { ...input.prices, items: [{ ...input.prices.items[0]!, bid: null, ask: null }] },
		};
		const base = reportFixture();
		const discard: InventoryRecommendationDecisionV1 = {
			action: 'discard_candidate', itemId: 10, quantity: 2,
			allocations: [{ positionRef: '#/positions/10/0', quantity: 2 }], explanationRef: '#/explanations/discard',
			ruleId: 'discard-10', safety: 'irreversible_review_only',
			discardProof: { rulePackSha256: base.rulePack.sha256, catalogSource: 'network',
				tradingPost: 'unavailable', vendor: 'unavailable', salvage: 'no_salvage',
				use: 'not_applicable', open: 'not_applicable', unlocks: 'complete',
				collections: 'complete', deleteWarning: false },
		};
		const discardReport: InventoryAdvisorReportV1 = {
			...base,
			lines: [{ ...base.lines[0]!, reservedQuantity: 0, actionedQuantity: 2,
				decisions: [discard], reasons: [] }],
			reasons: [], explanations: [{
				ref: '#/explanations/discard', itemId: 10, action: 'discard_candidate',
				reasonCodes: [], evidenceRefs: ['#/evidence/rules'], ruleId: 'discard-10',
			}],
		};
		const envelope = createInventoryRecommendationEnvelope(discardReport);
		expect(envelope).not.toBeNull();
		expect(isInventoryAdvisorResultForInput({ status: 'ready', report: discardReport, envelope }, discardInput))
			.toBe(true);
		expect(isInventoryRecommendationEnvelope({ ...envelope!, decisions: [
			{ ...discard, ruleId: null },
		] })).toBe(false);
		expect(isInventoryRecommendationEnvelope({ ...envelope!, decisions: [
			{ ...discard, safety: 'manual_only' },
		] })).toBe(false);
		expect(isInventoryRecommendationEnvelope({ ...envelope!, decisions: [
			{ ...discard, action: 'destroy' },
		] })).toBe(false);
		expect(isInventoryRecommendationEnvelope({ ...envelope!, executor: 'delete' })).toBe(false);
		expect(isInventoryAdvisorResultForInput({ status: 'ready', report: discardReport, envelope }, {
			...discardInput, catalog: { ...discardInput.catalog, items: { '10': {
				...discardInput.catalog.items['10']!, flags: ['DeleteWarning', 'NoSalvage', 'NoSell'],
			} } },
		})).toBe(false);
		const discardResult = { status: 'ready' as const, report: discardReport, envelope };
		expect(isInventoryAdvisorResultForInput(discardResult, { ...discardInput, goals: [{
			schemaVersion: 1, goalId: 'hold-10', title: 'Guardar objeto', status: 'active', priority: 100,
			reason: 'personal', requirements: [{ key: 'item:10', namespace: 'item', id: 10,
				targetQuantity: 1, creditedQuantity: 0, basis: 'available', intendedUse: 'hold' }],
		}] })).toBe(false);
		expect(isInventoryAdvisorResultForInput(discardResult, { ...discardInput, keepExceptions: [{
			version: 1, exceptionId: 'keep-all-10', itemId: 10, status: 'active', basis: 'available',
			quantity: { mode: 'all' }, reason: 'user_keep',
		}] })).toBe(false);
		expect(isInventoryAdvisorResultForInput(discardResult, { ...discardInput,
			prices: { ...discardInput.prices, items: [{ ...discardInput.prices.items[0]!,
				bid: { unitCopper: 1, quantity: 1 } }] },
		})).toBe(false);
		expect(isInventoryAdvisorResultForInput(discardResult, { ...discardInput,
			accountSignals: { ...discardInput.accountSignals, unlockCoverage: 'partial' },
		})).toBe(false);
	});

	it('splits a physical stack by allocated quantity without double spending it', () => {
		const report = reportFixture();
		expect(report.lines[0]!.positions).toHaveLength(1);
		expect(isInventoryAdvisorReport(report)).toBe(true);
		expect(isInventoryAdvisorReport({ ...report, lines: [{ ...report.lines[0]!, decisions: [
			{ ...report.lines[0]!.decisions[0]!, quantity: 2,
				allocations: [{ positionRef: '#/positions/10/0', quantity: 2 }] },
			report.lines[0]!.decisions[1]!,
		] }] })).toBe(false);
	});

	it('fails closed for hostile proxies at every public unknown boundary', () => {
		const hostile = new Proxy({}, {
			getPrototypeOf: () => { throw new Error('hostile prototype'); },
			ownKeys: () => { throw new Error('hostile keys'); },
			get: () => { throw new Error('hostile getter'); },
		});
		expect(() => isInventoryAdvisorInput(hostile)).not.toThrow();
		expect(() => isInventoryAdvisorReport(hostile)).not.toThrow();
		expect(() => isInventoryAdvisorResult(hostile)).not.toThrow();
		expect(() => isInventoryAdvisorResultForInput(hostile, hostile)).not.toThrow();
		expect(() => isInventoryRecommendationEnvelope(hostile)).not.toThrow();
		expect(isInventoryAdvisorInput(hostile)).toBe(false);
		expect(isInventoryAdvisorReport(hostile)).toBe(false);
		expect(isInventoryAdvisorResult(hostile)).toBe(false);
		expect(isInventoryAdvisorResultForInput(hostile, hostile)).toBe(false);
		expect(isInventoryRecommendationEnvelope(hostile)).toBe(false);
	});

	it('blocks economic actions in blocked results and rejects fingerprint drift', () => {
		const report = reportFixture();
		const envelope = createInventoryRecommendationEnvelope(report)!;
		expect(isInventoryAdvisorResult({
			status: 'blocked', report: { ...report, coverage: 'blocked' }, envelope,
		})).toBe(false);
		expect(isInventoryAdvisorResult({
			status: 'ready', report, envelope: { ...envelope, reportSha256: '0'.repeat(64) },
		})).toBe(false);
		expect(isInventoryAdvisorResult({
			status: 'invalid', reasons: [{ code: 'snapshot_invalid', itemId: null, goalId: null, ruleId: null }],
			report: null, envelope: null,
		})).toBe(true);
	});
});

function inputFixture(): InventoryAdvisorInputV1 {
	const snapshot = snapshotFixture();
	const catalog: CatalogResolution = {
		snapshotId: snapshot.snapshotId, locale: 'es', schemaVersion: PINNED_SCHEMA,
		resolvedAt: '2026-08-14T09:00:00.000Z',
		items: { '10': { kind: 'item', id: 10, name: 'Objeto 10', type: 'Trophy', rarity: 'Basic',
			level: 0, vendorValue: 1, flags: [], gameTypes: ['Pve'], restrictions: [] } },
		currencies: {}, materials: {}, warnings: [],
		coverage: { items: { '10': { status: 'resolved', source: 'network' } }, currencies: {}, materials: {} },
	};
	const rulePack = rulePackFixture();
	return {
		version: 1, asOf: '2026-08-14T09:05:00.000Z', snapshot, catalog,
		prices: {
			version: 1, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
			capturedAt: '2026-08-14T09:04:00.000Z', source: 'gw2-commerce-prices', schemaVersion: PINNED_SCHEMA,
			requestedItemIds: [10], status: 'complete', missingItemIds: [],
			items: [{ itemId: 10, whitelisted: true, bid: { unitCopper: 20, quantity: 50 },
				ask: { unitCopper: 25, quantity: 30 } }],
		},
		goals: [], keepExceptions: [],
		accountSignals: {
			version: 1, source: 'gw2-account-api', accountId: snapshot.accountId, capturedAt: '2026-08-14T09:03:00.000Z', schemaVersion: PINNED_SCHEMA,
			tradingPostAccess: 'full', unlockCoverage: 'complete', unlockedRecipes: [],
			endpointCoverage: {
				account: { status: 'complete', capturedAt: '2026-08-14T09:03:00.000Z', reason: null }, recipes: { status: 'complete', capturedAt: '2026-08-14T09:03:00.000Z', reason: null },
				skins: { status: 'complete', capturedAt: '2026-08-14T09:03:00.000Z', reason: null }, minis: { status: 'complete', capturedAt: '2026-08-14T09:03:00.000Z', reason: null },
				achievements: { status: 'complete', capturedAt: '2026-08-14T09:03:00.000Z', reason: null },
			},
			unlockedSkins: [], unlockedMinis: [], achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
		},
		rulePack,
		policy: { version: 1, maxSnapshotAgeMs: 604_800_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000,
			maxAccountSignalsAgeMs: 604_800_000, maxRulePackAgeMs: 15_552_000_000,
			maxFutureSkewMs: 300_000, listingMinimumAdvantageBps: 1_000 },
	};
}

function reportFixture(): InventoryAdvisorReportV1 {
	const rulePack = rulePackFixture();
	return {
		version: 1, scope: 'supported_storage_v1', accountId: 'account-1', snapshotId: 'snapshot-1',
		asOf: '2026-08-14T09:05:00.000Z', coverage: 'complete',
		rulePack,
		reasons: [],
		lines: [{
			itemId: 10, name: 'Objeto 10', ownedQuantity: 2, availableQuantity: 2,
			positions: [{ ref: '#/positions/10/0', holdingIndex: 0, itemId: 10, quantity: 2,
				source: 'materials', state: 'loose' }],
			coverage: { snapshot: 'complete', inventory: 'complete', catalog: 'complete', prices: 'complete',
				reservations: 'complete', accountSignals: 'complete', rules: 'complete' },
			reservedQuantity: 1, exceptionQuantity: 0, retainedQuantity: 0, actionedQuantity: 1, unclassifiedQuantity: 0,
			decisions: [
				{ action: 'keep', itemId: 10, quantity: 1,
					allocations: [{ positionRef: '#/positions/10/0', quantity: 1 }],
					explanationRef: '#/explanations/keep', ruleId: null, safety: 'manual_only', discardProof: null },
				{ action: 'vendor', itemId: 10, quantity: 1,
					allocations: [{ positionRef: '#/positions/10/0', quantity: 1 }],
					explanationRef: '#/explanations/vendor', ruleId: null, safety: 'manual_only', discardProof: null },
			],
			reasons: [{ code: 'alternative_route_exists', itemId: 10, goalId: null, ruleId: null },
				{ code: 'reserved_for_goal', itemId: 10, goalId: 'goal-1', ruleId: null }],
		}],
		explanations: [
			{ ref: '#/explanations/keep', itemId: 10, action: 'keep', reasonCodes: ['reserved_for_goal'],
				evidenceRefs: ['#/evidence/reservations'], ruleId: null },
			{ ref: '#/explanations/vendor', itemId: 10, action: 'vendor', reasonCodes: ['alternative_route_exists'],
				evidenceRefs: ['#/evidence/catalog'], ruleId: null },
		],
	};
}

function rulePackFixture(): InventoryAdvisorRulePackV1 {
	const rulePack: InventoryAdvisorRulePackV1 = {
		schemaVersion: 1, id: 'official-mvp', version: 1,
		publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z',
		validUntil: '2027-01-01T00:00:00.000Z', sha256: '0'.repeat(64),
		sources: [{ id: 'gw2-items', url: 'https://wiki.guildwars2.com/wiki/API:2/items',
			retrievedAt: '2026-08-01T00:00:00.000Z' }],
		rules: [{ ruleId: 'discard-10', itemId: 10, action: 'discard_candidate', status: 'approved', assertion: 'applicable',
			reason: 'curated_discard_review', sourceIds: ['gw2-items'] }],
	};
	rulePack.sha256 = sha256InventoryRulePack(rulePack);
	return rulePack;
}

function snapshotFixture(): StorageSnapshot {
	const coverage: SnapshotCoverage = {
		sources: {
			characters: { status: 'complete' }, shared_inventory: { status: 'complete' },
			bank: { status: 'complete' }, materials: { status: 'complete' }, wallet: { status: 'complete' },
			commerce_delivery: { status: 'complete' },
		},
		characters: {},
	};
	return {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T09:00:00.000Z',
		completedAt: '2026-08-14T09:00:01.000Z', passCoverages: [coverage, coverage], quality: 'stable',
		passes: 2, schemaVersion: PINNED_SCHEMA,
		holdings: [{ kind: 'item', itemId: 10, quantity: 2, state: 'loose',
			location: { source: 'materials', category: 7 }, metadata: {} }],
		currencies: [], availableByItem: { '10': 2 }, ownedByItem: { '10': 2 }, currencyById: {},
		coverage, roster: [],
	};
}
