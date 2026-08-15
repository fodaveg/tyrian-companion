import { isComparableStorageSnapshot } from '../account/storage-delta';
import type { StorageSnapshotService } from '../account/storage-snapshot-service';
import { allowsEndpoint } from '../account/storage-snapshot-service';
import { PINNED_SCHEMA, type StorageSnapshot } from '../account/storage-snapshot-model';
import { parseAccountProfile, parseTokenInfo, type TokenInfo } from '../account/account-service';
import { MissingApiKeyError, type GuildWars2Operation } from '../account/guild-wars-2-client';
import { PublicCatalogService } from '../catalog/public-catalog-service';
import type { CatalogLocale, CatalogResolution } from '../catalog/public-catalog-model';
import type { PublicCatalogGateway } from '../catalog/public-catalog-client';
import { parsePublicTradingPostPriceBatch } from '../economy/session-price-snapshot';
import {
	INVENTORY_ADVISOR_VERSION,
	INVENTORY_PRICE_SNAPSHOT_VERSION,
	type AccountSignalsV1,
	type InventoryItemPriceV1,
	type InventoryPriceSnapshotV1,
} from './inventory-advisor-model';
import {
	INVENTORY_ADVISOR_EVIDENCE_VERSION,
	type InventoryAdvisorEvidenceCapture,
	type InventoryAdvisorEvidenceCaptureResultV1,
	type InventoryAdvisorEvidenceCoverageV1,
	type InventoryAdvisorEvidenceV1,
} from './inventory-advisor-evidence-model';
import { isInventoryAdvisorEvidence } from './inventory-advisor-evidence-contract';
import { sha256CanonicalValue } from './inventory-advisor-contract';
import {
	isInventoryContainerPriceEvidence,
	type InventoryContainerPriceEvidenceV1,
} from './inventory-container-economy';

const BATCH_SIZE = 200;
const SNAPSHOT_TTL_MS = 15 * 60_000;
const CATALOG_TTL_MS = 7 * 86_400_000;
const PRICE_TTL_MS = 15 * 60_000;
const ACCOUNT_SIGNALS_TTL_MS = 24 * 60 * 60_000;

export interface InventoryAdvisorEvidenceClient {
	beginOperation(): GuildWars2Operation;
}

/** Explicit H4.14 capture only. Constructing this service performs no requests or persistence. */
export class InventoryAdvisorEvidenceService implements InventoryAdvisorEvidenceCapture {
	private readonly inFlight = new Map<string, Promise<InventoryAdvisorEvidenceCaptureResultV1>>();
	constructor(
		private readonly client: InventoryAdvisorEvidenceClient,
		private readonly snapshots: Pick<StorageSnapshotService, 'captureWithOperation'>,
		private readonly catalog: Pick<PublicCatalogService, 'resolve'>,
		private readonly publicGateway: PublicCatalogGateway,
		private readonly now: () => number = Date.now,
	) {}

	capture(locale: CatalogLocale, containerPriceItemIds: readonly number[] = []): Promise<InventoryAdvisorEvidenceCaptureResultV1> {
		const ids = normalizeSupplementalIds(containerPriceItemIds);
		if (ids === null) return Promise.resolve({ status: 'invalid', evidence: null, containerPrices: null });
		const key = `${locale}:${ids.join(',')}`;
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = this.captureInternal(locale, ids).finally(() => { if (this.inFlight.get(key) === promise) this.inFlight.delete(key); });
		this.inFlight.set(key, promise);
		return promise;
	}

