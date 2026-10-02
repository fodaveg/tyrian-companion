import { describe, expect, it } from 'vitest';

import { completePassFixture } from '../account/__fixtures__/storage';
import type { HttpResponse } from '../core/http';
import type { StorageSnapshot } from '../account/storage-snapshot-model';
import { PINNED_SCHEMA } from '../account/storage-snapshot-model';
import { StorageSnapshotService } from '../account/storage-snapshot-service';
import type { CatalogResolution } from '../catalog/public-catalog-model';
import type { InventoryMarketDepthEvidenceV1 } from '../economy/commerce-listings';
import type { ReservationGoal } from '../economy/reservation-model';
import { sha256CanonicalValue } from './inventory-advisor-contract';
import { inventoryAdvisorEvidenceValidationFailure } from './inventory-advisor-evidence-contract';
import type { InventoryAdvisorEvidenceV1 } from './inventory-advisor-evidence-model';
import { inventoryAdvisorBuiltinBundleProvider } from './inventory-advisor-builtin-bundle';
import type { AccountSignalsV1, InventoryAdvisorResultV1, InventoryPriceSnapshotV1 } from './inventory-advisor-model';
import { isInventoryAdvisorResultForInput } from './inventory-advisor-result';
import {
	EMPTY_INVENTORY_ADVISOR_PREFERENCES,
	InventoryAdvisorWorkflow,
	createInventoryAdvisorBuiltinRulesProvider,
	type InventoryAdvisorWorkflowPorts,
} from './inventory-advisor-workflow';

/**
 * The advisor capture leaves the wallet out on purpose and still reads the Trading Post delivery
 * box, so coins waiting to be collected are a currency whose balance the capture does not fully
 * know. That currency is in the reservation plan of every analysis, asked for by no goal. These
 * tests go through the real workflow with the built-in bundle: the classifier, the result verifier
 * and the discard allowlist.
 */

const NOW = '2026-10-01T10:00:00.000Z';
const BASE = 9_000_000;
const TRADABLE_A = BASE + 1; // bid 100, ask 150, vendor 10
const TRADABLE_B = BASE + 2; // bid 3, ask 500, vendor 1
const BOUND_VENDOR = BASE + 3; // account bound, vendor 50, not on the Trading Post
const BOUND_NO_SELL = BASE + 4; // account bound, NoSell
const UNRESOLVED = BASE + 5; // the catalog did not resolve it

interface Shape {
	wallet: 'complete' | 'skipped';
	/** The shape of a real account: an object the catalog did not resolve and prices only for what trades. */
	partialEvidence: boolean;
	depth: 'absent' | 'partial';
	deliveryCoins: number;
}

