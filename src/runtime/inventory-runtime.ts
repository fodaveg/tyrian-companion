/**
 * The inventory side of the core (DE-01, step 3g): the advisor's refresh and its view model, the
 * editor of the preferences (goals and keep exceptions), the one-click and manual syncs of the
 * inventory notes, the wallet sync, and the receipts and copies the advisor leaves in the host.
 * - The advisor: `refreshInventoryAdvisor`, the refresh a sync runs with its phases
 *   (`refreshInventoryAdvisorForSync`), the analysis the notes are written from
 *   (`inventoryAnalysisForNotes`), the view model with its rules expiry and its invalidation.
 * - The preferences: the editor state and sessions, `loadInventoryPreferences`, the four goal and
 *   keep-exception writes, and the copy of the preferences in the host's settings
 *   (`writeInventoryPreferencesBackup`).
 * - The syncs: the one-click flow (run, confirm, cancel, its last outcome), the manual preview and
 *   apply, and the wallet preview and apply with the notice each ends in.
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * building the controllers and services these drive (`inventoryAdvisor`, `inventoryPreferences`,
 * `inventoryVaultSync`, `inventoryVaultSyncRun`, `walletVaultSync`), the settings write chain, the
 * managed assets that follow a sync and the notices, and hands all of that through
 * `InventoryRuntimePort`; the getters below carry the names of the core's own fields, so the moved
 * code reads as it did there.
 *
 * Its name does not hold `session-runtime`, and it is not a store: the receipt and the copy of the
 * preferences go through the host's vault and settings ports, which the core handed over.
 */
import type { InventoryAdvisorCaptureReceiptV1 } from '../advisor/inventory-advisor-evidence-model';
import { inventoryAdvisorBuiltinBundleProvider } from '../advisor/inventory-advisor-builtin-bundle';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { InventoryAdvisorContextualPresentationSource } from '../advisor/inventory-advisor-presentation';
import type { InventoryObjectResultsV1 } from '../advisor/inventory-object-result';
import {
	inventoryPreferencesBackupWritableOver,
	mergeInventoryPreferencesBackup,
	sameInventoryPreferencesBackup,
	type InventoryPreferencesBackupV1,
	type InventoryPreferencesBackupWriteOutcome,
} from '../advisor/inventory-preferences-backup';
import type {
	InventoryPreferencesEditorSession,
	InventoryPreferencesEditorState,
	InventoryPreferencesRuntime,
} from '../advisor/inventory-preferences-runtime';
import { snapshotCoverageLogCounts } from '../account/snapshot-coverage-log';
import { createTranslator } from '../core/i18n';
import { translateRuntime } from '../core/i18n-runtime-catalog';
import type { LocalDebugActionOutcome, LocalDebugActionRunner, ResolvedLocalDebugActionContext } from '../core/local-debug-action-runner';
import type { InventoryVaultSyncLastRun, TyrianSettings } from '../core/settings';
import type { ReservationGoal } from '../economy/reservation-model';
import type { TyrianHost } from '../host/tyrian-host';
import { inventoryAnalysisMissingCause, inventoryAnalysisNotReadyCause } from '../inventory/inventory-analysis';
import type { InventoryAdvisorPresentationController } from '../ui/inventory-advisor-controller';
import {
	applyLiveInventoryAdvisorRulesExpiry,
	buildInventoryAdvisorViewModel,
	type InventoryAdvisorViewModel,
} from '../ui/inventory-advisor-view-model';
import type { InventoryVaultSyncController } from '../ui/inventory-vault-sync-controller';
import type {
	InventoryVaultOneClickSyncController,
	InventoryVaultSyncCaptureProgress,
	InventoryVaultSyncRunState,
} from '../ui/inventory-vault-sync-run-controller';
import type { WalletVaultSyncController, WalletVaultSyncViewState } from '../ui/wallet-vault-sync-controller';
import { inventoryOneClickSyncOutcome, vaultSyncFailureOutcome } from './core-outcomes';
import { liveRulesExpiredAtMsFromLoad } from './core-sale-rules';
import type { InventoryAdvisorCaptureProgressListenerRef, InventoryAdvisorPhaseListenerRef } from './assemble-advisor';
import type { SaleRuntime } from './sale-runtime';

/**
 * Everything `InventoryRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field or method, read live: the controllers are built in `initializeRuntime`
 * (after this runtime), and the settings, the unload flag and the sync-analysis flag change.
 */
