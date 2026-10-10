import { failureEvidence, type ManagedAssetsFailureCause, type ManagedAssetsManager, type ManagedAssetsResult } from './managed-assets';
import type { ManagedAssetsInspection } from './managed-assets-model';
import type { ManagedAssetsPointerState, ManagedAssetsPointerStore } from './managed-assets-pointer';
import {
	startLocalDebugAction,
	type LocalDebugActionPort,
	type LocalDebugActionSpan,
	type ResolvedLocalDebugActionContext,
} from '../core/local-debug-action-runner';

export type ManagedAssetsLifecycleResult = { status: 'applied' | 'removed' | 'relocated' | 'unchanged'; root: string | null; generation: number } | { status: 'busy' | 'conflict' | 'unavailable'; message: string; cause?: ManagedAssetsFailureCause; details?: Record<string, unknown> };

export class ManagedAssetsLifecycle {
	constructor(
		private readonly manager: Pick<ManagedAssetsManager, 'apply' | 'relocate' | 'uninstall' | 'inspect' | 'inspectForLegacyTransition'>,
		private readonly pointer: ManagedAssetsPointerStore,
		private readonly diagnostics?: LocalDebugActionPort,
	) {}

	/** `guard` is handed to the manager's apply (see `ManagedAssetsManager.apply`): the caller's last word on the inspection it acts on. */
	async install(root: string, parent?: ResolvedLocalDebugActionContext, guard?: (inspection: ManagedAssetsInspection) => boolean): Promise<ManagedAssetsLifecycleResult> {
		const span = startLocalDebugAction(this.diagnostics, {
			component: 'assets', action: 'managed_assets_apply', ...inheritedIds(parent),
		});
		try {
			const result = await this.installInternal(root, guard);
			finishLifecycleSpan(span, result);
			return result;
		} catch (error) {
			span.failure(error, 'storage_failure', 'unavailable');
			throw error;
		}
	}