function capture(shape: Shape): { evidence: InventoryAdvisorEvidenceV1; marketDepth: InventoryMarketDepthEvidenceV1 | undefined } {
	const itemIds = [TRADABLE_A, TRADABLE_B, BOUND_VENDOR, BOUND_NO_SELL, ...(shape.partialEvidence ? [UNRESOLVED] : [])];
	const coverage = () => ({ sources: {
		characters: { status: 'complete' as const }, shared_inventory: { status: 'complete' as const },
		bank: { status: 'complete' as const }, materials: { status: 'complete' as const },
		wallet: shape.wallet === 'complete' ? { status: 'complete' as const } : { status: 'skipped' as const, reason: 'not_requested' as const },
		commerce_delivery: { status: 'complete' as const },
	}, characters: {} });
	const bound = (id: number): boolean => id === BOUND_VENDOR || id === BOUND_NO_SELL;
	const snapshot: StorageSnapshot = {
		snapshotId: 'snapshot-1', accountId: 'account-1', startedAt: '2026-10-01T09:59:00.000Z',
		completedAt: '2026-10-01T09:59:01.000Z', schemaVersion: PINNED_SCHEMA, quality: 'stable', passes: 2,
		holdings: itemIds.map((itemId, slot) => ({ kind: 'item' as const, itemId, quantity: 5, state: 'loose' as const,
			location: { source: 'bank' as const, slot }, metadata: bound(itemId) ? { binding: 'Account' } : {} })),
		currencies: shape.deliveryCoins === 0 ? [] : [{ kind: 'currency', namespace: 'delivery', currencyId: 1, quantity: shape.deliveryCoins }],
		availableByItem: Object.fromEntries(itemIds.map((id) => [String(id), 5])),
		ownedByItem: Object.fromEntries(itemIds.map((id) => [String(id), 5])),
		currencyById: shape.deliveryCoins === 0 ? {} : { '1': { total: shape.deliveryCoins, wallet: 0, delivery: shape.deliveryCoins } },
		roster: [], coverage: coverage(), passCoverages: [coverage(), coverage()],
	};
	const priced = [
		{ itemId: TRADABLE_A, whitelisted: true, bid: { unitCopper: 100, quantity: 1000 }, ask: { unitCopper: 150, quantity: 1000 } },
		{ itemId: TRADABLE_B, whitelisted: true, bid: { unitCopper: 3, quantity: 1000 }, ask: { unitCopper: 500, quantity: 1000 } },
	];
	const unpriced = itemIds.filter((id) => id !== TRADABLE_A && id !== TRADABLE_B);
	const prices = {
		version: 1, accountId: 'account-1', snapshotId: 'snapshot-1', capturedAt: NOW, source: 'gw2-commerce-prices',
		schemaVersion: PINNED_SCHEMA, requestedItemIds: itemIds, status: shape.partialEvidence ? 'partial' : 'complete',
		items: shape.partialEvidence ? priced
			: [...priced, ...unpriced.map((itemId) => ({ itemId, whitelisted: false, bid: null, ask: null }))],
		missingItemIds: shape.partialEvidence ? unpriced : [],
	} as InventoryPriceSnapshotV1;
	const evidence = evidenceOf(snapshot, catalogOf(itemIds), prices, NOW);
	evidence.coverage = { snapshot: shape.wallet === 'complete' ? 'complete' : 'partial',
		catalog: shape.partialEvidence ? 'partial' : 'complete', prices: prices.status, accountSignals: 'complete' };
	const marketDepth: InventoryMarketDepthEvidenceV1 | undefined = shape.depth === 'absent' ? undefined : {
		version: 1, capturedAt: NOW, source: 'gw2-commerce-listings', requestedItemIds: itemIds, status: 'partial',
		items: itemIds.map((itemId) => {
			const price = priced.find((entry) => entry.itemId === itemId);
			return price === undefined ? { itemId, coverage: 'missing' as const, buys: [], sells: [] }
				: { itemId, coverage: 'complete' as const, buys: [{ ...price.bid }], sells: [{ ...price.ask }] };
		}),
	};
	return { evidence, marketDepth };
}

function catalogOf(itemIds: readonly number[]): CatalogResolution {
	const item = (id: number, flags: string[], vendorValue: number) => ({ kind: 'item' as const, id, name: `Item ${id}`,
		type: 'Trophy', rarity: 'Basic', level: 0, vendorValue, flags, gameTypes: [], restrictions: [] });
	const known: Record<number, ReturnType<typeof item>> = {
		[TRADABLE_A]: item(TRADABLE_A, [], 10), [TRADABLE_B]: item(TRADABLE_B, [], 1),
		[BOUND_VENDOR]: item(BOUND_VENDOR, ['AccountBound'], 50), [BOUND_NO_SELL]: item(BOUND_NO_SELL, ['AccountBound', 'NoSell'], 0),
	};
	const resolved = itemIds.filter((id) => id !== UNRESOLVED);
	return {
		snapshotId: 'snapshot-1', locale: 'es', schemaVersion: PINNED_SCHEMA, resolvedAt: NOW,
		items: Object.fromEntries(resolved.map((id) => [String(id), known[id] ?? item(id, [], 10)])),
		currencies: {}, materials: {}, warnings: [],
		coverage: { items: Object.fromEntries(itemIds.map((id) => [String(id), id === UNRESOLVED
			? { status: 'missing' as const, source: 'network' as const, reason: 'not_found' as const }
			: { status: 'resolved' as const, source: 'network' as const }])), currencies: {}, materials: {} },
	};
}

