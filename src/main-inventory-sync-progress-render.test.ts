import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }));

import type { InventoryVaultSyncPlan, InventoryVaultSyncResult } from './inventory/inventory-vault-sync';
import { createRuntimeHarness, type RuntimeHarness } from './test/runtime-harness';
import { InventoryAdvisorItemView, inventoryAdvisorView } from './ui/inventory-advisor-item-view';
import type { InventoryAdvisorViewModel } from './ui/inventory-advisor-view-model';
import type { InventoryVaultSyncRunPorts, InventoryVaultSyncRunState } from './ui/inventory-vault-sync-run-controller';
import { MountedViews } from './ui/mounted-views';
import { SaleItemView, saleView } from './ui/sale-item-view';
import { buildSaleViewModel } from './ui/sale-view-model';

/**
 * Audit V1, finding 3.1. One inventory sync writes one note per step and every step reports its
 * progress, each report an `await` apart from the next. These are COUNT tests through the real
 * core and the real one-click controller it wires, never clock tests: how many times the Sale tab
 * is emptied and rebuilt during the burst, how many times the Inventory tab repaints, and what the
 * progress bar says once the frame runs.
 */

const STEPS = 40;
const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };

describe('inventory sync progress and the open product tabs', () => {
	let harness: RuntimeHarness | null = null;

	afterEach(() => {
		harness?.dispose();
		harness = null;
	});

	/**
	 * The real core after its real `initializeRuntime`, with one Inventory tab and one Sale tab
	 * mounted the way the host mounts them (`MountedViews`), and the real controller's own ports
	 * replaced by a plan of `STEPS` writes that stops before the last promise resolves.
	 */
	async function syncInFlight() {
		const runtime = createRuntimeHarness();
		harness = runtime;
		(runtime.core as unknown as { localDebugActions: null }).localDebugActions = null;
		await runtime.initializeRuntime();
		const core = runtime.core as unknown as {
			viewControllers: unknown;
			inventoryVaultSyncRun: {
				ports: InventoryVaultSyncRunPorts;
				run(): Promise<InventoryVaultSyncRunState>;
				current(): InventoryVaultSyncRunState;
			};
		};
		const controller = core.inventoryVaultSyncRun;
		const document = new FakeDocument();
		vi.stubGlobal('createEl', (tag: string, options?: FakeOptions) => new FakeElement(tag, document, options));
		vi.stubGlobal('createDiv', (options?: FakeOptions) => new FakeElement('div', document, options));
		vi.stubGlobal('createSpan', (options?: FakeOptions) => new FakeElement('span', document, options));

		const saleContent = new FakeElement('div', document);
		const sale = new SaleItemView(saleContent as unknown as HTMLElement, icons, {
			getSaleLocale: () => 'en',
			getSaleViewModel: () => buildSaleViewModel({
				status: 'ready', nowMs: Date.UTC(2026, 8, 26), festivalStartMs: null, maxPriceAgeMs: 900_000,
				hero: null, rows: [], calendar: [],
			}),
			refreshSale: async () => undefined,
		});
		const advisorContent = new FakeElement('div', document);
		const advisor = new InventoryAdvisorItemView(advisorContent as unknown as HTMLElement, icons, {
			getInventoryAdvisorLocale: () => 'en',
			getInventoryAdvisorViewModel: (): InventoryAdvisorViewModel => ({ status: 'ready', title: 'advisor', detail: 'ready', groups: [] }),
			refreshInventoryAdvisor: async () => undefined,
			getInventoryVaultSyncRunState: () => controller.current(),
			runInventoryVaultSync: async () => undefined,
			confirmInventoryVaultSync: async () => undefined,
			cancelInventoryVaultSync: () => undefined,
			hasManagedAssetsRoot: () => true,
		});
		const sales = new MountedViews(() => sale);
		const advisors = new MountedViews(() => advisor);
		core.viewControllers = {
			companion: new MountedViews(() => { throw new Error('No Companion view is mounted in this test.'); }),
			inventoryAdvisor: advisors, sale: sales,
		};
		const saleRegistration = sales.registration(saleView({ getSaleLocale: () => 'en' }));
		const advisorRegistration = advisors.registration(inventoryAdvisorView({ getInventoryAdvisorLocale: () => 'en' }));
		await saleRegistration.mount(saleContent as unknown as HTMLElement);
		await advisorRegistration.mount(advisorContent as unknown as HTMLElement);

		let burstDone!: () => void;
		const burst = new Promise<void>((resolve) => { burstDone = resolve; });
		let finishApply!: () => void;
		const applyGate = new Promise<void>((resolve) => { finishApply = resolve; });
		const plan = { schemaVersion: 1, root: 'Inventory', capturedAt: '2026-09-26T00:00:00.000Z', positions: STEPS, canApply: true, steps: [] } as unknown as InventoryVaultSyncPlan;
		Object.assign(controller.ports, {
			disabledReason: () => null,
			refreshAdvisor: async () => undefined,
			previewSync: async () => plan,
			applySync: async (_plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void): Promise<InventoryVaultSyncResult> => {
				for (let step = 1; step <= STEPS; step += 1) {
					// Every note is its own awaited vault write: no two reports share a microtask.
					await Promise.resolve();
					onStep(step, STEPS);
				}
				burstDone();
				await applyGate;
				return { status: 'applied', created: STEPS, updated: 0, deactivated: 0 };
			},
		} satisfies InventoryVaultSyncRunPorts);

		const saleEmptiedBefore = saleContent.emptied;
		const advisorRender = vi.spyOn(advisor, 'render');
		const run = controller.run();
		await burst;
		return {
			runtime, controller, sale, advisor, saleContent, advisorContent, advisorRender, document,
			saleRebuilds: () => saleContent.emptied - saleEmptiedBefore,
			unmountAdvisor: () => advisorRegistration.unmount(advisorContent as unknown as HTMLElement),
			finish: async () => { finishApply(); await run; },
		};
	}

	it(`does not empty and rebuild the Sale tab for any of ${String(STEPS)} progress reports`, async () => {
		const sync = await syncInFlight();

		expect(sync.controller.current()).toMatchObject({ status: 'running', phase: 'apply', completed: STEPS, total: STEPS });
		expect(sync.saleRebuilds()).toBe(0);

		await sync.finish();
	});

	it('rebuilds the Sale tab once when the run ends, the outcome the content may depend on', async () => {
		const sync = await syncInFlight();

		await sync.finish();

		expect(sync.controller.current()).toMatchObject({ status: 'idle', lastRun: { status: 'success' } });
		expect(sync.saleRebuilds()).toBe(1);
	});

	it(`repaints the Inventory tab once per frame, not once per report, across ${String(STEPS)} reports`, async () => {
		const sync = await syncInFlight();

		// Nothing painted yet: the whole burst is waiting for one frame of the tab's own window.
		expect(sync.advisorRender).toHaveBeenCalledTimes(0);
		expect(sync.advisorContent.win.pendingFrames()).toBe(1);

		sync.advisorContent.win.runFrames();

		expect(sync.advisorRender).toHaveBeenCalledTimes(1);
		expect(sync.advisorContent.win.pendingFrames()).toBe(0);

		await sync.finish();
	});

	it('always shows the last progress report once the frame runs', async () => {
		const sync = await syncInFlight();
		const last = sync.controller.current();
		if (last.status !== 'running') throw new Error('Expected the run to be in flight.');

		sync.advisorContent.win.runFrames();

		const progress = only(walk(sync.advisorContent).filter((element) => element.tag === 'progress'));
		expect(progress.hidden).toBe(false);
		expect(progress.value).toBe(last.percent);
		expect(text(sync.advisorContent)).toContain(`${String(STEPS)}/${String(STEPS)}`);

		await sync.finish();
	});

	it('paints the outcome at once when the run ends and leaves no frame behind', async () => {
		const sync = await syncInFlight();

		await sync.finish();

		expect(sync.advisorContent.win.pendingFrames()).toBe(0);
		const progress = only(walk(sync.advisorContent).filter((element) => element.tag === 'progress'));
		expect(progress.hidden).toBe(true);
		const rendersAtTheEnd = sync.advisorRender.mock.calls.length;
		sync.advisorContent.win.runFrames();
		expect(sync.advisorRender).toHaveBeenCalledTimes(rendersAtTheEnd);
	});

	it('keeps the focus on the Sale tab control the user was on through the whole burst', async () => {
		const runtime = await syncInFlight();
		await runtime.finish();
		const refresh = only(walk(runtime.saleContent).filter((element) => element.tag === 'button'));
		refresh.focus();

		// A second run: the focused button was painted before it started.
		const rebuildsBefore = runtime.saleRebuilds();
		let burstDone!: () => void;
		const burst = new Promise<void>((resolve) => { burstDone = resolve; });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		Object.assign(runtime.controller.ports, {
			applySync: async (_plan: InventoryVaultSyncPlan, onStep: (completed: number, total: number) => void): Promise<InventoryVaultSyncResult> => {
				for (let step = 1; step <= STEPS; step += 1) { await Promise.resolve(); onStep(step, STEPS); }
				burstDone();
				await gate;
				return { status: 'applied', created: 0, updated: 0, deactivated: 0 };
			},
		});
		const run = runtime.controller.run();
		await burst;

		expect(runtime.saleRebuilds()).toBe(rebuildsBefore);
		expect(runtime.document.activeElement).toBe(refresh);
		expect(walk(runtime.saleContent)).toContain(refresh);

		release();
		await run;
	});

	it('keeps the focus on the Inventory tab control the user was on after a progress repaint', async () => {
		const sync = await syncInFlight();
		const search = only(walk(sync.advisorContent).filter((element) => element.tag === 'input' && element.type === 'search'));
		search.focus();

		sync.advisorContent.win.runFrames();

		expect(sync.document.activeElement).toBe(search);
		expect(walk(sync.advisorContent)).toContain(search);

		await sync.finish();
	});

	it('cancels the pending frame when the Inventory tab closes, and a late frame paints nothing', async () => {
		const sync = await syncInFlight();
		expect(sync.advisorContent.win.pendingFrames()).toBe(1);

		await sync.unmountAdvisor();

		expect(sync.advisorContent.win.pendingFrames()).toBe(0);
		expect(sync.advisorContent.win.cancelled).toHaveLength(1);
		expect(sync.advisorRender).toHaveBeenCalledTimes(0);

		await sync.finish();
	});

	it('drops the price disclosure subscription when the Inventory tab closes', async () => {
		const sync = await syncInFlight();
		const disclosure = only(walk(sync.advisorContent).filter((element) => element.className === 'tyrian-inventory-advisor__price-history'));
		expect(disclosure.listeners.get('toggle')).toHaveLength(1);

		await sync.unmountAdvisor();

		expect(disclosure.listeners.get('toggle')).toHaveLength(0);

		await sync.finish();
	});

	it('cancels the pending frame when the plugin unloads', async () => {
		const sync = await syncInFlight();
		expect(sync.advisorContent.win.pendingFrames()).toBe(1);

		await sync.runtime.shutdown();

		expect(sync.advisorContent.win.pendingFrames()).toBe(0);
		expect(sync.advisorContent.win.cancelled).toHaveLength(1);
		expect(sync.advisorRender).toHaveBeenCalledTimes(0);

		await sync.finish();
	});
});

