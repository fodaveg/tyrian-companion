export type ManagedAssetsAction = 'preview' | 'apply' | 'repair' | 'move' | 'remove';

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
