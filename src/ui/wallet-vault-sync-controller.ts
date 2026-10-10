import type {
	WalletVaultSyncPlan,
	WalletVaultSyncResult,
} from '../wallet/wallet-vault-sync';
import type {
	VaultSyncControllerPorts,
	VaultSyncDisabledReason,
	VaultSyncErrorReason,
	VaultSyncPlanSummary,
	VaultSyncViewState,
} from './vault-sync-controller';
import { VaultSyncController, summarizeVaultSyncPlan } from './vault-sync-controller';

export type WalletVaultSyncDisabledReason = VaultSyncDisabledReason;
export type WalletVaultSyncErrorReason = VaultSyncErrorReason;
export type WalletVaultSyncPlanSummary = VaultSyncPlanSummary;
export type WalletVaultSyncViewState = VaultSyncViewState<WalletVaultSyncResult>;
export type WalletVaultSyncControllerPorts = VaultSyncControllerPorts<WalletVaultSyncPlan, WalletVaultSyncResult>;

/** Wallet binding of the shared Vault sync machine; states and races live in `VaultSyncController`. */
export class WalletVaultSyncController extends VaultSyncController<WalletVaultSyncPlan, WalletVaultSyncResult> {}

/** Test seed (DE-09): the wallet binding of `summarizeVaultSyncPlan`; only its own test calls it. */
export function summarizeWalletVaultSyncPlan(plan: WalletVaultSyncPlan): WalletVaultSyncPlanSummary {
	return summarizeVaultSyncPlan(plan);
}
