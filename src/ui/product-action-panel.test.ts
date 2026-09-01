import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	ProductActionController,
	PRODUCT_ACTION_IDS,
	registerProductActionPalette,
	type ProductActionControllerPorts,
} from './product-action-controller';
import { mountActionPanel, renderProductShell } from './product-shell';
import type { SessionCommandId } from './session-command-model';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('product action surface', () => {
	it('has exact 16-command parity with the requested 2/7/2/5 groups', () => {
		const controller = createController();
		expect(PRODUCT_ACTION_IDS).toHaveLength(16);
		expect(new Set(PRODUCT_ACTION_IDS).size).toBe(16);
		expect(controller.all().find((action) => action.id === 'open-companion')?.group).toBe('navigation');
		expect(controller.all().filter((action) => action.group === 'navigation')).toHaveLength(2);
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

	it('renders every action, a visible disabled reason, live feedback, and routes clicks to controller.run', () => {
		installFakeDocument();
		const controller = createController();
		const run = vi.spyOn(controller, 'run').mockResolvedValue('completed');
		const panelMount = mountActionPanel(controller, 'es');
		const panel = panelMount.element as unknown as FakeElement;
		const elements = walk(panel);
		const actions = elements.filter((element) => element.className.includes('tyrian-action-panel__action'));
		expect(actions).toHaveLength(16);
		const refresh = actions.find((element) => element.attributes.get('data-command-id') === 'refresh-inventory-advisor')!;
		const refreshButton = walk(refresh).find((element) => element.tag === 'button')!;
		expect(refreshButton.disabled).toBe(true);
		expect(walk(refresh).map((element) => element.textContent).join(' ')).toContain('Vincula una clave API');
		const feedback = elements.find((element) => element.className.includes('tyrian-action-panel__feedback'))!;
		expect(feedback.attributes.get('aria-live')).toBe('polite');
		const open = actions.find((element) => element.attributes.get('data-command-id') === 'open-companion')!;
		walk(open).find((element) => element.tag === 'button')!.dispatch('click');
		expect(run).toHaveBeenCalledWith('open-companion');
	});

	it('updates feedback and button state in place for success and sanitized failure', async () => {
		installFakeDocument();
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		const controller = createController({ execute: async () => { await pending; return 'completed' as const; }, hasKey: true, locale: 'en' });
		const mount = mountActionPanel(controller, 'en');
		const panel = mount.element as unknown as FakeElement;
		const action = walk(panel).find((element) => element.attributes.get('data-command-id') === 'open-companion')!;
		const button = walk(action).find((element) => element.tag === 'button')!;
		const feedback = walk(panel).find((element) => element.className.includes('tyrian-action-panel__feedback'))!;
		button.focus();
		button.dispatch('click');
		await Promise.resolve();
		expect(feedback.textContent).toContain('Action running');
		expect(button.disabled).toBe(true);
		expect(walk(panel).find((element) => element.attributes.get('data-command-id') === 'open-companion')).toBe(action);
		expect(button.ownerDocument.activeElement).toBe(button);
		finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(feedback.textContent).toContain('Action completed');
		expect(button.disabled).toBe(false);

		const failing = createController({
			execute: async () => { throw new Error('private raw transport detail'); }, hasKey: true, locale: 'en',
		});
		const failedMount = mountActionPanel(failing, 'en');
		const failedPanel = failedMount.element as unknown as FakeElement;
		const failedButton = walk(failedPanel).find((element) => element.attributes.get('data-command-id') === 'open-companion')!
			.children.find((element) => element.tag === 'button') ?? walk(failedPanel).find((element) => element.tag === 'button')!;
		failedButton.dispatch('click');
		await Promise.resolve();
		await Promise.resolve();
		const failedFeedback = walk(failedPanel).find((element) => element.className.includes('tyrian-action-panel__feedback'))!;
		expect(failedFeedback.textContent).toContain('previous state is preserved');
		expect(failedFeedback.textContent).not.toContain('private raw transport detail');
		expect(failedFeedback.attributes.get('role')).toBe('alert');
		expect(failedButton.disabled).toBe(false);
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
		installFakeDocument();
		let retryAt = now + 60_000;
		const controller = createController({
			hasKey: true,
			connection: () => ({ status: 'error', code: 'rate_limited', message: 'wait', retryAt }),
		});
		const mount = mountActionPanel(controller, 'es');
		const panel = mount.element as unknown as FakeElement;
		const action = walk(panel).find((element) => element.attributes.get('data-command-id') === 'refresh-inventory-advisor')!;
		const button = walk(action).find((element) => element.tag === 'button')!;
		expect(action.attributes.get('data-state')).toBe('cooldown');
		expect(button.disabled).toBe(true);
		expect(setTimer).toHaveBeenCalledTimes(1);
		expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 60_000);

		now += 60_000;
		scheduled.callback?.();
		expect(action.attributes.get('data-state')).toBe('idle');
		expect(button.disabled).toBe(false);
		expect(setTimer).toHaveBeenCalledTimes(1);

		retryAt = now + 30_000;
		controller.refresh();
		expect(action.attributes.get('data-state')).toBe('cooldown');
		expect(setTimer).toHaveBeenCalledTimes(2);
		mount.dispose();
		expect(clearTimer).toHaveBeenLastCalledWith(2);
	});

	it('renders real three-surface navigation and an actionable global missing-key warning', () => {
		const document = installFakeDocument();
		const root = new FakeElement('div', document);
		const openSettings = vi.fn();
		const mount = renderProductShell(root as unknown as HTMLElement, {
			locale: 'en', active: 'inventory', actions: createController(), missingApiKey: true, openSettings,
		});
		const elements = walk(root);
		expect((mount.panel as unknown as FakeElement).tag).toBe('aside');
		expect((mount.panel as unknown as FakeElement).hidden).toBe(true);
		const workspace = elements.find((element) => element.className.includes('tyrian-product-shell__workspace'))!;
		expect(workspace.children).toEqual([mount.content]);
		expect(elements.filter((element) => element.className.includes('tyrian-action-panel__action'))).toHaveLength(0);
		const nav = elements.find((element) => element.className.includes('tyrian-product-shell__nav'))!;
		const tabs = walk(nav).filter((element) => element.tag === 'button');
		expect(tabs).toHaveLength(3);
		expect(tabs.map((tab) => tab.textContent)).toEqual(['Session', 'Inventory', 'Settings']);
		expect(tabs[1]!.attributes.get('aria-current')).toBe('page');
		const warning = elements.find((element) => element.className.includes('tyrian-product-shell__attention'))!;
		expect(warning.attributes.get('role')).toBe('alert');
		expect(walk(warning).map((element) => element.textContent).join(' ')).toContain('API key not linked');
		walk(warning).find((element) => element.tag === 'button')!.dispatch('click');
		expect(openSettings).toHaveBeenCalledOnce();
	});

	it('keeps expert commands in the palette without mounting the 16-action panel at any width', () => {
		const document = installFakeDocument();
		const root = new FakeElement('div', document);
		const mount = renderProductShell(root as unknown as HTMLElement, {
			locale: 'es', active: 'companion', actions: createController(), missingApiKey: false, openSettings: vi.fn(),
		});
		expect(walk(root).some((element) => element.className.includes('tyrian-action-panel'))).toBe(false);
		expect((mount.panel as unknown as FakeElement).hidden).toBe(true);
		expect(PRODUCT_ACTION_IDS).toHaveLength(16);
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