	private async captureInternal(locale: CatalogLocale, containerPriceItemIds: number[]): Promise<InventoryAdvisorEvidenceCaptureResultV1> {
		let operation: GuildWars2Operation;
		try {
			operation = this.client.beginOperation();
		} catch (error) {
			return error instanceof MissingApiKeyError
				? { status: 'unavailable', evidence: null, failure: 'missing_key' }
				: { status: 'unavailable', evidence: null };
		}
		try {
			const snapshot = await this.snapshots.captureWithOperation(operation);
			if (!isComparableStorageSnapshot(snapshot)) return { status: 'invalid', evidence: null };
			const context = await verifiedContext(operation, snapshot.accountId);
			if (context.status === 'unavailable') return { status: 'unavailable', evidence: null };
			if (context.status === 'identity_mismatch') return { status: 'invalid', evidence: null };
			const [catalog, prices, accountSignals, containerPrices] = await Promise.all([
				this.captureCatalog(snapshot, locale, this.now()),
				captureInventoryPrices(snapshot, this.publicGateway, this.now()),
				captureAccountSignals(operation, snapshot.accountId, context.token, context.access, this.now),
				containerPriceItemIds.length === 0 ? Promise.resolve(null)
					: captureContainerPrices(snapshot, containerPriceItemIds, this.publicGateway, this.now()),
			]);
			const coverage: InventoryAdvisorEvidenceCoverageV1 = {
				snapshot: snapshotCoverage(snapshot),
				catalog: catalogCoverage(catalog, snapshot),
				prices: priceCoverage(prices),
				accountSignals: signalCoverage(accountSignals),
			};
			const finishedAt = new Date(this.now()).toISOString();
			const evidence: InventoryAdvisorEvidenceV1 = {
				version: INVENTORY_ADVISOR_EVIDENCE_VERSION,
				scope: 'supported_storage_v1', accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
				schemaVersion: snapshot.schemaVersion, capturedAt: snapshot.completedAt, finishedAt, locale, snapshot: structuredClone(snapshot), snapshotFingerprint: sha256CanonicalValue(snapshot),
				ttl: { snapshotMs: SNAPSHOT_TTL_MS, catalogMs: CATALOG_TTL_MS, pricesMs: PRICE_TTL_MS, accountSignalsMs: ACCOUNT_SIGNALS_TTL_MS },
				coverage, catalog, prices, accountSignals,
			};
			if (!isInventoryAdvisorEvidence(evidence)) return { status: 'invalid', evidence: null };
			return coverage.catalog === 'unavailable' && coverage.prices === 'unavailable'
				&& coverage.accountSignals === 'unavailable'
				? { status: 'unavailable', evidence: null }
			: { status: coverage.snapshot === 'complete' && coverage.catalog === 'complete' && coverage.prices === 'complete'
					&& coverage.accountSignals === 'complete' && (containerPrices === null || containerPrices.status === 'complete')
					? 'complete' : 'partial', evidence, containerPrices };
		} catch {
			return { status: 'unavailable', evidence: null };
		}
	}

	private async captureCatalog(snapshot: StorageSnapshot, locale: CatalogLocale, capturedAt: number): Promise<CatalogResolution> {
		try { return await this.catalog.resolve(snapshot, locale); }
		catch { return unavailableCatalog(snapshot, locale, capturedAt); }
	}
}

async function verifiedContext(operation: GuildWars2Operation, expectedAccountId: string): Promise<
	| { status: 'ok'; token: TokenInfo; access: string[] }
	| { status: 'identity_mismatch' }
	| { status: 'unavailable' }
> {
	try {
		const [token, account] = await Promise.all([
			requestBody(operation, 'tokeninfo'), requestBody(operation, 'account'),
		]);
		const tokenInfo = parseTokenInfo(token);
		const profile = parseAccountProfile(account);
		return profile.id === expectedAccountId ? { status: 'ok', token: tokenInfo, access: profile.access } : { status: 'identity_mismatch' };
	} catch { return { status: 'unavailable' }; }
}

async function captureInventoryPrices(
	snapshot: StorageSnapshot,
	gateway: PublicCatalogGateway,
	capturedAt: number,
): Promise<InventoryPriceSnapshotV1> {
	const requestedItemIds = ids(snapshot.availableByItem);
	const captured = await capturePriceItems(requestedItemIds, gateway);
	return {
		version: INVENTORY_PRICE_SNAPSHOT_VERSION, accountId: snapshot.accountId, snapshotId: snapshot.snapshotId,
		capturedAt: new Date(capturedAt).toISOString(), source: 'gw2-commerce-prices', schemaVersion: snapshot.schemaVersion,
		requestedItemIds, ...captured,
	};
}

