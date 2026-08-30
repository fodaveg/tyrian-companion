import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./halloween-alert-panel', () => ({ renderHalloweenAlertPanel: vi.fn() }));

import { TyrianCompanionView } from './companion-view';
import type { LocalDebugStatus } from '../core/local-debug-contract';
import { ProductActionController } from './product-action-controller';

afterEach(() => vi.unstubAllGlobals());

describe('Companion local diagnostics warning', () => {
	it('renders a live degraded warning with a navigable Settings action', () => {
		const opened = vi.fn();
		const texts: string[] = [];
		let role = '';
		let click: (() => void) | null = null;
		const status: LocalDebugStatus = {
			enabled: true, minimumLevel: 'debug', state: 'degraded', path: 'test-config-dir/plugins/tyrian-companion/logs/',
			bytes: 0, fileCount: 0, lastEventAt: null, droppedRecords: 1,
			errorCode: 'logger_failure', queuedRecords: 0, recoveredTails: 0,
		};
		const warning = {
			setAttr: (name: string, value: string) => { if (name === 'role') role = value; },
			createEl: (_tag: string, options: { text: string }) => {
				texts.push(options.text);
				return { addEventListener: (_name: string, listener: () => void) => { click = listener; } };
			},
		};
		const container = { createDiv: () => warning };
		const harness = {
			actions: {
				getLocalDebugStatus: () => status,
				getLocale: () => 'en' as const,
				openLocalDebugSettings: opened,
			},
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderLocalDebugWarning(this: typeof harness, container: { createDiv(): typeof warning }): void;
		}).renderLocalDebugWarning;

		render.call(harness, container);
		expect(role).toBe('alert');
		expect(texts).toEqual([
			'Local diagnostics are degraded',
			'Some entries could not be written. Plugin actions continue to work.',
			'Local diagnostics',
		]);
		if (click === null) throw new Error('Expected a Settings action.');
		(click as () => void)();
		expect(opened).toHaveBeenCalledOnce();
	});

	it('renders nothing while the writer is healthy', () => {
		const createDiv = vi.fn();
		const harness = { actions: { getLocalDebugStatus: () => ({ state: 'ready' }) } };
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the explicit isolated harness below.
		const render = (TyrianCompanionView.prototype as unknown as {
			renderLocalDebugWarning(this: typeof harness, container: { createDiv(): unknown }): void;
		}).renderLocalDebugWarning;
		render.call(harness, { createDiv });
		expect(createDiv).not.toHaveBeenCalled();
	});
});

describe('Companion retained product shell', () => {
	it('preserves the aside, panel disclosure and focus across an external render', async () => {
		const document = new RetainedFakeDocument();
		installRetainedDom(document);
		const contentEl = new RetainedFakeElement('div', document);
		const controller = retainedProductController();
		const harness = {
			actions: {
				getLocale: () => 'es' as const,
				getConnectionState: () => ({ status: 'idle' as const }),
				getSessionState: () => ({ version: 1 as const, status: 'idle' as const }),
				getProductActionController: () => controller,
				hasConfiguredApiKey: () => true,
				openProductSettings: () => undefined,
				getLootPresentation: () => null,
				localDebugViewEvent: vi.fn(),
			},
			contentEl,
			refreshInterval: null,
			dynamicStatusNodes: new Map(),
			headerPhase: null,
			headerElapsed: null,
			checkButton: null,
			cooldownNodes: [],
			incident: null,
			incidentMessage: null,
			incidentMore: null,
			ledger: null,
			productShell: null,
			productShellKey: null,
			clearRefresh: vi.fn(),
			projectStatus: () => ({ refreshEveryMs: null }),
			renderLedgerHeader: vi.fn(),
			renderLocalDebugWarning: vi.fn(),
			renderStatusRail: vi.fn(),
			renderSession: vi.fn(),
			renderAssistedDetection: vi.fn(),
			renderPendingConfirmation: vi.fn(),
			renderConnectionState: vi.fn(),
			t: (key: string) => key,
		};
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated retained-view harness.
		const render = (TyrianCompanionView.prototype as unknown as { render(this: typeof harness): void }).render;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit isolated retained-view harness.
		const close = (TyrianCompanionView.prototype as unknown as { onClose(this: typeof harness): Promise<void> }).onClose;

		render.call(harness);
		const aside = walkRetained(contentEl).find((element) => element.tag === 'aside')!;
		const disclosure = walkRetained(aside).find((element) => element.tag === 'details')!;
		const focused = walkRetained(disclosure).find((element) => element.tag === 'button')!;
		disclosure.open = false;
		focused.focus();

		render.call(harness);
		expect(walkRetained(contentEl).find((element) => element.tag === 'aside')).toBe(aside);
		expect(walkRetained(aside).find((element) => element.tag === 'details')).toBe(disclosure);
		expect(disclosure.open).toBe(false);
		expect(document.activeElement).toBe(focused);

		await close.call(harness);
		expect(harness.productShell).toBeNull();
	});
});