export interface InventoryRuntimePort {
	/** The settings in force; the sync's last outcome and the preferences copy are published into it. */
	settings: TyrianSettings;
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** True from the moment the plugin starts to unload. */
	readonly unloaded: boolean;
	/** Where the capture receipt is written and where the preferences copy is saved. */
	readonly host: Pick<TyrianHost, 'vault' | 'environment' | 'settings'>;
	readonly localDebugActions: LocalDebugActionRunner | null;
	readonly inventoryAdvisor: InventoryAdvisorPresentationController;
	readonly inventoryPreferences: InventoryPreferencesRuntime;
	readonly inventoryVaultSync: InventoryVaultSyncController;
	readonly inventoryVaultSyncRun: InventoryVaultOneClickSyncController;
	readonly walletVaultSync: WalletVaultSyncController;
	/** Where the advisor reports its phases and its capture counters; the sync's refresh fills them. */
	readonly inventoryAdvisorPhaseListener: InventoryAdvisorPhaseListenerRef;
	readonly inventoryAdvisorCaptureProgressListener: InventoryAdvisorCaptureProgressListenerRef;
	/** True while an analysis runs for a sync: the objects analysis then refreshes the price seeds. */
	inventoryAnalysisForSync: boolean;
	/** The Sale tab rides the advisor refresh, and an inventory sync is the action its seed passes wait for. */
	readonly sale: Pick<SaleRuntime, 'refreshSaleHeroTiming' | 'runPriceSeedSyncAction'>;
	notifyRuntimeStarting(): void;
	emitNotice(message: string, source: 'inventory_advisor_missing_key' | 'wallet_sync'): void;
	renderInventoryAdvisorViews(): void;
	activateInventoryAdvisorView(): Promise<void>;
	/** The Bases follow a newer plugin behind an explicit inventory sync. */
	updateManagedAssetsAfterInventorySync(): Promise<void>;
	/** Runs `section` after every earlier settings write (the core's chain). */
	serializeSettingsWrite<T>(section: () => Promise<T>): Promise<T>;
	/** What a save merges over; `null` means write nothing (the core's read). */
	loadSettingsBase(): Promise<TyrianSettings | null>;
}