async function captureContainerPrices(
	snapshot: StorageSnapshot,
	requestedItemIds: number[],
	gateway: PublicCatalogGateway,
	capturedAt: number,
): Promise<InventoryContainerPriceEvidenceV1> {
	const captured = await capturePriceItems(requestedItemIds, gateway);
	const value: InventoryContainerPriceEvidenceV1 = {
		version: 1,
		accountId: snapshot.accountId,
		snapshotId: snapshot.snapshotId,
		schemaVersion: snapshot.schemaVersion,
		capturedAt: new Date(capturedAt).toISOString(),
		source: 'gw2-commerce-prices',
		requestedItemIds: structuredClone(requestedItemIds),
		...captured,
	};
	if (!isInventoryContainerPriceEvidence(value)) throw new Error('invalid_container_price_evidence');
	return value;
}

async function capturePriceItems(
	requestedItemIds: number[],
	gateway: PublicCatalogGateway,
): Promise<Pick<InventoryPriceSnapshotV1, 'status' | 'items' | 'missingItemIds'>> {
	const items: InventoryItemPriceV1[] = [];
	const missing = new Set<number>();
	for (const batch of chunks(requestedItemIds, BATCH_SIZE)) {
		try {
			const response = await gateway.requestDetailed(`commerce/prices?ids=${batch.join(',')}&v=${encodeURIComponent(PINNED_SCHEMA)}`);
			if (response.status !== 200 && response.status !== 206) {
				batch.forEach((id) => missing.add(id));
				continue;
			}
			if (hasUnexpectedPriceId(response.body, new Set(batch))) { batch.forEach((id) => missing.add(id)); continue; }
			const parsed = parsePublicTradingPostPriceBatch(response.body, new Set(batch));
			items.push(...parsed.items);
			parsed.missing.forEach((id) => missing.add(id));
		} catch { batch.forEach((id) => missing.add(id)); }
	}
	items.sort((left, right) => left.itemId - right.itemId);
	const missingItemIds = [...missing].sort(numberOrder);
	return { status: missingItemIds.length === 0 ? 'complete' : items.length === 0 ? 'unavailable' : 'partial', items, missingItemIds };
}

async function captureAccountSignals(
	operation: GuildWars2Operation,
	accountId: string,
	token: TokenInfo,
	accountAccess: string[],
	now: () => number,
): Promise<AccountSignalsV1> {
	const permitted = (scope: string, endpoint: string): EndpointPermission => !token.permissions.includes(scope) ? 'missing_scope'
		: token.urls !== undefined && token.urls.length > 0 && !allowsEndpoint(token.urls, `/v2/${endpoint}`)
			? 'url_restricted' : 'complete';
	const [recipes, skins, minis, achievements] = await Promise.all([
		captureIdList(operation, permitted('unlocks', 'account/recipes'), 'account/recipes', now),
		captureIdList(operation, permitted('unlocks', 'account/skins'), 'account/skins', now),
		captureIdList(operation, permitted('unlocks', 'account/minis'), 'account/minis', now),
		captureAchievementBits(operation, permitted('progression', 'account/achievements'), now),
	]);
	const unlockResults = [recipes, skins, minis];
	const completedAt = now();
	const unlockCoverage = unlockResults.every((entry) => entry.coverage === 'complete') ? 'complete'
		: unlockResults.every((entry) => entry.coverage !== 'complete') ? 'unavailable' : 'partial';
	const achievementCoverage = achievements.coverage === 'complete' ? 'complete' : 'unavailable';
	const accountEvidence = endpointEvidence('complete', new Date(completedAt).toISOString(), null);
	return {
		version: INVENTORY_ADVISOR_VERSION, source: 'gw2-account-api', accountId, capturedAt: new Date(completedAt).toISOString(), schemaVersion: PINNED_SCHEMA,
		tradingPostAccess: tradingPostAccess(accountAccess),
		endpointCoverage: { account: accountEvidence, recipes: recipes.evidence, skins: skins.evidence, minis: minis.evidence, achievements: achievements.evidence }, unlockCoverage,
		unlockedRecipes: recipes.value, unlockedSkins: skins.value, unlockedMinis: minis.value,
		achievementCoverage, completedAchievementBits: achievements.bits, achievementProgress: achievements.progress,
	};
}

