import { describe, expect, it, vi } from 'vitest';

import { PINNED_SCHEMA, type SnapshotCoverage, type StorageSnapshot } from '../account/storage-snapshot-model';
import { MissingApiKeyError } from '../account/guild-wars-2-client';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { InventoryAdvisorEvidenceService } from './inventory-advisor-evidence';
import { createInventoryAdvisorInputFromEvidence, isInventoryAdvisorEvidence } from './inventory-advisor-evidence-contract';
import type { InventoryAdvisorCaptureReceiptV1 } from './inventory-advisor-evidence-model';
import { isAccountSignals, sha256InventoryRulePack } from './inventory-advisor-contract';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

describe('InventoryAdvisorEvidenceService H4.14', () => {
	it('captures all owned catalog IDs, all available prices and account signals without mutating positions', async () => {
		const snapshot = snapshotFixture([10, 11]);
		const before = structuredClone(snapshot);
		const service = serviceFor(snapshot, catalogFor(snapshot), publicGateway((ids) => ids.map((id) => pricePayload(id))));

		const result = await service.capture('es');

		expect(result.status).toBe('complete');
		expect(result.evidence).toMatchObject({ accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
			schemaVersion: PINNED_SCHEMA, coverage: { catalog: 'complete', prices: 'complete', accountSignals: 'complete' } });
		expect(result.evidence?.catalog.coverage.items).toHaveProperty('10');
		expect(result.evidence?.catalog.coverage.items).toHaveProperty('11');
		expect(result.evidence?.prices.requestedItemIds).toEqual([10, 11]);
		expect(result.evidence?.accountSignals).toMatchObject({ unlockedRecipes: [1, 2], unlockedSkins: [3], unlockedMinis: [4] });
		expect(isInventoryAdvisorEvidence(result.evidence)).toBe(true);
		expect(snapshot).toEqual(before);
	});

	it('forwards many live progress ticks but writes exactly one local receipt, however many characters resolve', async () => {
		const snapshot = snapshotFixture([10, 11]);
		const storageTicks: number[] = [];
		const captureInventoryWithOperation = vi.fn(async (
			_operation: unknown,
			onProgress?: (progress: {
				roster: { completed: number; total: number };
				accountStores: { completed: number; total: number };
				characters: { completed: number; total: number };
			}) => void,
		) => {
			for (let completed = 0; completed <= 40; completed += 1) {
				onProgress?.({ roster: { completed: 1, total: 1 }, accountStores: { completed: 3, total: 3 }, characters: { completed, total: 40 } });
				storageTicks.push(completed);
			}
			return snapshot;
		});
		const receipts: unknown[] = [];
		const service = new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			{ captureInventoryWithOperation }, { resolve: async () => catalogFor(snapshot) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW,
			async (receipt) => { receipts.push(receipt); },
		);
		const seenProgress: unknown[] = [];
		await service.capture('es', [], (progress) => seenProgress.push(progress));

		expect(storageTicks).toHaveLength(41);
		expect(seenProgress.length).toBeGreaterThan(10);
		// The one local diagnostic receipt (never a vault write) lands exactly once per
		// capture call — never once per tick, never once per character.
		expect(receipts).toHaveLength(1);
	});

	it('captures a fresh identity-bound sibling batch for the sack and eight H4.7 outcomes', async () => {
		const snapshot = snapshotFixture([36_038]);
		const calls: number[][] = [];
		const gateway = publicGateway((ids) => { calls.push(ids); return ids.map((id) => pricePayload(id)); });
		const requested = [36_038, 36_041, 36_059, 36_060, 36_061, 79_673, 79_677, 79_679, 89_002];
		const result = await serviceFor(snapshot, catalogFor(snapshot, 'en'), gateway).capture('en', requested);
		expect(calls).toEqual([[36_038], requested]);
		expect(result.status).toBe('complete');
		expect(result.containerPrices).toMatchObject({
			accountId: snapshot.accountId,
			snapshotId: snapshot.snapshotId,
			capturedAt: '2026-08-14T12:00:00.000Z',
			status: 'complete',
			requestedItemIds: requested,
			missingItemIds: [],
		});
		expect(result.containerPrices?.items.map((item) => item.itemId)).toEqual(requested);
		await expect(serviceFor(snapshot, catalogFor(snapshot, 'en'), gateway).capture('en', [...requested].reverse()))
			.resolves.toEqual({ status: 'invalid', evidence: null, containerPrices: null });
	});

	it('rejects tampered wrapper keys and identity links', async () => {
		const snapshot = snapshotFixture([10, 11]);
		const result = await serviceFor(snapshot, catalogFor(snapshot), publicGateway((ids) => ids.map((id) => pricePayload(id)))).capture('es');
		const evidence = result.evidence!;
		expect(isInventoryAdvisorEvidence({ ...evidence, hidden: true })).toBe(false);
		expect(isInventoryAdvisorEvidence({ ...evidence, accountSignals: { ...evidence.accountSignals, accountId: 'other' } })).toBe(false);
		expect(isInventoryAdvisorEvidence({ ...evidence, locale: 'en' })).toBe(false);
		expect(isInventoryAdvisorEvidence({ ...evidence, ttl: { ...evidence.ttl, pricesMs: 1 } })).toBe(false);
		expect(isInventoryAdvisorEvidence({ ...evidence, coverage: { ...evidence.coverage, prices: 'unavailable' } })).toBe(false);
		expect(isInventoryAdvisorEvidence({ ...evidence, snapshot: { ...evidence.snapshot, holdings: [] } })).toBe(false);
		const swapped = { ...evidence.snapshot, holdings: [...evidence.snapshot.holdings].reverse() };
		expect(isInventoryAdvisorEvidence({ ...evidence, snapshot: swapped })).toBe(false);
		expect(isInventoryAdvisorEvidence({ ...evidence, finishedAt: 'not-an-instant' })).toBe(false);
		const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile'); } });
		expect(isInventoryAdvisorEvidence(hostile)).toBe(false);
	});

	it('keeps completed achievements without bits and preserves valid bit zero', async () => {
		const snapshot = snapshotFixture([10]);
		const evidence = (await serviceFor(snapshot, catalogFor(snapshot), publicGateway((ids) => ids.map((id) => pricePayload(id)))).capture('es')).evidence!;
		const signals = { ...evidence.accountSignals, completedAchievementBits: { '8': [0] }, achievementProgress: [
			{ achievementId: 7, done: true, current: null, max: null, repeated: null, bits: null },
			{ achievementId: 8, done: true, current: 0, max: 0, repeated: 0, bits: [0] },
		] };
		expect(isAccountSignals(signals)).toBe(true);
		expect(isAccountSignals({ ...signals, completedAchievementBits: { '7': [] } })).toBe(false);
		expect(isAccountSignals({ ...signals, unlockedRecipes: null })).toBe(false);
		expect(isAccountSignals({ ...signals, endpointCoverage: { ...signals.endpointCoverage, recipes: { ...signals.endpointCoverage.recipes, reason: 'request_failed' } } })).toBe(false);
	});

	it('uses only detailed 200 private responses and canonicalizes successful endpoint arrays', async () => {
		const snapshot = snapshotFixture([10]);
		const request = vi.fn(async () => { throw new Error('request must not be used'); });
		const operation = {
			request,
			requestDetailed: async (path: string) => {
				if (path === 'tokeninfo') return { status: 200, headers: {}, body: { id: 'token', name: 'test', permissions: ['account', 'unlocks', 'progression'] } };
				if (path === 'account') return { status: 200, headers: {}, body: { id: 'account-1', name: 'Account', world: 1, created: '2020-01-01T00:00:00.000Z', access: ['GuildWars2'], commander: false } };
				if (path.startsWith('account/recipes')) return { status: 200, headers: {}, body: [2, 1] };
				if (path.startsWith('account/skins')) return { status: 206, headers: {}, body: [3] };
				if (path.startsWith('account/minis')) return { status: 200, headers: {}, body: [4] };
				return { status: 200, headers: {}, body: [{ id: 7, done: true }] };
			},
		};
		const result = await new InventoryAdvisorEvidenceService({ beginOperation: () => operation }, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW).capture('es');
		expect(result.evidence?.accountSignals).toMatchObject({ unlockedRecipes: [1, 2], unlockedSkins: null, unlockedMinis: [4], completedAchievementBits: {}, achievementProgress: [{ achievementId: 7, done: true, bits: null }] });
		expect(result.evidence?.accountSignals.achievementCoverage).toBe('complete');
		expect(result.evidence?.accountSignals.endpointCoverage.skins).toMatchObject({ status: 'unavailable', capturedAt: null, reason: 'request_failed' });
		expect(request).not.toHaveBeenCalled();
	});

	it('coalesces same-locale capture and begins a new operation after completion', async () => {
		const snapshot = snapshotFixture([10]);
		const base = clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined });
		const beginOperation = vi.fn(base.beginOperation);
		const service = new InventoryAdvisorEvidenceService({ beginOperation }, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW);
		await Promise.all([service.capture('es'), service.capture('es')]);
		expect(beginOperation).toHaveBeenCalledTimes(1);
		await service.capture('es');
		expect(beginOperation).toHaveBeenCalledTimes(2);
	});

	it('retries one transient partial snapshot before any catalog or price work, but not a capability limitation', async () => {
		const transient = snapshotFixture([10]);
		transient.quality = 'partial';
		transient.coverage.sources.bank = { status: 'partial', reason: 'partial_response' };
		const stable = snapshotFixture([10]);
		const captureInventoryWithOperation = vi.fn()
			.mockResolvedValueOnce(transient)
			.mockResolvedValueOnce(stable);
		const service = new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			{ captureInventoryWithOperation }, { resolve: async () => catalogFor(stable) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW,
		);
		expect(await service.capture('es')).toMatchObject({ status: 'complete', evidence: { snapshot: { quality: 'stable' } } });
		expect(captureInventoryWithOperation).toHaveBeenCalledTimes(2);

		const limited = snapshotFixture([10]);
		limited.coverage.sources.bank = { status: 'skipped', reason: 'missing_scope' };
		const limitedCapture = vi.fn(async () => limited);
		await new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			{ captureInventoryWithOperation: limitedCapture }, { resolve: async () => catalogFor(limited) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW,
		).capture('es');
		expect(limitedCapture).toHaveBeenCalledOnce();
	});

	it('uses the latest fully covered unstable pass as limited manual evidence', async () => {
		const unstable = snapshotFixture([10]);
		unstable.quality = 'unstable';
		unstable.passes = 3;
		unstable.passCoverages = [unstable.coverage, unstable.coverage, unstable.coverage];
		const captureInventoryWithOperation = vi.fn(async () => unstable);
		const service = new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			{ captureInventoryWithOperation }, { resolve: async () => catalogFor(unstable) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW,
		);

		await expect(service.capture('es')).resolves.toMatchObject({
			status: 'partial',
			evidence: { snapshot: { quality: 'unstable' }, coverage: { snapshot: 'partial' } },
		});
		expect(captureInventoryWithOperation).toHaveBeenCalledOnce();
	});

	it('reports incomplete coverage separately from a malformed snapshot', async () => {
		const incomplete = snapshotFixture([10]);
		incomplete.quality = 'partial';
		incomplete.coverage.sources.characters = {
			status: 'partial',
			reason: 'unavailable',
			diagnostic: { kind: 'http', status: 429, retryAfterMs: 2_000 },
		};
		incomplete.coverage.characters = {
			'Private Character Name': {
				status: 'partial',
				reason: 'missing_character',
				diagnostic: { kind: 'http', status: 404, retryAfterMs: null },
			},
		};
		incomplete.roster = ['Private Character Name'];
		incomplete.passCoverages = [
			structuredClone(incomplete.coverage),
			structuredClone(incomplete.coverage),
		];
		const incompleteCapture = vi.fn(async () => incomplete);
		const receipt = vi.fn<(value: InventoryAdvisorCaptureReceiptV1) => void>();
		const incompleteService = new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			{ captureInventoryWithOperation: incompleteCapture }, { resolve: async () => catalogFor(incomplete) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW, receipt,
		);
		await expect(incompleteService.capture('es')).resolves.toEqual({
			status: 'invalid', evidence: null, failure: 'snapshot_coverage_incomplete',
		});
		expect(receipt).toHaveBeenCalledOnce();
		expect(receipt).toHaveBeenCalledWith({
			version: 1,
			recordedAt: '2026-08-14T12:00:00.000Z',
			status: 'invalid',
			failure: 'snapshot_coverage_incomplete',
			evidenceCoverage: null,
			evidenceDetails: null,
			containerPrices: 'not_requested',
			workflow: null,
			snapshot: {
				quality: 'partial',
				passes: 2,
				durationMs: 1_000,
				roster: {
					status: 'partial', reason: 'unavailable',
					diagnostic: { kind: 'http', status: 429, retryAfterMs: 2_000 },
				},
				sharedInventory: { status: 'complete' },
				bank: { status: 'complete' },
				materials: { status: 'complete' },
				commerceDelivery: { status: 'complete' },
				characterInventories: [{
					status: 'partial', reason: 'missing_character',
					diagnostic: { kind: 'http', status: 404, retryAfterMs: null },
				}],
				attempts: [
					{
						roster: {
							status: 'partial', reason: 'unavailable',
							diagnostic: { kind: 'http', status: 429, retryAfterMs: 2_000 },
						},
						sharedInventory: { status: 'complete' },
						bank: { status: 'complete' },
						materials: { status: 'complete' },
						commerceDelivery: { status: 'complete' },
						characterInventories: [{
							status: 'partial', reason: 'missing_character',
							diagnostic: { kind: 'http', status: 404, retryAfterMs: null },
						}],
					},
					{
						roster: {
							status: 'partial', reason: 'unavailable',
							diagnostic: { kind: 'http', status: 429, retryAfterMs: 2_000 },
						},
						sharedInventory: { status: 'complete' },
						bank: { status: 'complete' },
						materials: { status: 'complete' },
						commerceDelivery: { status: 'complete' },
						characterInventories: [{
							status: 'partial', reason: 'missing_character',
							diagnostic: { kind: 'http', status: 404, retryAfterMs: null },
						}],
					},
				],
			},
		});
		const serializedReceipt = JSON.stringify(receipt.mock.calls);
		expect(serializedReceipt).not.toMatch(/account-1|Private Character Name|snapshot-1|Item 10/u);

		const malformed = snapshotFixture([10]);
		malformed.holdings = [];
		const malformedService = new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			snapshotCapture(malformed), { resolve: async () => catalogFor(malformed) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW,
		);
		await expect(malformedService.capture('es')).resolves.toEqual({
			status: 'invalid', evidence: null, failure: 'snapshot_structure_invalid',
		});
	});

	it('does not let a failed local receipt write block or alter capture', async () => {
		const snapshot = snapshotFixture([10]);
		const service = new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW,
			async () => { throw new Error('local receipt unavailable'); },
		);
		await expect(service.capture('es')).resolves.toMatchObject({ status: 'complete' });
	});

	it('records optional-store coverage without account, item, character, URL, or response data', async () => {
		const snapshot = snapshotFixture([10]);
		snapshot.coverage.sources.bank = {
			status: 'partial', reason: 'unavailable',
			diagnostic: { kind: 'http', status: 403, retryAfterMs: null },
		};
		snapshot.coverage.sources.materials = { status: 'skipped', reason: 'missing_scope' };
		snapshot.coverage.sources.commerce_delivery = { status: 'skipped', reason: 'url_restricted' };
		snapshot.passCoverages = [structuredClone(snapshot.coverage)];
		const receipt = vi.fn<(value: InventoryAdvisorCaptureReceiptV1) => void>();
		const service = new InventoryAdvisorEvidenceService(
			clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }),
			snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) },
			publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW, receipt,
		);

		await service.capture('es');

		expect(receipt.mock.calls[0]?.[0]).toMatchObject({
			snapshot: {
				bank: { status: 'partial', reason: 'unavailable', diagnostic: { kind: 'http', status: 403, retryAfterMs: null } },
				materials: { status: 'skipped', reason: 'missing_scope' },
				commerceDelivery: { status: 'skipped', reason: 'url_restricted' },
				attempts: [{
					bank: { status: 'partial', reason: 'unavailable', diagnostic: { kind: 'http', status: 403, retryAfterMs: null } },
					materials: { status: 'skipped', reason: 'missing_scope' },
					commerceDelivery: { status: 'skipped', reason: 'url_restricted' },
				}],
			},
		});
		expect(JSON.stringify(receipt.mock.calls)).not.toMatch(/account-1|Item 10|Private Character Name|\/v2\//u);
	});

	it('keeps missing scopes and URL-restricted signals null without calling their endpoints', async () => {
		const snapshot = snapshotFixture([10]);
		const request = vi.fn(async (path: string): Promise<unknown> => {
			if (path === 'tokeninfo') return { id: 'token', name: 'test', permissions: ['account', 'unlocks'], urls: ['/v2/tokeninfo', '/v2/account', '/v2/account/recipes'] };
			if (path === 'account') return { id: 'account-1', name: 'Account', world: 1, created: '2020-01-01T00:00:00.000Z', access: ['GuildWars2'], commander: false };
			if (path.startsWith('account/recipes')) return [];
			throw new Error(`unexpected ${path}`);
		});
		const operation = { request, requestDetailed: async (path: string) => ({ status: 200, headers: {}, body: await request(path) }) };
		const service = new InventoryAdvisorEvidenceService({ beginOperation: () => operation }, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW);
		const result = await service.capture('es');
		expect(result.evidence?.accountSignals).toMatchObject({ unlockedRecipes: [], unlockedSkins: null, unlockedMinis: null, completedAchievementBits: null, achievementProgress: null });
		expect(request.mock.calls.map(([path]) => path)).not.toContain('account/skins?v=2024-07-20T01%3A00%3A00.000Z');
		expect(request.mock.calls.map(([path]) => path)).not.toContain('account/achievements?v=2024-07-20T01%3A00%3A00.000Z');
	});

	it('distinguishes identity mismatch from unavailable authenticated context', async () => {
		const snapshot = snapshotFixture([10]);
		const identityRequest = async (path: string): Promise<unknown> => path === 'tokeninfo'
			? { id: 'token', name: 'test', permissions: ['account'] }
			: { id: 'other-account', name: 'Account', world: 1, created: '2020-01-01T00:00:00.000Z', access: [], commander: false };
		const identityOperation = { request: identityRequest, requestDetailed: async (path: string) => ({ status: 200, headers: {}, body: await identityRequest(path) }) };
		const mismatch = new InventoryAdvisorEvidenceService({ beginOperation: () => identityOperation }, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW);
		expect(await mismatch.capture('es')).toEqual({ status: 'invalid', evidence: null, failure: 'identity_mismatch' });
		const unavailable = new InventoryAdvisorEvidenceService({ beginOperation: () => ({ request: async () => { throw new Error('offline'); }, requestDetailed: async () => { throw new Error('unused'); } }) }, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW);
		expect(await unavailable.capture('es')).toEqual({ status: 'unavailable', evidence: null });
	});

	it('reports a removed SecretStorage selection without exposing its name or value', async () => {
		const snapshot = snapshotFixture([10]);
		const service = new InventoryAdvisorEvidenceService(
			{ beginOperation: () => { throw new MissingApiKeyError(); } }, snapshotCapture(snapshot),
			{ resolve: async () => catalogFor(snapshot) }, publicGateway(() => []), () => NOW,
		);
		expect(await service.capture('es')).toEqual({ status: 'unavailable', evidence: null, failure: 'missing_key' });
	});

	it('keeps proven null bid/ask, reports partial coverage and never substitutes inaccessible signals with empty arrays', async () => {
		const snapshot = snapshotFixture([10, 11]);
	const client = clientFor({ permissions: ['account', 'unlocks'], urls: undefined });
		const service = new InventoryAdvisorEvidenceService(client, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot, 'en') },
			publicGateway((ids) => ids.filter((id) => id === 10).map((id) => pricePayload(id, true))), () => NOW);

		const result = await service.capture('en');

		expect(result.status).toBe('partial');
		expect(result.evidence?.prices).toMatchObject({ status: 'partial', missingItemIds: [11], items: [{ bid: null, ask: null }] });
		expect(result.evidence?.accountSignals).toMatchObject({ unlockCoverage: 'complete', achievementCoverage: 'unavailable', completedAchievementBits: null });
	});

	it('keeps 0/0 and one-sided public quotes as complete demonstrated price evidence', async () => {
		const snapshot = snapshotFixture([10]);
		const gateway = publicGateway(() => [{ id: 10, whitelisted: true, buys: { quantity: 0, unit_price: 0 }, sells: { quantity: 1, unit_price: 12 } }]);
		const result = await serviceFor(snapshot, catalogFor(snapshot), gateway).capture('es');
		expect(result.evidence?.prices).toMatchObject({ status: 'complete', missingItemIds: [], items: [{ bid: null, ask: { unitCopper: 12 } }] });
	});

	it('accepts a 206 price batch and marks only omitted non-tradeable items missing', async () => {
		const snapshot = snapshotFixture([10, 11]);
		const gateway: PublicCatalogGateway = {
			requestDetailed: async () => ({ status: 206, headers: {}, body: [pricePayload(10)] }),
		};

		const result = await serviceFor(snapshot, catalogFor(snapshot), gateway).capture('es');

		expect(result.evidence?.prices).toMatchObject({
			status: 'partial',
			items: [{ itemId: 10 }],
			missingItemIds: [11],
		});
	});

	it('builds the H4.13 input from captured evidence without an external snapshot', async () => {
		const snapshot = snapshotFixture([10]);
		const evidence = (await serviceFor(snapshot, catalogFor(snapshot), publicGateway((ids) => ids.map((id) => pricePayload(id)))).capture('es')).evidence!;
		const rulePack = { schemaVersion: 1 as const, id: 'rules', version: 1, publishedAt: '2026-08-01T00:00:00.000Z', reviewedAt: '2026-08-02T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', sha256: '', sources: [], rules: [] };
		rulePack.sha256 = sha256InventoryRulePack(rulePack);
		const policy = { version: 1 as const, maxSnapshotAgeMs: 900_000, maxPriceAgeMs: 900_000, maxCatalogAgeMs: 604_800_000, maxAccountSignalsAgeMs: 86_400_000, maxRulePackAgeMs: 15_552_000_000, maxFutureSkewMs: 300_000, listingMinimumAdvantageBps: 1_000 };
		expect(createInventoryAdvisorInputFromEvidence({ asOf: '2026-08-14T12:00:00.000Z', evidence, goals: [], keepExceptions: [], rulePack, policy })).not.toBeNull();
		expect(createInventoryAdvisorInputFromEvidence({ asOf: '2026-08-14T12:00:00.000Z', evidence, goals: [], keepExceptions: [], rulePack, policy: { ...policy, maxPriceAgeMs: evidence.ttl.pricesMs + 1 } })).toBeNull();
	});

	it('marks limited storage or stale catalog sources partial instead of globally complete', async () => {
		const limited = snapshotFixture([10]);
		limited.coverage.sources.commerce_delivery = { status: 'partial', reason: 'unavailable' };
		expect((await serviceFor(limited, catalogFor(limited), publicGateway((ids) => ids.map((id) => pricePayload(id)))).capture('es')).status).toBe('partial');
		const snapshot = snapshotFixture([10]);
		const stale = catalogFor(snapshot);
		stale.coverage.items['10'] = { status: 'resolved', source: 'cache_stale' };
		expect((await serviceFor(snapshot, stale, publicGateway((ids) => ids.map((id) => pricePayload(id)))).capture('es')).status).toBe('partial');
	});

	it('preserves a successful second price batch and marks failed or corrupt batches missing', async () => {
		const snapshot = snapshotFixture(Array.from({ length: 201 }, (_, index) => index + 1));
		let call = 0;
		const mixed: PublicCatalogGateway = { requestDetailed: async (path) => { call += 1; if (call === 1) throw new Error('offline'); return { status: 200, headers: {}, body: idsFrom(path).map((id) => pricePayload(id)) }; } };
		const partial = await serviceFor(snapshot, catalogFor(snapshot), mixed).capture('es');
		expect(partial.evidence?.prices).toMatchObject({ status: 'partial', missingItemIds: Array.from({ length: 200 }, (_, index) => index + 1) });
		const unavailable: PublicCatalogGateway = { requestDetailed: async () => { throw new Error('offline'); } };
		expect((await serviceFor(snapshotFixture([10]), catalogFor(snapshotFixture([10])), unavailable).capture('es')).evidence?.prices.status).toBe('unavailable');
		const unexpected: PublicCatalogGateway = { requestDetailed: async () => ({ status: 200, headers: {}, body: [pricePayload(10), pricePayload(99)] }) };
		expect((await serviceFor(snapshotFixture([10]), catalogFor(snapshotFixture([10])), unexpected).capture('es')).evidence?.prices).toMatchObject({ status: 'unavailable', missingItemIds: [10] });
		const malformed: PublicCatalogGateway = { requestDetailed: async () => ({ status: 200, headers: {}, body: [{ id: 10, whitelisted: true, buys: { quantity: 'bad', unit_price: 1 }, sells: { quantity: 1, unit_price: 2 } }] }) };
		expect((await serviceFor(snapshotFixture([10]), catalogFor(snapshotFixture([10])), malformed).capture('es')).evidence?.prices).toMatchObject({ status: 'unavailable', missingItemIds: [10] });
	});

	it('fails closed when a catalog port returns a mismatched locale, identity or coverage', async () => {
		const snapshot = snapshotFixture([10]);
		const validCatalog = catalogFor(snapshot);
		const corruptions: Array<[CatalogResolution, string]> = [
			[{ ...validCatalog, locale: 'en' }, 'cross_reference_invalid'],
			[{ ...validCatalog, snapshotId: 'other-snapshot' }, 'cross_reference_invalid'],
			[{ ...validCatalog, coverage: { ...validCatalog.coverage, items: {} } }, 'catalog_invalid'],
			[{ ...validCatalog, items: {} }, 'catalog_invalid'],
		];
		for (const [corrupt, failure] of corruptions) {
			expect(await new InventoryAdvisorEvidenceService(clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }), snapshotCapture(snapshot), { resolve: async () => corrupt }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW).capture('es')).toEqual({ status: 'invalid', evidence: null, failure });
		}
	});

	it('treats PlayForFree plus a paid entitlement as full account access', async () => {
		const snapshot = snapshotFixture([10]);
		const client = clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined, access: ['PlayForFree', 'GuildWars2'] });
		const result = await new InventoryAdvisorEvidenceService(client, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW).capture('es');
		expect(result.evidence?.accountSignals.tradingPostAccess).toBe('full');
	});

	it.each([
		[['PlayForFree'], 'free_to_play'],
		[[], 'unknown'],
	])('derives %s access conservatively from account access', async (access, expected) => {
		const snapshot = snapshotFixture([10]);
		const client = clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined, access });
		const result = await new InventoryAdvisorEvidenceService(client, snapshotCapture(snapshot), { resolve: async () => catalogFor(snapshot) }, publicGateway((ids) => ids.map((id) => pricePayload(id))), () => NOW).capture('es');
		expect(result.evidence?.accountSignals.tradingPostAccess).toBe(expected);
	});

	it('batches all available ids at 200 and fails closed on duplicate price records', async () => {
		const snapshot = snapshotFixture(Array.from({ length: 201 }, (_, index) => index + 1));
		const calls: number[][] = [];
		const gateway = publicGateway((ids) => {
			calls.push(ids);
			return ids[0] === 1 ? [pricePayload(1), pricePayload(1), ...ids.slice(1).map((id) => pricePayload(id))] : ids.map((id) => pricePayload(id));
		});
		const result = await serviceFor(snapshot, catalogFor(snapshot), gateway).capture('es');

		expect(calls.map((ids) => ids.length)).toEqual([200, 1]);
		expect(result.status).toBe('partial');
		expect(result.evidence?.prices.missingItemIds).toEqual([1]);
	});

	it('does no public capture for an invalid or hostile snapshot', async () => {
		const beginOperation = vi.fn();
		const catalog = { resolve: vi.fn() };
		const gateway: PublicCatalogGateway = { requestDetailed: vi.fn() };
		const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile'); } }) as StorageSnapshot;
		const service = new InventoryAdvisorEvidenceService({ beginOperation }, snapshotCapture(hostile), catalog, gateway, () => NOW);

		await expect(service.capture('es')).resolves.toEqual({ status: 'invalid', evidence: null, failure: 'snapshot_structure_invalid' });
		expect(beginOperation).toHaveBeenCalledTimes(1);
		expect(catalog.resolve).not.toHaveBeenCalled();
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Vitest mock assertion.
		expect(gateway.requestDetailed).not.toHaveBeenCalled();
	});
});

