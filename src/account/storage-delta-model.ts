import type { ItemLocation, ItemMetadata, SnapshotQuality } from './storage-snapshot-model';

export const STORAGE_DELTA_VERSION = 1 as const;

export type StorageDeltaStatus = 'comparable' | 'limited' | 'invalid';

export type StorageDeltaReasonCode =
	| 'invalid_snapshot'
	| 'account_mismatch'
	| 'schema_mismatch'
	| 'snapshot_id_reused'
	| 'invalid_window'
	| 'overlapping_window'
	| 'unsupported_quality'
	| 'core_coverage_incomplete'
	| 'character_coverage_incomplete'
	| 'aggregate_invariant_failed'
	| 'delivery_excluded';

export interface StorageDeltaReason {
	code: StorageDeltaReasonCode;
	snapshot?: 'before' | 'after' | 'both';
	detail?: string;
}

export interface StorageDeltaWarning {
	code:
		| 'delivery_coverage_asymmetric'
		| 'wallet_unobserved'
		| 'wallet_coverage_asymmetric'
		| 'placement_changed_during_capture'
		| 'roster_changed'
		| 'surface_excludes_equipment_mail_guild_and_active_tp'
		| 'net_only_gross_turnover_unknown';
	before?: string;
	after?: string;
}

export interface QuantityChange {
	id: number;
	before: number;
	after: number;
	delta: number;
}

export interface ItemCompositionPart {
	quantity: number;
	state: 'loose' | 'equipped_container' | 'embedded_upgrade' | 'embedded_infusion' | 'pending_claim';
	location: ItemLocation;
	metadata: ItemMetadata;
	parentItemId?: number;
	embeddedKind?: 'upgrade' | 'infusion';
}

export interface CurrencyCompositionPart {
	quantity: number;
	namespace: 'wallet' | 'delivery';
}

export type CompositionChange =
	| {
			kind: 'item';
			id: number;
			before: ItemCompositionPart[];
			after: ItemCompositionPart[];
	  }
	| {
			kind: 'currency';
			id: number;
			before: CurrencyCompositionPart[];
			after: CurrencyCompositionPart[];
	  };

export interface StorageDelta {
	version: typeof STORAGE_DELTA_VERSION;
	status: StorageDeltaStatus;
	accountId: string | null;
	beforeSnapshotId: string | null;
	afterSnapshotId: string | null;
	window: { from: string; to: string } | null;
	surface: 'core_and_delivery' | 'core_only' | null;
	currencySurface: 'wallet_and_delivery' | 'wallet_only' | 'unavailable' | null;
	reasons: StorageDeltaReason[];
	warnings: StorageDeltaWarning[];
	itemChanges: QuantityChange[];
	currencyChanges: QuantityChange[];
	availabilityChanges: QuantityChange[];
	compositionChanges: CompositionChange[];
}

export const COMPARABLE_SNAPSHOT_QUALITIES: ReadonlySet<SnapshotQuality> = new Set([
	'stable',
	'stable_owned_placement_changed',
]);
