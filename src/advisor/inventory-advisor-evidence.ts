import { inventoryAdvisorStorageSnapshotFailure } from '../account/storage-delta';
import type { StorageSnapshotCaptureProgress, StorageSnapshotService } from '../account/storage-snapshot-service';
import { allowsEndpoint } from '../account/storage-snapshot-service';
import { HttpTransportError } from '../core/http';
import {
	PINNED_SCHEMA,
	type SourceCoverage,
	type StorageSnapshot,
} from '../account/storage-snapshot-model';
import { parseAccountProfile, parseTokenInfo, type AccountProfile, type TokenInfo } from '../account/account-service';
import { MissingApiKeyError, type GuildWars2Operation } from '../account/guild-wars-2-client';
import { captureActiveTradingPostOrders } from '../account/trading-post-evidence';
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
	type InventoryAdvisorCaptureProgress,
	type InventoryAdvisorCaptureReceiptSink,
	type InventoryAdvisorCaptureReceiptV1,
	type InventoryAdvisorEvidenceCapture,
	type InventoryAdvisorEvidenceCaptureResultV1,
	type InventoryAdvisorEvidenceCoverageV1,
	type InventoryAdvisorEvidenceV1,
} from './inventory-advisor-evidence-model';
import { inventoryAdvisorEvidenceValidationFailure } from './inventory-advisor-evidence-contract';
import { sha256CanonicalValue } from './inventory-advisor-contract';
import {
	isInventoryContainerPriceEvidence,
	type InventoryContainerPriceEvidenceV1,
} from './inventory-container-economy';
import { captureInventoryMarketDepth } from '../economy/commerce-listings';
import type { RateLimitCoordinator } from '../core/rate-limit-coordinator';

const BATCH_SIZE = 200;
const SNAPSHOT_TTL_MS = 15 * 60_000;
const CATALOG_TTL_MS = 7 * 86_400_000;
const PRICE_TTL_MS = 15 * 60_000;
const ACCOUNT_SIGNALS_TTL_MS = 24 * 60 * 60_000;
/** Catalog, prices, account signals, and container prices: always exactly four concurrent legs. */
const CATALOG_AND_PRICES_TOTAL = 4;
const ZERO_STORAGE_CAPTURE_PROGRESS: StorageSnapshotCaptureProgress = {
	roster: { completed: 0, total: 1 },
	accountStores: { completed: 0, total: 0 },
	characters: { completed: 0, total: 0 },
};

export interface InventoryAdvisorEvidenceClient {
	beginOperation(): GuildWars2Operation;
}

/** Explicit H4.14 capture only. Constructing this service performs no requests or persistence. */
export class InventoryAdvisorEvidenceService implements InventoryAdvisorEvidenceCapture {
	private readonly inFlight = new Map<string, Promise<InventoryAdvisorEvidenceCaptureResultV1>>();
	constructor(
		private readonly client: InventoryAdvisorEvidenceClient,
		private readonly snapshots: Pick<StorageSnapshotService, 'captureInventoryWithOperation'>,
		private readonly catalog: Pick<PublicCatalogService, 'resolve'>,
		private readonly publicGateway: PublicCatalogGateway,
		private readonly now: () => number = Date.now,
		private readonly captureReceipt: InventoryAdvisorCaptureReceiptSink = () => undefined,
		private readonly rateLimit?: Pick<RateLimitCoordinator, 'status' | 'recordRateLimited'>,
	) {}

	capture(
		locale: CatalogLocale,
		containerPriceItemIds: readonly number[] = [],
		onProgress?: (progress: InventoryAdvisorCaptureProgress) => void,
	): Promise<InventoryAdvisorEvidenceCaptureResultV1> {
		const ids = normalizeSupplementalIds(containerPriceItemIds);
		if (ids === null) {
			return this.finishCapture(
				{ status: 'invalid', evidence: null, containerPrices: null },
				null,
			);
		}
		const key = `${locale}:${ids.join(',')}`;
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = this.captureInternal(locale, ids, onProgress).finally(() => { if (this.inFlight.get(key) === promise) this.inFlight.delete(key); });
		this.inFlight.set(key, promise);
		return promise;
	}

