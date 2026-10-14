/**
 * The price history as the views and the notes use it (DE-01, step 3g): its state, its opt-in, the
 * series and datawars2 seeds the panels ask for, the code block a note paints, the catalog names of
 * the watch list and the Halloween bag's public price.
 * - State and consent: `getPriceHistoryState`, `enablePriceHistory`, `isPriceHistoryOptInOffered`,
 *   `dismissPriceHistoryOptIn`.
 * - The local series and the seed behind an item (`loadPriceHistorySeries`, `ensurePriceHistorySeed`,
 *   `getPriceHistorySeedState`) and the note block that shares that seed.
 * - The names and icons of the watch list (`resolvePriceHistoryItemCatalog`) and the bag's quote for
 *   the in-game bridge (`getBagPriceIngameState`).
 *
 * Moved unchanged from `TyrianCompanionCore`, which stays the facade the views see. The core keeps
 * the services (it builds them in `initializeRuntime` and disposes them in `unload`) and the catalog
 * it shares with the session loot panel; it hands all of that through `PriceHistoryRuntimePort`,
 * whose members carry the names of the core's own fields, so the moved code reads as it did there.
 *
 * Not to be confused with `economy/price-history-runtime.ts`, the service this one reads (imported
 * here as `PriceHistoryService`). Its name does not hold `session-runtime`, and it is not a
 * persisted-session boundary: the history's stores belong to that service, this holds none.
 */
import type { PriceIngameState } from '../alerts/price-ingame-state';
import { openSessionCatalog } from './session-note-runtime';
import type { PublicCatalogService } from '../catalog/public-catalog-service';
import type { LocalDebugActionRunner } from '../core/local-debug-action-runner';
import { startLocalDebugAction } from '../core/local-debug-action-runner';
import { createTranslator } from '../core/i18n';
import { priceHistoryOptInOffered, type TyrianSettings } from '../core/settings';
import type { PriceHistoryRuntime as PriceHistoryService, PriceHistoryRuntimeState } from '../economy/price-history-runtime';
import type { PriceHistorySide, PriceHistoryWindowDays } from '../economy/price-history-model';
import type { PriceHistoryPanelSeedService, PriceHistoryPanelSeedState } from '../economy/price-seed-panel-service';
import { HALLOWEEN_TOT_BAG_ITEM_ID } from '../economy/session-valuation';
import type { TyrianCodeBlockContext, TyrianHost } from '../host/tyrian-host';
import type { LiveSessionEconomy } from '../sessions/live-session-economy';
import type { LiveSessionLifecycle } from '../sessions/live-session-lifecycle';
import { paintPriceHistoryNoteBlock } from '../ui/price-history-note-block-controller';
import { safePublicRenderIconUrl } from '../ui/price-history-panel-view';
import { projectBagPriceIngameState } from './farming-runtime-projection';

function disabledPriceHistoryState(): PriceHistoryRuntimeState {
	return {
		status: 'disabled', watchItemIds: [], selectedItemId: null, selectedSide: 'ask', windowDays: 42,
		daily: [], lastSampleAtMs: null, nextCaptureAtMs: null, provisionalDayUtc: null,
	};
}

/** `ctx.frontmatter` is `any`; this is the one place that reads `tc_item_name` out of it safely. */
function frontmatterTcItemName(frontmatter: unknown): string | null {
	if (typeof frontmatter !== 'object' || frontmatter === null) return null;
	const value = (frontmatter as Record<string, unknown>).tc_item_name;
	return typeof value === 'string' ? value : null;
}

/**
 * Everything `PriceHistoryRuntime` reads from the core and asks of it. Each member carries the name
 * of the core's own field, read live: the services are built in `initializeRuntime`, after the port,
 * and the settings are replaced on every update. The catalog is a setter too, because the first
 * reader opens it and every later one (the loot panel, the summary) shares it.
 */
