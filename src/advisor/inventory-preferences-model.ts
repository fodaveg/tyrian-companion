import type { KeepExceptionV1 } from './inventory-advisor-model';
import type { ReservationGoal } from '../economy/reservation-model';

/** Opaque local diagnostic identity; structural here to keep the domain model core-independent. */
export interface InventoryPreferencesActionContext {
	readonly actionId: string;
	readonly correlationId: string;
}

export const INVENTORY_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const INVENTORY_PREFERENCES_DB_VERSION = 1 as const;
export const INVENTORY_PREFERENCES_DB_NAME = 'tyrian-companion-inventory-preferences';
export const INVENTORY_PREFERENCES_STORE_NAME = 'preferences';

/** The vault and Guild Wars 2 account are both part of every durable key. */
export interface InventoryPreferenceScope {
	vaultId: string;
	accountId: string;
}

/**
 * Durable, account-scoped intent only. These data never compute or authorize an
 * advisor action by themselves; H4.13 remains the sole recommendation boundary.
 */
export interface InventoryPreferencesV1 extends InventoryPreferenceScope {
	schemaVersion: typeof INVENTORY_PREFERENCES_SCHEMA_VERSION;
	generation: number;
	updatedAt: string;
	goals: ReservationGoal[];
	keepExceptions: KeepExceptionV1[];
}

export type InventoryPreferencesFailureCode = 'corrupt' | 'future_schema' | 'unavailable';

export type InventoryPreferencesReadResult =
	| { status: 'ok'; record: InventoryPreferencesV1 | null }
	| { status: 'error'; code: InventoryPreferencesFailureCode };

export type InventoryPreferencesWriteResult =
	| { status: 'saved'; record: InventoryPreferencesV1 }
	| { status: 'conflict'; generation: number }
	| { status: 'error'; code: InventoryPreferencesFailureCode };

/**
 * Minimal persistence port. The compare-and-swap is atomic in the adapter so
 * two Obsidian windows cannot silently overwrite each other's preferences.
 */
export interface InventoryPreferencesStore {
	read(
		scope: InventoryPreferenceScope,
		actionContext?: InventoryPreferencesActionContext,
	): Promise<InventoryPreferencesReadResult>;
	compareAndSwap(
		scope: InventoryPreferenceScope,
		expectedGeneration: number,
		next: InventoryPreferencesV1,
		actionContext?: InventoryPreferencesActionContext,
	): Promise<InventoryPreferencesWriteResult>;
	dispose(): void;
}

export type InventoryPreferencesOperationResult =
	| { status: 'ok'; record: InventoryPreferencesV1 | null }
	| { status: 'conflict'; generation: number }
	| { status: 'invalid' }
	| { status: 'error'; code: InventoryPreferencesFailureCode };
