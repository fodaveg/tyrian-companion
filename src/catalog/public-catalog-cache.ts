import type {
	CatalogEntity,
	CatalogEntityByKind,
	CatalogKind,
	CatalogLocale,
} from './public-catalog-model';

export interface CatalogCacheRecord<T extends CatalogEntity> {
	value: T | null;
	storedAt: number;
	schemaVersion: string;
	normalizerVersion: number;
	negativeReason?: 'not_found' | 'partial_response';
}

export interface CatalogCacheKey<K extends CatalogKind = CatalogKind> {
	kind: K;
	locale: CatalogLocale;
	id: number;
	schemaVersion: string;
	normalizerVersion: number;
}

export interface CatalogCacheAdapter {
	get<K extends CatalogKind>(
		key: CatalogCacheKey<K>,
	): Promise<CatalogCacheRecord<CatalogEntityByKind[K]> | undefined>;
	/**
	 * Batched lookup, keyed by `id`. Optional: a caller falls back to parallel `get` calls when an
	 * adapter does not implement it (see `PublicCatalogService.resolveKind`). Every key passed in
	 * shares `kind`/`locale`, so `id` alone is enough to key the result.
	 */
	getMany?<K extends CatalogKind>(
		keys: readonly CatalogCacheKey<K>[],
	): Promise<Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>>;
	set<K extends CatalogKind>(
		key: CatalogCacheKey<K>,
		record: CatalogCacheRecord<CatalogEntityByKind[K]>,
	): Promise<void>;
	dispose(): void;
}

/** Process-local cache adapter. Persistent storage stays outside this vertical. */
export class MemoryCatalogCache implements CatalogCacheAdapter {
	private readonly records = new Map<string, CatalogCacheRecord<CatalogEntity>>();

	async get<K extends CatalogKind>(
		cacheKey: CatalogCacheKey<K>,
	): Promise<CatalogCacheRecord<CatalogEntityByKind[K]> | undefined> {
		const record = this.records.get(key(cacheKey));
		return (record === undefined ? undefined : structuredClone(record)) as
			| CatalogCacheRecord<CatalogEntityByKind[K]>
			| undefined;
	}

	async getMany<K extends CatalogKind>(
		cacheKeys: readonly CatalogCacheKey<K>[],
	): Promise<Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>> {
		const results = new Map<number, CatalogCacheRecord<CatalogEntityByKind[K]>>();
		for (const cacheKey of cacheKeys) {
			const record = this.records.get(key(cacheKey));
			if (record !== undefined) {
				results.set(cacheKey.id, structuredClone(record) as CatalogCacheRecord<CatalogEntityByKind[K]>);
			}
		}
		return results;
	}

	async set<K extends CatalogKind>(
		cacheKey: CatalogCacheKey<K>,
		record: CatalogCacheRecord<CatalogEntityByKind[K]>,
	): Promise<void> {
		this.records.set(key(cacheKey), structuredClone(record));
	}

	dispose(): void {
		this.records.clear();
	}
}

function key(cacheKey: CatalogCacheKey): string {
	return [
		cacheKey.kind,
		cacheKey.locale,
		cacheKey.id,
		cacheKey.schemaVersion,
		cacheKey.normalizerVersion,
	].join(':');
}
