import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { createTranslator, type Locale } from '../core/i18n';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { InventoryPreferencesEditorSession } from '../advisor/inventory-preferences-runtime';
import type { ReservationGoal } from '../economy/reservation-model';
import type { InventoryAdvisorViewModel } from './inventory-advisor-view-model';
import { renderInventoryAdvisorView } from './inventory-advisor-view';
import type { PriceHistoryPanelInteractions } from './price-history-panel-view';
import type { InventoryVaultSyncRunState } from './inventory-vault-sync-run-controller';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { PriceHistorySide, PriceHistoryWindowDays } from '../economy/price-history-model';
import type { ProductActionController } from './product-action-controller';
import { renderProductShell, type ProductShellMount } from './product-shell';

export const INVENTORY_ADVISOR_VIEW_TYPE = 'tyrian-inventory-advisor-view';

export interface InventoryAdvisorViewActions {
	getInventoryAdvisorLocale(): Locale;
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
	refreshInventoryAdvisor?(): Promise<void>;
	createInventoryPreferencesEditorSession?(): InventoryPreferencesEditorSession;
	loadInventoryPreferences?(): Promise<void>;
	upsertInventoryGoal?(goal: ReservationGoal): Promise<void>;
	removeInventoryGoal?(goalId: string): Promise<void>;
	upsertInventoryKeepException?(keepException: KeepExceptionV1): Promise<void>;
	removeInventoryKeepException?(exceptionId: string): Promise<void>;
	/** Reads the live/persisted state of the single-button sync; never starts work by itself. */
	getInventoryVaultSyncRunState?(): InventoryVaultSyncRunState;
	hasManagedAssetsRoot?(): boolean;
	/** The one-click flow: refresh, preview, and (unless it must pause) apply. */
	runInventoryVaultSync?(): Promise<void>;
	/** Writes a plan that paused for confirmation. */
	confirmInventoryVaultSync?(): Promise<void>;
	/** Discards a pending destructive plan without writing anything. */
	cancelInventoryVaultSync?(): void;
	getPriceHistoryState?(): PriceHistoryRuntimeState;
	enablePriceHistory?(): Promise<void>;
	loadPriceHistorySeries?(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void>;
	/** Public catalog name + icon for watched ids not already covered by the current inventory model. Cached; deferred to the panel opening. */
	resolvePriceHistoryItemCatalog?(itemIds: number[]): Promise<Record<number, { name: string; icon: string | null }>>;
	/** Last known datawars2 seed state for one item; a stale read, never a trigger. */
	getPriceHistorySeedState?(itemId: number): PriceHistoryPanelSeedState;
	getProductActionController?(): ProductActionController;
	hasConfiguredApiKey?(): boolean;
	openProductSettings?(): void;
}

/** Thin Obsidian adapter. Opening and rendering only read the controller's memory snapshot. */
export class InventoryAdvisorItemView extends ItemView {
	private preferencesBusy = false;
	private analysisBusy = false;
	private syncBusy = false;
	private priceHistoryBusy = false;
	private closed = false;
	private productShell: ProductShellMount | null = null;
	private productShellKey: string | null = null;
	private readonly preferenceSession: InventoryPreferencesEditorSession | undefined;
	/** Public catalog name/icon for the price-history watch list. Resolved once per distinct id set. */
	private priceHistoryCatalog: Record<number, { name: string; icon: string | null }> = {};
	private priceHistoryCatalogKey: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly actions: InventoryAdvisorViewActions) {
		super(leaf);
		this.preferenceSession = this.actions.createInventoryPreferencesEditorSession?.();
	}
	getViewType(): string { return INVENTORY_ADVISOR_VIEW_TYPE; }
	getDisplayText(): string { return createTranslator(this.actions.getInventoryAdvisorLocale()).t('advisor.view.title'); }
	getIcon(): string { return 'package-search'; }
	async onOpen(): Promise<void> { this.closed = false; this.render(); }
	async onClose(): Promise<void> {
		this.closed = true;
		this.actions.getProductActionController?.().setInventorySurfaceBusy(this, false);
		this.productShell?.dispose();
		this.productShell = null;
		this.productShellKey = null;
	}