export interface PriceHistoryRuntimePort {
	readonly settings: TyrianSettings;
	/** False until `initializeRuntime` has built the services below. */
	readonly runtimeReady: boolean;
	readonly host: { readonly environment: Pick<TyrianHost['environment'], 'pluginVersion'> };
	readonly localDebugActions: LocalDebugActionRunner | null;
	readonly priceHistory: PriceHistoryService | null;
	readonly priceHistoryPanelSeed: Pick<PriceHistoryPanelSeedService, 'ensure' | 'getState'> | null;
	readonly sessionCatalogFactory: (() => Promise<PublicCatalogService>) | null;
	sessionCatalog: PublicCatalogService | null;
	readonly liveSessions: Pick<LiveSessionLifecycle, 'getView'> | null;
	readonly liveEconomy: Pick<LiveSessionEconomy, 'refreshBagQuote' | 'rawQuote'> | null;
	/** "The plugin is still starting", for a request that came before `runtimeReady`. */
	notifyRuntimeStarting(): void;
	/** Resolves once, the first time after the call that startup settles (ready or failed). */
	whenRuntimeReady(): Promise<void>;
	renderInventoryAdvisorViews(): void;
	updateSettings(settings: Partial<TyrianSettings>): Promise<unknown>;
}

export class PriceHistoryRuntime {
	/** @param port What this reads from the core and asks of it; nothing else reaches the core. */
	constructor(private readonly port: PriceHistoryRuntimePort) {}

	// The core's own fields, read through the port under the names the moved code uses.
	private get settings(): TyrianSettings { return this.port.settings; }
	private get runtimeReady(): boolean { return this.port.runtimeReady; }
	private get host(): PriceHistoryRuntimePort['host'] { return this.port.host; }
	private get localDebugActions(): LocalDebugActionRunner | null { return this.port.localDebugActions; }
	private get priceHistory(): PriceHistoryService | null { return this.port.priceHistory; }
	private get priceHistoryPanelSeed(): PriceHistoryRuntimePort['priceHistoryPanelSeed'] { return this.port.priceHistoryPanelSeed; }
	private get sessionCatalogFactory(): PriceHistoryRuntimePort['sessionCatalogFactory'] { return this.port.sessionCatalogFactory; }
	private get liveSessions(): PriceHistoryRuntimePort['liveSessions'] { return this.port.liveSessions; }
	private get liveEconomy(): PriceHistoryRuntimePort['liveEconomy'] { return this.port.liveEconomy; }
	private notifyRuntimeStarting(): void { this.port.notifyRuntimeStarting(); }
	private whenRuntimeReady(): Promise<void> { return this.port.whenRuntimeReady(); }
	private renderInventoryAdvisorViews(): void { this.port.renderInventoryAdvisorViews(); }
	private updateSettings(settings: Partial<TyrianSettings>): Promise<unknown> { return this.port.updateSettings(settings); }

	getPriceHistoryState(): PriceHistoryRuntimeState {
		return this.priceHistory?.getState() ?? disabledPriceHistoryState();
	}

	async enablePriceHistory(): Promise<void> {
		await this.updateSettings({ priceHistoryEnabled: true });
	}

	/** Whether the advisor shows the price-history opt-in offer. Reads settings only; starts no I/O. */
	isPriceHistoryOptInOffered(): boolean {
		return priceHistoryOptInOffered(this.settings, this.host.environment.pluginVersion);
	}

	/** «Ahora no» on that offer: records the installed version, so the next release offers it again. */
	async dismissPriceHistoryOptIn(): Promise<void> {
		await this.updateSettings({ priceHistoryNoticeDismissedVersion: this.host.environment.pluginVersion });
	}

	async loadPriceHistorySeries(itemId: number, side: PriceHistorySide, windowDays: PriceHistoryWindowDays): Promise<void> {
		if (!this.runtimeReady || this.priceHistory === null) { this.notifyRuntimeStarting(); return; }
		await this.priceHistory.loadSeries(itemId, side, windowDays);
		// `ensure` never throws: a datawars2 failure is a state on the seed service, not an
		// exception, so the local series above is never held hostage to a third party.
		await this.priceHistoryPanelSeed?.ensure(itemId);
		this.renderInventoryAdvisorViews();
	}

