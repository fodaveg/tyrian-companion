import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	ProductActionController,
	PRODUCT_ACTION_IDS,
	registerProductActionPalette,
	type ProductActionControllerPorts,
} from './product-action-controller';
import { renderProductShell } from './product-shell';
import type { SessionCommandId } from './session-command-model';

/** The host's `setIcon`, recording the Lucide id on the element as the Obsidian test double does. */
const icons = { setIcon: (el: HTMLElement, icon: string): void => { el.setAttribute('data-icon', icon); } };

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('product action surface', () => {
	// `review-session` is gone (Lote S, 2026-09-09: nobody reviews a session anymore), so the
	// session group drops from 7 to 6 and the total from 16 to 15. «Abandonar sesión» (David, 2026-09-24)
	// brings them back to 7 and 16. The Sale tab's `open-sale` brings the navigation group to 3 and the
	// total to 17.
	it('has exact 17-command parity with the requested 3/7/2/5 groups', () => {
		const controller = createController();
		expect(PRODUCT_ACTION_IDS).toHaveLength(17);
		expect(new Set(PRODUCT_ACTION_IDS).size).toBe(17);
		expect(controller.all().find((action) => action.id === 'open-companion')?.group).toBe('navigation');
		expect(controller.all().filter((action) => action.group === 'navigation')).toHaveLength(3);
		expect(controller.all().filter((action) => action.group === 'session')).toHaveLength(7);
		expect(controller.all().filter((action) => action.group === 'detection')).toHaveLength(2);
		expect(controller.all().filter((action) => action.group === 'inventory')).toHaveLength(5);
	});

	it('uses one controller for palette execution and delegates session commands to SessionCommandController', async () => {
		const sessionRun = vi.fn(async () => 'completed' as const);
		const execute = vi.fn(async () => 'completed' as const);
		const controller = createController({ sessionRun, execute, hasKey: true });
		const palette: Array<{ id: string; checkCallback(checking: boolean): boolean }> = [];
		registerProductActionPalette({ addCommand: (command) => { palette.push(command); } }, controller);
		expect(palette.map((command) => command.id)).toEqual(PRODUCT_ACTION_IDS);
		palette.find((command) => command.id === 'start-farming-session')!.checkCallback(false);
		palette.find((command) => command.id === 'open-companion')!.checkCallback(false);
		await Promise.resolve();
		expect(sessionRun).toHaveBeenCalledWith('start-farming-session');
		expect(execute).toHaveBeenCalledWith('open-companion');
	});

	// The controller-level guarantees of the removed panel tests: the disabled reason, the live
	// feedback while running and after success, and a sanitized failure message.
	it('projects a disabled reason, running and completed feedback, and a sanitized failure from the controller', async () => {
		const missingKey = createController();
		const refresh = missingKey.describe('refresh-inventory-advisor');
		expect(refresh.available).toBe(false);
		expect(refresh.disabledReason).toContain('Vincula una clave API');

		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		const controller = createController({ execute: async () => { await pending; return 'completed' as const; }, hasKey: true, locale: 'en' });
		const run = controller.run('open-companion');
		await Promise.resolve();
		expect(controller.currentFeedback()?.message).toContain('Action running');
		expect(controller.describe('open-companion').available).toBe(false);
		finish();
		await run;
		expect(controller.currentFeedback()?.message).toContain('Action completed');
		expect(controller.describe('open-companion').available).toBe(true);

		const failing = createController({
			execute: async () => { throw new Error('private raw transport detail'); }, hasKey: true, locale: 'en',
		});
		await expect(failing.run('open-companion')).rejects.toThrow();
		expect(failing.currentFeedback()).toMatchObject({ kind: 'error' });
		expect(failing.currentFeedback()?.message).toContain('previous state is preserved');
		expect(failing.currentFeedback()?.message).not.toContain('private raw transport detail');
		expect(failing.describe('open-companion').available).toBe(true);
	});

	it.each(['cancelled', 'unavailable'] as const)('never reports %s session outcomes as success', async (outcome) => {
		const controller = createController({ sessionRun: async () => outcome, hasKey: true, locale: 'en' });
		await expect(controller.run('start-farming-session')).resolves.toBe(outcome);
		expect(controller.currentFeedback()).toMatchObject({ kind: 'neutral', actionId: 'start-farming-session' });
		expect(controller.currentFeedback()?.message).not.toContain('completed');
	});

	it('marks a structured failure as error and propagates a sanitized rejection', async () => {
		const controller = createController({ sessionRun: async () => 'failed', hasKey: true, locale: 'en' });
		await expect(controller.run('start-farming-session')).rejects.toThrow('Product action failed.');
		expect(controller.currentFeedback()).toMatchObject({ kind: 'error', actionId: 'start-farming-session' });
		expect(controller.currentFeedback()?.message).not.toContain('raw');
	});

	it('expires a future cooldown in place and cancels its sole timer on dispose', () => {
		let now = Date.parse('2026-08-30T08:00:00.000Z');
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const scheduled: { callback: (() => void) | null } = { callback: null };
		const setTimer = vi.fn((callback: () => void) => {
			scheduled.callback = callback;
			return setTimer.mock.calls.length;
		});
		const clearTimer = vi.fn();
		vi.stubGlobal('window', { setTimeout: setTimer, clearTimeout: clearTimer });
		let retryAt = now + 60_000;
		const controller = createController({
			hasKey: true,
			connection: () => ({ status: 'error', code: 'rate_limited', message: 'wait', retryAt }),
		});
		const unsubscribe = controller.subscribe(() => undefined);
		expect(controller.describe('refresh-inventory-advisor').state).toBe('cooldown');
		expect(controller.describe('refresh-inventory-advisor').available).toBe(false);
		expect(setTimer).toHaveBeenCalledTimes(1);
		expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 60_000);

		now += 60_000;
		scheduled.callback?.();
		expect(controller.describe('refresh-inventory-advisor').state).toBe('idle');
		expect(controller.describe('refresh-inventory-advisor').available).toBe(true);
		expect(setTimer).toHaveBeenCalledTimes(1);

		retryAt = now + 30_000;
		controller.refresh();
		expect(controller.describe('refresh-inventory-advisor').state).toBe('cooldown');
		expect(setTimer).toHaveBeenCalledTimes(2);
		unsubscribe();
		expect(clearTimer).toHaveBeenLastCalledWith(2);
	});

	// H14.14: a listener that never unsubscribes (a view torn down without its own cleanup
	// running, the way a plugin unload can leave one) used to leave this timer armed forever.
	it('cancels a still-subscribed cooldown timer directly on dispose()', () => {
		const setTimer = vi.fn(() => 1);
		const clearTimer = vi.fn();
		vi.stubGlobal('window', { setTimeout: setTimer, clearTimeout: clearTimer });
		const controller = createController({
			hasKey: true,
			connection: () => ({ status: 'error', code: 'rate_limited', message: 'wait', retryAt: Date.now() + 60_000 }),
		});
		const unsubscribe = controller.subscribe(() => undefined);
		expect(setTimer).toHaveBeenCalledOnce();

		controller.dispose();
		expect(clearTimer).toHaveBeenCalledWith(1);

		// The subscriber is still live: unsubscribing afterwards must not schedule a second timer
		// or throw on an already-cleared one.
		unsubscribe();
		expect(setTimer).toHaveBeenCalledOnce();
	});

	it('renders real four-surface navigation and an actionable global missing-key warning', () => {
		const document = installFakeDocument();
		const root = new FakeElement('div', document);
		const openSettings = vi.fn();
		const execute = vi.fn(async () => 'completed' as const);
		const mount = renderProductShell(root as unknown as HTMLElement, {
			locale: 'en', active: 'inventory', actions: createController({ execute }), missingApiKey: true, openSettings, ui: icons,
		});
		const elements = walk(root);
		expect((mount.panel as unknown as FakeElement).tag).toBe('aside');
		expect((mount.panel as unknown as FakeElement).hidden).toBe(true);
		const workspace = elements.find((element) => element.className.includes('tyrian-product-shell__workspace'))!;
		expect(workspace.children).toEqual([mount.content]);
		expect(elements.filter((element) => element.className.includes('tyrian-action-panel__action'))).toHaveLength(0);
		const nav = elements.find((element) => element.className.includes('tyrian-product-shell__nav'))!;
		const tabs = walk(nav).filter((element) => element.tag === 'button');
		expect(tabs).toHaveLength(4);
		// H18.36: Ajustes is now an icon-only button (no visible text), identified by its
		// aria-label and Lucide icon instead of the tab word it used to share with the other three.
		expect(tabs.map((tab) => tab.textContent)).toEqual(['Session', 'Inventory', 'Sale', '']);
		expect(tabs[1]!.attributes.get('aria-current')).toBe('page');
		expect(tabs[3]!.attributes.get('aria-label')).toBe('Tyrian Companion settings');
		expect(tabs[3]!.attributes.get('data-icon')).toBe('settings');
		expect(tabs[3]!.className).toContain('clickable-icon');
		// The "Sale" tab navigates through the SAME controller as the other two, not a
		// bespoke callback.
		tabs[2]!.dispatch('click');
		expect(execute).toHaveBeenCalledWith('open-sale');
		const warning = elements.find((element) => element.className.includes('tyrian-product-shell__attention'))!;
		expect(warning.attributes.get('role')).toBe('alert');
		expect(walk(warning).map((element) => element.textContent).join(' ')).toContain('API key not linked');
		walk(warning).find((element) => element.tag === 'button')!.dispatch('click');
		expect(openSettings).toHaveBeenCalledOnce();
	});

	it('keeps expert commands in the palette without mounting the 17-action panel at any width', () => {
		const document = installFakeDocument();
		const root = new FakeElement('div', document);
		const mount = renderProductShell(root as unknown as HTMLElement, {
			locale: 'es', active: 'companion', actions: createController(), missingApiKey: false, openSettings: vi.fn(), ui: icons,
		});
		expect(walk(root).some((element) => element.className.includes('tyrian-action-panel'))).toBe(false);
		expect((mount.panel as unknown as FakeElement).hidden).toBe(true);
		expect(PRODUCT_ACTION_IDS).toHaveLength(17);
		mount.dispose();
	});
});

