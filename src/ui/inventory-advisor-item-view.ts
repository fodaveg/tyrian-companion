import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { createTranslator, type Locale } from '../core/i18n';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { InventoryPreferencesEditorSession } from '../advisor/inventory-preferences-runtime';
import type { ReservationGoal } from '../economy/reservation-model';
import type { InventoryAdvisorViewModel } from './inventory-advisor-view-model';
import { renderInventoryAdvisorView } from './inventory-advisor-view';
import type { InventoryVaultSyncViewState } from './inventory-vault-sync-controller';

export const INVENTORY_ADVISOR_VIEW_TYPE = 'tyrian-inventory-advisor-view';

export interface InventoryAdvisorViewActions {
	getInventoryAdvisorLocale(): Locale;
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
	createInventoryPreferencesEditorSession?(): InventoryPreferencesEditorSession;
	refreshInventoryAdvisor(): Promise<void>;
	loadInventoryPreferences?(): Promise<void>;
	upsertInventoryGoal?(goal: ReservationGoal): Promise<void>;
	removeInventoryGoal?(goalId: string): Promise<void>;
	upsertInventoryKeepException?(keepException: KeepExceptionV1): Promise<void>;
	removeInventoryKeepException?(exceptionId: string): Promise<void>;
	getInventoryVaultSyncState?(): InventoryVaultSyncViewState;
	canApplyInventoryVaultSync?(): boolean;
	hasManagedAssetsRoot?(): boolean;
	previewInventoryVaultSync?(): Promise<void>;
	applyInventoryVaultSync?(): Promise<void>;
}

/** Thin Obsidian adapter. Opening and rendering only read the controller's memory snapshot. */
export class InventoryAdvisorItemView extends ItemView {
	private refreshing = false;
	private preferencesBusy = false;
	private closed = false;
	private readonly preferenceSession: InventoryPreferencesEditorSession | undefined;

	constructor(leaf: WorkspaceLeaf, private readonly actions: InventoryAdvisorViewActions) {
		super(leaf);
		this.preferenceSession = this.actions.createInventoryPreferencesEditorSession?.();
	}
	getViewType(): string { return INVENTORY_ADVISOR_VIEW_TYPE; }
	getDisplayText(): string { return createTranslator(this.actions.getInventoryAdvisorLocale()).t('advisor.view.title'); }
	getIcon(): string { return 'package-search'; }
	async onOpen(): Promise<void> { this.closed = false; this.render(); }
	async onClose(): Promise<void> { this.closed = true; }

	render(): void {
		if (this.closed) return;
		renderInventoryAdvisorView(
			this.contentEl,
			this.actions.getInventoryAdvisorViewModel(),
			createTranslator(this.actions.getInventoryAdvisorLocale()),
			undefined,
			{
				refreshing: this.refreshing,
				preferencesBusy: this.preferencesBusy,
				onRefresh: () => this.refresh(),
				preferences: this.preferenceSession?.current(),
				onLoadPreferences: this.preferenceSession === undefined ? undefined : () => this.runPreferenceAction(async () => { await this.preferenceSession!.load(); }),
				onUpsertGoal: this.preferenceSession === undefined ? undefined : (goal) => this.runPreferenceAction(async () => { await this.preferenceSession!.upsertGoal(goal); }),
				onRemoveGoal: this.preferenceSession === undefined ? undefined : (goalId) => this.runPreferenceAction(async () => { await this.preferenceSession!.removeGoal(goalId); }),
				onUpsertKeepException: this.preferenceSession === undefined ? undefined : (keepException) => this.runPreferenceAction(async () => { await this.preferenceSession!.upsertKeepException(keepException); }),
				onRemoveKeepException: this.preferenceSession === undefined ? undefined : (exceptionId) => this.runPreferenceAction(async () => { await this.preferenceSession!.removeKeepException(exceptionId); }),
				inventorySync: this.actions.getInventoryVaultSyncState === undefined ||
					this.actions.previewInventoryVaultSync === undefined || this.actions.applyInventoryVaultSync === undefined
					? undefined
					: {
						state: this.actions.getInventoryVaultSyncState(),
						canApply: this.actions.canApplyInventoryVaultSync?.() ?? false,
						assetsInstalled: this.actions.hasManagedAssetsRoot?.() ?? false,
						onPreview: () => this.runInventorySyncAction(() => this.actions.previewInventoryVaultSync!()),
						onApply: () => this.runInventorySyncAction(() => this.actions.applyInventoryVaultSync!()),
					},
			},
		);
	}

	private async runInventorySyncAction(action: () => Promise<void>): Promise<void> {
		if (this.closed) return;
		this.render();
		try { await action(); }
		finally { this.render(); }
	}

	async refresh(): Promise<void> {
		if (this.refreshing || this.closed) return;
		this.refreshing = true;
		this.render();
		try { await this.actions.refreshInventoryAdvisor(); }
		finally { this.refreshing = false; this.render(); }
	}

	private async runPreferenceAction(action: () => void | Promise<void> | undefined): Promise<void> {
		if (this.preferencesBusy || this.closed) return;
		this.preferencesBusy = true;
		this.render();
		try { await action(); }
		finally { this.preferencesBusy = false; this.render(); }
	}
}
