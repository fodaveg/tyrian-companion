import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpTransportError } from '../core/http';
import { nextExpiryMs, SALE_REFRESH_DEADLINE_MS, SALE_VIEW_TYPE, SaleItemView, saleView, type SaleViewActions } from './sale-item-view';
import { ProductActionController } from './product-action-controller';
import { buildSaleViewModel, type SaleSourceRow, type SaleViewModel, type SaleViewModelInput } from './sale-view-model';

/** The host's `setIcon`, recording the Lucide id on the element as the Obsidian test double does. */
const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };

/** The content element the host mounts a view into (an `ItemView`'s `contentEl` in Obsidian). */
function content(): HTMLElement { return new FakeElement('div', activeDocument) as unknown as HTMLElement; }

let activeDocument: FakeDocument;

beforeEach(() => { activeDocument = new FakeDocument(); });
afterEach(() => vi.unstubAllGlobals());

const NOW_MS = Date.UTC(2026, 8, 26, 7, 38, 0);

function row(overrides: Partial<SaleSourceRow> & Pick<SaleSourceRow, 'itemId' | 'name'>): SaleSourceRow {
	return {
		id: `#/row/${String(overrides.itemId)}`, icon: null, ownedQuantity: 1, slotsUsed: 1,
		materialStorageEligible: false, decision: null, bidCopper: null, instantSellNetCopper: null, listingNetCopper: null,
		...overrides,
	};
}

function baseInput(overrides: Partial<SaleViewModelInput> = {}): SaleViewModelInput {
	return {
		status: 'ready', nowMs: NOW_MS, festivalStartMs: Date.UTC(2026, 9, 13), maxPriceAgeMs: 900_000,
		hero: null, rows: [], calendar: [],
		...overrides,
	};
}

/** Lets the refresh's promise chain (the shared in-flight call, then the view's own end) settle. */
async function flush(): Promise<void> { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }

function actions(model: () => SaleViewModel, extra: Partial<SaleViewActions> = {}): SaleViewActions {
	return { getSaleLocale: () => 'es', getSaleViewModel: model, ...extra };
}

