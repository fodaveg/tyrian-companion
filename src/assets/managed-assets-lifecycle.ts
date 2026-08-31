import type { ManagedAssetsManager, ManagedAssetsResult } from './managed-assets';
import type { ManagedAssetsPointerState, ManagedAssetsPointerStore } from './managed-assets-pointer';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type LocalDebugActionSpan,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';

export type ManagedAssetsLifecycleResult = { status: 'applied' | 'removed' | 'relocated' | 'unchanged'; root: string | null; generation: number } | { status: 'busy' | 'conflict' | 'unavailable'; message: string };

export class ManagedAssetsLifecycle {
	constructor(
		private readonly manager: Pick<ManagedAssetsManager, 'apply' | 'relocate' | 'uninstall' | 'inspect' | 'inspectForLegacyTransition'>,
		private readonly pointer: ManagedAssetsPointerStore,
		private readonly diagnostics?: LocalDebugActionPort,
	) {}

	async install(root: string, parent?: ResolvedLocalDebugActionContext): Promise<ManagedAssetsLifecycleResult> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'assets', action: 'managed_assets_apply', ...inheritedIds(parent),
		});
		try {
			const result = await this.installInternal(root);
			finishLifecycleSpan(span, result);
			return result;
		} catch (error) {
			span.failure(error, 'storage_failure', 'unavailable');
			throw error;
		}
	}

	private async installInternal(root: string): Promise<ManagedAssetsLifecycleResult> {
		let current = await this.pointer.read();
		if (current.status === 'installing' && current.targetRoot === root) {
			// Resume the exact durable intent after a crash or from another window.
		} else if (current.status !== 'ready') return { status: 'busy', message: 'Another managed-assets lifecycle operation is active.' };
		if (current.root === root) {
			const upgraded = await this.manager.apply(root, 'upgrade');
			return successResult(upgraded, 'applied', current);
		}
		if (current.status === 'ready' && current.root !== null) return { status: 'conflict', message: 'Another managed-assets root is active.' };
		const claim = current.status === 'installing' ? current : await this.pointer.compareAndSet(current, { status: 'installing', root: null, targetRoot: root });
		if (!claim) return { status: 'busy', message: 'Another managed-assets lifecycle operation won the race.' };
		current = claim;
		const installed = await this.manager.apply(root, 'install');
		if (!isSuccess(installed)) {
			// Release only when inspection proves no manifest/journal was ever established.
			try {
				const inspection = await this.manager.inspect(root);
				if (inspection.manifestStatus === 'missing') await this.pointer.compareAndSet(current, { status: 'ready', root: null, targetRoot: null });
			} catch { /* retain installing authority for explicit retry/reconcile */ }
			return failure(installed);
		}
		const ready = await this.pointer.compareAndSet(current, { status: 'ready', root, targetRoot: null });
		if (!ready) {
			const raced = await this.pointer.read();
			if (raced.status === 'ready' && raced.root === root) return { status: 'unchanged', root, generation: raced.generation };
			return { status: 'conflict', message: 'The managed-assets pointer changed before install completed.' };
		}
		return { status: installed.status === 'unchanged' ? 'unchanged' : 'applied', root, generation: ready.generation };
	}

	async remove(
		expectedLegacyRoot?: string,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<ManagedAssetsLifecycleResult> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'assets', action: 'managed_assets_remove', ...inheritedIds(parent),
		});
		try {
			const result = await this.removeInternal(expectedLegacyRoot);
			finishLifecycleSpan(span, result);
			return result;
		} catch (error) {
			span.failure(error, 'storage_failure', 'unavailable');
			throw error;
		}
	}

	private async removeInternal(expectedLegacyRoot?: string): Promise<ManagedAssetsLifecycleResult> {
		let current = await this.pointer.read();
		if (expectedLegacyRoot !== undefined) {
			const adopted = await this.adoptExpectedLegacyRoot(current, expectedLegacyRoot, true);
			if ('failure' in adopted) return adopted.failure;
			if ('removed' in adopted) return adopted.removed;
			current = adopted.current;
		}
		if (current.status === 'ready' && current.root === null) return { status: 'unchanged', root: null, generation: current.generation };
		if (current.status === 'ready' && current.root !== null) {
			const claim = await this.pointer.compareAndSet(current, { status: 'removing', root: current.root, targetRoot: null });
			if (!claim) return { status: 'busy', message: 'Another managed-assets lifecycle operation won the race.' };
			current = claim;
		}
		if (current.status !== 'removing') return { status: 'busy', message: 'Another managed-assets lifecycle operation is active.' };
		const removed = await this.manager.uninstall(current.root);
		if (!isSuccess(removed) || (removed.status !== 'detached' && removed.status !== 'unchanged')) return failure(removed);
		const ready = await this.pointer.compareAndSet(current, { status: 'ready', root: null, targetRoot: null });
		if (!ready) {
			const raced = await this.pointer.read();
			return raced.status === 'ready' && raced.root === null ? { status: 'unchanged', root: null, generation: raced.generation } : { status: 'conflict', message: 'The managed-assets pointer changed before remove completed.' };
		}
		return { status: 'removed', root: null, generation: ready.generation };
	}

	async move(
		to: string,
		expectedLegacyRoot?: string,
		parent?: ResolvedLocalDebugActionContext,
	): Promise<ManagedAssetsLifecycleResult> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'assets', action: 'managed_assets_relocate', ...inheritedIds(parent),
		});
		try {
			const result = await this.moveInternal(to, expectedLegacyRoot);
			finishLifecycleSpan(span, result);
			return result;
		} catch (error) {
			span.failure(error, 'storage_failure', 'unavailable');
			throw error;
		}
	}

	private async moveInternal(to: string, expectedLegacyRoot?: string): Promise<ManagedAssetsLifecycleResult> {
		let current = await this.pointer.read();
		if (expectedLegacyRoot !== undefined) {
			const adopted = await this.adoptExpectedLegacyRoot(current, expectedLegacyRoot);
			if ('failure' in adopted) return adopted.failure;
			if ('removed' in adopted) return adopted.removed;
			current = adopted.current;
		}
		if (current.status === 'ready' && current.root === to) return { status: 'unchanged', root: to, generation: current.generation };
		let from: string;
		if (current.status === 'ready' && current.root !== null) {
			from = current.root;
			const claim = await this.pointer.compareAndSet(current, { status: 'moving', root: from, targetRoot: to });
			if (!claim) return { status: 'busy', message: 'Another managed-assets lifecycle operation won the race.' };
			current = claim;
		} else if (current.status === 'moving' && current.targetRoot === to) from = current.root;
		else if (current.status === 'moving' && current.root === to) from = current.targetRoot;
		else return { status: 'busy', message: 'Another managed-assets lifecycle operation is active.' };
		if (current.root === from) {
			const installed = await this.manager.relocate(from, to);
			if (!isSuccess(installed)) return failure(installed);
			const switched = await this.pointer.compareAndSet(current, { status: 'moving', root: to, targetRoot: from });
			if (!switched) {
				const raced = await this.pointer.read();
				if ((raced.status === 'moving' && raced.root === to && raced.targetRoot === from) || (raced.status === 'ready' && raced.root === to)) return { status: 'unchanged', root: to, generation: raced.generation };
				return { status: 'conflict', message: 'The managed-assets pointer changed before destination activation.' };
			}
			current = switched;
		}
		const asserted = await this.pointer.read();
		if (JSON.stringify(asserted) !== JSON.stringify(current)) return { status: 'conflict', message: 'The managed-assets pointer changed before origin cleanup.' };
		const removed = await this.manager.uninstall(from);
		if (!isSuccess(removed) || (removed.status !== 'detached' && removed.status !== 'unchanged')) return failure(removed);
		const ready = await this.pointer.compareAndSet(current, { status: 'ready', root: to, targetRoot: null });
		if (!ready) return { status: 'conflict', message: 'The managed-assets pointer changed before relocation completed.' };
		return { status: 'relocated', root: to, generation: ready.generation };
	}

	/**
	 * A settings migration may retain a historical root before IndexedDB ever
	 * held an authority for it. It becomes authoritative only inside the
	 * requested Move/Remove after an exact, read-only ownership inspection.
	 */
	private async adoptExpectedLegacyRoot(
		current: ManagedAssetsPointerState,
		expectedRoot: string,
		acceptDetachedRemoval = false,
	): Promise<{ current: ManagedAssetsPointerState } | { removed: ManagedAssetsLifecycleResult } | { failure: ManagedAssetsLifecycleResult }> {
		if (current.status !== 'ready') return { failure: { status: 'busy', message: 'Another managed-assets lifecycle operation is active.' } };
		if (current.root !== null && current.root !== expectedRoot) return { failure: { status: 'conflict', message: 'The managed-assets pointer names a different root.' } };
		let inspection: Awaited<ReturnType<ManagedAssetsManager['inspectForLegacyTransition']>>;
		try { inspection = await this.manager.inspectForLegacyTransition(expectedRoot); }
		catch { return { failure: { status: 'unavailable', message: 'The retained managed-assets root could not be inspected.' } }; }
		if (inspection.root !== expectedRoot || inspection.manifest?.root !== expectedRoot) {
			return { failure: { status: 'conflict', message: 'The retained managed-assets root has no exact owned manifest.' } };
		}
		if (acceptDetachedRemoval && inspection.manifestStatus === 'detached') {
			if (current.root === null) {
				const reasserted = await this.pointer.read();
				if (JSON.stringify(reasserted) !== JSON.stringify(current)) {
					return { failure: { status: 'conflict', message: 'The managed-assets pointer changed while confirming legacy removal.' } };
				}
				return { removed: { status: 'removed', root: null, generation: current.generation } };
			}
			return { current };
		}
		if (inspection.manifestStatus !== 'ready') return { failure: { status: 'conflict', message: 'The retained managed-assets root has no exact owned manifest.' } };
		if (current.root === expectedRoot) return { current };
		const adopted = await this.pointer.compareAndSet(current, { status: 'ready', root: expectedRoot, targetRoot: null });
		if (adopted) return { current: adopted };
		const raced = await this.pointer.read();
		if (raced.status === 'ready' && raced.root === expectedRoot) return { current: raced };
		return { failure: { status: 'conflict', message: 'The managed-assets pointer changed before legacy adoption.' } };
	}
}

