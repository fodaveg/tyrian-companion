import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { createTranslator, type Locale } from '../core/i18n';
import type { KeepExceptionV1 } from '../advisor/inventory-advisor-model';
import type { InventoryPreferencesEditorSession } from '../advisor/inventory-preferences-runtime';
import type { ReservationGoal } from '../economy/reservation-model';
import type { InventoryAdvisorViewModel } from './inventory-advisor-view-model';
import { renderInventoryAdvisorView } from './inventory-advisor-view';
import type { InventoryVaultSyncRunState } from './inventory-vault-sync-run-controller';

export const INVENTORY_ADVISOR_VIEW_TYPE = 'tyrian-inventory-advisor-view';

export interface InventoryAdvisorViewActions {
	getInventoryAdvisorLocale(): Locale;
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
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
}

/** Thin Obsidian adapter. Opening and rendering only read the controller's memory snapshot. */
export class InventoryAdvisorItemView extends ItemView {
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
		const sync = this.actions.getInventoryVaultSyncRunState === undefined
			|| this.actions.runInventoryVaultSync === undefined
			|| this.actions.confirmInventoryVaultSync === undefined
			|| this.actions.cancelInventoryVaultSync === undefined
			? undefined
			: {
				state: this.actions.getInventoryVaultSyncRunState(),
				assetsInstalled: this.actions.hasManagedAssetsRoot?.() ?? false,
				onRun: () => this.runInventorySyncAction(() => this.actions.runInventoryVaultSync!()),
				onConfirm: () => this.runInventorySyncAction(() => this.actions.confirmInventoryVaultSync!()),
				onCancel: () => { this.actions.cancelInventoryVaultSync!(); this.render(); },
			};
		renderInventoryAdvisorView(
			this.contentEl,
			this.actions.getInventoryAdvisorViewModel(),
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
			},
		);
	}

	private async runInventorySyncAction(action: () => Promise<void>): Promise<void> {
		if (this.closed) return;
		this.render();
		try { await action(); }
		finally { this.render(); }
	}

	private async runPreferenceAction(action: () => void | Promise<void> | undefined): Promise<void> {
		if (this.preferencesBusy || this.closed) return;
		this.preferencesBusy = true;
		this.render();
		try { await action(); }
		finally { this.preferencesBusy = false; this.render(); }
	}
}