function installFakeDocument(): FakeDocument {
	const document = new FakeDocument();
	vi.stubGlobal('createEl', (tag: string, options?: FakeOptions) => new FakeElement(tag, document, options));
	vi.stubGlobal('createDiv', (options?: FakeOptions) => new FakeElement('div', document, options));
	vi.stubGlobal('createSpan', (options?: FakeOptions) => new FakeElement('span', document, options));
	return document;
}

function createController(overrides: {
	readonly sessionRun?: (id: SessionCommandId) => Promise<'completed' | 'cancelled' | 'unavailable' | 'failed'>;
	readonly execute?: ProductActionControllerPorts['execute'];
	readonly hasKey?: boolean;
	readonly locale?: 'es' | 'en';
	readonly connection?: ProductActionControllerPorts['getConnectionState'];
} = {}): ProductActionController {
	return new ProductActionController({
		getLocale: () => overrides.locale ?? 'es', isRuntimeReady: () => true, hasApiKey: () => overrides.hasKey ?? false,
		getConnectionState: overrides.connection ?? (() => ({ status: 'connected', details: {} } as never)),
		getPendingProposals: () => ({ status: 'ready', pendingCount: 1, next: {} } as never),
		getDetectionState: () => ({ status: 'disarmed', reason: 'initial', scheduler: {}, lastSnapshotAt: null } as never),
		canArmDetection: () => true, canApplyInventory: () => false, canApplyWallet: () => false,
		isInventoryBusy: () => false,
		sessionCommands: {
			describe: (id) => ({ id, name: id, available: true, icon: 'test', destructive: id.includes('discard') || id.includes('clear'), targetKey: 'test' }),
			runWithOutcome: overrides.sessionRun ?? vi.fn(async () => 'completed' as const),
		},
		execute: overrides.execute ?? vi.fn(async () => 'completed' as const),
	});
}