function isSuccess(result: ManagedAssetsResult): result is Extract<ManagedAssetsResult, { status: 'applied' | 'unchanged' | 'detached' }> { return !('message' in result); }
function failure(result: ManagedAssetsResult): ManagedAssetsLifecycleResult { return 'message' in result ? { status: result.status === 'busy' ? 'busy' : result.status === 'unavailable' ? 'unavailable' : 'conflict', message: result.message } : { status: 'conflict', message: 'Managed-assets evidence did not reach the required state.' }; }
function successResult(result: ManagedAssetsResult, status: 'applied', pointer: ManagedAssetsPointerState): ManagedAssetsLifecycleResult { return isSuccess(result) ? { status: result.status === 'unchanged' ? 'unchanged' : status, root: pointer.root, generation: pointer.generation } : failure(result); }

function finishLifecycleSpan(span: LocalDebugActionSpan, result: ManagedAssetsLifecycleResult): void {
	if (result.status === 'applied' || result.status === 'removed' || result.status === 'relocated') {
		span.success(result.status);
	} else if (result.status === 'unchanged' || result.status === 'busy') {
		span.skip('skipped', result.status);
	} else if (result.status === 'unavailable') {
		span.failure(new Error('managed_assets_unavailable'), 'storage_failure', result.status);
	} else {
		span.failure(new Error('managed_assets_conflict'), 'validation_failed', result.status);
	}
}

function inheritedIds(parent: ResolvedLocalDebugActionContext | undefined):
	{ parent: Pick<ResolvedLocalDebugActionContext, 'actionId' | 'correlationId'> } | Record<string, never> {
	return parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } };
}