	/**
	 * The datawars2 seed of one item for the chart inside an Inventory row's «Detalles». Unlike
	 * `loadPriceHistorySeries` it never touches the price panel's selected item or its local series:
	 * the seed service takes any item id (the watch list only bounds the LOCAL captures), and it
	 * already carries the 24 h cache and the shared interactive download turn. With the history off
	 * it does nothing at all, so opening a row cannot start a request the player has not consented to.
	 */
	async ensurePriceHistorySeed(itemId: number): Promise<void> {
		if (!this.settings.priceHistoryEnabled || !this.runtimeReady || this.priceHistoryPanelSeed === null) return;
		await this.priceHistoryPanelSeed.ensure(itemId);
		this.renderInventoryAdvisorViews();
	}

	/** Last known datawars2 seed for one item; a stale read, it never starts a download itself. */
	getPriceHistorySeedState(itemId: number): PriceHistoryPanelSeedState {
		return this.priceHistoryPanelSeed?.getState(itemId)
			?? { status: 'idle', itemId, days: [], failureReason: null, retrievedAt: null };
	}

	/**
	 * H9.2 piloto: the `tyrian-price-history` code-block handler Obsidian invokes for every
	 * rendered note that carries one, never at load. Shares the exact same 24h-cached seed
	 * service as the settings panel (`priceHistoryPanelSeed`): a note and the panel showing
	 * the same item inside that window never cost a second request.
	 */
	async paintPriceHistoryNoteBlockView(
		source: string,
		el: HTMLElement,
		ctx: TyrianCodeBlockContext,
	): Promise<void> {
		const frontmatterItemName = frontmatterTcItemName(ctx.frontmatter);
		await paintPriceHistoryNoteBlock(el, source, {
			translator: createTranslator(this.settings.language),
			ready: () => this.runtimeReady && this.priceHistoryPanelSeed !== null,
			getState: (itemId) => this.getPriceHistorySeedState(itemId),
			ensure: async (itemId) => await this.priceHistoryPanelSeed?.ensure(itemId)
				?? this.getPriceHistorySeedState(itemId),
			itemName: () => frontmatterItemName,
			// A note can render this block before `initializeRuntime` finishes (H18 bug, 28 sep):
			// nothing else ever repaints a code block on its own, so without this the block was
			// stuck on "loading" forever. Retried exactly once, the moment startup settles.
			whenReady: () => this.whenRuntimeReady(),
		});
	}

	/**
	 * Public catalog name + icon for the price-history watch list.
	 *
	 * Reuses the same lazily-opened, IndexedDB-cached catalog service the session
	 * loot panel uses: names and icons ride the one existing 7-day cache instead of
	 * a bespoke one, and a second panel opening inside that window never repeats
	 * the network request.
	 */
	async resolvePriceHistoryItemCatalog(itemIds: number[]): Promise<Record<number, { name: string; icon: string | null }>> {
		if (itemIds.length === 0 || this.sessionCatalogFactory === null) return {};
		const span = startLocalDebugAction(this.localDebugActions ?? undefined, {
			component: 'price_history', action: 'price_history_load_series', state: 'price_history_catalog',
		});
		try {
			const items = await (await openSessionCatalog(this.port)).resolveItems(itemIds, this.settings.language);
			const resolved: Record<number, { name: string; icon: string | null }> = {};
			for (const [key, item] of Object.entries(items)) {
				const itemId = Number(key);
				if (!Number.isSafeInteger(itemId)) continue;
				resolved[itemId] = { name: item.name, icon: safePublicRenderIconUrl(item.icon) };
			}
			span.success('resolved', { itemCount: itemIds.length });
			return resolved;
		} catch (error) {
			span.failure(error, 'network_failure', 'price_history_catalog_unavailable');
			return {};
		}
	}

	/** Public gross price of the Halloween bag for `price2`. The bridge calls it only for a subscribed connection, which is what keeps the quote refreshed. */
	getBagPriceIngameState(): PriceIngameState {
		this.liveEconomy?.refreshBagQuote();
		return projectBagPriceIngameState({ phase: this.liveSessions?.getView().phase ?? 'idle',
			quote: this.liveEconomy?.rawQuote(HALLOWEEN_TOT_BAG_ITEM_ID) ?? null, now: Date.now() });
	}
}