	render(): void {
		if (this.closed) return;
		const model = this.actions.getInventoryAdvisorViewModel();
		const sync = this.actions.getInventoryVaultSyncRunState === undefined
			|| this.actions.runInventoryVaultSync === undefined
			|| this.actions.confirmInventoryVaultSync === undefined
			|| this.actions.cancelInventoryVaultSync === undefined
			|| this.actions.refreshInventoryAdvisor === undefined
			? undefined
			: {
				state: this.actions.getInventoryVaultSyncRunState(),
				assetsInstalled: this.actions.hasManagedAssetsRoot?.() ?? false,
				analysisBusy: this.analysisBusy,
				onAnalyze: () => this.runInventoryAnalysisAction(() => this.actions.refreshInventoryAdvisor!()),
				onRun: () => this.runInventorySyncAction(() => this.actions.runInventoryVaultSync!()),
				onConfirm: () => this.runInventorySyncAction(() => this.actions.confirmInventoryVaultSync!()),
				onCancel: () => { this.actions.cancelInventoryVaultSync!(); this.render(); },
			};
		const priceHistory = this.actions.getPriceHistoryState === undefined
			|| this.actions.enablePriceHistory === undefined
			|| this.actions.loadPriceHistorySeries === undefined
			? undefined : this.buildPriceHistoryInteractions(this.actions.getPriceHistoryState(), model);
		const actionController = this.actions.getProductActionController?.();
		actionController?.setInventorySurfaceBusy(this, this.analysisBusy || this.syncBusy);
		const locale = this.actions.getInventoryAdvisorLocale();
		const missingApiKey = !(this.actions.hasConfiguredApiKey?.() ?? true);
		const shellKey = `${locale}:${String(missingApiKey)}`;
		if (actionController !== undefined && (this.productShell === null || this.productShellKey !== shellKey)) {
			this.productShell?.dispose();
			this.productShell = renderProductShell(this.contentEl, {
			locale,
			active: 'inventory',
			actions: actionController,
			missingApiKey,
			openSettings: () => this.actions.openProductSettings?.(),
			});
			this.productShellKey = shellKey;
		}
		const surface = this.productShell?.content ?? this.contentEl;
		this.productShell?.update();
		renderInventoryAdvisorView(
			surface,
			model,
			createTranslator(this.actions.getInventoryAdvisorLocale()),
			undefined,
			{
				preferencesBusy: this.preferencesBusy,
				preferences: this.preferenceSession?.current(),
				onLoadPreferences: this.preferenceSession === undefined ? undefined : () => this.runPreferenceAction(async () => { await this.preferenceSession!.load(); }),
				onUpsertGoal: this.preferenceSession === undefined ? undefined : (goal) => this.runPreferenceAction(async () => { await this.preferenceSession!.upsertGoal(goal); }),
				onRemoveGoal: this.preferenceSession === undefined ? undefined : (goalId) => this.runPreferenceAction(async () => { await this.preferenceSession!.removeGoal(goalId); }),
				onUpsertKeepException: this.preferenceSession === undefined ? undefined : (keepException) => this.runPreferenceAction(async () => { await this.preferenceSession!.upsertKeepException(keepException); }),
				onRemoveKeepException: this.preferenceSession === undefined ? undefined : (exceptionId) => this.runPreferenceAction(async () => { await this.preferenceSession!.removeKeepException(exceptionId); }),
				inventorySync: sync,
				priceHistory,
			},
		);
	}

	private async runInventorySyncAction(action: () => Promise<void>): Promise<void> {
		if (this.closed || this.analysisBusy || this.syncBusy) return;
		this.syncBusy = true;
		try {
			const operation = action();
			this.render();
			await operation;
		}
		finally {
			this.syncBusy = false;
			this.render();
		}
	}

	private async runInventoryAnalysisAction(action: () => Promise<void>): Promise<void> {
		if (this.closed || this.analysisBusy) return;
		this.analysisBusy = true;
		this.render();
		try { await action(); }
		finally {
			this.analysisBusy = false;
			this.render();
		}
	}

	private async runPriceHistoryAction(action: () => Promise<void>): Promise<void> {
		if (this.closed || this.priceHistoryBusy) return;
		this.priceHistoryBusy = true;
		this.render();
		try { await action(); }
		finally { this.priceHistoryBusy = false; this.render(); }
	}

	/** Adds the price-history panel's own catalog names/icons and current seed on top of the runtime state. */
	private buildPriceHistoryInteractions(state: PriceHistoryRuntimeState, model: InventoryAdvisorViewModel): PriceHistoryPanelInteractions {
		this.refreshPriceHistoryCatalog(state.watchItemIds);
		const modelNames = Object.fromEntries(model.groups.flatMap(({ rows }) => rows.map(({ itemId, name }) => [itemId, name])));
		const itemLabels: Record<number, string> = { ...modelNames };
		const itemIcons: Record<number, string> = {};
		for (const [key, entry] of Object.entries(this.priceHistoryCatalog)) {
			const itemId = Number(key);
			itemLabels[itemId] = entry.name;
			if (entry.icon !== null) itemIcons[itemId] = entry.icon;
		}
		const selectedItemId = state.selectedItemId ?? state.watchItemIds[0] ?? null;
		const seed = selectedItemId === null ? undefined : this.actions.getPriceHistorySeedState?.(selectedItemId);
		return {
			state,
			itemLabels,
			itemIcons,
			seed,
			busy: this.priceHistoryBusy,
			onEnable: () => this.runPriceHistoryAction(() => this.actions.enablePriceHistory!()),
			onLoad: (itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays) =>
				this.runPriceHistoryAction(() => this.actions.loadPriceHistorySeries!(itemId, side, windowDays)),
		};
	}

	/** Resolves catalog names/icons for the watch list at most once per distinct id set; deferred to render. */
	private refreshPriceHistoryCatalog(watchItemIds: readonly number[]): void {
		if (this.actions.resolvePriceHistoryItemCatalog === undefined || watchItemIds.length === 0) return;
		const key = [...watchItemIds].sort((left, right) => left - right).join(',');
		if (key === this.priceHistoryCatalogKey) return;
		this.priceHistoryCatalogKey = key;
		void this.loadPriceHistoryCatalog([...watchItemIds]);
	}

	private async loadPriceHistoryCatalog(itemIds: number[]): Promise<void> {
		try {
			const resolved = await this.actions.resolvePriceHistoryItemCatalog!(itemIds);
			if (this.closed) return;
			this.priceHistoryCatalog = { ...this.priceHistoryCatalog, ...resolved };
			this.render();
		} catch {
			// An unreachable catalog leaves every id on its numeric fallback; the panel keeps working.
		}
	}

	private async runPreferenceAction(action: () => void | Promise<void> | undefined): Promise<void> {
		if (this.preferencesBusy || this.closed) return;
		this.preferencesBusy = true;
		this.render();
		try { await action(); }
		finally { this.preferencesBusy = false; this.render(); }
	}
}
