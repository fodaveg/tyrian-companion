import type { TyrianUiPort } from '../host/tyrian-host';
import { createTranslator, type Locale } from '../core/i18n';
import type { LocalDebugActionPort } from '../core/local-debug-action-runner';
import { sectionViewDescriptor, type TyrianSectionDescriptor, type TyrianSectionViewSlot, type TyrianViewDescriptor } from './mounted-views';
import type { ProductActionController } from './product-action-controller';
import { renderProductShell, type ProductShellMount } from './product-shell';
import { renderSaleView, type SaleRefreshOutcome } from './sale-view';
import type { SaleViewModel } from './sale-view-model';

export const SALE_VIEW_TYPE = 'tyrian-sale-view';

export interface SaleViewActions {
	getSaleLocale(): Locale;
	/** A synchronous read boundary, like `InventoryAdvisorViewActions`: opening the view starts no I/O. */
	getSaleViewModel(): SaleViewModel;
	/** The same one-click refresh the Inventory tab already exposes (`refreshInventoryAdvisor`). */
	refreshSale?(options?: { refreshSeeds: boolean }): Promise<void>;
	getProductActionController?(): ProductActionController;
	/** Where a refresh failure is registered; absent in isolated harnesses (fail-open, like the action controller's). */
	getSaleDiagnostics?(): LocalDebugActionPort | undefined;
	/** Names a refresh failure for the diagnostics; the host knows the transport, the view does not. Absent: `unknown_failure`. */
	classifySaleRefreshFailure?(error: unknown): SaleRefreshFailureCode;
	hasConfiguredApiKey?(): boolean;
	openProductSettings?(): void;
	/** True while the host itself lists the sections (its main screen), so the shell builds no bar of tabs. Absent means false. */
	hostListsSections?(): boolean;
}

/** The closed set of codes a failed Venta refresh is registered under. */
export type SaleRefreshFailureCode = 'timeout' | 'network_failure' | 'unknown_failure';

/** The Sale section, wherever a host shows it. */
export function saleSection(actions: Pick<SaleViewActions, 'getSaleLocale'>): TyrianSectionDescriptor {
	return {
		id: 'sale',
		title: () => createTranslator(actions.getSaleLocale()).t('sale.view.title'),
		label: () => createTranslator(actions.getSaleLocale()).t('shell.nav.sale'),
		icon: 'candy',
	};
}

/** Where the Sale section is a view of its own: in Hebra, the 960×720 dialog (agreed with Hebra, R1c). */
export const SALE_VIEW_SLOT: TyrianSectionViewSlot = { type: SALE_VIEW_TYPE, placement: 'dialog' };

/** The Sale tab for `TyrianUiPort.registerView`: its section in its slot. */
export function saleView(actions: Pick<SaleViewActions, 'getSaleLocale'>): TyrianViewDescriptor {
	return sectionViewDescriptor(saleSection(actions), SALE_VIEW_SLOT);
}

/**
 * The Sale tab's controller, mounted by the host into `contentEl` (an `ItemView`'s content in
 * Obsidian). Opening and rendering only read the controller's memory snapshot.
 */
export class SaleItemView {
	private closed = false;
	private refreshing = false;
	/** How the last refresh ended while Venta was still `loading`; null once data arrives or a new one starts. */
	private refreshOutcome: SaleRefreshOutcome | null = null;
	/** Identifies the refresh whose end may still touch the view: a retry after the deadline supersedes the old one. */
	private refreshRun = 0;
	private refreshDeadlineTimer: number | null = null;
	/**
	 * The `refreshSale` call still running, shared by every wait on it. After the deadline the view
	 * stops waiting but the call goes on; a retry then waits for THAT call (with a new deadline)
	 * instead of starting a second, concurrent `refreshSale` over the same advisor and seed queue.
	 */
	private inFlight: Promise<boolean> | null = null;
	private productShell: ProductShellMount | null = null;
	private productShellKey: string | null = null;
	/** The pending repaint for the next instant a figure on screen stops being "recent". */
	private expiryTimer: number | null = null;
	private visibilityCleanup: (() => void) | null = null;
	/**
	 * True while the host keeps this section mounted but hidden (`setVisible`). A `render()` asked
	 * for meanwhile needs no mark of its own: being shown again always repaints, once.
	 */
	private sectionHidden = false;

	constructor(
		readonly contentEl: HTMLElement,
		private readonly ui: Pick<TyrianUiPort, 'setIcon'>,
		private readonly actions: SaleViewActions,
	) {}