describe('SaleItemView wiring', () => {
	it('registers with SALE_VIEW_TYPE and renders the model on open', async () => {
		installDom();
		const model = buildSaleViewModel(baseInput({
			rows: [row({
				itemId: 48805, name: 'Colmillos de plástico de alta calidad',
				decision: { action: 'sell', reason: 'seasonal_sell_window', until: null, priceQuotedAt: null, sellWindowFromDay: '2026-09-22', sellWindowToDay: '2026-10-19' },
			})],
		}));
		const registration = saleView(actions(() => model));
		expect([registration.type, registration.title(), registration.icon, registration.placement])
			.toEqual([SALE_VIEW_TYPE, 'Venta de Halloween', 'candy', 'dialog']);
		const view = new SaleItemView(content(), icons, actions(() => model));
		await view.onOpen();
		expect(text(view.contentEl as unknown as FakeElement)).toContain('Colmillos de plástico de alta calidad');
		expect(text(view.contentEl as unknown as FakeElement)).toContain('Vender ahora');
	});

	it('reaches an actual rendered row, not just the pure model, with the low-space override', async () => {
		installDom();
		const model = buildSaleViewModel(baseInput({
			storageSpace: {
				bags: { free: 5, total: 160 }, bank: { free: 4, total: 210 }, sharedInventory: { free: 0, total: 6 },
				lowSpace: { freeSlots: 5, totalSlots: 160, thresholdFreeSlots: 20, isLow: true },
				materialCapacity: null, bagCharacter: { character: 'Beta', source: 'addon' },
			},
			rows: [row({
				itemId: 43320, name: 'Jorcamelo', slotsUsed: 1, bagSlotsUsed: 1,
				decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
			})],
		}));
		const view = new SaleItemView(content(), icons, actions(() => model));
		await view.onOpen();
		const root = view.contentEl as unknown as FakeElement;
		const jorcamelo = find(root, 'li').find((li) => li.attributes.get('data-item') === '43320')!;
		expect(text(jorcamelo)).toContain('Vender ahora');
		expect(text(jorcamelo)).toContain('Libera 1 hueco en las bolsas de Beta');
	});

	it('mounts the product shell active on "sale" and navigates through the same controller as the other tabs', async () => {
		installDom();
		const execute = vi.fn(async () => 'completed' as const);
		const controller = productController(execute);
		const model = buildSaleViewModel(baseInput({}));
		const view = new SaleItemView(content(), icons, actions(() => model, {
			getProductActionController: () => controller, hasConfiguredApiKey: () => true, openProductSettings: () => undefined,
		}));
		await view.onOpen();
		const root = view.contentEl as unknown as FakeElement;
		const nav = find(root, 'nav').find((el) => el.className.includes('tyrian-product-shell__nav'))!;
		const tabs = find(nav, 'button');
		const saleTab = tabs.find((tab) => tab.attributes.get('aria-current') === 'page')!;
		expect(saleTab.textContent).toBe('Venta');
		const companionTab = tabs.find((tab) => tab.textContent === 'Sesión')!;
		companionTab.dispatch('click');
		expect(execute).toHaveBeenCalledWith('open-companion');
	});

	it('runs a refresh through the footer button and re-renders while busy', async () => {
		installDom();
		let refreshed = 0;
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		const model = buildSaleViewModel(baseInput({}));
		const view = new SaleItemView(content(), icons, actions(() => model, {
			refreshSale: async (options) => { expect(options?.refreshSeeds).toBe(true); refreshed += 1; await pending; },
		}));
		await view.onOpen();
		const root = view.contentEl as unknown as FakeElement;
		const button = find(root, 'button').find((el) => text(el).includes('Actualizar'))!;
		button.dispatch('click');
		expect(refreshed).toBe(1);
		finish();
		await flush();
		await flush();
	});

	/**
	 * H18.38 (David, 0.2.3 via BRAT): opening Venta with the advisor unanalyzed this session left
	 * "Leyendo precios del bazar…" on screen forever — `getSaleViewModel` reports `loading`
	 * (`buildInventoryAdvisorViewModel(null)`) and `onOpen` never asked for the same refresh the
	 * footer button already offers. Fails before the `onOpen` auto-trigger: `refreshCalls` stays 0.
	 */
	it('auto-triggers the same refresh once when opened with the advisor unanalyzed, and stops saying Leyendo once it resolves', async () => {
		installDom();
		let refreshCalls = 0;
		let resolveRefresh!: () => void;
		const pending = new Promise<void>((resolve) => { resolveRefresh = resolve; });
		let status: 'loading' | 'ready' = 'loading';
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status })), {
			refreshSale: async (options) => {
				expect(options?.refreshSeeds).toBe(false);
				refreshCalls += 1;
				await pending;
				status = 'ready';
			},
		}));
		await view.onOpen();
		expect(refreshCalls).toBe(1);
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root)).toContain('Leyendo precios del bazar');
		resolveRefresh();
		await flush();
		await flush();
		await flush();
		expect(text(root)).not.toContain('Leyendo precios del bazar');
	});

	it('does not trigger a second refresh while the auto-triggered one is still in flight', async () => {
		installDom();
		let refreshCalls = 0;
		let resolveRefresh!: () => void;
		const pending = new Promise<void>((resolve) => { resolveRefresh = resolve; });
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { refreshCalls += 1; await pending; },
		}));
		await view.onOpen();
		view.render();
		view.render();
		expect(refreshCalls).toBe(1);
		resolveRefresh();
		await flush();
		await flush();
	});

	it('when the runtime is not ready yet and the refresh leaves the model in loading, ends in a final message with a working Actualizar button', async () => {
		installDom();
		let refreshCalls = 0;
		// Mirrors `main.ts`'s `refreshInventoryAdvisor`: `if (!this.runtimeReady) { notify; return; }`
		// resolves without ever changing the cached model away from `loading`.
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { refreshCalls += 1; },
		}));
		await view.onOpen();
		await flush();
		await flush();
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root)).not.toContain('Leyendo precios del bazar');
		expect(text(root)).toContain('No se pudieron leer los precios del bazar');
		expect(find(root, 'p').some((p) => p.attributes.get('role') === 'alert')).toBe(true);
		expect(find(root, 'span').some((el) => el.className.includes('tyrian-sale__spinner'))).toBe(false);
		const button = find(root, 'button').find((el) => text(el).includes('Actualizar'))!;
		expect(button.disabled).toBe(false);
		button.dispatch('click');
		expect(refreshCalls).toBe(2);
	});

	/** Loading with a refresh in flight: one text, a spinner span, `aria-busy` on the region. */
	it('while the refresh runs, says "Leyendo" once, shows the spinner and marks the region busy', async () => {
		installDom();
		let resolveRefresh!: () => void;
		const pending = new Promise<void>((resolve) => { resolveRefresh = resolve; });
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { await pending; },
		}));
		await view.onOpen();
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root).split('Leyendo precios del bazar').length - 1).toBe(1);
		expect(find(root, 'span').filter((el) => el.className.includes('tyrian-sale__spinner'))).toHaveLength(1);
		expect(find(root, 'div').some((el) => el.className.includes('tyrian-sale') && el.attributes.get('aria-busy') === 'true')).toBe(true);
		expect(find(root, 'p').filter((p) => p.attributes.get('role') === 'status')).toHaveLength(1);
		expect(find(root, 'button').find((el) => text(el).includes('Actualizar'))!.disabled).toBe(true);
		resolveRefresh();
		await flush();
	});

	it('a refresh that throws ends in the failure message with a retry, not in an eternal Leyendo', async () => {
		installDom();
		let calls = 0;
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { calls += 1; throw new Error('network down'); },
		}));
		await view.onOpen();
		await flush();
		await flush();
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root)).toContain('No se pudieron leer los precios del bazar');
		expect(text(root)).not.toContain('Leyendo precios del bazar');
		find(root, 'button').find((el) => text(el).includes('Actualizar'))!.dispatch('click');
		expect(calls).toBe(2);
	});

	it('a refresh that never answers ends at the deadline in the timed-out message, and the retry runs', async () => {
		installDom();
		vi.useFakeTimers();
		try {
			let calls = 0;
			const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
				refreshSale: () => { calls += 1; return new Promise<void>(() => undefined); },
			}));
			await view.onOpen();
			const root = view.contentEl as unknown as FakeElement;
			expect(text(root)).toContain('Leyendo precios del bazar');
			vi.advanceTimersByTime(SALE_REFRESH_DEADLINE_MS - 1);
			expect(text(root)).toContain('Leyendo precios del bazar');
			vi.advanceTimersByTime(1);
			expect(text(root)).toContain('tardan demasiado');
			expect(text(root)).not.toContain('Leyendo precios del bazar');
			const button = find(root, 'button').find((el) => text(el).includes('Actualizar'))!;
			expect(button.disabled).toBe(false);
			button.dispatch('click');
			// The first call is still in flight: the retry waits for it, it does not start a second one.
			expect(calls).toBe(1);
			expect(text(root)).toContain('Leyendo precios del bazar');
			vi.advanceTimersByTime(SALE_REFRESH_DEADLINE_MS);
			expect(text(root)).toContain('tardan demasiado');
			await view.onClose();
		} finally { vi.useRealTimers(); }
	});

	it('when the analysis cannot run (missing key), shows the blocked reason instead of Leyendo', async () => {
		installDom();
		let status: 'loading' | 'blocked' = 'loading';
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({
			status, ...(status === 'blocked' ? { blockedReason: 'credential_unavailable' } : {}),
		})), {
			refreshSale: async () => { status = 'blocked'; },
		}));
		await view.onOpen();
		await flush();
		await flush();
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root)).not.toContain('Leyendo precios del bazar');
	});

	it('registers a failed refresh in the diagnostics (component ui, error, failure) and keeps the cause out of the view', async () => {
		installDom();
		const event = vi.fn();
		const boom = new Error('boom');
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { throw boom; },
			getSaleDiagnostics: () => ({ event, createContext: vi.fn() }),
		}));
		await view.onOpen();
		await flush();
		expect(event).toHaveBeenCalledTimes(1);
		expect(event).toHaveBeenCalledWith({
			component: 'ui', action: 'view_render', level: 'error', phase: 'failure', code: 'unknown_failure', state: 'sale_refresh', message: boom,
		});
	});

	it('tells a transport timeout from a generic failure in the diagnostics code', async () => {
		installDom();
		const event = vi.fn();
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { throw new HttpTransportError('timeout', null, null, 'Request timed out.'); },
			classifySaleRefreshFailure: (error) => (error instanceof HttpTransportError && error.kind === 'timeout' ? 'timeout' : 'unknown_failure'),
			getSaleDiagnostics: () => ({ event, createContext: vi.fn() }),
		}));
		await view.onOpen();
		await flush();
		expect(event.mock.calls[0]![0]).toMatchObject({ code: 'timeout', level: 'error' });
	});

	it('an old "unfinished" outcome does not leak into a later loading: data in between clears it', async () => {
		installDom();
		let status: 'loading' | 'ready' = 'loading';
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status })), {
			refreshSale: async () => undefined,
		}));
		await view.onOpen();
		await flush();
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root)).toContain('No se pudieron leer');
		status = 'ready';
		view.render();
		status = 'loading';
		view.render();
		expect(text(root)).toContain('Leyendo precios del bazar');
		expect(text(root)).not.toContain('No se pudieron leer');
		expect(find(root, 'span').some((el) => el.className.includes('tyrian-sale__spinner'))).toBe(true);
	});

	it('reopening the same instance after a refresh that never ended leaves the button usable', async () => {
		installDom();
		const view = new SaleItemView(content(), icons, actions(() => buildSaleViewModel(baseInput({ status: 'ready' })), {
			refreshSale: () => new Promise<void>(() => undefined),
		}));
		await view.onOpen();
		const root = view.contentEl as unknown as FakeElement;
		find(root, 'button').find((el) => text(el).includes('Actualizar'))!.dispatch('click');
		expect(find(root, 'button').find((el) => text(el).includes('Actualizar'))!.disabled).toBe(true);
		await view.onClose();
		await view.onOpen();
		expect(find(root, 'button').find((el) => text(el).includes('Actualizar'))!.disabled).toBe(false);
	});

});