function evidenceOf(
	snapshot: StorageSnapshot, catalog: CatalogResolution, prices: InventoryPriceSnapshotV1, at: string,
): InventoryAdvisorEvidenceV1 {
	const endpoint = () => ({ status: 'complete' as const, capturedAt: at, reason: null });
	const accountSignals: AccountSignalsV1 = {
		version: 1, source: 'gw2-account-api', accountId: snapshot.accountId, capturedAt: at, schemaVersion: PINNED_SCHEMA,
		tradingPostAccess: 'full',
		endpointCoverage: { account: endpoint(), recipes: endpoint(), skins: endpoint(), minis: endpoint(), achievements: endpoint() },
		unlockCoverage: 'complete', unlockedRecipes: [], unlockedSkins: [], unlockedMinis: [],
		achievementCoverage: 'complete', completedAchievementBits: {}, achievementProgress: [],
	};
	return {
		version: 1, scope: 'supported_storage_v1', accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
		schemaVersion: snapshot.schemaVersion, capturedAt: snapshot.completedAt, finishedAt: at, locale: 'es', snapshot,
		snapshotFingerprint: sha256CanonicalValue(snapshot),
		ttl: { snapshotMs: 900_000, catalogMs: 604_800_000, pricesMs: 900_000, accountSignalsMs: 86_400_000 },
		coverage: { snapshot: 'partial', catalog: 'complete', prices: 'complete', accountSignals: 'complete' },
		catalog, prices, accountSignals,
	};
}

interface Analysed {
	status: InventoryAdvisorResultV1['status'];
	/** `<item>:<action>/<reason>` in report order, with the item as its offset from `BASE`. */
	decisions: string[];
	reasons: string[];
	actions: string[];
	/** The producer's result checked again by the public verifier, as a second reader would. */
	producerVerified: boolean;
}

async function analyse(
	evidence: InventoryAdvisorEvidenceV1,
	marketDepth: InventoryMarketDepthEvidenceV1 | undefined,
	now: string,
	goals: ReservationGoal[] = [],
): Promise<Analysed> {
	expect(inventoryAdvisorEvidenceValidationFailure(evidence)).toBeNull();
	const ports: InventoryAdvisorWorkflowPorts = {
		capture: { capture: async () => ({ status: 'partial' as const, evidence, ...(marketDepth === undefined ? {} : { marketDepth }) }) },
		preferences: goals.length === 0 ? EMPTY_INVENTORY_ADVISOR_PREFERENCES
			: { load: async () => ({ status: 'ready' as const, value: { goals, keepExceptions: [] } }) },
		rules: createInventoryAdvisorBuiltinRulesProvider(inventoryAdvisorBuiltinBundleProvider),
		now: () => Date.parse(now),
	};
	const result = await new InventoryAdvisorWorkflow(ports).refresh('es');
	if (result.status !== 'ready' || !('discardContext' in result.source)) throw new Error('Expected a contextual analysis.');
	const { engineInput, producerResult } = result.source.discardContext;
	const report = result.source.result.report;
	if (report === null) throw new Error('Expected a report.');
	const described = report.lines.flatMap((line) => line.decisions.map((decision) => {
		const explanation = report.explanations.find((candidate) => candidate.ref === decision.explanationRef);
		return { action: decision.action, reason: explanation?.reasonCodes.join('+') ?? '?', itemId: decision.itemId };
	}));
	return {
		status: result.source.result.status,
		decisions: described.map((entry) => `${entry.itemId - BASE}:${entry.action}/${entry.reason}`),
		reasons: described.map((entry) => entry.reason),
		actions: described.map((entry) => entry.action),
		producerVerified: isInventoryAdvisorResultForInput(
			producerResult, engineInput.input, engineInput.knowledgePack, engineInput.containerEconomy,
			engineInput.personalValuation, engineInput.activeOrders, engineInput.materialStorageCapacity,
			engineInput.marketDepth, engineInput.equipmentSalvage,
		),
	};
}