function serviceFor(snapshot: StorageSnapshot, catalog: CatalogResolution, gateway: PublicCatalogGateway): InventoryAdvisorEvidenceService {
	return new InventoryAdvisorEvidenceService(clientFor({ permissions: ['account', 'tradingpost', 'unlocks', 'progression'], urls: undefined }), snapshotCapture(snapshot),
		{ resolve: async () => catalog }, gateway, () => NOW);
}

function snapshotCapture(snapshot: StorageSnapshot) { return { captureInventoryWithOperation: async () => snapshot }; }

function clientFor(options: { permissions: string[]; urls: string[] | undefined; access?: string[] }) {
	return {
		beginOperation: () => {
			const request = async (path: string): Promise<unknown> => {
				if (path === 'tokeninfo') return { id: 'token', name: 'test', permissions: options.permissions, ...(options.urls ? { urls: options.urls } : {}) };
				if (path === 'account') return { id: 'account-1', name: 'Account', world: 1, created: '2020-01-01T00:00:00.000Z', access: options.access ?? ['GuildWars2'], commander: false };
				if (path.startsWith('account/recipes')) return [1, 2];
				if (path.startsWith('account/skins')) return [3];
				if (path.startsWith('account/minis')) return [4];
				if (path.startsWith('account/achievements')) return [{ id: 7, done: true, current: 2, max: 2, repeated: 0, bits: [1, 2] }];
				throw new Error(`unexpected ${path}`);
			};
			return { request, requestDetailed: async (path: string) => ({ status: 200, headers: {}, body: await request(path) }) };
		},
	};
}