/**
 * Z-venta-10: a tab left open kept saying "reciente" after the verdict's `until`, because nothing
 * repainted a model built once with `Date.now()`.
 */
describe('SaleItemView repaints when a figure on screen expires', () => {
	const UNTIL_MS = NOW_MS + 5 * 60_000;
	const quoteStates = (view: SaleItemView): string[] => find(view.contentEl as unknown as FakeElement, 'p')
		.filter((p) => p.className.includes('tyrian-sale__quote')).map((p) => p.attributes.get('data-state') ?? '');
	const liveModel = (): SaleViewModel => buildSaleViewModel(baseInput({
		nowMs: Date.now(),
		rows: [row({
			itemId: 48805, name: 'Colmillos',
			decision: {
				action: 'sell', reason: 'seasonal_sell_window', until: new Date(UNTIL_MS).toISOString(),
				priceQuotedAt: new Date(NOW_MS).toISOString(), sellWindowFromDay: '2026-09-22', sellWindowToDay: '2026-10-19',
			},
		})],
	}));

	beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW_MS); });
	afterEach(() => { vi.useRealTimers(); });

	it('repaints as stale once the verdict\'s until has passed', async () => {
		installDom();
		const view = new SaleItemView(content(), icons, actions(liveModel));
		await view.onOpen();
		expect(quoteStates(view)).toEqual(['fresh']);

		await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);

		expect(quoteStates(view), 'still says recent after the until').toEqual(['stale']);
	});

	it('does not repaint on its own while the window is hidden, and repaints when it becomes visible', async () => {
		installDom();
		const view = new SaleItemView(content(), icons, actions(liveModel));
		await view.onOpen();
		(view.contentEl as unknown as FakeElement).doc.setHidden(true);
		expect(vi.getTimerCount()).toBe(0);

		vi.setSystemTime(UNTIL_MS + 60_000);
		(view.contentEl as unknown as FakeElement).doc.setHidden(false);

		expect(quoteStates(view)).toEqual(['stale']);
	});

	it('cancels its timer and its listener when the view closes', async () => {
		installDom();
		const view = new SaleItemView(content(), icons, actions(liveModel));
		await view.onOpen();
		const doc = (view.contentEl as unknown as FakeElement).doc;
		expect(vi.getTimerCount()).toBe(1);
		expect(doc.listenerCount('visibilitychange')).toBe(1);

		await view.onClose();

		expect(vi.getTimerCount()).toBe(0);
		expect(doc.listenerCount('visibilitychange')).toBe(0);
	});

	it('arms nothing for a model with no verdict deadline, and never re-arms for an instant already past', async () => {
		installDom();
		const stale = buildSaleViewModel(baseInput({ nowMs: NOW_MS }));
		const view = new SaleItemView(content(), icons, actions(() => stale));
		await view.onOpen();
		expect(vi.getTimerCount()).toBe(0);
		expect(nextExpiryMs(liveModel(), UNTIL_MS)).toBe(NOW_MS + 900_000);
		expect(nextExpiryMs(liveModel(), NOW_MS + 900_000)).toBeNull();
	});

	describe('as a section the host hides without unmounting it', () => {
		/** A model that counts how many times a paint read it. */
		const counted = () => {
			const reads = { count: 0 };
			return { reads, model: (): SaleViewModel => { reads.count += 1; return liveModel(); } };
		};

		it('drops its timer while hidden, paints nothing however often it is asked, and repaints once when shown', async () => {
			installDom();
			const { reads, model } = counted();
			const view = new SaleItemView(content(), icons, actions(model));
			await view.onOpen();
			expect(vi.getTimerCount()).toBe(1);
			const paintsWhileVisible = reads.count;

			view.setVisible(false);
			expect(vi.getTimerCount()).toBe(0);
			// What the core does while it is hidden: every refresh of the advisor repaints the Sale tab.
			view.render();
			view.render();
			view.render();
			vi.setSystemTime(UNTIL_MS + 60_000);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(reads.count, 'painted while hidden').toBe(paintsWhileVisible);
			expect(quoteStates(view), 'the figure on screen is the one from before').toEqual(['fresh']);
			expect(vi.getTimerCount()).toBe(0);

			view.setVisible(true);
			expect(reads.count, 'one repaint on being shown').toBe(paintsWhileVisible + 1);
			expect(quoteStates(view)).toEqual(['stale']);
			// Shown twice in a row is shown once.
			view.setVisible(true);
			expect(reads.count).toBe(paintsWhileVisible + 1);
		});

		it('arms the timer again when shown, and never while the window itself is hidden', async () => {
			installDom();
			const view = new SaleItemView(content(), icons, actions(liveModel));
			await view.onOpen();
			const doc = (view.contentEl as unknown as FakeElement).doc;

			view.setVisible(false);
			view.setVisible(true);
			expect(vi.getTimerCount()).toBe(1);

			// The window comes back while the section is still hidden: nothing to repaint, nothing armed.
			view.setVisible(false);
			doc.setHidden(true);
			doc.setHidden(false);
			expect(vi.getTimerCount()).toBe(0);
			// And the section shown while the window is hidden paints, but arms nothing.
			doc.setHidden(true);
			view.setVisible(true);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('arms no timer for a hidden section at the arming point itself, where it would for one on screen', async () => {
			installDom();
			const view = new SaleItemView(content(), icons, actions(liveModel));
			await view.onOpen();
			const arm = (): void => { (view as unknown as { scheduleExpiryRepaint(model: SaleViewModel): void }).scheduleExpiryRepaint(liveModel()); };

			view.setVisible(false);
			// The same place that looks at the hidden window looks at the hidden section.
			arm();
			expect(vi.getTimerCount()).toBe(0);

			(view as unknown as { sectionHidden: boolean }).sectionHidden = false;
			arm();
			expect(vi.getTimerCount()).toBe(1);
		});

		it('repaints once when shown even if nothing asked for it: a figure may have expired meanwhile', async () => {
			installDom();
			const { reads, model } = counted();
			const view = new SaleItemView(content(), icons, actions(model));
			await view.onOpen();
			const before = reads.count;

			view.setVisible(false);
			view.setVisible(true);

			expect(reads.count).toBe(before + 1);
		});

		it('a refresh that ends while hidden leaves the busy state painted for the next time it is shown', async () => {
			installDom();
			let finish!: () => void;
			const pending = new Promise<void>((resolve) => { finish = resolve; });
			const { reads, model } = counted();
			const view = new SaleItemView(content(), icons, actions(model, { refreshSale: async () => { await pending; } }));
			await view.onOpen();
			const root = view.contentEl as unknown as FakeElement;
			find(root, 'button').find((el) => text(el).includes('Actualizar'))!.dispatch('click');
			const busyPaints = reads.count;

			view.setVisible(false);
			finish();
			await vi.advanceTimersByTimeAsync(0);
			expect(reads.count, 'the end of the refresh painted a hidden section').toBe(busyPaints);

			view.setVisible(true);
			expect(reads.count).toBe(busyPaints + 1);
		});
	});
});

