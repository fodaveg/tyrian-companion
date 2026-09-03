import { PINNED_SCHEMA, type StorageSnapshot } from '../account/storage-snapshot-model';
import { createLimiter } from '../core/concurrency';
import { HttpTransportError } from '../core/http';
import type {
	CatalogCacheAdapter,
	CatalogCacheKey,
	CatalogCacheRecord,
} from './public-catalog-cache';
import type { PublicCatalogGateway } from './public-catalog-client';
import {
	type CatalogEntityByKind,
	type CatalogIdCoverage,
	type CatalogItem,
	type CatalogKind,
	type CatalogLocale,
	type CatalogResolution,
	type CatalogWarning,
	CATALOG_NORMALIZER_VERSION,
} from './public-catalog-model';
import {
	parseCatalogCurrency,
	parseCatalogItem,
	parseCatalogMaterial,
	readCatalogEntryId,
} from './public-catalog-parsers';
import { canonicalJson as canonical } from '../core/canonical-sha256';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NEGATIVE_TTL_MS = 60 * 60 * 1_000;
const STALE_MAX_AGE_MS = 30 * DAY_MS;
const POSITIVE_TTL_MS: Record<CatalogKind, number> = {
	items: 7 * DAY_MS,
	currencies: 7 * DAY_MS,
	materials: DAY_MS,
};
const BATCH_SIZE = 200;

interface KindResolution<K extends CatalogKind> {
	entities: Map<number, CatalogEntityByKind[K]>;
	coverage: Map<number, CatalogIdCoverage>;
	warnings: CatalogWarning[];
}

interface CurrencyReference {
	key: string;
	id: number;
}

interface MaterialMembership {
	categoryId: number;
	itemId: number;
}

/** Resolves public metadata without mutating or persisting the account snapshot. */
export class PublicCatalogService {
	private readonly inFlight = new Map<string, Promise<CatalogResolution>>();
	private readonly requestLimit = createLimiter(3);

	constructor(
		private readonly gateway: PublicCatalogGateway,
		private readonly cache: CatalogCacheAdapter,
		private readonly now: () => number = Date.now,
	) {}

	resolve(snapshot: StorageSnapshot, locale: CatalogLocale): Promise<CatalogResolution> {
		const inputs = extractInputs(snapshot);
		const flightKey = JSON.stringify([
			snapshot.snapshotId,
			locale,
			inputs.itemIds,
			inputs.currencyReferences,
			inputs.materialIds,
		]);
		const current = this.inFlight.get(flightKey);
		if (current) return current;

		const promise = this.resolveInternal(snapshot.snapshotId, inputs, locale).finally(() => {
			if (this.inFlight.get(flightKey) === promise) this.inFlight.delete(flightKey);
		});
		this.inFlight.set(flightKey, promise);
		return promise;
	}

	/**
	 * Resolves item metadata for a bounded id list, keyed by decimal id.
	 *
	 * A session note only ever values the items the session gained, so making it resolve a whole
	 * account snapshot would trade a handful of ids for thousands. Ids the API does not know are
	 * simply absent from the result; the caller decides what a missing entry means.
	 */
	async resolveItems(
		itemIds: readonly number[],
		locale: CatalogLocale,
	): Promise<Record<string, CatalogItem>> {
		const ids = uniqueSorted([...itemIds]);
		if (ids.length === 0) return {};
		const items = await this.resolveKind('items', ids, locale, parseCatalogItem, this.now());
		return mapEntities(items.entities);
	}