function publicGateway(response: (ids: number[]) => unknown[]): PublicCatalogGateway {
	return { requestDetailed: async (path) => ({ status: 200, headers: {}, body: response(idsFrom(path)) }) };
}
function idsFrom(path: string): number[] { return new URLSearchParams(path.split('?')[1]).get('ids')!.split(',').map(Number); }
function pricePayload(id: number, nullSides = false): Record<string, unknown> {
	return { id, whitelisted: true, buys: nullSides ? { quantity: 0, unit_price: 0 } : { quantity: 1, unit_price: id + 10 }, sells: nullSides ? { quantity: 0, unit_price: 0 } : { quantity: 1, unit_price: id + 11 } };
}

function catalogFor(snapshot: StorageSnapshot, locale: 'es' | 'en' = 'es'): CatalogResolution {
	const entries = Object.keys(snapshot.ownedByItem).map(Number);
	return { snapshotId: snapshot.snapshotId, locale, schemaVersion: PINNED_SCHEMA, resolvedAt: new Date(NOW).toISOString(),
		items: Object.fromEntries(entries.map((id) => [String(id), { kind: 'item' as const, id, name: `Item ${id}`, type: 'Trophy', rarity: 'Basic', level: 0, vendorValue: 1, flags: [], gameTypes: [], restrictions: [] }])),
		currencies: {}, materials: {}, warnings: [], coverage: { items: Object.fromEntries(entries.map((id) => [String(id), { status: 'resolved' as const, source: 'network' as const }])), currencies: {}, materials: {} } };
}

function snapshotFixture(ids: number[]): StorageSnapshot {
	const coverage: SnapshotCoverage = { sources: { characters: { status: 'complete' }, shared_inventory: { status: 'complete' }, bank: { status: 'complete' }, materials: { status: 'complete' }, wallet: { status: 'complete' }, commerce_delivery: { status: 'complete' } }, characters: {} };
	const holdings = ids.map((itemId, slot) => ({ kind: 'item' as const, itemId, quantity: 1, state: 'loose' as const, location: { source: 'bank' as const, slot }, metadata: {} }));
	const quantities = Object.fromEntries(ids.map((id) => [String(id), 1]));
	return { snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-08-14T11:59:00.000Z', completedAt: '2026-08-14T11:59:01.000Z', passCoverages: [coverage, coverage], quality: 'stable', passes: 2, schemaVersion: PINNED_SCHEMA, holdings, currencies: [], availableByItem: quantities, ownedByItem: quantities, currencyById: {}, coverage, roster: [] };
}
