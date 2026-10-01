import type { TyrianUiPort } from '../host/tyrian-host';
import { createTranslator, type Locale } from '../core/i18n';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { InventoryPreferencesEditorSession, InventoryPreferencesEditorState } from '../advisor/inventory-preferences-runtime';
import type { ReservationGoal } from '../economy/reservation-model';
import type { InventoryAdvisorViewModel } from './inventory-advisor-view-model';
import { disposeInventoryAdvisorView, keepExceptionForItem, renderInventoryAdvisorView } from './inventory-advisor-view';
import type { PriceHistoryPanelInteractions } from './price-history-panel-view';
import type { InventoryVaultSyncRunState } from './inventory-vault-sync-run-controller';
import type { PriceSeedQueueCoverage } from '../economy/price-seed-model';
import type { PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import type { PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { PriceHistorySide, PriceHistoryWindowDays } from '../economy/price-history-model';
import type { SellSignalRuntimeState } from '../economy/sell-signal-runtime';
import type { TyrianViewDescriptor } from './mounted-views';
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
	/** Opt-in offer (24 sep 2026): a settings read only, never a trigger. See `priceHistoryOptInOffered`. */
	isPriceHistoryOptInOffered?(): boolean;
	/** «Ahora no» on the offer: one settings write, hides it until the next plugin version. */
	dismissPriceHistoryOptIn?(): Promise<void>;
	loadPriceHistorySeries?(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void>;
	/** Public catalog name + icon for watched ids not already covered by the current inventory model. Cached; deferred to the panel opening. */
	resolvePriceHistoryItemCatalog?(itemIds: number[]): Promise<Record<number, { name: string; icon: string | null }>>;
	/** Last known datawars2 seed state for one item; a stale read, never a trigger. */
	getPriceHistorySeedState?(itemId: number): PriceHistoryPanelSeedState;
	/**
	 * H18.17: the bulk seed queue's coverage across the whole watch list, from the last
	 * "Sincronizar inventario" pass. A stale read, never a trigger.
	 */
	getPriceSeedQueueCoverage?(): PriceSeedQueueCoverage | null;
	getProductActionController?(): ProductActionController;
	hasConfiguredApiKey?(): boolean;
	openProductSettings?(): void;
	/** Same account-level Halloween bag sell/hold verdict the session panel already reads (H14.6/H14.12). */
	getSellSignalState?(): SellSignalRuntimeState | null;
}

/** The Inventory tab for `TyrianUiPort.registerView`: in Hebra, the 960×720 dialog (agreed with Hebra, R1c). */
export function inventoryAdvisorView(actions: Pick<InventoryAdvisorViewActions, 'getInventoryAdvisorLocale'>): TyrianViewDescriptor {
	return {
		type: INVENTORY_ADVISOR_VIEW_TYPE,
		title: () => createTranslator(actions.getInventoryAdvisorLocale()).t('advisor.view.title'),
		icon: 'package-search',
		placement: 'dialog',
	};
}

/**
 * The Inventory tab's controller, mounted by the host into `contentEl` (an `ItemView`'s content
 * in Obsidian). Opening and rendering only read the controller's memory snapshot.
 */
export class InventoryAdvisorItemView {
	private preferencesBusy = false;
	/** The last preference write of this view did not save; cleared by the next write or load. */
	private preferenceWriteFailed = false;
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
	/** The frame a progress report is waiting for, with the window that owns it (a popout has its own). */
	private progressFrame: { readonly win: Window; readonly handle: number } | null = null;
	/** The element the advisor view is mounted in: the shell's content, or `contentEl` without a shell. */
	private advisorSurface: HTMLElement | null = null;

	constructor(
		readonly contentEl: HTMLElement,
		private readonly ui: Pick<TyrianUiPort, 'setIcon'>,
		private readonly actions: InventoryAdvisorViewActions,
	) {
		this.preferenceSession = this.actions.createInventoryPreferencesEditorSession?.();
	}
	async onOpen(): Promise<void> { this.closed = false; this.render(); }
	async onClose(): Promise<void> {
		this.closed = true;
		this.cancelProgressRender();
		this.releaseAdvisorSurface(null);
		this.actions.getProductActionController?.().setInventorySurfaceBusy(this, false);
		this.productShell?.dispose();
		this.productShell = null;
		this.productShellKey = null;
	}

	/**
	 * A progress report of a run in flight: repaints on the next frame of this tab's own window, so
	 * a burst of reports (one per note written, each an `await` apart) costs one repaint per frame
	 * and none while the window is not being drawn. The frame reads the state when it runs, never
	 * the one that asked for it, so the last report is always the one shown.
	 */
	renderProgress(): void {
		if (this.closed || this.progressFrame !== null) return;
		const win = this.contentEl.win;
		const handle = win.requestAnimationFrame(() => {
			this.progressFrame = null;
			this.render();
		});
		this.progressFrame = { win, handle };
	}

	/** Drops the frame a progress report is waiting for; closing the tab and unloading both call it. */
	cancelProgressRender(): void {
		if (this.progressFrame === null) return;
		this.progressFrame.win.cancelAnimationFrame(this.progressFrame.handle);
		this.progressFrame = null;
	}

	/** Disposes the advisor view of the surface this tab is leaving (a rebuilt shell, or the close). */
	private releaseAdvisorSurface(next: HTMLElement | null): void {
		if (this.advisorSurface !== null && this.advisorSurface !== next) disposeInventoryAdvisorView(this.advisorSurface);
		this.advisorSurface = next;
	}

	render(): void {
		if (this.closed) return;
		// A full repaint already shows whatever a waiting progress frame was going to show.
		this.cancelProgressRender();
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
		// The offer's enable is the panel's own `enablePriceHistory`, i.e. `updateSettings`, the path
		// Settings uses; both buttons share the panel's busy guard so a double click writes once.
		const priceHistoryOptIn = this.actions.enablePriceHistory === undefined
			|| this.actions.dismissPriceHistoryOptIn === undefined
			|| this.actions.isPriceHistoryOptInOffered?.() !== true
			? undefined
			: {
				busy: this.priceHistoryBusy,
				onEnable: () => this.runPriceHistoryAction(() => this.actions.enablePriceHistory!()),
				onDismiss: () => this.runPriceHistoryAction(() => this.actions.dismissPriceHistoryOptIn!()),
			};
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
			ui: this.ui,
			});
			this.productShellKey = shellKey;
		}
		const surface = this.productShell?.content ?? this.contentEl;
		this.releaseAdvisorSurface(surface);
		this.productShell?.update();
		renderInventoryAdvisorView(
			surface,
			this.ui,
			model,
			createTranslator(this.actions.getInventoryAdvisorLocale()),
			undefined,
			{
				preferencesBusy: this.preferencesBusy,
				preferences: this.preferenceSession?.current(),
				preferenceWriteFailed: this.preferenceWriteFailed,
				onLoadPreferences: this.preferenceSession === undefined ? undefined : () => this.runPreferenceAction(async () => { this.preferenceWriteFailed = false; await this.preferenceSession!.load(); }),
				onUpsertGoal: this.preferenceSession === undefined ? undefined : (goal) => this.runPreferenceWrite(async () => await this.preferenceSession!.upsertGoal(goal)),
				onRemoveGoal: this.preferenceSession === undefined ? undefined : (goalId) => this.runPreferenceWrite(async () => await this.preferenceSession!.removeGoal(goalId)),
				onUpsertKeepException: this.preferenceSession === undefined ? undefined : (keepException) => this.runPreferenceWrite(async () => await this.preferenceSession!.upsertKeepException(keepException)),
				onRemoveKeepException: this.preferenceSession === undefined ? undefined : (exceptionId) => this.runPreferenceWrite(async () => await this.preferenceSession!.removeKeepException(exceptionId)),
				onKeepItem: this.preferenceSession === undefined ? undefined : (itemId) => this.runPreferenceWrite(async () => await this.keepItem(itemId)),
				inventorySync: sync,
				priceHistory,
				priceHistoryOptIn,
				sellSignalState: this.actions.getSellSignalState?.() ?? null,
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
			queueCoverage: this.actions.getPriceSeedQueueCoverage?.() ?? null,
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

	/**
	 * H18.18: a row's "Conservar". The same keep-exception write the preferences form does, without
	 * the id: the preferences are loaded first when the view never opened them (the write needs
	 * their CAS revision), and an item already kept whole is left as it is.
	 */
	private async keepItem(itemId: number): Promise<InventoryPreferencesEditorState> {
		const session = this.preferenceSession!;
		const state = session.current().status === 'ready' ? session.current() : await session.load();
		if (state.status !== 'ready') return state;
		const keepException = keepExceptionForItem(itemId, state.keepExceptions);
		return keepException === null ? state : await session.upsertKeepException(keepException);
	}

	/**
	 * One preference write of the user. It ends either saved or visibly refused: a session that fell
	 * behind (`needs_refresh`: another leaf wrote, or a new analysis replaced the revision) is reloaded
	 * and the same intention is applied once more on top of the revision in force, and anything that
	 * still did not save is kept as `preferenceWriteFailed` for the view to say so. The retry cannot
	 * overwrite a revision this view never read: the write is still a CAS on the reloaded generation.
	 */
	private async runPreferenceWrite(write: () => Promise<InventoryPreferencesEditorState>): Promise<void> {
		await this.runPreferenceAction(async () => {
			this.preferenceWriteFailed = false;
			let saved = false;
			try {
				let state = await write();
				if (state.status === 'needs_refresh' && (await this.preferenceSession!.load()).status === 'ready') state = await write();
				saved = state.status === 'ready';
			}
			finally { this.preferenceWriteFailed = !saved; }
		});
	}

	private async runPreferenceAction(action: () => void | Promise<void> | undefined): Promise<void> {
		if (this.preferencesBusy || this.closed) return;
		this.preferencesBusy = true;
		this.render();
		try { await action(); }
		finally { this.preferencesBusy = false; this.render(); }
	}
}