	private async captureInternal(
		locale: CatalogLocale,
		containerPriceItemIds: number[],
		onProgress?: (progress: InventoryAdvisorCaptureProgress) => void,
	): Promise<InventoryAdvisorEvidenceCaptureResultV1> {
		let snapshot: StorageSnapshot | null = null;
		let operation: GuildWars2Operation;
		// Purely in-memory: this only ever composes a callback the caller already
		// owns. It never writes a receipt, a setting, or any note or file anywhere.
		let latestStorageProgress = ZERO_STORAGE_CAPTURE_PROGRESS;
		let catalogAndPricesCompleted = 0;
		const reportProgress = (): void => onProgress?.({
			...latestStorageProgress,
			catalogAndPrices: { completed: catalogAndPricesCompleted, total: CATALOG_AND_PRICES_TOTAL },
		});
		const onStorageProgress = (progress: StorageSnapshotCaptureProgress): void => {
			latestStorageProgress = progress;
			reportProgress();
		};
		const reportCatalogOrPrice = (): void => { catalogAndPricesCompleted += 1; reportProgress(); };
		try {
			operation = this.client.beginOperation();
		} catch (error) {
			return await this.finishCapture(error instanceof MissingApiKeyError
				? { status: 'unavailable', evidence: null, failure: 'missing_key' }
				: { status: 'unavailable', evidence: null }, snapshot);
		}
		try {
			snapshot = await this.snapshots.captureInventoryWithOperation(operation, onStorageProgress);
			if (shouldRetryTransientSnapshot(snapshot)) {
				snapshot = await this.snapshots.captureInventoryWithOperation(operation, onStorageProgress);
			}
			const snapshotFailure = inventoryAdvisorStorageSnapshotFailure(snapshot);
			if (snapshotFailure !== null) {
				return await this.finishCapture(
					{ status: 'invalid', evidence: null, failure: snapshotFailure },
					snapshot,
				);
			}
			const context = await verifiedContext(operation, snapshot.accountId);
			if (context.status === 'unavailable') {
				return await this.finishCapture({ status: 'unavailable', evidence: null }, snapshot);
			}
			if (context.status === 'identity_mismatch') {
				return await this.finishCapture(
					{ status: 'invalid', evidence: null, failure: 'identity_mismatch' },
					snapshot,
				);
			}
			const [catalog, market, accountContext, containerPrices] = await Promise.all([
				this.captureCatalog(snapshot, locale, this.now()).finally(reportCatalogOrPrice),
				Promise.all([
					captureInventoryPrices(snapshot, this.publicGateway, this.now()),
					captureInventoryMarketDepth(ids(snapshot.availableByItem), this.publicGateway, this.now(), this.rateLimit),
				]).finally(reportCatalogOrPrice),
				captureAccountContext(operation, snapshot.accountId, context.token, context.access, this.now).finally(reportCatalogOrPrice),
				(containerPriceItemIds.length === 0 ? Promise.resolve(null)
					: captureContainerPrices(snapshot, containerPriceItemIds, this.publicGateway, this.now())).finally(reportCatalogOrPrice),
			]);
			const [prices, marketDepth] = market;
			const { accountSignals, activeOrders } = accountContext;
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
			const validationFailure = inventoryAdvisorEvidenceValidationFailure(evidence);
			if (validationFailure !== null) {
				return await this.finishCapture(
					{ status: 'invalid', evidence: null, failure: validationFailure },
					snapshot,
				);
			}
			const result: InventoryAdvisorEvidenceCaptureResultV1 =
				coverage.catalog === 'unavailable' && coverage.prices === 'unavailable'
				&& coverage.accountSignals === 'unavailable'
				? { status: 'unavailable', evidence: null }
			: { status: coverage.snapshot === 'complete' && coverage.catalog === 'complete' && coverage.prices === 'complete'
					&& coverage.accountSignals === 'complete' && activeOrders.status === 'complete'
					&& marketDepth.status === 'complete'
					&& (containerPrices === null || containerPrices.status === 'complete')
					? 'complete' : 'partial', evidence, containerPrices, activeOrders, marketDepth };
			return await this.finishCapture(result, snapshot);
		} catch (error) {
			if (error instanceof HttpTransportError && error.status === 429) {
				return await this.finishCapture({ status: 'unavailable', evidence: null, failure: 'rate_limited' }, snapshot);
			}
			return await this.finishCapture({ status: 'unavailable', evidence: null }, snapshot);
		}
	}

