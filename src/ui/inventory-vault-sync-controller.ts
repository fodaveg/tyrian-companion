import type {
	InventoryVaultSyncPlan,
	InventoryVaultSyncResult,
} from '../inventory/inventory-vault-sync';
import type {
	VaultSyncControllerPorts,
	VaultSyncDisabledReason,
	VaultSyncErrorReason,
	VaultSyncPlanSummary,
	VaultSyncViewState,
} from './vault-sync-controller';
import { VaultSyncController, summarizeVaultSyncPlan } from './vault-sync-controller';

export type InventoryVaultSyncDisabledReason = VaultSyncDisabledReason;
export type InventoryVaultSyncErrorReason = VaultSyncErrorReason;
export type InventoryVaultSyncPlanSummary = VaultSyncPlanSummary;
export type InventoryVaultSyncViewState = VaultSyncViewState<InventoryVaultSyncResult>;
export type InventoryVaultSyncControllerPorts = VaultSyncControllerPorts<InventoryVaultSyncPlan, InventoryVaultSyncResult>;

/** Inventory binding of the shared Vault sync machine; states and races live in `VaultSyncController`. */
export class InventoryVaultSyncController extends VaultSyncController<InventoryVaultSyncPlan, InventoryVaultSyncResult> {}

export function summarizeInventoryVaultSyncPlan(plan: InventoryVaultSyncPlan): InventoryVaultSyncPlanSummary {
	return summarizeVaultSyncPlan(plan);
}
