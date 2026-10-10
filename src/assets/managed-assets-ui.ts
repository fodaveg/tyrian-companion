import type { ManagedAssetsPlan, ManagedAssetStatus } from './managed-assets-model';

export type ManagedAssetsAction = 'preview' | 'apply' | 'repair' | 'replace' | 'move' | 'remove';

/** Closed presentation codes; Vault engines retain their technical diagnostics internally. */
export type ManagedAssetsMessageCode =
	| 'not_inspected' | 'legacy_root_retained' | 'inspecting' | 'preview_ready'
	| 'preview_blocked' | 'inspect_failed' | 'legacy_explicit_only' | 'applying_lifecycle'
	| 'lifecycle_ready' | 'applying_journal' | 'ownership_detached' | 'assets_ready'
	| 'no_unowned' | 'operation_busy' | 'operation_conflict' | 'operation_invalid' | 'operation_unavailable'
	/** The press did nothing: the plugin is still starting / this device only consults. */
	| 'runtime_starting' | 'consult_mode'
	/** The preview found files of the user's that Apply will not touch. */
	| 'preview_unowned' | 'preview_unowned_no_root'
	/** Why an operation failed, when the host or the folder says so (`ManagedAssetsFailureCause`). */
	| 'operation_bytes_not_synced' | 'operation_output_folder_missing' | 'operation_host_refused' | 'operation_only_unowned'
	/** A press asked to create the missing output folder and the host could not. */
	| 'operation_output_folder_create_failed';

/**
 * What a write of the managed-assets row may do besides its own work. `createOutputFolder`: create the output
 * folder when the library lacks it (Hebra; David, 10 Oct 2026 «si no existe, se crea»). Only the Settings presses
 * of Apply, Repair and Replace pass it; a start, an automatic apply, Remove and Move never do.
 */
export interface ManagedAssetsWriteOptions {
	readonly createOutputFolder?: boolean;
}

export interface ManagedAssetsView {
	status: 'idle' | 'working' | 'ready' | 'error';
	message: ManagedAssetsMessageCode;
	plan: ManagedAssetsPlan | null;
}

export type ManagedAssetsVisualStatus = ManagedAssetStatus | 'detached';

export interface ManagedAssetsActionContext {
	working: boolean;
	hasManagedRoot: boolean;
	canMove: boolean;
}

/** Single projection used by Settings so every action is disabled during a durable operation. */
export function projectManagedAssetsActions(context: ManagedAssetsActionContext): Record<ManagedAssetsAction, boolean> {
	return {
		preview: !context.working,
		apply: !context.working,
		repair: !context.working && context.hasManagedRoot,
		replace: !context.working && context.hasManagedRoot,
		move: !context.working && context.hasManagedRoot && context.canMove,
		remove: !context.working && context.hasManagedRoot,
	};
}

export interface ManagedAssetsRootDivergence {
	managedAssetsRoot: string;
	outputFolder: string;
	/** False on a host that cannot move assets between roots (Hebra): the row says Apply, not Move. */
	canMove?: boolean;
}

/**
 * Detects a managed-assets root left behind by an explicit folder change. Legacy roots carry
 * their own retained-state messaging, so they never report a divergence here.
 */
export function projectManagedAssetsRootDivergence(settings: {
	managedAssetsRoot: string | null;
	outputFolder: string;
	legacyManagedAssetsRoot: string | null;
}, canMove = true): ManagedAssetsRootDivergence | null {
	if (settings.legacyManagedAssetsRoot !== null || settings.managedAssetsRoot === null ||
		settings.managedAssetsRoot === settings.outputFolder) return null;
	return { managedAssetsRoot: settings.managedAssetsRoot, outputFolder: settings.outputFolder, ...(canMove ? {} : { canMove: false }) };
}

export async function runConfirmedManagedAssetsRemoval(
	confirm: () => Promise<boolean>,
	remove: () => Promise<void>,
): Promise<boolean> {
	if (!await confirm()) return false;
	await remove();
	return true;
}