	async onOpen(): Promise<void> {
		this.closed = false;
		this.sectionHidden = false;
		this.registerVisibilityRepaint();
		this.render();
		// H18.38 (David, 0.2.3): opening still only reads the memory snapshot, but a snapshot that
		// says "loading" because the advisor never analyzed this session needs the SAME one-click
		// refresh the header button already offers, fired once, not a silent wait for a click that
		// nothing on screen invites. `runRefresh` already no-ops while one is in flight or absent.
		if (this.actions.getSaleViewModel().status === 'loading') void this.runRefresh(false);
	}
	/**
	 * The host hid this section, or showed it again, WITHOUT unmounting it (a host that keeps its
	 * sections mounted; a view of its own is never told). Hidden, the expiry timer is dropped and a
	 * `render()` asked for meanwhile paints nothing. Shown again, it repaints once (and re-arms the
	 * timer) whether or not one was asked for: a figure may have stopped being "recent" while
	 * nobody looked, as on the return from a hidden window.
	 */
	setVisible(visible: boolean): void {
		if (visible === !this.sectionHidden) return;
		this.sectionHidden = !visible;
		if (!visible) { this.clearExpiryTimer(); return; }
		this.render();
	}

	/**
	 * Stops the view repainting by itself: drops the expiry timer and the visibility listener, and
	 * makes a late `render()` a no-op. The runtime calls it on unload because Hebra only unmounts a
	 * view when it chooses to, and a timer left behind would repaint (and read the core) after the
	 * plugin is gone. Idempotent; `onClose` does the same plus the shell disposal.
	 */
	cancelExpiryRepaint(): void {
		this.closed = true;
		this.clearExpiryTimer();
		this.clearRefreshDeadline();
		// Reopening the same instance must not inherit a refresh that never ended: its end is ignored
		// (the run number moved on) and the button is not left disabled for good.
		this.refreshing = false;
		this.refreshRun += 1;
		this.visibilityCleanup?.();
		this.visibilityCleanup = null;
	}

	async onClose(): Promise<void> {
		this.cancelExpiryRepaint();
		this.productShell?.dispose();
		this.productShell = null;
		this.productShellKey = null;
	}

	render(): void {
		if (this.closed) return;
		// Hidden: nothing is painted. Being shown again repaints (`setVisible`).
		if (this.sectionHidden) return;
		const model = this.actions.getSaleViewModel();
		// An outcome is about a `loading` that has ended: once there is data, a later `loading` starts clean.
		if (model.status !== 'loading') this.refreshOutcome = null;
		const locale = this.actions.getSaleLocale();
		const actionController = this.actions.getProductActionController?.();
		const missingApiKey = !(this.actions.hasConfiguredApiKey?.() ?? true);
		const navigation = !(this.actions.hostListsSections?.() ?? false);
		const shellKey = `${locale}:${String(missingApiKey)}:${String(navigation)}`;
		if (actionController !== undefined && (this.productShell === null || this.productShellKey !== shellKey)) {
			this.productShell?.dispose();
			this.productShell = renderProductShell(this.contentEl, {
				locale,
				active: 'sale',
				actions: actionController,
				missingApiKey,
				openSettings: () => this.actions.openProductSettings?.(),
				ui: this.ui,
				navigation,
			});
			this.productShellKey = shellKey;
		}
		const surface = this.productShell?.content ?? this.contentEl;
		this.productShell?.update();
		renderSaleView(surface, this.ui, model, createTranslator(locale), {
			refreshing: this.refreshing,
			refreshOutcome: model.status === 'loading' ? this.refreshOutcome : null,
			onRefresh: this.actions.refreshSale === undefined ? undefined : () => this.runRefresh(),
		});
		this.scheduleExpiryRepaint(model);
	}

	/**
	 * A tab left open kept saying "reciente" past the instant its price stopped being so: the model
	 * is a snapshot built with `Date.now()` and nothing repainted it. One timer, armed after each
	 * paint for the NEXT instant a figure on screen changes state, and dropped while the window is
	 * hidden (`registerVisibilityRepaint` repaints on return) and when the view closes.
	 */
	private scheduleExpiryRepaint(model: SaleViewModel): void {
		this.clearExpiryTimer();
		if (this.closed || this.contentEl.doc.hidden || this.sectionHidden) return;
		// After the real clock too: a model that was not rebuilt (nowMs in the past) must not re-arm for an instant already gone.
		const at = nextExpiryMs(model, Math.max(model.nowMs, Date.now()));
		if (at === null) return;
		// +1 ms: a figure is stale once `nowMs > until`, so repainting AT `until` would still say fresh.
		// Never a hot loop (1 s floor); capped below the 32-bit timer limit, the repaint re-arms itself.
		const delay = Math.min(MAX_TIMER_MS, Math.max(1_000, at - Date.now() + 1));
		this.expiryTimer = this.contentEl.win.setTimeout(() => {
			this.expiryTimer = null;
			this.render();
		}, delay);
	}

	private clearExpiryTimer(): void {
		if (this.expiryTimer === null) return;
		this.contentEl.win.clearTimeout(this.expiryTimer);
		this.expiryTimer = null;
	}

