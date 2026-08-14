import type { ManagedAssetsPlan, ManagedAssetStatus } from './managed-assets-model';

export type ManagedAssetsAction = 'preview' | 'apply' | 'repair' | 'move' | 'remove';

/** Closed presentation codes; Vault engines retain their technical diagnostics internally. */
export type ManagedAssetsMessageCode =
	| 'not_inspected' | 'legacy_root_retained' | 'inspecting' | 'preview_ready'
	| 'preview_blocked' | 'inspect_failed' | 'legacy_explicit_only' | 'applying_lifecycle'
	| 'lifecycle_ready' | 'applying_journal' | 'ownership_detached' | 'assets_ready'
	| 'operation_busy' | 'operation_conflict' | 'operation_invalid' | 'operation_unavailable';

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
		move: !context.working && context.hasManagedRoot && context.canMove,
		remove: !context.working && context.hasManagedRoot,
	};
}

export async function runConfirmedManagedAssetsRemoval(
	confirm: () => Promise<boolean>,
	remove: () => Promise<void>,
): Promise<boolean> {
	if (!await confirm()) return false;
	await remove();
	return true;
}