	private async finishCapture(
		result: InventoryAdvisorEvidenceCaptureResultV1,
		snapshot: StorageSnapshot | null,
	): Promise<InventoryAdvisorEvidenceCaptureResultV1> {
		try {
			await this.captureReceipt(captureReceiptFor(result, snapshot, this.now()));
		} catch {
			// A local diagnostic receipt must never become an advisor dependency.
		}
		return result;
	}

	private async captureCatalog(snapshot: StorageSnapshot, locale: CatalogLocale, capturedAt: number): Promise<CatalogResolution> {
		try { return await this.catalog.resolve(snapshot, locale); }
		catch { return unavailableCatalog(snapshot, locale, capturedAt); }
	}
}

function captureReceiptFor(
	result: InventoryAdvisorEvidenceCaptureResultV1,
	snapshot: StorageSnapshot | null,
	recordedAt: number,
): InventoryAdvisorCaptureReceiptV1 {
	return {
		version: 1,
		recordedAt: new Date(recordedAt).toISOString(),
		status: result.status,
		failure: 'failure' in result ? result.failure ?? null : null,
		evidenceCoverage: result.evidence === null
			? null
			: structuredClone(result.evidence.coverage),
		evidenceDetails: result.evidence === null ? null : evidenceDetails(result.evidence),
		containerPrices: result.containerPrices?.status ?? 'not_requested',
		activeOrders: result.evidence === null || result.activeOrders === undefined ? null : {
			status: result.activeOrders.status,
			buys: result.activeOrders.endpointCoverage.buy.status,
			sells: result.activeOrders.endpointCoverage.sell.status,
		},
		workflow: null,
		snapshot: snapshot === null ? null : {
			quality: snapshot.quality,
			passes: snapshot.passes,
			durationMs: Math.max(0, Date.parse(snapshot.completedAt) - Date.parse(snapshot.startedAt)),
			roster: structuredClone(snapshot.coverage.sources.characters),
			sharedInventory: structuredClone(snapshot.coverage.sources.shared_inventory),
			bank: structuredClone(snapshot.coverage.sources.bank),
			materials: structuredClone(snapshot.coverage.sources.materials),
			commerceDelivery: structuredClone(snapshot.coverage.sources.commerce_delivery),
			characterInventories: uniqueCoverage(Object.values(snapshot.coverage.characters)),
			attempts: snapshot.passCoverages.map((coverage) => ({
				roster: structuredClone(coverage.sources.characters),
				sharedInventory: structuredClone(coverage.sources.shared_inventory),
				bank: structuredClone(coverage.sources.bank),
				materials: structuredClone(coverage.sources.materials),
				commerceDelivery: structuredClone(coverage.sources.commerce_delivery),
				characterInventories: uniqueCoverage(Object.values(coverage.characters)),
			})),
		},
	};
}

function evidenceDetails(
	evidence: InventoryAdvisorEvidenceV1,
): NonNullable<InventoryAdvisorCaptureReceiptV1['evidenceDetails']> {
	const catalogCoverage = Object.values(evidence.catalog.coverage.items);
	return {
		catalog: {
			requested: Object.keys(evidence.snapshot.ownedByItem).length,
			resolved: catalogCoverage.filter((entry) => entry.status === 'resolved'
				&& entry.source !== 'cache_stale').length,
			stale: catalogCoverage.filter((entry) => entry.status === 'resolved'
				&& entry.source === 'cache_stale').length,
			unavailable: catalogCoverage.filter((entry) => entry.status === 'unavailable').length,
		},
		prices: {
			requested: evidence.prices.requestedItemIds.length,
			captured: evidence.prices.items.length,
			missing: evidence.prices.missingItemIds.length,
		},
	};
}