const ADVISED = [
	'1:list/alternative_route_exists', '2:list/alternative_route_exists',
	'3:vendor/alternative_route_exists', '4:keep/no_sell',
];

describe('inventory advisor: coins waiting in the Trading Post delivery box', () => {
	it('advises every object as usual on a real-shaped capture, and reviews only the one the catalog did not resolve', async () => {
		const { evidence, marketDepth } = capture({ wallet: 'skipped', partialEvidence: true, depth: 'partial', deliveryCoins: 12_345 });
		const analysed = await analyse(evidence, marketDepth, NOW);
		expect(analysed.decisions).toEqual([...ADVISED, '5:review/price_partial']);
		expect(analysed.status).toBe('limited');
		expect(analysed.producerVerified).toBe(true);
	});

	it('gives the same analysis as the capture with nothing to collect', async () => {
		const shape = { wallet: 'skipped', partialEvidence: true, depth: 'partial' } as const;
		const withCoins = capture({ ...shape, deliveryCoins: 12_345 });
		const without = capture({ ...shape, deliveryCoins: 0 });
		const left = await analyse(withCoins.evidence, withCoins.marketDepth, NOW);
		const right = await analyse(without.evidence, without.marketDepth, NOW);
		expect(left).toEqual(right);
	});

	it('publishes ready, with every object advised, when the coins are the only thing the capture does not fully know', async () => {
		const { evidence, marketDepth } = capture({ wallet: 'skipped', partialEvidence: false, depth: 'absent', deliveryCoins: 12_345 });
		const analysed = await analyse(evidence, marketDepth, NOW);
		expect(analysed.decisions).toEqual(ADVISED);
		expect(analysed.status).toBe('ready');
		expect(analysed.producerVerified).toBe(true);
	});

	it('keeps in review the free part of an object whose goal also asks for a currency the capture does not know, and still reserves the rest', async () => {
		const goal: ReservationGoal = {
			schemaVersion: 1, goalId: 'goal-with-currency', title: 'Goal with a currency', status: 'active', priority: 1, reason: 'personal',
			requirements: [
				{ key: 'currency:2', namespace: 'currency', id: 2, targetQuantity: 100, creditedQuantity: 0, basis: 'owned', intendedUse: 'spend' },
				{ key: `item:${TRADABLE_A}`, namespace: 'item', id: TRADABLE_A, targetQuantity: 3, creditedQuantity: 0, basis: 'available', intendedUse: 'hold' },
			],
		};
		const { evidence, marketDepth } = capture({ wallet: 'skipped', partialEvidence: false, depth: 'absent', deliveryCoins: 0 });
		const analysed = await analyse(evidence, marketDepth, NOW, [goal]);
		expect(analysed.decisions).toEqual([
			'1:keep/reserved_for_goal', '1:review/price_partial',
			'2:list/alternative_route_exists', '3:vendor/alternative_route_exists', '4:keep/no_sell',
		]);
		expect(analysed.producerVerified).toBe(true);
	});

	it('advises the free part of a reserved object when its goal asks for nothing the capture does not know', async () => {
		const goal: ReservationGoal = {
			schemaVersion: 1, goalId: 'goal-of-items', title: 'Goal of items', status: 'active', priority: 1, reason: 'personal',
			requirements: [
				{ key: `item:${TRADABLE_A}`, namespace: 'item', id: TRADABLE_A, targetQuantity: 3, creditedQuantity: 0, basis: 'available', intendedUse: 'hold' },
			],
		};
		const { evidence, marketDepth } = capture({ wallet: 'skipped', partialEvidence: false, depth: 'absent', deliveryCoins: 12_345 });
		const analysed = await analyse(evidence, marketDepth, NOW, [goal]);
		expect(analysed.decisions).toEqual([
			'1:keep/reserved_for_goal', '1:list/alternative_route_exists',
			'2:list/alternative_route_exists', '3:vendor/alternative_route_exists', '4:keep/no_sell',
		]);
		expect(analysed.producerVerified).toBe(true);
	});
});