	private async resolveInternal(
		snapshotId: string,
		inputs: ReturnType<typeof extractInputs>,
		locale: CatalogLocale,
	): Promise<CatalogResolution> {
		const resolvedAt = this.now();
		const [items, currencies, materials] = await Promise.all([
			this.resolveKind('items', inputs.itemIds, locale, parseCatalogItem, resolvedAt),
			this.resolveKind(
				'currencies',
				uniqueSorted(inputs.currencyReferences.map((entry) => entry.id)),
				locale,
				parseCatalogCurrency,
				resolvedAt,
			),
			this.resolveKind('materials', inputs.materialIds, locale, parseCatalogMaterial, resolvedAt),
		]);
		const warnings = [...items.warnings, ...currencies.warnings, ...materials.warnings];
		addMaterialMembershipWarnings(inputs.materialMemberships, materials.entities, warnings);

		const resolution: CatalogResolution = {
			snapshotId,
			locale,
			schemaVersion: PINNED_SCHEMA,
			resolvedAt: new Date(resolvedAt).toISOString(),
			items: mapEntities(items.entities),
			currencies: {},
			materials: mapEntities(materials.entities),
			warnings: sortWarnings(warnings),
			coverage: {
				items: mapCoverage(items.coverage),
				currencies: {},
				materials: mapCoverage(materials.coverage),
			},
		};

		for (const reference of inputs.currencyReferences) {
			const entity = currencies.entities.get(reference.id);
			if (entity) resolution.currencies[reference.key] = entity;
			const coverage = currencies.coverage.get(reference.id);
			if (coverage) resolution.coverage.currencies[reference.key] = coverage;
		}
		return resolution;
	}

	private async resolveKind<K extends CatalogKind>(
		kind: K,
		ids: number[],
		locale: CatalogLocale,
		parse: (value: unknown) => CatalogEntityByKind[K],
		now: number,
	): Promise<KindResolution<K>> {
		const result: KindResolution<K> = { entities: new Map(), coverage: new Map(), warnings: [] };
		const stale = new Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>();
		const unresolved: number[] = [];

		await Promise.all(
			ids.map(async (id) => {
				const cached = await this.cache.get(cacheKey(kind, locale, id));
				if (!cached) {
					unresolved.push(id);
					return;
				}
				if (
					cached.schemaVersion !== PINNED_SCHEMA ||
					cached.normalizerVersion !== CATALOG_NORMALIZER_VERSION
				) {
					unresolved.push(id);
					return;
				}
				const age = Math.max(0, now - cached.storedAt);
				if (cached.value === null) {
					if (age <= NEGATIVE_TTL_MS) {
						result.coverage.set(id, {
							status: 'missing',
							source: 'cache_negative',
							reason: cached.negativeReason ?? 'not_found',
						});
					} else {
						unresolved.push(id);
					}
					return;
				}
				if (cached.value.id !== id || !hasExpectedKind(kind, cached.value.kind)) {
					unresolved.push(id);
					return;
				}
				if (age <= POSITIVE_TTL_MS[kind]) {
					result.entities.set(id, cached.value);
					result.coverage.set(id, { status: 'resolved', source: 'cache_fresh' });
					return;
				}
				if (age <= STALE_MAX_AGE_MS) stale.set(id, cached);
				unresolved.push(id);
			}),
		);

		const batches = chunk(uniqueSorted(unresolved), BATCH_SIZE);
		await Promise.all(
			batches.map((batch) =>
				this.requestLimit(() => this.fetchBatch(kind, batch, locale, parse, now, stale, result)),
			),
		);
		return result;
	}

