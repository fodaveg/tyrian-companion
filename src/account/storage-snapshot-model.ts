export const PINNED_SCHEMA = '2024-07-20T01:00:00.000Z';

export type SnapshotQuality =
	| 'stable'
	| 'stable_owned_placement_changed'
	| 'partial'
	| 'unstable';

export type StorageSource =
	| 'characters'
	| 'shared_inventory'
	| 'bank'
	| 'materials'
	| 'wallet'
	| 'commerce_delivery';

export type CoverageStatus = 'complete' | 'partial' | 'skipped';

export interface SourceCoverage {
	status: CoverageStatus;
	reason?:
		| 'missing_scope'
		| 'url_restricted'
		| 'not_requested'
		| 'missing_character'
		| 'partial_response'
		| 'unavailable';
	diagnostic?: {
		kind: 'http' | 'timeout' | 'network';
		status: number | null;
		retryAfterMs: number | null;
	};
}

export interface SnapshotCoverage {
	sources: Record<StorageSource, SourceCoverage>;
	characters: Record<string, SourceCoverage>;
}

export type ItemLocation =
	| { source: 'character'; character: string; container: 'equipped_bag'; bagIndex: number }
	| { source: 'character'; character: string; container: 'bag'; bagIndex: number; slot: number }
	| { source: 'shared_inventory'; slot: number }
	| { source: 'bank'; slot: number }
	| { source: 'materials'; category: number }
	| { source: 'commerce_delivery'; slot: number };

export interface ItemMetadata {
	binding?: string;
	boundTo?: string;
	skin?: number;
	statsId?: number;
	statsAttributes?: Record<string, number>;
	charges?: number;
}

export interface ItemHolding {
	kind: 'item';
	itemId: number;
	quantity: number;
	state:
		| 'loose'
		| 'equipped_container'
		| 'embedded_upgrade'
		| 'embedded_infusion'
		| 'pending_claim';
	location: ItemLocation;
	metadata: ItemMetadata;
	parentItemId?: number;
	embeddedKind?: 'upgrade' | 'infusion';
}

export interface CurrencyHolding {
	kind: 'currency';
	namespace: 'wallet' | 'delivery';
	currencyId: number;
	quantity: number;
}

export interface CurrencyTotal {
	total: number;
	wallet: number;
	delivery: number;
}

export interface StorageSnapshotPass {
	holdings: ItemHolding[];
	currencies: CurrencyHolding[];
	availableByItem: Record<string, number>;
	ownedByItem: Record<string, number>;
	currencyById: Record<string, CurrencyTotal>;
	coverage: SnapshotCoverage;
	roster: string[];
}

export interface StorageSnapshot extends StorageSnapshotPass {
	snapshotId: string;
	accountId: string;
	startedAt: string;
	completedAt: string;
	passCoverages: SnapshotCoverage[];
	quality: SnapshotQuality;
	passes: 1 | 2 | 3;
	schemaVersion: typeof PINNED_SCHEMA;
}

export class SnapshotCapabilityError extends Error {
	constructor(readonly missingScopes: string[]) {
		super(`Storage snapshot requires: ${missingScopes.join(', ')}.`);
		this.name = 'SnapshotCapabilityError';
	}
}

export class InvalidSnapshotPayloadError extends Error {
	constructor(source: string) {
		super(`The ${source} response was invalid.`);
		this.name = 'InvalidSnapshotPayloadError';
	}
}
