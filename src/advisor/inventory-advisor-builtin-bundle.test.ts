import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PINNED_SCHEMA, type StorageSnapshot } from '../account/storage-snapshot-model';
import {
	createInventoryAdvisorBuiltinBundleProvider,
	inventoryAdvisorBuiltinBundleProvider,
	type InventoryAdvisorBuiltinBundleV1,
} from './inventory-advisor-builtin-bundle';
import {
	isInventoryAdvisorInput,
	isInventoryAdvisorPolicy,
	isInventoryAdvisorRulePack,
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

describe('inventory advisor H4.17 built-in review-only bundle', () => {
	it('loads the exact deterministic policy and empty review-only packs', () => {
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		expect(result.status).toBe('available');
		if (result.status !== 'available') return;
		expect(result.bundle).toEqual({
			version: 1,
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
				schemaVersion: 1,
				id: 'tc.inventory-rules.review-only',
				version: 1,
				publishedAt: '2026-08-14T00:00:00.000Z',
				reviewedAt: '2026-08-14T00:00:00.000Z',
				validUntil: '2026-11-12T00:00:00.000Z',
				sha256: '40e7a35d95f7b8bdf673e3afea50cd00dfe80509af60d93970811019d2697f08',
				sources: [],
				rules: [],
			},
			knowledgePack: {
				schemaVersion: 1,
				id: 'tc.inventory-knowledge.review-only',
				version: 1,
				publishedAt: '2026-08-14T00:00:00.000Z',
				reviewedAt: '2026-08-14T00:00:00.000Z',
				validUntil: '2026-11-12T00:00:00.000Z',
				sha256: 'bf734a70c9246759a649ea64512fcd0ec01cabaa9d98fcddcbd1369cfed14a73',
				sources: [],
				entries: [],
			},
		});
	});

	it('passes the authoritative validators and content hashes', () => {
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		if (result.status !== 'available') throw new Error('expected built-in bundle');
		expect(isInventoryAdvisorPolicy(result.bundle.policy)).toBe(true);
		expect(isInventoryAdvisorRulePack(result.bundle.rulePack)).toBe(true);
		expect(isInventoryKnowledgePack(result.bundle.knowledgePack)).toBe(true);
		expect(sha256InventoryRulePack(result.bundle.rulePack)).toBe(result.bundle.rulePack.sha256);
		expect(sha256InventoryKnowledgePack(result.bundle.knowledgePack)).toBe(result.bundle.knowledgePack.sha256);
		expect(result.bundle.rulePack).toMatchObject({
			publishedAt: '2026-08-14T00:00:00.000Z', reviewedAt: '2026-08-14T00:00:00.000Z',
			validUntil: '2026-11-12T00:00:00.000Z',
		});
		expect(result.bundle.knowledgePack).toMatchObject({
			publishedAt: '2026-08-14T00:00:00.000Z', reviewedAt: '2026-08-14T00:00:00.000Z',
			validUntil: '2026-11-12T00:00:00.000Z',
		});
	});

	it('binds the built-in bundle to a valid H4.15 input and stays review-only through H4.16', () => {
		const asOf = '2026-08-14T00:05:00.000Z';
		const loaded = inventoryAdvisorBuiltinBundleProvider.load(asOf);
		if (loaded.status !== 'available') throw new Error('expected built-in bundle');
		const input = advisorInput(loaded.bundle, asOf);
		expect(isInventoryAdvisorInput(input)).toBe(true);

		const engineInput = { input, knowledgePack: loaded.bundle.knowledgePack };
		const producerResult = classifyInventoryAdvisor(engineInput);
		expect(producerResult.status).toBe('ready');
		expect(isInventoryAdvisorResultForInput(producerResult, input)).toBe(true);
		const producerDecisions = producerResult.report?.lines.flatMap((line) => line.decisions) ?? [];
		expect(producerDecisions.length).toBeGreaterThan(0);
		expect(producerDecisions.every((decision) => decision.action === 'review')).toBe(true);

		const allowlistResult = applyInventoryDiscardAllowlist({ engineInput, producerResult });
		expect(allowlistResult.status).toBe('ready');
		expect(isInventoryDiscardAllowlistResultForInput(allowlistResult, { engineInput, producerResult })).toBe(true);
		const finalActions = allowlistResult.report?.lines.flatMap((line) => line.decisions.map((decision) => decision.action)) ?? [];
		expect(finalActions).toEqual(['review']);
		expect(finalActions).not.toContain('discard_candidate');
		expect(finalActions.some((action) => ['sell', 'list', 'vendor', 'salvage', 'use', 'open'].includes(action))).toBe(false);
	});

	it('returns isolated clones and remains deterministic across providers', () => {
		const first = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		const second = createInventoryAdvisorBuiltinBundleProvider().load(BEFORE_EXPIRY);
		expect(second).toEqual(first);
		if (first.status !== 'available') throw new Error('expected built-in bundle');
		first.bundle.policy.maxSnapshotAgeMs = 1;
		first.bundle.rulePack.sources.push({ id: 'mutated', url: 'https://example.invalid', retrievedAt: '2026-08-14T00:00:00Z' });
		const reloaded = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		expect(reloaded.status).toBe('available');
		if (reloaded.status === 'available') {
			expect(reloaded.bundle.policy.maxSnapshotAgeMs).toBe(900_000);
			expect(reloaded.bundle.rulePack.sources).toEqual([]);
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
		expect(isInventoryAdvisorRulePack(foreign.rulePack)).toBe(true);
		expect(isInventoryKnowledgePack(foreign.knowledgePack)).toBe(true);
		expect(createInventoryAdvisorBuiltinBundleProvider(foreign).load(BEFORE_EXPIRY)).toEqual({
			status: 'unavailable', reason: 'invalid', bundle: null,
		});
	});

	it.each(['es', 'en'])('is locale-neutral for %s', (locale) => {
		const result = createInventoryAdvisorBuiltinBundleProvider().load(BEFORE_EXPIRY);
		if (result.status !== 'available') throw new Error(`expected bundle for ${locale}`);
		expect(JSON.stringify(result.bundle)).not.toContain('locale');
		expect(result.bundle.rulePack.sha256).toBe('40e7a35d95f7b8bdf673e3afea50cd00dfe80509af60d93970811019d2697f08');
		expect(result.bundle.knowledgePack.sha256).toBe('bf734a70c9246759a649ea64512fcd0ec01cabaa9d98fcddcbd1369cfed14a73');
	});

	it('treats validUntil as an exclusive boundary and rejects invalid clocks', () => {
		expect(inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY).status).toBe('available');
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-11-12T00:00:00.000Z')).toEqual({
			status: 'unavailable', reason: 'expired', bundle: null,
		});
		expect(inventoryAdvisorBuiltinBundleProvider.load('2026-11-12T00:00:00.001Z')).toEqual({
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

	it('contains no curated IDs, F2P whitelist, clock read, operation or I/O capability', () => {
		const source = readFileSync('src/advisor/inventory-advisor-builtin-bundle.ts', 'utf8');
		expect(source).not.toContain('36038');
		expect(source).not.toContain('free_to_play');
		expect(source).not.toContain('whitelist');
		expect(source).not.toContain('Date.now');
		expect(source).not.toMatch(/\b(?:fetch|requestUrl|XMLHttpRequest|WebSocket|destroyItem|deleteItem|salvageItem|openContainer)\b/u);
		const result = inventoryAdvisorBuiltinBundleProvider.load(BEFORE_EXPIRY);
		expect(JSON.stringify(result)).not.toMatch(/"(?:action|executor|execution|sideEffects|requiresUserAction)"/u);
	});
});

function deepFreeze<T>(value: T): T {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

// Compile-time fixture: the public boundary returns data, not an execution interface.
const _bundleShape: InventoryAdvisorBuiltinBundleV1 | null = null;
void _bundleShape;

function advisorInput(bundle: InventoryAdvisorBuiltinBundleV1, asOf: string) {
	const capturedAt = '2026-08-14T00:04:00.000Z';
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-builtin', accountId: 'account-builtin',
		startedAt: capturedAt, completedAt: capturedAt, schemaVersion: PINNED_SCHEMA,
		quality: 'stable', passes: 2,
		holdings: [{ kind: 'item', itemId: 10, quantity: 2, state: 'loose', location: { source: 'bank', slot: 0 }, metadata: {} }],
		currencies: [], availableByItem: { '10': 2 }, ownedByItem: { '10': 2 }, currencyById: {}, roster: [],
		coverage: completeCoverage(), passCoverages: [completeCoverage(), completeCoverage()],
	};
	const endpoint = { status: 'complete' as const, capturedAt, reason: null };
	return {
		version: 1 as const, asOf, snapshot,
		catalog: {
			snapshotId: snapshot.snapshotId, locale: 'es' as const, schemaVersion: PINNED_SCHEMA, resolvedAt: capturedAt,
			items: { '10': { kind: 'item' as const, id: 10, name: 'Objeto sin regla', type: 'Trophy', rarity: 'Basic', level: 0,
				vendorValue: 100, flags: [], gameTypes: [], restrictions: [] } },
			currencies: {}, materials: {}, warnings: [],
			coverage: { items: { '10': { status: 'resolved' as const, source: 'network' as const } }, currencies: {}, materials: {} },
		},
		prices: {
			version: 1 as const, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
			capturedAt, source: 'gw2-commerce-prices' as const, schemaVersion: PINNED_SCHEMA,
			requestedItemIds: [10], status: 'complete' as const,
			items: [{ itemId: 10, whitelisted: true, bid: { unitCopper: 200, quantity: 2 }, ask: { unitCopper: 250, quantity: 2 } }],
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

function completeCoverage() {
	return { sources: {
		characters: { status: 'complete' as const }, shared_inventory: { status: 'complete' as const },
		bank: { status: 'complete' as const }, materials: { status: 'complete' as const },
		wallet: { status: 'complete' as const }, commerce_delivery: { status: 'complete' as const },
	}, characters: {} };
}