export class InventoryRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: InventoryRuntimePort) {}

	// The core's own fields, read through the port under the names the moved code uses.
	private get settings(): TyrianSettings { return this.port.settings; }
	private set settings(value: TyrianSettings) { this.port.settings = value; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get unloaded(): boolean { return this.port.unloaded; }
	private get host(): InventoryRuntimePort['host'] { return this.port.host; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get inventoryAdvisor(): InventoryAdvisorPresentationController { return this.port.inventoryAdvisor; }
	private get inventoryPreferences(): InventoryPreferencesRuntime { return this.port.inventoryPreferences; }
	private get inventoryVaultSync(): InventoryVaultSyncController { return this.port.inventoryVaultSync; }
	private get inventoryVaultSyncRun(): InventoryVaultOneClickSyncController { return this.port.inventoryVaultSyncRun; }
	private get walletVaultSync(): WalletVaultSyncController { return this.port.walletVaultSync; }
	private get inventoryAdvisorPhaseListener(): InventoryAdvisorPhaseListenerRef { return this.port.inventoryAdvisorPhaseListener; }
	private get inventoryAdvisorCaptureProgressListener(): InventoryAdvisorCaptureProgressListenerRef {
		return this.port.inventoryAdvisorCaptureProgressListener;
	}
	private get inventoryAnalysisForSync(): boolean { return this.port.inventoryAnalysisForSync; }
	private set inventoryAnalysisForSync(value: boolean) { this.port.inventoryAnalysisForSync = value; }
	private get sale(): InventoryRuntimePort['sale'] { return this.port.sale; }
	private notifyRuntimeStarting(): void { this.port.notifyRuntimeStarting(); }
	private emitNotice(message: string, source: 'inventory_advisor_missing_key' | 'wallet_sync'): void { this.port.emitNotice(message, source); }
	private renderInventoryAdvisorViews(): void { this.port.renderInventoryAdvisorViews(); }
	private activateInventoryAdvisorView(): Promise<void> { return this.port.activateInventoryAdvisorView(); }
	private updateManagedAssetsAfterInventorySync(): Promise<void> { return this.port.updateManagedAssetsAfterInventorySync(); }
	private serializeSettingsWrite<T>(section: () => Promise<T>): Promise<T> { return this.port.serializeSettingsWrite(section); }
	private loadSettingsBase(): Promise<TyrianSettings | null> { return this.port.loadSettingsBase(); }

	/**
	 * H18.35: the cached `InventoryAdvisorPresentationController` result only updates on an explicit
	 * refresh, so without this the Asesor tab could keep showing `ready`/`limited` well after the
	 * curated builtin bundle's own `validUntil`, exactly the silent staleness H18.34 already fixed for
	 * the Venta tab's `SaleViewModel.rulesExpiredAtMs`. Checked fresh on every read, never on the
	 * cached model's own `status`.
	 */
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel {
		if (!this.runtimeReady) return buildInventoryAdvisorViewModel(null);
		return applyLiveInventoryAdvisorRulesExpiry(this.inventoryAdvisor.open(), liveRulesExpiredAtMs(Date.now()));
	}

	getInventoryPreferencesEditorState(): InventoryPreferencesEditorState {
		return this.runtimeReady ? this.inventoryPreferences.current() : structuredClone(IDLE_PREFERENCES_STATE);
	}

	/** Gives each ItemView an opaque CAS revision without placing it in its DOM. */
	createInventoryPreferencesEditorSession(): InventoryPreferencesEditorSession {
		if (!this.runtimeReady) return idleInventoryPreferencesEditorSession(() => this.notifyRuntimeStarting());
		const session = this.inventoryPreferences.createEditorSession();
		const after = async (
			state: InventoryPreferencesEditorState, reclassifyReady = true,
		): Promise<InventoryPreferencesEditorState> => {
			let settled = state;
			// Preferences that answer again also lift the block an earlier storage failure left on the
			// advisor: without this the tab kept saying they were unavailable until a restart.
			if (state.status === 'ready' && (reclassifyReady || this.inventoryAdvisor.blockedOnPreferences())) {
				await this.inventoryAdvisor.reclassify();
				// That reclassification reloads the preferences, which expires every editor session, this
				// one included. Only the session that caused it is read again here (a plain read: it never
				// reclassifies); another leaf's session stays expired and must reload before it may write.
				if (session.current().status !== 'ready') settled = await session.load();
			}
			if (settled.status === 'blocked' || settled.status === 'conflict') this.inventoryAdvisor.block();
			this.renderInventoryAdvisorViews();
			return settled;
		};
		return Object.freeze({
			// A load changes nothing by itself: it reclassifies only when the loaded revision is not the one
			// the analysis in force used (another window or device wrote since). Writes always reclassify.
			// Either way the session that asked ends ready on the revision in force (see `after`).
			current: () => session.current(),
			load: async () => await after(await session.load(), this.inventoryPreferences.differsFromAnalysis()),
			upsertGoal: async (goal: ReservationGoal) => await after(await session.upsertGoal(goal)),
			removeGoal: async (goalId: string) => await after(await session.removeGoal(goalId)),
			upsertKeepException: async (keepException: KeepExceptionV1) => await after(await session.upsertKeepException(keepException)),
			removeKeepException: async (exceptionId: string) => await after(await session.removeKeepException(exceptionId)),
		});
	}

	async refreshInventoryAdvisor(): Promise<void> {
		const perform = async (context?: ResolvedLocalDebugActionContext): Promise<LocalDebugActionOutcome | undefined> => {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return undefined; }
		const operation = this.inventoryAdvisor.refresh({}, context);
		this.renderInventoryAdvisorViews();
		const model = await operation; if (model.status === 'blocked' && model.blockedReason === 'credential_unavailable') this.emitNotice(translateRuntime(createTranslator(this.settings.language), 'advisor.view.blockedReason.credential_unavailable'), 'inventory_advisor_missing_key');
		// The Sale tab's hero card rides the same refresh: its verdict needs the freshest owned
		// quantity and today's bid, both of which this analysis just settled.
		await this.sale.refreshSaleHeroTiming();
		this.renderInventoryAdvisorViews();
		return this.snapshotCoverageOutcome();
		};
		// No deferred seed pass starts here: the action that left one starts it itself, when it ends
		// (`startPriceSeedDeferredPass`), so an "Analizar" never starts another action's downloads.
		await (this.localDebugActions?.run(
			{ component: 'inventory', action: 'inventory_refresh' }, perform,
		) ?? perform());
	}

	/**
	 * The success record of a refresh carries how much of the account its capture covered, as counts only
	 * (`snapshotCoverageLogCounts`, flat in `details` with the `inventory` vocabulary). It is read from the
	 * analysis the view now holds and fails open: no analysis, or a read that throws, adds nothing.
	 */
	private snapshotCoverageOutcome(): LocalDebugActionOutcome | undefined {
		try {
			const snapshot = this.inventoryAdvisor.analysis({ readOnly: true })?.source.input.snapshot;
			if (snapshot === undefined) return undefined;
			return { details: { ...snapshotCoverageLogCounts(snapshot.coverage, snapshot.roster) } };
		} catch {
			return undefined;
		}
	}

	/**
	 * Runs the ordinary advisor refresh while reporting its real capture/preferences/
	 * classification phases, plus the real request counters inside the capture phase.
	 * Both listeners are purely in-memory and cleared as soon as the refresh settles.
	 * It is also the one analysis the inventory notes are then written from (H18.16).
	 */
	async refreshInventoryAdvisorForSync(
		onPhase: (phase: 'capture' | 'preferences' | 'classification') => void,
		onCaptureProgress: (progress: InventoryVaultSyncCaptureProgress) => void,
	): Promise<void> {
		this.inventoryAdvisorPhaseListener.current = onPhase;
		this.inventoryAdvisorCaptureProgressListener.current = onCaptureProgress;
		this.inventoryAnalysisForSync = true;
		try { await this.refreshInventoryAdvisor(); }
		finally {
			this.inventoryAnalysisForSync = false;
			this.inventoryAdvisorPhaseListener.current = null;
			this.inventoryAdvisorCaptureProgressListener.current = null;
		}
	}

	/**
	 * H18.16: the analysis the inventory notes are written from, which is always the one the
	 * advisor view is showing. When that analysis cannot rewrite the notes (no analysis yet, a
	 * snapshot that is not stable and complete in every store, or one older than the advisor's
	 * snapshot policy), ONE more analysis runs, and the view shows that one too: a recovery read,
	 * never a second private capture that could contradict what the view says.
	 */
	async inventoryAnalysisForNotes(): Promise<{
		source: InventoryAdvisorContextualPresentationSource;
		objects: InventoryObjectResultsV1;
	}> {
		const check = (): {
			ready: { source: InventoryAdvisorContextualPresentationSource; objects: InventoryObjectResultsV1 } | null;
			cause: string | null;
		} => {
			const analysis = this.inventoryAdvisor.analysis();
			if (analysis === null) return { ready: null, cause: inventoryAnalysisMissingCause(this.inventoryAdvisor.current()) };
			const cause = inventoryAnalysisNotReadyCause(analysis.source, analysis.objects, Date.now());
			return cause === null && analysis.objects !== null
				? { ready: { source: analysis.source, objects: analysis.objects }, cause: null }
				: { ready: null, cause: cause ?? 'objects_null' };
		};
		const current = check();
		if (current.ready !== null) return current.ready;
		this.inventoryAnalysisForSync = true;
		try { await this.refreshInventoryAdvisor(); }
		finally { this.inventoryAnalysisForSync = false; }
		const recovered = check();
		// The code names the condition that failed after the recovery read (safe: a closed list).
		if (recovered.ready === null) throw new Error(recovered.cause ?? 'inventory_capture_incomplete');
		return recovered.ready;
	}

	/** Live/persisted state of the single-button view sync. It never starts work by itself. */
	getInventoryVaultSyncRunState(): InventoryVaultSyncRunState {
		return this.inventoryVaultSyncRun.current();
	}

	/**
	 * The one-click flow: refresh, preview, and (unless it must pause) apply. The stale price seeds
	 * its analyses left are refreshed once all of it has ended (`runPriceSeedSyncAction`).
	 */
	async runInventoryVaultSync(): Promise<void> {
		await this.sale.runPriceSeedSyncAction(async () => {
			const perform = async () => inventoryOneClickSyncOutcome(await this.inventoryVaultSyncRun.run());
			await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
			await this.updateManagedAssetsAfterInventorySync();
		});
	}

	/** Writes a plan that paused for confirmation because it would deactivate rows. */
	async confirmInventoryVaultSync(): Promise<void> {
		const perform = async () => inventoryOneClickSyncOutcome(await this.inventoryVaultSyncRun.confirm());
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
		await this.updateManagedAssetsAfterInventorySync();
	}

	/** Discards a pending destructive plan without writing anything. */
	cancelInventoryVaultSync(): void {
		if (this.localDebugActions) this.localDebugActions.runSync(
			{ component: 'inventory', action: 'inventory_sync' }, () => this.inventoryVaultSyncRun.cancel(),
		);
		else this.inventoryVaultSyncRun.cancel();
	}

	async recordInventorySyncOutcome(outcome: InventoryVaultSyncLastRun): Promise<void> {
		await this.serializeSettingsWrite(async () => {
			const base = await this.loadSettingsBase();
			// DU-04: with settings from a newer release the receipt lives in memory only, for this run.
			if (base !== null) await this.host.settings.save({ ...base, inventorySyncLastRun: outcome });
			// Memory takes only the key this method owns. What another device changed stays unpublished,
			// so the next `updateSettings` still sees it as a difference and reacts to it.
			this.settings = { ...this.settings, inventorySyncLastRun: outcome };
		});
	}

	/**
	 * DU-13: writes the copy of the inventory preferences into the host's settings, over the settings as they are now
	 * (`loadSettingsBase`), in the same write chain as every other save, merged over the stored copy so that no account
	 * of it is dropped (`mergeInventoryPreferencesBackup`). A result equal to the stored copy is not written again. Nothing is written with settings from a newer release (DU-04), over a stored copy of a version this release
	 * does not know (only the newer release can read it), or once the plugin is unloaded, except the `final` write the
	 * copy starts as it is disposed. A failed save rejects, for the copy to record.
	 */
	async writeInventoryPreferencesBackup(backup: InventoryPreferencesBackupV1, final: boolean): Promise<InventoryPreferencesBackupWriteOutcome> {
		if (this.unloaded && !final) return 'unloaded';
		return await this.serializeSettingsWrite(async () => {
			if (this.unloaded && !final) return 'unloaded';
			const base = await this.loadSettingsBase();
			if (base === null) return 'read_only';
			if (!inventoryPreferencesBackupWritableOver(base.inventoryPreferencesBackup)) return 'future_kept';
			// An account the stored copy has and `backup` does not (IndexedDB lacks it or cannot read it) is kept.
			const merged = mergeInventoryPreferencesBackup(base.inventoryPreferencesBackup, backup);
			if (sameInventoryPreferencesBackup(base.inventoryPreferencesBackup, merged)) return 'unchanged';
			await this.host.settings.save({ ...base, inventoryPreferencesBackup: merged });
			// Memory takes only the key this method owns, as `recordInventorySyncOutcome` does.
			this.settings = { ...this.settings, inventoryPreferencesBackup: structuredClone(merged) };
			return 'saved';
		});
	}

	/**
	 * The manual preview. Its recovery read (`inventoryAnalysisForNotes`) can run a sync's analysis
	 * outside `runInventoryVaultSync`: that seed pass requests the missing seeds and leaves the stale
	 * copies for the next sync or Sale refresh (see `refreshPriceSeedsForSync`).
	 */
	async previewInventoryVaultSync(openView = false): Promise<void> {
		const perform = async (): Promise<void> => {
		if (openView) await this.activateInventoryAdvisorView();
		const operation = this.inventoryVaultSync.preview();
		this.renderInventoryAdvisorViews();
		await operation;
		this.renderInventoryAdvisorViews();
		};
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_preview' }, perform) ?? perform());
	}

	async applyInventoryVaultSync(): Promise<void> {
		const perform = async () => {
			const operation = this.inventoryVaultSync.apply();
			this.renderInventoryAdvisorViews();
			await operation;
			this.renderInventoryAdvisorViews();
			return vaultSyncFailureOutcome(this.inventoryVaultSync.current());
		};
		await (this.localDebugActions?.run({ component: 'inventory', action: 'inventory_sync' }, perform) ?? perform());
	}

	getWalletVaultSyncState(): WalletVaultSyncViewState {
		return this.walletVaultSync.current();
	}

	canApplyWalletVaultSync(): boolean {
		return this.walletVaultSync.canApply();
	}

	async previewWalletVaultSync(): Promise<void> {
		const perform = async (): Promise<void> => {
		const state = await this.walletVaultSync.preview();
		this.emitNotice(this.walletVaultSyncNoticeText(state), 'wallet_sync');
		};
		await (this.localDebugActions?.run({ component: 'wallet', action: 'wallet_preview' }, perform) ?? perform());
	}

	async applyWalletVaultSync(): Promise<void> {
		const perform = async () => {
			const state = await this.walletVaultSync.apply();
			this.emitNotice(this.walletVaultSyncNoticeText(state), 'wallet_sync');
			return vaultSyncFailureOutcome(state);
		};
		await (this.localDebugActions?.run({ component: 'wallet', action: 'wallet_sync' }, perform) ?? perform());
	}

	private walletVaultSyncNoticeText(state: WalletVaultSyncViewState): string {
		const translator = createTranslator(this.settings.language);
		switch (state.status) {
			case 'disabled':
				return translateRuntime(translator, state.reason === 'missing_key' ? 'notices.walletVaultMissingKey' : 'notices.walletVaultLegacyRoot');
			case 'preview':
				return translateRuntime(translator, 'notices.walletVaultPreviewReady', {
					create: state.summary.create, update: state.summary.update,
					deactivate: state.summary.deactivate, unchanged: state.summary.unchanged,
				});
			case 'success':
				return state.result.status === 'applied'
					? translateRuntime(translator, 'notices.walletVaultApplied', {
						created: state.result.created, updated: state.result.updated, deactivated: state.result.deactivated,
					})
					: translateRuntime(translator, 'notices.walletVaultUnchanged');
			case 'conflict':
				return translateRuntime(translator, 'notices.walletVaultConflict');
			case 'idle':
			case 'loading':
			case 'applying':
			case 'error':
				return translateRuntime(translator, 'notices.walletVaultError');
		}
	}

	async writeInventoryAdvisorCaptureReceipt(
		receipt: InventoryAdvisorCaptureReceiptV1,
	): Promise<void> {
		const path = `${this.host.vault.configDir}/plugins/${this.host.environment.pluginId}/inventory-advisor-capture-receipt.json`;
		await this.host.vault.adapter.write(path, `${JSON.stringify(receipt, null, '\t')}\n`);
	}

	async loadInventoryPreferences(): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.loadCached();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		// The same as an editor session's load: a block left by a storage failure does not outlive it.
		else if (state.status === 'ready' && this.inventoryAdvisor.blockedOnPreferences()) await this.inventoryAdvisor.reclassify();
		this.renderInventoryAdvisorViews();
	}

	async upsertInventoryGoal(goal: ReservationGoal): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.upsertGoal(goal);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async removeInventoryGoal(goalId: string): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.removeGoal(goalId);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async upsertInventoryKeepException(keepException: KeepExceptionV1): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.upsertKeepException(keepException);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	async removeInventoryKeepException(exceptionId: string): Promise<void> {
		if (!this.runtimeReady) { this.notifyRuntimeStarting(); return; }
		const state = await this.inventoryPreferences.removeKeepException(exceptionId);
		if (state.status === 'ready') await this.inventoryAdvisor.reclassify();
		if (state.status === 'blocked' || state.status === 'conflict') this.inventoryAdvisor.block();
		this.renderInventoryAdvisorViews();
	}

	invalidateInventoryAdvisor(): void {
		this.inventoryAdvisor.invalidate();
		this.inventoryPreferences.invalidate();
		this.renderInventoryAdvisorViews();
	}
}

/** `liveRulesExpiredAtMsFromLoad` from a bare instant, for callers that have not already loaded the bundle themselves. */
function liveRulesExpiredAtMs(nowMs: number): number | null {
	return liveRulesExpiredAtMsFromLoad(inventoryAdvisorBuiltinBundleProvider.load(new Date(nowMs).toISOString()));
}

/** Identical to a brand-new editor session before its first `load()`. */
const IDLE_PREFERENCES_STATE: InventoryPreferencesEditorState = { status: 'not_loaded', goals: [], keepExceptions: [] };

/** Every action resolves without mutating anything and tells the caller the boot is still running. */
function idleInventoryPreferencesEditorSession(notifyRuntimeStarting: () => void): InventoryPreferencesEditorSession {
	const blocked = async (): Promise<InventoryPreferencesEditorState> => {
		notifyRuntimeStarting();
		return structuredClone(IDLE_PREFERENCES_STATE);
	};
	return Object.freeze({
		current: () => structuredClone(IDLE_PREFERENCES_STATE),
		load: blocked,
		upsertGoal: blocked,
		removeGoal: blocked,
		upsertKeepException: blocked,
		removeKeepException: blocked,
	});
}