function only<T>(values: readonly T[]): T {
	if (values.length !== 1) throw new Error(`Expected exactly one element, found ${String(values.length)}.`);
	return values[0]!;
}

function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }

function text(root: FakeElement): string {
	return walk(root).map((element) => element.textContent ?? '').join('\n');
}

/** The window a view's container belongs to (`contentEl.win`): a frame queue the test runs by hand. */
class FakeWindow {
	private readonly frames = new Map<number, () => void>();
	private nextHandle = 1;
	readonly cancelled: number[] = [];
	requestAnimationFrame = (callback: () => void): number => {
		const handle = this.nextHandle;
		this.nextHandle += 1;
		this.frames.set(handle, callback);
		return handle;
	};
	cancelAnimationFrame = (handle: number): void => {
		if (this.frames.delete(handle)) this.cancelled.push(handle);
	};
	/** The timers a view arms for its own repaint (Sale tab); real ones, cleared by the view on close. */
	setTimeout = (callback: () => void, milliseconds: number): number => globalThis.setTimeout(callback, milliseconds) as unknown as number;
	clearTimeout = (handle: number): void => { globalThis.clearTimeout(handle); };
	pendingFrames(): number { return this.frames.size; }
	runFrames(): void {
		const due = [...this.frames.values()];
		this.frames.clear();
		for (const callback of due) callback();
	}
}

