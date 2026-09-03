import type { StorageDelta } from './storage-delta-model';

export const BOUNDARY_EVIDENCE_VERSION = 1 as const;
export const SESSION_CLASSIFICATION_VERSION = 2 as const;
export const LEGACY_SESSION_CLASSIFICATION_VERSION = 1 as const;

export type BoundaryCoverage = 'complete_both' | 'missing_both' | 'asymmetric';

export interface BoundaryQuantityEvidence {
	before: number;
	after: number;
	delta: number;
}

export interface BoundaryItemEvidence extends BoundaryQuantityEvidence {
	id: number;
}

export interface BoundaryDeliveryCoinEvidence extends BoundaryQuantityEvidence {
	id: 1;
}

export type BoundaryEvidenceReasonCode =
	| 'invalid_snapshot'
	| 'account_mismatch'
	| 'snapshot_id_reused'
	| 'invalid_window'
	| 'overlapping_window';

export interface BoundaryEvidenceReason {
	code: BoundaryEvidenceReasonCode;
	snapshot?: 'before' | 'after' | 'both';
}

export interface BoundaryEvidence {
	version: typeof BOUNDARY_EVIDENCE_VERSION;
	status: 'valid' | 'invalid';
	accountId: string | null;
	beforeSnapshotId: string | null;
	afterSnapshotId: string | null;
	window: { from: string; to: string } | null;
	delivery: {
		coverage: BoundaryCoverage;
		items: BoundaryItemEvidence[];
		coins: BoundaryDeliveryCoinEvidence;
	};
	wallet: {
		coverage: BoundaryCoverage;
		currencies: BoundaryItemEvidence[];
	};
	reasons: BoundaryEvidenceReason[];
}

export type TradingPostEvidenceStatus = 'complete' | 'partial' | 'unavailable';

export interface TradingPostEvent {
	kind: 'buy' | 'sell';
	itemId: number;
	quantity: number;
	coins: number;
	occurredAt: string;
}

export type DeclaredActivity =
	| 'open'
	| 'salvage'
	| 'consume'
	| 'craft'
	| 'tp'
	| 'vendor'
	| 'transfer'
	| 'other';

export type UserDeclaration =
	| { status: 'confirmed_clean' }
	| { status: 'activities'; activities: DeclaredActivity[] }
	| { status: 'unsure' }
	| { status: 'absent' };

export interface SessionClassificationContext {
	boundary: BoundaryEvidence;
	tradingPost: {
		status: TradingPostEvidenceStatus;
		events: TradingPostEvent[];
	};
	declaration: UserDeclaration;
	boundaryCertainty: 'manual_confirmed' | 'auto_confirmed' | 'auto_uncertain';
	/**
	 * Whether the final snapshot waited the documented Guild Wars 2 cache window before reading
	 * the account. Absent means the caller has no session stop boundary to declare (the kernel is
	 * also used to classify a bare pair of snapshots); a session flow always declares it.
	 */
	apiSettlement?: 'settled' | 'skipped' | 'exceeded';
}

export type SessionClassificationStatus = 'exact' | 'estimated' | 'contaminated' | 'invalid';

export type SessionClassificationReasonCode =
	| 'delta_invalid'
	| 'boundary_invalid'
	| 'boundary_delta_mismatch'
	| 'boundary_arithmetic_invalid'
	| 'delta_arithmetic_invalid'
	| 'classification_context_invalid'
	| 'trading_post_evidence_invalid'
	| 'delivery_items_changed'
	| 'delivery_coins_changed'
	| 'tp_buy_observed'
	| 'tp_sell_observed'
	| 'wallet_decreased'
	| 'consumable_currency_spent'
	| 'wallet_increased_ambiguous'
	| 'wallet_increase_clean_confirmation_used'
	| 'roster_changed'
	| 'character_unobserved'
	| 'activity_declared'
	| 'open_activity_declared'
	| 'item_losses_observed'
	| 'clean_declaration_conflicts_with_evidence'
	| 'delta_limited'
	| 'boundary_not_manually_confirmed'
	| 'api_settlement_window_skipped'
	| 'api_settlement_window_exceeded'
	| 'declaration_not_clean'
	| 'trading_post_not_complete_clean_declaration_used';

export interface SessionClassificationReason {
	code: SessionClassificationReasonCode;
	detail?: string;
}

export type SessionReviewRequestCode =
	| 'repair_boundary_evidence'
	| 'review_detected_external_activity'
	| 'confirm_session_boundaries'
	| 'confirm_session_cleanliness'
	| 'review_wallet_increase'
	| 'review_limited_surface'
	| 'review_consumed_inputs';

export interface SessionReviewRequest {
	code: SessionReviewRequestCode;
}

export interface SessionPermissions {
	finalize: boolean;
	showNet: boolean;
	valueNet: boolean;
	grossPerHour: boolean;
	recommend: boolean;
}

export interface SessionDeltaClassification {
	version: typeof SESSION_CLASSIFICATION_VERSION;
	status: SessionClassificationStatus;
	confidence: 'high' | 'medium' | 'low';
	scope: 'observed_storage_net';
	reasons: SessionClassificationReason[];
	reviewRequests: SessionReviewRequest[];
	permissions: SessionPermissions;
}

export type ClassifiableStorageDelta = StorageDelta;