function retainedProductController(): ProductActionController {
	return new ProductActionController({
		getLocale: () => 'es', isRuntimeReady: () => true, hasApiKey: () => true,
		getConnectionState: () => ({ status: 'idle' }),
		getPendingProposals: () => ({ status: 'ready', pendingCount: 0, next: null }),
		getDetectionState: () => ({ status: 'disarmed', reason: 'initial', scheduler: {}, lastSnapshotAt: null } as never),
		canArmDetection: () => true, canApplyInventory: () => false, canApplyWallet: () => false,
		isInventoryBusy: () => false,
		sessionCommands: {
			describe: (id) => ({ id, name: id, available: true, icon: 'test', destructive: false, targetKey: 'test' }),
			runWithOutcome: async () => 'completed',
		},
		execute: async () => 'completed' as const,
	});
}

function installRetainedDom(document: RetainedFakeDocument): void {
	vi.stubGlobal('createEl', (tag: string, options?: RetainedFakeOptions) => new RetainedFakeElement(tag, document, options));
	vi.stubGlobal('createDiv', (options?: RetainedFakeOptions) => new RetainedFakeElement('div', document, options));
	vi.stubGlobal('createSpan', (options?: RetainedFakeOptions) => new RetainedFakeElement('span', document, options));
}

function walkRetained(root: RetainedFakeElement): RetainedFakeElement[] {
	return [root, ...root.children.flatMap(walkRetained)];
}

interface RetainedFakeOptions { readonly text?: string; readonly cls?: string; readonly attr?: Record<string, string> }

class RetainedFakeDocument { activeElement: RetainedFakeElement | null = null }

class RetainedFakeElement {
	readonly children: RetainedFakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly listeners = new Map<string, Array<() => void>>();
	readonly win = { setInterval: () => 1, clearInterval: () => undefined };
	className = '';
	textContent = '';
	disabled = false;
	hidden = false;
	open = false;

	constructor(readonly tag: string, readonly ownerDocument: RetainedFakeDocument, options: RetainedFakeOptions = {}) {
		this.className = options.cls ?? '';
		this.textContent = options.text ?? '';
		for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
	}

	empty(): void { this.children.splice(0); this.textContent = ''; }
	append(...children: RetainedFakeElement[]): void { this.children.push(...children); }
	prepend(...children: RetainedFakeElement[]): void { this.children.unshift(...children); }
	createEl(tag: string, options?: RetainedFakeOptions): RetainedFakeElement {
		const child = new RetainedFakeElement(tag, this.ownerDocument, options); this.children.push(child); return child;
	}
	createDiv(options?: RetainedFakeOptions): RetainedFakeElement {
		const child = new RetainedFakeElement('div', this.ownerDocument, options); this.children.push(child); return child;
	}
	createSpan(options?: RetainedFakeOptions): RetainedFakeElement {
		const child = new RetainedFakeElement('span', this.ownerDocument, options); this.children.push(child); return child;
	}
	setAttr(name: string, value: string): void { this.attributes.set(name, value); }
	removeAttribute(name: string): void { this.attributes.delete(name); }
	setText(value: string): void { this.textContent = value; }
	addClass(value: string): void { this.className = `${this.className} ${value}`.trim(); }
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
	}
	focus(): void { this.ownerDocument.activeElement = this; }
}
