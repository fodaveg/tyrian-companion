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