type EndpointPermission = 'complete' | 'missing_scope' | 'url_restricted';
type EndpointCoverage = EndpointPermission | 'unavailable' | 'invalid';
type EndpointEvidence = AccountSignalsV1['endpointCoverage']['recipes'];

async function captureIdList(
	operation: GuildWars2Operation, allowed: EndpointPermission, endpoint: string, now: () => number,
): Promise<{ coverage: EndpointCoverage; evidence: EndpointEvidence; value: number[] | null }> {
	if (allowed !== 'complete') return { coverage: allowed, evidence: endpointEvidence(allowed, null, allowed), value: null };
	try {
		const value = await requestBody(operation, `${endpoint}?v=${encodeURIComponent(PINNED_SCHEMA)}`);
		if (!Array.isArray(value) || !value.every(positive) || new Set(value).size !== value.length) return { coverage: 'invalid', evidence: endpointEvidence('invalid', null, 'invalid_payload'), value: null };
		return { coverage: 'complete', evidence: endpointEvidence('complete', new Date(now()).toISOString(), null), value: [...value].sort(numberOrder) };
	} catch { return { coverage: 'unavailable', evidence: endpointEvidence('unavailable', null, 'request_failed'), value: null }; }
}

async function captureAchievementBits(
	operation: GuildWars2Operation, allowed: EndpointPermission, now: () => number,
): Promise<{ coverage: EndpointCoverage; evidence: EndpointEvidence; bits: Record<string, number[]> | null; progress: AccountSignalsV1['achievementProgress'] }> {
	if (allowed !== 'complete') return { coverage: allowed, evidence: endpointEvidence(allowed, null, allowed), bits: null, progress: null };
	try {
		const value = await requestBody(operation, `account/achievements?v=${encodeURIComponent(PINNED_SCHEMA)}`);
		if (!Array.isArray(value)) return { coverage: 'invalid', evidence: endpointEvidence('invalid', null, 'invalid_payload'), bits: null, progress: null };
		const entries = value.map((entry) => isAchievement(entry) ? entry : null);
		if (entries.some((entry) => entry === null)) return { coverage: 'invalid', evidence: endpointEvidence('invalid', null, 'invalid_payload'), bits: null, progress: null };
		const result: Record<string, number[]> = {};
		const seen = new Set<number>();
		const progress: NonNullable<AccountSignalsV1['achievementProgress']> = [];
		for (const entry of entries) {
			if (seen.has(entry!.id)) return { coverage: 'invalid', evidence: endpointEvidence('invalid', null, 'invalid_payload'), bits: null, progress: null };
			seen.add(entry!.id);
			const rawBits = entry!.bits ?? null;
			const bits = rawBits === null ? null : [...rawBits].sort(numberOrder);
			if (bits !== null) result[String(entry!.id)] = bits;
			progress.push({ achievementId: entry!.id, done: entry!.done, current: entry!.current ?? null, max: entry!.max ?? null, repeated: entry!.repeated ?? null, bits });
		}
		return { coverage: 'complete', evidence: endpointEvidence('complete', new Date(now()).toISOString(), null), bits: result, progress: progress.sort((left, right) => left.achievementId - right.achievementId) };
	} catch { return { coverage: 'unavailable', evidence: endpointEvidence('unavailable', null, 'request_failed'), bits: null, progress: null }; }
}

function unavailableCatalog(snapshot: StorageSnapshot, locale: CatalogLocale, capturedAt: number): CatalogResolution {
	return {
		snapshotId: snapshot.snapshotId, locale, schemaVersion: snapshot.schemaVersion, resolvedAt: new Date(capturedAt).toISOString(),
		items: {}, currencies: {}, materials: {}, warnings: [],
		coverage: { items: Object.fromEntries(ids(snapshot.ownedByItem).map((id) => [String(id), {
			status: 'unavailable' as const, source: 'network' as const, reason: 'request_failed' as const,
		}])), currencies: {}, materials: {} },
	};
}