	private async installInternal(root: string, guard?: (inspection: ManagedAssetsInspection) => boolean): Promise<ManagedAssetsLifecycleResult> {
		let current = await this.pointer.read();
		if (current.status === 'installing' && current.targetRoot === root) {
			// Resume the exact durable intent after a crash or from another window.
		} else if (current.status !== 'ready') return { status: 'busy', message: 'Another managed-assets lifecycle operation is active.' };
		if (current.root === root) return await this.installOverExistingAuthority(root, current, guard);
		if (current.status === 'ready' && current.root !== null) {
			const reclaimed = await this.reclaimStalePointer(current, current.root, root);
			if (!reclaimed) return { status: 'conflict', message: 'Another managed-assets root is active.' };
			if ('failure' in reclaimed) return reclaimed.failure;
			if (reclaimed.adopt) return await this.installAdoptedRoot(current.root, root, reclaimed.state, guard);
			return await this.installOverExistingAuthority(root, reclaimed.state, guard);
		}
		const claim = current.status === 'installing' ? current : await this.pointer.compareAndSet(current, { status: 'installing', root: null, targetRoot: root });
		if (!claim) return { status: 'busy', message: 'Another managed-assets lifecycle operation won the race.' };
		current = claim;
		const installed = await this.manager.apply(root, 'install', guard);
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

	/**
	 * Confirms authority over a root the durable pointer already names (or was just reclaimed
	 * for). A root whose entire tracked footprint reports `missing` is the exact signature left
	 * behind when Obsidian moves the folder out from under the plugin: the manifest is still
	 * `ready`, but every file it names is gone. Calling the ordinary upgrade there would recreate
	 * fresh, default-content copies at that abandoned root as a side effect of merely confirming
	 * authority — and a subsequent relocation adopts files by comparing their semantic hash
	 * against THIS root's manifest, so freshly fabricated content would poison that comparison
	 * and make the real files at the destination unrecognizable. Authority is confirmed without
	 * writing anything in that case; an explicit Repair, not an implicit Apply, is what should
	 * ever recreate wholesale-missing content.
	 */
	private async installOverExistingAuthority(root: string, current: ManagedAssetsPointerState, guard?: (inspection: ManagedAssetsInspection) => boolean): Promise<ManagedAssetsLifecycleResult> {
		try {
			const inspection = await this.manager.inspect(root);
			if (inspection.manifestStatus === 'ready' && inspection.assets.length > 0 &&
				inspection.assets.every((entry) => entry.status === 'missing')) {
				return { status: 'unchanged', root, generation: current.generation };
			}
		} catch { /* fall through; apply() below performs its own safe inspection */ }
		const upgraded = await this.manager.apply(root, 'upgrade', guard);
		return successResult(upgraded, 'applied', current);
	}

	/**
	 * A `ready` pointer naming a different root than the one this install targets is reclaimed in
	 * exactly three cases, all through a `compareAndSet` keyed on the exact pointer already read (a
	 * concurrent window that moves the pointer in between always beats this one back to `null`).
	 *
	 * 1. Stale: the named root has decayed to nothing (no manifest and every asset `create`) while
	 * the requested root already carries its own `ready` manifest. A live install, a root still
	 * mid-operation or one that still owns files never qualifies, so an active window's root is
	 * never stepped on.
	 * 2. Adopt: the requested root is the one the settings name, has no manifest (Obsidian stripped
	 * the markers, or it was deleted) and at least one Base matches a published hash (`recoverable`
	 * or `update`, the same proof `decideManagedAssetsAutoUpdate` uses). The old root may still be
	 * alive; it is neither read for this decision nor touched afterwards (what to do with it is the
	 * user's call). A requested root with nothing adoptable never qualifies, so pointing the
	 * settings at a foreign folder cannot make it managed.
	 * 3. Fresh: the named root has decayed to nothing (as in 1) and the requested root has no manifest
	 * either. This is what a host whose vault is the output folder (Hebra) leaves after the output
	 * folder changes: the old root is outside the vault, so it reads as nothing, and no Move can ever
	 * read it. Without this the only possible exit, installing into the new folder, answered
	 * `conflict` for ever (the new folder can only get its manifest from that install). It installs
	 * like case 2, so a folder with nothing but the user's own files still ends in `conflict` and the
	 * pointer goes back to the root it named.
	 *
	 * Anything else leaves this returning `null` and `installInternal` answers `conflict`.
	 */
	private async reclaimStalePointer(current: ManagedAssetsPointerState, staleRoot: string, root: string): Promise<{ state: ManagedAssetsPointerState; adopt: boolean } | { failure: ManagedAssetsLifecycleResult } | null> {
		let adopt = false;
		try {
			const requested = await this.manager.inspect(root);
			adopt = requested.manifestStatus === 'missing' && requested.assets.some((entry) => entry.status === 'recoverable' || entry.status === 'update');
			if (!adopt) {
				const stale = await this.manager.inspect(staleRoot);
				const abandoned = stale.manifestStatus === 'missing' && stale.assets.every((entry) => entry.status === 'create');
				if (!abandoned || (requested.manifestStatus !== 'ready' && requested.manifestStatus !== 'missing')) return null;
				// Fresh (case 3): no manifest to extend, so it is installed like an adopted root.
				adopt = requested.manifestStatus === 'missing';
			}
		} catch (error) {
			// An inspection the host could not complete (bytes not synced, folder missing) keeps its cause: it is not a conflict.
			return { failure: { status: 'unavailable', message: 'The managed-assets roots could not be inspected.', ...failureEvidence(error) } };
		}
		const state = await this.pointer.compareAndSet(current, { status: 'ready', root, targetRoot: null });
		return state ? { state, adopt } : null;
	}

	/**
	 * Installs over a root that has just been adopted from a pointer that named another root. The
	 * ordinary `install` adopts by published hash and writes the manifest. If it fails before any
	 * manifest exists, the pointer goes back to the previous root so that authority is not lost.
	 */
	private async installAdoptedRoot(previousRoot: string, root: string, claim: ManagedAssetsPointerState, guard?: (inspection: ManagedAssetsInspection) => boolean): Promise<ManagedAssetsLifecycleResult> {
		const installed = await this.manager.apply(root, 'install', guard);
		if (isSuccess(installed) && installed.status === 'unchanged' && installed.inspection.manifestStatus === 'missing') {
			// The guard refused (or nothing was left to install): no manifest exists at the new root, so it must not keep the pointer.
			await this.pointer.compareAndSet(claim, { status: 'ready', root: previousRoot, targetRoot: null });
			return { status: 'unchanged', root: previousRoot, generation: claim.generation };
		}
		if (isSuccess(installed)) return successResult(installed, 'applied', claim);
		const inspection = await this.manager.inspect(root);
		if (inspection.manifestStatus === 'missing') await this.pointer.compareAndSet(claim, { status: 'ready', root: previousRoot, targetRoot: null });
		return failure(installed);
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
function failure(result: ManagedAssetsResult): ManagedAssetsLifecycleResult {
	if (!('message' in result)) return { status: 'conflict', message: 'Managed-assets evidence did not reach the required state.' };
	return {
		status: result.status === 'busy' ? 'busy' : result.status === 'unavailable' ? 'unavailable' : 'conflict', message: result.message,
		...(result.cause === undefined ? {} : { cause: result.cause }), ...(result.details === undefined ? {} : { details: result.details }),
	};
}
function successResult(result: ManagedAssetsResult, status: 'applied', pointer: ManagedAssetsPointerState): ManagedAssetsLifecycleResult { return isSuccess(result) ? { status: result.status === 'unchanged' ? 'unchanged' : status, root: pointer.root, generation: pointer.generation } : failure(result); }

function finishLifecycleSpan(span: LocalDebugActionSpan, result: ManagedAssetsLifecycleResult): void {
	if (result.status === 'applied' || result.status === 'removed' || result.status === 'relocated') {
		span.success(result.status);
	} else if (result.status === 'unchanged' || result.status === 'busy') {
		span.skip('skipped', result.status);
	} else if (result.status === 'unavailable') {
		// The real code (`cause`, else the error's own code) reaches the record, not only the fixed «unavailable».
		span.failure(new Error('managed_assets_unavailable'), result.cause === undefined ? 'storage_failure' : 'missing', result.status, { message: result.message, ...result.details });
	} else {
		span.failure(new Error('managed_assets_conflict'), 'validation_failed', result.status, { message: 'message' in result ? result.message : undefined, ...('details' in result ? result.details : {}) });
	}
}

function inheritedIds(parent: ResolvedLocalDebugActionContext | undefined):
	{ parent: Pick<ResolvedLocalDebugActionContext, 'actionId' | 'correlationId'> } | Record<string, never> {
	return parent === undefined ? {} : { parent: { actionId: parent.actionId, correlationId: parent.correlationId } };
}