	/** Back from a hidden window the figures may have expired meanwhile: repaint at once (and re-arm). */
	private registerVisibilityRepaint(): void {
		if (this.visibilityCleanup !== null) return;
		const doc = this.contentEl.doc;
		const onVisibilityChange = (): void => {
			if (doc.hidden) { this.clearExpiryTimer(); return; }
			this.render();
		};
		doc.addEventListener('visibilitychange', onVisibilityChange);
		this.visibilityCleanup = () => { doc.removeEventListener('visibilitychange', onVisibilityChange); };
	}

	private async runRefresh(refreshSeeds = true): Promise<void> {
		if (this.closed || this.refreshing || this.actions.refreshSale === undefined) return;
		const run = ++this.refreshRun;
		this.refreshing = true;
		this.refreshOutcome = null;
		this.armRefreshDeadline(run);
		this.render();
		const failed = await (this.inFlight ?? this.startRefresh(refreshSeeds));
		// A refresh that passed its deadline already told the view; its late end must not undo a retry.
		if (run !== this.refreshRun) { this.render(); return; }
		this.clearRefreshDeadline();
		this.refreshing = false;
		// Whether it matters is `render()`'s call: the outcome only reaches the view while the model is `loading`.
		this.refreshOutcome = failed ? 'failed' : 'unfinished';
		this.render();
	}

	/** The one `refreshSale` call; resolves true when it threw, after registering the failure once. */
	private startRefresh(refreshSeeds: boolean): Promise<boolean> {
		const call = this.callRefreshSale(refreshSeeds).finally(() => { if (this.inFlight === call) this.inFlight = null; });
		this.inFlight = call;
		return call;
	}

	private async callRefreshSale(refreshSeeds: boolean): Promise<boolean> {
		try {
			await this.actions.refreshSale?.({ refreshSeeds });
			return false;
		} catch (error) {
			// Reported, not swallowed: the view shows a retry, the diagnostics keep the cause.
			this.actions.getSaleDiagnostics?.()?.event({
				component: 'ui', action: 'view_render', level: 'error', phase: 'failure',
				code: this.actions.classifySaleRefreshFailure?.(error) ?? 'unknown_failure', state: 'sale_refresh', message: error,
			});
			return true;
		}
	}

	/**
	 * The refresh's own network calls already have deadlines (`HttpTransport`: 10 s each, 30 s the
	 * character fan-out), but nothing bounds the whole of it. Past `SALE_REFRESH_DEADLINE_MS` the view
	 * stops waiting: "loading" becomes a timed-out message and the button works again. The refresh is
	 * not cancelled; if it ends well later, the data simply paints.
	 */
	private armRefreshDeadline(run: number): void {
		this.clearRefreshDeadline();
		this.refreshDeadlineTimer = this.contentEl.win.setTimeout(() => {
			this.refreshDeadlineTimer = null;
			if (this.closed || run !== this.refreshRun || !this.refreshing) return;
			this.refreshing = false;
			this.actions.getSaleDiagnostics?.()?.event({
				component: 'ui', action: 'view_render', level: 'warn', phase: 'failure',
				code: 'timeout', state: 'sale_refresh', message: new Error('Sale refresh passed its deadline.'),
			});
			this.refreshOutcome = 'timed_out';
			this.refreshRun += 1;
			this.render();
		}, SALE_REFRESH_DEADLINE_MS);
	}

	private clearRefreshDeadline(): void {
		if (this.refreshDeadlineTimer === null) return;
		this.contentEl.win.clearTimeout(this.refreshDeadlineTimer);
		this.refreshDeadlineTimer = null;
	}
}

/** How long Venta waits for a whole refresh before it says so and offers a retry. */
export const SALE_REFRESH_DEADLINE_MS = 60_000;

/** Largest delay a browser timer takes (a 32-bit signed count of milliseconds). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The next instant after `afterMs` (the model's own `nowMs` by default) when something it shows changes state: the end of
 * the price's validity (`capturedAtMs + maxPriceAgeMs`, the status line) or the `until` of a hero or
 * row verdict (the "recent" mark). Null when nothing on screen is going to expire.
 */
export function nextExpiryMs(model: SaleViewModel, afterMs: number = model.nowMs): number | null {
	const candidates: Array<number | null | undefined> = [
		model.capturedAtMs === null ? null : model.capturedAtMs + model.maxPriceAgeMs,
		model.hero?.quote.staleAtMs,
		...[...model.groups.now, ...model.groups.wait, ...model.groups.noData].map((row) => row.quote.staleAtMs),
	];
	let next: number | null = null;
	for (const at of candidates) {
		if (at === null || at === undefined || at <= afterMs) continue;
		if (next === null || at < next) next = at;
	}
	return next;
}