describe('inventory advisor: a real capture with coins to collect', () => {
	function clientFor(pass: Record<string, unknown>) {
		const requestDetailed = async (path: string): Promise<HttpResponse> => {
			const rawPath = path.split('?')[0]!;
			if (!(rawPath in pass)) throw new Error(`Missing fixture for ${rawPath}.`);
			return { status: 200, headers: {}, body: pass[rawPath] };
		};
		return { beginOperation: () => ({
			request: async (path: string): Promise<unknown> => path === 'tokeninfo'
				? { id: 'fixture-token-id', name: 'Fixture key', permissions: ['account', 'characters', 'inventories', 'wallet', 'tradingpost'] }
				: { id: 'fixture-account-id', name: 'Fixture account', world: 1001, created: '2020-01-01T00:00:00Z', access: ['GuildWars2'], commander: false },
			requestDetailed,
		}) };
	}

	async function analyseRealCapture(coins: number): Promise<{ snapshot: StorageSnapshot; analysed: Analysed }> {
		const client = clientFor({ ...completePassFixture, 'commerce/delivery': { coins, items: [] } });
		const snapshot = await new StorageSnapshotService(client)
			.captureInventoryWithOperation(client.beginOperation());
		const at = snapshot.completedAt;
		const owned = Object.keys(snapshot.ownedByItem).map(Number).sort((left, right) => left - right);
		const available = Object.entries(snapshot.availableByItem).filter(([, quantity]) => quantity > 0)
			.map(([id]) => Number(id)).sort((left, right) => left - right);
		const catalog: CatalogResolution = { ...catalogOf(owned), snapshotId: snapshot.snapshotId, resolvedAt: at };
		const prices: InventoryPriceSnapshotV1 = {
			version: 1, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId, capturedAt: at, source: 'gw2-commerce-prices',
			schemaVersion: snapshot.schemaVersion, requestedItemIds: available, status: 'complete',
			items: available.map((itemId) => ({ itemId, whitelisted: true,
				bid: { unitCopper: 100, quantity: 1000 }, ask: { unitCopper: 150, quantity: 1000 } })),
			missingItemIds: [],
		};
		return { snapshot, analysed: await analyse(evidenceOf(snapshot, catalog, prices, at), undefined, at) };
	}

	it('carries the coins as a delivery currency next to a wallet it did not ask for, and advises as it does with none', async () => {
		const withCoins = await analyseRealCapture(50);
		const without = await analyseRealCapture(0);
		expect(withCoins.snapshot.quality).toBe('stable');
		expect(withCoins.snapshot.coverage.sources.wallet).toEqual({ status: 'skipped', reason: 'not_requested' });
		expect(withCoins.snapshot.currencyById).toEqual({ '1': { total: 50, wallet: 0, delivery: 50 } });
		expect(without.snapshot.currencyById).toEqual({});

		expect(withCoins.analysed.reasons).not.toContain('price_partial');
		expect(withCoins.analysed.actions.some((action) => action === 'sell' || action === 'list' || action === 'vendor')).toBe(true);
		expect(withCoins.analysed.decisions).toEqual(without.analysed.decisions);
		expect(withCoins.analysed.status).toBe(without.analysed.status);
		expect(withCoins.analysed.producerVerified).toBe(true);
	});
});