describe('SaleItemView where the host lists the sections itself', () => {
	const shellOf = (view: SaleItemView): { shell: FakeElement | undefined; nav: FakeElement | undefined } => {
		const root = view.contentEl as unknown as FakeElement;
		return {
			shell: walk(root).find((el) => el.className.split(' ').includes('tyrian-product-shell')),
			nav: find(root, 'nav').find((el) => el.className.includes('tyrian-product-shell__nav')),
		};
	};
	const withShell = (extra: Partial<SaleViewActions> = {}): SaleViewActions => actions(() => buildSaleViewModel(baseInput({})), {
		getProductActionController: () => productController(async () => 'completed'), hasConfiguredApiKey: () => true,
		openProductSettings: () => undefined, ...extra,
	});

	it('builds no tabs on the host\'s main screen, and keeps the shell around the content and the settings button at the end of its row', async () => {
		installDom();
		const openProductSettings = vi.fn();
		const view = new SaleItemView(content(), icons, withShell({ hostListsSections: () => true, openProductSettings }));
		await view.onOpen();

		const { shell, nav } = shellOf(view);
		expect(shell).toBeDefined();
		// No navigation at all: not an empty `<nav>`, and none of the three tabs anywhere.
		expect(nav).toBeUndefined();
		expect(find(view.contentEl as unknown as FakeElement, 'nav')).toEqual([]);
		expect(find(view.contentEl as unknown as FakeElement, 'button').map((el) => el.textContent))
			.not.toEqual(expect.arrayContaining(['Sesión', 'Inventario', 'Venta']));
		// The settings button is the only thing in its row, before the content, and it opens Settings.
		const tools = shell!.children[0]!;
		expect(tools.className).toBe('tyrian-product-shell__tools');
		expect(tools.children.map((el) => [el.tag, el.className, el.attributes.get('aria-label'), el.attributes.get('data-icon')]))
			.toEqual([['button', 'clickable-icon tyrian-product-shell__settings', 'Ajustes de Tyrian Companion', 'settings']]);
		tools.children[0]!.dispatch('click');
		expect(openProductSettings).toHaveBeenCalledOnce();
	});

	it('keeps the bar as a view of its own, and where the core says nothing about it', async () => {
		installDom();
		for (const extra of [{ hostListsSections: () => false }, {}]) {
			const view = new SaleItemView(content(), icons, withShell(extra));
			await view.onOpen();
			const { nav } = shellOf(view);
			const buttons = find(nav!, 'button');
			expect(buttons.filter((el) => !el.className.includes('tyrian-product-shell__settings')).map((el) => el.textContent))
				.toEqual(['Sesión', 'Inventario', 'Venta', 'Logros']);
			expect(buttons.filter((el) => el.className.includes('tyrian-product-shell__settings'))).toHaveLength(1);
		}
	});

	it('keeps the missing-key warning, with its way to Settings, where there is no bar', async () => {
		installDom();
		const openProductSettings = vi.fn();
		const view = new SaleItemView(content(), icons, withShell({ hostListsSections: () => true, hasConfiguredApiKey: () => false, openProductSettings }));
		await view.onOpen();

		const warning = walk(view.contentEl as unknown as FakeElement).find((el) => el.className.includes('tyrian-product-shell__attention'))!;
		find(warning, 'button')[0]!.dispatch('click');
		expect(openProductSettings).toHaveBeenCalledOnce();
	});
});

