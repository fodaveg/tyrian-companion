/**
 * The live view of the session (DE-01, step 3f): opening, repainting and focusing the views the host
 * has mounted, and the loot state they paint.
 * - The repaint of the Companion, coalesced to one per microtask (`renderViews`), the repaint of the
 *   Inventory and Sale tabs together (`renderInventoryAdvisorViews`), the Achievements one, the
 *   one-click sync's progress (`renderInventorySyncRunChange`) and the background indicators.
 * - Opening a section, or focusing it where it is already open (`activateView` and its siblings,
 *   `revealSection`), on the main screen or in a view of its own.
 * - The live session's loot as the views read it (`getLiveSessionLoot`).
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * the mounted view controllers (`viewControllers`, which its registration and unload also walk), the
 * placement it registered and the product actions. It hands all of that through
 * `LiveViewRuntimePort`; the getters below carry the names of the core's own fields, so the moved
 * code reads as it did there.
 *
 * Its name does not hold `session-runtime`, and it is not a persisted-session boundary: it reaches no
 * store and no note writer, only paints what the services already hold.
 */
import type { TyrianHost } from '../host/tyrian-host';
import type { LiveSessionLootState, LiveSessionLootTracker } from '../sessions/live-session-loot';
import type { AchievementsItemView } from '../ui/achievements-item-view';
import { ACHIEVEMENTS_VIEW_TYPE } from '../ui/achievements-item-view';
import { refreshBackgroundStatus } from '../ui/background-status-refresh';
import { COMPANION_VIEW_TYPE, type TyrianCompanionView } from '../ui/companion-view';
import { INVENTORY_ADVISOR_VIEW_TYPE, type InventoryAdvisorItemView } from '../ui/inventory-advisor-item-view';
import type { MountedViews, TyrianSectionId } from '../ui/mounted-views';
import { SALE_VIEW_TYPE, type SaleItemView } from '../ui/sale-item-view';
import type { InventoryVaultSyncRunState } from '../ui/inventory-vault-sync-run-controller';
import type { ProductActionController } from '../ui/product-action-controller';
import type { ViewPlacement } from './view-placement';

/** The ONE view of a host's main screen that lists the four sections (`TyrianUiPort.registerSectionsView`). */
export const TYRIAN_MAIN_VIEW_TYPE = 'tyrian-main-view';

/**
 * R1c: the view controllers the host has mounted, one set per view type, which the repaints walk.
 * The core builds them on first use and owns them.
 */
export interface LiveViewControllers {
	readonly companion: MountedViews<TyrianCompanionView>;
	readonly inventoryAdvisor: MountedViews<InventoryAdvisorItemView>;
	readonly sale: MountedViews<SaleItemView>;
	readonly achievements: MountedViews<AchievementsItemView>;
}

/**
 * Everything `LiveViewRuntime` reads from the core and asks of it. Each member carries the name of
 * the core's own field, read live: the controllers and the placement are replaced after the port is
 * built, and a service the core builds in `initializeRuntime` is seen as it stands at the moment of
 * the read.
 */
export interface LiveViewRuntimePort {
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	/** The host's UI: where a section is revealed. */
	readonly host: { readonly ui: Pick<TyrianHost['ui'], 'revealView' | 'revealSection'> };
	/** The mounted view controllers, built on first use. */
	readonly mountedViews: LiveViewControllers;
	/** What is registered with the host right now; null until `onload` registers. */
	readonly registeredPlacement: ViewPlacement | null;
	/** Built in `onload`; the repaint refreshes it, so it may still be unset. */
	readonly productActions: Pick<ProductActionController, 'refresh'> | undefined;
	/** The ribbon's title follows the session. */
	readonly commands: { refreshSessionRibbon(): void };
	/** Built in `initializeRuntime`; read only once `runtimeReady` says so. */
	readonly liveSessionLoot: Pick<LiveSessionLootTracker, 'getState'>;
}

