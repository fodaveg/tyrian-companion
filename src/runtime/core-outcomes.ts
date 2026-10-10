/**
 * Mappers from a service or controller state to the `ProductActionOutcome` (or failure record) the
 * action observability reads (DE-01, step 1). Moved here unchanged from `tyrian-companion-core.ts`.
 */
import type { AssistedDetectionState } from '../sessions/assisted-detection-service';
import type { ProductActionOutcome } from '../ui/product-action-controller';
import type { InventoryAdvisorViewModel } from '../ui/inventory-advisor-view-model';
import type { InventoryVaultSyncViewState } from '../ui/inventory-vault-sync-controller';
import type { InventoryVaultSyncRunState } from '../ui/inventory-vault-sync-run-controller';
import type { WalletVaultSyncViewState } from '../wallet/wallet-vault-sync';

export function detectionActionOutcome(
	state: AssistedDetectionState,
	request: 'arm' | 'disarm',
): ProductActionOutcome {
	if (state.status === 'error') return 'failed';
	if (request === 'disarm') return state.status === 'disarmed' ? 'completed' : 'unavailable';
	return state.status === 'armed' || state.status === 'start_proposed' || state.status === 'stop_proposed'
		? 'completed' : 'unavailable';
}


export function advisorActionOutcome(model: InventoryAdvisorViewModel): ProductActionOutcome {
	if (model.status === 'blocked' && model.blockedReason === 'credential_unavailable') return 'unavailable';
	if (model.status === 'blocked' || model.status === 'invalid' || model.refreshWarning !== undefined) return 'failed';
	return model.status === 'loading' ? 'unavailable' : 'completed';
}

export function vaultSyncActionOutcome(
	state: InventoryVaultSyncViewState | WalletVaultSyncViewState,
	request: 'preview' | 'apply',
): ProductActionOutcome {
	if (state.status === 'disabled') return 'unavailable';
	if (state.status === 'conflict' || state.status === 'error') return 'failed';
	if (request === 'preview') return state.status === 'preview' ? 'completed' : 'unavailable';
	return state.status === 'success' ? 'completed' : 'unavailable';
}

/**
 * H15.11 (2026-09-10 incident): `applyInventoryVaultSync`/`applyWalletVaultSync` never inspected
 * the result of their own write, so `run()` always logged `success ok` even after the apply hit a
 * real storage rejection mid-plan. `code` is fixed at `storage_failure` (this subsystem's only
 * write-failure code); `reason` inside `details` carries which of the shared machine's error
 * branches actually fired.
 */
export function vaultSyncFailureOutcome(
	state: InventoryVaultSyncViewState | WalletVaultSyncViewState,
): { phase: 'failure'; code: 'storage_failure'; details: Record<string, unknown> } | undefined {
	if (state.status !== 'error') return undefined;
	return {
		phase: 'failure', code: 'storage_failure',
		details: { reason: state.reason, errorName: state.cause, written: state.written },
	};
}

/** Same idea as `vaultSyncFailureOutcome`, for the one-click runner's own idle+lastRun shape. */
export function inventoryOneClickSyncOutcome(
	state: InventoryVaultSyncRunState,
): { phase: 'failure'; code: 'storage_failure'; details: Record<string, unknown> } | undefined {
	if (state.status !== 'idle' || state.lastRun === null || state.lastRun.status !== 'error') return undefined;
	return {
		phase: 'failure', code: 'storage_failure',
		details: { reason: state.lastRun.error, errorName: state.lastRun.errorName, written: state.lastRun.written },
	};
}