interface FakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

class FakeDocument { activeElement: FakeElement | null = null }

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	className = '';
	textContent = '';
	disabled = false;
	hidden = false;
	open = false;

	constructor(readonly tag: string, readonly ownerDocument: FakeDocument, options: FakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? '';
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	get lastElementChild(): FakeElement | null { return this.children.at(-1) ?? null; }
	empty(): void { this.children.splice(0); this.textContent = ''; }
	append(...children: FakeElement[]): void { this.children.push(...children); }
	prepend(...children: FakeElement[]): void { this.children.unshift(...children); }
	createEl(tag: string, options?: FakeOptions): FakeElement { const child = new FakeElement(tag, this.ownerDocument, options); this.children.push(child); return child; }
	createDiv(options?: FakeOptions): FakeElement { const child = new FakeElement('div', this.ownerDocument, options); this.children.push(child); return child; }
	createSpan(options?: FakeOptions): FakeElement { const child = new FakeElement('span', this.ownerDocument, options); this.children.push(child); return child; }
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	setText(value: string): void { this.textContent = value; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
	dispatch(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
	focus(): void { this.ownerDocument.activeElement = this; }
	contains(target: FakeElement | null): boolean {
		return target === this || this.children.some((child) => child.contains(target));
	}
}

function walk(root: FakeElement): FakeElement[] { return [root, ...root.children.flatMap(walk)]; }
