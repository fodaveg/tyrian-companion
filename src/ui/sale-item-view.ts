import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { createTranslator, type Locale } from '../core/i18n';
import type { ProductActionController } from './product-action-controller';
import { renderProductShell, type ProductShellMount } from './product-shell';
import { renderSaleView } from './sale-view';
import type { SaleViewModel } from './sale-view-model';

export const SALE_VIEW_TYPE = 'tyrian-sale-view';

export interface SaleViewActions {
	getSaleLocale(): Locale;
	/** A synchronous read boundary, like `InventoryAdvisorViewActions`: opening the view starts no I/O. */
	getSaleViewModel(): SaleViewModel;
	/** The same one-click refresh the Inventory tab already exposes (`refreshInventoryAdvisor`). */
	refreshSale?(options?: { refreshSeeds: boolean }): Promise<void>;
	getProductActionController?(): ProductActionController;
	hasConfiguredApiKey?(): boolean;
	openProductSettings?(): void;
}

/** Thin Obsidian adapter. Opening and rendering only read the controller's memory snapshot. */
export class SaleItemView extends ItemView {
	private closed = false;
	private refreshing = false;
	private productShell: ProductShellMount | null = null;
	private productShellKey: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly actions: SaleViewActions) {
		super(leaf);
	}

	getViewType(): string { return SALE_VIEW_TYPE; }
	getDisplayText(): string { return createTranslator(this.actions.getSaleLocale()).t('sale.view.title'); }
	getIcon(): string { return 'candy'; }
	async onOpen(): Promise<void> {
		this.closed = false;
		this.render();
		// H18.38 (David, 0.2.3): opening still only reads the memory snapshot, but a snapshot that
		// says "loading" because the advisor never analyzed this session needs the SAME one-click
		// refresh the footer button already offers, fired once, not a silent wait for a click that
		// nothing on screen invites. `runRefresh` already no-ops while one is in flight or absent.
		if (this.actions.getSaleViewModel().status === 'loading') void this.runRefresh(false);
	}
	async onClose(): Promise<void> {
		this.closed = true;
		this.productShell?.dispose();
		this.productShell = null;
		this.productShellKey = null;
	}

	render(): void {
		if (this.closed) return;
		const model = this.actions.getSaleViewModel();
		const locale = this.actions.getSaleLocale();
		const actionController = this.actions.getProductActionController?.();
		const missingApiKey = !(this.actions.hasConfiguredApiKey?.() ?? true);
		const shellKey = `${locale}:${String(missingApiKey)}`;
		if (actionController !== undefined && (this.productShell === null || this.productShellKey !== shellKey)) {
			this.productShell?.dispose();
			this.productShell = renderProductShell(this.contentEl, {
				locale,
				active: 'sale',
				actions: actionController,
				missingApiKey,
				openSettings: () => this.actions.openProductSettings?.(),
			});
			this.productShellKey = shellKey;
		}
		const surface = this.productShell?.content ?? this.contentEl;
		this.productShell?.update();
		renderSaleView(surface, model, createTranslator(locale), {
			refreshing: this.refreshing,
			onRefresh: this.actions.refreshSale === undefined ? undefined : () => this.runRefresh(),
		});
	}

	private async runRefresh(refreshSeeds = true): Promise<void> {
		if (this.closed || this.refreshing || this.actions.refreshSale === undefined) return;
		this.refreshing = true;
		this.render();
		try { await this.actions.refreshSale({ refreshSeeds }); }
		finally { this.refreshing = false; this.render(); }
	}
}
