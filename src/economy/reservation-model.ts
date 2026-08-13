import type { SessionValuation } from './session-valuation';

export const RESERVATION_SCHEMA_VERSION = 1 as const;
export type AssetNamespace = 'item' | 'currency';
export type ReservationReason = 'achievement' | 'purchase' | 'personal';
export type IntendedUse = 'hold' | 'open' | 'consume' | 'exchange' | 'spend';
export type ReservationBasis = 'owned' | 'available';
export type ReservationCoverage = 'complete' | 'limited' | 'unknown';

export interface ReservationRequirement {
	key: string;
	namespace: AssetNamespace;
	id: number;
	targetQuantity: number;
	creditedQuantity: number;
	basis: ReservationBasis;
	intendedUse: IntendedUse;
}

export interface ReservationGoal {
	schemaVersion: typeof RESERVATION_SCHEMA_VERSION;
	goalId: string;
	title: string;
	status: 'active' | 'paused' | 'completed';
	priority: number;
	reason: ReservationReason;
	requirements: ReservationRequirement[];
}

export interface ReservationAssetBalance {
	key: string;
	namespace: AssetNamespace;
	id: number;
	ownedQuantity: number;
	availableQuantity: number;
	coverage: ReservationCoverage;
}

export interface ReservationBalance {
	accountId: string;
	snapshotId: string;
	capturedAt: string;
	coverage: Record<AssetNamespace, ReservationCoverage>;
	assets: ReservationAssetBalance[];
}

export interface ReservationAllocation {
	goalId: string;
	priority: number;
	reason: ReservationReason;
	required: number;
	satisfied: number;
	protectedAvailable: number;
	shortfall: number;
	basis: ReservationBasis;
	intendedUse: IntendedUse;
}

export interface ReservationAllowances {
	liquidate: number | null;
	open: number | null;
	consume: number | null;
	exchange: number | null;
	spend: number | null;
}

export interface ReservationPlanAsset extends ReservationAssetBalance {
	requested: number;
	protectedAvailable: number;
	unprotectedAvailable: number;
	shortfall: number;
	allocations: ReservationAllocation[];
	allowances: ReservationAllowances;
}

export interface ReservationWarning {
	code: 'limited_balance' | 'unknown_balance' | 'insufficient_quantity' | 'multiple_goals_same_asset';
	key: string;
}

export interface ReservationPlan {
	schemaVersion: typeof RESERVATION_SCHEMA_VERSION;
	accountId: string;
	snapshotId: string;
	capturedAt: string;
	coverage: 'complete' | 'limited' | 'blocked';
	satisfaction: 'met' | 'shortfall';
	assets: ReservationPlanAsset[];
	warnings: ReservationWarning[];
}

export interface SessionValuationReservationLine {
	itemId: number;
	gainedQuantity: number;
	protectedFromLiquidation: number | null;
	liquidationEligible: number | null;
	openEligible: number | null;
	consumeEligible: number | null;
	exchangeEligible: number | null;
}

export interface SessionValuationReservationOverlay {
	schemaVersion: typeof RESERVATION_SCHEMA_VERSION;
	accountId: string;
	snapshotId: string;
	sackItemIds: number[];
	valuation: SessionValuation;
	lines: SessionValuationReservationLine[];
}