class FakeDocument {
	activeElement: FakeElement | null = null;
	readonly defaultView = new FakeWindow();
	hidden = false;
	addEventListener(_type: string, _listener: () => void): void { /* visibilitychange is never fired here */ }
	removeEventListener(_type: string, _listener: () => void): void { /* see above */ }
	createElementNS(_namespace: string, tag: string): FakeElement { return new FakeElement(tag, this); }
}

interface FakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

type FakeListener = (event: { preventDefault(): void }) => void;

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, FakeListener[]>();
	emptied = 0;
	className = '';
	id = '';
	scope = '';
	colSpan = 1;
	textContent: string | null = null;
	type = '';
	value: string | number = '';
	max = 0;
	placeholder = '';
	selected = false;
	checked = false;
	required = false;
	open = false;
	disabled = false;
	hidden = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? null;
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}
	/** Obsidian's `Node.win`: the window this element lives in, a popout's own when it is in one. */
	get win(): FakeWindow { return this.ownerDocument.defaultView; }
	/** Obsidian's `Node.doc`: the document this element lives in. */
	get doc(): FakeDocument { return this.ownerDocument; }
	empty(): void { this.emptied += 1; this.children.splice(0); this.textContent = null; }
	append(...children: FakeElement[]): void { this.children.push(...children); }
	prepend(...children: FakeElement[]): void { this.children.unshift(...children); }
	replaceChildren(...children: FakeElement[]): void { this.children.splice(0, this.children.length, ...children); }
	createEl(tag: string, options?: FakeOptions): FakeElement { const child = new FakeElement(tag, this.ownerDocument, options); this.children.push(child); return child; }
	createDiv(options?: FakeOptions): FakeElement { const child = new FakeElement('div', this.ownerDocument, options); this.children.push(child); return child; }
	createSpan(options?: FakeOptions): FakeElement { const child = new FakeElement('span', this.ownerDocument, options); this.children.push(child); return child; }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setText(value: string): void { this.textContent = value; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	addEventListener(type: string, listener: FakeListener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: FakeListener): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
	}
	dispatch(type: string): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ preventDefault() {} }); }
	focus(): void { this.ownerDocument.activeElement = this; }
	contains(other: FakeElement): boolean { return other === this || this.children.some((child) => child.contains(other)); }
}