	private async fetchBatch<K extends CatalogKind>(
		kind: K,
		ids: number[],
		locale: CatalogLocale,
		parse: (value: unknown) => CatalogEntityByKind[K],
		now: number,
		stale: Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>,
		result: KindResolution<K>,
	): Promise<void> {
		let status: number;
		let body: unknown;
		try {
			const response = await this.gateway.requestDetailed(buildPath(kind, ids, locale));
			status = response.status;
			body = response.body;
		} catch (error) {
			if (error instanceof HttpTransportError && error.status === 404) {
				await this.recordMissing(kind, locale, ids, now, result);
				return;
			}
			this.recordUnavailable(
				ids,
				isTransient(error)
					? stale
					: new Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>(),
				result,
			);
			return;
		}

		if (status === 404) {
			await this.recordMissing(kind, locale, ids, now, result);
			return;
		}
		if (status !== 200 && status !== 206) {
			this.recordUnavailable(
				ids,
				isTransientStatus(status)
					? stale
					: new Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>(),
				result,
			);
			return;
		}

		if (!Array.isArray(body)) {
			this.recordMalformed(ids, kind, result);
			return;
		}

		const requested = new Set(ids);
		const returned = new Map<number, CatalogEntityByKind[K]>();
		const malformed = new Set<number>();
		const conflicts = new Set<number>();
		for (const entry of body) {
			const id = readCatalogEntryId(entry);
			if (id === null) {
				result.warnings.push({ code: 'malformed_entry', kind });
				continue;
			}
			if (!requested.has(id)) {
				result.warnings.push({ code: 'unexpected_id', kind, id });
				continue;
			}
			let entity: CatalogEntityByKind[K];
			try {
				entity = parse(entry);
			} catch {
				malformed.add(id);
				returned.delete(id);
				result.warnings.push({ code: 'malformed_entry', kind, id });
				continue;
			}
			if (malformed.has(id) || conflicts.has(id)) continue;
			const previous = returned.get(id);
			if (!previous) {
				returned.set(id, entity);
				continue;
			}
			if (canonical(previous) === canonical(entity)) {
				result.warnings.push({ code: 'duplicate_identical', kind, id });
			} else {
				returned.delete(id);
				conflicts.add(id);
				result.warnings.push({ code: 'duplicate_conflict', kind, id });
			}
		}

		for (const id of ids) {
			if (conflicts.has(id)) {
				result.coverage.set(id, {
					status: 'invalid',
					source: 'network',
					reason: 'duplicate_conflict',
				});
				continue;
			}
			if (malformed.has(id)) {
				result.coverage.set(id, {
					status: 'malformed',
					source: 'network',
					reason: 'malformed_entry',
				});
				continue;
			}
			const entity = returned.get(id);
			if (entity) {
				result.entities.set(id, entity);
				result.coverage.set(id, { status: 'resolved', source: 'network' });
				await this.cache.set(cacheKey(kind, locale, id), cacheRecord(entity, now));
			} else if (status === 206) {
				await this.recordMissing(kind, locale, [id], now, result, 'partial_response');
			} else {
				result.coverage.set(id, {
					status: 'missing',
					source: 'network',
					reason: 'missing_response',
				});
				result.warnings.push({ code: 'missing_response', kind, id });
			}
		}
	}

	private async recordMissing<K extends CatalogKind>(
		kind: K,
		locale: CatalogLocale,
		ids: number[],
		now: number,
		result: KindResolution<K>,
		reason: 'not_found' | 'partial_response' = 'not_found',
	): Promise<void> {
		for (const id of ids) {
			result.coverage.set(id, { status: 'missing', source: 'network', reason });
			await this.cache.set(
				cacheKey(kind, locale, id),
				cacheRecord<CatalogEntityByKind[K]>(null, now, reason),
			);
		}
	}

	private recordMalformed<K extends CatalogKind>(
		ids: number[],
		kind: K,
		result: KindResolution<K>,
	): void {
		for (const id of ids) {
			result.coverage.set(id, {
				status: 'malformed',
				source: 'network',
				reason: 'malformed_entry',
			});
			result.warnings.push({ code: 'malformed_entry', kind, id });
		}
	}

	private recordUnavailable<K extends CatalogKind>(
		ids: number[],
		stale: Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>,
		result: KindResolution<K>,
	): void {
		for (const id of ids) {
			const cached = stale.get(id);
			if (cached?.value) {
				result.entities.set(id, cached.value);
				result.coverage.set(id, { status: 'resolved', source: 'cache_stale' });
			} else {
				result.coverage.set(id, {
					status: 'unavailable',
					source: 'network',
					reason: 'request_failed',
				});
			}
		}
	}
}