function catalogCoverage(catalog: CatalogResolution, snapshot: StorageSnapshot): InventoryAdvisorEvidenceCoverageV1['catalog'] {
	const entries = ids(snapshot.ownedByItem).map((id) => catalog.coverage.items[String(id)]);
	return entries.every((entry) => entry?.status === 'resolved' && (entry.source === 'network' || entry.source === 'cache_fresh')) ? 'complete'
		: entries.every((entry) => entry?.status === 'unavailable') ? 'unavailable' : 'partial';
}
function snapshotCoverage(snapshot: StorageSnapshot): InventoryAdvisorEvidenceCoverageV1['snapshot'] {
	return snapshot.quality === 'stable' && Object.values(snapshot.coverage.sources).every((entry) => entry.status === 'complete') ? 'complete' : 'partial';
}
function priceCoverage(prices: InventoryPriceSnapshotV1): InventoryAdvisorEvidenceCoverageV1['prices'] { return prices.status; }
function signalCoverage(signals: AccountSignalsV1): InventoryAdvisorEvidenceCoverageV1['accountSignals'] {
	return signals.unlockCoverage === 'complete' && signals.achievementCoverage === 'complete'
		&& signals.tradingPostAccess !== 'unknown' ? 'complete'
		: signals.unlockCoverage === 'unavailable' && signals.achievementCoverage === 'unavailable'
		&& signals.tradingPostAccess === 'unknown' ? 'unavailable' : 'partial';
}
function isAchievement(value: unknown): value is { id: number; done: boolean; current?: number | null; max?: number | null; repeated?: number | null; bits?: number[] | null } {
	return record(value) && positive(value.id) && typeof value.done === 'boolean'
		&& optionalNonNegative(value.current) && optionalNonNegative(value.max) && optionalNonNegative(value.repeated)
		&& (value.current === null || value.current === undefined || value.max === null || value.max === undefined || value.current <= value.max)
		&& (value.bits === undefined || (Array.isArray(value.bits) && value.bits.every(nonNegative) && new Set(value.bits).size === value.bits.length));
}
function hasUnexpectedPriceId(body: unknown, requested: ReadonlySet<number>): boolean {
	return Array.isArray(body) && body.some((entry) => record(entry) && positive(entry.id) && !requested.has(entry.id));
}
function endpointEvidence(status: EndpointCoverage, capturedAt: string | null, reason: EndpointEvidence['reason']): EndpointEvidence { return { status, capturedAt, reason }; }
async function requestBody(operation: GuildWars2Operation, path: string): Promise<unknown> {
	const response = await operation.requestDetailed(path);
	if (response.status !== 200) throw new Error(`Unexpected status ${response.status}.`);
	return response.body;
}
function tradingPostAccess(access: string[]): AccountSignalsV1['tradingPostAccess'] {
	const normalized = [...new Set(access)].sort();
	if (normalized.length === 1 && normalized[0] === 'PlayForFree') return 'free_to_play';
	return normalized.some((entry) => ['GuildWars2', 'HeartOfThorns', 'PathOfFire', 'EndOfDragons', 'SecretsOfTheObscure', 'JanthirWilds'].includes(entry)) ? 'full' : 'unknown';
}
function optionalNonNegative(value: unknown): boolean { return value === undefined || value === null || nonNegative(value); }
function normalizeSupplementalIds(values: readonly number[]): number[] | null {
	if (!Array.isArray(values) || !values.every(positive)
		|| values.some((value, index) => index > 0 && values[index - 1]! >= value)) return null;
	return [...values];
}
function ids(values: Record<string, number>): number[] { return Object.entries(values).filter(([, quantity]) => quantity > 0).map(([id]) => Number(id)).sort(numberOrder); }
function chunks<T>(values: T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size)); return result; }
function numberOrder(left: number, right: number): number { return left - right; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
