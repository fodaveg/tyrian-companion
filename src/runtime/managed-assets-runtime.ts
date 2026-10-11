/**
 * The managed assets (DE-01, step 3g): the Bases and templates the plugin ships and keeps in the
 * vault, as Settings and the Companion card drive them.
 * - The Settings row's actions: preview, apply, repair, the explicit «Replace» of the Bases the plugin
 *   cannot prove it wrote (and the list it confirms), move to the output folder and remove, and the
 *   view the row paints (`getManagedAssetsView`).
 * - The journaled and lifecycle runs behind them (`runManagedAssetOperation`,
 *   `runManagedAssetsLifecycle`, `ensureManagedAssetsAuthority`) and the follow of a changed output
 *   folder (`reconcileManagedAssetsRoot`).
 * - The automatic follow of a newer plugin: after the one-click inventory sync and on load
 *   (`updateManagedAssetsAfterInventorySync`, `updateManagedAssetsOnLoad`).
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core still
 * builds the manager, the lifecycle and the pointer store in `initializeRuntime`, owns the row's
 * `managedAssetsView` (its boot clears a stale «still starting»), the settings tab and `updateSettings`.
 * It hands all of that through `ManagedAssetsRuntimePort`; the getters below carry the names of the
 * core's own fields, so the moved code reads as it did there.
 *
 * Its name does not hold `session-runtime`, and it is not a persisted-session boundary: it keeps no
 * store of its own. What it writes goes through the manager and the lifecycle the core built, and the
 * settings through the core's `updateSettings`.
 */