function uniqueCoverage(entries: readonly SourceCoverage[]): SourceCoverage[] {
	const unique = new Map<string, SourceCoverage>();
	for (const entry of entries) {
		const copy: SourceCoverage = structuredClone(entry);
		const diagnostic = copy.diagnostic;
		unique.set([
			copy.status,
			copy.reason ?? '',
			diagnostic?.kind ?? '',
			diagnostic?.status ?? '',
			diagnostic?.retryAfterMs ?? '',
		].join(':'), copy);
	}
	return [...unique.values()].sort((left, right) =>
		left.status.localeCompare(right.status)
		|| (left.reason ?? '').localeCompare(right.reason ?? ''),
	);
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

/** Public-price batch shared by explicit Inventory Advisor and durable inventory captures. */
export async function captureInventoryPrices(
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

/**
 * Account trading-post tier shared by the explicit Inventory Advisor evidence capture
 * and the durable inventory-notes sync. Reuses the same tokeninfo-free `account`
 * lookup and the same scope-to-tier mapping (`tradingPostAccess`) as
 * `captureAccountSignals`, so both captures agree on what a "full" account is.
 *
 * It fails closed. `'unknown'` is a real answer -- an account whose access list names
 * no edition we recognise -- and `isTradingPostAccessible()` denies every item for it,
 * so returning `'unknown'` for a request that simply did not answer would rewrite every
 * inventory note with null values without saying anything: the exact silent failure this
 * capture was added to fix. Aborting costs the user a retry and surfaces as the sync's
 * `capture_unavailable` error instead. The snapshot capture has already read and parsed
 * `account` over this same operation by the time we get here, so failing is exceptional.
 */
export async function captureInventoryTradingPostAccess(
	operation: GuildWars2Operation,
	expectedAccountId: string,
): Promise<AccountSignalsV1['tradingPostAccess']> {
	let profile: AccountProfile;
	try { profile = parseAccountProfile(await requestBody(operation, 'account')); }
	catch { throw new Error('inventory_trading_post_access_unavailable'); }
	if (profile.id !== expectedAccountId) throw new Error('inventory_trading_post_access_unavailable');
	return tradingPostAccess(profile.access);
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

async function captureAccountContext(
	operation: GuildWars2Operation,
	accountId: string,
	token: TokenInfo,
	accountAccess: string[],
	now: () => number,
): Promise<{
	accountSignals: AccountSignalsV1;
	activeOrders: Awaited<ReturnType<typeof captureActiveTradingPostOrders>>;
}> {
	const permitted = (scope: string, endpoint: string): EndpointPermission => !token.permissions.includes(scope) ? 'missing_scope'
		: token.urls !== undefined && token.urls.length > 0 && !allowsEndpoint(token.urls, `/v2/${endpoint}`)
			? 'url_restricted' : 'complete';
	const [recipes, skins, minis, achievements, activeOrders] = await Promise.all([
		captureIdList(operation, permitted('unlocks', 'account/recipes'), 'account/recipes', now),
		captureIdList(operation, permitted('unlocks', 'account/skins'), 'account/skins', now),
		captureIdList(operation, permitted('unlocks', 'account/minis'), 'account/minis', now),
		captureAchievementBits(operation, permitted('progression', 'account/achievements'), now),
		captureActiveTradingPostOrders(operation, accountId, token, now),
	]);
	const unlockResults = [recipes, skins, minis];
	const completedAt = now();
	const unlockCoverage = unlockResults.every((entry) => entry.coverage === 'complete') ? 'complete'
		: unlockResults.every((entry) => entry.coverage !== 'complete') ? 'unavailable' : 'partial';
	const achievementCoverage = achievements.coverage === 'complete' ? 'complete' : 'unavailable';
	const accountEvidence = endpointEvidence('complete', new Date(completedAt).toISOString(), null);
	const accountSignals: AccountSignalsV1 = {
		version: INVENTORY_ADVISOR_VERSION, source: 'gw2-account-api', accountId, capturedAt: new Date(completedAt).toISOString(), schemaVersion: PINNED_SCHEMA,
		tradingPostAccess: tradingPostAccess(accountAccess),
		endpointCoverage: { account: accountEvidence, recipes: recipes.evidence, skins: skins.evidence, minis: minis.evidence, achievements: achievements.evidence }, unlockCoverage,
		unlockedRecipes: recipes.value, unlockedSkins: skins.value, unlockedMinis: minis.value,
		achievementCoverage, completedAchievementBits: achievements.bits, achievementProgress: achievements.progress,
	};
	return { accountSignals, activeOrders };
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
function hasTransientSnapshotFailure(snapshot: StorageSnapshot): boolean {
	if (snapshot.quality === 'unstable') return false;
	return [...Object.values(snapshot.coverage.sources), ...Object.values(snapshot.coverage.characters)]
		.some((entry) => entry.status === 'partial' && (entry.reason === 'partial_response' || entry.reason === 'unavailable'));
}
function shouldRetryTransientSnapshot(snapshot: StorageSnapshot): boolean {
	try {
		return hasTransientSnapshotFailure(snapshot);
	} catch {
		return false;
	}
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
