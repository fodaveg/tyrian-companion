import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { createTranslator, type Locale } from '../core/i18n';
import type { InventoryAdvisorViewModel } from './inventory-advisor-view-model';
import { renderInventoryAdvisorView } from './inventory-advisor-view';

export const INVENTORY_ADVISOR_VIEW_TYPE = 'tyrian-inventory-advisor-view';

export interface InventoryAdvisorViewActions {
	getInventoryAdvisorLocale(): Locale;
	getInventoryAdvisorViewModel(): InventoryAdvisorViewModel;
	refreshInventoryAdvisor(): Promise<void>;
}

/** Thin Obsidian adapter. Opening and rendering only read the controller's memory snapshot. */
export class InventoryAdvisorItemView extends ItemView {
	private refreshing = false;
	private closed = false;

	constructor(leaf: WorkspaceLeaf, private readonly actions: InventoryAdvisorViewActions) { super(leaf); }
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
			{ refreshing: this.refreshing, onRefresh: () => this.refresh() },
		);
	}

	async refresh(): Promise<void> {
		if (this.refreshing || this.closed) return;
		this.refreshing = true;
		this.render();
		try { await this.actions.refreshInventoryAdvisor(); }
		finally { this.refreshing = false; this.render(); }
	}
}