function installDom(): void {
	vi.stubGlobal('createEl', (tag: string, options?: FakeOptions) => new FakeElement(tag, activeDocument, options));
	vi.stubGlobal('createDiv', (options?: FakeOptions) => new FakeElement('div', activeDocument, options));
	vi.stubGlobal('createSpan', (options?: FakeOptions) => new FakeElement('span', activeDocument, options));
}

function find(root: FakeElement, tag: string): FakeElement[] {
	return walk(root).filter((element) => element.tag === tag);
}

function walk(root: FakeElement): FakeElement[] {
	return [root, ...root.children.flatMap(walk)];
}

function text(root: FakeElement): string {
	return walk(root).map((element) => element.textContent ?? '').join('\n');
}

function productController(execute: () => Promise<'completed'>): ProductActionController {
	return new ProductActionController({
		getLocale: () => 'es', isRuntimeReady: () => true, hasApiKey: () => true,
		getConnectionState: () => ({ status: 'connected', details: {} } as never),
		getPendingProposals: () => ({ status: 'ready', pendingCount: 0, next: null }),
		getDetectionState: () => ({ status: 'disarmed', reason: 'initial', scheduler: {}, lastSnapshotAt: null } as never),
		canArmDetection: () => true, canApplyInventory: () => false, canApplyWallet: () => false,
		isInventoryBusy: () => false,
		sessionCommands: {
			describe: (id) => ({ id, name: id, available: true, icon: 'test', destructive: false, targetKey: 'test' }),
			runWithOutcome: async () => 'completed',
		},
		execute,
	});
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	hidden = false;
	private readonly listeners = new Map<string, Set<() => void>>();
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
	}
	removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
	listenerCount(type: string): number { return this.listeners.get(type)?.size ?? 0; }
	/** The browser's `visibilitychange`, after flipping `hidden`. */
	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		for (const listener of [...(this.listeners.get('visibilitychange') ?? [])]) listener();
	}
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}

interface FakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = '';
	textContent: string | null = null;
	disabled = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? null;
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}
	empty(): void { this.children.splice(0); this.textContent = null; }
	append(...children: FakeElement[]): void { this.children.push(...children); }
	createEl(tag: string, options?: FakeOptions): FakeElement { const child = new FakeElement(tag, this.ownerDocument, options); this.children.push(child); return child; }
	createDiv(options?: FakeOptions): FakeElement { const child = new FakeElement('div', this.ownerDocument, options); this.children.push(child); return child; }
	createSpan(options?: FakeOptions): FakeElement { const child = new FakeElement('span', this.ownerDocument, options); this.children.push(child); return child; }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	/** Obsidian's `contentEl.doc` / `contentEl.win`; the timers are the global ones, so fake timers drive them. */
	get doc(): FakeDocument { return this.ownerDocument; }
	readonly win = {
		setTimeout: (callback: () => void, milliseconds: number): number => globalThis.setTimeout(callback, milliseconds) as unknown as number,
		clearTimeout: (handle: number): void => { globalThis.clearTimeout(handle); },
	};
}
