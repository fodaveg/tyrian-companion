import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SALE_VIEW_TYPE, SaleItemView, type SaleViewActions } from './sale-item-view';
import { ProductActionController } from './product-action-controller';
import { buildSaleViewModel, type SaleSourceRow, type SaleViewModel, type SaleViewModelInput } from './sale-view-model';

vi.mock('obsidian', () => ({
	ItemView: class {
		readonly contentEl = new FakeElement('div', activeDocument);
		constructor(_leaf: unknown) {}
	},
	setIcon: (el: { setAttribute(name: string, value: string): void }, iconId: string) => { el.setAttribute('data-icon', iconId); },
}));

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
		const view = new SaleItemView({} as never, actions(() => model));
		expect(view.getViewType()).toBe(SALE_VIEW_TYPE);
		await view.onOpen();
		expect(text(view.contentEl as unknown as FakeElement)).toContain('Colmillos de plástico de alta calidad');
		expect(text(view.contentEl as unknown as FakeElement)).toContain('Vender ahora');
	});

	it('reaches an actual rendered row, not just the pure model, with the low-space override', async () => {
		installDom();
		const model = buildSaleViewModel(baseInput({
			storageSpace: {
				bags: { free: 5, total: 160 }, bank: { free: 4, total: 210 }, sharedInventory: { free: 0, total: 6 },
				lowSpace: { freeSlots: 9, totalSlots: 376, thresholdFreeSlots: 20, isLow: true },
				materialCapacity: null,
			},
			rows: [row({
				itemId: 43320, name: 'Jorcamelo', slotsUsed: 1,
				decision: { action: 'hold', reason: 'below_local_band', until: null, priceQuotedAt: null, sellWindowFromDay: null, sellWindowToDay: null },
			})],
		}));
		const view = new SaleItemView({} as never, actions(() => model));
		await view.onOpen();
		const root = view.contentEl as unknown as FakeElement;
		const jorcamelo = find(root, 'li').find((li) => li.attributes.get('data-item') === '43320')!;
		expect(text(jorcamelo)).toContain('Vender ahora');
		expect(text(jorcamelo)).toContain('Libera 1 hueco');
	});

	it('mounts the product shell active on "sale" and navigates through the same controller as the other tabs', async () => {
		installDom();
		const execute = vi.fn(async () => 'completed' as const);
		const controller = productController(execute);
		const model = buildSaleViewModel(baseInput({}));
		const view = new SaleItemView({} as never, actions(() => model, {
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
		const view = new SaleItemView({} as never, actions(() => model, {
			refreshSale: async () => { refreshed += 1; await pending; },
		}));
		await view.onOpen();
		const root = view.contentEl as unknown as FakeElement;
		const button = find(root, 'button').find((el) => text(el).includes('Actualizar'))!;
		button.dispatch('click');
		expect(refreshed).toBe(1);
		finish();
		await Promise.resolve();
		await Promise.resolve();
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
		const view = new SaleItemView({} as never, actions(() => buildSaleViewModel(baseInput({ status })), {
			refreshSale: async () => {
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
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(text(root)).not.toContain('Leyendo precios del bazar');
	});

	it('does not trigger a second refresh while the auto-triggered one is still in flight', async () => {
		installDom();
		let refreshCalls = 0;
		let resolveRefresh!: () => void;
		const pending = new Promise<void>((resolve) => { resolveRefresh = resolve; });
		const view = new SaleItemView({} as never, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { refreshCalls += 1; await pending; },
		}));
		await view.onOpen();
		view.render();
		view.render();
		expect(refreshCalls).toBe(1);
		resolveRefresh();
		await Promise.resolve();
		await Promise.resolve();
	});

	it('when the runtime is not ready yet and the refresh leaves the model in loading, shows a working Actualizar button instead of a dead end', async () => {
		installDom();
		let refreshCalls = 0;
		// Mirrors `main.ts`'s `refreshInventoryAdvisor`: `if (!this.runtimeReady) { notify; return; }`
		// resolves without ever changing the cached model away from `loading`.
		const view = new SaleItemView({} as never, actions(() => buildSaleViewModel(baseInput({ status: 'loading' })), {
			refreshSale: async () => { refreshCalls += 1; },
		}));
		await view.onOpen();
		await Promise.resolve();
		await Promise.resolve();
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root)).toContain('Leyendo precios del bazar');
		const button = find(root, 'button').find((el) => text(el).includes('Actualizar'))!;
		expect(button).toBeDefined();
		button.dispatch('click');
		expect(refreshCalls).toBe(2);
	});

	it('when the analysis cannot run (missing key), shows the blocked reason instead of Leyendo', async () => {
		installDom();
		let status: 'loading' | 'blocked' = 'loading';
		const view = new SaleItemView({} as never, actions(() => buildSaleViewModel(baseInput({
			status, ...(status === 'blocked' ? { blockedReason: 'credential_unavailable' } : {}),
		})), {
			refreshSale: async () => { status = 'blocked'; },
		}));
		await view.onOpen();
		await Promise.resolve();
		await Promise.resolve();
		const root = view.contentEl as unknown as FakeElement;
		expect(text(root)).not.toContain('Leyendo precios del bazar');
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
}