import type { ManagedAssetsFailureCause, ManagedAssetsManager, ManagedAssetsResult } from '../assets/managed-assets';
import type { ManagedAssetsLifecycle, ManagedAssetsLifecycleResult } from '../assets/managed-assets-lifecycle';
import {
	decideManagedAssetsAutoUpdate,
	planManagedAssets,
	type ManagedAssetsAutoUpdateDecision,
	type ManagedAssetsInspection,
} from '../assets/managed-assets-model';
import type { ManagedAssetsMessageCode, ManagedAssetsView, ManagedAssetsWriteOptions } from '../assets/managed-assets-ui';
import { createTranslator, type Translator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LocalDebugActionRunner, ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import { unmappedErrorLogDetails } from '../core/local-debug-error-details';
import type { CollectorMode, TyrianSettings } from '../core/settings';
import { vaultFailureCause } from '../core/vault-failure-cause';
import type { TyrianHost } from '../host/tyrian-host';
import { consulting, refusedInConsult } from './core-actions';

/** The notice sources the managed assets raise (a closed subset of the core's diagnostic sources). */
export type ManagedAssetsNoticeSource = 'managed_assets_blocked' | 'managed_assets_updated' | 'managed_assets_relocated';

/**
 * Everything `ManagedAssetsRuntime` reads from the core and asks of it. Each member carries the name
 * of the core's own field or method, read live: the manager and the lifecycle are built in
 * `initializeRuntime`, and a setting changed is seen as it stands at the moment of the read.
 */
export interface ManagedAssetsRuntimePort {
	readonly settings: Pick<TyrianSettings,
		'language' | 'outputFolder' | 'managedAssetsRoot' | 'legacyManagedAssetsRoot' | 'legacyOutputFolder'>;
	readonly runtimeReady: boolean;
	readonly unloaded: boolean;
	readonly collectorMode: CollectorMode | undefined;
	readonly host: TyrianHost | undefined;
	readonly localDebugActions: Pick<LocalDebugActionRunner, 'run'> | null;
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so. */
	readonly managedAssets: Pick<ManagedAssetsManager,
		'inspect' | 'preview' | 'apply' | 'replaceUnowned' | 'listUnowned' | 'retirementReport'>;
	readonly managedAssetsLifecycle: Pick<ManagedAssetsLifecycle, 'install' | 'move' | 'remove'>;
	/** The row's view: the core owns it, its boot clears a stale «still starting». */
	managedAssetsView: ManagedAssetsView;
	readonly settingTab: { refreshManagedAssetsRow(): void };
	/** Built in `onload`; read only once `runtimeReady` says so. */
	readonly inventoryVaultSyncRun: { current(): { status: string; lastRun?: { status: string } | null } };
	notifyRuntimeStarting(): void;
	notifyConsultMode(): void;
	emitNotice(message: string, source: ManagedAssetsNoticeSource): void;
	updateSettings(settings: Partial<TyrianSettings>): Promise<unknown>;
}

export class ManagedAssetsRuntime {
	/** True once a held automatic update has warned in this plugin load; it warns once. */
	private managedAssetsAutoUpdateWarned = false;

	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: ManagedAssetsRuntimePort) {}

	// The core's own fields and methods, read through the port under the names the moved code uses.
	private get settings(): ManagedAssetsRuntimePort['settings'] { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get unloaded(): boolean { return this.port.unloaded; }
	/** Public, like the core's: `consulting` and `refusedInConsult` read it from `this`. */
	get collectorMode(): CollectorMode | undefined { return this.port.collectorMode; }
	private get host(): TyrianHost | undefined { return this.port.host; }
	private get localDebugActions(): ManagedAssetsRuntimePort['localDebugActions'] { return this.port.localDebugActions; }
	private get managedAssets(): ManagedAssetsRuntimePort['managedAssets'] { return this.port.managedAssets; }
	private get managedAssetsLifecycle(): ManagedAssetsRuntimePort['managedAssetsLifecycle'] { return this.port.managedAssetsLifecycle; }
	private get managedAssetsView(): ManagedAssetsView { return this.port.managedAssetsView; }
	private set managedAssetsView(value: ManagedAssetsView) { this.port.managedAssetsView = value; }
	private get settingTab(): ManagedAssetsRuntimePort['settingTab'] { return this.port.settingTab; }
	private get inventoryVaultSyncRun(): ManagedAssetsRuntimePort['inventoryVaultSyncRun'] { return this.port.inventoryVaultSyncRun; }
	private notifyRuntimeStarting(): void { this.port.notifyRuntimeStarting(); }
	/** Public, like the core's: `refusedInConsult` calls it on `this`. */
	notifyConsultMode(): void { this.port.notifyConsultMode(); }
	private emitNotice(message: string, source: ManagedAssetsNoticeSource): void { this.port.emitNotice(message, source); }
	private updateSettings(settings: Partial<TyrianSettings>): Promise<unknown> { return this.port.updateSettings(settings); }

	/**
	 * H18.18: the Bases follow a newer plugin on their own, but only behind the explicit inventory
	 * sync that just rewrote the notes they read (never on load: PRODUCT.md principle 2 and 4).
	 * Only an installed root that already is the output folder is touched, and only when the
	 * manual preview's own conflict rule finds nothing the user edited
	 * (`decideManagedAssetsAutoUpdate`); the write is the Settings "Aplicar" path, unchanged. A held
	 * update keeps today's manual preview, ready in Settings, and warns once per plugin load.
	 */
	async updateManagedAssetsAfterInventorySync(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		// A manual inventory sync also runs in consult, but the Bases stay the collector's to write.
		if (consulting(this)) return;
		const state = this.inventoryVaultSyncRun.current();
		if (!this.runtimeReady || state.status !== 'idle' || state.lastRun?.status !== 'success') return;
		const root = this.settings.managedAssetsRoot;
		if (root === null || root !== this.settings.outputFolder
			|| this.settings.legacyManagedAssetsRoot !== null || this.settings.legacyOutputFolder !== null) return;
		const perform = async () => {
			let decision: ManagedAssetsAutoUpdateDecision;
			let inspection: ManagedAssetsInspection;
			try {
				inspection = await this.managedAssets.inspect(root);
				decision = decideManagedAssetsAutoUpdate(inspection);
			} catch (error) {
				return { phase: 'failure' as const, code: 'unknown_failure' as const, details: unmappedErrorLogDetails(error) };
			}
			const translator = createTranslator(this.settings.language);
			if (decision.action === 'manual') {
				this.managedAssetsView = { status: 'ready', message: 'preview_blocked', plan: planManagedAssets(inspection, 'upgrade') };
				this.settingTab.refreshManagedAssetsRow();
				if (!this.managedAssetsAutoUpdateWarned) {
					this.managedAssetsAutoUpdateWarned = true;
					this.emitNotice(translateRuntime(translator, 'notices.managedAssetsAutoUpdateBlocked'), 'managed_assets_blocked');
				}
				return undefined;
			}
			if (decision.action === 'none') return undefined;
			const applied = await this.applyManagedAssetsIfStillDue(false);
			if (applied === null && this.managedAssetsView.status === 'ready') return undefined;
			if (this.managedAssetsView.status !== 'ready') {
				this.emitNotice(translateRuntime(translator, 'notices.managedAssetsAutoUpdateBlocked'), 'managed_assets_updated');
			} else if (applied !== null && !this.announceManagedAssetsFollowed(applied)) {
				this.emitNotice(translateRuntime(translator, 'notices.managedAssetsAutoUpdated'), 'managed_assets_updated');
			}
			return undefined;
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_apply', state: 'after_inventory_sync' }, perform)
			?? perform());
	}

	/**
	 * David, 9 Oct 2026 (his choices «Sí, que las cree solo», «Actualizarla también» and «Borrarlos si no los editaste»): on
	 * load the managed Bases follow the plugin exactly as they do after an inventory sync, with ONE rule
	 * (`decideManagedAssetsAutoUpdate`): create the new ones, update those the user did not edit, and
	 * retire those the bundle no longer ships (an unedited file is removed as the host's deleted-files setting says, an edited one stays
	 * and stops being managed). A Base the user edited, a deleted one, a conflict or a newer manifest
	 * holds everything back: nothing is written and, unlike the sync, nobody is warned (an edit made on
	 * purpose would nag at every start). It additionally needs a `ready` manifest (an installation that
	 * never applied assets gets nothing), the same root as the sync path (installed, equal to the output
	 * folder, no legacy) and a collector. The «last sync succeeded» condition is the sync's and does not
	 * apply. It runs after `runtimeReady`, off the boot path, through the Settings «Aplicar» path.
	 */
	async updateManagedAssetsOnLoad(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host) || this.unloaded || !this.runtimeReady || consulting(this)) return;
		const root = this.settings.managedAssetsRoot;
		if (root === null || root !== this.settings.outputFolder
			|| this.settings.legacyManagedAssetsRoot !== null || this.settings.legacyOutputFolder !== null) return;
		const perform = async () => {
			// An unreadable manifest throws: `run` records the failure and the boot's fire-and-forget swallows it.
			const inspection = await this.managedAssets.inspect(root);
			if (this.unloaded || inspection.manifestStatus !== 'ready' || decideManagedAssetsAutoUpdate(inspection).action !== 'apply') return undefined;
			const applied = await this.applyManagedAssetsIfStillDue(true);
			if (applied !== null && !this.unloaded && this.managedAssetsView.status === 'ready') this.announceManagedAssetsFollowed(applied);
			return undefined;
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_apply', state: 'on_load' }, perform) ?? perform());
	}

	/**
	 * Applies the managed assets only if the decision still holds on the inspection the apply itself acts on
	 * (same flight, no gap for a sync or an edit in between), and not after the plugin unloaded. Returns that
	 * inspection, or `null` when nothing was applied. `requireReady`: the load never acts without a `ready`
	 * manifest; the sync may also recover a lost one, as `decideManagedAssetsAutoUpdate` allows.
	 */
	async applyManagedAssetsIfStillDue(requireReady: boolean): Promise<ManagedAssetsInspection | null> {
		const seen: { inspection: ManagedAssetsInspection | null } = { inspection: null };
		await this.applyManagedAssets((inspection) => {
			if (this.unloaded || (requireReady && inspection.manifestStatus !== 'ready')) return false;
			if (decideManagedAssetsAutoUpdate(inspection).action !== 'apply') return false;
			seen.inspection = inspection;
			return true;
		// An automatic apply never creates a missing output folder: only the press of «Aplicar» does.
		}, { createOutputFolder: false });
		return seen.inspection;
	}

	/**
	 * Says what the apply did, naming files: created, updated, removed (retired and not edited) and kept
	 * without being managed (retired and edited). Returns false when there was nothing to name.
	 */
	announceManagedAssetsFollowed(applied: ManagedAssetsInspection): boolean {
		const translator: Translator = createTranslator(this.settings.language);
		const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
		const named = (status: string): string[] => applied.assets.filter((entry) => entry.status === status).map((entry) => entry.asset.relativePath);
		const report = this.managedAssets.retirementReport();
		let said = false;
		const say = (key: 'notices.managedAssetsAutoCreated' | 'notices.managedAssetsAutoLoadUpdated' | 'notices.managedAssetsAutoRetired' | 'notices.managedAssetsAutoReleased', names: string[]): void => {
			if (names.length === 0) return;
			said = true;
			this.emitNotice(translateRuntime(translator, key, { names: names.join(', ') }), 'managed_assets_updated');
		};
		say('notices.managedAssetsAutoCreated', named('create'));
		say('notices.managedAssetsAutoLoadUpdated', named('update'));
		say('notices.managedAssetsAutoRetired', report.trashed.map(base));
		say('notices.managedAssetsAutoReleased', report.kept.map(base));
		return said;
	}

	/** The Companion card's escape hatch for a blocked `operation_conflict`: the same journaled Move. */
	async retryManagedAssetsReconciliation(): Promise<void> {
		await this.reconcileManagedAssetsRoot();
	}

	getManagedAssetsView() { return structuredClone(this.managedAssetsView); }

	/**
	 * False when the host declared `capabilities.managedAssets: false` (a host with no Bases; Hebra declares
	 * `true`): Settings shows no assets row and nothing here installs, moves, repairs, replaces or removes them.
	 * An omitted capability means true, so Obsidian is unchanged.
	 */
	managedAssetsSupported(): boolean {
		return hostSupportsManagedAssets(this.host);
	}

	/** False when the host cannot move assets between roots (Hebra): no Move button, no automatic follow. */
	managedAssetsCanMove(): boolean {
		return canMoveManagedAssets(this.host, this.settings.legacyManagedAssetsRoot ?? this.settings.managedAssetsRoot, this.settings.outputFolder);
	}

	hasManagedAssetsRoot(): boolean {
		return this.settings.managedAssetsRoot !== null || this.settings.legacyManagedAssetsRoot !== null;
	}

	// Every press of the Assets row that does nothing (still starting, only consulting) says so in the row, with a
	// message that tells what to do, besides the notice. Written inline: the tests drive these methods over a plain port.
	async previewManagedAssets(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.managedAssetsView = { status: 'error', message: 'runtime_starting', plan: null }; this.settingTab.refreshManagedAssetsRow(); this.notifyRuntimeStarting(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_root_retained', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		const root = this.settings.managedAssetsRoot ?? this.settings.outputFolder;
		this.managedAssetsView = { status: 'working', message: 'inspecting', plan: null };
		this.settingTab.refreshManagedAssetsRow();
		// H15.19 (2026-09-10 incident): the catch below fixed the view but never registered
		// anything, so a failed inspection (a corrupt manifest, a Vault read that threw) looked
		// identical in the local debug log to a preview that never ran at all.
		const perform = async () => {
			try {
				const kind = this.settings.managedAssetsRoot ? 'upgrade' : 'install';
				const plan = await this.managedAssets.preview(root, kind);
				// Files of the user's at a managed path are not touched by Apply: the preview says so and points to Replace.
				const message = !plan.canApply ? 'preview_blocked'
					: plan.steps.some((step) => step.status === 'occupied_unowned')
						// Replace needs a managed root: a fresh install, with none, can only be told to move or rename the files.
						? (this.settings.managedAssetsRoot !== null || this.settings.legacyManagedAssetsRoot !== null ? 'preview_unowned' : 'preview_unowned_no_root')
						: 'preview_ready';
				this.managedAssetsView = { status: 'ready', message, plan };
				return undefined;
			} catch (error) {
				const cause = vaultFailureCause(error);
				this.managedAssetsView = { status: 'error', message: cause === undefined ? 'inspect_failed' : managedAssetsFailureCode('unavailable', cause), plan: null };
				return { phase: 'failure' as const, code: cause === undefined ? 'unknown_failure' as const : 'missing' as const, details: { ...unmappedErrorLogDetails(error), ...(cause === undefined ? {} : { code: cause }) } };
			}
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_preview' }, perform) ?? perform());
		this.settingTab.refreshManagedAssetsRow();
	}

	/**
	 * `guard` is the caller's last word on the inspection the apply acts on (see `ManagedAssetsManager.apply`).
	 * `options.createOutputFolder`: only the Settings press passes it (`createMissingOutputFolder`).
	 */
	async applyManagedAssets(guard?: (inspection: ManagedAssetsInspection) => boolean, options: ManagedAssetsWriteOptions = {}): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.managedAssetsView = { status: 'error', message: 'runtime_starting', plan: null }; this.settingTab.refreshManagedAssetsRow(); this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) { this.managedAssetsView = { status: 'error', message: 'consult_mode', plan: null }; this.settingTab.refreshManagedAssetsRow(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		const outputFolder = this.settings.outputFolder;
		const result = await this.runManagedAssetsLifecycle(async () => (
			await createMissingOutputFolder(this.host, outputFolder, outputFolder, options)
			?? await this.managedAssetsLifecycle.install(outputFolder, undefined, guard)
		));
		if ('root' in result) await this.updateSettings({ managedAssetsRoot: result.root });
	}

	async repairManagedAssets(options: ManagedAssetsWriteOptions = {}): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.managedAssetsView = { status: 'error', message: 'runtime_starting', plan: null }; this.settingTab.refreshManagedAssetsRow(); this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) { this.managedAssetsView = { status: 'error', message: 'consult_mode', plan: null }; this.settingTab.refreshManagedAssetsRow(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		if (!this.settings.managedAssetsRoot) return;
		const root = this.settings.managedAssetsRoot;
		const outputFolder = this.settings.outputFolder;
		await this.runManagedAssetOperation(async () => (
			await createMissingOutputFolder(this.host, root, outputFolder, options) ?? await this.managedAssets.apply(root, 'repair')
		));
	}

	/**
	 * The explicit «Replace» of Settings (the user confirmed it): overwrites the Bases the plugin cannot prove
	 * it wrote (edited by hand, or from a build nothing published) with the ones it ships. No automatic path
	 * reaches it: the preview keeps listing those files as «Yours, left untouched» until this runs.
	 */
	async replaceUnownedManagedAssets(confirmed: readonly string[], options: ManagedAssetsWriteOptions = {}): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.managedAssetsView = { status: 'error', message: 'runtime_starting', plan: null }; this.settingTab.refreshManagedAssetsRow(); this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) { this.managedAssetsView = { status: 'error', message: 'consult_mode', plan: null }; this.settingTab.refreshManagedAssetsRow(); return; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return;
		}
		if (!this.settings.managedAssetsRoot) return;
		const root = this.settings.managedAssetsRoot;
		const outputFolder = this.settings.outputFolder;
		await this.runManagedAssetOperation(async () => (
			await createMissingOutputFolder(this.host, root, outputFolder, options) ?? await this.managedAssets.replaceUnowned(root, confirmed)
		));
	}

	/**
	 * What «Replace» would overwrite right now (a fresh read, not the last preview): shown in its confirmation,
	 * and the exact set `replaceUnownedManagedAssets` is then limited to. Empty when nothing can be listed; an unreadable manifest throws, as the Settings preview's own inspection would.
	 */
	async listUnownedManagedAssets(): Promise<Array<{ id: string; path: string }>> {
		if (!hostSupportsManagedAssets(this.host)) return [];
		if (!this.runtimeReady) { this.managedAssetsView = { status: 'error', message: 'runtime_starting', plan: null }; this.settingTab.refreshManagedAssetsRow(); this.notifyRuntimeStarting(); return []; }
		if (refusedInConsult(this)) { this.managedAssetsView = { status: 'error', message: 'consult_mode', plan: null }; this.settingTab.refreshManagedAssetsRow(); return []; }
		if (this.settings.legacyManagedAssetsRoot !== null) {
			this.managedAssetsView = { status: 'error', message: 'legacy_explicit_only', plan: null };
			this.settingTab.refreshManagedAssetsRow();
			return [];
		}
		// No root and no legacy one: nothing to list, silent as Repair is in that same case.
		const root = this.settings.managedAssetsRoot;
		if (!root) return [];
		let found: Array<{ id: string; path: string }> = [];
		const perform = async () => {
			try {
				found = await this.managedAssets.listUnowned(root);
				this.managedAssetsView = found.length === 0
					? { status: 'ready', message: 'no_unowned', plan: null }
					: this.managedAssetsView;
				return undefined;
			} catch (error) {
				found = [];
				this.managedAssetsView = { status: 'error', message: 'inspect_failed', plan: null };
				return { phase: 'failure' as const, code: 'unknown_failure' as const, details: unmappedErrorLogDetails(error) };
			}
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_replace_list' }, perform) ?? perform());
		this.settingTab.refreshManagedAssetsRow();
		return found;
	}

	/** Returns `null` only when the move was never attempted (runtime not ready, or the durable
	 * pointer could not be confirmed to match the retained root first). */
	async relocateManagedAssets(parent?: ResolvedLocalDebugActionContext): Promise<ManagedAssetsLifecycleResult | null> {
		if (!hostSupportsManagedAssets(this.host) || !canMoveManagedAssets(this.host, this.settings.legacyManagedAssetsRoot ?? this.settings.managedAssetsRoot, this.settings.outputFolder)) return null;
		if (!this.runtimeReady) { this.managedAssetsView = { status: 'error', message: 'runtime_starting', plan: null }; this.settingTab.refreshManagedAssetsRow(); this.notifyRuntimeStarting(); return null; }
		if (refusedInConsult(this)) { this.managedAssetsView = { status: 'error', message: 'consult_mode', plan: null }; this.settingTab.refreshManagedAssetsRow(); return null; }
		const destination = this.settings.outputFolder;
		const legacyRoot = this.settings.legacyManagedAssetsRoot;
		if (!await this.ensureManagedAssetsAuthority(parent)) return null;
		const result = await this.runManagedAssetsLifecycle(
			() => this.managedAssetsLifecycle.move(destination, legacyRoot ?? undefined, parent),
		);
		if ('root' in result && (legacyRoot === null || result.status === 'relocated' && result.root === destination)) {
			await this.updateSettings({ managedAssetsRoot: result.root });
		}
		return result;
	}

	async removeManagedAssets(): Promise<void> {
		if (!hostSupportsManagedAssets(this.host)) return;
		if (!this.runtimeReady) { this.managedAssetsView = { status: 'error', message: 'runtime_starting', plan: null }; this.settingTab.refreshManagedAssetsRow(); this.notifyRuntimeStarting(); return; }
		if (refusedInConsult(this)) { this.managedAssetsView = { status: 'error', message: 'consult_mode', plan: null }; this.settingTab.refreshManagedAssetsRow(); return; }
		const legacyRoot = this.settings.legacyManagedAssetsRoot;
		if (!await this.ensureManagedAssetsAuthority()) return;
		const result = await this.runManagedAssetsLifecycle(() => this.managedAssetsLifecycle.remove(legacyRoot ?? undefined));
		if ('root' in result && (legacyRoot === null || result.status === 'removed' && result.root === null)) {
			await this.updateSettings({ managedAssetsRoot: result.root });
		}
	}

	/**
	 * The output-folder selector is the single source of truth for managed assets: Bases and
	 * templates must never sit somewhere the user never chose. This heals both an explicit
	 * folder change and a divergence discovered at startup (an install whose Bases root never
	 * followed a later folder change, e.g. an upgrade from before H5.8) through the exact same
	 * journaled Move lifecycle as the manual "Move" action, not a bespoke copy of it. Move only
	 * deletes origin bytes after the destination install already succeeded and refuses to run
	 * over a modified/unowned/conflicting root, so a blocked reconciliation always leaves both
	 * roots exactly as they were: nothing is ever moved halfway or silently overwritten. A
	 * completed or blocked attempt still surfaces through a Notice, because relocating files in
	 * the user's Vault without them ever seeing it is worse than telling them after the fact;
	 * the Settings row and its manual Move button remain the escape hatch when this is blocked.
	 *
	 * A retained legacy root is deliberately excluded: `managed-assets.test.ts` documents that
	 * adopting one only ever happens through an explicit lifecycle Move, and this must not turn
	 * that into something that fires on its own the next time Obsidian starts.
	 */
	async reconcileManagedAssetsRoot(parent?: ResolvedLocalDebugActionContext): Promise<void> {
		if (!hostSupportsManagedAssets(this.host) || !canMoveManagedAssets(this.host, this.settings.legacyManagedAssetsRoot ?? this.settings.managedAssetsRoot, this.settings.outputFolder)) return;
		// R1b: moving the Bases is a collector write; a consult installation leaves them where they are.
		if (consulting(this) || this.settings.legacyManagedAssetsRoot !== null) return;
		if (this.settings.managedAssetsRoot === null || this.settings.managedAssetsRoot === this.settings.outputFolder) return;
		const result = await this.relocateManagedAssets(parent);
		const translator = createTranslator(this.settings.language);
		if (result === null) {
			this.emitNotice(
				translateRuntime(translator, 'notices.managedAssetsAutoRelocationBlocked'),
				'managed_assets_blocked',
			);
			return;
		}
		if (result.status === 'relocated') {
			this.emitNotice(
				translateRuntime(translator, 'notices.managedAssetsAutoRelocated', { root: this.settings.outputFolder }),
				'managed_assets_relocated',
			);
		} else if (result.status !== 'unchanged') {
			this.emitNotice(
				translateRuntime(translator, 'notices.managedAssetsAutoRelocationBlocked'),
				'managed_assets_blocked',
			);
		}
	}

	async ensureManagedAssetsAuthority(parent?: ResolvedLocalDebugActionContext): Promise<boolean> {
		if (this.settings.legacyManagedAssetsRoot !== null) return true;
		const mirroredRoot = this.settings.managedAssetsRoot;
		if (!mirroredRoot) return true;
		const adopted = await this.runManagedAssetsLifecycle(
			() => this.managedAssetsLifecycle.install(mirroredRoot, parent),
		);
		return 'root' in adopted && adopted.root === mirroredRoot;
	}

	async runManagedAssetsLifecycle(operation: () => Promise<ManagedAssetsLifecycleResult>): Promise<ManagedAssetsLifecycleResult> {
		this.managedAssetsView = { status: 'working', message: 'applying_lifecycle', plan: null };
		this.settingTab.refreshManagedAssetsRow();
		let result: ManagedAssetsLifecycleResult;
		try { result = await operation(); }
		catch { result = { status: 'unavailable', message: 'The durable managed-assets authority is unavailable.' }; }
		this.managedAssetsView = 'root' in result
			? { status: 'ready', message: 'lifecycle_ready', plan: null }
			: { status: 'error', message: managedAssetsFailureCode(result.status, result.cause), plan: null };
		this.settingTab.refreshManagedAssetsRow();
		return result;
	}

	async runManagedAssetOperation(operation: () => Promise<ManagedAssetsResult>): Promise<ManagedAssetsResult> {
		this.managedAssetsView = { status: 'working', message: 'applying_journal', plan: null };
		this.settingTab.refreshManagedAssetsRow();
		let result!: ManagedAssetsResult;
		// Repair and Replace used to leave nothing in the local log when they failed: the record carries the real code now.
		const perform = async () => {
			result = await operation();
			if (!('message' in result)) return undefined;
			return {
				phase: 'failure' as const,
				code: result.cause === undefined || result.cause === 'only_unowned_files' ? 'validation_failed' as const : 'missing' as const,
				details: { status: result.status, message: result.message, ...result.details },
			};
		};
		await (this.localDebugActions?.run({ component: 'assets', action: 'managed_assets_apply' }, perform) ?? perform());
		if (result.status === 'applied' || result.status === 'unchanged' || result.status === 'detached') {
			this.managedAssetsView = { status: 'ready', message: result.status === 'detached' ? 'ownership_detached' : 'assets_ready', plan: null };
		} else if ('message' in result) {
			this.managedAssetsView = { status: 'error', message: managedAssetsFailureCode(result.status, result.cause), plan: null };
		}
		this.settingTab.refreshManagedAssetsRow();
		return result;
	}
}

function managedAssetsFailureCode(status: 'busy' | 'conflict' | 'invalid' | 'unavailable', cause?: ManagedAssetsFailureCause): ManagedAssetsMessageCode {
	const byCause: Record<ManagedAssetsFailureCause, ManagedAssetsMessageCode> = {
		bytes_not_synced: 'operation_bytes_not_synced', output_folder_missing: 'operation_output_folder_missing',
		host_refused: 'operation_host_refused', only_unowned_files: 'operation_only_unowned',
		output_folder_create_failed: 'operation_output_folder_create_failed',
	};
	if (cause !== undefined) return byCause[cause];
	const codes: Record<typeof status, ManagedAssetsMessageCode> = {
		busy: 'operation_busy', conflict: 'operation_conflict', invalid: 'operation_invalid', unavailable: 'operation_unavailable',
	};
	return codes[status];
}

/**
 * Whether the managed assets can be moved off the root the settings name. A host that declared
 * `capabilities.managedAssetsMove: false` (Hebra: the vault IS the output folder) can only do it while that root is
 * still READABLE in the vault. There the vault is the output folder, so that is decided by paths alone: the root is
 * the output folder or lies inside it (the manifest may be lost and its Bases intact, which Move adopts). Once the
 * output folder moved away from it (a sibling, or a folder inside it) nothing of the old root can be read and
 * Apply installs afresh instead.
 */
export function canMoveManagedAssets(host: TyrianHost | undefined, root: string | null, outputFolder: string): boolean {
	if (host?.capabilities?.managedAssetsMove !== false) return true;
	return root !== null && (root === outputFolder || root.startsWith(`${outputFolder}/`));
}

/**
 * Whether the host keeps managed assets (Bases): true unless it declared
 * `capabilities.managedAssets: false`. Tolerates an absent host, like `consulting` does for the
 * isolated `this` objects the tests drive.
 */
function hostSupportsManagedAssets(host: TyrianHost | undefined): boolean {
	return host?.capabilities?.managedAssets !== false;
}

/**
 * `options.createOutputFolder` (only the Settings press passes it): creates the output folder when the root is it or
 * lies inside it and the host can. Never without that flag (a start, an automatic apply, Remove, Move), nor for a root
 * outside the output folder. Returns the failure the row shows when creating it failed (the host already reported
 * why), null otherwise. Tolerates an absent host, like `consulting`.
 */
async function createMissingOutputFolder(
	host: TyrianHost | undefined,
	root: string,
	outputFolder: string,
	options: ManagedAssetsWriteOptions,
): Promise<{ status: 'unavailable'; message: string; cause: 'output_folder_create_failed' } | null> {
	if (options.createOutputFolder !== true || (root !== outputFolder && !root.startsWith(`${outputFolder}/`))) return null;
	const vault = host?.vault;
	if (vault?.createOutputFolder === undefined) return null;
	if (await vault.createOutputFolder()) return null;
	return { status: 'unavailable', message: 'The output folder is not in the library and could not be created.', cause: 'output_folder_create_failed' };
}