export class LiveViewRuntime {
	/** Set the instant a caller marks a repaint due; cleared once `flushRenderViews` has run. */
	private renderViewsDirty = false;
	/** True between the first `renderViews()` of a batch and the microtask that flushes it. */
	private renderViewsFlushScheduled = false;
	/** True while the one-click sync's last reported state was `running`. */
	private inventorySyncRunInFlight = false;

	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: LiveViewRuntimePort) {}

	// The core's own fields, read through the port under the names the moved code uses.
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get host(): LiveViewRuntimePort['host'] { return this.port.host; }
	private get mountedViews(): LiveViewControllers { return this.port.mountedViews; }
	private get registeredPlacement(): ViewPlacement | null { return this.port.registeredPlacement; }
	private get productActions(): LiveViewRuntimePort['productActions'] { return this.port.productActions; }
	private get commands(): LiveViewRuntimePort['commands'] { return this.port.commands; }
	private get liveSessionLoot(): LiveViewRuntimePort['liveSessionLoot'] { return this.port.liveSessionLoot; }

	getLiveSessionLoot(): LiveSessionLootState {
		// H checkpoint 16 (Hebra): `liveSessionLoot` is assigned inside `initializeRuntime`, but a
		// saved-tab view can mount and read this before that finishes. Answer with the same `idle`
		// state the tracker itself starts in, instead of throwing on the still-unassigned field.
		return this.runtimeReady ? this.liveSessionLoot.getState() : { status: 'idle' };
	}

	/**
	 * Marks the Companion surface dirty and coalesces every call in the same microtask tick into
	 * one repaint. A single detection poll chains up to four of these (loot tracker, both
	 * Halloween callbacks, session state), and `TyrianCompanionView.render()` empties and rebuilds
	 * the whole panel (`companion-view.ts`'s `surface.empty()`): four synchronous calls used to
	 * mean four full rebuilds of a screen that only needed to change once.
	 */
	renderViews(): void {
		this.renderViewsDirty = true;
		if (this.renderViewsFlushScheduled) return;
		this.renderViewsFlushScheduled = true;
		queueMicrotask(() => {
			this.renderViewsFlushScheduled = false;
			if (!this.renderViewsDirty) return;
			this.renderViewsDirty = false;
			this.flushRenderViews();
		});
	}

	private flushRenderViews(): void {
		this.productActions?.refresh();
		this.commands.refreshSessionRibbon();
		for (const view of this.mountedViews.companion.current()) view.render();
	}

	renderInventoryAdvisorViews(): void {
		this.productActions?.refresh();
		for (const view of this.mountedViews.inventoryAdvisor.current()) view.render();
		// The Sale tab reads the SAME advisor model, so every refresh that moves it also
		// moves the Sale tab's own hero card, calendar and grouped list.
		for (const view of this.mountedViews.sale.current()) view.render();
	}

	renderAchievementsViews(): void {
		for (const view of this.mountedViews.achievements.current()) view.render();
	}

	/**
	 * Every state the one-click sync reports. A run in flight reports once per note written, each an
	 * `await` apart, and none of those reports changes what the Sale tab shows: only the Inventory
	 * tab carries the progress, and it repaints on its own next frame (`renderProgress`). Any other
	 * state (the outcome, a conflict, a disabled reason) is content and repaints both tabs at once.
	 */
	renderInventorySyncRunChange(state: InventoryVaultSyncRunState): void {
		if (state.status !== 'running') {
			this.inventorySyncRunInFlight = false;
			this.renderInventoryAdvisorViews();
			return;
		}
		// The shared actions only read whether a run is in flight, not how far along it is.
		if (!this.inventorySyncRunInFlight) {
			this.inventorySyncRunInFlight = true;
			this.productActions?.refresh();
		}
		for (const view of this.mountedViews.inventoryAdvisor.current()) view.renderProgress();
	}

	refreshBackgroundIndicators(): void {
		this.commands.refreshSessionRibbon();
		refreshBackgroundStatus(this.mountedViews.companion.current());
	}

	/** Opens the Companion, or focuses it where it is already open (`host.ui.revealView`). */
	async activateView(): Promise<void> {
		await this.revealSection('session', COMPANION_VIEW_TYPE);
	}

	async activateInventoryAdvisorView(): Promise<void> {
		await this.revealSection('inventory', INVENTORY_ADVISOR_VIEW_TYPE);
	}

	async activateSaleView(): Promise<void> {
		await this.revealSection('sale', SALE_VIEW_TYPE);
	}

	async activateAchievementsView(): Promise<void> {
		await this.revealSection('achievements', ACHIEVEMENTS_VIEW_TYPE);
	}

	/**
	 * Everything that opens a section from outside it (a command, the ribbon menu, a notice, the
	 * end of a sync) comes here: on the host's main screen it enters that section of the one view;
	 * otherwise it opens the section's own view.
	 */
	private async revealSection(section: TyrianSectionId, viewType: string): Promise<void> {
		const reveal = this.registeredPlacement === 'main' ? this.host.ui.revealSection?.(TYRIAN_MAIN_VIEW_TYPE, section) : undefined;
		if (reveal !== undefined) await reveal;
		else await this.host.ui.revealView(viewType);
	}
}