function extractInputs(snapshot: StorageSnapshot): {
	itemIds: number[];
	currencyReferences: CurrencyReference[];
	materialIds: number[];
	materialMemberships: MaterialMembership[];
} {
	const itemIds = uniqueSorted(snapshot.holdings.map((holding) => holding.itemId));
	const memberships = new Map<string, MaterialMembership>();
	for (const holding of snapshot.holdings) {
		if (holding.location.source !== 'materials') continue;
		const membership = { categoryId: holding.location.category, itemId: holding.itemId };
		memberships.set(`${membership.categoryId}:${membership.itemId}`, membership);
	}
	const materialMemberships = [...memberships.values()].sort(
		(left, right) => left.categoryId - right.categoryId || left.itemId - right.itemId,
	);
	const materialIds = uniqueSorted(materialMemberships.map((entry) => entry.categoryId));
	const references = new Map<string, CurrencyReference>();
	for (const currency of snapshot.currencies) {
		const key = `${currency.namespace}:${currency.currencyId}`;
		references.set(key, { key, id: currency.currencyId });
	}
	return {
		itemIds,
		currencyReferences: [...references.values()].sort((left, right) =>
			left.key.localeCompare(right.key),
		),
		materialIds,
		materialMemberships,
	};
}

function buildPath(kind: CatalogKind, ids: number[], locale: CatalogLocale): string {
	return `${kind}?ids=${ids.join(',')}&lang=${locale}&v=${encodeURIComponent(PINNED_SCHEMA)}`;
}

function uniqueSorted(values: number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function chunk(values: number[], size: number): number[][] {
	const chunks: number[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function mapEntities<T>(values: Map<number, T>): Record<string, T> {
	return Object.fromEntries([...values.entries()].sort(([left], [right]) => left - right));
}

function mapCoverage(values: Map<number, CatalogIdCoverage>): Record<string, CatalogIdCoverage> {
	return Object.fromEntries([...values.entries()].sort(([left], [right]) => left - right));
}

function cacheKey<K extends CatalogKind>(
	kind: K,
	locale: CatalogLocale,
	id: number,
): CatalogCacheKey<K> {
	return {
		kind,
		locale,
		id,
		schemaVersion: PINNED_SCHEMA,
		normalizerVersion: CATALOG_NORMALIZER_VERSION,
	};
}

function cacheRecord<T extends CatalogEntityByKind[CatalogKind]>(
	value: T | null,
	storedAt: number,
	negativeReason?: 'not_found' | 'partial_response',
): CatalogCacheRecord<T> {
	return {
		value,
		storedAt,
		schemaVersion: PINNED_SCHEMA,
		normalizerVersion: CATALOG_NORMALIZER_VERSION,
		negativeReason,
	};
}

function addMaterialMembershipWarnings(
	memberships: MaterialMembership[],
	categories: Map<number, CatalogEntityByKind['materials']>,
	warnings: CatalogWarning[],
): void {
	for (const membership of memberships) {
		const category = categories.get(membership.categoryId);
		if (category && !category.items.includes(membership.itemId)) {
			warnings.push({
				code: 'material_membership_mismatch',
				kind: 'materials',
				id: membership.categoryId,
				relatedId: membership.itemId,
			});
		}
	}
}

function sortWarnings(warnings: CatalogWarning[]): CatalogWarning[] {
	return [...warnings].sort((left, right) =>
		canonical([left.kind, left.id ?? 0, left.relatedId ?? 0, left.code]).localeCompare(
			canonical([right.kind, right.id ?? 0, right.relatedId ?? 0, right.code]),
		),
	);
}


function isTransient(error: unknown): boolean {
	return (
		error instanceof HttpTransportError &&
		(error.kind === 'network' || error.kind === 'timeout' || isTransientStatus(error.status))
	);
}

function isTransientStatus(status: number | null): boolean {
	return status !== null && [429, 500, 502, 503, 504].includes(status);
}

function hasExpectedKind(kind: CatalogKind, entityKind: string): boolean {
	return (
		(kind === 'items' && entityKind === 'item') ||
		(kind === 'currencies' && entityKind === 'currency') ||
		(kind === 'materials' && entityKind === 'material_category')
	);
}
